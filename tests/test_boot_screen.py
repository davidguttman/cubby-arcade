"""The boot screen holds the art until the hub paints, and never holds up boot."""
import array
import argparse
import importlib.util
import mmap
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
from unittest import mock

from rocknix import network, update_release

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'runtime/native/rg353v/boot-screen'
spec = importlib.util.spec_from_file_location('boot_screen', BUNDLE / 'boot-screen.py')
boot_screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_screen)
ART = (bytes(range(250)) * 5000)[:boot_screen.STRIDE * boot_screen.HEIGHT]
FILL_PIXEL = bytes((*boot_screen.FILL, 255))
REAL_SELECT = boot_screen.select.select


class FakeCompositor(threading.Thread):
    """Just enough of a compositor to see what the overlay asks for."""

    def __init__(self, path, close_first=False):
        super().__init__(daemon=True)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(path))
        self.listener.listen()
        self.close_first = close_first
        self.requests = []
        self.pool = None
        self.connections = 0
        self.names = {1: 'wl_compositor', 2: 'wl_shm', 3: 'zwlr_layer_shell_v1'}
        self.start()

    def run(self):
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self.serve, args=(client,), daemon=True).start()

    def global_event(self, registry, name, interface):
        text = interface.encode() + b'\0'
        body = struct.pack('<II', name, len(text)) + text + b'\0' * (-len(text) % 4) + struct.pack('<I', 4)
        return boot_screen.message(registry, 0, body)

    def serve(self, client):
        buffered = b''
        bound = {}
        layer = None
        while True:
            fds = array.array('i')
            try:
                data, ancillary, _, _ = client.recvmsg(65536, socket.CMSG_LEN(16))
            except OSError:
                return
            if not data:
                return
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    fds.frombytes(payload)
            if fds:
                self.pool = fds[0]
            buffered += data
            while len(buffered) >= 8:
                obj, opcode, size = struct.unpack_from('<IHH', buffered)
                if len(buffered) < size:
                    break
                body = buffered[8:size]
                buffered = buffered[size:]
                self.requests.append((obj, opcode, body))
                if obj == 1 and opcode == 1:
                    registry = struct.unpack('<I', body)[0]
                    for name, interface in self.names.items():
                        client.sendall(self.global_event(registry, name, interface))
                elif obj == 1 and opcode == 0:
                    callback = struct.unpack('<I', body)[0]
                    client.sendall(boot_screen.message(callback, 0, struct.pack('<I', 0)))
                elif obj == 2 and opcode == 0:  # wl_registry.bind
                    length = struct.unpack_from('<I', body, 4)[0]
                    interface = body[8:7 + length].decode()
                    bound[interface] = struct.unpack_from('<I', body, 8 + length + (-length % 4) + 4)[0]
                elif obj == bound.get('zwlr_layer_shell_v1') and opcode == 0:
                    layer, _, self.output, self.layer_kind = struct.unpack_from('<IIII', body)
                elif layer and obj != layer and opcode == 6 and not getattr(self, 'configured', False):
                    # The first surface commit asks to be configured.
                    if self.close_first:
                        self.close_first = False
                        client.sendall(boot_screen.message(layer, 1))
                        layer = None
                    else:
                        self.configured = True
                        client.sendall(boot_screen.message(layer, 0, struct.pack('<III', 77, 640, 480)))
                elif obj == layer and opcode == 6:
                    self.acked = struct.unpack('<I', body)[0]

    def close(self):
        self.listener.close()


def arguments(directory, limit=30.0):
    return argparse.Namespace(art=str(directory / 'art.raw'), runtime_dir=str(directory),
                              seconds_file=str(directory / 'seconds'), limit=limit,
                              relative=False, no_framebuffer=True)


class Clock:
    """Boot time that moves only as the screen waits, and acts at chosen moments."""

    def __init__(self, at=()):
        self.time = 5.0
        self.at = sorted(at, key=lambda item: item[0])

    def __call__(self):
        return self.time

    def sleep(self, seconds):
        self.time += seconds
        while self.at and self.at[0][0] <= self.time:
            self.at.pop(0)[1]()


