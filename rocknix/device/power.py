#!/usr/bin/python3
"""Handheld sleep: an idle timer, telling games, and powering off before the battery dies.

ROCKNIX owns suspend itself. This watches logind, so every route into sleep (power
button, idle timer, anything else) goes through one path. It holds logind's delay lock
to get a few seconds before each sleep, and treats resume as a question: did a person
wake this, or did our own alarm? Our alarm wakes must stay dark, so the display is
powered off through Sway first. The backlight alone is not enough: the panel driver
turns it back on during kernel resume.

Any doubt about a wake means a person woke it. Stdlib only; network.py starts this
outside the chroot. See docs/rg353v-power.md.
"""
from __future__ import annotations
import array
import fcntl
import glob
import json
import os
from pathlib import Path
import queue
import select
import signal
import struct
import subprocess
import threading
import time
import urllib.request

DEFAULTS = {
    'idle_seconds': 10 * 60,
    'sleep_on_external_power': False,
    'first_wake_seconds': 15 * 60,
    'low_percent': 10.0,
    'max_wake_seconds': 12 * 60 * 60,
    'external_wake_seconds': 60 * 60,
    'event_window_seconds': 2.0,
    'power_supply_dir': '/sys/class/power_supply',
    'poweroff_dry_run': False,
}
SETTINGS_FILE = 'power.json'
LOG_FILE = 'power.log'
LOG_LIMIT = 64 * 1024
MIN_DROP_PERCENT = 0.05
MAX_READ_FAILURES = 3
WAKE_EARLY_TOLERANCE = 10
SUSPEND_START_TIMEOUT = 15
RESUME_TIMEOUT = 30
POWEROFF_TIMEOUT = 60
POWER_KEY_GRACE = 2
BUSY_RETRY = 5
INPUT_RESCAN = 5
RUNTIME_DIR = '/run/0-runtime-dir'
MARKER = '/run/cubby-power-dark'
FROZEN = ('cog', 'WPEWebProcess', 'WPENetworkProce', 'WPEGPUProcess')
IGNORED_INPUT = ('Motion Sensors', 'vibrator', 'Headphones', 'Headset Jack')
EV_KEY, EV_ABS = 1, 3
KEY_POWER = 116
AXIS_ACTIVITY = 0.2


def load_settings(state_dir):
    """Defaults, plus only known keys of the right type, so a bad file can't stop sleep."""
    settings = dict(DEFAULTS)
    try:
        saved = json.loads((Path(state_dir) / SETTINGS_FILE).read_text())
    except (OSError, ValueError):
        return settings
    if isinstance(saved, dict):
        for key, value in saved.items():
            default = DEFAULTS.get(key)
            kinds = (int, float) if isinstance(default, (int, float)) and not isinstance(default, bool) else type(default)
            if key in DEFAULTS and isinstance(value, kinds) and (kinds is bool or not isinstance(value, bool)):
                settings[key] = value
    return settings


