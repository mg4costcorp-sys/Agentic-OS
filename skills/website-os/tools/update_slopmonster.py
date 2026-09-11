#!/usr/bin/env python3
"""Check or refresh Website OS's pinned SlopMonster copy from Jack's public repo."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parent.parent
REPO='ItsssssJack/SlopMonster'

def fetch(url,limit):
    with urlopen(Request(url,headers={'User-Agent':'Website-OS-updater','Accept':'application/vnd.github+json'}),timeout=30) as response:
        data=response.read(limit+1)
    if len(data)>limit:raise ValueError('Upstream response exceeds the size limit')
    return data

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--check',action='store_true');action.add_argument('--update',action='store_true')
    args=parser.parse_args()
    manifest=json.loads((ROOT/'SOURCES.json').read_text())
    previous=manifest['sources']['slopmonster']['commit']
    current=json.loads(fetch(f'https://api.github.com/repos/{REPO}/commits/main',1000000))['sha']
    if len(current)!=40 or any(c not in '0123456789abcdef' for c in current):raise ValueError('Malformed upstream commit')
    if args.check or current==previous:
        print(json.dumps({'pinned':previous,'upstream':current,'update_available':current!=previous}));return
    # Stage beside the vendor folder so renames stay on the same filesystem.
    with tempfile.TemporaryDirectory(prefix='.slop-update-',dir=ROOT/'vendor') as tmp:
        staging=Path(tmp)/'slopmonster';staging.mkdir()
        archive=fetch(f'https://codeload.github.com/{REPO}/tar.gz/{current}',25000000)
        with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:
            total=0
            for member in tar.getmembers():
                parts=PurePosixPath(member.name).parts
                if '..' in parts or member.name.startswith('/') or member.issym() or member.islnk():raise ValueError('Unsafe archive path')
                if not member.isfile() or len(parts)<2:continue
                rel=Path(*parts[1:])
                if rel.parts[0] not in ('tools','references','prompts','LICENSE','SKILL.md'):continue
                total+=member.size
                if total>12000000:raise ValueError('Unexpected upstream file size')
                if rel.as_posix()=='SKILL.md':rel=Path('UPSTREAM-SKILL.md')
                out=staging/rel;out.parent.mkdir(parents=True,exist_ok=True)
                out.write_bytes(tar.extractfile(member).read())
        for required in ('LICENSE','tools/deslop.py','tools/test_deslop.py','prompts/cleanse.txt'):
            if not (staging/required).is_file():raise ValueError('Missing '+required)
        test=subprocess.run([sys.executable,'tools/test_deslop.py'],cwd=staging,capture_output=True,text=True,timeout=60)
        if test.returncode:raise ValueError('Upstream tests failed; previous copy retained.\n'+test.stdout[-2000:]+test.stderr[-2000:])
        # Regression tests can create Python bytecode; keep it out of the bundle.
        for cache in staging.rglob('__pycache__'):shutil.rmtree(cache)
        files={str(p.relative_to(staging)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(staging.rglob('*')) if p.is_file()}
        original=ROOT/'vendor/slopmonster';backup=Path(tmp)/'backup';original.rename(backup)
        try:
            staging.rename(original)
            manifest['sources']['slopmonster'].update(commit=current,verified_at=datetime.now(timezone.utc).date().isoformat(),files=files)
            target=ROOT/'SOURCES.json';temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(manifest,indent=2)+'\n');temporary.replace(target)
        except Exception:
            if original.exists():shutil.rmtree(original)
            backup.rename(original)
            raise
    print(json.dumps({'updated':True,'previous':previous,'commit':current,'tests':'passed'}))

if __name__=='__main__':
    try:main()
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
