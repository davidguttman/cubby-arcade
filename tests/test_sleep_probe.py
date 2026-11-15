"""Bounded sleep probes fail closed before suspend and clean only owned state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sleep_probe', Path(__file__).resolve().parents[1]/'rocknix/device/sleep_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class DiscoveryTests(unittest.TestCase):
    def test_characterized_kernel_name_is_not_the_physical_path(self):
        rows = [dict(event='event1', name='rk805 pwrkey', phys='rk805_pwrkey/input0', key=1 << 116)]
        self.assertEqual(probe.select_power(rows)['event'], 'event1')

    def test_wrong_capability_and_ambiguous_devices_fail_before_sleep(self):
        row = dict(event='event1', name='rk805 pwrkey', phys='', key=1 << 116)
        for rows in ([], [dict(row, key=1)], [row, dict(row, event='event2')]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                probe.select_power(rows)


class SettingsTests(unittest.TestCase):
    def test_symlinked_settings_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'real').mkdir(); (root/'alias').symlink_to('real')
            with self.assertRaises(ValueError):
                with probe.temporary_settings(root/'alias/power.json'): pass
            self.assertFalse((root/'real/power.json').exists())

    def test_existing_file_or_link_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'power.json'
            for link in (False, True):
                if link:
                    path.unlink(); path.symlink_to('missing')
                else:
                    path.write_text('original')
                with self.assertRaises(FileExistsError):
                    with probe.temporary_settings(path):
                        self.fail('existing state accepted')
                if not link: self.assertEqual(path.read_text(), 'original')

    def test_exception_cleans_owned_settings_but_preserves_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'power.json'
            with self.assertRaises(RuntimeError):
                with probe.temporary_settings(path):
                    self.assertEqual(json.loads(path.read_text())['external_wake_seconds'], 15)
                    raise RuntimeError('probe failed')
            self.assertFalse(path.exists())
            with self.assertRaises(ValueError):
                with probe.temporary_settings(path):
                    path.write_text('someone changed this')
            self.assertEqual(path.read_text(), 'someone changed this')


class FakeHost:
    def __init__(self, root, fail=False):
        self.settings = root/'power.json'; self.log = root/'power.log'
        self.log.write_text('old restore\n'); self.events=[]; self.fail=fail
    def preflight(self): self.events.append('preflight'); return {'event':'event1'}
    def restart(self): self.events.append('restart')
    def arm_probe(self): self.events.append('alarm')
    def suspend_and_wake(self, timeout):
        self.events.append('suspend')
        if self.fail: raise TimeoutError('no verified suspend')
        self.log.write_text('old restore\nwake reason=button\naudio/display restored muted=False\n')
        return 15.0
    def status(self): return {'display_on':True, 'unmuted':True, 'cog':True}
    def close(self): self.events.append('close')


class RunTests(unittest.TestCase):
    def test_preflight_failure_never_restarts_or_suspends(self):
        with tempfile.TemporaryDirectory() as tmp:
            host=FakeHost(Path(tmp))
            def refuse(): raise ValueError('bad preflight')
            host.preflight=refuse
            with self.assertRaises(ValueError): probe.run_probe(host)
            self.assertEqual(host.events, ['close'])

    def test_failure_restores_defaults_and_never_claims_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            host=FakeHost(Path(tmp), fail=True)
            with self.assertRaises(TimeoutError): probe.run_probe(host)
            self.assertFalse(host.settings.exists())
            self.assertEqual(host.events, ['preflight','alarm','restart','suspend','restart','close'])

    def test_success_needs_suspend_and_fresh_restore_and_reports_physical_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            host=FakeHost(Path(tmp)); result=probe.run_probe(host)
            self.assertTrue(result['passed'])
            self.assertFalse(result['physical_switch_verified'])
            self.assertEqual(result['suspended_seconds'], 15)
            self.assertFalse(host.settings.exists())

    def test_stale_log_cannot_pass_even_with_good_audio_and_display(self):
        with tempfile.TemporaryDirectory() as tmp:
            host=FakeHost(Path(tmp)); host.suspend_and_wake=lambda timeout: 15
            with self.assertRaises(ValueError): probe.run_probe(host)
            self.assertFalse(host.settings.exists())


if __name__ == '__main__': unittest.main()
