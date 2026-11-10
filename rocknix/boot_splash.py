#!/usr/bin/env -S uv run --script
"""Build splash rasters or install/remove them on an OFFLINE mounted Cubby boot partition.

Never pass a block device. Power the handheld off and mount its FAT boot
partition on the computer first. This does not write KERNEL, SYSTEM or saves.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Exact pre-diagnostics image hook from 3c113fc, also found on the live RG353V.
LEGACY_BOOT_HOOK_SHA256 = '718957a1a6d059cd5f44d754f75a63024d69f7b03682c6f31436996c6c7ac213'
SPLASH_HOOK = '''
# Cubby boot artwork: stock init calls load_splash after mount_sysroot.
if [ -f /flash/cubby-splash/load.sh ]; then
  . /flash/cubby-splash/load.sh
fi
'''


def pack(rgb: bytes, depth: int) -> bytes:
    """Technical little-endian framebuffer encoding, not artwork generation."""
    if len(rgb) % 3 or depth not in (16, 32):
        raise ValueError('Expected complete RGB pixels and 16/32-bit output')
    result = bytearray()
    for r, g, b in zip(rgb[::3], rgb[1::3], rgb[2::3]):
        if depth == 32:
            result.extend((b, g, r, 0))
        else:
            result.extend((((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)).to_bytes(2, 'little'))
    return bytes(result)


def find_stars(raster: bytes) -> list[tuple[int, int, int, int]]:
    """Where the stars are in the 32-bit art, as (x, y, width, height) boxes around each glow.

    A star is a small lit shape on the open sky. Everything else is left alone: the
    wordmark and rings are too big, the handheld and landscape are outside the sky,
    and the coloured pickups are filled-in and saturated.
    """
    width, height, threshold = 640, 480, 48
    def luma(x, y):
        offset = (y * width + x) * 4
        return (raster[offset + 2] * 299 + raster[offset + 1] * 587 + raster[offset] * 114) // 1000
    lit = {(x, y) for y in range(345 + 10) for x in range(width) if luma(x, y) >= threshold}
    stars = []
    while lit:
        pending = [lit.pop()]
        shape = []
        while pending:
            x, y = pending.pop()
            shape.append((x, y))
            for near in ((x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                if near in lit:
                    lit.remove(near)
                    pending.append(near)
        xs, ys = [x for x, _ in shape], [y for _, y in shape]
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        if max(right - left, bottom - top) >= 31 or bottom >= 354 or max(luma(x, y) for x, y in shape) < 70:
            continue
        if right > 225 and left < 415 and bottom > 165:  # The handheld.
            continue
        colours = (raster[(y * width + x) * 4:(y * width + x) * 4 + 3] for x, y in shape)
        if len(shape) > 40 and any(max(colour) - min(colour) > 90 for colour in colours):  # A pickup.
            continue
        stars.append((max(left - 1, 0), max(top - 1, 0), right - left + 3, bottom - top + 3))
    return sorted(stars, key=lambda star: (star[1], star[0]))


def prepare(source: Path) -> None:
    # source.png is the finished 4:3 composition. Only exact display-size
    # sampling and pixel-format conversion happen here, with no crop/redesign.
    dimensions = subprocess.check_output(['magick', 'identify', '-format', '%w %h', str(source)], text=True)
    width, height = map(int, dimensions.split())
    if width * 3 != height * 4:
        raise ValueError('Reviewed artwork must be 4:3; refusing to crop/stretch')
    target = ROOT / 'rocknix/splash'
    subprocess.run(['magick', str(source), '-resize', '640x480!', '-strip', str(target / 'preview.png')], check=True)
    rgb = subprocess.check_output(['magick', str(target / 'preview.png'), '-depth', '8', 'rgb:-'])
    if len(rgb) != 640 * 480 * 3:
        raise ValueError('Unexpected raster size')
    for depth in (16, 32):
        name = f'splash-{depth}.raw'
        data = pack(rgb, depth)
        (target / name).write_bytes(data)
        (target / f'splash-{depth}.sha256').write_text(hashlib.sha256(data).hexdigest() + '  ' + name + '\n')


def print_stars(raster_path: Path) -> None:
    """Print the star table for boot-screen.py. Run this after replacing the art."""
    raster = raster_path.read_bytes()
    print(f"STARS_ART_SHA256 = '{hashlib.sha256(raster).hexdigest()}'")
    stars = find_stars(raster)
    print('STARS = (')
    for start in range(0, len(stars), 5):
        print('    ' + ' '.join(f'{star},' for star in stars[start:start + 5]))
    print(')')


def payload(source_root: Path = ROOT) -> dict[str, bytes]:
    result = {'load.sh': (source_root / 'rocknix/device/boot-splash.sh').read_bytes()}
    for depth in (16, 32):
        name = f'splash-{depth}.raw'
        data = (source_root / 'rocknix/splash' / name).read_bytes()
        checksum = (source_root / 'rocknix/splash' / f'splash-{depth}.sha256').read_bytes()
        expected = hashlib.sha256(data).hexdigest() + '  ' + name + '\n'
        if len(data) != 640 * 480 * depth // 8 or checksum != expected.encode():
            raise ValueError('Invalid checked-in splash raster: ' + name)
        result[name] = data
        result[f'splash-{depth}.sha256'] = checksum
    return result


def installation_files(original: bytes, hook: bytes, source_root: Path = ROOT) -> dict[str, bytes]:
    files = payload(source_root) | {'previous-post-sysroot.sh': original}
    manifest = {'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
                'hook_sha256': hashlib.sha256(hook).hexdigest()}
    return files | {'installed.json': (json.dumps(manifest, indent=2) + '\n').encode()}


def checked_flash(path: Path) -> Path:
    if path.is_symlink() or not path.is_dir():
        raise ValueError('Expected offline mounted FAT directory, never a block device or symlink')
    extlinux = [entry for entry in path.iterdir() if entry.name.lower() == 'extlinux']
    if len(extlinux) != 1 or extlinux[0].is_symlink() or not extlinux[0].is_dir():
        raise ValueError('Missing regular Cubby EXTLINUX directory')
    for name in ('KERNEL', 'SYSTEM', str(extlinux[0].relative_to(path) / 'extlinux.conf'), 'post-sysroot.sh'):
        target = path / name
        if target.is_symlink() or not target.is_file():
            raise ValueError('Missing regular Cubby boot file: ' + name)
    return path


def verify_owned(directory: Path) -> dict:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Unmanaged splash directory')
    manifest_path = directory / 'installed.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('Unmanaged splash directory')
    manifest = json.loads(manifest_path.read_text())
    inventory = manifest['files']
    if set(p.name for p in directory.iterdir()) != set(inventory) | {'installed.json'}:
        raise ValueError('Unknown files in splash directory; preserving them')
    for name, digest in inventory.items():
        if '/' in name or name in ('.', '..'):
            raise ValueError('Invalid splash inventory')
        target = directory / name
        if target.is_symlink() or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError('Modified splash file; preserving it: ' + name)
    return manifest


def atomic_write(path: Path, data: bytes) -> None:
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.cubby-tmp-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def install(path: Path) -> None:
    from rocknix.image import BASE_BOOT_HOOK
    flash = checked_flash(path)
    hook = flash / 'post-sysroot.sh'
    target = flash / 'cubby-splash'
    if target.exists() or target.is_symlink():
        manifest = verify_owned(target)
        current = hook.read_bytes()
        if hashlib.sha256(current).hexdigest() == manifest['hook_sha256']:
            return
        if current == (target / 'previous-post-sysroot.sh').read_bytes():
            # Previous invocation staged verified files but never activated.
            activated = current + SPLASH_HOOK.encode()
            if hashlib.sha256(activated).hexdigest() != manifest['hook_sha256']:
                raise ValueError('Inconsistent staged boot hook; preserving it')
            atomic_write(hook, activated)
            return
        raise ValueError('Modified boot hook; preserving it')
    original = hook.read_bytes()
    if original != BASE_BOOT_HOOK.encode() and hashlib.sha256(original).hexdigest() != LEGACY_BOOT_HOOK_SHA256:
        raise ValueError('Refusing unmanaged post-sysroot.sh; expected exact supported Cubby image hook')
    activated = original + SPLASH_HOOK.encode()
    files = installation_files(original, activated)
    with tempfile.TemporaryDirectory(prefix='.cubby-splash-', dir=flash) as temporary:
        stage = Path(temporary) / 'payload'
        stage.mkdir()
        for name, data in files.items():
            (stage / name).write_bytes(data)
        os.rename(stage, target)
    # Publish data first, activate by atomic hook rename last. Interrupted data
    # preparation cannot change boot. If activation fails, leave all evidence.
    atomic_write(hook, activated)


def remove(path: Path) -> None:
    flash = checked_flash(path)
    directory = flash / 'cubby-splash'
    manifest = verify_owned(directory)
    hook = flash / 'post-sysroot.sh'
    if hashlib.sha256(hook.read_bytes()).hexdigest() != manifest['hook_sha256']:
        raise ValueError('Modified boot hook; preserving it')
    atomic_write(hook, (directory / 'previous-post-sysroot.sh').read_bytes())
    shutil.rmtree(directory)  # exact verified owned inventory, after deactivation


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'install', 'remove', 'stars'))
    parser.add_argument('path', type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'stars':
            print_stars(args.path)
            return
        {'prepare': prepare, 'install': install, 'remove': remove}[args.action](args.path)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Splash operation stopped: {error}\n')
    print('Splash ' + args.action + ' finished; hardware display remains unverified.')


if __name__ == '__main__':
    main()
