#!/usr/bin/python3
"""Hold Cubby's boot art on screen, with a progress bar, until the hub has painted.

Nothing else draws between the early splash and the hub, so without this the
handheld shows black, then a white window. Two surfaces cover that time:

- Before Sway: the kernel framebuffer. The text console is unbound first, because
  systemd's console reset and ROCKNIX's boot messages would otherwise wipe the art.
- Once Sway runs: an overlay layer surface above every window, so Cog's blank
  window never shows. The overlay takes no input and is gone when this exits.

Stdlib only: it runs on the host, outside the chroot, early in boot. Any failure
just leaves the screen to whatever is underneath. It must never hold up boot.
"""
from __future__ import annotations

import argparse
import math
import mmap
import os
from pathlib import Path
import select
import socket
import struct
import tempfile
import time

WIDTH, HEIGHT = 640, 480
STRIDE = WIDTH * 4
BAR_X, BAR_Y, BAR_W, BAR_H = 170, 450, 300, 8
FILL = (0x45, 0xbb, 0xff)  # BGR of the hub's yellow, matching the pixel byte order.
# A format with alpha, on purpose. Sway stops sending frame callbacks to windows
# under an opaque surface, and then the hub never gets far enough to report it
# has painted, so this would wait for a signal it was itself preventing.
ARGB8888 = 0
OVERLAY_LAYER = 3
DEFAULT_SECONDS = 28.0  # Measured kernel start to hub paint on an RG353V.
FRAME_SECONDS = 0.1


def fraction_at(elapsed, expected):
    """Boot progress. Reaches 90% at the expected time, then creeps without ever finishing."""
    expected = max(expected, 1.0)
    if elapsed <= expected:
        return max(0.0, 0.9 * elapsed / expected)
    return 0.9 + 0.09 * (1 - math.exp((expected - elapsed) / 15))


