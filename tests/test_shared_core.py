"""Behavioral JS contract tests; Node is an interpreter, never a server."""
from pathlib import Path
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which('node'), 'Node JS interpreter required')
class SharedCoreTests(unittest.TestCase):
    def test_shared_contract(self):
        result = subprocess.run(['node', '--test', 'tests/shared_core.cjs', 'tests/controls.cjs', 'tests/host_osd.cjs', 'tests/game_shell.cjs', 'tests/preferences.cjs', 'tests/preferences_pages.cjs', 'tests/save_management.cjs'],
                                cwd=Path(__file__).resolve().parents[1],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
