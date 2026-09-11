#!/usr/bin/env python3
"""Website OS: versioned static HTML edits. Python 3.10+, standard library only.

The conversation plans edits. This tool validates and persists structured changes.
Run `python3 site_os.py --help`. It never calls a model or publishes a website.
"""
from __future__ import annotations
import argparse
import contextlib
import hashlib
import html
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import sys
import shutil
import tempfile
from datetime import datetime, timezone
from urllib.parse import urlsplit
import uuid

TOKEN = re.compile(r'\{\{wos:([a-z][a-z0-9_.-]*)\}\}')
CSS_MARKER = '/* website-os:tokens */'
ID = re.compile(r'[a-z][a-z0-9_.-]{0,99}\Z')
KINDS = {'text', 'url', 'image', 'color', 'number', 'choice'}
UNITS = {'', 'px', 'rem', 'em', '%', 'vh', 'vw', 's', 'ms'}
BLOCKED_TEXT_CONTEXT = {'script', 'style', 'textarea', 'xmp', 'iframe', 'noscript'}

class Invalid(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise Invalid(message)

def now():
    return datetime.now(timezone.utc).isoformat()

def encode(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + '\n'

def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))

def atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

@contextlib.contextmanager
def locked(root):
    folder = root / '.website-os'
    folder.mkdir(parents=True, exist_ok=True)
    lock = folder / 'write.lock'
    try:
        lock.mkdir()
    except FileExistsError:
        raise Invalid('Another edit is running (or left a stale .website-os/write.lock). Check it before removing the lock.')
    try:
        yield
    finally:
        lock.rmdir()

def validate_value(key, spec, value):
    kind = spec.get('type')
    if kind == 'number':
        require(type(value) in (int, float) and math.isfinite(value), f'{key}: expected a finite number')
        require(spec.get('min', 0) <= value <= spec.get('max', 100), f'{key}: outside allowed range')
        return value
    require(isinstance(value, str), f'{key}: expected a string')
    require(not any(ord(c) < 32 and c not in '\n\t' for c in value), f'{key}: control characters are not allowed')
    require(len(value) <= spec.get('max_length', 2000), f'{key}: exceeds maximum length')
    require(value.strip() or spec.get('allow_empty', False), f'{key}: cannot be empty')
    if kind == 'color':
        require(re.fullmatch(r'#[0-9a-fA-F]{6}', value), f'{key}: use a six-digit hex colour')
    if kind == 'choice':
        require(value in spec['choices'], f'{key}: not one of the configured choices')
    if kind in ('url', 'image'):
        require(value == value.strip() and not re.search(r'[\s\\<>"\x00-\x1f]', value), f'{key}: malformed URL')
        require(not value.startswith('//'), f'{key}: protocol-relative URLs are not supported')
        parsed = urlsplit(value)
        allowed = ('http', 'https') if kind == 'image' else ('http', 'https', 'mailto', 'tel')
        require(not parsed.scheme or parsed.scheme.lower() in allowed, f'{key}: URL scheme is not allowed')
        if parsed.scheme.lower() in ('http','https'):
            require(parsed.netloc and not parsed.username and not parsed.password, f'{key}: use a URL with a hostname and no credentials')
        elif not parsed.scheme:
            require(not re.search(r'(?i)%2e|%2f|%5c', parsed.path), f'{key}: encoded path separators are not supported')
            require('..' not in parsed.path.split('/'), f'{key}: parent paths are not allowed')
    return value

def parse_fields(data):
    require(isinstance(data, dict) and data, 'Fields must be a nonempty JSON object')
    schema, content, css_names = {}, {}, set()
    for key, raw in data.items():
        require(ID.fullmatch(key), f'Invalid field ID: {key}')
        require(isinstance(raw, dict) and raw.get('type') in KINDS and 'value' in raw, f'{key}: needs type and value')
        spec = {k:v for k,v in raw.items() if k != 'value'}
        require(set(spec) <= {'type','label','group','max_length','allow_empty','choices','min','max','css','unit'}, f'{key}: unknown field setting')
        if spec['type'] == 'choice':
            require(isinstance(spec.get('choices'), list) and spec['choices'] and all(isinstance(x,str) for x in spec['choices']), f'{key}: choices must be strings')
        if 'css' in spec:
            require(spec['type'] in ('color','number'), f'{key}: CSS variables must be colors or bounded numbers')
            require(isinstance(spec['css'], str) and re.fullmatch(r'--[a-z][a-z0-9-]*', spec['css']), f'{key}: invalid CSS variable')
            require(spec['css'] not in css_names, f'{key}: duplicate CSS variable')
            css_names.add(spec['css'])
        if 'unit' in spec:
            require(spec['type'] == 'number' and spec['unit'] in UNITS, f'{key}: invalid CSS unit')
        if spec['type'] == 'number':
            require(type(spec.get('min',0)) in (int,float) and type(spec.get('max',100)) in (int,float), f'{key}: range must be numeric')
            require(math.isfinite(spec.get('min',0)) and math.isfinite(spec.get('max',100)) and spec.get('min',0) <= spec.get('max',100), f'{key}: invalid range')
        if 'max_length' in spec:
            require(type(spec['max_length']) is int and spec['max_length'] > 0, f'{key}: invalid max_length')
        schema[key] = spec
        content[key] = validate_value(key, spec, raw['value'])
    return schema, content

