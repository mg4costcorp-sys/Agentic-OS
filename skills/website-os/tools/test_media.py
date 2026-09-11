"""Focused checks for media drafts and the code/content boundary."""
import base64, hashlib, json, tempfile, unittest, struct, zlib
from pathlib import Path
from unittest.mock import patch
import media, site_os

class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name);self.project=self.root/'project'
        (self.project/'art').mkdir(parents=True)
        def chunk(kind, payload):
            return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
        pixels = (b'\x00' + b'\x88\xaa\x99' * 1024) * 1024
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1024, 1024, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
        (self.project/'art/form.png').write_bytes(png)
        self.patches=[patch.object(media,'ROOT',self.root),patch.object(media,'PROJECT',self.project),patch.object(media,'JOBS',self.project/'.website-os/jobs')]
        for p in self.patches:p.start()
        self.current={'revision':1,'content':{'media.form.image':'/art/form.png'}}
        self.asset={'id':'form','name':'Form','imageField':'media.form.image'}
        (self.root/'workspace.json').write_text(json.dumps({'media':[self.asset]}))
        self.loader=patch.object(site_os,'load',return_value={'revisions':[self.current]});self.loader.start()
        self.data={'revision':1,'assetId':'form','kind':'image','filename':'replacement.png','data':base64.b64encode((self.project/'art/form.png').read_bytes()).decode()}
    def tearDown(self):
        self.loader.stop()
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def test_upload_preserves_original_and_only_returns_draft(self):
        before=(self.project/'art/form.png').read_bytes()
        result=media.upload(self.data)
        self.assertEqual(result['dimensions']['width'],1024)
        self.assertEqual(result['dimensions']['height'],1024)
        self.assertEqual((self.project/'art/form.png').read_bytes(),before)
        self.assertEqual(self.current['content']['media.form.image'],'/art/form.png')
        self.assertTrue((self.root/'dist'/result['url'].lstrip('/')).is_file())
    def test_upload_rejects_stale_revision_and_svg(self):
        for update in ({'revision':0},{'filename':'replacement.svg'},{'data':'not base64'}):
            with self.subTest(update=update),self.assertRaises(ValueError):media.upload(dict(self.data,**update))
    def test_sources_cannot_escape_the_project(self):
        for path in ('/art/../../secret','https://example.com/asset.png','/etc/passwd'):
            with self.subTest(path=path),self.assertRaises(ValueError):media.local_path(path)
        outside=self.root/'secret.png';outside.write_bytes(b'private')
        (self.project/'art/link.png').symlink_to(outside)
        with self.assertRaises(ValueError):media.local_path('/art/link.png')
    def test_generation_is_idempotent_without_resubmission(self):
        data=dict(self.data,prompt='Fresh sculptural glass shapes',requestId='a'*32)
        with patch.object(media,'capabilities',return_value={'available':True}),patch.object(media.threading,'Thread') as thread:
            first=media.generate(data);second=media.generate(data)
            self.assertEqual(first['id'],second['id']);self.assertEqual(thread.call_count,1)
            with self.assertRaises(ValueError):media.generate(dict(data,requestId='b'*32))
    def test_restart_does_not_retry_billable_work(self):
        job={'id':'c'*32,'status':'running','createdAt':1};media.write_job(job)
        media.recover_jobs();self.assertEqual(media.read_job(job['id'])['status'],'failed')
    def test_media_binding_never_allows_script_sources(self):
        schema={'asset':{'type':'image','value':'/art/form.png'}}
        for tag in ('script','iframe','object'):
            validator=site_os.TemplateAudit(schema)
            with self.assertRaises(ValueError):validator.feed('<'+tag+' src="{{wos:asset}}"></'+tag+'>')

if __name__=='__main__':unittest.main()
