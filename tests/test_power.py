"""Sleep decisions, without a device. Host is the only part that touches one."""
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cubby_power', ROOT / 'rocknix/device/power.py')
power = importlib.util.module_from_spec(spec)
spec.loader.exec_module(power)
Reading = power.Reading
MINUTE = 60
HOUR = 60 * MINUTE
SETTINGS = dict(power.DEFAULTS)


def battery(percent, external=False, critical=False):
    return Reading(percent, external, critical)


class DrainPlanTests(unittest.TestCase):
    def setUp(self):
        self.plan = power.DrainPlan(SETTINGS)

    def test_first_measurement_is_15_minutes_after_sleep(self):
        self.assertEqual(self.plan.start(battery(80), 0), 15 * MINUTE)

    def test_works_out_when_it_would_reach_10_percent(self):
        self.plan.start(battery(80), 0)
        # 1% in 15 minutes leaves 69% to go: 69 * 15 minutes, capped at 12 hours.
        self.assertEqual(self.plan.after_wake(battery(79), 15 * MINUTE), ('sleep', 12 * HOUR))
        self.plan = power.DrainPlan(SETTINGS)
        self.plan.start(battery(30), 0)
        self.assertEqual(self.plan.after_wake(battery(25), HOUR), ('sleep', 3 * HOUR))

    def test_recomputes_from_the_latest_measurement(self):
        self.plan.start(battery(30), 0)
        self.assertEqual(self.plan.after_wake(battery(25), HOUR), ('sleep', 3 * HOUR))
        # Drain doubled, so the next estimate uses the new rate rather than the average.
        self.assertEqual(self.plan.after_wake(battery(13), 4 * HOUR), ('sleep', 45 * MINUTE))

    def test_never_wakes_again_sooner_than_the_first_interval(self):
        self.plan.start(battery(12), 0)
        self.assertEqual(self.plan.after_wake(battery(10.1), HOUR), ('sleep', 15 * MINUTE))

    def test_powers_off_at_the_low_mark_only(self):
        self.plan.start(battery(20), 0)
        self.assertEqual(self.plan.after_wake(battery(10.01), HOUR)[0], 'sleep')
        self.assertEqual(self.plan.after_wake(battery(10), 2 * HOUR), ('poweroff', None))

    def test_already_low_still_gets_the_first_interval_then_powers_off(self):
        self.assertEqual(self.plan.start(battery(8), 0), 15 * MINUTE)
        self.assertEqual(self.plan.after_wake(battery(8), 15 * MINUTE), ('poweroff', None))

    def test_coarse_reading_backs_off_and_keeps_the_baseline(self):
        self.plan.start(battery(50), 0)
        self.assertEqual(self.plan.after_wake(battery(50), 15 * MINUTE), ('sleep', 30 * MINUTE))
        self.assertEqual(self.plan.after_wake(battery(50), 45 * MINUTE), ('sleep', HOUR))
        self.assertEqual(self.plan.after_wake(battery(50), 105 * MINUTE), ('sleep', 2 * HOUR))
        # The drop is measured across the whole span, not the last interval: 1% per 225 minutes.
        self.assertEqual(self.plan.after_wake(battery(49), 225 * MINUTE), ('sleep', 12 * HOUR))

    def test_backing_off_stops_at_the_longest_wait(self):
        self.plan.start(battery(50), 0)
        now = 0
        for _ in range(12):
            action, seconds = self.plan.after_wake(battery(50), now + HOUR)
            now += seconds
        self.assertEqual((action, seconds), ('sleep', 12 * HOUR))

    def test_on_external_power_nothing_powers_off(self):
        self.assertEqual(self.plan.start(battery(5, external=True), 0), HOUR)
        self.assertEqual(self.plan.after_wake(battery(3, external=True), HOUR), ('sleep', HOUR))

    def test_unplugging_while_asleep_starts_a_new_measurement(self):
        self.plan.start(battery(90, external=True), 0)
        self.assertEqual(self.plan.after_wake(battery(90), HOUR), ('sleep', 15 * MINUTE))
        self.assertEqual(self.plan.after_wake(battery(85), 2 * HOUR), ('sleep', 12 * HOUR))

    def test_a_reading_that_rises_is_a_new_baseline_not_a_negative_drain(self):
        self.plan.start(battery(50), 0)
        self.assertEqual(self.plan.after_wake(battery(60), HOUR), ('sleep', 15 * MINUTE))

    def test_failed_readings_back_off_then_stop_waking(self):
        self.plan.start(None, 0)
        self.assertEqual(self.plan.after_wake(None, 15 * MINUTE), ('sleep', 30 * MINUTE))
        self.assertEqual(self.plan.after_wake(None, 45 * MINUTE), ('sleep', HOUR))
        self.assertEqual(self.plan.after_wake(None, 2 * HOUR), ('sleep', None))

    def test_a_good_reading_clears_the_failure_count(self):
        self.plan.start(battery(50), 0)
        self.plan.after_wake(None, HOUR)
        self.plan.after_wake(None, 2 * HOUR)
        self.plan.after_wake(battery(49), 3 * HOUR)
        self.assertEqual(self.plan.after_wake(None, 4 * HOUR)[1], 30 * MINUTE)

    def test_sagging_voltage_powers_off_whatever_the_counter_says(self):
        self.plan.start(battery(60), 0)
        self.assertEqual(self.plan.after_wake(battery(55, critical=True), HOUR), ('poweroff', None))

    def test_wakes_stay_bounded_all_the_way_to_empty(self):
        self.plan.start(battery(100), 0)
        now, level, wakes = 0, 100.0, 0
        for _ in range(10000):
            action, seconds = self.plan.after_wake(battery(level), now)
            if action == 'poweroff':
                break
            wakes += 1
            now += seconds
            level -= seconds / HOUR * 0.5
        self.assertEqual(action, 'poweroff')
        self.assertLessEqual(now / wakes, 12 * HOUR)
        self.assertGreaterEqual(now / wakes, 15 * MINUTE)
        self.assertLess(wakes, 60)


class ReadBatteryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def supply(self, name, **values):
        folder = self.root / name
        folder.mkdir(exist_ok=True)
        for key, value in values.items():
            (folder / key).write_text(f'{value}\n')

    def test_uses_the_charge_counter_because_capacity_is_coarse(self):
        self.supply('battery', capacity=50, charge_now=1234567, charge_full=2500000, status='Discharging')
        self.assertAlmostEqual(power.read_battery(self.root).percent, 49.38, places=2)

    def test_falls_back_to_capacity(self):
        self.supply('battery', capacity=50, status='Discharging')
        self.assertEqual(power.read_battery(self.root).percent, 50)

    def test_no_reading_is_none_not_zero(self):
        self.supply('battery', status='Discharging')
        self.assertIsNone(power.read_battery(self.root))

    def test_charger_online_means_external_power(self):
        self.supply('battery', capacity=50, status='Discharging')
        self.supply('charger', online=1, type='USB')
        self.assertTrue(power.read_battery(self.root).external)
        self.supply('charger', online=0)
        self.assertFalse(power.read_battery(self.root).external)

    def test_a_game_controller_with_its_own_battery_is_not_a_charger(self):
        self.supply('battery', capacity=50, status='Discharging')
        self.supply('ps-controller-battery', online=1, capacity=80)
        self.assertFalse(power.read_battery(self.root).external)

    def test_charging_or_full_status_counts_even_without_a_charger_file(self):
        self.supply('battery', capacity=100, status='Full')
        self.assertTrue(power.read_battery(self.root).external)

    def test_voltage_at_the_design_floor_is_critical(self):
        self.supply('battery', capacity=30, status='Discharging', voltage_avg=3400000, voltage_min_design=3400000)
        self.assertTrue(power.read_battery(self.root).critical)
        self.supply('battery', voltage_avg=3700000)
        self.assertFalse(power.read_battery(self.root).critical)


class Settings(unittest.TestCase):
    def test_a_bad_file_cannot_change_or_stop_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / power.SETTINGS_FILE
            self.assertEqual(power.load_settings(directory), power.DEFAULTS)
            path.write_text('not json')
            self.assertEqual(power.load_settings(directory), power.DEFAULTS)
            path.write_text(json.dumps({'idle_seconds': 'soon', 'other': 1, 'sleep_on_external_power': 1, 'low_percent': True}))
            self.assertEqual(power.load_settings(directory), power.DEFAULTS)
            path.write_text(json.dumps({'idle_seconds': 60, 'sleep_on_external_power': True, 'low_percent': 15}))
            loaded = power.load_settings(directory)
            self.assertEqual((loaded['idle_seconds'], loaded['sleep_on_external_power'], loaded['low_percent']), (60, True, 15))


