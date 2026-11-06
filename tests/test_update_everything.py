"""Whole-device updates, starting from the layout and coordinator on real devices today.

coordinator_0_11_0.py and launch_0_11_0.sh are the exact baseline files installed
devices run. The boot tests start the real launch.sh, boot entry, guard and
coordinators as processes; only the session (which needs root and a GPU) is a stub.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import zipfile

from rocknix import update_release, updates
from release_automation import advance_feed, verify_device, prepare_device
from runtime import server as assets
from tests.test_update_publish import FakeGitHub
from rocknix import update_publish

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures'
FEED = 'https://updates.example/manifest.json'
PLATFORM_FEED = 'https://updates.example/update.json'

SESSION_STUB = '''#!/bin/bash
echo "session $(basename "$1")" >> "$CUBBY_TEST_DIR/log"
exec "$CUBBY_TEST_PYTHON" "$CUBBY_TEST_DIR/session.py"
'''
BROKEN_SESSION = '''#!/bin/bash
echo "broken-session $(basename "$1")" >> "$CUBBY_TEST_DIR/log"
exit 3
'''
FAKE_SESSION = '''
import http.server, json, os, pathlib, socket, sys, threading, time
class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
    def log_message(self, *args): pass
token = os.environ.get('CUBBY_UPDATE_TRIAL')
once = pathlib.Path(os.environ['CUBBY_TEST_DIR']) / 'install-once'
if once.exists() and not token:
    # What the adult's Install button does, through the same socket.
    once.unlink()
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(os.environ['CUBBY_UPDATER_SOCKET'])
        client.sendall(json.dumps({'action': 'apply'}).encode() + b'\\n')
        print(client.recv(4096).decode(), flush=True)
    time.sleep(30)
    sys.exit(5)
if token:
    server = http.server.ThreadingHTTPServer(('127.0.0.1', int(os.environ['CUBBY_HEALTH_PORT'])), Health)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(os.environ['CUBBY_UPDATER_SOCKET'])
        client.sendall(json.dumps({'action': 'ready', 'token': token}).encode() + b'\\n')
        client.recv(4096)
    pending = pathlib.Path(os.environ['CUBBY_BASE']) / 'updates/pending.json'
    for _ in range(200):
        if not pending.exists(): sys.exit(0)
        time.sleep(.1)
    sys.exit(4)
'''


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


old = load(FIXTURES / 'coordinator_0_11_0.py', 'cubby_old_coordinator')


class Device(unittest.TestCase):
    """A device as installed today, with the release files of this checkout."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.base = self.root / 'cubby'
        self.keys = self.root / 'keys'; self.keys.mkdir()
        self.key = self.keys / 'private.pem'; self.public = self.keys / 'public.pem'
        self.new_key(self.key, self.public)
        self.responses = {}
        self.port = free_port()
        self.socket = self.root / 'updater.sock'
        self.stock = self.root / 'stock'
        self.stock.write_text('#!/bin/sh\necho stock >> "$CUBBY_TEST_DIR/log"\n'); self.stock.chmod(0o755)
        (self.root / 'session.py').write_text(FAKE_SESSION)
        self.source = self.make_source()
        self.install_today()

    @staticmethod
    def new_key(private, public):
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(private)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(private), '-pubout', '-out', str(public)], check=True, capture_output=True)

    def make_source(self, session=SESSION_STUB):
        source = self.root / 'source'
        if source.exists(): shutil.rmtree(source)
        ignore = shutil.ignore_patterns('__pycache__', 'splash', 'patches', '*.pyc')
        for name in ('runtime', 'rocknix'):
            shutil.copytree(ROOT / name, source / name, ignore=ignore)
        (source / 'hosting').mkdir()
        shutil.copy2(ROOT / 'hosting/catalog.yaml', source / 'hosting/catalog.yaml')
        stub = source / 'rocknix/device/chroot-run.sh'
        stub.write_text(session); stub.chmod(0o755)
        return source

    def install_today(self):
        base = self.base
        for name in ('releases', 'runtimes', 'state', 'updates', 'updater/device'):
            (base / name).mkdir(parents=True)
        (base / 'state/save').write_bytes(b'keep')
        self.add_runtime(base / 'runtimes' / updates.RUNTIME)
        text = (FIXTURES / 'coordinator_0_11_0.py').read_text()
        self.assertIn('/run/cubby-updater/socket', text)
        text = text.replace('/run/cubby-updater/socket', str(self.socket)).replace('/usr/bin/start_es.sh', str(self.stock))
        (base / 'updater/coordinator.py').write_text(text)
        launch = (FIXTURES / 'launch_0_11_0.sh').read_text().replace('/storage/cubby', str(base)).replace('/usr/bin/start_es.sh', str(self.stock))
        launch = launch.replace('/usr/bin/python3', sys.executable)
        (base / 'updater/device/launch.sh').write_text(launch)
        (base / 'updater/device/chroot-run.sh').write_text(SESSION_STUB)
        for name in ('launch.sh', 'chroot-run.sh'):
            (base / 'updater/device' / name).chmod(0o755)
        old.atomic(base / 'updater/device/.baseline-inventory.json', old.Manager.device_inventory(base / 'updater/device'))
        shutil.copy2(self.public, base / 'updater/release-key.pem')
        (base / 'updater/config.json').write_text(json.dumps({'feed': FEED, 'public_key': 'release-key.pem'}))
        release = base / 'releases/app-1-aaaaaaaaaaaaaaaa'
        (release / 'app/rocknix').mkdir(parents=True)
        (release / 'rootfs').symlink_to('../../runtimes/' + updates.RUNTIME)
        (release / 'device').symlink_to('../../updater/device')
        (release / 'release.json').write_text(json.dumps({'sequence': 1, 'version': '0.1.0'}))
        (base / 'current').symlink_to('releases/' + release.name)
        (base / 'updates/record.json').write_text(json.dumps({'sequence': 1, 'version': '0.1.0'}))
        self.r0 = release.name

    @staticmethod
    def add_runtime(path, marker=b'baseline'):
        (path / 'usr/bin').mkdir(parents=True)
        for name in ('python3', 'openssl', 'cog'):
            (path / 'usr/bin' / name).write_bytes(marker)
        (path / 'run').mkdir()

    def env(self, **extra):
        env = dict(os.environ, CUBBY_BASE=str(self.base), CUBBY_STOCK=str(self.stock), CUBBY_UPDATER_SOCKET=str(self.socket),
                   CUBBY_HEALTH_PORT=str(self.port), CUBBY_TEST_DIR=str(self.root), CUBBY_TEST_PYTHON=sys.executable,
                   CUBBY_TRIAL_STABLE='0.3', PYTHONDONTWRITEBYTECODE='1', CUBBY_UPDATER_UID=str(os.getuid()))
        env.update(extra)
        return env

    def boot(self, timeout=60, **extra):
        """What systemd does: run current/device/launch.sh and wait for the session to end."""
        log = self.root / 'log'
        log.unlink(missing_ok=True)
        launcher = self.base / 'current/device/launch.sh'
        self.rewrite_launch_python(launcher)
        result = subprocess.run([str(launcher)], env=self.env(**extra), capture_output=True, text=True, timeout=timeout)
        self.boot_output = result.stdout + result.stderr
        return log.read_text().split('\n')[:-1] if log.exists() else []

    @staticmethod
    def rewrite_launch_python(launcher):
        """/usr/bin/python3 on the device; this machine's interpreter here."""
        target = launcher.resolve()
        text = target.read_text()
        if '/usr/bin/python3' in text:
            target.write_text(text.replace('/usr/bin/python3', sys.executable))

    def release(self, version, sequence, *, source=None, trust=None, fallback=False, key=None):
        output = self.root / ('out-' + version)
        url = f'https://updates.example/{version}/app.zip'
        update_release.build(source or self.source, output, version, sequence, url, key or self.key, trust=trust, fallback=fallback)
        for name in ('app.zip', 'platform.zip'):
            if (output / name).exists():
                self.responses[f'https://updates.example/{version}/{name}'] = (output / name).read_bytes()
        return output

    def publish_legacy(self, output):
        self.responses[FEED] = (output / 'manifest.json').read_bytes()
        self.responses[FEED + '.sig'] = (output / 'manifest.json.sig').read_bytes()

    def publish_platform(self, output):
        self.responses[PLATFORM_FEED] = (output / 'update.json').read_bytes()
        self.responses[PLATFORM_FEED + '.sig'] = (output / 'update.json.sig').read_bytes()

    def fetcher(self, module):
        def fetch(url, *args, **kwargs):
            if url not in self.responses:
                raise updates.urllib.error.HTTPError(url, 404, 'missing', None, None)
            return self.responses[url]
        return mock.patch.object(module, 'fetch', side_effect=fetch)

    def old_install(self, version='0.2.0', sequence=2):
        """The baseline coordinator installs a release exactly as it does today, trial included."""
        output = self.release(version, sequence)
        self.publish_legacy(output)
        manager = old.Manager(self.base, openssl=['openssl'])
        with self.fetcher(old):
            manager.check(); manager.stage(); manager.apply()
        pending = old.read_json(manager.dir / 'pending.json')
        manager.dispatch({'action': 'ready', 'token': pending['token']})
        manager.confirm(pending['token'])
        return (self.base / 'current').resolve().name

    def current(self):
        return (self.base / 'current').resolve().name

    def record(self):
        return json.loads((self.base / 'updates/record.json').read_bytes())

    def manager(self, **kwargs):
        kwargs.setdefault('probe', lambda root: self.assertTrue((Path(root) / 'usr/bin/python3').exists()))
        return updates.Manager(self.base, openssl=['openssl'], **kwargs)

    def migrated(self):
        """Bridge a device and boot through its first guarded trial."""
        self.bridged = self.old_install()
        self.assertEqual(updates.bridge(self.base), 'armed')
        lines = self.boot()
        self.assertEqual(self.current(), self.bridged + updates.BRIDGED_SUFFIX, lines)
        return lines


