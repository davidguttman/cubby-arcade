import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from rocknix import commission
from rocknix.device import commissioning as native


class CommissionTests(unittest.TestCase):
    expected = dict(version='0.35.0', commit='a'*40, cid='c'*32)

    def identity(self):
        return dict(self.expected, bound_cid=self.expected['cid'],
                    flash='/dev/mmcblk0p1', storage='/dev/mmcblk0p2')

    def test_pending_gates_never_certify_ready(self):
        report = commission.receipt({'binding': {'version': '0.35.0', 'commit': 'a'*40,
            'image_sha256': 'b'*64}, 'storage': {'cid': 'c'*32}},
            {'boot_id': 'one', 'checks': {'hardware_presence': True}}, {'clean': True})
        self.assertFalse(report['customer_ready'])
        self.assertIn('signed_update_rollback', report['pending'])

    def test_wrong_target_before_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = native.Device(root, fixture=True)
            target.expected = {'version': '0.35.0', 'commit': 'a'*40, 'cid': 'c'*32}
            with patch.object(target, 'identity', return_value={'version': 'old'}), \
                 patch.object(target, 'stop') as stop:
                with self.assertRaises(ValueError): target.handoff([])
                stop.assert_not_called()

    def test_clean_handoff_preserves_machine_keys_and_unrelated_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = native.Device(root, fixture=True)
            state = root/'storage/cubby/state'; state.mkdir(parents=True)
            (state/'game').mkdir(); (state/'game/save').write_text('test')
            key = root/'storage/cubby/recovery/private/key'; key.parent.mkdir(parents=True)
            key.write_text('preserve')
            profiles = target.profiles; profiles.mkdir(parents=True)
            uid = '12345678-1234-1234-1234-123456789abc'
            (profiles/f'cubby-{uid}.nmconnection').write_text('[connection]\nuuid='+uid+'\n')
            (profiles/'unrelated.nmconnection').write_text('preserve')
            with patch.object(target, 'validate'), patch.object(target, 'stop'), \
                 patch.object(target, 'start'), patch.object(target, 'command', return_value=''):
                result = target.handoff([uid])
            self.assertTrue(result['clean'])
            self.assertEqual(list(state.iterdir()), [])
            self.assertTrue(key.exists()); self.assertTrue((profiles/'unrelated.nmconnection').exists())
            self.assertFalse((profiles/f'cubby-{uid}.nmconnection').exists())

    def test_symlink_blocks_before_stop_or_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); target = native.Device(root, fixture=True)
            state = root/'storage/cubby/state'; state.mkdir(parents=True)
            outside = root/'outside'; outside.write_text('safe')
            (state/'escape').symlink_to(outside)
            with patch.object(target, 'validate'), patch.object(target, 'stop') as stop:
                with self.assertRaises(ValueError): target.handoff([])
                stop.assert_not_called()
            self.assertEqual(outside.read_text(), 'safe')

    def test_unknown_cubby_profile_blocks_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            target = native.Device(Path(directory), fixture=True)
            (target.root/'storage/cubby/state').mkdir(parents=True)
            target.profiles.mkdir(parents=True)
            (target.profiles/'cubby-unknown.nmconnection').write_text('unknown')
            with patch.object(target, 'validate'), patch.object(target, 'stop') as stop:
                with self.assertRaises(ValueError): target.handoff([])
                stop.assert_not_called()

    def test_credentials_not_in_ssh_command(self):
        args = type('Args', (), {'identity':Path('/private/client'), 'job':Path('/private/job'),
                               'host':'169.254.170.2'})()
        ssh = commission.Remote(args)
        with patch('subprocess.run') as run:
            run.return_value.returncode=0; run.return_value.stdout=b'{}'
            ssh.call('bench', {'password':'SecretNoLog', 'ssid':'private'}, {'cid':'a'*32})
            call = run.call_args
            self.assertNotIn('SecretNoLog', str(call.args))
            self.assertIn(b'SecretNoLog', call.kwargs['input'])
            self.assertIn('StrictHostKeyChecking=yes', call.args[0])

    def test_remote_error_sanitized(self):
        args=type('Args', (), {'identity':Path('/key'), 'job':Path('/job'), 'host':'169.254.170.2'})()
        with patch('subprocess.run') as run:
            run.return_value.returncode=1; run.return_value.stderr=b'private password'
            with self.assertRaisesRegex(commission.Blocked, '^commissioning_transport_failed$'):
                commission.Remote(args).call('snapshot', {}, {})

    def test_resume_requires_new_boot(self):
        remote=type('Remote', (), {'call':lambda *a,**kw: {'boot_id':'old','checks':{}}})()
        with self.assertRaisesRegex(commission.Blocked, 'reboot_not_observed'):
            commission.wait_reboot(remote, {}, 'old', timeout=0)

    def test_profile_ancestor_symlink_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); target=native.Device(root,fixture=True)
            (root/'storage').mkdir(); outside=root/'elsewhere'; outside.mkdir()
            (root/'storage/.config').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError): target.profile_ids()

    def test_native_target_requires_binding_and_internal_mounts(self):
        target=native.Device(Path('/fixture'),fixture=True)
        target.expected=dict(version='0.35.0',commit='a'*40,cid='c'*32)
        good=dict(target.expected,bound_cid='c'*32,flash='/dev/mmcblk0p1',storage='/dev/mmcblk0p2')
        with patch.object(target,'identity',return_value=good): self.assertEqual(target.validate(),good)
        for changed in ({'cid':'d'*32},{'bound_cid':None},{'storage':'/dev/mmcblk1p2'}, {'commit':'b'*40}):
            with self.subTest(changed=changed), patch.object(target,'identity',return_value=dict(good,**changed)):
                with self.assertRaises(ValueError): target.validate()

    def test_reboot_wait_uses_authenticated_new_boot(self):
        remote=type('Remote', (), {})()
        from unittest.mock import Mock
        remote.call=Mock(side_effect=[commission.Blocked('commissioning_transport_failed'),self.healthy_snapshot()])
        with patch('time.sleep'):
            self.assertEqual(commission.wait_reboot(remote,self.expected,'old',timeout=1)['boot_id'],'new')

    def healthy_snapshot(self, boot='new', **changes):
        checks={key:True for key in ['no_failed_units','artwork','boot_progress','management','updater',
                                    'controller_presence','audio_presence','power_presence']}
        checks.update(changes)
        return dict(identity=self.identity(), boot_id=boot, checks=checks, profile_ids=[])

    def test_new_boot_waits_for_managed_services_without_repeating_reboot(self):
        from unittest.mock import Mock
        remote=Mock()
        remote.call.side_effect=[self.healthy_snapshot(management=False),self.healthy_snapshot()]
        with patch('time.sleep'):
            result=commission.wait_reboot(remote,self.expected,'old',timeout=1)
        self.assertTrue(result['checks']['management'])
        self.assertEqual([call.args[0] for call in remote.call.call_args_list],['snapshot','snapshot'])

    def test_initial_readiness_waits_for_services(self):
        from unittest.mock import Mock
        remote=Mock()
        remote.call.side_effect=[self.healthy_snapshot(updater=False),self.healthy_snapshot()]
        with patch('time.sleep'):
            result=commission.wait_ready(remote,self.expected,timeout=1)
        self.assertTrue(result['checks']['updater'])

    def native_readiness_fixture(self, root):
        target=native.Device(root,fixture=True)
        target.expected=dict(version='0.35.0',commit='a'*40,cid='c'*32)
        files={'storage/cubby/current/image.json':json.dumps(dict(version='0.35.0',source_commit='a'*40)),
               'storage/cubby/image-provenance/device.json':json.dumps(dict(device_cid='c'*32)),
               'sys/block/mmcblk0/device/cid':'c'*32,
               'proc/mounts':'/dev/mmcblk0p1 /flash vfat rw 0 0\n/dev/mmcblk0p2 /storage ext4 rw 0 0\n',
               'proc/sys/kernel/random/boot_id':'new',
               'run/cubby-splash.status':'rendered 640x480 success',
               'sys/class/input/event0/device/name':'gamepad', 'dev/snd/pcm0':'',
               'sys/class/power_supply/battery/type':'Battery'}
        for name,text in files.items():
            path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(text)
        return target

    def test_native_missing_service_and_marker_wait_then_ready(self):
        """Exercise native main -> SSH response parser -> host readiness loop."""
        import contextlib
        import io
        from types import SimpleNamespace
        from unittest.mock import Mock
        for missing in ('updater','updater_refused','updater_timeout','splash','progress','systemctl','controller'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                target=self.native_readiness_fixture(Path(directory))
                splash=target.path('/run/cubby-splash.status')
                controller=target.path('/sys/class/input/event0/device/name')
                if missing=='splash': splash.unlink()
                if missing=='controller': controller.unlink()
                client=Mock(); client.__enter__=Mock(return_value=client); client.__exit__=Mock(return_value=False)
                client.connect_ex.return_value=0
                client.makefile.return_value=io.StringIO(json.dumps(dict(installed='0.35.0',configured=True,phase='idle'))+'\n')
                attempts=[]
                def execute(command, **kwargs):
                    attempts.append(1)
                    if len(attempts)>1:
                        splash.write_text('rendered 640x480 success'); controller.write_text('gamepad')
                        client.makefile.return_value=io.StringIO(json.dumps(dict(installed='0.35.0',configured=True,phase='idle'))+'\n')
                    unavailable={'updater':FileNotFoundError(), 'updater_refused':ConnectionRefusedError(),
                                 'updater_timeout':TimeoutError()}
                    client.connect.side_effect=unavailable.get(missing) if len(attempts)==1 else None
                    def systemctl(*args):
                        if missing=='systemctl' and len(attempts)==1: raise FileNotFoundError()
                        if args[1]=='show':
                            if missing=='progress' and len(attempts)==1:
                                raise subprocess.CalledProcessError(1,args)
                            return 'success'
                        return ''
                    output=io.StringIO(); code=0
                    with patch.object(native,'Device',return_value=target), patch.object(target,'command',side_effect=systemctl), \
                         patch.object(native.socket,'socket',return_value=client), patch('sys.stdin',io.StringIO(kwargs['input'].decode())), \
                         contextlib.redirect_stdout(output):
                        try: native.main()
                        except SystemExit as error: code=error.code
                    return SimpleNamespace(returncode=code,stdout=output.getvalue().encode(),stderr=b'')
                args=SimpleNamespace(identity=Path('/key'),job=Path('/job'),host='169.254.170.2')
                with patch('subprocess.run',side_effect=execute), patch('time.sleep'):
                    result=commission.wait_ready(commission.Remote(args),target.expected,timeout=1)
                self.assertTrue(all(result['checks'].values()))
                self.assertEqual(len(attempts),2)

    def test_native_snapshot_probe_validation_errors_still_terminal(self):
        import contextlib
        import io
        from types import SimpleNamespace
        for error in (PermissionError(),ValueError('malformed_service_status')):
            with self.subTest(error=type(error)), tempfile.TemporaryDirectory() as directory:
                target=self.native_readiness_fixture(Path(directory))
                def execute(command, **kwargs):
                    output=io.StringIO(); code=0
                    with patch.object(native,'Device',return_value=target), patch.object(target,'rpc',side_effect=error), \
                         patch('sys.stdin',io.StringIO(kwargs['input'].decode())), contextlib.redirect_stdout(output):
                        try: native.main()
                        except SystemExit as failure: code=failure.code
                    return SimpleNamespace(returncode=code,stdout=output.getvalue().encode(),stderr=b'')
                args=SimpleNamespace(identity=Path('/key'),job=Path('/job'),host='169.254.170.2')
                with patch('subprocess.run',side_effect=execute) as run:
                    with self.assertRaisesRegex(commission.Blocked,'^commissioning_native_failed$'):
                        commission.wait_ready(commission.Remote(args),target.expected,timeout=1)
                    self.assertEqual(run.call_count,1)

    def test_native_invalid_identity_remains_terminal_before_service_probe(self):
        import contextlib
        import io
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            target=self.native_readiness_fixture(Path(directory))
            target.path('/storage/cubby/current/image.json').write_text('{malformed')
            def execute(command, **kwargs):
                output=io.StringIO(); code=0
                with patch.object(native,'Device',return_value=target), patch.object(target,'rpc') as rpc, \
                     patch('sys.stdin',io.StringIO(kwargs['input'].decode())), contextlib.redirect_stdout(output):
                    try: native.main()
                    except SystemExit as error: code=error.code
                    rpc.assert_not_called()
                return SimpleNamespace(returncode=code,stdout=output.getvalue().encode(),stderr=b'')
            args=SimpleNamespace(identity=Path('/key'),job=Path('/job'),host='169.254.170.2')
            with patch('subprocess.run',side_effect=execute) as run:
                with self.assertRaisesRegex(commission.Blocked,'^commissioning_native_failed$'):
                    commission.wait_ready(commission.Remote(args),target.expected,timeout=1)
                self.assertEqual(run.call_count,1)

    def test_new_boot_permanent_failed_check_has_bounded_readiness_error(self):
        from unittest.mock import Mock
        remote=Mock(); remote.call.return_value=self.healthy_snapshot(management=False)
        with patch('time.monotonic',side_effect=[0,0,0,1,1,2]), patch('time.sleep'):
            with self.assertRaisesRegex(commission.Blocked,'^commissioning_readiness_timeout$'):
                commission.wait_reboot(remote,self.expected,'old',timeout=1)
        self.assertEqual(remote.call.call_count,1)

    def test_readiness_does_not_retry_native_or_authentication_failure(self):
        from unittest.mock import Mock
        for reason in ['commissioning_native_failed','commissioning_authentication_failed']:
            remote=Mock(); remote.call.side_effect=commission.Blocked(reason)
            with self.subTest(reason=reason), self.assertRaisesRegex(commission.Blocked,'^'+reason+'$'):
                commission.wait_reboot(remote,self.expected,'old',timeout=1)
            self.assertEqual(remote.call.call_count,1)

    def test_ssh_authentication_failure_is_terminal_and_sanitized(self):
        args=type('Args', (), {'identity':Path('/key'), 'job':Path('/job'), 'host':'169.254.170.2'})()
        with patch('subprocess.run') as run:
            run.return_value.returncode=255
            run.return_value.stdout=b''
            run.return_value.stderr=b'Host key verification failed. Private hostname'
            with self.assertRaisesRegex(commission.Blocked,'^commissioning_authentication_failed$'):
                commission.Remote(args).call('snapshot',{}, {})

    def test_native_wrong_target_failure_is_not_retried(self):
        args=type('Args', (), {'identity':Path('/key'), 'job':Path('/job'), 'host':'169.254.170.2'})()
        with patch('subprocess.run') as run:
            run.return_value.returncode=1
            run.return_value.stdout=b'{"error":"native_commissioning_failed"}'
            run.return_value.stderr=b''
            with self.assertRaisesRegex(commission.Blocked,'^commissioning_native_failed$'):
                commission.wait_ready(commission.Remote(args),self.expected,timeout=1)
            self.assertEqual(run.call_count,1)

    def test_malformed_checks_are_terminal_not_readiness(self):
        from unittest.mock import Mock
        remote=Mock(); remote.call.return_value=dict(self.healthy_snapshot(), checks={})
        with self.assertRaisesRegex(commission.Blocked,'^commissioning_automated_gate_failed$'):
            commission.wait_ready(remote,self.expected,timeout=1)
        self.assertEqual(remote.call.call_count,1)

    def test_successful_ssh_malformed_json_is_terminal_without_retry(self):
        args=type('Args', (), {'identity':Path('/key'), 'job':Path('/job'), 'host':'169.254.170.2'})()
        for payload in (b'not-json', b'', b'\xff'):
            with self.subTest(payload=payload), patch('subprocess.run') as run, patch('time.sleep'):
                run.side_effect=[subprocess.CompletedProcess([],0,payload,b''),
                                 subprocess.CompletedProcess([],0,json.dumps(self.healthy_snapshot()).encode(),b'')]
                with self.assertRaisesRegex(commission.Blocked,'^commissioning_native_failed$'):
                    commission.wait_ready(commission.Remote(args),self.expected,timeout=1)
                self.assertEqual(run.call_count,1)

    def test_successful_snapshot_shape_is_terminal_before_readiness_branching(self):
        import copy
        from types import SimpleNamespace
        args=SimpleNamespace(identity=Path('/key'),job=Path('/job'),host='169.254.170.2')
        good=self.healthy_snapshot()
        malformed=[{}, None, [], {'boot_id':'old'}, dict(good,identity=None),
                   dict(good,boot_id='old',checks={}), dict(good,boot_id='old',identity={}),
                   dict(good,boot_id='old',profile_ids=None)]
        for key in good:
            row=copy.deepcopy(good); del row[key]; malformed.append(row)
        for boot in ('', ' ', 'new\n', None, 3, [], {}):
            malformed.append(dict(good,boot_id=boot))
        for key in good['identity']:
            identity=dict(good['identity']); del identity[key]
            malformed.append(dict(good,identity=identity))
            malformed.append(dict(good,identity=dict(good['identity'],**{key:'wrong'})))
        for checks in (None, [], {}, dict(good['checks'],updater=1), dict(good['checks'],unknown=True)):
            malformed.append(dict(good,checks=checks))
        for profiles in (None, {}, 'uuid', ['not-a-uuid'], [1],
                         ['12345678-1234-1234-1234-123456789abc']*2):
            malformed.append(dict(good,profile_ids=profiles))
        for row in malformed:
            for old_boot in (None,'old'):
                with self.subTest(row=row,old_boot=old_boot), patch('subprocess.run') as run, patch('time.sleep'):
                    run.side_effect=[subprocess.CompletedProcess([],0,json.dumps(row).encode(),b''),
                                     subprocess.CompletedProcess([],0,json.dumps(good).encode(),b'')]
                    with self.assertRaises(commission.Blocked):
                        commission.wait_ready(commission.Remote(args),self.expected,old_boot=old_boot,timeout=.01)
                    self.assertEqual(run.call_count,1)

    def test_valid_same_boot_then_new_boot_uses_actual_remote_parser(self):
        from types import SimpleNamespace
        args=SimpleNamespace(identity=Path('/key'),job=Path('/job'),host='169.254.170.2')
        rows=[self.healthy_snapshot('old'),self.healthy_snapshot('new',updater=False),self.healthy_snapshot('new')]
        with patch('subprocess.run') as run, patch('time.sleep'):
            run.side_effect=[subprocess.CompletedProcess([],0,json.dumps(row).encode(),b'') for row in rows]
            result=commission.wait_reboot(commission.Remote(args),self.expected,'old',timeout=1)
        self.assertEqual(result,rows[-1]); self.assertEqual(run.call_count,3)

    def test_required_checks_fail_closed(self):
        with self.assertRaises(commission.Blocked): commission.checked_snapshot({'checks':{}})
        checks={key:True for key in ['no_failed_units','artwork','boot_progress','management','updater',
                                    'controller_presence','audio_presence','power_presence']}
        commission.checked_snapshot({'checks':checks})
        checks['updater']=False
        with self.assertRaises(commission.Blocked): commission.checked_snapshot({'checks':checks})

    def test_bench_uses_socket_and_records_uuid_only(self):
        target=native.Device(Path('/fixture'),fixture=True)
        uid='12345678-1234-1234-1234-123456789abc'
        from unittest.mock import Mock
        target.rpc=Mock(side_effect=[{'networks':[dict(ssid='bench',supported=True,signal=90,bssid='00:11:22:33:44:55')]},
                                     {'internet':True}])
        with patch.object(target,'validate'), patch.object(target,'profile_ids',side_effect=[[],[uid]]), \
             patch.object(target,'command',return_value='1'):
            result=target.bench(dict(ssid='bench',password='superprivate',baseline=[]))
        self.assertEqual(result['profile_ids'],[uid])
        self.assertNotIn('superprivate',str(result))
        self.assertEqual(target.rpc.call_args.args[1]['action'],'connect')

    def test_bench_refuses_changed_baseline_before_connect(self):
        target=native.Device(Path('/fixture'),fixture=True)
        with patch.object(target,'validate'), patch.object(target,'profile_ids',return_value=['other']), \
             patch.object(target,'rpc') as rpc:
            with self.assertRaises(ValueError): target.bench({'baseline':[]})
            rpc.assert_not_called()

    def test_host_resume_reboot_checkpoint_and_receipt(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            job=Path(directory); job.chmod(0o700)
            binding=dict(version='0.35.0',commit='a'*40,image_sha256='b'*64)
            uid='12345678-1234-1234-1234-123456789abc'
            data=dict(binding=binding,storage={'cid':'c'*32},stage='commissioning_pending',
                      commissioning=dict(phase='reboot_pending',boot_before='old',bench={'profile_ids':[uid]}))
            for name,text in [('state.json',json.dumps(data)),('known_hosts','pinned'),('identity','private')]:
                (job/name).write_text(text); (job/name).chmod(0o600)
            checks={key:True for key in ['no_failed_units','artwork','boot_progress','management','updater',
                                        'controller_presence','audio_presence','power_presence']}
            snapshot=dict(identity=self.identity(),boot_id='new',checks=checks,profile_ids=[uid])
            remote=Mock(); remote.call.side_effect=[snapshot,snapshot,dict(internet=True,wifi_enabled=True,profile_ids=[uid])]
            args=SimpleNamespace(job=job,identity=job/'identity',host='169.254.170.2',action='check')
            with patch.object(commission,'Remote',return_value=remote): report=commission.run(args)
            state=json.loads((job/'state.json').read_text())
            self.assertTrue(state['commissioning']['wifi_reboot'])
            self.assertEqual(state['commissioning']['boot_after'],'new')
            self.assertFalse(report['customer_ready'])
            self.assertEqual(report['binding']['image_sha256'],'b'*64)

    def test_pending_trial_blocks_cleanup_before_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); target=native.Device(root,fixture=True)
            pending=root/'storage/cubby/updates/pending.json'
            pending.parent.mkdir(parents=True); pending.write_text('{}')
            with patch.object(target,'validate'), patch.object(target,'stop') as stop:
                with self.assertRaisesRegex(ValueError,'update_trial'): target.handoff([])
                stop.assert_not_called()
