import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wifi_recovery', ROOT/'rocknix/device/wifi-recovery.py')


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sys = self.root/'sys'
        self.chip = self.sys/'bus/sdio/devices/mmc7:0001:1'
        self.chip.mkdir(parents=True)
        (self.chip/'vendor').write_text('0x024c')
        (self.chip/'device').write_text('0xc821')
        self.model = self.root/'model'
        self.model.write_bytes(b'Anbernic RG353V\0')
        self.now = 0
        self.commands = []
        self.bluetooth = True
        self.fail_remove = False
        self.fail_insert = False
        self.create_wlan = True
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.recovery = self.module.Recovery(self.sys, self.model, self.root/'state',
                                            run=self.run_command, now=lambda:self.now,
                                            sleep=self.sleep)

    def sleep(self, seconds):
        self.now += seconds

    def wlan(self):
        (self.chip/'net/wlan1').mkdir(parents=True, exist_ok=True)

    def run_command(self, argv, **kwargs):
        self.commands.append(argv)
        self.assertLessEqual(kwargs['timeout'], 5)
        if argv[0] == 'journalctl':
            text = 'Bluetooth: hci0: RTL: fw version 0x123' if self.bluetooth else 'Bluetooth: hci0: start'
            return subprocess.CompletedProcess(argv, 0, text, '')
        if '-r' in argv and self.fail_remove:
            raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
        if argv == ['modprobe', 'rtw88_8821cs']:
            if self.fail_insert:
                return subprocess.CompletedProcess(argv, 1, '', '')
            if self.create_wlan:
                self.wlan()
        return subprocess.CompletedProcess(argv, 0, '', '')

    def mutations(self):
        return [c for c in self.commands if c[0]=='modprobe']

    def test_success_and_repeat_skip(self):
        self.assertTrue(self.recovery.recover())
        self.assertEqual(self.mutations(), [self.module.REMOVE, self.module.INSERT])
        self.assertTrue(self.recovery.recover())
        self.assertEqual(len(self.mutations()), 2)
        self.assertIn('-b', self.commands[0])

    def test_wrong_model_chip_or_no_sdio(self):
        for mode in ('model', 'chip', 'missing'):
            with self.subTest(mode=mode):
                self.commands.clear()
                self.model.write_text('Anbernic RG353VS' if mode=='model' else 'Anbernic RG353V')
                (self.chip/'device').write_text('0x1234' if mode=='chip' else '0xc821')
                if mode=='missing': (self.chip/'vendor').unlink()
                self.assertFalse(self.recovery.recover())
                self.assertEqual(self.mutations(), [])

    def test_existing_disconnected_wlan_is_untouched(self):
        self.wlan()
        self.assertTrue(self.recovery.recover())
        self.assertEqual(self.commands, [])

    def test_delayed_sdio_probe_is_allowed_to_finish(self):
        hidden = self.root/'pending-chip'
        self.chip.rename(hidden)
        def appears(seconds):
            self.now += seconds
            if hidden.exists(): hidden.rename(self.chip)
        self.recovery.sleep = appears
        self.assertTrue(self.recovery.recover())
        self.assertEqual(self.mutations(), [self.module.REMOVE, self.module.INSERT])

    def test_bluetooth_timeout_never_reloads(self):
        self.bluetooth = False
        self.assertFalse(self.recovery.recover())
        self.assertEqual(self.mutations(), [])
        self.assertLess(self.now, 40)

    def test_bluetooth_delayed_and_wlan_race(self):
        self.bluetooth = False
        def delayed(seconds):
            self.now += seconds
            self.bluetooth = True
        self.recovery.sleep = delayed
        self.assertTrue(self.recovery.recover())
        self.assertGreater(self.now, 0)
        self.commands.clear()
        (self.chip/'net/wlan1').rmdir()
        self.bluetooth = False
        def appears(seconds):
            self.now += seconds
            self.wlan()
        self.recovery.sleep = appears
        self.assertTrue(self.recovery.recover())
        self.assertEqual(self.mutations(), [])

    def test_other_rtw88_user_blocks_removal(self):
        other = self.sys/'class/net/wlan2'
        (other/'wireless').mkdir(parents=True)
        driver = other/'device/driver'
        driver.parent.mkdir()
        driver.symlink_to('/sys/bus/sdio/drivers/rtw88_8821cs')
        self.assertFalse(self.recovery.recover())
        self.assertEqual(self.mutations(), [])

    def test_another_bound_sdio_consumer_blocks_removal(self):
        other = self.sys/'bus/sdio/devices/mmc8:0001:1'
        other.mkdir()
        (other/'driver').symlink_to('/sys/bus/sdio/drivers/rtw88_8821cs')
        self.assertFalse(self.recovery.recover())
        self.assertEqual(self.mutations(), [])

    def test_missing_current_boot_evidence_command_fails_closed(self):
        def unavailable(argv, **kwargs):
            self.commands.append(argv)
            raise OSError('journal unavailable')
        self.recovery.run = unavailable
        self.assertFalse(self.recovery.recover())
        self.assertEqual(self.mutations(), [])

    def test_removal_failure_attempts_restore(self):
        self.fail_remove = True
        self.assertFalse(self.recovery.recover())
        self.assertEqual(self.mutations(), [self.module.REMOVE, self.module.INSERT])

    def test_insertion_failure_and_no_interface_are_bounded(self):
        self.fail_insert = True
        self.assertFalse(self.recovery.recover())
        self.fail_insert = False
        self.create_wlan = False
        self.assertFalse(self.recovery.recover())
        self.assertLess(self.now, 40)

    def test_unwritable_persistence_is_not_fatal(self):
        self.recovery.state = self.model
        self.assertTrue(self.recovery.recover())

    def test_service_is_bounded_opt_out_and_nonfatal(self):
        service = (ROOT/'rocknix/device/cubby-wifi-recovery.service').read_text()
        self.assertIn('TimeoutStartSec=45', service)
        self.assertIn('ConditionPathExists=!/flash/CUBBY-WIFI-RECOVERY-DISABLED', service)
        self.assertIn('Before=essway.service', service)
        self.assertNotIn('Restart=', service)
        from rocknix.image import BOOT_HOOK
        self.assertIn('cubby-wifi-recovery.service', BOOT_HOOK.split('[ ! -e /flash/CUBBY-DISABLED ]')[0])


if __name__ == '__main__': unittest.main()
