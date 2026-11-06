import hashlib
import io
import zipfile
import warnings
import sys
import stat
import json
import tempfile
import unittest
import subprocess
import shutil
from unittest import mock
from rocknix import update_release
from pathlib import Path
from rocknix import updates

class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        (self.base/'releases/old/app').mkdir(parents=True)
        (self.base/'releases/new/app').mkdir(parents=True)
        (self.base/'state').mkdir()
        (self.base/'state/save').write_bytes(b'keep')
        (self.base/'current').symlink_to('releases/old')
        self.manager = updates.Manager(self.base)
    def signing(self):
        self.source=self.base/'source'
        for name,body in {'runtime/index.html':b'<html>ready</html>','rocknix/server.py':b'# server',
                          'rocknix/session.sh':b'#!/bin/sh\nexit 0','hosting/catalog.yaml':b'[]'}.items():
            p=self.source/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body)
        self.key=self.base/'private.pem'
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(self.key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        trust=self.base/'updater';trust.mkdir()
        subprocess.run(['openssl','pkey','-in',str(self.key),'-pubout','-out',str(trust/'release-key.pem')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (trust/'config.json').write_text(json.dumps({'feed':'https://updates.example/manifest.json','public_key':'release-key.pem'}))
        self.output=self.base/'signed'
        self.manifest=update_release.build(self.source,self.output,'1.0.0',1,'https://updates.example/app.zip',self.key)
        self.manager.openssl=['openssl']
        return (self.output/'manifest.json').read_bytes(),(self.output/'manifest.json.sig').read_bytes()
    def test_real_ed25519_signature_and_tampering(self):
        raw,signature=self.signing()
        self.assertEqual(self.manager.verify(raw,signature)['version'],'1.0.0')
        for body,sig in [(raw+b' ',signature),(raw,b'0'*64)]:
            with self.assertRaises(ValueError):self.manager.verify(body,sig)
        updates.atomic(self.manager.dir/'record.json',{'sequence':1})
        with self.assertRaises(ValueError):self.manager.verify(raw,signature)
    def prepare_stage(self):
        raw,signature=self.signing()
        release=self.base/'releases/old'
        (release/'device').mkdir();(release/'device/chroot-run.sh').write_text('# trusted')
        (release/'device/chroot-run.sh').chmod(0o755)
        (release/'rootfs/usr/bin').mkdir(parents=True)
        (release/'rootfs/usr/bin/cog').write_text('# runtime')
        self.responses={'https://updates.example/manifest.json':raw,'https://updates.example/manifest.json.sig':signature,
                        'https://updates.example/app.zip':(self.output/'app.zip').read_bytes()}
        def fetch(url,*a,**kw):
            if url not in self.responses:raise updates.urllib.error.HTTPError(url,404,'missing',None,None)
            return self.responses[url]
        return mock.patch.object(updates,'fetch',side_effect=fetch)
    def test_interrupted_device_copy_is_recovered_on_recreated_manager_retry(self):
        with self.prepare_stage():
            self.manager.check()
            def interrupted(source,destination,*args,**kwargs):
                Path(destination).mkdir()
                (Path(destination)/'partial').write_bytes(b'preserve')
                raise OSError('power lost during baseline copy')
            with mock.patch.object(updates.shutil,'copytree',side_effect=interrupted):
                with self.assertRaises(OSError): self.manager.stage()
            resumed=updates.Manager(self.base,openssl=['openssl'])
            resumed.stage(); resumed.apply()
            self.assertEqual((self.base/'current/device/chroot-run.sh').read_text(),'# trusted')
            self.assertEqual((self.base/'state/save').read_bytes(),b'keep')

    def test_current_real_device_tree_wins_over_different_retained_image(self):
        with self.prepare_stage():
            historical=self.base/'releases/retained-image/device'
            historical.mkdir(parents=True)
            (historical/'chroot-run.sh').write_text('# historical baseline')
            (historical/'chroot-run.sh').chmod(0o755)
            self.manager.check();self.manager.stage()
            self.assertEqual((self.base/'updater/device/chroot-run.sh').read_text(),'# trusted')
            self.manager.apply()
            self.assertEqual((self.base/'current/device/chroot-run.sh').read_text(),'# trusted')
            self.assertEqual((historical/'chroot-run.sh').read_text(),'# historical baseline')

    def test_legacy_partial_device_directory_is_preserved_and_replaced(self):
        with self.prepare_stage():
            device=self.base/'updater/device';device.mkdir()
            (device/'unknown').write_bytes(b'preserve')
            self.manager.check();self.manager.stage();self.manager.apply()
            self.assertTrue((self.base/'current/device/chroot-run.sh').is_file())
            saved=list((self.base/'updater').glob('.device-incomplete-*/unknown'))
            self.assertEqual(len(saved),1)
            self.assertEqual(saved[0].read_bytes(),b'preserve')

    def test_interruption_after_partial_directory_quarantine_is_retryable(self):
        with self.prepare_stage():
            device=self.base/'updater/device';device.mkdir()
            (device/'unknown').write_bytes(b'preserve')
            self.manager.check()
            rename=updates.os.rename
            def interrupted(source,destination):
                result=rename(source,destination)
                if Path(source)==device: raise OSError('power lost after quarantine')
                return result
            with mock.patch.object(updates.os,'rename',side_effect=interrupted):
                with self.assertRaises(OSError): self.manager.stage()
            resumed=updates.Manager(self.base,openssl=['openssl'])
            resumed.stage();resumed.apply()
            self.assertTrue((self.base/'current/device/chroot-run.sh').is_file())
            saved=list((self.base/'updater').glob('.device-incomplete-*/unknown'))
            self.assertEqual([p.read_bytes() for p in saved],[b'preserve'])

    def test_activated_legacy_partial_baseline_is_repaired_before_supervisor_launch(self):
        with self.prepare_stage():
            original=self.base/'releases/old/device'
            device=self.base/'updater/device';device.mkdir()
            (device/'unknown').write_bytes(b'preserve')
            (self.base/'releases/new/device').symlink_to('../../updater/device')
            (self.base/'current').unlink();(self.base/'current').symlink_to('releases/new')
            class StopAfterLaunch(Exception): pass
            def launch(*args,**kwargs):
                self.assertEqual((self.base/'current/device/chroot-run.sh').read_bytes(),
                                 (original/'chroot-run.sh').read_bytes())
                raise StopAfterLaunch()
            with mock.patch.object(updates,'serve'), mock.patch.object(updates.signal,'signal'), \
                 mock.patch.object(updates.subprocess,'Popen',side_effect=launch):
                with self.assertRaises(StopAfterLaunch): updates.supervisor(self.base)

    def test_baseline_mode_changes_and_missing_recovery_source_fail_closed(self):
        with self.prepare_stage():
            self.manager.check();self.manager.stage()
            script=self.base/'updater/device/chroot-run.sh';script.chmod(0o644)
            with self.assertRaises(ValueError):self.manager.apply()
            shutil.rmtree(self.base/'releases/old/device')
            with self.assertRaisesRegex(ValueError,'Cannot safely recover'):
                self.manager.ensure_baseline_device()
            self.assertTrue(script.exists())

    def test_corrupted_baseline_cannot_activate_staged_app(self):
        with self.prepare_stage():
            self.manager.check();self.manager.stage()
            (self.base/'updater/device/chroot-run.sh').unlink()
            with self.assertRaises(ValueError): self.manager.apply()
            self.assertEqual((self.base/'current').readlink().as_posix(),'releases/old')

    def test_download_stage_apply_health_and_state_preservation(self):
        with self.prepare_stage():
            self.manager.check();self.manager.stage()
        release=self.base/'releases'/self.manager.release_id(self.manifest)
        self.assertEqual((release/'app/runtime/index.html').read_bytes(),b'<html>ready</html>')
        self.assertTrue((release/'rootfs').is_symlink())
        self.assertEqual((self.base/'releases/old/rootfs').resolve(),(release/'rootfs').resolve())
        self.manager.apply()
        pending=updates.read_json(self.manager.dir/'pending.json')
        self.manager.dispatch({'action':'ready','token':pending['token']})
        self.manager.confirm(pending['token'])
        self.assertEqual((self.base/'state/save').read_bytes(),b'keep')
    def test_crash_after_journal_before_current_switch_restores_old(self):
        with mock.patch.object(updates,'link',side_effect=OSError('power lost')):
            with self.assertRaises(OSError): self.manager.activate('new',1)
        self.assertTrue((self.manager.dir/'pending.json').exists())
        updates.Manager(self.base).recover()
        self.assertEqual((self.base/'current').readlink().as_posix(),'releases/old')
    def test_incompatible_signed_manifest_and_duplicate_keys_rejected(self):
        raw,_=self.signing()
        manifests=[]
        m=json.loads(raw);m['architecture']='x86_64';manifests.append(json.dumps(m).encode())
        manifests.append(raw[:-1]+b',"schema":1}')
        for body in manifests:
            path=self.output/'modified.json';path.write_bytes(body)
            signature=self.output/'modified.sig'
            subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(self.key),'-in',str(path),'-out',str(signature)],check=True)
            with self.assertRaises(ValueError):self.manager.verify(body,signature.read_bytes())
    def test_verified_stage_survives_coordinator_restart(self):
        with self.prepare_stage():
            self.manager.check();self.manager.stage()
        resumed=updates.Manager(self.base,openssl=['openssl'])
        self.assertEqual(resumed.status()['phase'],'staged')
        resumed.apply()
        self.assertTrue((self.base/'updates/pending.json').exists())

    def test_checking_installed_release_is_up_to_date_not_replay_activation(self):
        with self.prepare_stage():
            self.manager.check();self.manager.stage();self.manager.apply()
            p=updates.read_json(self.manager.dir/'pending.json');self.manager.confirm(p['token'])
            self.assertEqual(self.manager.check()['phase'],'idle')
            with self.assertRaises(ValueError):self.manager.verify((self.output/'manifest.json').read_bytes(),(self.output/'manifest.json.sig').read_bytes())

    def test_truncated_archive_does_not_activate(self):
        with self.prepare_stage():
            self.manager.check()
            self.responses['https://updates.example/app.zip']=b'bad'
            with self.assertRaises(ValueError):self.manager.stage()
        self.assertEqual((self.base/'current').readlink().as_posix(),'releases/old')
    def test_low_storage_does_not_download(self):
        with self.prepare_stage():
            self.manager.check()
            with mock.patch.object(shutil,'disk_usage',return_value=shutil._ntuple_diskusage(10,10,0)):
                with self.assertRaises(ValueError):self.manager.stage()
        self.assertEqual((self.base/'state/save').read_bytes(),b'keep')
    def test_staged_tampering_cannot_activate(self):
        with self.prepare_stage():
            self.manager.check(); self.manager.stage()
        release=self.base/'releases'/self.manager.release_id(self.manifest)
        (release/'app/runtime/index.html').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.manager.apply()
        self.assertEqual((self.base/'current').readlink().as_posix(),'releases/old')
    def test_signed_malicious_zip_entries_are_rejected(self):
        for attack in ['duplicate','symlink','traversal']:
            with self.subTest(attack=attack):
                # Each mutation is authentically signed: signature alone must
                # not bypass archive structure/path validation.
                fixture=UpdateTests(); fixture.setUp()
                try:
                    with fixture.prepare_stage():
                        original=fixture.responses['https://updates.example/app.zip']
                        out=io.BytesIO()
                        with zipfile.ZipFile(io.BytesIO(original)) as incoming, zipfile.ZipFile(out,'w') as z:
                            for info in incoming.infolist():
                                body=incoming.read(info)
                                if attack=='symlink' and info.filename=='runtime/index.html': info.external_attr=(stat.S_IFLNK|0o644)<<16
                                z.writestr(info,body)
                            if attack=='duplicate':
                                with warnings.catch_warnings():
                                    warnings.simplefilter('ignore'); z.writestr(incoming.infolist()[0],incoming.read(incoming.infolist()[0]))
                            if attack=='traversal': z.writestr('../escape',b'bad')
                        body=out.getvalue();fixture.manifest['archive'].update(size=len(body),sha256=hashlib.sha256(body).hexdigest())
                        raw=json.dumps(fixture.manifest).encode(); manifest=fixture.output/'manifest.json';manifest.write_bytes(raw)
                        subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(fixture.key),'-in',str(manifest),'-out',str(fixture.output/'manifest.json.sig')],check=True)
                        fixture.responses.update({'https://updates.example/app.zip':body,'https://updates.example/manifest.json':raw,
                           'https://updates.example/manifest.json.sig':(fixture.output/'manifest.json.sig').read_bytes()})
                        fixture.manager.check()
                        with self.assertRaises(ValueError):fixture.manager.stage()
                        self.assertFalse((fixture.base/'escape').exists())
                finally:fixture.doCleanups()
    def test_dispatch_rejects_arbitrary_path_and_url(self):
        for request in [{'action':'apply','path':'/etc'},{'action':'check','url':'https://attacker.example'}, {'action':'shell'}]:
            with self.assertRaises(ValueError):self.manager.dispatch(request)

    def test_runtime_relocation_interruption_is_recoverable(self):
        with self.prepare_stage():
            current=self.base/'releases/old'
            shared=self.base/'runtimes'/updates.RUNTIME;shared.parent.mkdir()
            (current/'rootfs').rename(shared)
            self.manager.layout()
            self.assertEqual((current/'rootfs').resolve(),shared)

    def test_supervisor_repairs_interrupted_runtime_migration_before_launch(self):
        with self.prepare_stage():
            current=self.base/'releases/old'
            shared=self.base/'runtimes'/updates.RUNTIME
            rename=updates.os.rename
            def interrupted(source,destination):
                rename(source,destination)
                raise OSError('power lost after rename')
            with mock.patch.object(updates.os,'rename',side_effect=interrupted):
                with self.assertRaises(OSError): self.manager.layout()
            self.assertFalse((current/'rootfs').exists())
            self.assertFalse((self.manager.dir/'pending.json').exists())
            class StopAfterLaunch(Exception): pass
            def launch(*args,**kwargs):
                self.assertEqual((current/'rootfs').resolve(strict=True),shared)
                self.assertEqual((current/'rootfs/usr/bin/cog').read_text(),'# runtime')
                raise StopAfterLaunch()
            # Exercise the real supervisor entry point and its newly-created
            # Manager, stopping only after startup recovery reaches launch.
            for _ in range(2):
                with mock.patch.object(updates,'serve'), mock.patch.object(updates.signal,'signal'), \
                     mock.patch.object(updates.subprocess,'Popen',side_effect=launch):
                    with self.assertRaises(StopAfterLaunch): updates.supervisor(self.base)
            self.assertEqual((self.base/'state/save').read_bytes(),b'keep')

    def test_supervisor_does_not_migrate_untouched_runtime(self):
        with self.prepare_stage():
            current=self.base/'releases/old'
            class StopAfterLaunch(Exception): pass
            def launch(*args,**kwargs):
                self.assertTrue((current/'rootfs').is_dir())
                self.assertFalse((current/'rootfs').is_symlink())
                self.assertFalse((self.base/'runtimes').exists())
                raise StopAfterLaunch()
            with mock.patch.object(updates,'serve'), mock.patch.object(updates.signal,'signal'), \
                 mock.patch.object(updates.subprocess,'Popen',side_effect=launch):
                with self.assertRaises(StopAfterLaunch): updates.supervisor(self.base)

    def test_unconfigured_fails_closed(self):
        self.assertEqual(self.manager.status()['phase'], 'unconfigured')
        with self.assertRaises(ValueError): self.manager.check()
        self.assertEqual((self.base/'current').readlink().as_posix(), 'releases/old')
    def test_durable_trial_reboot_rolls_back(self):
        self.manager.activate('new', 1)
        self.assertEqual((self.base/'current').readlink().as_posix(), 'releases/new')
        updates.Manager(self.base).recover()
        self.assertEqual((self.base/'current').readlink().as_posix(), 'releases/old')
        self.assertEqual((self.base/'state/save').read_bytes(), b'keep')
        self.assertIn('new', self.manager.read_record().get('rejected', []))
    def test_stale_health_does_not_commit(self):
        token = self.manager.activate('new', 1)
        with self.assertRaises(ValueError): self.manager.confirm('stale')
        self.manager.confirm(token)
        self.assertEqual((self.base/'previous').readlink().as_posix(), 'releases/old')
        self.assertFalse((self.base/'updates/pending.json').exists())
        self.assertEqual(self.manager.read_record()['sequence'], 1)
    def run_trial(self,ready,alive,lifetime=.15):
        token=self.manager.activate('new',1)
        if ready:self.manager.dispatch({'action':'ready','token':token})
        p=subprocess.Popen([sys.executable,'-c',f'import time; time.sleep({lifetime})'])
        self.addCleanup(lambda: p.poll() is None and (p.terminate(),p.wait()))
        result=updates.watch_trial(self.manager,p,timeout=.08,stable=.025,health=lambda:alive,interval=.005)
        return result
    def test_http_health_without_browser_ready_times_out(self):
        self.assertEqual(self.run_trial(False,True),'timeout')
        self.assertTrue((self.manager.dir/'pending.json').exists())
        self.manager.recover()
        self.assertEqual((self.base/'current').readlink().as_posix(),'releases/old')
    def test_browser_ready_without_live_server_times_out(self):
        self.assertEqual(self.run_trial(True,False),'timeout')
        self.assertTrue((self.manager.dir/'pending.json').exists())
    def test_both_health_signals_commit_then_process_exits(self):
        self.assertEqual(self.run_trial(True,True),'exit')
        self.assertFalse((self.manager.dir/'pending.json').exists())
        self.assertEqual(self.manager.read_record()['sequence'],1)

    def test_archive_paths_and_types(self):
        for name in ['../bad','/bad','runtime/../bad','rocknix/device/launch.sh','hosting/secret']:
            with self.subTest(name=name), self.assertRaises(ValueError): updates.app_path(name)
        self.assertEqual(updates.app_path('runtime/index.html'), 'runtime/index.html')
    def test_reject_bad_manifest(self):
        for value in [{}, {'schema': True}]:
            with self.assertRaises(ValueError): updates.validate_manifest(value)

