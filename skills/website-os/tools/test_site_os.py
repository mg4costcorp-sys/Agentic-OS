#!/usr/bin/env python3
"""Behaviour tests for Website OS's content persistence and edit boundaries."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT=Path(__file__).with_name('site_os.py')
TEMPLATE='''<!doctype html><html><head><title>{{wos:title}}</title><style>/* website-os:tokens */ h1{color:var(--accent)}</style><script>const preserved = 42;</script></head><body><h1>{{wos:title}}</h1><a href="{{wos:link}}">Link</a><img src="{{wos:image}}" alt="Picture"><footer>Unchanged footer</footer></body></html>'''
FIELDS={
 'title':{'type':'text','value':'Original','max_length':100},
 'link':{'type':'url','value':'https://example.com'},
 'image':{'type':'image','value':'assets/photo.png'},
 'accent':{'type':'color','value':'#FF6B35','css':'--accent'},
 'radius':{'type':'number','value':12,'min':0,'max':40,'css':'--radius','unit':'px'}
}

class SiteTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name);self.root=self.base/'site'
  self.template=self.base/'template.html';self.template.write_text(TEMPLATE)
  self.fields=self.base/'fields.json';self.fields.write_text(json.dumps(FIELDS))
  self.call('init','--template',self.template,'--fields',self.fields)
  self.original=(self.root/'index.html').read_bytes()
 def tearDown(self):self.tmp.cleanup()
 def call(self,command,*args,ok=True):
  result=subprocess.run([sys.executable,str(SCRIPT),command,str(self.root),*map(str,args)],capture_output=True,text=True)
  self.assertEqual(result.returncode==0,ok,result.stdout+result.stderr)
  return json.loads(result.stdout if ok else result.stderr)
 def draft(self,changes,ok=True):
  path=self.base/'changes.json';path.write_text(json.dumps(changes))
  return self.call('draft','--changes',path,ok=ok)
 def setvalue(self,key,value):return self.draft([{'op':'set','id':key,'value':value}])
 def test_apply_and_undo_preserve_structure(self):
  draft=self.setvalue('title','New & real')
  self.assertEqual((self.root/'index.html').read_bytes(),self.original)
  self.assertIn('New &amp; real',Path(draft['preview']).read_text())
  self.call('apply','--draft',draft['draft'])
  output=(self.root/'index.html').read_text();self.assertIn('const preserved = 42;',output);self.assertIn('Unchanged footer',output)
  self.call('undo');self.assertEqual((self.root/'index.html').read_bytes(),self.original);self.call('verify')
 def test_content_is_escaped(self):
  draft=self.setvalue('title','<img src=x onerror=alert(1)>')
  self.call('apply','--draft',draft['draft'])
  output=(self.root/'index.html').read_text();self.assertIn('&lt;img',output);self.assertNotIn('<img src=x',output)
 def test_unknown_field_is_atomic(self):
  self.draft([{'op':'set','id':'title','value':'Valid'},{'op':'set','id':'invented','value':'Bad'}],ok=False)
  self.assertEqual((self.root/'index.html').read_bytes(),self.original)
  self.assertFalse((self.root/'.website-os/drafts').exists())
 def test_duplicate_ops_fail(self):
  self.draft([{'op':'set','id':'title','value':'A'},{'op':'set','id':'title','value':'B'}],ok=False)
 def test_unsafe_url_fails(self):
  for key,url in [('link','javascript:alert(1)'),('image','data:image/svg+xml,evil'),('link','java\nscript:evil'),('image','../private.png'),('link','//example.com'),('link','https://user:secret@example.com')]:
   self.draft([{'op':'set','id':key,'value':url}],ok=False)
 def test_safe_relative_url_and_image(self):
  draft=self.draft([{'op':'set','id':'link','value':'/about#contact'},{'op':'set','id':'image','value':'assets/new-photo.webp'}]);self.call('apply','--draft',draft['draft'])
 def test_invalid_number_and_color(self):
  for key,value in [('accent','red;display:none'),('accent','#fff'),('radius',41),('radius',True),('radius','12px')]:
   self.draft([{'op':'set','id':key,'value':value}],ok=False)
 def test_stale_draft_rejected(self):
  a=self.setvalue('title','First');b=self.setvalue('title','Second');self.call('apply','--draft',a['draft']);self.call('apply','--draft',b['draft'],ok=False)
  self.assertIn('First',(self.root/'index.html').read_text())
 def test_altered_preview_rejected(self):
  draft=self.setvalue('title','New');Path(draft['preview']).write_text('tampered');self.call('apply','--draft',draft['draft'],ok=False)
 def test_direct_edit_detected(self):
  (self.root/'index.html').write_text('outside edit');self.call('inspect',ok=False);self.call('repair',ok=False);self.call('repair','--confirm');self.assertEqual((self.root/'index.html').read_bytes(),self.original)
 def test_rebase_preserves_content_and_is_undoable(self):
  draft=self.setvalue('title','Accepted');self.call('apply','--draft',draft['draft'])
  revised=TEMPLATE.replace('<footer>','<section id="new">New section</section><footer>');self.template.write_text(revised)
  self.call('rebase','--template',self.template,'--fields',self.fields)
  self.assertIn('Accepted',(self.root/'index.html').read_text());self.assertIn('id="new"',(self.root/'index.html').read_text())
  self.call('undo');self.assertNotIn('id="new"',(self.root/'index.html').read_text());self.assertIn('Accepted',(self.root/'index.html').read_text())
  self.call('undo');self.assertEqual((self.root/'index.html').read_bytes(),self.original)
 def test_slots_in_executable_context_fail(self):
  for injected in ['<script>let x="{{wos:title}}"</script>','<div onclick="{{wos:title}}">x</div>','<div style="color:{{wos:accent}}">x</div>','<!-- {{wos:title}} -->','<a href={{wos:link}}>x</a>']:
   self.template.write_text(TEMPLATE.replace('</body>',injected+'</body>'))
   self.call('rebase','--template',self.template,'--fields',self.fields,ok=False)
 def test_repeated_binding_and_marker_text(self):
  value='Keep {{wos:accent}} literal';draft=self.setvalue('title',value);self.call('apply','--draft',draft['draft']);self.assertEqual((self.root/'index.html').read_text().count(value),2)
 def test_export_excludes_model_and_drafts(self):
  (self.root/'assets').mkdir();(self.root/'assets/photo.png').write_bytes(b'fixture')
  self.setvalue('title','Unsaved');dest=self.base/'export';self.call('export','--out',dest)
  self.assertEqual((dest/'index.html').read_bytes(),self.original);self.assertTrue((dest/'assets/photo.png').exists());self.assertFalse((dest/'.website-os').exists());self.assertFalse(list(dest.glob('preview-*')))
 def test_export_rejects_asset_symlinks(self):
  (self.root/'assets').mkdir();(self.root/'assets/secret').symlink_to(self.fields)
  self.call('export','--out',self.base/'export',ok=False)
 def test_noop_or_empty_changes_rejected(self):
  self.draft([],ok=False);self.draft([{'op':'set','id':'title','value':'Original'}],ok=False)
 def test_field_removal_requires_explicit_flag(self):
  data=dict(FIELDS);data.pop('image');self.fields.write_text(json.dumps(data));self.template.write_text(TEMPLATE.replace('<img src="{{wos:image}}" alt="Picture">',''))
  self.call('rebase','--template',self.template,'--fields',self.fields,ok=False)
  self.call('rebase','--template',self.template,'--fields',self.fields,'--allow-removed-fields');self.call('undo');self.assertEqual((self.root/'index.html').read_bytes(),self.original)

if __name__=='__main__':unittest.main()