class TemplateAudit(HTMLParser):
    """Allow content slots in text and approved attributes, never in executable code."""
    def __init__(self, schema):
        super().__init__(convert_charrefs=False)
        self.schema = schema
        self.context = []
        self.seen = []
        self.css_markers = 0
    def handle_starttag(self, tag, attrs):
        raw = self.get_starttag_text()
        found = []
        for attr, value in attrs:
            if value is None:
                continue
            ids = TOKEN.findall(value)
            found.extend(ids)
            for key in ids:
                require(key in self.schema, f'Template references unknown field {key}')
                kind = self.schema[key]['type']
                allowed = {'alt','title','aria-label','placeholder'}
                safe = attr in allowed or (tag == 'meta' and attr == 'content')
                if attr == 'href':
                    safe = tag == 'a' and kind == 'url' and value == '{{wos:' + key + '}}'
                if attr == 'src':
                    safe = tag in ('img','video','source') and kind == 'image' and value == '{{wos:' + key + '}}'
                if attr == 'poster':
                    safe = tag == 'video' and kind == 'image' and value == '{{wos:' + key + '}}'
                if attr in ('data-media','data-poster'):
                    safe = tag == 'a' and kind == 'image' and value == '{{wos:' + key + '}}'
                if attr == 'href' and tag == 'a' and kind == 'image':
                    safe = value == '{{wos:' + key + '}}'
                require(safe, f'{key}: unsupported binding in {tag}[{attr}]')
                require(re.search(r'''\b''' + re.escape(attr) + r'''\s*=\s*(["']).*?\1''', raw, re.S), f'{key}: attribute bindings must be quoted')
        require(sorted(found) == sorted(TOKEN.findall(raw)), 'Field slots are only allowed in text or approved quoted attributes')
        self.seen.extend(found)
        if tag in BLOCKED_TEXT_CONTEXT:
            self.context.append(tag)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)
    def handle_endtag(self, tag):
        require(not TOKEN.search(tag), 'Field slots are not allowed in tag names')
        if self.context and self.context[-1] == tag:
            self.context.pop()
    def handle_data(self, data):
        ids = TOKEN.findall(data)
        require(not ids or not self.context, 'Field slots cannot appear in scripts, styles or raw-text elements')
        for key in ids:
            require(key in self.schema, f'Template references unknown field {key}')
        self.seen.extend(ids)
        if CSS_MARKER in data:
            require(self.context == ['style'], 'CSS marker must be inside a style element')
            self.css_markers += data.count(CSS_MARKER)
    def handle_comment(self, data):
        require(not TOKEN.search(data), 'Field slots cannot appear in HTML comments')
    def handle_decl(self, data):
        require(not TOKEN.search(data), 'Field slots cannot appear in declarations')

def validate_template(template, schema):
    require(isinstance(template,str) and re.search(r'<html\b',template,re.I), 'Template must be a complete HTML document')
    audit = TemplateAudit(schema)
    audit.feed(template)
    audit.close()
    require(sorted(audit.seen) == sorted(TOKEN.findall(template)), 'An unsupported field slot was found in the template')
    css_fields = {key for key,spec in schema.items() if 'css' in spec}
    require(audit.css_markers == (1 if css_fields else 0), 'Use exactly one CSS marker when fields define CSS variables')
    used = set(audit.seen) | css_fields
    require(used == set(schema), 'Unbound fields: ' + ', '.join(sorted(set(schema)-used)))
    # Values are substituted once; content containing marker-like text stays literal.
    residue = TOKEN.sub('', template).replace(CSS_MARKER, '')
    require('{{wos:' not in residue, 'Malformed field token')

def render(snapshot):
    template, schema, content = (snapshot[k] for k in ('template','schema','content'))
    validate_template(template, schema)
    for key,spec in schema.items():
        validate_value(key,spec,content[key])
    css = []
    for key,spec in schema.items():
        if 'css' in spec:
            css.append(f"  {spec['css']}: {content[key]}{spec.get('unit','')};")
    template = template.replace(CSS_MARKER, ':root {\n'+'\n'.join(css)+'\n}' if css else '')
    return TOKEN.sub(lambda m: html.escape(str(content[m[1]]), quote=True), template)