if __name__ == '__main__': unittest.main()

class UpdateHTTPTests(unittest.TestCase):
    def setUp(self):
        import threading
        from rocknix.server import State,make_server
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.state=State(Path(__file__).resolve().parents[1],self.tmp.name)
        class Adapter:
            def __init__(self):self.calls=[]
            def dispatch(self,body):self.calls.append(body);return {'phase':'staged','configured':True}
        self.adapter=Adapter();self.state.updater=self.adapter
        self.http=make_server(self.state,0)
        threading.Thread(target=self.http.serve_forever,daemon=True).start()
        self.addCleanup(self.http.server_close);self.addCleanup(self.http.shutdown)
        self.origin='http://127.0.0.1:'+str(self.http.server_address[1])
    def request(self,body,**changes):
        import http.client
        c=http.client.HTTPConnection('127.0.0.1',self.http.server_address[1])
        headers={'Host':self.origin.removeprefix('http://'),'Origin':self.origin,
                 'Referer':self.origin+'/adult/updates','X-Cubby-Session':self.state.adult_token,'Content-Type':'application/json'}
        headers.update(changes)
        c.request('POST','/api/update',json.dumps(body),headers)
        r=c.getresponse();status=r.status;r.read();c.close();return status
    def test_apply_excludes_game_and_package_operations(self):
        for field in ['active_game','busy','network_busy']:
            setattr(self.state,field,True)
            self.assertEqual(self.request({'action':'apply'}),409)
            setattr(self.state,field,None if field=='active_game' else False)
        self.assertEqual(self.adapter.calls,[])
        self.assertEqual(self.request({'action':'apply'}),200)
        self.assertTrue(self.state.busy)
    def test_ambiguous_apply_timeout_keeps_gameplay_blocked(self):
        def timeout(body):raise TimeoutError('reply lost after activation')
        self.adapter.dispatch=timeout
        self.assertEqual(self.request({'action':'apply'}),400)
        self.assertTrue(self.state.busy)
    def test_explicit_apply_rejection_releases_gameplay_lock(self):
        def reject(body):raise updates.Rejected('No staged update')
        self.adapter.dispatch=reject
        self.assertEqual(self.request({'action':'apply'}),400)
        self.assertFalse(self.state.busy)
    def test_cross_origin_and_game_frame_cannot_update(self):
        self.assertEqual(self.request({'action':'apply'},Origin='https://attacker.example'),403)
        self.assertEqual(self.request({'action':'apply'},Referer=self.origin+'/games/game/index.html'),403)
        self.assertEqual(self.request({'action':'check','url':'https://attacker.example'}),400)
        self.assertEqual(self.adapter.calls,[])