class ProgressTests(unittest.TestCase):
    def test_progress_rises_and_only_ready_completes_it(self):
        values = [boot_screen.fraction_at(second, 28) for second in range(0, 400)]
        self.assertEqual(values, sorted(values))
        self.assertAlmostEqual(boot_screen.fraction_at(28, 28), .9)
        self.assertLess(values[-1], 1)

    def test_bar_is_lit_up_to_the_filled_width_over_darkened_art(self):
        bar = boot_screen.Bar(ART)
        rows = bar.at(10)
        self.assertEqual(len(rows), boot_screen.BAR_H)
        offset, pixels = rows[3]
        self.assertEqual(offset, (boot_screen.BAR_Y + 3) * boot_screen.STRIDE + boot_screen.BAR_X * 4)
        self.assertEqual(len(pixels), boot_screen.BAR_W * 4)
        self.assertEqual(pixels[:40], FILL_PIXEL * 10)
        self.assertEqual(pixels[40:43], bytes(value // 3 for value in ART[offset + 40:offset + 43]))
        self.assertEqual(pixels[43], 255)
        self.assertEqual(bar.at(boot_screen.BAR_W)[3][1], FILL_PIXEL * boot_screen.BAR_W)
        self.assertNotIn(FILL_PIXEL, bar.at(0)[3][1][:4])

    def test_bar_keeps_rounded_corners_at_every_width(self):
        for filled in (0, 1, 150, boot_screen.BAR_W):
            top = boot_screen.Bar(ART).at(filled)[0]
            self.assertEqual(top[0], boot_screen.BAR_Y * boot_screen.STRIDE + (boot_screen.BAR_X + 1) * 4)
            self.assertEqual(len(top[1]), (boot_screen.BAR_W - 2) * 4)


class FramebufferTests(unittest.TestCase):
    def sysfs(self, root, **overrides):
        values = {'virtual_size': '640,480', 'bits_per_pixel': '32', 'stride': '2560', 'pan': '0,0'}
        for name, value in (values | overrides).items():
            (root / name).write_text(value + '\n')
        return root

    def test_writes_art_and_bar_to_the_framebuffer(self):
        with tempfile.TemporaryDirectory() as name:
            root = self.sysfs(Path(name))
            device = root / 'fb0'
            device.write_bytes(bytes(len(ART)))
            fb = boot_screen.Framebuffer(device, root)
            fb.show(ART)
            self.assertEqual(device.read_bytes(), ART)
            rows = boot_screen.Bar(ART).at(50)
            fb.draw(rows)
            fb.close()
            offset, pixels = rows[2]
            self.assertEqual(device.read_bytes()[offset:offset + len(pixels)], pixels)

    def test_refuses_any_other_layout(self):
        for overrides in ({'bits_per_pixel': '16'}, {'stride': '1280'}, {'pan': '0,480'}, {'virtual_size': '640,960'}):
            with tempfile.TemporaryDirectory() as name:
                root = self.sysfs(Path(name), **overrides)
                (root / 'fb0').write_bytes(b'')
                with self.assertRaisesRegex(ValueError, 'Unsupported'):
                    boot_screen.Framebuffer(root / 'fb0', root)

    def test_unbinds_only_the_framebuffer_console(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for console, label in (('vtcon0', '(S) dummy device'), ('vtcon1', '(M) frame buffer device')):
                (root / console).mkdir()
                (root / console / 'name').write_text(label + '\n')
                (root / console / 'bind').write_text('1\n')
            boot_screen.unbind_text_console(root)
            self.assertEqual((root / 'vtcon0/bind').read_text(), '1\n')
            self.assertEqual((root / 'vtcon1/bind').read_text(), '0\n')


class OverlayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        (self.directory / 'art.raw').write_bytes(ART)

    def run_screen(self, compositor, clock, limit=30.0):
        def waited(rlist, wlist, xlist, timeout):
            clock.sleep(timeout)
            return REAL_SELECT(rlist, wlist, xlist, 0.01)
        with mock.patch.object(boot_screen.select, 'select', waited):
            return boot_screen.run(arguments(self.directory, limit), now=clock, sleep=clock.sleep)

    def test_overlay_covers_the_screen_until_the_hub_paints(self):
        compositor = FakeCompositor(self.directory / 'wayland-1')
        self.addCleanup(compositor.close)
        ready = self.directory / 'cubby-ui-ready'
        self.assertTrue(self.run_screen(compositor, Clock([(9, ready.touch)])))
        self.assertEqual(compositor.layer_kind, boot_screen.OVERLAY_LAYER)
        self.assertEqual(compositor.acked, 77)
        pixels = mmap.mmap(compositor.pool, len(ART))
        filled = boot_screen.Bar(boot_screen.opaque(ART)).at(boot_screen.BAR_W)[3]
        self.assertEqual(pixels[filled[0]:filled[0] + len(filled[1])], filled[1])
        self.assertEqual(pixels[:4096], boot_screen.opaque(ART)[:4096])
        self.assertEqual(set(pixels[3:4096:4]), {255})
        # The buffer format must have alpha: an opaque overlay stops the hub painting.
        buffers = [struct.unpack('<IiiiiI', body) for _, opcode, body in compositor.requests
                   if opcode == 0 and len(body) == 24 and body[12:16] == struct.pack('<i', boot_screen.HEIGHT)]
        self.assertEqual(len(buffers), 1)
        self.assertEqual(buffers[0][5], boot_screen.ARGB8888)
        self.assertEqual(boot_screen.ARGB8888, 0)
        # An empty input region, so controls reach the hub underneath.
        kinds = [(opcode, body) for _, opcode, body in compositor.requests if opcode == 5 and len(body) == 4]
        self.assertTrue(kinds)
        self.assertGreater(float((self.directory / 'seconds').read_text()), 8)

    def test_connects_again_if_no_output_was_ready(self):
        compositor = FakeCompositor(self.directory / 'wayland-1', close_first=True)
        self.addCleanup(compositor.close)
        ready = self.directory / 'cubby-ui-ready'
        self.assertTrue(self.run_screen(compositor, Clock([(12, ready.touch)])))
        self.assertEqual(compositor.connections, 2)
        self.assertEqual(compositor.acked, 77)

    def test_a_hub_that_never_paints_still_reveals_recovery(self):
        compositor = FakeCompositor(self.directory / 'wayland-1')
        self.addCleanup(compositor.close)
        self.assertFalse(self.run_screen(compositor, Clock(), limit=8))
        self.assertFalse((self.directory / 'seconds').exists())

    def test_uses_the_last_boots_time_for_the_estimate(self):
        (self.directory / 'seconds').write_text('40.0\n')
        ready = self.directory / 'cubby-ui-ready'
        drawn = []
        real = boot_screen.Bar.at
        with mock.patch.object(boot_screen.Bar, 'at', lambda bar, filled: drawn.append(filled) or real(bar, filled)):
            clock = Clock([(20, ready.touch)])
            boot_screen.run(arguments(self.directory), now=clock, sleep=clock.sleep)
        self.assertLessEqual(max(drawn[:-1]), round(boot_screen.BAR_W * .9 * 20.2 / 40))
        self.assertEqual(drawn[-1], boot_screen.BAR_W)

    def test_runs_without_art_rather_than_failing_boot(self):
        (self.directory / 'art.raw').unlink()
        args = arguments(self.directory)
        with mock.patch.object(boot_screen.argparse.ArgumentParser, 'parse_args', return_value=args):
            boot_screen.main()


class InstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.storage = Path(temporary.name) / 'storage'
        (self.storage / '.config/system.d').mkdir(parents=True)

    def test_installs_the_unit_and_repeats_harmlessly(self):
        for _ in range(2):
            network.install_boot_screen(ROOT, storage=self.storage)
            system = self.storage / '.config/system.d'
            self.assertEqual((system / network.BOOT_SCREEN_UNIT).read_bytes(),
                             (BUNDLE / network.BOOT_SCREEN_UNIT).read_bytes())
            self.assertEqual(os.readlink(system / 'sysinit.target.wants' / network.BOOT_SCREEN_UNIT),
                             '../' + network.BOOT_SCREEN_UNIT)

    def test_replaces_an_older_unit(self):
        unit = self.storage / '.config/system.d' / network.BOOT_SCREEN_UNIT
        unit.write_text('hand-installed prototype')
        network.install_boot_screen(ROOT, storage=self.storage)
        self.assertEqual(unit.read_bytes(), (BUNDLE / network.BOOT_SCREEN_UNIT).read_bytes())

    def release_script(self, root):
        script = root / 'cubby/releases/app-1/app/rocknix/network.py'
        script.parent.mkdir(parents=True)
        script.write_text('')
        return script

    def test_waits_for_the_release_to_pass_its_trial(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve()
            script = self.release_script(root)
            pending = root / 'cubby/updates/pending.json'
            pending.parent.mkdir()
            pending.write_text('{}')
            installs = []
            network.install_boot_screen_once_confirmed(
                script, sleep=lambda seconds: (self.assertEqual(installs, []), pending.unlink()),
                install=lambda app, storage: installs.append((app, storage)))
            self.assertEqual(installs, [(root / 'cubby/releases/app-1/app', root)])

    def test_a_failed_install_never_breaks_the_helper(self):
        with tempfile.TemporaryDirectory() as name:
            script = self.release_script(Path(name).resolve())
            network.install_boot_screen_once_confirmed(script, install=mock.Mock(side_effect=OSError('read-only')))

    def test_does_nothing_outside_an_installed_release(self):
        install = mock.Mock()
        network.install_boot_screen_once_confirmed(ROOT / 'rocknix/network.py', install=install)
        install.assert_not_called()


class ReleaseTests(unittest.TestCase):
    def test_update_packages_carry_the_boot_screen(self):
        for name in ('boot-screen.py', network.BOOT_SCREEN_UNIT):
            path = f'{network.BOOT_SCREEN_BUNDLE}/{name}'
            self.assertTrue((ROOT / path).is_file())
            self.assertEqual(update_release.app_path(path), path)

    def test_platform_package_carries_the_boot_screen(self):
        named = {name for name, _ in update_release.platform_entries(ROOT)}
        for name in ('boot-screen.py', network.BOOT_SCREEN_UNIT):
            self.assertIn(f'{network.BOOT_SCREEN_BUNDLE}/{name}', named)

    def test_unit_runs_from_the_current_release_and_stays_out_of_recovery(self):
        unit = (BUNDLE / network.BOOT_SCREEN_UNIT).read_text()
        self.assertIn('/storage/cubby/current/app/runtime/native/rg353v/boot-screen/boot-screen.py', unit)
        self.assertIn('ConditionPathExists=!/flash/CUBBY-DISABLED', unit)
        self.assertIn('ConditionPathExists=!/storage/cubby/DISABLED', unit)
        self.assertIn('Restart=no', unit)


if __name__ == '__main__':
    unittest.main()