class FakeHost:
    def __init__(self, reading=None):
        self.clock = 1000.0
        self.slept = 0.0
        self.calls = []
        self.reading = reading or battery(80)
        self.alarm = None
        self.alarm_works = True
        self.dark_works = True
        self.suspend_works = True
        self.allowed = True
        self.counts = {'power': 0, 'alarm': 0}
        self.lit, self.frozen, self.delay, self.blocked = True, False, False, False

    def now(self): return self.clock + self.slept
    def monotonic(self): return self.clock
    def take_delay_lock(self): self.delay = True
    def release_delay_lock(self): self.delay = False; self.calls.append('release')
    def block_power_key(self): self.blocked = True
    def unblock_power_key(self): self.blocked = False
    def go_dark(self): self.lit = False; self.calls.append('dark'); return self.dark_works
    def light_up(self): self.lit = True; self.calls.append('lit')
    def freeze(self): self.frozen = True; self.calls.append('freeze')
    def thaw(self): self.frozen = False; self.calls.append('thaw')
    def battery(self): return self.reading
    def wake_counts(self): return dict(self.counts) if self.counts else None
    def set_alarm(self, seconds):
        self.alarm = seconds if self.alarm_works else None
        return self.alarm_works
    def clear_alarm(self): self.alarm = None
    def request_suspend(self): self.calls.append('suspend'); return self.suspend_works
    def poweroff(self): self.calls.append('poweroff')
    def idle_allowed(self): return self.allowed
    def recover_from_crash(self): pass


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost()
        self.hub = power.EventHub()
        self.logged = []
        self.controller = power.Controller(self.host, self.hub, dict(SETTINGS), self.logged.append)

    def events(self):
        return [(e['type'], e['detail']['reason']) for e in self.hub.events]

    def sleep_now(self):
        self.controller.prepare_for_sleep()

    def alarm_fires(self):
        self.host.slept += self.host.alarm
        self.host.counts['alarm'] += 1
        self.controller.resumed()

    def test_sleep_goes_dark_tells_the_game_then_freezes_then_releases(self):
        self.sleep_now()
        self.assertFalse(self.host.lit)
        self.assertTrue(self.host.frozen)
        self.assertTrue(self.host.blocked)
        self.assertEqual(self.host.calls, ['dark', 'freeze', 'release'])
        self.assertEqual(self.host.alarm, 15 * MINUTE)
        self.assertEqual(self.events(), [('sleep', 'system')])
        self.assertEqual(self.controller.state, power.ASLEEP)

    def test_game_gets_the_window_only_while_a_host_server_listens(self):
        seen = []
        with patch.object(self.hub, 'wait_ack', side_effect=lambda seq, timeout: seen.append(timeout)):
            self.sleep_now()
        self.assertEqual(seen, [SETTINGS['event_window_seconds']])

    def test_a_press_is_reported_as_the_reason(self):
        self.controller.power_pressed()
        self.sleep_now()
        self.assertEqual(self.events(), [('sleep', 'button')])

    def test_alarm_wake_measures_in_the_dark_and_goes_back_to_sleep(self):
        self.sleep_now()
        self.host.reading = battery(79)
        calls = len(self.host.calls)
        self.alarm_fires()
        self.assertEqual(self.controller.state, power.DARK)
        self.assertFalse(self.host.lit)
        self.assertTrue(self.host.frozen)
        self.assertEqual(self.host.calls[calls:], ['suspend'])
        self.assertEqual(self.events(), [('sleep', 'system')], 'a measurement wake tells the game nothing')
        self.controller.prepare_for_sleep()
        self.assertEqual(self.controller.state, power.ASLEEP)
        self.assertEqual(self.host.alarm, 12 * HOUR)
        self.assertFalse(self.host.delay, 'logind must not wait out the whole delay')
        self.assertEqual(self.host.calls.count('dark'), 1)

    def test_a_person_waking_it_lights_up_and_tells_the_game(self):
        self.sleep_now()
        self.host.slept += HOUR / 12
        self.host.counts['power'] += 2
        self.controller.resumed()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)
        self.assertFalse(self.host.frozen)
        self.assertIsNone(self.host.alarm)
        self.assertEqual(self.events()[-1][0], 'wake')
        self.assertTrue(self.host.delay)

    def test_doubt_always_means_a_person(self):
        cases = {
            'too early': lambda h: (setattr(h, 'slept', h.slept + 60), h.counts.__setitem__('alarm', h.counts['alarm'] + 1)),
            'alarm did not count': lambda h: setattr(h, 'slept', h.slept + 15 * MINUTE),
            'key counted too': lambda h: (setattr(h, 'slept', h.slept + 15 * MINUTE), h.counts.__setitem__('alarm', 1), h.counts.__setitem__('power', 1)),
            'counts unreadable': lambda h: (setattr(h, 'slept', h.slept + 15 * MINUTE), setattr(h, 'counts', None)),
        }
        for name, happen in cases.items():
            with self.subTest(name):
                self.setUp()
                self.sleep_now()
                happen(self.host)
                self.controller.resumed()
                self.assertEqual(self.controller.state, power.AWAKE)
                self.assertTrue(self.host.lit)

    def test_a_press_the_input_watcher_saw_beats_a_due_alarm(self):
        self.sleep_now()
        self.controller.power_pressed()
        self.alarm_fires()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertEqual(self.events()[-1], ('wake', 'button'))

    def test_a_press_during_a_dark_wake_lights_up_at_once(self):
        self.sleep_now()
        self.alarm_fires()
        self.controller.power_pressed()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)
        self.assertFalse(self.host.frozen)

    def test_low_battery_powers_off_without_lighting_up(self):
        self.sleep_now()
        self.host.reading = battery(9)
        self.alarm_fires()
        self.assertEqual(self.controller.state, power.OFF)
        self.assertIn('poweroff', self.host.calls)
        self.assertFalse(self.host.lit)
        self.assertIsNone(self.host.alarm, 'an armed alarm could power it back on')
        self.assertFalse(self.host.frozen, 'the session has to be able to stop cleanly')

    def test_a_poweroff_that_never_happens_ends_lit(self):
        self.sleep_now()
        self.host.reading = battery(9)
        self.alarm_fires()
        self.host.clock += power.POWEROFF_TIMEOUT + 1
        self.controller.tick()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)

    def test_on_external_power_it_never_powers_off(self):
        self.host.reading = battery(2, external=True)
        self.sleep_now()
        self.assertEqual(self.host.alarm, HOUR)
        self.alarm_fires()
        self.assertNotIn('poweroff', self.host.calls)
        self.assertEqual(self.controller.state, power.DARK)

    def test_no_alarm_means_a_plain_sleep_with_no_dark_wakes(self):
        self.host.alarm_works = False
        self.sleep_now()
        self.assertIsNone(self.controller.planned)
        self.host.slept += HOUR
        self.host.counts['alarm'] += 1
        self.controller.resumed()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)

    def test_if_the_display_cannot_go_off_it_never_wakes_itself(self):
        self.host.dark_works = False
        self.sleep_now()
        self.assertIsNone(self.host.alarm)
        self.assertIsNone(self.controller.planned)

    def test_failed_readings_stop_the_wakes(self):
        self.host.reading = None
        self.sleep_now()
        for _ in range(2):
            self.alarm_fires()
            self.controller.prepare_for_sleep()
            self.assertIsNotNone(self.host.alarm)
        self.alarm_fires()
        self.controller.prepare_for_sleep()
        self.assertIsNone(self.host.alarm)

    def test_a_suspend_that_is_refused_during_a_dark_wake_ends_lit(self):
        self.sleep_now()
        self.host.suspend_works = False
        self.alarm_fires()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)

    def test_a_suspend_that_never_starts_ends_lit(self):
        self.sleep_now()
        self.alarm_fires()
        self.host.clock += power.SUSPEND_START_TIMEOUT + 1
        self.controller.tick()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)

    def test_a_missing_resume_signal_ends_lit(self):
        self.sleep_now()
        self.host.clock += power.RESUME_TIMEOUT + 1
        self.controller.tick()
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertTrue(self.host.lit)
        self.assertTrue(self.host.delay)

    def test_a_failed_suspend_cannot_loop(self):
        self.sleep_now()
        self.controller.resumed()   # logind reports the failure straight away.
        self.assertEqual(self.controller.state, power.AWAKE)
        self.assertEqual(self.host.calls.count('suspend'), 0)

    def test_power_key_stays_blocked_until_just_after_waking(self):
        self.sleep_now()
        self.host.counts['power'] += 1
        self.host.slept += 60
        self.controller.resumed()
        self.assertTrue(self.host.blocked)
        self.host.clock += power.POWER_KEY_GRACE + .1
        self.controller.tick()
        self.assertFalse(self.host.blocked)

    # Idle timer. The fake reports external power only when told to.
    def idle(self, seconds):
        self.host.clock += seconds
        self.controller.tick()

    def test_idle_timer_asks_for_sleep_after_10_minutes(self):
        self.idle(599)
        self.assertNotIn('suspend', self.host.calls)
        self.idle(2)
        self.assertEqual(self.host.calls, ['suspend'])
        self.controller.prepare_for_sleep()
        self.assertEqual(self.events(), [('sleep', 'idle')])

    def test_input_restarts_the_idle_timer(self):
        self.idle(590)
        self.controller.input_activity()
        self.idle(590)
        self.assertNotIn('suspend', self.host.calls)

    def test_idle_waits_for_busy_work_then_sleeps(self):
        self.host.allowed = False
        self.idle(700)
        self.assertNotIn('suspend', self.host.calls)
        self.host.allowed = True
        self.idle(power.BUSY_RETRY + 1)
        self.assertEqual(self.host.calls, ['suspend'])

    def test_idle_does_not_repeat_while_a_request_is_in_flight(self):
        self.idle(601)
        self.idle(1)
        self.idle(1)
        self.assertEqual(self.host.calls.count('suspend'), 1)

    def test_idle_starts_over_if_a_request_goes_nowhere(self):
        self.idle(601)
        self.idle(power.SUSPEND_START_TIMEOUT + 1)
        self.assertEqual(self.host.calls.count('suspend'), 1)
        self.idle(100)
        self.assertEqual(self.host.calls.count('suspend'), 1)

    def test_on_external_power_idle_never_sleeps_and_restarts_on_unplug(self):
        self.host.reading = battery(50, external=True)
        self.idle(3 * HOUR)
        self.assertNotIn('suspend', self.host.calls)
        self.host.reading = battery(50)
        self.idle(power.EXTERNAL_CHECK)
        self.assertNotIn('suspend', self.host.calls)
        self.idle(601)
        self.assertEqual(self.host.calls, ['suspend'])

    def test_the_fuel_gauge_is_not_read_every_tick(self):
        reads = []
        real = self.host.battery
        self.host.battery = lambda: reads.append(1) or real()
        for _ in range(20):
            self.idle(1)
        self.assertLessEqual(len(reads), 5)

    def test_the_external_power_rule_can_be_turned_off(self):
        self.controller.settings['sleep_on_external_power'] = True
        self.host.reading = battery(50, external=True)
        self.idle(601)
        self.assertEqual(self.host.calls, ['suspend'])

    def test_waking_restarts_the_idle_timer(self):
        self.sleep_now()
        self.host.counts['power'] += 1
        self.host.clock += 700
        self.controller.resumed()
        self.idle(500)
        self.assertNotIn('suspend', self.host.calls)


