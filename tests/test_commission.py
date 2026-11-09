import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rocknix import commission
from rocknix.device import commissioning as native


class CommissionTests(unittest.TestCase):
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
        remote=type('Remote', (), {'call':lambda *a: {'boot_id':'old','checks':{}}})()
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
        remote.call=Mock(side_effect=[commission.Blocked('offline'),{'boot_id':'new','checks':{}}])
        with patch('time.sleep'):
            self.assertEqual(commission.wait_reboot(remote,{},'old',timeout=1)['boot_id'],'new')

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
            snapshot=dict(boot_id='new',checks=checks,profile_ids=[uid])
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