class BridgeRelease(Device):
    def test_baseline_coordinator_installs_the_bridge_release_unchanged(self):
        name = self.old_install()
        release = self.base / 'releases' / name
        bundle = release / 'app' / updates.DEVICE_BUNDLE
        for file in updates.DEVICE_REQUIRED:
            self.assertTrue(os.access(bundle / file, os.X_OK), file)
        self.assertTrue((release / 'app/rocknix/updates.py').is_file())
        self.assertFalse((bundle / 'release-key.pem').exists())
        self.assertEqual(self.record()['sequence'], 2)

    def test_real_checkout_manifests_pass_each_coordinator(self):
        output = self.root / 'real'
        update_release.build(ROOT, output, '9.9.9', 99990000, 'https://updates.example/9/app.zip', self.key)
        legacy = json.loads((output / 'manifest.json').read_bytes())
        self.assertEqual(old.validate_manifest(legacy)['schema'], 1)
        self.assertEqual(updates.validate_manifest(legacy)['schema'], 1)
        platform = json.loads((output / 'update.json').read_bytes())
        self.assertEqual(updates.validate_manifest(platform)['schema'], 2)
        with self.assertRaises(ValueError): old.validate_manifest(platform)
        self.assertEqual(platform['files']['runtime/native/rg353v/cog']['mode'], 0o755)
        self.assertEqual(platform['files'][updates.DEVICE_BUNDLE + '/chroot-run.sh']['mode'], 0o755)
        self.assertNotIn('rocknix/device/launch.sh', platform['files'])
        self.assertNotIn(updates.DEVICE_BUNDLE + '/release-key.pem', platform['files'])
        # New host modules no longer vanish from releases, as they do in the legacy list.
        self.assertIn('rocknix/package.py', platform['files'])
        self.assertNotIn('rocknix/package.py', legacy['files'])

    def test_bridge_waits_for_the_trial_and_moves_nothing_until_boot(self):
        output = self.release('0.2.0', 2); self.publish_legacy(output)
        manager = old.Manager(self.base, openssl=['openssl'])
        with self.fetcher(old):
            manager.check(); manager.stage(); manager.apply()
        name = self.current()
        self.assertEqual(updates.bridge(self.base, self.base / 'releases' / name), 'waiting')
        self.assertFalse((self.base / 'boot').exists())
        pending = old.read_json(manager.dir / 'pending.json')
        manager.dispatch({'action': 'ready', 'token': pending['token']}); manager.confirm(pending['token'])
        self.assertEqual(updates.bridge(self.base, self.base / 'releases' / self.r0), 'other')
        baseline = (self.base / 'updater/coordinator.py').read_bytes()
        self.assertEqual(updates.bridge(self.base, self.base / 'releases' / name), 'armed')
        self.assertEqual(self.current(), name)
        self.assertFalse((self.base / 'updates/pending.json').exists(), 'the running old coordinator would time its session out')
        self.assertEqual((self.base / 'updater/coordinator.baseline.py').read_bytes(), baseline)
        self.assertEqual((self.base / 'updater/coordinator.py').read_bytes(), updates.TRAMPOLINE)
        self.assertEqual(os.readlink(self.base / 'fallback'), 'releases/' + name)
        self.assertEqual((self.base / 'updater/device/launch.sh').read_text(), (self.base / 'current/device/launch.sh').read_text())
        self.assertEqual(updates.bridge(self.base), 'armed', 'safe to repeat at every session until the reboot')

    def test_changed_release_files_refuse_to_bridge(self):
        name = self.old_install()
        guard = self.base / 'releases' / name / 'app' / updates.DEVICE_BUNDLE / 'guard.py'
        guard.write_text('# tampered\n')
        with self.assertRaises(ValueError): updates.bridge(self.base)
        self.assertFalse((self.base / 'boot').exists())
        self.assertNotEqual((self.base / 'updater/coordinator.py').read_bytes(), updates.TRAMPOLINE)

    def test_device_without_updates_configured_does_not_bridge(self):
        self.old_install()
        (self.base / 'updater/config.json').unlink()
        self.assertEqual(updates.bridge(self.base), 'unconfigured')
        self.assertFalse((self.base / 'boot').exists())

    def test_network_helper_runs_the_bridge_from_inside_the_release(self):
        name = self.old_install()
        rocknix = self.base / 'releases' / name / 'app/rocknix'
        network = load(rocknix / 'network.py', 'cubby_release_network')
        network.bridge_to_guarded_updates(sleep=lambda seconds: self.fail('nothing to wait for'))
        self.assertTrue((self.base / 'boot/activate.json').is_file())
        self.assertEqual((self.base / 'updater/coordinator.py').read_bytes(), updates.TRAMPOLINE)

    def test_network_helper_survives_a_failing_bridge(self):
        name = self.old_install()
        rocknix = self.base / 'releases' / name / 'app/rocknix'
        (rocknix / 'updates.py').write_text('raise RuntimeError("bad")\n')
        load(rocknix / 'network.py', 'cubby_release_network_b').bridge_to_guarded_updates()
        self.assertFalse((self.base / 'boot').exists())

    def test_device_files_are_not_served_to_pages(self):
        handler = object.__new__(assets.Handler)
        self.assertTrue(handler.translate_path('/' + updates.DEVICE_BUNDLE + '/guard.py').endswith('.missing-runtime-asset'))


