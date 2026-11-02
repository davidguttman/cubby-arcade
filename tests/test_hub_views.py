from pathlib import Path
import subprocess
import unittest

class HubViewTests(unittest.TestCase):
    def test_shared_hub_state(self):
        result = subprocess.run(['node', '--test', 'tests/hub_views.cjs'], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
