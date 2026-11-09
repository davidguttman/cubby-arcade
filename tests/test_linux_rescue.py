import copy
import unittest
from rocknix import linux_rescue as rescue
from rocknix.provision import Blocked

CID='150100424a5444345200ec55ccb75600'

def facts():
    return dict(cid=CID,name='BJTD4R',sectors=61071360,removable=0,battery=85,
                type='MMC',sd=True,mounted=False,charging=True,flash='/dev/mmcblk1p1',storage='/dev/mmcblk1p2',
                root_disks=['mmcblk1'],active_disks=['mmcblk1'],holders=[],
                media_ids=['SD-LABEL','SD-UUID','SD-PARTUUID'],probe_complete=True)

class Safety(unittest.TestCase):
    def test_valid_sd(self):
        result=rescue.validate_rescue(facts(),1024)
        self.assertFalse(result['sd']) # only adapter result satisfies existing Android-core guard
    def test_unsafe_dependencies(self):
        for key,value in [('root_disks',['mmcblk0']),('root_disks',[]),
                          ('active_disks',['mmcblk1','mmcblk0']),('holders',['dm-0']),
                          ('flash','/dev/mmcblk0p1'),('storage','/dev/mmcblk0p2'),
                          ('probe_complete',False),('sd',False),('mounted',True),
                          ('cid','0'*32)]:
            with self.subTest(key=key,value=value), self.assertRaises(Blocked):
                data=facts(); data[key]=value; rescue.validate_rescue(data,1024)
    def test_media_collision(self):
        plan={'media_identities':dict(boot_label='SD-LABEL',partition_guids=['p1','p2'])}
        with self.assertRaises(Blocked):rescue.distinct_media(facts(),plan)
        plan['media_identities']['boot_label']='OTHER'
        rescue.distinct_media(facts(),plan)
    def test_missing_media_probe(self):
        data=facts();data['media_ids']=[]
        with self.assertRaises(Blocked):rescue.distinct_media(data,{'media_identities':{}})


import hashlib
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from rocknix.device import linux_rescue_probe as probe

class RealTransport(unittest.TestCase):
    def test_pinned_args_and_real_binary_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            directory=Path(directory)
            args=SimpleNamespace(recovery_port=2223,identity=directory/'key',
                                 recovery_known_hosts=directory/'known',host='169.254.170.2')
            remote=rescue.Ssh(args,{},512)
            command=remote.args('true')
            for value in ('-T','StrictHostKeyChecking=yes','ClearAllForwardings=yes'):
                self.assertIn(value,command)
            wrapper=directory/'ssh-fixture.py'
            wrapper.write_text('import subprocess,sys\nsys.exit(subprocess.run(["sh","-c",sys.argv[-1]]).returncode)\n')
            def local(*parts):return ['python3',str(wrapper),*parts]
            remote.args=local
            remote.require_shell_v2()
            with self.assertRaises(Blocked):remote.command('shell','false')
            output=directory/'out'; payload=b'\x00\xff\r\n'*1024
            source=directory/'in';source.write_bytes(payload)
            with source.open('rb') as stream:
                remote.stream('cat > '+str(output)+'; printf diagnostic >&2',stream)
            self.assertEqual(output.read_bytes(),payload)
            # Exercise shared finite dd readback with statistics on stderr and
            # the historically missed final 33 sectors.
            payload=b'A'*(33*512);output.write_bytes(payload)
            def mapped(*parts):return local(*(part.replace('/dev/mmcblk0',str(output)) for part in parts))
            remote.args=mapped
            self.assertEqual(remote.readback(len(payload)),(len(payload),hashlib.sha256(payload).hexdigest()))

