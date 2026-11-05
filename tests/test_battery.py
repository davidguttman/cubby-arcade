import tempfile
from pathlib import Path
import unittest

from runtime.battery import read_battery


class BatteryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def supply(self, name='rk817-battery', **values):
        folder = self.root / name
        folder.mkdir(exist_ok=True)
        for key, value in values.items():
            (folder / key).write_text(str(value))
        return folder

    def test_kernel_capacity_and_charging_status(self):
        self.supply(type='Battery', capacity=17, status='Charging', present=1)
        self.assertEqual(read_battery(self.root), {'available': True, 'level': 17, 'charging': True})
        self.supply(capacity=100, status='Full')
        self.assertEqual(read_battery(self.root), {'available': True, 'level': 100, 'charging': False})

    def test_ignores_mains_and_absent_batteries(self):
        self.supply('ac', type='Mains', capacity=100, status='Charging')
        self.supply(type='Battery', present=0, capacity=0, status='Unknown')
        self.assertEqual(read_battery(self.root), {'available': False})

    def test_missing_malformed_or_out_of_range_data_is_unavailable(self):
        self.assertEqual(read_battery(self.root / 'missing'), {'available': False})
        folder = self.supply(type='Battery', capacity=50)
        self.assertEqual(read_battery(self.root), {'available': False})
        for value in ['oops', '-1', '101', '12.5', '']:
            with self.subTest(value=value):
                self.supply(capacity=value, status='Discharging')
                self.assertEqual(read_battery(self.root), {'available': False})
        (folder / 'capacity').unlink()
        self.assertEqual(read_battery(self.root), {'available': False})

    def test_bad_supply_does_not_hide_later_valid_battery(self):
        self.supply('aaa', type='Battery', capacity='bad', status='Discharging')
        self.supply(type='Battery', capacity=0, status='Discharging')
        self.assertEqual(read_battery(self.root), {'available': True, 'level': 0, 'charging': False})
