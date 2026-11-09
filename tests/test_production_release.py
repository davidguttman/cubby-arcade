import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

class ProductionReleaseTests(unittest.TestCase):
    def test_runtime_download_checks_hash_and_never_publishes_partial(self):
        from rocknix import production_release as module
        class Response(io.BytesIO):
            headers = {'Content-Length': '7'}
            def geturl(self): return module.RUNTIME_URL
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with mock.patch.object(module, 'urlopen', return_value=Response(b'corrupt')):
                with self.assertRaises(ValueError): module.fetch_runtime(root)
            self.assertEqual(list(root.iterdir()), [])
            body=b'fixture'
            with mock.patch.object(module.image, 'ROOTFS_SHA256', hashlib.sha256(body).hexdigest()), mock.patch.object(module, 'urlopen', return_value=Response(body)):
                path=module.fetch_runtime(root)
                self.assertEqual(path.read_bytes(),body)

    def test_runtime_size_and_deadline_fail_closed(self):
        from rocknix import production_release as module
        class Response(io.BytesIO):
            headers = {'Content-Length': str(module.RUNTIME_SIZE+1)}
            def geturl(self): return module.RUNTIME_URL
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(module,'urlopen',return_value=Response(b'x')):
                with self.assertRaisesRegex(ValueError,'size'):module.fetch_runtime(directory)
            self.assertEqual(list(Path(directory).iterdir()),[])
            response=Response(b'x');response.headers={}
            with mock.patch.object(module,'urlopen',return_value=response), mock.patch.object(module.time,'monotonic',side_effect=[0,901]):
                with self.assertRaisesRegex(ValueError,'time budget'):module.fetch_runtime(directory)
            self.assertEqual(list(Path(directory).iterdir()),[])

    def test_release_image_gate_rejects_missing_stale_and_provisioned_before_verification(self):
        from rocknix import production_release as module
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); plan={'version':'1.2.3','source_commit':'a'*40,'flash_files':{},'app_files':{},'storage_files':{}}
            with mock.patch.object(module.production_image,'source_plan',return_value=plan), mock.patch.object(module.production_image,'verify') as verify:
                with self.assertRaises(ValueError):module.release_files(root,root,'1.2.3','a'*40)
                name=module.production_image.image_name(plan); artifact=root/name;artifact.write_bytes(b'image')
                receipt={**plan,'image':{'filename':name,'size':5,'sha256':hashlib.sha256(b'image').hexdigest()}}
                sidecar=root/(name+'.json'); sidecar.write_text(json.dumps(receipt))
                (root/(name+'.sha256')).write_text(receipt['image']['sha256']+'  '+name+'\n')
                verify.return_value=receipt
                self.assertEqual(len(module.release_files(root,root,'1.2.3','a'*40)),3)
                self.assertTrue(verify.call_args.kwargs['public'])
                receipt['flash_files']={'cubby-setup/authorized_keys':'x'};sidecar.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError): module.release_files(root,root,'1.2.3','a'*40)
                receipt['source_commit']='b'*40;sidecar.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError): module.release_files(root,root,'1.2.3','a'*40)
