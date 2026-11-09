"""Host-only stock installer tests. No device commands are executed."""
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rocknix import provision as p


FACTS = dict(cid='a'*32, name='BJTD4R', sectors=61071360, removable=0,
             battery=80, charging=True, mounted=False, sd=False)

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
        with patch.object(p.subprocess,'run') as run:
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
        data={'version':'0.35.0','source_commit':'a'*40,'cid':FACTS['cid'],
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
        self.plan={'image':{'sha256':hashlib.sha256(self.image.read_bytes()).hexdigest()},
                   'flash_files':{'cubby-setup/authorized_keys':hashlib.sha256(self.key).hexdigest()}}
        self.binding=dict(serial='test123',image_sha256=self.plan['image']['sha256'],profile=p.PROFILE,
            version='0.35.0',commit='a'*40,public_key_sha256=hashlib.sha256(self.key).hexdigest())

    def patches(self):
        from contextlib import ExitStack
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch('rocknix.production_image.verify',return_value=self.plan))
        stack.enter_context(patch('rocknix.production_image.public_keys',return_value=self.key))
        stack.enter_context(patch.object(p,'checked_run',return_value=self.key.strip()))
        return stack

    def test_resume_after_linux_has_no_adb_uses_only_pinned_reconnect(self):
        self.patches()
        with p.Journal(self.args.job,self.binding) as journal:
            journal.save('rebooting',storage=p.identity(FACTS))
        with patch.object(p,'discover',side_effect=AssertionError('must not use adb')), \
             patch.object(p,'reconnect',return_value={'stage':'commissioning_pending'}) as reconnect:
            self.assertEqual(p.run(self.args)['stage'],'commissioning_pending')
            self.assertEqual(reconnect.call_args.args[2],p.identity(FACTS))

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


class ExecutableTransportTests(unittest.TestCase):
    def test_fake_adb_executable_readback_includes_tail_and_pins_serial(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); executable=root/'adb'; log=root/'args'
            executable.write_text('#!/usr/bin/env python3\nimport sys,pathlib\n'
                +'pathlib.Path('+repr(str(log))+').write_text(repr(sys.argv[1:]))\n'
                +"sys.stdout.buffer.write(b'x'*(512*33))\n")
            executable.chmod(0o700)
            adb=p.Adb(str(executable),'test123')
            size,digest=adb.readback(512*33)
            self.assertEqual(size,512*33)
            self.assertEqual(digest,hashlib.sha256(b'x'*(512*33)).hexdigest())
            args=log.read_text()
            self.assertIn("'-s', 'test123', 'exec-out'",args)
            self.assertIn('bs=512 count=33',args)

    def test_probe_rejects_root_failure_before_device_inventory(self):
        adb=p.Adb('fake-adb','test123')
        with patch.object(adb,'command',return_value=b'2000') as command:
            with self.assertRaisesRegex(p.Blocked,'root_unavailable'):adb.facts()
            self.assertEqual(command.call_count,1)

    def test_mount_aliases_are_canonicalized_by_probe(self):
        self.assertIn('readlink -f "$source"',p.PROBE)
        self.assertIn('/dev/block/mmcblk0p[0-9]*',p.PROBE)



class EnrollmentTests(unittest.TestCase):
    def test_enrollment_persists_exact_key_without_placing_private_bytes_in_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key=root/'host';key.write_bytes(b'PRIVATE TEST KEY')
            expected=hashlib.sha256(key.read_bytes()).hexdigest()
            with p.Journal(root/'job',{'serial':'a'}) as journal:
                from unittest.mock import Mock
                adb=Mock();adb.facts.return_value=FACTS
                adb.command.return_value=(expected+'  fixed-path\n').encode()
                p.enroll_host_identity(adb,key,FACTS,512,journal)
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
                adb=Mock();adb.facts.return_value=FACTS;adb.command.return_value=b'bad  fixed-path'
                with self.assertRaisesRegex(p.Blocked,'enrollment_mismatch'):
                    p.enroll_host_identity(adb,key,FACTS,512,journal)
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
