"""Host-only stock installer tests. No device commands are executed."""
import gzip
import hashlib
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rocknix import provision as p


FACTS = dict(cid='a'*32, name='BJTD4R', sectors=61071360, removable=0,
             battery=80, charging=True, mounted=False, sd=False)
GEOMETRY = {'mmcblk0p1': (32768, 4194304), 'mmcblk0p2': (4227072, 12582912)}
PARTITIONS = b'mmcblk0p1=32768:4194304\nmmcblk0p2=4227072:12582912\n'

class StockProvisionTests(unittest.TestCase):
    def test_discovery_refuses_ambiguity_and_unauthorized(self):
        for output in ['List of devices attached\na device\nb device\n',
                       'List of devices attached\na unauthorized\n',
                       'List of devices attached\na offline\n']:
            with self.assertRaises(p.Blocked): p.select_device(output)
        self.assertEqual(p.select_device('List of devices attached\na device product:foo\n'), 'a')

    def test_profile_is_explicit_and_shared_android_name_is_not_model_proof(self):
        facts = dict(FACTS, android='11', product='RG353P', platform='rk3566')
        p.validate_stock(facts, 'rg353v-android11')
        for key, value in [('android','10'),('product','UNKNOWN'),('platform','rk3326')]:
            with self.subTest(key=key), self.assertRaises(p.Blocked):
                p.validate_stock(dict(facts, **{key:value}), 'rg353v-android11')
        with self.assertRaises(p.Blocked): p.validate_stock(facts, 'auto')

    def test_recovery_storage_and_battery_fail_closed(self):
        p.validate_storage(FACTS, 1024)
        for changes in ({'mounted':True}, {'sd':True}, {'removable':1},
                        {'name':'SD'}, {'sectors':10}, {'battery':12}, {'cid':'bad'}):
            with self.subTest(changes=changes), self.assertRaises(p.Blocked):
                p.validate_storage(dict(FACTS, **changes), 1024)

    def test_identity_ignores_battery_but_never_storage_changes(self):
        self.assertEqual(p.identity(FACTS),p.identity(dict(FACTS,battery=75)))
        with self.assertRaises(p.Blocked): p.same_storage(FACTS, dict(FACTS,cid='b'*32))

    def test_complete_raw_hash_includes_non_mib_tail(self):
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'test.gz'; raw=b'x'*(1024*1024)+b't'*512*33
            with gzip.open(image,'wb') as f:f.write(raw)
            size,digest=p.raw_digest(image)
            self.assertEqual(size,len(raw));self.assertEqual(digest,hashlib.sha256(raw).hexdigest())
            with gzip.open(image,'wb') as f:f.write(raw[:-1])
            with self.assertRaises(p.Blocked):p.raw_digest(image)

    def test_checkpoints_are_bound_and_atomic(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'job'; binding={'serial':'a','image_sha256':'b'}
            with p.Journal(path,binding) as j:j.save('written')
            with p.Journal(path,binding) as j:self.assertEqual(j.state['stage'],'written')
            with self.assertRaises(p.Blocked):
                with p.Journal(path,dict(binding,serial='other')):pass
            self.assertEqual(json.loads((path/'state.json').read_text())['stage'],'written')

    def test_adb_shell_is_always_serial_bound_and_errors_sanitized(self):
        adb=p.Adb('adb','test123')
        with patch.object(p.subprocess,'run') as run, patch.object(adb,'require_shell_v2'):
            run.return_value.returncode=0;run.return_value.stdout=b'ok'
            self.assertEqual(adb.command('shell','id'), b'ok')
            self.assertEqual(run.call_args.args[0][:3],['adb','-s','test123'])
            run.return_value.returncode=1;run.return_value.stderr=b'secret'
            with self.assertRaises(p.Blocked) as error:adb.command('shell','id')
            self.assertNotIn('secret',str(error.exception))

    def test_write_failure_never_reboots_and_resume_rechecks(self):
        transport=FakeAdb();transport.fail_write=True
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'image.gz';image.write_bytes(b'compressed')
            with p.Journal(Path(d)/'job',{'serial':'a'}) as journal:
                journal.save('written',storage=p.identity(FACTS))
                with self.assertRaises(p.Blocked):p.write_verified(transport,image,512,'a'*64,FACTS,journal)
                self.assertEqual(journal.state['stage'],'writing')
                self.assertNotIn('reboot',transport.events)
                self.assertEqual(transport.events[0],'facts')

    def test_readback_mismatch_never_reboots(self):
        transport=FakeAdb()
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'image.gz';image.write_bytes(b'compressed')
            with p.Journal(Path(d)/'job',{'serial':'a'}) as journal:
                with self.assertRaises(p.Blocked):p.write_verified(transport,image,512,'a'*64,FACTS,journal)
                self.assertEqual(journal.state['stage'],'written')
                self.assertNotIn('reboot',transport.events)

    def test_changed_storage_is_rejected_before_write(self):
        transport=FakeAdb();transport.facts_value=dict(FACTS,cid='b'*32)
        with tempfile.TemporaryDirectory() as d:
            with p.Journal(Path(d)/'job',{'serial':'a'}) as journal:
                with self.assertRaises(p.Blocked):p.write_verified(transport,Path(d)/'x',512,'a'*64,FACTS,journal)
                self.assertNotIn('write',transport.events)

    def test_successful_readback_records_all_bytes(self):
        transport=FakeAdb();transport.digest='a'*64
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'image.gz';image.write_bytes(b'compressed')
            with p.Journal(Path(d)/'job',{'serial':'a'}) as journal:
                p.write_verified(transport,image,512*33,'a'*64,FACTS,journal)
                self.assertEqual(journal.state['stage'],'verified')
                self.assertEqual(journal.state['raw_size'],512*33)
                self.assertEqual(transport.read_size,512*33)

    def test_live_check_rejects_sd_boot_and_wrong_release(self):
        data={'version':'0.35.0','source_commit':'a'*40,'cid':FACTS['cid'],'device_cid':FACTS['cid'],
              'flash_source':'/dev/mmcblk0p1','storage_source':'/dev/mmcblk0p2'}
        p.validate_live(data,'0.35.0','a'*40,FACTS)
        for changes in ({'storage_source':'/dev/mmcblk1p2'}, {'version':'0.34.0'}, {'cid':'b'*32}):
            with self.assertRaises(p.Blocked):p.validate_live(dict(data,**changes),'0.35.0','a'*40,FACTS)

class FakeAdb:
    def __init__(self):
        self.events=[];self.facts_value=FACTS;self.fail_write=False;self.digest='b'*64
    def facts(self, recovery=True):self.events.append('facts');return self.facts_value
    def stream(self,command,source):
        self.events.append('write')
        if self.fail_write:raise p.Blocked('write_failed')
    def readback(self,size):self.events.append('readback');self.read_size=size;return size,self.digest


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        import argparse
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.image=self.root/'image.gz'
        with gzip.open(self.image,'wb') as f:f.write(b'x'*512)
        self.args=argparse.Namespace(profile=p.PROFILE, expect_version='0.35.0', expect_commit='a'*40,
            host='169.254.170.2',image=self.image,manifest=self.root/'manifest',public_key=self.root/'pub',
            identity=self.root/'private',serial='test123',adb='fake-adb',job=self.root/'job',
            action='install',reconnect_timeout=10)
        self.args.identity.write_bytes(b'private fixture');self.args.identity.chmod(0o600)
        self.key=b'ssh-ed25519 AAAATEST\n'
        self.plan={'device_cid':FACTS['cid'], 'image':{'sha256':hashlib.sha256(self.image.read_bytes()).hexdigest()},
                   'flash_files':{'cubby-setup/authorized_keys':hashlib.sha256(self.key).hexdigest()}}
        self.binding=dict(serial='test123',image_sha256=self.plan['image']['sha256'],profile=p.PROFILE,
            version='0.35.0',commit='a'*40,public_key_sha256=hashlib.sha256(self.key).hexdigest())

    def patches(self):
        from contextlib import ExitStack
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch('rocknix.production_image.verify',return_value=self.plan))
        stack.enter_context(patch('rocknix.production_image.public_keys',return_value=self.key))
        stack.enter_context(patch.object(p,'checked_run',return_value=self.key.strip()))
        stack.enter_context(patch.object(p,'image_geometry',return_value=GEOMETRY))
        return stack

    def test_resume_after_linux_has_no_adb_uses_only_pinned_reconnect(self):
        self.patches()
        with p.Journal(self.args.job,self.binding) as journal:
            journal.save('rebooting',storage=p.identity(FACTS))
        with patch.object(p,'discover',side_effect=AssertionError('must not use adb')), \
             patch.object(p,'reconnect',return_value={'stage':'commissioning_pending'}) as reconnect:
            self.assertEqual(p.run(self.args)['stage'],'commissioning_pending')
            self.assertEqual(reconnect.call_args.args[2],p.identity(FACTS))

    def test_wrong_bound_cid_is_rejected_before_checkpoint_or_write(self):
        self.patches()
        self.plan['device_cid'] = 'b'*32
        stock=dict(FACTS,android='11',product='RG353P',platform='rk3566')
        with patch.object(p,'discover',return_value='test123'), patch.object(p,'Adb') as adb:
            adb.return_value.facts.return_value=stock
            with self.assertRaisesRegex(p.Blocked,'cid_mismatch'):
                p.run(self.args)
            adb.return_value.stream.assert_not_called()
            adb.return_value.command.assert_not_called()
        self.assertFalse((self.args.job/'state.json').exists())

    def test_read_only_plan_does_not_reboot_root_or_create_job(self):
        self.patches();self.args.action='plan'
        stock=dict(FACTS,android='11',product='RG353P',platform='rk3566')
        with patch.object(p,'discover',return_value='test123'),patch.object(p,'Adb') as adb:
            adb.return_value.facts.return_value=stock
            self.assertEqual(p.run(self.args)['stage'],'planned')
            adb.return_value.command.assert_not_called()
        self.assertFalse(self.args.job.exists())

    def test_wrong_reconnected_image_never_claims_commissioned(self):
        with p.Journal(self.args.job,self.binding) as journal:
            (self.args.job/'known_hosts').write_text('pinned')
            data={'version':'0.34.0','source_commit':'b'*40,'cid':FACTS['cid'],
                  'flash_source':'/dev/mmcblk0p1','storage_source':'/dev/mmcblk0p2'}
            with patch.object(p,'checked_run',return_value=json.dumps(data).encode()):
                with self.assertRaises(p.Blocked):p.reconnect(self.args,journal,FACTS)
            self.assertNotEqual(journal.state['stage'],'commissioning_pending')

    def test_reconnect_is_bounded_and_does_not_disable_host_verification(self):
        with p.Journal(self.args.job,self.binding) as journal:
            (self.args.job/'known_hosts').write_text('pinned')
            with patch.object(p,'checked_run',side_effect=p.Blocked('connection_failed')) as run, \
                 patch.object(p.time,'monotonic',side_effect=[0,0,10,10]),patch.object(p.time,'sleep'):
                with self.assertRaisesRegex(p.Blocked,'reconnect_timeout'):
                    p.reconnect(self.args,journal,FACTS)
            command=run.call_args.args[0]
            self.assertIn('StrictHostKeyChecking=yes',command)
            self.assertIn('BatchMode=yes',command)

    def test_image_mutation_rejected_before_write(self):
        transport=FakeAdb()
        with p.Journal(self.args.job,self.binding) as journal:
            with self.assertRaisesRegex(p.Blocked,'image_changed'):
                p.write_verified(transport,self.image,512,'a'*64,FACTS,journal,'f'*64)
            self.assertNotIn('write',transport.events)

    def test_unsupported_recovery_reread_blocks_before_any_write(self):
        self.patches()
        stock=dict(FACTS,android='11',product='RG353P',platform='rk3566')
        with patch.object(p,'discover',return_value='test123'), patch.object(p,'Adb') as adb, \
             patch.object(p,'probe_recovery_tools',side_effect=p.Blocked('ioctl_unsupported')), \
             patch.object(p,'write_verified') as write, patch.object(p,'enroll_host_identity') as enroll:
            adb.return_value.facts.return_value=stock
            adb.return_value.command.return_value=b'recovery'
            with self.assertRaisesRegex(p.Blocked,'ioctl_unsupported'): p.run(self.args)
            write.assert_not_called(); enroll.assert_not_called()

    def test_readback_precedes_partition_enrollment_and_reboot(self):
        self.patches(); events=[]
        stock=dict(FACTS,android='11',product='RG353P',platform='rk3566')
        with patch.object(p,'discover',return_value='test123'), patch.object(p,'Adb') as adb, \
             patch.object(p,'probe_recovery_tools',side_effect=lambda *a: events.append('probe')), \
             patch.object(p,'prepare_host_identity',return_value=(self.root/'host','digest')), \
             patch.object(p,'write_verified',side_effect=lambda *a: events.append('readback')), \
             patch.object(p,'enroll_host_identity',side_effect=lambda *a: events.append('enroll')) as enroll, \
             patch.object(p,'reconnect',return_value={'stage':'commissioning_pending'}):
            adb.return_value.facts.return_value=stock
            def command(*args, **kwargs):
                if args == ('reboot',): events.append('reboot')
                return b'recovery'
            adb.return_value.command.side_effect=command
            p.run(self.args)
            self.assertEqual(events,['probe','readback','enroll','reboot'])
            self.assertEqual(enroll.call_args.args[-1],GEOMETRY)