def opaque(art):
    """The art with every pixel's alpha set. The rasters leave that byte zero."""
    pixels = bytearray(art)
    pixels[3::4] = b'\xff' * (len(pixels) // 4)
    return bytes(pixels)


class Bar:
    """The progress bar composited onto the art, rendered once per row."""

    def __init__(self, art):
        self.rows = []
        for row in range(BAR_H):
            # Rounded ends: the corner pixels stay as bare art.
            inset = 1 if row in (0, BAR_H - 1) else 0
            offset = (BAR_Y + row) * STRIDE + (BAR_X + inset) * 4
            under = art[offset:offset + (BAR_W - inset * 2) * 4]
            track = bytearray(value // 3 for value in under)
            track[3::4] = b'\xff' * (len(track) // 4)
            track = bytes(track)
            self.rows.append((offset, inset, bytes((*FILL, 255)) * (BAR_W - inset * 2), track))

    def at(self, filled):
        """(byte offset, pixels) per row, with the first `filled` pixels lit."""
        rows = []
        for offset, inset, fill, track in self.rows:
            split = max(0, filled - inset) * 4
            rows.append((offset, fill[:split] + track[split:]))
        return rows


class Framebuffer:
    """The kernel framebuffer, written with the same path as the early splash's dd."""

    def __init__(self, device='/dev/fb0', sysfs='/sys/class/graphics/fb0'):
        sys = Path(sysfs)
        if (sys.joinpath('virtual_size').read_text().strip() != f'{WIDTH},{HEIGHT}'
                or sys.joinpath('bits_per_pixel').read_text().strip() != '32'
                or sys.joinpath('stride').read_text().strip() != str(STRIDE)
                or sys.joinpath('pan').read_text().strip() != '0,0'):
            raise ValueError('Unsupported framebuffer')
        self.fd = os.open(device, os.O_RDWR)

    def show(self, art):
        os.pwrite(self.fd, art, 0)

    def draw(self, rows):
        for offset, pixels in rows:
            os.pwrite(self.fd, pixels, offset)

    def close(self):
        os.close(self.fd)


def unbind_text_console(vtconsole='/sys/class/vtconsole'):
    """Stop the text console drawing on the framebuffer. Sway never needs it."""
    for console in Path(vtconsole).glob('vtcon*'):
        if 'frame buffer' in console.joinpath('name').read_text():
            console.joinpath('bind').write_text('0\n')


def message(obj, opcode, args=b''):
    return struct.pack('<IHH', obj, opcode, 8 + len(args)) + args


def wl_string(text):
    data = text.encode() + b'\0'
    return struct.pack('<I', len(data)) + data + b'\0' * (-len(data) % 4)


class Overlay:
    """A minimal Wayland client: one shared-memory overlay surface over the whole output."""

    def __init__(self, path, art):
        self.art = art
        self.runtime_dir = Path(path).parent
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.setblocking(False)
        self.sock.connect(str(path))
        self.incoming = b''
        self.ids = 1
        self.globals = {}
        self.mapped = False
        self.closed = False
        self.layer = None
        self.registry = self.new_id()
        self.sync = self.new_id()
        self.send(message(1, 1, struct.pack('<I', self.registry)))
        self.send(message(1, 0, struct.pack('<I', self.sync)))

    def new_id(self):
        self.ids += 1
        return self.ids

    def send(self, data, fds=()):
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack(f'{len(fds)}i', *fds))] if fds else []
        self.sock.setblocking(True)
        try:
            self.sock.sendmsg([data], ancillary)
        finally:
            self.sock.setblocking(False)

    def bind(self, interface, version):
        name, advertised = self.globals[interface]
        new = self.new_id()
        self.send(message(self.registry, 0, struct.pack('<I', name) + wl_string(interface)
                          + struct.pack('<II', min(version, advertised), new)))
        return new

    def create_surface(self):
        compositor = self.bind('wl_compositor', 1)
        shm = self.bind('wl_shm', 1)
        shell = self.bind('zwlr_layer_shell_v1', 1)
        self.surface = self.new_id()
        self.send(message(compositor, 0, struct.pack('<I', self.surface)))
        region = self.new_id()  # An empty input region: input goes to whatever is below.
        self.send(message(compositor, 1, struct.pack('<I', region)))
        self.send(message(self.surface, 5, struct.pack('<I', region)))
        size = len(self.art)
        pool = self.new_id()
        with tempfile.TemporaryFile(dir=self.runtime_dir) as shared:  # Unlinked, on tmpfs.
            os.ftruncate(shared.fileno(), size)
            self.pixels = mmap.mmap(shared.fileno(), size)
            self.pixels[:] = self.art
            self.send(message(shm, 0, struct.pack('<Ii', pool, size)), [shared.fileno()])
        self.buffer = self.new_id()
        self.send(message(pool, 0, struct.pack('<IiiiiI', self.buffer, 0, WIDTH, HEIGHT, STRIDE, ARGB8888)))
        self.layer = self.new_id()
        self.send(message(shell, 0, struct.pack('<IIII', self.layer, self.surface, 0, OVERLAY_LAYER)
                          + wl_string('cubby-boot-screen')))
        self.send(message(self.layer, 0, struct.pack('<II', WIDTH, HEIGHT)))
        self.send(message(self.surface, 6))

    def pump(self):
        """Handle whatever the compositor has sent. Raises once the connection is gone."""
        try:
            data = self.sock.recv(65536)
        except BlockingIOError:
            return
        if not data:
            raise ConnectionError('Compositor closed')
        self.incoming += data
        while len(self.incoming) >= 8:
            obj, opcode, size = struct.unpack_from('<IHH', self.incoming)
            if len(self.incoming) < size:
                return
            self.event(obj, opcode, self.incoming[8:size])
            self.incoming = self.incoming[size:]

    def event(self, obj, opcode, body):
        if obj == 1 and opcode == 0:
            raise ConnectionError('Compositor rejected the overlay')
        if obj == self.registry and opcode == 0:
            name, length = struct.unpack_from('<II', body)
            version = struct.unpack_from('<I', body, 8 + length + (-length % 4))[0]
            self.globals[body[8:7 + length].decode()] = (name, version)
        elif obj == self.sync and opcode == 0:
            self.create_surface()
        elif obj == self.layer and opcode == 0:
            serial = struct.unpack_from('<I', body)[0]
            self.send(message(self.layer, 6, struct.pack('<I', serial)))
            self.commit_frame(0, HEIGHT)
            self.mapped = True
        elif obj == self.layer and opcode == 1:
            self.closed = True  # No output yet. The caller connects again.

    def commit_frame(self, y, height):
        self.send(message(self.surface, 1, struct.pack('<Iii', self.buffer, 0, 0))
                  + message(self.surface, 2, struct.pack('<iiii', 0, y, WIDTH, height))
                  + message(self.surface, 6))

    def draw(self, rows):
        for offset, pixels in rows:
            self.pixels[offset:offset + len(pixels)] = pixels
        if self.mapped:
            self.commit_frame(BAR_Y, BAR_H)

    def close(self):
        self.sock.close()


def run(args, now=None, sleep=time.sleep):
    now = now or (lambda: time.clock_gettime(time.CLOCK_BOOTTIME))
    art = Path(args.art).read_bytes()
    if len(art) != STRIDE * HEIGHT:
        raise ValueError('Unexpected art size')
    art = opaque(art)
    try:
        expected = float(Path(args.seconds_file).read_text())
    except (OSError, ValueError):
        expected = DEFAULT_SECONDS
    bar = Bar(art)
    begin = now() if args.relative else 0.0
    socket_path = Path(args.runtime_dir) / 'wayland-1'
    ready = Path(args.runtime_dir) / 'cubby-ui-ready'

    fb = None
    if not args.no_framebuffer and not socket_path.exists():
        try:
            unbind_text_console()
            fb = Framebuffer()
            fb.show(art)
        except (OSError, ValueError) as error:
            print('Cubby boot screen: framebuffer unavailable:', error, flush=True)
            fb = None

    overlay = None
    drawn = -1
    finished = False
    try:
        while True:
            elapsed = now() - begin
            finished = ready.exists()
            if finished or elapsed > args.limit:
                break
            if overlay is None and socket_path.exists():
                try:
                    overlay = Overlay(socket_path, art)
                except OSError:
                    overlay = None
            if overlay is not None:
                try:
                    overlay.pump()
                except (OSError, struct.error, KeyError, ValueError) as error:
                    print('Cubby boot screen: reconnecting:', error, flush=True)
                    overlay.close()
                    overlay = None
                else:
                    if overlay.closed:
                        overlay.close()
                        overlay = None
                    elif overlay.mapped and fb is not None:
                        fb.close()
                        fb = None
                        drawn = -1  # The overlay's buffer has no bar on it yet.
            filled = round(BAR_W * fraction_at(elapsed, expected))
            if filled != drawn:
                rows = bar.at(filled)
                if fb is not None:
                    fb.draw(rows)
                if overlay is not None and overlay.mapped:
                    overlay.draw(rows)
                drawn = filled
            if overlay is not None:
                select.select([overlay.sock], [], [], FRAME_SECONDS)
            else:
                sleep(FRAME_SECONDS)
        if finished:
            rows = bar.at(BAR_W)
            if overlay is not None and overlay.mapped:
                overlay.draw(rows)
            elif fb is not None:
                fb.draw(rows)
            sleep(0.15)
            if not args.relative:
                write_seconds(args.seconds_file, now() - begin)
    finally:
        if overlay is not None:
            overlay.close()
        if fb is not None:
            fb.close()
    return finished


def write_seconds(path, seconds):
    temporary = f'{path}.tmp'
    try:
        Path(temporary).write_text(f'{seconds:.1f}\n')
        os.replace(temporary, path)
    except OSError as error:
        print('Cubby boot screen: could not save boot time:', error, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--art', default='/flash/cubby-splash/splash-32.raw')
    parser.add_argument('--runtime-dir', default='/var/run/0-runtime-dir')
    parser.add_argument('--seconds-file', default='/storage/cubby/state/boot-seconds')
    parser.add_argument('--limit', type=float, default=60.0,
                        help='Give up after this long, so a failed hub still reveals recovery.')
    parser.add_argument('--relative', action='store_true', help='Time from now, not kernel start (testing).')
    parser.add_argument('--no-framebuffer', action='store_true')
    args = parser.parse_args()
    try:
        run(args)
    except (OSError, ValueError) as error:
        print('Cubby boot screen stopped:', error, flush=True)


if __name__ == '__main__':
    main()