class Collector(unittest.TestCase):
    def test_loop_root_sd_and_target_consumers(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            def write(name,value):
                path=root/name.lstrip('/');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value)
            def node(name,dev,parent=None):
                actual=root/'sys/devices'/('mmcblk1/'+name if parent else name)
                actual.mkdir(parents=True,exist_ok=True)
                (actual/'dev').write_text(dev)
                for child in ('slaves','holders'):(actual/child).mkdir(exist_ok=True)
                if parent:(actual/'partition').write_text('1')
                for base,key in [('sys/dev/block',dev),('sys/class/block',name)]:
                    path=root/base/key;path.parent.mkdir(parents=True,exist_ok=True);path.symlink_to(actual)
                return actual
            sd=node('mmcblk1','179:8');node('mmcblk1p1','179:9',True);node('mmcblk1p2','179:10',True)
            internal=node('mmcblk0','179:0');loop=node('loop0','7:0')
            (loop/'loop').mkdir();(loop/'loop/backing_file').write_text('/flash/SYSTEM')
            for name,value in [('device/cid',CID),('device/name','BJTD4R'),('device/type','MMC'),
                               ('size','61071360'),('removable','0')]:
                path=internal/name;path.parent.mkdir(exist_ok=True,parents=True);path.write_text(value)
            (root/'sys/block').mkdir()
            (root/'sys/block/mmcblk0').symlink_to(internal);(root/'sys/block/mmcblk1').symlink_to(sd)
            write('/sys/class/power_supply/battery/capacity','85')
            write('/sys/class/power_supply/battery/status','Charging')
            mount='1 0 7:0 / / ro - squashfs /dev/loop0 ro\n2 1 179:9 / /flash ro - vfat /dev/mmcblk1p1 ro\n3 1 179:10 / /storage rw - ext4 /dev/mmcblk1p2 rw\n'
            write('/proc/self/mountinfo',mount);write('/proc/swaps','Filename Type Size Used Priority\n')
            original=Path
            def mapped(path):return original(root/str(path).lstrip('/'))
            result=SimpleNamespace(stdout='UUID=SDUUID\nPARTUUID=SDPART\nLABEL=SDLABEL\n')
            with patch.object(probe,'Path',side_effect=mapped),patch.object(probe.os,'geteuid',return_value=0),patch.object(probe.subprocess,'run',return_value=result):
                data=probe.collect()
                self.assertEqual(data['root_disks'],['mmcblk1']);rescue.validate_rescue(data,512)
                # A target mount private to another process is still active.
                write('/proc/123/mountinfo',mount+'4 1 179:0 / /private rw - ext4 /dev/mmcblk0 rw\n')
                write('/proc/123/maps','')
                (root/'proc/123/fd').mkdir()
                with self.assertRaises(Blocked):rescue.validate_rescue(probe.collect(),512)
                # Lazy unmount removes the mount record, not open file users.
                write('/proc/123/mountinfo',mount)
                write('/proc/123/fd/7','open target file')
                original_stat=original.stat
                target_reference=root/'proc/123/fd/7'
                def target_file(path,*args,**kwargs):
                    if path==target_reference:
                        return SimpleNamespace(st_mode=0o100600,st_dev=__import__('os').makedev(179,0))
                    return original_stat(path,*args,**kwargs)
                for name in ('fd/7','cwd','root','exe'):
                    target_reference=root/'proc/123'/name
                    with self.subTest(reference=name),patch.object(original,'stat',target_file):
                        with self.assertRaises(Blocked):rescue.validate_rescue(probe.collect(),512)
                (root/'proc/123/fd/7').unlink()
                # File mappings survive both descriptor closure and unmount.
                write('/proc/123/maps','1000-2000 r--p 00000000 b3:00 12 /gone (deleted)\n')
                with self.assertRaises(Blocked):rescue.validate_rescue(probe.collect(),512)
                write('/proc/123/maps','')
                (root/'proc/123/maps').unlink()
                with self.assertRaisesRegex(ValueError,'process_dependencies_unresolved'):probe.collect()
                write('/proc/123/maps','')
                original_read=original.read_text
                def unreadable_namespace(path,*args,**kwargs):
                    if path==root/'proc/123/mountinfo':raise PermissionError('fixture')
                    return original_read(path,*args,**kwargs)
                with patch.object(original,'read_text',unreadable_namespace):
                    with self.assertRaises(PermissionError):probe.collect()
                (root/'proc/123/fd').rmdir()
                (root/'proc/123/maps').unlink();(root/'proc/123/mountinfo').unlink();(root/'proc/123').rmdir()
                # Loopback root depending on mounted eMMC is detected transitively.
                write('/proc/self/mountinfo',mount+'4 1 179:0 / /internal rw - ext4 /dev/mmcblk0 rw\n')
                (loop/'loop/backing_file').write_text('/internal/SYSTEM')
                data=probe.collect()
                with self.assertRaises(Blocked):rescue.validate_rescue(data,512)
                # Swap and holders also block even without an eMMC mount.
                write('/proc/self/mountinfo',mount)
                (loop/'loop/backing_file').write_text('/flash/SYSTEM')
                write('/proc/swaps','Filename Type Size Used Priority\n/internal/swap file 12 0 -2\n')
                with self.assertRaises((ValueError,FileNotFoundError)):probe.collect()
                write('/proc/swaps','Filename Type Size Used Priority\n')
                (internal/'holders/dm-0').mkdir()
                with self.assertRaises(Blocked):rescue.validate_rescue(probe.collect(),512)
                (internal/'holders/dm-0').rmdir()
                (loop/'loop/backing_file').write_text('/unknown/SYSTEM')
                with self.assertRaises(ValueError):probe.collect()

