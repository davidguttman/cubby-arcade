#!/usr/bin/python3
"""Hold Cubby's boot art on screen, with a progress bar, until the hub has painted.

Nothing else draws between the early splash and the hub, so without this the
handheld shows black, then a white window. Two surfaces cover that time:

- Before Sway: the kernel framebuffer. The text console is unbound first, because
  systemd's console reset and ROCKNIX's boot messages would otherwise wipe the art.
- Once Sway runs: an overlay layer surface above every window, so Cog's blank
  window never shows. The overlay takes no input and is gone when this exits.

The stars twinkle on both surfaces. Each one is a few small rows redrawn from levels
worked out once at the start, so the animation costs little while the system boots.

Stdlib only: it runs on the host, outside the chroot, early in boot. Any failure
just leaves the screen to whatever is underneath. It must never hold up boot.
"""
from __future__ import annotations

import argparse
import hashlib
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
BAR_BOX = (BAR_X, BAR_Y, BAR_W, BAR_H)

# The art lives on /flash, outside updates, so a device can hold art other than this.
# The stars below only fit this exact art. Other art just stays still.
# Both come from `rocknix/boot_splash.py stars rocknix/splash/splash-32.raw`.
STARS_ART_SHA256 = '8e63b06b54ea253f5216037b3e7ee9c2522b7bd33c3eee51d7fc2c634402c5cc'
STARS = (
    (536, 7, 4, 3), (89, 8, 4, 4), (282, 10, 3, 4), (385, 10, 6, 7), (477, 10, 7, 7),
    (152, 11, 4, 4), (201, 11, 5, 4), (33, 13, 3, 4), (510, 16, 4, 3), (61, 18, 7, 7),
    (453, 19, 4, 4), (617, 20, 4, 4), (173, 21, 3, 4), (265, 22, 4, 4), (413, 22, 7, 7),
    (497, 22, 4, 3), (585, 23, 10, 9), (131, 24, 9, 8), (106, 27, 3, 3), (536, 27, 4, 4),
    (19, 29, 5, 5), (512, 29, 8, 8), (40, 33, 4, 3), (62, 37, 29, 30), (542, 37, 29, 29),
    (116, 44, 3, 3), (483, 44, 4, 3), (623, 44, 3, 4), (29, 56, 5, 5), (611, 58, 6, 5),
    (503, 68, 4, 3), (18, 70, 4, 4), (122, 71, 4, 4), (580, 72, 4, 4), (105, 75, 4, 3),
    (520, 81, 7, 8), (17, 82, 4, 5), (619, 84, 4, 4), (566, 86, 3, 4), (111, 91, 4, 4),
    (588, 94, 8, 8), (52, 98, 11, 10), (548, 99, 4, 4), (79, 102, 3, 4), (122, 103, 4, 4),
    (20, 105, 4, 4), (516, 105, 4, 3), (106, 113, 8, 8), (528, 115, 10, 11), (558, 119, 3, 3),
    (621, 121, 4, 4), (584, 123, 4, 4), (21, 124, 3, 4), (498, 127, 3, 4), (128, 133, 22, 22),
    (77, 135, 4, 4), (621, 135, 3, 3), (35, 137, 4, 4), (451, 138, 3, 4), (564, 138, 5, 5),
    (180, 139, 3, 4), (609, 143, 4, 3), (95, 147, 5, 5), (437, 148, 4, 3), (472, 148, 18, 17),
    (521, 150, 4, 4), (238, 151, 4, 4), (114, 157, 4, 4), (24, 159, 5, 5), (543, 161, 4, 4),
    (603, 161, 5, 5), (158, 167, 3, 3), (52, 173, 4, 4), (459, 174, 4, 4), (76, 175, 11, 10),
    (577, 179, 12, 11), (509, 181, 3, 4), (527, 182, 4, 4), (618, 185, 4, 4), (555, 188, 4, 3),
    (133, 189, 3, 4), (173, 192, 5, 4), (30, 193, 5, 5), (492, 196, 4, 3), (65, 201, 4, 4),
    (604, 207, 4, 4), (113, 208, 4, 4), (504, 208, 3, 3), (477, 211, 4, 4), (13, 213, 4, 3),
    (56, 217, 4, 4), (171, 218, 4, 4), (414, 218, 8, 8), (567, 218, 5, 5), (142, 221, 3, 4),
    (91, 223, 4, 4), (545, 224, 4, 3), (492, 231, 3, 3), (615, 232, 4, 4), (590, 234, 4, 5),
    (200, 235, 4, 4), (527, 235, 11, 10), (76, 243, 4, 5), (193, 243, 3, 4), (476, 244, 3, 3),
    (117, 247, 10, 10), (36, 251, 4, 4), (553, 251, 3, 3), (507, 255, 4, 4), (487, 260, 3, 4),
    (56, 264, 3, 4), (619, 264, 4, 4), (18, 266, 3, 4), (518, 276, 6, 5), (601, 277, 8, 8),
    (40, 282, 11, 10), (560, 282, 4, 4), (139, 289, 4, 4), (537, 294, 4, 4), (512, 303, 3, 4),
    (66, 306, 5, 4), (28, 309, 3, 4), (605, 314, 4, 5), (572, 317, 4, 5), (495, 319, 10, 10),
    (50, 321, 4, 4), (99, 322, 11, 11), (472, 330, 3, 4), (66, 336, 4, 3), (482, 341, 3, 3),
    (535, 343, 11, 10), (459, 348, 4, 4),
)
TWINKLE_LEVELS = 8
TWINKLE_DEPTH = 0.65  # How far a star fades at the bottom of a twinkle.
TWINKLE_SHARE = 0.35  # How much of its cycle a star spends twinkling. It rests for the rest.
TWINKLE_SOFT = 16  # Light this close to the sky fades less, so a star's box never shows.


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