class MigrationBoot(Device):
    def test_next_boot_runs_the_guarded_layout_and_keeps_the_way_back(self):
        lines = self.migrated()
        twin = self.bridged + updates.BRIDGED_SUFFIX
        self.assertEqual(lines, ['session ' + twin, 'stock'], self.boot_output)
        release = self.base / 'releases' / twin
        self.assertEqual(release.joinpath('device').resolve(), (release / 'app' / updates.DEVICE_BUNDLE).resolve())
        self.assertEqual(release.joinpath('rootfs').resolve(), (self.base / 'runtimes' / updates.RUNTIME).resolve())
        self.assertEqual((release / 'trust/release-key.pem').read_bytes(), self.public.read_bytes())
        self.assertFalse((self.base / 'updates/pending.json').exists())
        self.assertFalse((self.base / 'boot/activate.json').exists())
        self.assertFalse((self.base / 'boot/trial-attempted').exists())
        self.assertEqual(os.readlink(self.base / 'previous'), 'releases/' + self.bridged)
        self.assertEqual(os.readlink(self.base / 'fallback'), 'releases/' + self.bridged)
        self.assertEqual(self.record()['sequence'], 2)
        self.assertEqual((self.base / 'state/save').read_bytes(), b'keep')
        # Later boots are ordinary, and the check treats this version as installed.
        self.assertEqual(self.boot(), ['session ' + twin, 'stock'])
        self.publish_platform(self.root / 'out-0.2.0')
        with self.fetcher(updates):
            self.assertEqual(self.manager().check()['phase'], 'idle')

    def assert_rolled_back_to_baseline(self, lines):
        twin = self.bridged + updates.BRIDGED_SUFFIX
        self.assertEqual(self.current(), self.bridged, (lines, self.boot_output))
        self.assertIn(twin, self.record()['rejected'])
        self.assertFalse((self.base / 'updates/pending.json').exists())
        self.assertEqual(lines[-2:], ['session ' + self.bridged, 'stock'], self.boot_output)
        self.assertEqual((self.base / 'state/save').read_bytes(), b'keep')
        self.assertEqual(updates.bridge(self.base), 'rejected', 'never loops on a twin that failed')

    def arm(self):
        self.bridged = self.old_install()
        self.assertEqual(updates.bridge(self.base), 'armed')
        return self.base / 'releases' / (self.bridged + updates.BRIDGED_SUFFIX)

    def test_coordinator_that_cannot_start_falls_back_to_the_baseline_coordinator(self):
        twin = self.arm()
        (twin / 'app/rocknix/updates.py').write_text('raise SystemExit(3)\n')
        self.assert_rolled_back_to_baseline(self.boot())

    def test_coordinator_with_a_syntax_error_falls_back(self):
        twin = self.arm()
        (twin / 'app/rocknix/updates.py').write_text('def (\n')
        self.assert_rolled_back_to_baseline(self.boot())

    def test_hung_coordinator_is_stopped_by_the_guard_and_rolled_back(self):
        twin = self.arm()
        (twin / 'app/rocknix/updates.py').write_text('import time\ntime.sleep(300)\n')
        self.assert_rolled_back_to_baseline(self.boot(CUBBY_TRIAL_LIMIT='1'))

    def test_session_that_fails_in_trial_rolls_back(self):
        twin = self.arm()
        script = twin / 'app' / updates.DEVICE_BUNDLE / 'chroot-run.sh'
        script.write_text(BROKEN_SESSION); script.chmod(0o755)
        lines = self.boot()
        self.assertIn('broken-session ' + twin.name, lines)
        self.assert_rolled_back_to_baseline(lines)

    def test_broken_boot_entry_in_the_release_is_caught_before_it_matters(self):
        twin = self.arm()
        launcher = twin / 'app' / updates.DEVICE_BUNDLE / 'launch.sh'
        launcher.write_text('#!/bin/sh\nexit 9\n'); launcher.chmod(0o755)
        # systemd starts the still-current bridge release, whose launch.sh is the baseline.
        lines = self.boot()
        self.assertNotIn('session ' + twin.name, lines)
        self.assert_rolled_back_to_baseline(lines)

    def test_power_loss_during_the_trial_rolls_back_at_the_next_boot(self):
        twin = self.arm()
        marker = json.loads((self.base / 'boot/activate.json').read_bytes())
        updates.atomic(self.base / 'updates/pending.json', marker)
        (self.base / 'boot/activate.json').unlink()
        updates.link(self.base, 'current', marker['new'])
        (self.base / 'boot/trial-attempted').write_text(marker['token'])
        self.assert_rolled_back_to_baseline(self.boot())
        self.assertFalse((self.base / 'boot/trial-attempted').exists())
        self.assertTrue(twin.is_dir())

    def test_power_loss_between_journal_and_switch_rolls_back(self):
        self.arm()
        marker = json.loads((self.base / 'boot/activate.json').read_bytes())
        updates.atomic(self.base / 'updates/pending.json', marker)
        (self.base / 'boot/activate.json').unlink()
        self.assert_rolled_back_to_baseline(self.boot())

    def test_a_later_baseline_install_before_the_reboot_discards_the_armed_trial(self):
        self.arm()
        output = self.release('0.3.0', 3); self.publish_legacy(output)
        manager = old.Manager(self.base, openssl=['openssl'])
        with self.fetcher(old):
            manager.check(); manager.stage(); manager.apply()
        pending = old.read_json(manager.dir / 'pending.json')
        manager.dispatch({'action': 'ready', 'token': pending['token']}); manager.confirm(pending['token'])
        name = self.current()
        lines = self.boot()
        self.assertEqual(self.current(), name)
        self.assertFalse((self.base / 'boot/activate.json').exists())
        self.assertEqual(lines, ['session ' + name, 'stock'], self.boot_output)
        self.assertEqual(updates.bridge(self.base), 'armed', 'that release bridges in turn')

    def test_broken_guard_uses_the_previous_guard_then_the_baseline(self):
        self.arm()
        (self.base / 'boot/guard.py').write_text('def (\n')
        lines = self.boot()
        self.assertEqual(self.current(), self.bridged + updates.BRIDGED_SUFFIX, self.boot_output)
        self.assertEqual(lines[-1], 'stock')
        (self.base / 'boot/guard.previous.py').write_text('def (\n')
        lines = self.boot()
        self.assertEqual(lines[-1], 'stock', self.boot_output)

    def test_missing_guard_still_starts_cubby_from_the_baseline(self):
        self.arm()
        shutil.rmtree(self.base / 'boot')
        lines = self.boot()
        self.assertEqual(lines, ['session ' + self.bridged, 'stock'], self.boot_output)

    def test_baseline_after_failed_migration_can_still_take_an_update(self):
        twin = self.arm()
        (twin / 'app/rocknix/updates.py').write_text('raise SystemExit(3)\n')
        self.assert_rolled_back_to_baseline(self.boot())
        name = self.old_install('0.3.0', 3)
        self.assertEqual(self.record()['sequence'], 3)
        self.assertEqual(updates.bridge(self.base, self.base / 'releases' / name), 'armed')
        lines = self.boot()
        self.assertEqual(lines, ['session ' + name + updates.BRIDGED_SUFFIX, 'stock'], self.boot_output)