class EventHubTests(unittest.TestCase):
    def test_negative_after_only_learns_the_position(self):
        hub = power.EventHub()
        hub.publish('sleep', {})
        self.assertEqual(hub.wait(-1, 0), {'seq': 1, 'events': []})

    def test_wait_returns_only_newer_events(self):
        hub = power.EventHub()
        hub.publish('sleep', {'reason': 'idle'})
        hub.publish('wake', {'reason': 'other'})
        self.assertEqual([e['type'] for e in hub.wait(1, 0)['events']], ['wake'])

    def test_wait_wakes_as_soon_as_something_is_published(self):
        hub = power.EventHub()
        threading.Timer(.05, hub.publish, ('sleep', {})).start()
        started = time.monotonic()
        self.assertEqual(hub.wait(0, 5)['seq'], 1)
        self.assertLess(time.monotonic() - started, 2)

    def test_no_listening_server_means_no_wait(self):
        hub = power.EventHub()
        started = time.monotonic()
        self.assertFalse(hub.wait_ack(hub.publish('sleep', {}), 5))
        self.assertLess(time.monotonic() - started, 1)

    def test_a_listening_server_gets_the_window_and_it_is_bounded(self):
        hub = power.EventHub()
        hub.wait(-1, 0)
        started = time.monotonic()
        self.assertFalse(hub.wait_ack(hub.publish('sleep', {}), .2))
        self.assertGreaterEqual(time.monotonic() - started, .2)
        self.assertLess(time.monotonic() - started, 1)

    def test_ack_ends_the_window_early(self):
        hub = power.EventHub()
        hub.wait(-1, 0)
        seq = hub.publish('sleep', {})
        threading.Timer(.05, hub.ack, (seq,)).start()
        started = time.monotonic()
        self.assertTrue(hub.wait_ack(seq, 5))
        self.assertLess(time.monotonic() - started, 2)

    def test_dispatch_rejects_nonsense(self):
        hub = power.EventHub()
        for request in [{'action': 'system-wait', 'after': 'x', 'timeout': 1}, {'action': 'system-wait', 'after': 0, 'timeout': 99},
                        {'action': 'system-ack', 'seq': 'x'}, {'action': 'system-nope'}]:
            with self.subTest(request), self.assertRaises(ValueError):
                hub.dispatch(request)