def twinkle_at(index, elapsed):
    """A star's brightness, 1 at rest. Each has its own pace, so they never pulse together."""
    pace = 3.0 + (index * 0.381966 % 1) * 4.0
    phase = (elapsed / pace + index * 0.618034) % 1
    if phase >= TWINKLE_SHARE:
        return 1.0
    return 1 - TWINKLE_DEPTH * math.sin(math.pi * phase / TWINKLE_SHARE) ** 2


def stars_for(art):
    """The star boxes, if this is the art they were found in."""
    return STARS if hashlib.sha256(art).hexdigest() == STARS_ART_SHA256 else ()


class Star:
    """One star's box, with its rows at each brightness worked out the first time they're needed."""

    def __init__(self, art, box):
        x, y, width, height = self.box = box
        self.offsets = [(y + row) * STRIDE + x * 4 for row in range(height)]
        self.rows = [art[offset:offset + width * 4] for offset in self.offsets]
        edge = self.rows[0] + self.rows[-1] + b''.join(row[:4] + row[-4:] for row in self.rows)
        self.sky = [sorted(edge[channel::4])[len(edge) // 8] for channel in range(3)]
        self.levels = {}

    def at(self, level):
        if level not in self.levels:
            self.levels[level] = list(zip(self.offsets, self.faded(level)))
        return self.levels[level]

    def faded(self, level):
        """Fade towards the sky around the star. Dim light goes first, so its points draw in."""
        brightness = (1 - TWINKLE_DEPTH) + TWINKLE_DEPTH * level / (TWINKLE_LEVELS - 1)
        sky = self.sky
        lit = max(1, max(max(row[index] - sky[index % 4] for index in range(len(row)) if index % 4 != 3)
                         for row in self.rows))
        rows = []
        for row in self.rows:
            pixels = bytearray(row)
            for offset in range(0, len(row), 4):
                glow = max(row[offset + channel] - sky[channel] for channel in range(3))
                if glow <= 0:
                    continue
                keep = brightness ** (1 + 2 * (1 - glow / lit))
                keep = 1 - min(1, glow / TWINKLE_SOFT) * (1 - keep)
                for channel in range(3):
                    pixels[offset + channel] = round(sky[channel] + (row[offset + channel] - sky[channel]) * keep)
            rows.append(bytes(pixels))
        return rows


class Twinkle:
    """The stars, drawn only when one has changed brightness."""

    def __init__(self, art, boxes):
        self.stars = [Star(art, box) for box in boxes]
        self.forget()

    def forget(self):
        """A fresh copy of the art went up, so every star is back to full brightness."""
        self.shown = [TWINKLE_LEVELS - 1] * len(self.stars)

    def at(self, elapsed):
        """(rows, boxes) for the stars that changed since the last call."""
        rows, boxes = [], []
        for index, star in enumerate(self.stars):
            level = round((twinkle_at(index, elapsed) - (1 - TWINKLE_DEPTH)) / TWINKLE_DEPTH * (TWINKLE_LEVELS - 1))
            if self.shown[index] != level:
                self.shown[index] = level
                rows += star.at(level)
                boxes.append(star.box)
        return rows, boxes


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
            self.commit_frame([(0, 0, WIDTH, HEIGHT)])
            self.mapped = True
        elif obj == self.layer and opcode == 1:
            self.closed = True  # No output yet. The caller connects again.

    def commit_frame(self, boxes):
        self.send(message(self.surface, 1, struct.pack('<Iii', self.buffer, 0, 0))
                  + b''.join(message(self.surface, 2, struct.pack('<iiii', *box)) for box in boxes)
                  + message(self.surface, 6))

    def draw(self, rows, boxes):
        for offset, pixels in rows:
            self.pixels[offset:offset + len(pixels)] = pixels
        if self.mapped:
            self.commit_frame(boxes)

    def close(self):
        self.sock.close()


def run(args, now=None, sleep=time.sleep):
    now = now or (lambda: time.clock_gettime(time.CLOCK_BOOTTIME))
    art = Path(args.art).read_bytes()
    if len(art) != STRIDE * HEIGHT:
        raise ValueError('Unexpected art size')
    stars = stars_for(art)
    art = opaque(art)
    try:
        expected = float(Path(args.seconds_file).read_text())
    except (OSError, ValueError):
        expected = DEFAULT_SECONDS
    bar = Bar(art)
    twinkle = Twinkle(art, stars)
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
                        twinkle.forget()
            filled = round(BAR_W * fraction_at(elapsed, expected))
            rows, boxes = twinkle.at(elapsed)
            if filled != drawn:
                rows += bar.at(filled)
                boxes.append(BAR_BOX)
                drawn = filled
            if rows:
                if fb is not None:
                    fb.draw(rows)
                if overlay is not None and overlay.mapped:
                    overlay.draw(rows, boxes)
            if overlay is not None:
                select.select([overlay.sock], [], [], FRAME_SECONDS)
            else:
                sleep(FRAME_SECONDS)
        if finished:
            rows = bar.at(BAR_W)
            if overlay is not None and overlay.mapped:
                overlay.draw(rows, [BAR_BOX])
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
