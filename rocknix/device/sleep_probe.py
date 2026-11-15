#!/usr/bin/env python3
"""Opt-in native sleep probe. Run detached from SSH; never proves switch actuation."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import struct
import subprocess
import time

KEY_POWER = 116
SETTINGS = dict(idle_seconds=987, first_wake_seconds=15,
                external_wake_seconds=15, max_wake_seconds=30)
ENV = dict(os.environ, LC_ALL='C', XDG_RUNTIME_DIR='/run/0-runtime-dir',
           SWAYSOCK='/run/0-runtime-dir/sway-ipc.0.sock')


def select_power(rows):
    matches = [row for row in rows if row['key'] & (1 << KEY_POWER)
               and re.search(r'(?:pwrkey|power)', row['name']+' '+row['phys'], re.I)]
    if len(matches) != 1:
        raise ValueError('exactly_one_power_capable_input_required')
    return matches[0]


@contextmanager
def temporary_settings(path):
    """Exclusive creation, never overwrite existing settings or remove changed state."""
    if any(parent.is_symlink() for parent in path.parents):
        raise ValueError('symlinked_settings_parent')
    payload = json.dumps(SETTINGS, sort_keys=True).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    owned = os.fstat(fd)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload); stream.flush(); os.fsync(stream.fileno())
        yield
    finally:
        current = path.lstat()
        if ((current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino)
                or not stat.S_ISREG(current.st_mode) or path.read_bytes() != payload):
            raise ValueError('probe_settings_changed_preserved')
        path.unlink()


class NativeHost:
    def __init__(self):
        self.settings = Path('/storage/cubby/state/power.json')
        self.log = self.settings.with_name('power.log')
        self.alarm = Path('/sys/class/rtc/rtc0/wakealarm')
        self.fd = None

    def command(self, *args):
        return subprocess.check_output(args, text=True, env=ENV, timeout=8).strip()

    def preflight(self):
        if os.geteuid() != 0 or 'ROCKNIX' not in Path('/etc/os-release').read_text():
            raise ValueError('native_rocknix_root_required')
        if self.settings.exists() or self.settings.is_symlink():
            raise FileExistsError('existing_power_settings_preserved')
        if '[deep]' not in Path('/sys/power/mem_sleep').read_text():
            raise ValueError('deep_suspend_required')
        if self.alarm.read_text().strip():
            raise ValueError('existing_rtc_alarm_preserved')
        with self.alarm.open('r+'):
            pass  # Check access without arming or clearing someone else's alarm.
        rows = []
        for event in Path('/sys/class/input').glob('event*'):
            device = event/'device'
            keys = device/'capabilities/key'
            if not keys.exists(): continue
            # Kernel prints machine-word-sized groups, most significant first.
            key = int(''.join(word.zfill(struct.calcsize('L')*2)
                              for word in keys.read_text().split()), 16)
            rows.append(dict(event=event.name, name=(device/'name').read_text().strip(),
                             phys=(device/'phys').read_text().strip(), key=key))
        selected = select_power(rows)
        path = Path('/dev/input')/selected['event']
        self.fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        if not stat.S_ISCHR(os.fstat(self.fd).st_mode):
            raise ValueError('power_input_not_character_device')
        bits = bytearray(96)
        fcntl.ioctl(self.fd, 0x80000000 | (len(bits) << 16) | (ord('E') << 8) | 0x21, bits)
        if not bits[KEY_POWER//8] & (1 << (KEY_POWER % 8)):
            raise ValueError('opened_input_lacks_power_key')
        status = self.status()
        if not all(status.values()): raise ValueError('awake_display_audio_cog_required')
        return dict(input={key: selected[key] for key in ('event','name','phys')}, awake=status)

    def status(self):
        outputs = json.loads(self.command('swaymsg', '-t', 'get_outputs', '-r'))
        return dict(display_on=any(row.get('active') and row.get('power') is True for row in outputs),
                    unmuted=self.command('pactl', 'get-sink-mute', '@DEFAULT_SINK@') == 'Mute: no',
                    cog=bool(self.command('pgrep', '-x', 'cog')))

    def restart(self):
        before = self.log.read_text() if self.log.exists() else ''
        self.command('systemctl', 'restart', 'essway.service')
        idle = SETTINGS['idle_seconds'] if self.settings.exists() else 600
        deadline = time.monotonic()+35
        while time.monotonic() < deadline:
            text = self.log.read_text() if self.log.exists() else ''
            fresh = text[len(before):] if text.startswith(before) else text
            if f'started idle={idle}s' in fresh:
                try:
                    if all(self.status().values()): return
                except (OSError, ValueError, subprocess.SubprocessError): pass
            time.sleep(.25)
        raise TimeoutError('power_helper_restart_not_verified')

    def arm_probe(self):
        """Prove the RTC accepts an alarm before any suspend; leave it cleared."""
        if self.alarm.read_text().strip(): raise ValueError('existing_rtc_alarm_preserved')
        try:
            self.alarm.write_text('+15')
            if not self.alarm.read_text().strip(): raise ValueError('rtc_alarm_not_armed')
        finally:
            self.alarm.write_text('0')

    def key(self):
        for value in (1, 0):
            os.write(self.fd, struct.pack('llHHi', 0, 0, 1, KEY_POWER, value)
                     + struct.pack('llHHi', 0, 0, 0, 0, 0))
            time.sleep(.05)

    def suspend_and_wake(self, timeout):
        start_boot = time.clock_gettime(time.CLOCK_BOOTTIME)
        start_mono = time.monotonic()
        self.command('systemctl', 'suspend', '--no-block')
        injected = False
        while time.clock_gettime(time.CLOCK_BOOTTIME)-start_boot < timeout:
            suspended = ((time.clock_gettime(time.CLOCK_BOOTTIME)-start_boot)
                         - (time.monotonic()-start_mono))
            if suspended > 3 and not injected:
                self.key(); injected = True  # Already-open verified kernel input, no SSH dependency.
            if injected and not Path('/run/cubby-power-dark').exists():
                try:
                    if all(self.status().values()): return suspended
                except (OSError, ValueError, subprocess.SubprocessError): pass
            time.sleep(.1)
        raise TimeoutError('suspend_or_lit_wake_not_verified')

    def close(self):
        if self.fd is not None:
            os.close(self.fd); self.fd = None


def run_probe(host, timeout=90):
    created = False
    try:
        preflight = host.preflight()
        host.arm_probe()
        with temporary_settings(host.settings):
            created = True
            host.restart()
            before = host.log.read_text()
            suspended = host.suspend_and_wake(timeout)
            text = host.log.read_text()
            fresh = text[len(before):] if text.startswith(before) else text
            awake = host.status()
            if (suspended <= 3 or 'wake reason=' not in fresh
                    or 'audio/display restored muted=False' not in fresh
                    or not all(awake.values())):
                raise ValueError('fresh_suspend_and_restore_evidence_required')
            result = dict(passed=True, physical_switch_verified=False,
                          suspended_seconds=suspended, preflight=preflight,
                          awake=awake, power_log=fresh)
        return result
    finally:
        try:
            # Never restart on preflight failure or over somebody else's replacement.
            if created and not host.settings.exists() and not host.settings.is_symlink():
                host.restart()
        finally:
            host.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight','run'])
    args=parser.parse_args()
    host=NativeHost()
    def interrupted(signum, frame): raise InterruptedError('probe_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        if args.action == 'preflight':
            try: result=host.preflight()
            finally: host.close()
        else: result=run_probe(host)
        print(json.dumps(result, indent=2), flush=True)
    except Exception as error:
        print(json.dumps(dict(passed=False, physical_switch_verified=False,
                              error=str(error))), flush=True)
        raise SystemExit(1)


if __name__ == '__main__': main()