def paths(root):
    return root / '.website-os/state.json', root / 'index.html'

def load(root, verify=True):
    state_path,index = paths(root)
    require(state_path.exists(), 'No Website OS model here. Run init first.')
    state = read_json(state_path)
    require(state.get('format') == 1, 'Unsupported Website OS state version')
    if verify:
        require(index.exists() and digest(index.read_text(encoding='utf-8')) == state['rendered_sha256'], 'index.html changed outside Website OS. Preserve those edits and use rebase, or explicitly repair from saved state.')
        require(digest(render(state['revisions'][-1])) == state['rendered_sha256'], 'Saved model was modified outside Website OS. Restore state before continuing.')
    return state

def save(root, state):
    state_path,index = paths(root)
    output = render(state['revisions'][-1])
    state['rendered_sha256'] = digest(output)
    old = index.read_bytes() if index.exists() else None
    atomic(index, output)
    try:
        atomic(state_path, encode(state))
    except Exception:
        if old is not None:
            atomic(index, old.decode('utf-8'))
        else:
            index.unlink(missing_ok=True)
        raise
    # A crash between the two atomic file writes is detected by load(). Repair
    # explicitly rebuilds index.html from the last saved state; it cannot guess intent.

def revision(snapshot, number, message, kind, **details):
    return dict(snapshot, revision=number, created_at=now(), message=message, kind=kind, **details)

def snap(rev):
    return {k:rev[k] for k in ('template','schema','content')}

def diff_content(before,after):
    return [{'id':key,'from':before.get(key),'to':after.get(key)} for key in sorted(set(before)|set(after)) if before.get(key)!=after.get(key)]

def commit(root,state,snapshot,message,kind,undo=True,**details):
    if undo:
        state['undo_targets'].append(state['revisions'][-1]['revision'])
    state['revisions'].append(revision(snapshot,len(state['revisions']),message,kind,**details))
    save(root,state)
    return {'status':'saved locally','revision':len(state['revisions'])-1,'file':str(root/'index.html'),'published':False}

def draft_path(root, draft_id):
    require(re.fullmatch(r'[0-9a-f]{12}',draft_id), 'Invalid draft ID')
    return root / '.website-os/drafts' / (draft_id + '.json')