class ExecutableTransportTests(unittest.TestCase):
    def test_probe_rejects_root_failure_before_device_inventory(self):
        adb=p.Adb('fake-adb','test123')
        with patch.object(adb,'command',return_value=b'2000') as command:
            with self.assertRaisesRegex(p.Blocked,'root_unavailable'):adb.facts()
            self.assertEqual(command.call_count,1)

    def test_mount_aliases_are_canonicalized_by_probe(self):
        self.assertIn('readlink -f "$source"',p.PROBE)
        self.assertIn('/dev/block/mmcblk0p[0-9]*',p.PROBE)



class ShellV2TransportTests(unittest.TestCase):
    """Run actual shell/cat/dd through a model of ADB's two transport modes."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.executable = self.root/'adb'
        self.log = self.root/'argv'
        self.executable.write_text('''#!/usr/bin/env python3
import json, pathlib, subprocess, sys
args = sys.argv[1:]
assert args[:2] == ['-s', 'test123']
args = args[2:]
with pathlib.Path(LOG).open('a') as out: out.write(json.dumps(args)+'\\n')
if args == ['features']:
    print(FEATURES); sys.exit(0)
if args[0] == 'exec-out':
    # Real raw exec-out does NOT copy host stdin, combines stderr and has no status.
    result = subprocess.run(' '.join(args[1:]), shell=True, executable='/bin/bash',
                            input=b'', stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    sys.stdout.buffer.write(result.stdout); sys.exit(0)
assert args[:2] == ['shell', '-T'] and '-x' not in args
result = subprocess.run(' '.join(args[2:]), shell=True, executable='/bin/bash',
                        stdin=sys.stdin.buffer, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
'''.replace('LOG', repr(str(self.log))).replace('FEATURES', repr('shell_v2,cmd')))
        self.executable.chmod(0o700)
        self.adb = p.Adb(str(self.executable), 'test123')

    def test_stream_forwards_binary_stdin_and_enrollment_bytes(self):
        target = self.root/'target'; source = self.root/'source'
        payload = bytes(range(256))*99
        source.write_bytes(payload)
        with source.open('rb') as stream:
            self.adb.stream('cat > '+p.quote(str(target)), stream)
        self.assertEqual(target.read_bytes(), payload)
        self.assertNotIn(payload.hex(), self.log.read_text())

    def test_remote_failure_is_not_a_successful_command(self):
        with self.assertRaises(p.Blocked):
            self.adb.command('shell', 'sh', '-c', p.quote('echo sensitive >&2; exit 17'))

    def test_readback_excludes_real_dd_diagnostics_and_includes_tail(self):
        image = self.root/'disk'; payload = bytes(range(256))*66
        image.write_bytes(payload)
        with patch.object(p, 'BLOCK', str(image)):
            size, digest = self.adb.readback(len(payload))
        self.assertEqual(size, 512*33)
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
        commands = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(all(row[0] != 'exec-out' for row in commands))
        self.assertEqual(commands[-1][:2], ['shell','-T'])
        self.assertIn('bs=512 count=33', commands[-1][-1])

    def test_failed_readback_exit_status_is_not_a_digest(self):
        with patch.object(p, 'BLOCK', str(self.root/'missing')):
            with self.assertRaises(p.Blocked): self.adb.readback(512)

    def test_shell_v2_absent_blocks_before_stream(self):
        self.executable.write_text(self.executable.read_text().replace('shell_v2,cmd','cmd'))
        source = self.root/'source'; source.write_bytes(b'secret fixture')
        target = self.root/'never-written'
        with source.open('rb') as stream, self.assertRaises(p.Blocked):
            self.adb.stream('cat > '+p.quote(str(target)), stream)
        self.assertFalse(target.exists())

    def test_advertised_but_broken_shell_semantics_block_before_stream(self):
        text = self.executable.read_text().replace('sys.exit(result.returncode)', 'sys.exit(0)')
        self.executable.write_text(text)
        source = self.root/'source'; source.write_bytes(b'fixture')
        target = self.root/'never-written'
        with source.open('rb') as stream, self.assertRaises(p.Blocked):
            self.adb.stream('cat > '+p.quote(str(target)), stream)
        self.assertFalse(target.exists())

    def test_daemon_transitions_invalidate_verified_transport(self):
        self.adb.require_shell_v2()
        self.assertTrue(self.adb.shell_v2_verified)
        with patch.object(p.subprocess, 'run') as run:
            run.return_value.returncode = 0; run.return_value.stdout = b''
            for transition in [('root',), ('reboot','recovery'), ('wait-for-device',)]:
                self.adb.shell_v2_verified = True
                self.adb.command(*transition)
                self.assertFalse(self.adb.shell_v2_verified)

    def test_stdin_or_stderr_framing_failure_blocks_before_stream(self):
        original = self.executable.read_text()
        for broken in (original.replace('stdin=sys.stdin.buffer', "input=b''"),
                       original.replace('sys.stderr.buffer.write(result.stderr)',
                                        'sys.stdout.buffer.write(result.stderr)')):
            with self.subTest(broken=broken[-40:]):
                self.executable.write_text(broken)
                source = self.root/'source'; source.write_bytes(b'fixture')
                target = self.root/'never-written'
                with source.open('rb') as stream, self.assertRaises(p.Blocked):
                    self.adb.stream('cat > '+p.quote(str(target)), stream)
                self.assertFalse(target.exists())

    def test_actual_failing_blockdev_preflight_cannot_reach_write(self):
        fixture = self.root/'ordinary-file'; fixture.write_bytes(b'not a block device')
        command = self.adb.command
        def safe_command(*args, **kwargs):
            # Test only: map the fixed target to an ordinary temp file. Let the
            # actual blockdev ioctl fail; no real device pathname reaches a shell.
            script = args[-1].replace('/dev/block/mmcblk0',str(fixture))
            script = script.replace('test -b ', 'test -f ')
            return command(*args[:-1],script,**kwargs)
        with patch.object(self.adb,'command',side_effect=safe_command), \
             patch.object(p,'write_verified') as write:
            with self.assertRaises(p.Blocked):
                p.probe_recovery_tools(self.adb)
                p.write_verified(None,None,None,None,None,None)
            write.assert_not_called()
        self.assertIn('blockdev --rereadpt',self.log.read_text())

    def test_failing_partition_reread_blocks_via_remote_exit(self):
        # The required blockdev primitive runs against an ordinary nonexistent file.
        # No actual block device is accessed by this test.
        with self.assertRaises(p.Blocked):
            self.adb.command('shell','sh','-c',p.quote('blockdev --rereadpt '+str(self.root/'missing')))



class EnrollmentTests(unittest.TestCase):
    def test_real_sysfs_probe_script_reads_both_extents(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for name, (start,size) in GEOMETRY.items():
                partition=root/name; partition.mkdir()
                (partition/'start').write_text(str(start)+'\n')
                (partition/'size').write_text(str(size)+'\n')
            script=p.PARTITION_PROBE.replace('/sys/block/mmcblk0',str(root))
            result=subprocess.run(['sh','-c',script],capture_output=True,check=True)
            self.assertEqual(result.stdout,PARTITIONS)

    def test_geometry_is_derived_through_validated_gpt_parser_not_receipt(self):
        from rocknix import image
        with tempfile.TemporaryDirectory() as directory:
            artifact=Path(directory)/'image.gz'
            with gzip.open(artifact,'wb') as stream: stream.write(b'not a GPT')
            with self.assertRaises(ValueError): p.image_geometry(artifact)
            with patch.object(image,'generated_gpt_layout',return_value=(None,None,None,list(GEOMETRY.values()))) as parser:
                self.assertEqual(p.image_geometry(artifact),GEOMETRY)
                self.assertEqual(parser.call_count,1)

    def test_stale_android_mapping_or_extra_partition_never_mounts(self):
        from unittest.mock import Mock
        for response in (b'mmcblk0p1=16384:8192\nmmcblk0p2=24576:4096\n',
                         PARTITIONS + b'mmcblk0p3=99:100\n',
                         b'mmcblk0p1=32768:4194304\n',
                         b'mmcblk0p1=32768:4194304\nmmcblk0p2=4227072:1\n'):
            with self.subTest(response=response), tempfile.TemporaryDirectory() as directory:
                root=Path(directory); key=root/'key'; key.write_bytes(b'key')
                with p.Journal(root/'job',{'serial':'a'}) as journal:
                    adb=Mock(); adb.facts.return_value=FACTS
                    adb.command.side_effect=[b'',response]
                    with self.assertRaisesRegex(p.Blocked,'partition_geometry'):
                        p.enroll_host_identity(adb,key,FACTS,512,journal,GEOMETRY)
                    adb.stream.assert_not_called()

    def test_reread_failure_never_mounts_or_enrolls(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); key=root/'key'; key.write_bytes(b'key')
            with p.Journal(root/'job',{'serial':'a'}) as journal:
                adb=Mock(); adb.facts.return_value=FACTS
                adb.command.side_effect=p.Blocked('adb_command_failed')
                with self.assertRaises(p.Blocked):
                    p.enroll_host_identity(adb,key,FACTS,512,journal,GEOMETRY)
                adb.stream.assert_not_called()
                self.assertNotEqual(journal.state['stage'],'enrolled')

    def test_prewrite_probe_executes_actual_reread_not_only_help(self):
        from unittest.mock import Mock
        adb=Mock()
        p.probe_recovery_tools(adb)
        script=adb.command.call_args.args[-1]
        self.assertIn('blockdev --rereadpt /dev/block/mmcblk0',script)

    def test_enrollment_persists_exact_key_without_placing_private_bytes_in_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key=root/'host';key.write_bytes(b'PRIVATE TEST KEY')
            expected=hashlib.sha256(key.read_bytes()).hexdigest()
            with p.Journal(root/'job',{'serial':'a'}) as journal:
                from unittest.mock import Mock
                adb=Mock();adb.facts.return_value=FACTS
                adb.command.side_effect=[b'',PARTITIONS,(expected+'  fixed-path\n').encode()]
                p.enroll_host_identity(adb,key,FACTS,512,journal,GEOMETRY)
                self.assertIn('blockdev --rereadpt',adb.command.call_args_list[0].args[-1])
                script=adb.stream.call_args.args[0]
                self.assertNotIn('PRIVATE TEST KEY',script)
                self.assertIn('/cubby/recovery/private',script)
                self.assertEqual(journal.state['stage'],'enrolled')
                self.assertTrue(journal.state['personalization']['raw_hash_is_pre_personalization'])

    def test_enrollment_mismatch_is_not_checkpointed_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key=root/'host';key.write_bytes(b'PRIVATE TEST KEY')
            with p.Journal(root/'job',{'serial':'a'}) as journal:
                from unittest.mock import Mock
                adb=Mock();adb.facts.return_value=FACTS
                adb.command.side_effect=[b'',PARTITIONS,b'bad  fixed-path']
                with self.assertRaisesRegex(p.Blocked,'enrollment_mismatch'):
                    p.enroll_host_identity(adb,key,FACTS,512,journal,GEOMETRY)
                self.assertNotEqual(journal.state['stage'],'enrolled')

    def test_concurrent_job_cannot_acquire_checkpoint_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            job=Path(directory)/'job'
            with p.Journal(job,{'serial':'a'}):
                with self.assertRaises(BlockingIOError):
                    with p.Journal(job,{'serial':'a'}):pass



class StockRootTests(unittest.TestCase):
    def test_stock_su_must_prove_uid_zero(self):
        adb=p.Adb('fake-adb','test123')
        with patch.object(adb,'command',return_value=b'2000') as command:
            with self.assertRaisesRegex(p.Blocked,'stock_root_unavailable'):
                adb.facts(recovery=False)
            self.assertEqual(command.call_args.args,('shell','su','0','id','-u'))

if __name__=='__main__':unittest.main()
