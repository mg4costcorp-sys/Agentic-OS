#!/usr/bin/env python3
"""Local Website OS editor. Loopback only; never publish this development server."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlsplit
from pathlib import Path
from types import SimpleNamespace
import argparse,json,tempfile,threading,subprocess
import site_os
import media
from build import build,PROJECT,DIST
LOCK=threading.Lock()
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(DIST),**kw)
 def end_headers(self):
  self.send_header('Cache-Control','no-store');self.send_header('X-Website-OS','1');super().end_headers()
 def allowed(self):
  host=self.headers.get('Host','')
  expected={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
  return host in expected and (not self.headers.get('Origin') or self.headers['Origin'] in {'http://'+h for h in expected})
 def reply(self,code,data):
  raw=site_os.encode(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if not self.allowed():return self.reply(403,{'message':'This editor accepts local requests only'})
  if self.path.split('?')[0]=='/__wos/model':
   try:
    with LOCK:model=build()
    model['generation']=media.capabilities();model['mediaJobs']=media.recent_jobs()
    return self.reply(200,model)
   except Exception as e:return self.reply(409,{'message':str(e)})
  if self.path.startswith('/__wos/job/'):
   try:return self.reply(200,media.read_job(self.path.split('?')[0].rsplit('/',1)[-1]))
   except ValueError as e:return self.reply(404,{'message':str(e)})
  return super().do_GET()
 def do_POST(self):
  if not self.allowed():return self.reply(403,{'message':'This editor accepts local requests only'})
  if self.path not in ('/__wos/save','/__wos/undo','/__wos/upload','/__wos/generate'):return self.reply(404,{'message':'Unknown action'})
  if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply(415,{'message':'JSON is required'})
  try:
   size=int(self.headers.get('Content-Length','0'));site_os.require(0<size<=(56*1024*1024 if self.path=='/__wos/upload' else 100000),'Invalid request size')
   data=json.loads(self.rfile.read(size))
   site_os.require(isinstance(data,dict),'The request must be a JSON object')
   if self.path=='/__wos/upload':return self.reply(200,media.upload(data))
   if self.path=='/__wos/generate':return self.reply(202,media.generate(data))
   with LOCK,site_os.locked(PROJECT):
    state=site_os.load(PROJECT);site_os.require(data.get('revision')==state['revisions'][-1]['revision'],'The homepage changed. Reload before saving again.')
    if self.path=='/__wos/save':
     with tempfile.TemporaryDirectory() as temp:
      path=Path(temp)/'changes.json';path.write_text(site_os.encode(data.get('changes')))
      draft=site_os.run(SimpleNamespace(command='draft',root=str(PROJECT),changes=str(path),message='Edit homepage through Website OS'))
      result=site_os.run(SimpleNamespace(command='apply',root=str(PROJECT),draft=draft['draft']))
    else:result=site_os.run(SimpleNamespace(command='undo',root=str(PROJECT),message='Undo Website OS edit'))
    build()
   return self.reply(200,result)
  except subprocess.SubprocessError:return self.reply(409,{'message':'The media operation could not finish. Check ffmpeg/ffprobe and try again. No source change was saved.'})
  except (ValueError,KeyError,TypeError,OSError) as e:return self.reply(409,{'message':str(e)})
 def log_message(self,fmt,*args):pass
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8876);a=p.parse_args();media.recover_jobs();build()
 server=ThreadingHTTPServer(('127.0.0.1',a.port),Handler)
 print(f'Website OS: http://127.0.0.1:{server.server_port}',flush=True)
 server.serve_forever()
