"""Validate a prepared rewrite and expose an honest before/after review."""
from pathlib import Path
import json,subprocess,sys,tempfile
import site_os

def score(checker,html):
 with tempfile.TemporaryDirectory(prefix='website-os-copy-') as temp:
  p=Path(temp)/'homepage.html';p.write_text(html)
  r=subprocess.run([sys.executable,str(checker),str(p)],capture_output=True,text=True,timeout=15)
 return r.stdout.strip() if 'score ' in r.stdout else 'Copy check unavailable'

def load_review(root,current):
 path=root/'copy-review.json'
 if not path.exists():return None
 review=json.loads(path.read_text())
 site_os.require(review.get('format')==1,'Unsupported copy review format')
 source,rewritten=review['source'],review['rewritten']
 text_fields={k:v for k,v in current['content'].items() if current['schema'][k]['type']=='text'}
 if set(source)!=set(text_fields) or set(rewritten)!=set(source):return {'status':'stale'}
 for k in source:
  site_os.validate_value(k,current['schema'][k],source[k]);site_os.validate_value(k,current['schema'][k],rewritten[k])
 for k in review.get('lockedFields',[]):site_os.require(k in source and source[k]==rewritten[k],'Copy review changed a protected field')
 status='ready' if text_fields==source else 'applied' if text_fields==rewritten else 'stale'
 if status=='stale':return {'status':status}
 changes=[{'id':k,'label':current['schema'][k].get('label',k),'before':source[k],'after':rewritten[k],'note':review.get('notes',{}).get(k,'')} for k in source if source[k]!=rewritten[k]]
 before=dict(site_os.snap(current),content=dict(current['content'],**source))
 after=dict(site_os.snap(current),content=dict(current['content'],**rewritten))
 checker=root/'tools/deslop.py'
 return {'status':status,'changes':changes,'source':source,'rewritten':rewritten,'cleanse':review.get('cleanse',{'status':'pending'}),'beforeAudit':score(checker,site_os.render(before)),'afterAudit':score(checker,site_os.render(after))}
