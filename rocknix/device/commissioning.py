"""Narrow native commissioning actions. Invoked over pinned recovery SSH only."""
import configparser
import glob
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import uuid


class Device:
    def __init__(self, root=Path('/'), *, fixture=False):
        self.root = Path(root)
        if self.root != Path('/') and not fixture:
            raise ValueError('non_native_root')
        self.fixture = fixture
        self.expected = {}
        self.profiles = self.root/'storage/.config/NetworkManager/system-connections'

    def command(self, *args):
        if self.fixture:
            raise ValueError('fixture_command_not_mocked')
        return subprocess.run(args, check=True, capture_output=True, text=True,
                              timeout=120).stdout.strip()

    def path(self, name): return self.root/name.lstrip('/')

    def identity(self):
        if not self.fixture and ('ROCKNIX' not in Path('/etc/os-release').read_text()
                                 or os.geteuid() != 0):
            raise ValueError('native_root_required')
        image = json.loads(self.path('/storage/cubby/current/image.json').read_text())
        binding = json.loads(self.path('/storage/cubby/image-provenance/device.json').read_text())
        mounts = {row.split()[1]: row.split()[0]
                  for row in self.path('/proc/mounts').read_text().splitlines()}
        return dict(version=image['version'], commit=image['source_commit'],
                    cid=self.path('/sys/block/mmcblk0/device/cid').read_text().strip(),
                    bound_cid=binding['device_cid'], flash=mounts.get('/flash'),
                    storage=mounts.get('/storage'))

    def validate(self):
        actual = self.identity()
        if (any(actual.get(k) != self.expected.get(k) for k in ('version', 'commit', 'cid'))
                or actual.get('bound_cid') != self.expected.get('cid')
                or actual.get('flash') != '/dev/mmcblk0p1'
                or actual.get('storage') != '/dev/mmcblk0p2'):
            raise ValueError('commissioning_wrong_target')
        return actual

    def rpc(self, kind, request, *, timeout=180):
        paths = glob.glob('/run/cubby-network.*/socket') if kind == 'network' else ['/run/cubby-updater/socket']
        if len(paths) != 1: raise ValueError('ambiguous_service_socket')
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(timeout); client.connect(paths[0])
            client.sendall(json.dumps(request).encode()+b'\n')
            result = json.loads(client.makefile('r').readline(1024*1024))
        if not isinstance(result, dict) or result.get('error'):
            raise ValueError('service_action_failed')
        return result

    def profile_ids(self):
        for ancestor in (self.profiles, *self.profiles.parents):
            if ancestor == self.root: break
            if ancestor.is_symlink(): raise ValueError('unsafe_profile_directory')
        result = []
        for entry in self.profiles.glob('cubby-*.nmconnection'):
            uid = entry.name[len('cubby-'):-len('.nmconnection')]
            if not regular(entry) or str(uuid.UUID(uid)) != uid:
                raise ValueError('ambiguous_bench_profiles')
            config = configparser.ConfigParser(interpolation=None)
            config.read(entry)
            if config.get('connection', 'uuid') != uid:
                raise ValueError('profile_identity_mismatch')
            result.append(uid)
        return sorted(result)

    def snapshot(self):
        # Target identity/binding and persistent state validation are terminal.
        # Only the subsequent read-only service/presence probes can be not-ready.
        identity = self.validate()
        update = readiness_value(lambda: self.rpc('updater', {'action': 'status'}, timeout=2), {})
        splash = readiness_value(lambda: self.path('/run/cubby-splash.status').read_text(), '')
        with socket.socket() as client:
            client.settimeout(2)
            management = client.connect_ex(('169.254.170.2', 2222)) == 0
        failed = readiness_value(lambda: self.command('systemctl', '--failed', '--no-legend', '--plain'), 'unavailable')
        progress = readiness_value(lambda: self.command('systemctl', 'show', 'cubby-boot-screen.service', '-p', 'Result', '--value'), '')
        checks = dict(no_failed_units=not failed, artwork=splash.startswith('rendered 640x480 '),
                      boot_progress=progress == 'success', management=management,
                      updater=(update.get('installed') == self.expected['version']
                               and update.get('configured') is True and update.get('error') is None
                               and update.get('phase') == 'idle'
                               and not self.path('/storage/cubby/updates/pending.json').exists()),
                      controller_presence=any(
                          any(word in readiness_value(name.read_text, '').lower() for word in ('joypad','gamepad','controller'))
                          for name in self.path('/sys/class/input').glob('event*/device/name')),
                      audio_presence=bool(list(self.path('/dev/snd').glob('pcm*'))),
                      power_presence=self.path('/sys/class/power_supply/battery').exists())
        return dict(identity=identity, boot_id=self.path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                    checks=checks, profile_ids=self.profile_ids())

    def bench(self, request):
        self.validate()
        before = self.profile_ids()
        # Host checkpoint includes the baseline before connect. A crash cannot
        # quietly adopt a profile subsequently created by another actor.
        if before != request['baseline']: raise ValueError('profile_baseline_changed')
        scan = self.rpc('network', {'action':'scan'})
        choices = [row for row in scan['networks'] if row['ssid'] == request['ssid'] and row['supported']]
        if not choices: raise ValueError('bench_network_unavailable')
        entry = max(choices, key=lambda row:row['signal'])
        result = self.rpc('network', {'action':'connect', 'bssid':entry['bssid'], 'password':request['password']})
        after = self.profile_ids()
        created = sorted(set(after)-set(before))
        if len(created) != 1 or set(before)-set(after): raise ValueError('ambiguous_bench_profiles')
        enabled = self.command('rocknix-settings','--command','load','--key','wifi.enabled') == '1'
        if not result.get('internet') or not enabled: raise ValueError('bench_connection_not_persistent')
        return dict(profile_ids=created, wifi_enabled=True, internet=True)

    def wifi(self):
        self.validate()
        status = self.rpc('network', {'action':'status'})
        return dict(internet=status.get('internet') is True,
                    wifi_enabled=self.command('rocknix-settings','--command','load','--key','wifi.enabled') == '1',
                    profile_ids=self.profile_ids())

    def stop(self): self.command('systemctl','stop','essway.service')
    def start(self): self.command('systemctl','start','essway.service')

    def handoff(self, owned):
        self.validate()
        if self.path('/storage/cubby/updates/pending.json').exists():
            raise ValueError('update_trial_blocks_handoff')
        state = self.path('/storage/cubby/state')
        safe_tree(state, self.path('/storage'))
        profiles = self.profile_ids()
        if set(profiles)-set(owned): raise ValueError('unowned_cubby_profile_blocks_handoff')
        for uid in owned:
            if not isinstance(uid, str) or str(uuid.UUID(uid)) != uid: raise ValueError('invalid_profile_id')
        self.stop()
        # Recheck after process shutdown; do not follow links on either pass.
        self.validate(); safe_tree(state, self.path('/storage'))
        for uid in owned:
            path = self.profiles/f'cubby-{uid}.nmconnection'
            if path.exists():
                if not regular(path): raise ValueError('unsafe_profile')
                self.command('nmcli','connection','delete','uuid',uid)
                path.unlink(missing_ok=True)
        for entry in state.iterdir():
            if entry.is_dir(): shutil.rmtree(entry)
            else: entry.unlink()
        clean = not list(state.iterdir()) and not self.profile_ids()
        if not clean: raise ValueError('handoff_not_clean')
        os.sync()
        self.start()
        return dict(clean=True, launcher_restarted=True, removed_profile_ids=owned)