class Orchestration(unittest.TestCase):
    def test_install_then_pinned_verify_and_no_second_write(self):
        from contextlib import ExitStack
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            directory=Path(directory)
            identity=directory/'key';identity.write_bytes(b'private');identity.chmod(0o600)
            known=directory/'known';known.write_text('pinned');known.chmod(0o600)
            args=SimpleNamespace(host='169.254.170.2',recovery_port=2223,reconnect_timeout=10,
                 expect_commit='a'*40,expect_version='0.35.0',identity=identity,
                 recovery_known_hosts=known,job=directory/'job',image=directory/'image',
                 manifest=directory/'manifest',public_key=directory/'pub',action='install')
            key=b'ssh-ed25519 AAAA fixture\n'
            plan=dict(image={'sha256':'b'*64},flash_files={'cubby-setup/authorized_keys':hashlib.sha256(key).hexdigest()})
            events=[];remote=Mock()
            clean=rescue.validate_rescue(facts(),512)
            remote.facts.return_value=clean
            remote.command.side_effect=lambda *a,**kw:events.append('command')
            for module,name,value in [(rescue,'Ssh',Mock(return_value=remote)),
                (rescue.p,'raw_digest',Mock(return_value=(512,'c'*64))),
                (rescue.p,'image_geometry',Mock(return_value={'mmcblk0p1':(1,1)})),
                (rescue.p,'checked_run',Mock(return_value=key)),
                (rescue.p,'probe_recovery_tools',Mock(side_effect=lambda _:events.append('tools'))),
                (rescue.p,'prepare_host_identity',Mock(return_value=(identity,'hosthash'))),
                (rescue.p,'write_verified',Mock(side_effect=lambda *a:events.append('write_readback'))),
                (rescue.p,'enroll_host_identity',Mock(side_effect=lambda *a:events.append('enroll'))),
                (rescue.p,'reconnect',Mock(return_value={'stage':'commissioning_pending'}))]:
                stack.enter_context(patch.object(module,name,value))
            stack.enter_context(patch('rocknix.production_image.verify',return_value=plan))
            stack.enter_context(patch('rocknix.production_image.public_keys',return_value=key))
            result=rescue.run(args)
            self.assertEqual(result['stage'],'awaiting_internal_boot')
            self.assertLess(events.index('tools'),events.index('write_readback'))
            self.assertLess(events.index('write_readback'),events.index('enroll'))
            first=list(events)
            args.action='verify'
            self.assertEqual(rescue.run(args)['stage'],'commissioning_pending')
            self.assertEqual(events,first)
            # Even install retry on this checkpoint cannot reflash the device.
            args.action='install';rescue.run(args);self.assertEqual(events,first)
            # A fresh verify never enters installation or writes a byte.
            args.job=directory/'uninstalled';args.action='verify'
            with self.assertRaisesRegex(Blocked,'verified_install_checkpoint_required'):rescue.run(args)
            self.assertEqual(events,first)
            # A failed raw verification cannot reach key enrollment/shutdown.
            args.job=directory/'interrupted';args.action='install'
            rescue.p.write_verified.side_effect=Blocked('readback_mismatch')
            with self.assertRaisesRegex(Blocked,'readback_mismatch'):rescue.run(args)
            self.assertEqual(events.count('enroll'),1)

    def test_unknown_type_fails_closed(self):
        data=facts();del data['type']
        with self.assertRaises(Blocked):rescue.validate_rescue(data,512)

if __name__=='__main__':unittest.main()