class PlatformHelpers(Device):
    def runtime_archive(self, version='2', marker=b'new-runtime'):
        tree = self.root / ('runtime-' + version)
        self.add_runtime(tree, marker)
        archive = self.root / ('rootfs-' + version + '.tar.xz')
        subprocess.run(['tar', '-cJf', str(archive), '-C', str(tree), '.'], check=True)
        body = archive.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        url = f'https://updates.example/runtime/{digest}.tar.xz'
        self.bodies = getattr(self, 'bodies', {}); self.bodies[url] = body
        return {'sha256': digest, 'url': url, 'size': len(body), 'unpacked_size': 1024**2}

    def serve_runtime(self):
        def open_url(url):
            if url not in self.bodies:
                raise updates.urllib.error.HTTPError(url, 404, 'missing', None, None)
            return io.BytesIO(self.bodies[url])
        return mock.patch.object(updates, 'open_url', side_effect=open_url)

    def install(self, output, confirm=True, manager=None):
        self.publish_platform(output)
        manager = manager or self.manager()
        with self.fetcher(updates), self.serve_runtime() if hasattr(self, 'bodies') else mock.patch.object(updates, 'open_url'):
            manager.check(); self.assertEqual(manager.phase, 'available')
            manager.stage(); self.assertEqual(manager.phase, 'staged')
        manager.apply()
        return manager

    def set_runtime(self, runtime):
        (self.source / 'rocknix/runtime.json').write_text(json.dumps(runtime))


