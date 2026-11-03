"""Desktop boundary tests without starting an Electron window."""
from pathlib import Path
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which('node'), 'Node JS interpreter required')
class DesktopHostTests(unittest.TestCase):
    def test_desktop_boundaries(self):
        result = subprocess.run(['node', '--test', 'tests/desktop_host.cjs', 'tests/cloud_hub.cjs', 'tests/desktop_installer.cjs'],
                                cwd=Path(__file__).resolve().parents[1],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