class InputWatcherTests(unittest.TestCase):
    def watcher(self):
        self.activity, self.power = [], []
        return power.InputWatcher(lambda: self.activity.append(1), lambda: self.power.append(1))

    def test_a_press_counts_but_a_release_or_repeat_does_not(self):
        w = self.watcher()
        w.handle('d', None, power.EV_KEY, 304, 0)
        w.handle('d', None, power.EV_KEY, 304, 2)
        self.assertEqual(self.activity, [])
        w.handle('d', None, power.EV_KEY, 304, 1)
        self.assertEqual(self.activity, [1])

    def test_power_key_is_reported_separately(self):
        w = self.watcher()
        w.handle('d', None, power.EV_KEY, power.KEY_POWER, 1)
        self.assertEqual((self.activity, self.power), ([1], [1]))

    def test_stick_jitter_does_not_keep_it_awake_but_a_real_move_does(self):
        w = self.watcher()
        with patch.object(power.InputWatcher, 'axis_range', return_value=1000):
            for value in (500, 505, 495, 510, 498):
                w.handle('stick', 1, power.EV_ABS, 0, value)
            self.assertEqual(self.activity, [])
            w.handle('stick', 1, power.EV_ABS, 0, 900)
            self.assertEqual(self.activity, [1])

    def test_a_dpad_hat_counts(self):
        w = self.watcher()
        with patch.object(power.InputWatcher, 'axis_range', return_value=2):
            w.handle('pad', 1, power.EV_ABS, 16, 0)
            w.handle('pad', 1, power.EV_ABS, 16, 1)
        self.assertEqual(self.activity, [1])

    def test_motion_sensors_are_never_opened(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'input').mkdir()
            for event, name in [('event0', 'Pad Motion Sensors'), ('event1', 'pwm-vibrator'), ('event2', 'Pad')]:
                (root / 'input' / event).write_text('')
                (root / 'sys' / event / 'device').mkdir(parents=True)
                (root / 'sys' / event / 'device/name').write_text(name)
            w = power.InputWatcher(lambda: None, lambda: None, str(root / 'input'), str(root / 'sys'))
            w.rescan()
            self.addCleanup(lambda: [w.drop(p) for p in list(w.devices)])
            self.assertEqual([Path(p).name for p in w.devices], ['event2'])