class PlatformUpdates(PlatformHelpers):
    def test_new_runtime_downloads_to_disk_installs_and_boots_with_everything_else(self):
        self.migrated()
        twin = self.current()
        runtime = self.runtime_archive()
        self.set_runtime(runtime)
        marker = self.source / 'rocknix/updates.py'
        marker.write_text(marker.read_text() + '\n# coordinator 0.3.0\n')
        guard = self.source / 'rocknix/device/guard.py'
        guard.write_text(guard.read_text() + '\n# guard 0.3.0\n')
        output = self.release('0.3.0', 3)
        self.assertFalse((output / 'manifest.json').exists(), 'old coordinators stay on a release that can bridge them')
        self.install(output)
        name = self.current()
        self.assertEqual((self.base / 'current/rootfs/usr/bin/cog').read_bytes(), b'new-runtime')
        self.assertEqual(list((self.base / 'runtimes').glob('.runtime-*')), [])
        self.assertEqual(self.boot(), ['session ' + name, 'stock'], self.boot_output)
        self.assertEqual(self.record()['sequence'], 3)
        self.assertEqual(os.readlink(self.base / 'previous'), 'releases/' + twin)
        self.assertIn(b'# coordinator 0.3.0', (self.base / 'current/app/rocknix/updates.py').read_bytes())
        self.assertIn(b'# guard 0.3.0', (self.base / 'boot/guard.py').read_bytes())
        self.assertNotIn(b'# guard 0.3.0', (self.base / 'boot/guard.previous.py').read_bytes())
        self.assertTrue((self.base / 'runtimes' / updates.RUNTIME).is_dir(), 'the baseline runtime stays')

    def test_failed_trial_restores_runtime_device_files_coordinator_and_trust_together(self):
        self.migrated()
        twin = self.current()
        before = {name: (self.base / 'current' / name).read_bytes() for name in
                  ('rootfs/usr/bin/cog', 'device/chroot-run.sh', 'app/rocknix/updates.py', 'trust/release-key.pem', 'trust/config.json')}
        self.set_runtime(self.runtime_archive())
        stub = self.source / 'rocknix/device/chroot-run.sh'
        stub.write_text(BROKEN_SESSION); stub.chmod(0o755)
        coordinator = self.source / 'rocknix/updates.py'
        coordinator.write_text(coordinator.read_text() + '\n# coordinator 0.3.0\n')
        rotated, rotated_public = self.keys / 'rotated.pem', self.keys / 'rotated-public.pem'
        self.new_key(rotated, rotated_public)
        output = self.release('0.3.0', 3, trust={'feed': 'https://other.example/manifest.json', 'public_key': rotated_public.read_text()})
        self.install(output)
        name = self.current()
        self.assertEqual((self.base / 'current/rootfs/usr/bin/cog').read_bytes(), b'new-runtime')
        self.assertEqual((self.base / 'current/trust/release-key.pem').read_bytes(), rotated_public.read_bytes())
        lines = self.boot()
        self.assertIn('broken-session ' + name, lines)
        self.assertEqual(self.current(), twin, self.boot_output)
        self.assertEqual(lines[-2:], ['session ' + twin, 'stock'])
        for path, body in before.items():
            self.assertEqual((self.base / 'current' / path).read_bytes(), body, path)
        self.assertEqual(self.record()['sequence'], 2)
        self.assertIn(name, self.record()['rejected'])
        self.assertEqual((self.base / 'updater/release-key.pem').read_bytes(), self.public.read_bytes(), 'fallback trust is untouched')
        self.assertEqual((self.base / 'state/save').read_bytes(), b'keep')
        # A later good update still goes through with the original key.
        self.source = self.make_source()
        repaired = self.release('0.4.0', 4)
        self.install(repaired)
        self.assertEqual(self.boot(), ['session ' + self.current(), 'stock'], self.boot_output)
        self.assertEqual(self.record()['sequence'], 4)

    def test_coordinator_that_cannot_start_rolls_back_to_the_running_one(self):
        self.migrated()
        twin = self.current()
        self.install(self.release('0.3.0', 3))
        (self.base / 'current/app/rocknix/updates.py').write_text('raise SystemExit(3)\n')
        name = self.current()
        lines = self.boot()
        self.assertEqual(self.current(), twin, self.boot_output)
        self.assertEqual(lines, ['session ' + twin, 'stock'])
        self.assertIn(name, self.record()['rejected'])
        self.assertEqual(self.record()['sequence'], 2)

    def test_key_rotation_applies_after_the_trial_and_reaches_the_fallback(self):
        self.migrated()
        rotated, rotated_public = self.keys / 'rotated.pem', self.keys / 'rotated-public.pem'
        self.new_key(rotated, rotated_public)
        output = self.release('0.3.0', 3, trust={'feed': FEED, 'public_key': rotated_public.read_text()})
        self.install(output)
        self.assertEqual(self.boot(), ['session ' + self.current(), 'stock'], self.boot_output)
        self.assertEqual((self.base / 'updater/release-key.pem').read_bytes(), rotated_public.read_bytes())
        # The old key can no longer publish, and the new one can.
        forged = self.release('0.4.0', 4)
        manager = self.manager()
        with self.assertRaisesRegex(ValueError, 'signature'):
            manager.verify((forged / 'update.json').read_bytes(), (forged / 'update.json.sig').read_bytes())
        good = self.release('0.5.0', 5, key=rotated)
        self.assertEqual(manager.verify((good / 'update.json').read_bytes(), (good / 'update.json.sig').read_bytes())['sequence'], 5)

    def test_replay_and_rejected_releases_stay_refused(self):
        self.migrated()
        output = self.release('0.3.0', 3)
        raw, signature = (output / 'update.json').read_bytes(), (output / 'update.json.sig').read_bytes()
        self.install(output)
        (self.base / 'current/app/rocknix/updates.py').write_text('raise SystemExit(3)\n')
        self.boot()
        manager = self.manager()
        with self.assertRaisesRegex(ValueError, 'rejected'):
            manager.verify(raw, signature)
        updates.atomic(manager.dir / 'record.json', {**self.record(), 'sequence': 3})
        with self.assertRaisesRegex(ValueError, 'Replayed'):
            manager.verify(raw, signature)

    def staged_failure(self, runtime, probe=None, disk=None):
        """Staging fails, and nothing about the running device has changed."""
        self.set_runtime(runtime)
        output = self.release('0.3.0', 3)
        self.publish_platform(output)
        manager = self.manager(**({'probe': probe} if probe else {}))
        name = self.current()
        patches = [self.fetcher(updates), self.serve_runtime()]
        if disk is not None:
            patches.append(mock.patch.object(updates.shutil, 'disk_usage', return_value=mock.Mock(free=disk)))
        for patch in patches: patch.start()
        try:
            manager.check()
            with self.assertRaises((ValueError, OSError, subprocess.SubprocessError)): manager.stage()
        finally:
            for patch in patches: patch.stop()
        self.assertEqual(self.current(), name)
        self.assertFalse((self.base / 'runtimes' / runtime['sha256']).exists())
        self.assertEqual(list((self.base / 'runtimes').glob('.runtime-*')), [])
        self.assertFalse((self.base / 'updates/pending.json').exists())
        self.assertEqual(self.boot(), ['session ' + name, 'stock'], self.boot_output)

    def test_wrong_bytes_for_the_runtime_change_nothing(self):
        self.migrated()
        runtime = self.runtime_archive()
        self.bodies[runtime['url']] = self.bodies[runtime['url']][:-1] + b'\0'
        self.staged_failure(runtime)

    def test_truncated_runtime_changes_nothing(self):
        self.migrated()
        runtime = self.runtime_archive()
        self.bodies[runtime['url']] = self.bodies[runtime['url']][:-20]
        self.staged_failure(runtime)

    def test_oversized_runtime_stops_downloading(self):
        self.migrated()
        runtime = self.runtime_archive()
        self.bodies[runtime['url']] += b'x' * 4096
        self.staged_failure(runtime)

    def test_signed_archive_that_is_not_a_tar_changes_nothing(self):
        self.migrated()
        body = b'not a tar'
        digest = hashlib.sha256(body).hexdigest(); url = 'https://updates.example/runtime/bad.tar.xz'
        self.bodies = {url: body}
        self.staged_failure({'sha256': digest, 'url': url, 'size': len(body), 'unpacked_size': 1024})

    def test_runtime_that_cannot_run_is_discarded(self):
        self.migrated()
        def refuse(root): raise subprocess.CalledProcessError(1, 'probe')
        self.staged_failure(self.runtime_archive(), probe=refuse)

    def test_too_little_space_for_the_runtime_does_not_download(self):
        self.migrated()
        runtime = self.runtime_archive()
        room = runtime['size'] + runtime['unpacked_size']
        with mock.patch.object(updates, 'fetch_file') as download:
            self.staged_failure(runtime, disk=room)
            download.assert_not_called()

    def test_runtime_bytes_never_collect_in_memory(self):
        sizes = []
        class Stream(io.BytesIO):
            def read(self, size=-1):
                sizes.append(size)
                return super().read(size)
        body = b'x' * (5 * 1024**2 + 1)
        path = self.root / 'download'
        with mock.patch.object(updates, 'open_url', return_value=Stream(body)):
            updates.fetch_file('https://updates.example/r', path, len(body), hashlib.sha256(body).hexdigest())
        self.assertEqual(path.read_bytes(), body)
        self.assertTrue(sizes and max(sizes) <= 1024**2, sizes)

    def test_interrupted_runtime_leftovers_are_cleared_on_retry(self):
        self.migrated()
        (self.base / 'runtimes/.runtime-leftover').mkdir()
        (self.base / 'runtimes/.runtime-abc.tar.xz').write_bytes(b'partial')
        self.set_runtime(self.runtime_archive())
        self.install(self.release('0.3.0', 3))
        self.assertEqual(list((self.base / 'runtimes').glob('.runtime-*')), [])

    def test_runtimes_are_collected_only_when_nothing_can_start_from_them(self):
        self.migrated()
        first = self.runtime_archive('2', b'second'); self.set_runtime(first)
        self.install(self.release('0.3.0', 3)); self.boot()
        second = self.runtime_archive('3', b'third'); self.set_runtime(second)
        self.install(self.release('0.4.0', 4)); self.boot()
        self.assertTrue((self.base / 'runtimes' / first['sha256']).is_dir(), 'previous still needs it')
        third = self.runtime_archive('4', b'fourth'); self.set_runtime(third)
        self.install(self.release('0.5.0', 5)); self.boot()
        self.assertFalse((self.base / 'runtimes' / first['sha256']).exists())
        self.assertTrue((self.base / 'runtimes' / second['sha256']).is_dir())
        self.assertTrue((self.base / 'runtimes' / third['sha256']).is_dir())
        self.assertTrue((self.base / 'runtimes' / updates.RUNTIME).is_dir())
        self.assertTrue((self.base / 'fallback/rootfs/usr/bin/python3').exists())

    def test_baseline_coordinator_reads_state_left_by_a_newer_one(self):
        self.migrated()
        output = self.release('0.3.0', 3); self.publish_platform(output)
        manager = self.manager()
        with self.fetcher(updates): manager.check()
        self.assertTrue((self.base / 'updates/platform-candidate.json').is_file())
        updates.link(self.base, 'current', 'releases/' + self.bridged)
        baseline = old.Manager(self.base, openssl=['openssl'])
        self.assertIn(baseline.status()['phase'], {'idle'})
        baseline.recover()

    def test_coordinator_forgets_a_candidate_from_a_newer_schema(self):
        self.migrated()
        (self.base / 'updates/platform-candidate.json').write_text('{"schema": 3}')
        self.assertEqual(self.manager().status()['phase'], 'idle')
        self.assertFalse((self.base / 'updates/platform-candidate.json').exists())

    def test_broken_guard_in_a_release_never_replaces_the_working_one(self):
        self.migrated()
        working = (self.base / 'boot/guard.py').read_bytes()
        release = self.base / 'current'
        (release / 'app' / updates.DEVICE_BUNDLE / 'guard.py').write_text('def (\n')
        with self.assertRaises(SyntaxError): self.manager().install_boot(release)
        self.assertEqual((self.base / 'boot/guard.py').read_bytes(), working)

    def test_staging_refuses_a_release_with_broken_device_files(self):
        self.migrated()
        launcher = self.source / 'rocknix/device/launch.sh'
        launcher.write_text('if then\n')
        output = self.release('0.3.0', 3); self.publish_platform(output)
        manager = self.manager()
        with self.fetcher(updates):
            manager.check()
            with self.assertRaises(subprocess.SubprocessError): manager.stage()
        self.assertFalse((self.base / 'releases' / updates.Manager.release_id(json.loads((output / 'update.json').read_bytes()))).exists())

    def test_signed_flag_moves_the_fallback_forward(self):
        self.migrated()
        self.install(self.release('0.3.0', 3, fallback=True))
        name = self.current()
        self.boot()
        self.assertEqual(os.readlink(self.base / 'fallback'), 'releases/' + name)

    def test_platform_manifest_is_validated(self):
        output = self.release('0.3.0', 3)
        good = json.loads((output / 'update.json').read_bytes())
        def changed(**fields): return {**good, **fields}
        bad = [changed(kind='app'), changed(rocknix='20991231'), changed(fallback='yes'), changed(trust={'feed': FEED, 'public_key': 'nope'}),
               changed(trust={'feed': 'http://insecure.example/m', 'public_key': self.public.read_text()}),
               changed(runtime={**good['runtime'], 'sha256': 'f' * 64}),
               changed(runtime={'sha256': 'f' * 64, 'url': 'https://u.example/r', 'size': updates.MAX_RUNTIME_ARCHIVE + 1, 'unpacked_size': 1}),
               changed(runtime={'sha256': 'f' * 64, 'url': 'https://u.example/r', 'size': 1, 'unpacked_size': updates.MAX_RUNTIME_EXPANDED + 1}),
               changed(files={**good['files'], '../escape': {'sha256': 'f' * 64, 'size': 0, 'mode': 0o644}}),
               changed(files={**good['files'], 'state/save': {'sha256': 'f' * 64, 'size': 0, 'mode': 0o644}}),
               changed(files={k: v for k, v in good['files'].items() if not k.endswith('/guard.py')}),
               {**good, 'extra': 1}]
        for manifest in bad:
            with self.subTest(manifest=str(manifest)[:60]), self.assertRaises(ValueError): updates.validate_manifest(manifest)
        self.assertEqual(updates.validate_manifest(good)['schema'], 2)


