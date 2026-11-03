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