class SignalParsingTests(unittest.TestCase):
    def test_reads_dbus_monitor_text(self):
        lines = ['signal time=1 sender=org.freedesktop.DBus -> destination=:1.33 member=NameAcquired', '   string ":1.33"',
                 'signal time=2 sender=:1.3 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep', '   boolean true',
                 'signal time=3 sender=:1.3 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep', '   boolean false']
        self.assertEqual(list(power.parse_sleep_signals(lines)), [True, False])


class DeliveryTests(unittest.TestCase):
    def test_the_controller_ships_in_the_device_bundle_for_both_layouts(self):
        from rocknix import update_release
        entries = [n for n, _ in update_release.device_entries(ROOT)]
        self.assertIn('runtime/native/rg353v/device/power.py', entries)
        from rocknix.updates import app_path
        self.assertEqual(app_path('runtime/native/rg353v/device/power.py'), 'runtime/native/rg353v/device/power.py')

    def test_network_helper_starts_and_routes_it(self):
        from rocknix import network
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 's'
            with network.HostServer(str(path), network.HostHandler) as server:
                server.allowed_uid = __import__('os').geteuid()
                server.manager = network.Onboarding(network.Simulation(), directory)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                self.addCleanup(server.shutdown)
                client = network.HostClient(str(path))
                with self.assertRaises(network.NetworkError):
                    client.dispatch({'action': 'system-wait', 'after': -1, 'timeout': 0})
                server.events = power.EventHub()
                server.events.publish('sleep', {'reason': 'idle'})
                self.assertEqual(client.dispatch({'action': 'system-wait', 'after': -1, 'timeout': 0})['seq'], 1)
                self.assertEqual(client.dispatch({'action': 'system-ack', 'seq': 1}), {'accepted': True})
                self.assertEqual(server.events.acked, 1)
                with self.assertRaises(network.NetworkError):
                    client.dispatch({'action': 'system-ack', 'seq': 'x'})


if __name__ == '__main__':
    unittest.main()