class InstallFromRunningSession(PlatformHelpers):
    def chroot_for_signature_checks(self):
        """A stand-in for chroot that lets the coordinator's real openssl check run unprivileged."""
        tools = self.root / 'bin'; tools.mkdir()
        stub = tools / 'chroot'
        stub.write_text('#!/bin/bash\nroot=$1; shift; shift\nargs=()\nfor a in "$@"; do args+=("${a/#\\/run/$root/run}"); done\nexec openssl "${args[@]}"\n')
        stub.chmod(0o755)
        return str(tools) + ':' + os.environ['PATH']

    def test_install_button_restarts_into_the_new_release_and_confirms(self):
        self.migrated()
        twin = self.current()
        self.set_runtime(self.runtime_archive())
        coordinator = self.source / 'rocknix/updates.py'
        coordinator.write_text(coordinator.read_text() + '\n# coordinator 0.3.0\n')
        output = self.release('0.3.0', 3); self.publish_platform(output)
        manager = self.manager()
        with self.fetcher(updates), self.serve_runtime():
            manager.check(); manager.stage()
        self.assertEqual(self.current(), twin)
        (self.root / 'install-once').touch()
        lines = self.boot(PATH=self.chroot_for_signature_checks())
        name = updates.Manager.release_id(json.loads((output / 'update.json').read_bytes()))
        self.assertEqual(lines, ['session ' + twin, 'session ' + name, 'stock'], self.boot_output)
        self.assertEqual(self.current(), name)
        self.assertEqual(self.record()['sequence'], 3)
        self.assertEqual((self.base / 'current/rootfs/usr/bin/cog').read_bytes(), b'new-runtime')
        self.assertEqual(os.readlink(self.base / 'previous'), 'releases/' + twin)

    def test_install_button_with_a_failing_release_comes_back_to_the_running_one(self):
        self.migrated()
        twin = self.current()
        stub = self.source / 'rocknix/device/chroot-run.sh'
        stub.write_text(BROKEN_SESSION); stub.chmod(0o755)
        output = self.release('0.3.0', 3); self.publish_platform(output)
        manager = self.manager()
        with self.fetcher(updates): manager.check(); manager.stage()
        (self.root / 'install-once').touch()
        lines = self.boot(PATH=self.chroot_for_signature_checks())
        name = updates.Manager.release_id(json.loads((output / 'update.json').read_bytes()))
        self.assertIn('broken-session ' + name, lines, self.boot_output)
        self.assertEqual(self.current(), twin, self.boot_output)
        self.assertIn(name, self.record()['rejected'])
        self.assertEqual(self.record()['sequence'], 2)


