#!/usr/bin/python3
"""Cubby boot guard: start the current release, and back out of a bad one.

This runs outside every release, so a release that cannot even start its own
coordinator still gets rolled back. It owns only the decisions a broken release
cannot make: try a new release once, then fall back through previous and
fallback, and finally stock ROCKNIX. Stdlib only, no imports from a release.
"""
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time

BASE = Path(os.environ.get('CUBBY_BASE', '/storage/cubby'))
STOCK = os.environ.get('CUBBY_STOCK', '/usr/bin/start_es.sh')
TRIAL_LIMIT = float(os.environ.get('CUBBY_TRIAL_LIMIT', 240))
RESTART = 75  # The coordinator activated or rolled back a release: start again.
FAILURES_BEFORE_DEMOTION = 2
HEALTHY_RUN = 600
RELEASE = re.compile(r'releases/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\Z')


def read_json(path):
    try:
        value = json.loads(Path(path).read_bytes())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def syncdir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write(path, data):
    temporary = path.with_name('.' + path.name + '-' + secrets.token_hex(8))
    try:
        with temporary.open('wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        syncdir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def link(target):
    temporary = BASE / ('.current-' + secrets.token_hex(8))
    try:
        temporary.symlink_to(target)
        os.replace(temporary, BASE / 'current')
        syncdir(BASE)
    finally:
        temporary.unlink(missing_ok=True)


def current():
    try:
        return os.readlink(BASE / 'current')
    except OSError:
        return None


def stock():
    """Stock ROCKNIX. Exit 0 afterwards so nothing above treats this as the guard failing."""
    try:
        process = subprocess.Popen([STOCK])
    except OSError as error:
        print('Cubby guard could not start stock ROCKNIX:', error, file=sys.stderr)
        sys.exit(0)
    def forward(signum, frame):
        process.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    process.wait()
    sys.exit(0)


def pending():
    value = read_json(BASE / 'updates/pending.json')
    if value and isinstance(value.get('old'), str) and RELEASE.fullmatch(value['old']) \
            and isinstance(value.get('token'), str) and value.get('new'):
        return value
    return None


def reject(name):
    record = read_json(BASE / 'updates/record.json') or {}
    rejected = record.get('rejected') if isinstance(record.get('rejected'), list) else []
    if name not in rejected:
        record['rejected'] = rejected + [name]
        write(BASE / 'updates/record.json', json.dumps(record, sort_keys=True).encode())


def activate_bridge():
    """Enter the trial a bridge release armed. Only here, so its old coordinator never sees it."""
    marker = BASE / 'boot/activate.json'
    if not marker.exists():
        return
    armed = read_json(marker)
    usable = (armed and isinstance(armed.get('new'), str) and RELEASE.fullmatch(armed['new'])
              and armed.get('old') == current() and (BASE / armed['new']).is_dir()
              and not (BASE / 'updates/pending.json').exists())
    if usable:
        rejected = (read_json(BASE / 'updates/record.json') or {}).get('rejected') or []
        usable = armed['new'].split('/')[-1] not in rejected
    if usable:
        # Same order as a coordinator activation: journal first, then switch.
        write(BASE / 'updates/pending.json', json.dumps(armed, sort_keys=True).encode())
        link(armed['new'])
    marker.unlink()
    syncdir(marker.parent)


def session_command():
    """A new-format release carries its coordinator; an older one uses the retained baseline."""
    release = (BASE / 'current').resolve()
    own = release / 'app/rocknix/updates.py'
    if (release / 'trust').is_dir():
        return [sys.executable, '-I', str(own), '--base', str(BASE), 'supervise']
    baseline = BASE / 'updater/coordinator.baseline.py'
    return [sys.executable, '-I', str(baseline), '--base', str(BASE), 'supervise']


def entry_works(env):
    """The trial starts the coordinator directly, so prove the path systemd takes at the next boot."""
    launcher = BASE / 'current/device/launch.sh'
    try:
        result = subprocess.run([str(launcher)], env=dict(env, CUBBY_ENTRY_PROBE='1'),
                                stdin=subprocess.DEVNULL, timeout=30, check=False)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run(command, env, trial):
    try:
        process = subprocess.Popen(command, env=env, start_new_session=True)
    except OSError:
        return 127
    def forward(signum, frame):
        stop(process)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    started = time.monotonic()
    try:
        while True:
            try:
                return process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            # The coordinator has its own shorter limit. This one catches a hung coordinator.
            if trial and (BASE / 'updates/pending.json').exists() and time.monotonic() - started > TRIAL_LIMIT:
                stop(process)
                return 124
    finally:
        stop(process)


def usable(name, tried):
    release = BASE / name
    return (RELEASE.fullmatch(name) and name not in tried and (release / 'app').is_dir()
            and (release / 'rootfs/usr/bin/python3').exists() and (release / 'device/chroot-run.sh').exists())


def demote(tried):
    """A confirmed release keeps failing: step down, permanently, until a newer update arrives."""
    name = current()
    if name:
        tried.add(name)
    # A journal nothing could finish would otherwise pull the next coordinator straight back.
    journal = read_json(BASE / 'updates/pending.json')
    if journal and isinstance(journal.get('new'), str):
        reject(journal['new'].split('/')[-1])
    (BASE / 'updates/pending.json').unlink(missing_ok=True)
    for fallback in ('previous', 'fallback'):
        try:
            target = os.readlink(BASE / fallback)
        except OSError:
            continue
        if usable(target, tried):
            if name:
                reject(name.split('/')[-1])
            link(target)
            return True
    return False


def main():
    if os.environ.get('CUBBY_ENTRY_PROBE'):
        return 0
    boot = BASE / 'boot'
    attempted = boot / 'trial-attempted'
    activate_bridge()
    failures, tried = 0, set()
    while True:
        if (BASE / 'DISABLED').exists():
            stock()
        env = dict(os.environ, CUBBY_GUARD='1')
        env.pop('CUBBY_TRIAL_ACTIVE', None)
        journal, trial = pending(), False
        if journal and current() == journal.get('new'):
            try:
                tried_token = attempted.read_text()
            except OSError:
                tried_token = None
            if tried_token == journal['token']:
                # This trial already had its chance: a crash, a hang or a reboot.
                # Leave the journal so the older coordinator records the rejection.
                link(journal['old'])
                attempted.unlink(missing_ok=True)
            else:
                write(attempted, journal['token'].encode())
                if entry_works(env):
                    env['CUBBY_TRIAL_ACTIVE'] = journal['token']
                    trial = True
                else:
                    continue
        elif not journal:
            attempted.unlink(missing_ok=True)
        started = time.monotonic()
        command = session_command()
        code = run(command, env, trial)
        if not (BASE / 'updates/pending.json').exists():
            attempted.unlink(missing_ok=True)
        if code == 0:
            # The baseline coordinator starts stock ROCKNIX itself before it returns.
            if 'coordinator.baseline.py' in command[2]:
                sys.exit(0)
            stock()
        if code == RESTART:
            failures = 0
            continue
        if trial:
            continue  # The next pass rolls back.
        failures = 0 if time.monotonic() - started > HEALTHY_RUN else failures
        failures += 1
        if failures >= FAILURES_BEFORE_DEMOTION:
            if not demote(tried):
                stock()
            failures = 0
        else:
            time.sleep(2)


if __name__ == '__main__':
    sys.exit(main())