class HostClientReplyTests(unittest.TestCase):
    def reply(self, body):
        import socket
        import threading
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'socket'
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(path));listener.listen(1);listener.settimeout(3)
                def serve():
                    connection,_=listener.accept()
                    with connection:
                        connection.recv(2048)
                        connection.sendall(json.dumps(body).encode()+b'\n')
                thread=threading.Thread(target=serve);thread.start()
                try:return updates.HostClient(path).dispatch({'action':'status'})
                finally:thread.join(timeout=3)
    def test_successful_status_with_null_error_is_not_rejected(self):
        self.assertEqual(self.reply({'phase':'idle','error':None}),{'phase':'idle','error':None})
    def test_explicit_error_remains_rejected(self):
        with self.assertRaises(updates.Rejected):self.reply({'error':'Unavailable'})

class ActualReleaseAssetTests(unittest.TestCase):
    def test_server_required_gamepad_asset_is_in_signed_actual_checkout_archive(self):
        source=Path(__file__).resolve().parents[1]
        self.assertIn('/rocknix/gamepad.js',(source/'rocknix/server.py').read_text())
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary);key=base/'key.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(key)],
                           check=True,capture_output=True)
            output=base/'release'
            manifest=update_release.build(source,output,'0.1.1',3,
                                           'https://example.com/app.zip',key)
            name='rocknix/gamepad.js'
            self.assertIn(name,manifest['files'])
            expected=(source/name).read_bytes()
            self.assertEqual(manifest['files'][name]['sha256'],hashlib.sha256(expected).hexdigest())
            with zipfile.ZipFile(output/'app.zip') as archive:
                self.assertEqual(archive.read(name),expected)
            public=base/'public.pem'
            subprocess.run(['openssl','pkey','-in',str(key),'-pubout','-out',str(public)],
                           check=True,capture_output=True)
            subprocess.run(['openssl','pkeyutl','-verify','-pubin','-rawin','-inkey',str(public),
                            '-in',str(output/'manifest.json'),'-sigfile',str(output/'manifest.json.sig')],
                           check=True,capture_output=True)