class FreshImage(PlatformHelpers):
    def install_today(self):
        """A device flashed from a new image: this checkout's coordinator, not yet guarded."""
        base = self.base
        release = base / 'releases/image-abc'
        (release / 'app/rocknix').mkdir(parents=True)
        self.add_runtime(release / 'rootfs')
        shutil.copytree(self.source / 'rocknix/device', release / 'device')
        (base / 'current').symlink_to('releases/image-abc') if base.exists() else None
        (base / 'updates').mkdir(); (base / 'state').mkdir(); (base / 'state/save').write_bytes(b'keep')
        (base / 'updater').mkdir()
        (base / 'updater/coordinator.py').write_bytes((self.source / 'rocknix/updates.py').read_bytes())
        shutil.copy2(self.public, base / 'updater/release-key.pem')
        (base / 'updater/config.json').write_text(json.dumps({'feed': FEED, 'public_key': 'release-key.pem'}))
        self.r0 = release.name

    def test_first_update_installs_the_guard(self):
        manager = self.manager()
        self.assertEqual(updates.bridge(self.base), 'unsigned')
        output = self.release('0.3.0', 3); self.publish_platform(output)
        with self.fetcher(updates):
            manager.check(); manager.stage()
        manager.apply()
        pending = updates.read_json(manager.dir / 'pending.json')
        manager.dispatch({'action': 'ready', 'token': pending['token']}); manager.confirm(pending['token'])
        self.assertEqual((self.base / 'updater/coordinator.py').read_bytes(), updates.TRAMPOLINE)
        self.assertEqual(os.readlink(self.base / 'fallback'), 'releases/image-abc')
        self.assertEqual((self.base / 'releases/image-abc/rootfs').resolve(), (self.base / 'runtimes' / updates.RUNTIME).resolve())
        self.assertEqual(self.boot(), ['session ' + self.current(), 'stock'], self.boot_output)