def readiness_value(probe, unavailable):
    """Expected startup absence is false readiness, not a native identity error.

    Permission, invalid data and service error replies are deliberately not
    swallowed. Call only for read-only probes, after target validation.
    """
    try: return probe()
    except (FileNotFoundError, ConnectionRefusedError, ConnectionResetError,
            TimeoutError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return unavailable


def regular(path): return stat.S_ISREG(path.lstat().st_mode)


def safe_tree(path, boundary):
    for ancestor in [path, *path.parents]:
        if ancestor == boundary.parent: break
        if ancestor.is_symlink(): raise ValueError('unsafe_state_symlink')
    if not path.is_dir(): raise ValueError('missing_state_directory')
    for entry in path.rglob('*'):
        mode = entry.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('unsafe_state_entry')


def main():
    try:
        request = json.load(sys.stdin)
        device = Device(); device.expected=request['expected']
        action=request['action']; data=request['data']
        if action == 'snapshot': result=device.snapshot()
        elif action == 'bench': result=device.bench(data)
        elif action == 'wifi': result=device.wifi()
        elif action == 'handoff': result=device.handoff(data['profile_ids'])
        elif action == 'reboot':
            device.validate(); device.command('systemctl','--no-block','reboot'); result={'reboot_requested':True}
        else: raise ValueError('invalid_action')
        print(json.dumps(result))
    except Exception:
        # Never echo request, socket errors, native command output, or credentials.
        print(json.dumps({'error':'native_commissioning_failed'})); sys.exit(1)


if __name__ == '__main__': main()