def read_number(path):
    try:
        return float(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None


class Reading:
    def __init__(self, percent, external, critical=False):
        self.percent, self.external, self.critical = percent, external, critical

    def __repr__(self):
        return f'{self.percent:.2f}% external={self.external} critical={self.critical}'


def read_battery(supply_dir):
    """Charge counter when there is one, because capacity moves in whole percents."""
    root = Path(supply_dir)
    battery = root / 'battery'
    now, full = read_number(battery / 'charge_now'), read_number(battery / 'charge_full')
    percent = now * 100 / full if now is not None and full else read_number(battery / 'capacity')
    if percent is None:
        return None
    try:
        status = (battery / 'status').read_text().strip()
    except OSError:
        status = ''
    external = status in ('Charging', 'Full')
    for supply in root.iterdir() if root.is_dir() else ():
        if supply.name != 'battery' and read_number(supply / 'online') == 1 and not (supply / 'capacity').exists():
            external = True
    voltage, floor = read_number(battery / 'voltage_avg'), read_number(battery / 'voltage_min_design')
    # The counter can drift while asleep; a sagging cell is true whatever it says.
    critical = bool(voltage and floor and voltage <= floor)
    return Reading(max(0.0, min(100.0, percent)), external, critical)


class DrainPlan:
    """How long to sleep next. Times are seconds on any clock that counts sleep."""
    def __init__(self, settings):
        self.settings = settings
        self.baseline = None
        self.interval = settings['first_wake_seconds']
        self.failures = 0

    def start(self, reading, now):
        self.baseline = (now, reading.percent) if reading and not reading.external else None
        if reading and reading.external:
            return self.settings['external_wake_seconds']
        return self.settings['first_wake_seconds']

    def after_wake(self, reading, now):
        """('poweroff', None), or ('sleep', seconds), or ('sleep', None) to stop waking at all."""
        settings = self.settings
        if reading is None:
            self.failures += 1
            if self.failures >= MAX_READ_FAILURES:
                return 'sleep', None   # Blind wakes would only drain it. Sleep like stock.
            self.interval = min(self.interval * 2, settings['max_wake_seconds'])
            return 'sleep', self.interval
        self.failures = 0
        if reading.external:
            self.baseline, self.interval = None, settings['first_wake_seconds']
            return 'sleep', settings['external_wake_seconds']
        if reading.critical or reading.percent <= settings['low_percent']:
            return 'poweroff', None
        if self.baseline is None or reading.percent > self.baseline[1]:
            self.baseline, self.interval = (now, reading.percent), settings['first_wake_seconds']
            return 'sleep', self.interval
        started, level = self.baseline
        drop = level - reading.percent
        if drop < MIN_DROP_PERCENT or now <= started:
            # Too small to measure yet. Keep the baseline, so the next read spans more time.
            self.interval = min(self.interval * 2, settings['max_wake_seconds'])
            return 'sleep', self.interval
        remaining = (reading.percent - settings['low_percent']) * (now - started) / drop
        self.baseline, self.interval = (now, reading.percent), settings['first_wake_seconds']
        return 'sleep', int(max(settings['first_wake_seconds'], min(remaining, settings['max_wake_seconds'])))


class EventHub:
    """System events for pages. server.py long-polls this over the host socket."""
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.condition = threading.Condition()
        self.seq = 0
        self.events = []
        self.acked = 0
        self.last_wait = None

    def publish(self, kind, detail):
        with self.condition:
            self.seq += 1
            self.events = (self.events + [{'seq': self.seq, 'type': kind, 'detail': detail}])[-16:]
            self.condition.notify_all()
            return self.seq

    def wait(self, after, timeout):
        """Events after `after`. A negative `after` only learns where the stream is."""
        deadline = self.clock() + timeout
        with self.condition:
            self.last_wait = self.clock()
            if after < 0:
                return {'seq': self.seq, 'events': []}
            while self.seq <= after and self.clock() < deadline:
                self.condition.wait(min(1, max(0, deadline - self.clock())))
            self.last_wait = self.clock()
            return {'seq': self.seq, 'events': [e for e in self.events if e['seq'] > after]}

    def ack(self, seq):
        with self.condition:
            self.acked = max(self.acked, seq)
            self.condition.notify_all()

    def wait_ack(self, seq, timeout):
        """True if listeners finished. Returns at once when no host server is listening."""
        deadline = self.clock() + timeout
        with self.condition:
            if self.last_wait is None or self.clock() - self.last_wait > 60:
                return False
            while self.acked < seq and self.clock() < deadline:
                self.condition.wait(min(.1, max(0, deadline - self.clock())))
            return self.acked >= seq

    def dispatch(self, request):
        action = request.get('action')
        if action == 'system-wait':
            after, timeout = request.get('after'), request.get('timeout')
            if type(after) is not int or not isinstance(timeout, (int, float)) or not 0 <= timeout <= 30:
                raise ValueError('Invalid wait')
            return self.wait(after, timeout)
        if action == 'system-ack' and type(request.get('seq')) is int:
            self.ack(request['seq'])
            return {'accepted': True}
        raise ValueError('Invalid system event request')


class Host:
    """Everything that touches the device, so the controller can be tested without one."""
    def __init__(self, settings):
        self.settings = settings
        self.delay = self.block = None
        self.frozen = []
        self.was_muted = False
        self.env = dict(os.environ, XDG_RUNTIME_DIR=RUNTIME_DIR, SWAYSOCK=RUNTIME_DIR + '/sway-ipc.0.sock')

    def run(self, *command, timeout=10):
        return subprocess.run(command, env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True, timeout=timeout, check=False)

    @staticmethod
    def now():
        return time.clock_gettime(time.CLOCK_BOOTTIME)

    @staticmethod
    def monotonic():
        return time.monotonic()

    def inhibit(self, what, mode):
        # The child reads a pipe from this process, so a crash here releases the lock.
        return subprocess.Popen(['systemd-inhibit', f'--what={what}', f'--mode={mode}', '--who=Cubby',
                                 '--why=Cubby sleep handling', 'cat'], env=self.env, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @staticmethod
    def release(process):
        if process:
            try:
                process.stdin.close()
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()

    def take_delay_lock(self):
        if not self.delay:
            self.delay = self.inhibit('sleep', 'delay')

    def release_delay_lock(self):
        self.release(self.delay)
        self.delay = None

    def block_power_key(self):
        if not self.block:
            self.block = self.inhibit('handle-power-key', 'block')

    def unblock_power_key(self):
        self.release(self.block)
        self.block = None

    def go_dark(self):
        """True when the display really is off, which is what makes a dark wake possible."""
        try:
            muted = self.run('pactl', 'get-sink-mute', '@DEFAULT_SINK@').stdout
            self.was_muted = 'yes' in muted
            Path(MARKER).write_text(json.dumps({'muted': self.was_muted}))
            self.run('pactl', 'set-sink-mute', '@DEFAULT_SINK@', 'true')
            return self.run('swaymsg', 'output * power off').returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def light_up(self):
        for command in (('swaymsg', 'output * power on'),
                        ('pactl', 'set-sink-mute', '@DEFAULT_SINK@', 'true' if self.was_muted else 'false')):
            try:
                self.run(*command)
            except (OSError, subprocess.SubprocessError):
                pass
        Path(MARKER).unlink(missing_ok=True)

    def recover_from_crash(self):
        """A previous helper died while dark. Nothing else would ever turn the screen back on."""
        try:
            saved = json.loads(Path(MARKER).read_text())
        except (OSError, ValueError):
            return
        self.was_muted = bool(saved.get('muted')) if isinstance(saved, dict) else False
        self.thaw()
        self.light_up()

    def session_pids(self):
        pids = []
        for path in glob.glob('/proc/[0-9]*/comm'):
            try:
                name = Path(path).read_text().strip()
            except OSError:
                continue
            if name in FROZEN:
                pids.append(int(path.split('/')[2]))
        return pids

    def freeze(self):
        self.frozen = self.session_pids()
        self.signal_all(self.frozen, signal.SIGSTOP)

    def thaw(self):
        self.signal_all(set(self.frozen) | set(self.session_pids()), signal.SIGCONT)
        self.frozen = []

    @staticmethod
    def signal_all(pids, number):
        for pid in pids:
            try:
                os.kill(pid, number)
            except OSError:
                pass

    def battery(self):
        return read_battery(self.settings['power_supply_dir'])

    def set_alarm(self, seconds):
        """True only if the clock took it. Relative, so a wrong wall clock doesn't matter."""
        try:
            alarm = Path('/sys/class/rtc/rtc0/wakealarm')
            alarm.write_text('0')
            alarm.write_text(f'+{int(seconds)}')
            return bool(alarm.read_text().strip())
        except OSError:
            return False

    def clear_alarm(self):
        try:
            Path('/sys/class/rtc/rtc0/wakealarm').write_text('0')
        except OSError:
            pass

    @staticmethod
    def wake_counts():
        counts = {'power': 0, 'alarm': 0}
        try:
            for line in Path('/proc/interrupts').read_text().splitlines():
                fields = line.split()
                total = sum(int(f) for f in fields[1:] if f.isdigit())
                if 'pwrkey' in line:
                    counts['power'] += total
                elif line.rstrip().endswith('RTC alarm'):
                    counts['alarm'] += total
        except OSError:
            return None
        return counts

    def request_suspend(self):
        try:
            return self.run('systemctl', 'suspend').returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def poweroff(self):
        if self.settings['poweroff_dry_run']:
            return
        self.run('systemctl', 'poweroff')

    @staticmethod
    def idle_allowed():
        """Never sleep on its own during an update, an install, or a device showing on a TV."""
        for status in glob.glob('/sys/class/drm/card*-HDMI-A-*/status'):
            try:
                if Path(status).read_text().strip() == 'connected':
                    return False
            except OSError:
                pass
        if Path('/storage/cubby/updates/pending.json').exists():
            return False
        try:
            with urllib.request.urlopen('http://127.0.0.1:8080/api/power-state', timeout=3) as response:
                return json.loads(response.read()).get('busy') is False
        except (OSError, ValueError):
            return False


AWAKE, ASLEEP, DARK, OFF = 'awake', 'asleep', 'dark', 'off'


class Controller:
    def __init__(self, host, hub, settings, log=lambda message: None):
        self.host, self.hub, self.settings, self.log = host, hub, settings, log
        self.state = AWAKE
        self.plan = DrainPlan(settings)
        self.activity = host.monotonic()
        self.press_at = None
        self.pressed_in_dark = False
        self.idle_requested = False
        self.requested_at = None
        self.asleep_at = None
        self.unblock_at = None
        self.busy_until = 0
        self.can_be_dark = False
        self.slept_at = None
        self.planned = None
        self.counts = None
        self.next_wake = None
        self.poweroff_at = None
        host.take_delay_lock()

    def input_activity(self):
        self.activity = self.host.monotonic()

    def power_pressed(self):
        self.input_activity()
        self.press_at = self.host.monotonic()
        if self.state == DARK:
            self.wake('button')
        elif self.state == ASLEEP:
            self.pressed_in_dark = True

    def prepare_for_sleep(self):
        self.requested_at = None
        if self.state == AWAKE:
            reason = 'idle' if self.idle_requested else 'button' if self.recent_press() else 'system'
            self.idle_requested = False
            self.host.block_power_key()
            self.unblock_at = None
            self.can_be_dark = self.host.go_dark()
            seq = self.hub.publish('sleep', {'reason': reason})
            self.hub.wait_ack(seq, self.settings['event_window_seconds'])
            self.host.freeze()
            self.plan = DrainPlan(self.settings)
            reading = self.host.battery()
            self.log(f'sleep reason={reason} battery={reading}')
            self.next_wake = self.plan.start(reading, self.host.now())
        elif self.state != DARK:
            return
        self.pressed_in_dark = False
        self.arm(self.next_wake if self.can_be_dark else None)
        self.host.release_delay_lock()
        self.state = ASLEEP
        self.asleep_at = self.host.monotonic()

    def recent_press(self):
        return self.press_at is not None and self.host.monotonic() - self.press_at < POWER_KEY_GRACE

    def arm(self, seconds):
        self.counts = self.host.wake_counts()
        self.slept_at = self.host.now()
        self.planned = seconds if seconds and self.counts and self.host.set_alarm(seconds) else None
        if seconds and not self.planned:
            self.log('no timed wake: alarm or interrupt counts unavailable')
        if not self.planned:
            self.host.clear_alarm()

    def our_alarm(self):
        """A dark wake needs every sign to agree. Anything else was a person, or unknown."""
        if self.planned is None or self.pressed_in_dark or not self.counts:
            return False
        if self.host.now() - self.slept_at < self.planned - WAKE_EARLY_TOLERANCE:
            return False
        counts = self.host.wake_counts()
        return bool(counts and counts['power'] == self.counts['power'] and counts['alarm'] > self.counts['alarm'])

    def resumed(self):
        self.host.take_delay_lock()
        if self.state == OFF:
            return
        if self.state == ASLEEP and self.our_alarm():
            self.measure()
        elif self.state != AWAKE:
            self.wake('button' if self.pressed_in_dark else 'other')

    def measure(self):
        reading = self.host.battery()
        action, seconds = self.plan.after_wake(reading, self.host.now())
        self.log(f'dark wake battery={reading} action={action} next={seconds}')
        if action == 'poweroff':
            self.power_off()
            return
        self.state = DARK
        self.next_wake = seconds
        self.requested_at = self.host.monotonic()
        if not self.host.request_suspend():
            self.wake('other')

    def power_off(self):
        self.state = OFF
        self.poweroff_at = self.host.monotonic()
        self.host.clear_alarm()
        # Let the session stop cleanly. The display stays off and the sink stays muted.
        self.host.thaw()
        self.log('low battery: powering off')
        self.host.poweroff()

    def wake(self, reason):
        self.state = AWAKE
        self.requested_at = self.asleep_at = self.poweroff_at = None
        self.host.clear_alarm()
        self.host.thaw()
        self.host.light_up()
        self.input_activity()
        self.unblock_at = self.host.monotonic() + POWER_KEY_GRACE
        self.log(f'wake reason={reason}')
        self.hub.publish('wake', {'reason': reason})

    def tick(self):
        now = self.host.monotonic()
        if self.unblock_at is not None and now >= self.unblock_at:
            self.unblock_at = None
            self.host.unblock_power_key()
        # Any step that stalls ends bright, never stuck dark.
        if self.state == ASLEEP and self.asleep_at is not None and now - self.asleep_at > RESUME_TIMEOUT:
            self.log('no resume signal; waking')
            self.host.take_delay_lock()
            self.wake('other')
        elif self.state == DARK and self.requested_at is not None and now - self.requested_at > SUSPEND_START_TIMEOUT:
            self.log('suspend did not start; waking')
            self.wake('other')
        elif self.state == OFF and now - self.poweroff_at > POWEROFF_TIMEOUT:
            self.log('poweroff did not happen; waking')
            self.wake('other')
        elif self.state == AWAKE:
            self.check_idle(now)

    def check_idle(self, now):
        if self.requested_at is not None:
            if now - self.requested_at <= SUSPEND_START_TIMEOUT:
                return
            self.requested_at = None
            self.idle_requested = False
            self.input_activity()
            return
        if not self.settings['sleep_on_external_power']:
            reading = self.host.battery()
            if reading and reading.external:
                self.input_activity()
                return
        if now - self.activity < self.settings['idle_seconds'] or now < self.busy_until:
            return
        if not self.host.idle_allowed():
            self.busy_until = now + BUSY_RETRY
            return
        self.log('idle: sleeping')
        self.idle_requested = True
        self.requested_at = now
        if not self.host.request_suspend():
            self.idle_requested = False
            self.requested_at = None
            self.input_activity()


class InputWatcher:
    """Real input from the kernel, below every page, so frozen game packages need nothing."""
    def __init__(self, on_activity, on_power, directory='/dev/input', names='/sys/class/input'):
        self.on_activity, self.on_power = on_activity, on_power
        self.directory, self.names = directory, names
        self.devices = {}
        self.axes = {}

    def rescan(self):
        for path in glob.glob(self.directory + '/event*'):
            if path in self.devices:
                continue
            try:
                name = Path(self.names, os.path.basename(path), 'device/name').read_text().strip()
            except OSError:
                name = ''
            if any(word in name for word in IGNORED_INPUT):
                continue
            try:
                self.devices[path] = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                pass

    def drop(self, path):
        fd = self.devices.pop(path, None)
        if fd is not None:
            os.close(fd)
        self.axes = {k: v for k, v in self.axes.items() if k[0] != path}

    @staticmethod
    def axis_range(fd, code):
        try:
            values = array.array('i', [0] * 6)
            fcntl.ioctl(fd, 0x80184540 + code, values)
            return values[2] - values[1]
        except OSError:
            return 0

    def handle(self, path, fd, kind, code, value):
        if kind == EV_KEY and value == 1:
            self.on_activity()
            if code == KEY_POWER:
                self.on_power()
        elif kind == EV_ABS:
            # Sticks jitter constantly at rest, so only a real move counts.
            span = self.axis_range(fd, code) if fd is not None else 0
            key = (path, code)
            if key not in self.axes:
                self.axes[key] = value
            elif span <= 2 or abs(value - self.axes[key]) >= span * AXIS_ACTIVITY:
                self.axes[key] = value
                self.on_activity()

    def read_ready(self, timeout):
        paths = {fd: path for path, fd in self.devices.items()}
        ready, _, _ = select.select(list(paths), [], [], timeout) if paths else ([], [], [])
        for fd in ready:
            path = paths[fd]
            try:
                data = os.read(fd, 24 * 64)
            except OSError:
                self.drop(path)
                continue
            for offset in range(0, len(data) - 23, 24):
                _, _, kind, code, value = struct.unpack_from('qqHHi', data, offset)
                self.handle(path, fd, kind, code, value)

    def run(self):
        rescan_at = 0
        while True:
            now = time.monotonic()
            if now >= rescan_at:
                self.rescan()
                rescan_at = now + INPUT_RESCAN
            if self.devices:
                self.read_ready(1)
            else:
                time.sleep(1)


def parse_sleep_signals(lines):
    """Yields True/False from dbus-monitor's text for PrepareForSleep."""
    seen = False
    for line in lines:
        if 'member=PrepareForSleep' in line:
            seen = True
        elif seen and line.strip().startswith('boolean'):
            seen = False
            yield line.strip().endswith('true')


def watch_sleep_signals(events):
    process = subprocess.Popen(['dbus-monitor', '--system', "type='signal',interface='org.freedesktop.login1.Manager',"
                                "member='PrepareForSleep'"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for going in parse_sleep_signals(process.stdout):
        events.put('prepare' if going else 'resumed')
    events.put('signals-lost')


def file_logger(state_dir):
    path = Path(state_dir) / LOG_FILE

    def log(message):
        line = f'{time.strftime("%Y-%m-%dT%H:%M:%S%z")} {message}'
        print('Cubby power:', line, flush=True)
        try:
            if path.exists() and path.stat().st_size > LOG_LIMIT:
                path.replace(path.with_suffix('.previous.log'))
            with path.open('a') as stream:
                stream.write(line + '\n')
        except OSError:
            pass
    return log


def deep_sleep_available():
    """Stock fake suspend has its own flow, and a dark wake means nothing there."""
    try:
        return '[deep]' in Path('/sys/power/mem_sleep').read_text()
    except OSError:
        return False


def run(hub, state_dir):
    """Runs for the life of the session. If anything here fails, stock ROCKNIX sleep remains."""
    settings = load_settings(state_dir)
    log = file_logger(state_dir)
    if not deep_sleep_available():
        log('deep sleep unavailable; leaving stock behaviour')
        return
    host = Host(settings)
    host.recover_from_crash()
    events = queue.Queue()
    threading.Thread(target=watch_sleep_signals, args=(events,), daemon=True).start()
    time.sleep(1)   # Let the monitor subscribe before taking the lock it serves.
    controller = Controller(host, hub, settings, log)
    watcher = InputWatcher(lambda: events.put('input'), lambda: events.put('power'))
    threading.Thread(target=watcher.run, daemon=True).start()
    log(f'started idle={settings["idle_seconds"]}s')
    handlers = {'prepare': controller.prepare_for_sleep, 'resumed': controller.resumed,
                'input': controller.input_activity, 'power': controller.power_pressed}
    while True:
        try:
            event = events.get(timeout=1)
        except queue.Empty:
            event = None
        try:
            if event == 'signals-lost':
                log('sleep signals lost; leaving stock behaviour')
                if controller.state != AWAKE:
                    controller.wake('other')
                host.release_delay_lock()
                host.unblock_power_key()
                return
            if event:
                handlers[event]()
            controller.tick()
        except Exception as error:  # A bug here must never leave the screen off.
            log(f'error: {error!r}')
            if controller.state != AWAKE:
                controller.wake('other')
