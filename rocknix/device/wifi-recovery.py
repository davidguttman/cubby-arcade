#!/usr/bin/python3
"""One bounded, model/chip-specific retry of failed early RTL8821CS probing.

Does not change credentials, USB, Bluetooth, or an existing wireless interface.
This cannot repair missing SDIO enumeration; the timing compatibility profile
is separate and still requires hardware acceptance.
"""
from pathlib import Path
import re
import subprocess
import time

REMOVE = ['modprobe', '-r', 'rtw88_8821cs', 'rtw88_8821c', 'rtw88_sdio', 'rtw88_core']
INSERT = ['modprobe', 'rtw88_8821cs']


class Recovery:
    def __init__(self, sys=Path('/sys'), model=Path('/proc/device-tree/model'),
                 state=Path('/storage/cubby/diagnostics'), *, run=subprocess.run,
                 now=time.monotonic, sleep=time.sleep):
        self.sys, self.model, self.state = Path(sys), Path(model), Path(state)
        self.run, self.now, self.sleep = run, now, sleep

    def log(self, message):
        print('Cubby Wi-Fi recovery: ' + message, flush=True)
        try:
            self.state.mkdir(parents=True, exist_ok=True)
            # One bounded per-boot record, never append an unbounded journal.
            (self.state/'wifi-recovery.txt').write_text(message+'\n')
        except OSError:
            pass

    @staticmethod
    def text(path):
        try:
            return path.read_text().strip('\0\n ')
        except OSError:
            return ''

    def chips(self):
        return [p for p in (self.sys/'bus/sdio/devices').glob('*')
                if self.text(p/'vendor')=='0x024c' and self.text(p/'device')=='0xc821']

    @staticmethod
    def has_wlan(chip):
        return any((chip/'net').glob('*'))

    def shared_stack(self, target):
        # Fail closed for another bound SDIO consumer or wireless interface.
        for chip in (self.sys/'bus/sdio/devices').glob('*'):
            if chip != target and (chip/'driver').resolve().name.startswith('rtw'):
                return True
        for net in (self.sys/'class/net').glob('*'):
            if not (net/'wireless').exists():
                continue
            if net.name not in {p.name for p in (target/'net').glob('*')}:
                return True
        return False

    def command(self, argv):
        return self.run(argv, capture_output=True, text=True, timeout=5, check=False)

    def recover(self):
        if self.text(self.model) != 'Anbernic RG353V':
            self.log('unsupported model; unchanged')
            return False
        # udev-trigger completion is not SDIO probe completion. Allow the normal
        # controller probe to finish before distinguishing absent enumeration.
        enumeration_deadline = self.now()+6
        chips = self.chips()
        while not chips and self.now() < enumeration_deadline:
            self.sleep(.5)
            chips = self.chips()
        if len(chips) != 1:
            self.log('target SDIO function absent or ambiguous; unchanged')
            return False
        chip = chips[0]
        if self.has_wlan(chip):
            self.log('wireless interface already exists; unchanged')
            return True
        deadline = self.now()+12
        while True:
            if self.has_wlan(chip):
                self.log('wireless interface appeared; unchanged')
                return True
            try:
                journal = self.command(['journalctl', '-k', '-b', '--no-pager', '-o', 'cat', '-n', '1000'])
            except (OSError, subprocess.TimeoutExpired):
                self.log('current-boot Bluetooth evidence unavailable; unchanged')
                return False
            if journal.returncode == 0 and re.search(r'Bluetooth: hci\d+: RTL: fw version 0x[0-9a-fA-F]+', journal.stdout):
                break
            if self.now() >= deadline:
                self.log('Bluetooth firmware readiness timed out; unchanged')
                return False
            self.sleep(.5)
        if self.has_wlan(chip):
            return True
        if self.shared_stack(chip):
            self.log('another wireless/rtw88 consumer exists; unchanged')
            return False
        if self.has_wlan(chip):
            return True
        removed = False
        try:
            result = self.command(REMOVE)
            removed = result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            # A failed removal can still have removed part of the dependency
            # stack. Always attempt the fixed insertion, never leave it absent.
            try:
                inserted = self.command(INSERT).returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                inserted = False
        if not removed or not inserted:
            self.log('driver retry failed; restoration attempted')
            return False
        deadline = self.now()+8
        while not self.has_wlan(chip):
            if self.now() >= deadline:
                self.log('driver retry produced no wireless interface')
                return False
            self.sleep(.5)
        self.log('wireless interface created after one driver retry')
        return True


if __name__ == '__main__':
    # Nonfatal: internet onboarding reports the remaining network fault, while
    # Cubby and USB diagnostics must still be allowed to start.
    Recovery().recover()
