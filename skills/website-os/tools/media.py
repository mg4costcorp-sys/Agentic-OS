"""Local media drafts and OpenArt jobs. Saving a field is always a separate action."""
from pathlib import Path
import base64, json, math, shutil, subprocess, tempfile, threading, time, uuid
import site_os

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / 'project'
JOBS = PROJECT / '.website-os/jobs'
JOB_LOCK = threading.Lock()
PROBE_CACHE = {}
IMAGE_MODEL = 'nano-banana-2'
VIDEO_MODEL = 'byte-plus-seedance-2-fast'

def local_path(url):
    site_os.require(isinstance(url,str) and url.startswith(('/assets/','/art/','/img/')), 'Choose a local project asset first.')
    path = PROJECT / url.lstrip('/')
    site_os.require(not path.is_symlink() and path.resolve().is_relative_to(PROJECT.resolve()) and path.is_file(), 'The asset is not available in this project.')
    return path

def probe(path):
    key=(str(path),path.stat().st_mtime_ns)
    if key in PROBE_CACHE:return PROBE_CACHE[key]
    result=subprocess.run(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=width,height,codec_name:format=duration','-of','json',str(path)],capture_output=True,text=True,timeout=15)
    site_os.require(result.returncode==0,'This file could not be read as an image or video.')
    info=json.loads(result.stdout); streams=info.get('streams',[])
    site_os.require(bool(streams),'This file has no readable image or video.')
    stream=streams[0];w,h=stream['width'],stream['height']
    site_os.require(0<w<=8192 and 0<h<=8192,'Use an image or video no larger than 8192 pixels per side.')
    divisor=math.gcd(w,h)
    value={'width':w,'height':h,'ratio':f'{w//divisor}:{h//divisor}','duration':round(float(info.get('format',{}).get('duration',0)),2),'codec':stream.get('codec_name')}
    PROBE_CACHE[key]=value
    return value

def inventory(workspace,current):
    result=[]
    records=workspace.get('media',[])
    if not records:
        records=[{'id':'reference-'+str(i),'name':a[0],'note':a[1],'image':a[2],'referenceOnly':True} for i,a in enumerate(workspace.get('assets',[]))]
    for asset in records:
        item=dict(asset)
        for key in ('imageField','videoField'):
            if item.get(key): item['image' if key=='imageField' else 'video']=current['content'][item[key]]
        try:
            item['dimensions']=probe(local_path(item.get('video') or item['image']))
            item['imageDimensions']=probe(local_path(item['image']))
        except (ValueError,OSError,subprocess.SubprocessError):item['dimensions']=None
        result.append(item)
    return result

def find_asset(asset_id):
    workspace=json.loads((ROOT/'workspace.json').read_text())
    asset=next((a for a in workspace.get('media',[]) if a['id']==asset_id),None)
    site_os.require(asset is not None,'Unknown website asset.')
    return asset

def validate_target(data):
    asset=find_asset(data.get('assetId'))
    kind=data.get('kind','image')
    site_os.require(kind in ('image','video'),'Choose image or video.')
    field=asset.get('videoField' if kind=='video' else 'imageField')
    site_os.require(field is not None,'This source is reference-only. Edit the live graphic through the conversation.')
    current=site_os.load(PROJECT)['revisions'][-1]
    site_os.require(data.get('revision')==current['revision'],'The homepage changed. Reload before replacing media.')
    source=current['content'][field]
    dimensions=probe(local_path(source))
    return asset,kind,field,dimensions,current

def install_draft(source,kind,dimensions):
    folder=PROJECT/'assets/edits';folder.mkdir(parents=True,exist_ok=True)
    suffix='.mp4' if kind=='video' else '.png'
    target=folder/(uuid.uuid4().hex+suffix)
    w,h=dimensions['width'],dimensions['height']
    filters=f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1'
    command=['ffmpeg','-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',str(source),'-vf',filters]
    if kind=='video':
        command+=['-t',str(min(dimensions.get('duration') or 15,30)),'-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart']
    else:command+=['-frames:v','1','-update','1']
    result=subprocess.run(command+[str(target)],capture_output=True,timeout=120)
    if result.returncode:
        target.unlink(missing_ok=True)
        raise site_os.Invalid('Could not prepare that media file. Try a PNG, JPG, WebP, MP4 or WebM.')
    public=ROOT/'dist/assets/edits';public.mkdir(parents=True,exist_ok=True);shutil.copy2(target,public/target.name)
    return {'url':'/assets/edits/'+target.name,'dimensions':probe(target)}

def upload(data):
    asset,kind,field,dimensions,current=validate_target(data)
    name=str(data.get('filename',''));suffix=Path(name).suffix.lower()
    accepted=('.png','.jpg','.jpeg','.webp') if kind=='image' else ('.mp4','.webm','.mov')
    site_os.require(suffix in accepted,'Choose a PNG, JPG or WebP image, or an MP4, WebM or MOV video.')
    try:raw=base64.b64decode(data.get('data',''),validate=True)
    except (ValueError,TypeError):raise site_os.Invalid('The upload was incomplete. Choose the file again.')
    site_os.require(0<len(raw)<=40*1024*1024,'Choose a file smaller than 40 MB.')
    image_header=raw.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8\xff')) or (raw.startswith(b'RIFF') and raw[8:12]==b'WEBP')
    video_header=raw.startswith(b'\x1aE\xdf\xa3') or raw[4:8] in (b'ftyp',b'moov',b'wide',b'mdat')
    site_os.require(image_header if kind=='image' else video_header,'The file contents do not match a supported image or video.')
    with tempfile.TemporaryDirectory(prefix='website-os-upload-') as temp:
        path=Path(temp)/('upload'+suffix);path.write_bytes(raw);metadata=probe(path)
        if kind=='image':site_os.require(metadata['codec'] in ('png','mjpeg','webp'),'The file is not a supported image.')
        else:site_os.require(metadata['duration']<=120,'Use a video under two minutes.')
        result=install_draft(path,kind,dimensions)
    return dict(result,field=field,sourceDimensions=metadata)

def job_file(job_id):
    site_os.require(isinstance(job_id,str) and len(job_id)==32 and all(c in '0123456789abcdef' for c in job_id),'Invalid generation ID.')
    return JOBS/(job_id+'.json')

def read_job(job_id):
    path=job_file(job_id);site_os.require(path.exists(),'Generation not found.')
    return json.loads(path.read_text())

def write_job(job):
    JOBS.mkdir(parents=True,exist_ok=True);site_os.atomic(job_file(job['id']),site_os.encode(job))

def capabilities():
    return {'available':bool(shutil.which('openart') and shutil.which('ffmpeg') and shutil.which('ffprobe')),'provider':'OpenArt','imageModel':IMAGE_MODEL,'videoModel':VIDEO_MODEL,'imageResolution':'1K default','videoResolution':'720p'}

def generate(data):
    asset,kind,field,dimensions,current=validate_target(data)
    site_os.require(capabilities()['available'],'OpenArt is not installed on this computer. Upload a replacement or ask the conversation to generate one.')
    prompt=data.get('prompt','');site_os.require(isinstance(prompt,str) and 5<=len(prompt.strip())<=2500,'Describe the new graphic in 5 to 2500 characters.')
    request_id=data.get('requestId');job_file(request_id)
    with JOB_LOCK:
        if job_file(request_id).exists():return read_job(request_id)
        JOBS.mkdir(parents=True,exist_ok=True)
        for path in JOBS.glob('*.json'):
            other=json.loads(path.read_text())
            site_os.require(other.get('status') not in ('queued','running'),'A generation is already running. Let it finish before starting another.')
        job={'id':request_id,'status':'queued','assetId':asset['id'],'field':field,'kind':kind,'provider':'OpenArt','model':VIDEO_MODEL if kind=='video' else IMAGE_MODEL,'resolution':'720p' if kind=='video' else '1K','revision':current['revision'],'source':current['content'][field],'dimensions':dimensions,'createdAt':time.time()}
        write_job(job)
    threading.Thread(target=run_generation,args=(job,prompt,asset,current),daemon=True).start()
    return job

def generation_command(job,prompt,asset,current,output):
    kind=job['kind'];d=job['dimensions']
    brief=f"{prompt.strip()}\nWebsite artwork for {asset['name']}. Preserve the existing site's visual direction and the reference asset's role. No added text, logos or watermarks. Compose for {d['width']} x {d['height']} pixels ({d['ratio']}); the result will be fitted to these dimensions."
    command=['openart','generate',kind,brief,'--model',job.get('model') or (VIDEO_MODEL if kind=='video' else IMAGE_MODEL),'--no-input','--json','--timeout','9m','--output',str(output)]
    if kind=='image':
        command+=['--image',str(local_path(current['content'][asset['imageField']]))]
    if kind=='video':
        poster=current['content'][asset['imageField']]
        ratio=min(['16:9','4:3','1:1','3:4','9:16','21:9'],key=lambda r:abs(int(r.split(':')[0])/int(r.split(':')[1])-d['width']/d['height']))
        command+=['--image',str(local_path(poster)),'--duration',str(max(4,min(15,round(d.get('duration') or 5)))),'--aspect-ratio',ratio,'--resolution','720p']
    return command

def run_generation(job,prompt,asset,current):
    try:
        job['status']='running';write_job(job)
        temp_root=PROJECT/'.website-os/media-work';temp_root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temp_root) as temp:
            output=Path(temp)/('generated.mp4' if job['kind']=='video' else 'generated.png')
            result=subprocess.run(generation_command(job,prompt,asset,current,output),capture_output=True,text=True,timeout=570)
            if result.returncode:
                detail=(result.stderr+' '+result.stdout).lower()
                if any(word in detail for word in ['unauthorized','authentication','expired','login']):message='OpenArt needs you to sign in again. No replacement was saved.'
                elif 'credit' in detail:message='OpenArt could not complete this request. Check your credits and plan in OpenArt.'
                else:message='OpenArt did not complete the generation. Your original is unchanged. Check your OpenArt history before retrying.'
                raise site_os.Invalid(message)
            site_os.require(output.is_file(),'The generation did not return a downloadable file. Check your OpenArt history before retrying.')
            job.update(install_draft(output,job['kind'],job['dimensions']));job['status']='ready'
        write_job(job)
    except Exception as error:
        job['status']='failed';job['message']=str(error) if isinstance(error,site_os.Invalid) else 'Generation was interrupted. Check OpenArt history before retrying. Your original is unchanged.';write_job(job)

def recover_jobs():
    if not JOBS.exists():return
    for path in JOBS.glob('*.json'):
        job=json.loads(path.read_text())
        if job.get('status') in ('queued','running'):
            job['status']='failed';job['message']='The local editor restarted. Check OpenArt history before retrying; no automatic retry was sent.';write_job(job)

def recent_jobs():
    if not JOBS.exists():return []
    jobs=[json.loads(p.read_text()) for p in JOBS.glob('*.json')]
    return sorted(jobs,key=lambda j:j['createdAt'],reverse=True)[:30]
