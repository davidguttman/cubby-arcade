"""Brand migration preserves old VM override contracts while preferring new names."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

class BrandingTests(unittest.TestCase):
    def test_vm_state_override_compatibility(self):
        root = Path(__file__).resolve().parents[1]
        for values, expected in [({}, '/mnt/data/vms/cubby-arcade'),
                                 ({'HANDHELD_VM_DIR': '/tmp/legacy-vm'}, '/tmp/legacy-vm'),
                                 ({'HANDHELD_VM_DIR': '/tmp/legacy-vm', 'CUBBY_ARCADE_VM_DIR': '/tmp/cubby-vm'}, '/tmp/cubby-vm')]:
            env = {k:v for k,v in os.environ.items() if k not in ('HANDHELD_VM_DIR', 'CUBBY_ARCADE_VM_DIR')}
            env.update(values)
            result = subprocess.run([sys.executable, '-c', 'import vm; print(vm.STATE)'], cwd=root, env=env, text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.strip(), expected)

class VmIdentityTests(unittest.TestCase):
    def test_migrated_symlink_disk_still_identifies_running_vm(self):
        import tempfile
        from unittest.mock import patch
        import vm
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'cubby-arcade'
            state.mkdir()
            (state / 'disk.qcow2').write_bytes(b'disk')
            (state / 'qemu.pid').write_text('4242')
            old = root / 'handheld-os'
            old.symlink_to(state, target_is_directory=True)
            command = ('/usr/bin/qemu-system-aarch64\0-drive\0if=none,id=os,format=qcow2,file=' + str(old / 'disk.qcow2') + '\0').encode()
            with patch.object(vm, 'STATE', state), patch.object(Path, 'read_bytes', return_value=command):
                self.assertEqual(vm.pid(), 4242)

    def test_unrelated_disk_cannot_match_path_substrings_or_other_arguments(self):
        import tempfile
        from unittest.mock import patch
        import vm
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            disk = state / 'disk.qcow2'
            disk.write_bytes(b'owned')
            other = state / 'disk.qcow2.backup'
            other.write_bytes(b'other')
            (state / 'qemu.pid').write_text('4242')
            commands = [
                f'/usr/bin/qemu-system-aarch64\0-drive\0if=none,id=os,format=qcow2,file={other}\0',
                f'/usr/bin/qemu-system-aarch64\0-name\0{disk}\0-drive\0if=none,id=os,file={other}\0',
                f'/usr/bin/not-qemu-system-aarch64\0-drive\0id=os,file={disk}\0',
                f'/usr/bin/qemu-system-aarch64\0-drive\0id=seed,file={disk}\0',
            ]
            for command in commands:
                with self.subTest(command=command), patch.object(vm, 'STATE', state), patch.object(Path, 'read_bytes', return_value=command.encode()):
                    self.assertIsNone(vm.pid())