class Demotion(Device):
    def test_release_that_stops_working_steps_down_to_previous_then_fallback_then_stock(self):
        self.bridged = self.old_install()
        self.assertEqual(updates.bridge(self.base), 'armed')
        self.boot()
        twin = self.current()
        manager = self.manager()
        output = self.release('0.3.0', 3); self.publish_platform(output)
        with self.fetcher(updates): manager.check(); manager.stage(); manager.apply()
        self.boot()
        newest = self.current()
        self.assertEqual(self.record()['sequence'], 3)
        for name in (newest, twin):
            script = self.base / 'releases' / name / 'app' / updates.DEVICE_BUNDLE / 'chroot-run.sh'
            script.write_text(BROKEN_SESSION); script.chmod(0o755)
        lines = self.boot(timeout=120)
        self.assertEqual(self.current(), self.bridged, (lines, self.boot_output))
        self.assertIn('broken-session ' + newest, lines)
        self.assertIn('broken-session ' + twin, lines)
        self.assertEqual(lines[-2:], ['session ' + self.bridged, 'stock'])
        self.assertIn(newest, self.record()['rejected'])

    def test_stock_rocknix_is_the_end_of_the_line(self):
        self.bridged = self.old_install()
        self.assertEqual(updates.bridge(self.base), 'armed')
        self.boot()
        twin = self.current()
        script = self.base / 'releases' / twin / 'app' / updates.DEVICE_BUNDLE / 'chroot-run.sh'
        script.write_text(BROKEN_SESSION); script.chmod(0o755)
        for name in ('fallback', 'previous'):
            (self.base / name).unlink()
        lines = self.boot(timeout=120)
        self.assertEqual(lines[-1], 'stock', self.boot_output)

    def test_journal_nothing_can_finish_cannot_trap_the_guard(self):
        self.bridged = self.old_install()
        updates.bridge(self.base); self.boot()
        twin = self.current()
        (self.base / 'updates/pending.json').write_text('{"broken')
        lines = self.boot(timeout=120)
        self.assertFalse((self.base / 'updates/pending.json').exists())
        self.assertEqual(self.current(), self.bridged, (lines, self.boot_output))
        self.assertEqual(lines[-2:], ['session ' + self.bridged, 'stock'])
        self.assertTrue((self.base / 'releases' / twin).is_dir())

    def test_stopping_the_service_stops_the_whole_chain(self):
        self.bridged = self.old_install()
        updates.bridge(self.base); self.boot()
        hang = self.base / 'current/app' / updates.DEVICE_BUNDLE / 'chroot-run.sh'
        hang.write_text('#!/bin/bash\necho "up $$" >> "$CUBBY_TEST_DIR/log"\nexec sleep 300\n'); hang.chmod(0o755)
        launcher = self.base / 'current/device/launch.sh'
        self.rewrite_launch_python(launcher)
        log = self.root / 'log'; log.unlink(missing_ok=True)
        process = subprocess.Popen([str(launcher)], env=self.env())
        self.addCleanup(process.kill)
        for _ in range(200):
            if log.exists() and log.read_text().strip(): break
            time.sleep(.1)
        pid = int(log.read_text().split()[1])
        process.terminate()  # What a stop does if only the main process is signalled.
        process.wait(timeout=30)
        for _ in range(200):
            try: os.kill(pid, 0)
            except ProcessLookupError: break
            time.sleep(.1)
        else:
            os.kill(pid, 9); self.fail('session outlived the service')

    def test_disabled_flag_goes_straight_to_stock(self):
        self.migrated_for_disable()
        (self.base / 'DISABLED').touch()
        self.assertEqual(self.boot(), ['stock'])

    def migrated_for_disable(self):
        self.bridged = self.old_install()
        updates.bridge(self.base); self.boot()


class EntryProbe(Device):
    def test_probe_walks_the_real_boot_path_and_starts_nothing(self):
        self.bridged = self.old_install()
        updates.bridge(self.base); self.boot()
        launcher = self.base / 'current/device/launch.sh'
        (self.root / 'log').unlink(missing_ok=True)
        result = subprocess.run([str(launcher)], env=self.env(CUBBY_ENTRY_PROBE='1'), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'log').exists())

    def test_probe_fails_when_the_guard_cannot_run(self):
        self.bridged = self.old_install()
        updates.bridge(self.base); self.boot()
        (self.base / 'boot/guard.py').write_text('def (\n')
        (self.base / 'boot/guard.previous.py').write_text('def (\n')
        launcher = self.base / 'current/device/launch.sh'
        result = subprocess.run([str(launcher)], env=self.env(CUBBY_ENTRY_PROBE='1'), capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)


class Publishing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.source = self.root / 'source'
        for name in ['runtime/index.html', 'rocknix/server.py', 'rocknix/session.sh']:
            p = self.source / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('fixture')
        for name in update_release.DEVICE_REQUIRED:
            p = self.source / 'rocknix/device' / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('#!/bin/sh\n'); p.chmod(0o755)
        self.private = self.root / 'private.pem'; self.public = self.source / 'rocknix/device/release-key.pem'
        Device.new_key(self.private, self.public)

    def prepare(self, version, runtime=None):
        (self.source / 'package.json').write_text(json.dumps({'version': version}))
        if runtime: (self.source / 'rocknix/runtime.json').write_text(json.dumps(runtime))
        output = self.root / version
        prepare_device(self.source, output, self.private)
        return output

    @staticmethod
    def published(output):
        gh = FakeGitHub()
        gh.releases['v' + output.name] = {p.name: p.read_bytes() for p in output.iterdir()}
        return gh

    def test_feed_carries_both_manifests_for_a_normal_release(self):
        output = self.prepare('0.21.0')
        gh = self.published(output)
        advance_feed(output, self.public, 'a' * 40, gh)
        feed = gh.releases[update_publish.CHANNEL]
        self.assertEqual(json.loads(feed['manifest.json'])['schema'], 1)
        self.assertEqual(json.loads(feed['update.json'])['schema'], 2)
        uploads = len(gh.uploads); advance_feed(output, self.public, 'a' * 40, gh)
        self.assertEqual(len(gh.uploads), uploads, 'a retry does nothing')

    def test_new_runtime_release_leaves_old_coordinators_on_the_last_bridge(self):
        first = self.prepare('0.21.0')
        gh = self.published(first)
        advance_feed(first, self.public, 'a' * 40, gh)
        legacy = gh.releases[update_publish.CHANNEL]['manifest.json']
        second = self.prepare('0.22.0', {'sha256': 'f' * 64, 'url': 'https://u.example/r.tar.xz', 'size': 10, 'unpacked_size': 20})
        self.assertFalse((second / 'manifest.json').exists())
        self.assertEqual(verify_device(second, self.public, '0.22.0')['runtime']['sha256'], 'f' * 64)
        gh.releases['v0.22.0'] = {p.name: p.read_bytes() for p in second.iterdir()}
        advance_feed(second, self.public, 'a' * 40, gh)
        feed = gh.releases[update_publish.CHANNEL]
        self.assertEqual(feed['manifest.json'], legacy)
        self.assertEqual(json.loads(feed['update.json'])['version'], '0.22.0')

    def test_feed_never_goes_backwards(self):
        newer = self.prepare('0.22.0')
        gh = self.published(newer)
        advance_feed(newer, self.public, 'a' * 40, gh)
        older = self.prepare('0.21.0')
        gh.releases['v0.21.0'] = {p.name: p.read_bytes() for p in older.iterdir()}
        with self.assertRaisesRegex(ValueError, 'backwards'):
            advance_feed(older, self.public, 'a' * 40, gh)


if __name__ == '__main__':
    unittest.main()