def run(args):
    root = Path(args.root).resolve()
    if args.command == 'init':
        require(not paths(root)[0].exists(), 'This project is already initialized')
        require(not paths(root)[1].exists(), 'index.html already exists. Initialize in a fresh output folder to preserve it.')
        template = Path(args.template).read_text(encoding='utf-8')
        schema,content = parse_fields(read_json(Path(args.fields)))
        snapshot = dict(template=template,schema=schema,content=content)
        render(snapshot)
        state = {'format':1,'undo_targets':[],'revisions':[revision(snapshot,0,args.message,'init')]}
        save(root,state)
        return {'status':'initialized','revision':0,'fields':len(schema),'file':str(root/'index.html'),'published':False}
    state = load(root,verify=args.command != 'repair')
    current = state['revisions'][-1]
    if args.command == 'inspect':
        return {'revision':current['revision'],'fields':{k:dict(v,value=current['content'][k]) for k,v in current['schema'].items()}}
    if args.command == 'export':
        dest = Path(args.out).resolve()
        require(dest != root and not root.is_relative_to(dest), 'Export must be outside the project or in a child output folder')
        for folder in ('assets', 'img'):
            source = root / folder
            if source.exists():
                require(not dest.is_relative_to(source), 'Export cannot be inside a source asset directory')
                require(not source.is_symlink() and not any(p.is_symlink() for p in source.rglob('*')), 'Symlinked assets cannot be exported')
                target = dest / folder
                require(not target.is_symlink() and not any(p.is_symlink() for p in target.rglob('*')), 'Export target cannot contain symlinks')
        dest.mkdir(parents=True,exist_ok=True)
        require(not (dest / 'index.html').is_symlink(),'Export index cannot be a symlink')
        atomic(dest / 'index.html', render(current))
        for folder in ('assets', 'img'):
            if (root / folder).exists(): shutil.copytree(root / folder, dest / folder, dirs_exist_ok=True)
        return {'status':'exported','directory':str(dest),'published':False}
    if args.command == 'history':
        return {'revisions':[{k:v for k,v in row.items() if k not in ('template','schema','content')} for row in state['revisions']]}
    if args.command == 'verify':
        return {'status':'consistent','revision':current['revision'],'fields':len(current['schema']),'rendered_sha256':state['rendered_sha256'],'published':False}
    if args.command == 'repair':
        require(args.confirm, 'Repair overwrites index.html from saved state. Re-run with --confirm only when that is intended.')
        save(root,state)
        return {'status':'repaired from saved state','revision':current['revision'],'published':False}
    if args.command == 'draft':
        changes = read_json(Path(args.changes))
        require(isinstance(changes,list) and changes, 'Changes must be a nonempty JSON array')
        content = dict(current['content']); seen = set()
        for change in changes:
            require(isinstance(change,dict) and set(change) == {'op','id','value'} and change['op']=='set', 'Only {op: set, id, value} operations are allowed')
            key = change['id']
            require(isinstance(key,str) and key in current['schema'], f'Unknown field: {key}')
            require(key not in seen, f'Duplicate operation for {key}')
            seen.add(key)
            content[key] = validate_value(key,current['schema'][key],change['value'])
        diff = diff_content(current['content'],content)
        require(diff, 'No values changed')
        snapshot = dict(snap(current),content=content)
        output = render(snapshot)
        draft_id = uuid.uuid4().hex[:12]
        draft = {'id':draft_id,'base_revision':current['revision'],'base_state_sha256':digest(encode(state)),'base_html_sha256':state['rendered_sha256'],'message':args.message,'changes':changes,'diff':diff,'preview_sha256':digest(output),'created_at':now()}
        atomic(draft_path(root,draft_id), encode(draft))
        preview = root / f'preview-{draft_id}.html'
        atomic(preview,output)
        return {'status':'draft','draft':draft_id,'preview':str(preview),'diff':diff,'published':False}
    if args.command in ('diff','apply'):
        draft = read_json(draft_path(root,args.draft))
        require(draft['base_state_sha256'] == digest(encode(state)), 'Stale draft. Re-plan it against the latest revision.')
        if args.command == 'diff':
            return draft
        content = dict(current['content']); seen=set()
        for change in draft['changes']:
            require(isinstance(change,dict) and set(change)=={'op','id','value'} and change['op']=='set','Draft has an invalid operation')
            key=change['id']
            require(isinstance(key,str) and key in current['schema'] and key not in seen,'Draft has an unknown or duplicate field')
            seen.add(key)
            content[key] = validate_value(key,current['schema'][key],change['value'])
        snapshot=dict(snap(current),content=content)
        require(digest(render(snapshot))==draft['preview_sha256'],'Draft changed after its preview was rendered. Make a new draft.')
        preview=root/f'preview-{args.draft}.html'
        require(preview.exists() and digest(preview.read_text(encoding='utf-8'))==draft['preview_sha256'],'Preview changed or is missing. Make a new draft.')
        return commit(root,state,snapshot,draft['message'],'edit',draft=args.draft)
    if args.command == 'undo':
        require(state['undo_targets'],'Nothing to undo')
        target=state['undo_targets'].pop()
        return commit(root,state,snap(state['revisions'][target]),args.message,'undo',undo=False,restored_from=target)
    if args.command == 'rebase':
        template=Path(args.template).read_text(encoding='utf-8')
        schema,content=parse_fields(read_json(Path(args.fields)))
        # Existing values win; template edits must not silently reset the copy.
        for key in set(schema) & set(current['content']):
            content[key]=validate_value(key,schema[key],current['content'][key])
        removed=sorted(set(current['schema'])-set(schema))
        require(not removed or args.allow_removed_fields, 'Rebase removes fields: '+', '.join(removed)+'. Use --allow-removed-fields only when that removal was requested.')
        snapshot=dict(template=template,schema=schema,content=content)
        render(snapshot)
        return commit(root,state,snapshot,args.message,'design',removed_fields=removed)
    raise Invalid('Unknown command')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    for command in ('init','inspect','draft','diff','apply','undo','history','verify','rebase','repair','export'):
        p=commands.add_parser(command)
        p.add_argument('root',help='Website project directory')
        if command in ('init','rebase'):
            p.add_argument('--template',required=True);p.add_argument('--fields',required=True)
        if command in ('init','draft','undo','rebase'):
            p.add_argument('--message',default={'init':'Initial website','draft':'Edit website','undo':'Undo last change','rebase':'Update design'}[command])
        if command=='draft':p.add_argument('--changes',required=True)
        if command in ('diff','apply'):p.add_argument('--draft',required=True)
        if command=='rebase':p.add_argument('--allow-removed-fields',action='store_true')
        if command=='export':p.add_argument('--out',required=True)
        if command=='repair':p.add_argument('--confirm',action='store_true')
    args=parser.parse_args()
    try:
        root=Path(args.root).resolve()
        if args.command in ('inspect','history','verify','diff'):
            result=run(args)
        else:
            with locked(root):result=run(args)
        print(encode(result),end='')
    except (Invalid,OSError,ValueError,KeyError,TypeError) as error:
        print(encode({'status':'error','message':str(error)}),file=sys.stderr,end='')
        return 1
    return 0

if __name__=='__main__':
    sys.exit(main())
