#!/usr/bin/env python3
"""Export the real homepage and its Website OS workspace. No private model history ships."""
from pathlib import Path
import json,shutil,subprocess,sys
import site_os
from copy_review import load_review
from media import inventory
ROOT=Path(__file__).resolve().parent.parent
PROJECT=ROOT/'project';DIST=ROOT/'dist'
def build():
 state=site_os.load(PROJECT);current=state['revisions'][-1]
 DIST.mkdir(exist_ok=True)
 for item in PROJECT.iterdir():
  if item.name in ('assets','art','img','logos'):
   if item.is_symlink() or any(p.is_symlink() for p in item.rglob('*')):raise site_os.Invalid('Symlinked assets cannot be exported')
   shutil.copytree(item,DIST/item.name,dirs_exist_ok=True)
  elif item.is_file() and item.suffix in ('.css','.js','.svg','.ico'):
   if item.is_symlink():raise site_os.Invalid('Symlinked public files cannot be exported')
   shutil.copy2(item,DIST/item.name)
 site_os.atomic(DIST/'homepage.html',site_os.render(current))
 for item in (ROOT/'studio').iterdir():
  if item.is_file():shutil.copy2(item,DIST/item.name)
  elif item.name=='ui-build':shutil.copytree(item,DIST/'ui-build',dirs_exist_ok=True)
 workspace=json.loads((ROOT/'workspace.json').read_text()) if (ROOT/'workspace.json').exists() else {}
 model={'workspace':workspace,'revision':current['revision'],'canUndo':bool(state['undo_targets']),'fields':{k:dict(s,value=current['content'][k]) for k,s in current['schema'].items()}}
 model['media']=inventory(workspace,current)
 checker=ROOT/'tools/deslop.py'
 if checker.exists():
  check=subprocess.run([sys.executable,str(checker),str(DIST/'homepage.html')],capture_output=True,text=True,timeout=15)
  model['copyAudit']={'report':check.stdout.strip() if 'score ' in check.stdout else 'Copy check unavailable','revision':current['revision']}
 review=load_review(ROOT,current)
 if review:model['copyReview']=review
 site_os.atomic(DIST/'model.json',site_os.encode(model))
 return model
if __name__=='__main__':
 m=build();print(json.dumps({'built':str(DIST),'revision':m['revision'],'fields':len(m['fields'])}))
