#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.1.1"]
# ///
"""Regenerate website/boot.webp from the handheld's actual artwork and renderer.

Lossless WebP stores only star regions over the canonical static PNG.
This is a maintainer command only; normal site exports need no image dependency.
"""
import importlib.util
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cubby_boot', ROOT / 'runtime/native/rg353v/boot-screen/boot-screen.py')
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)
art = (ROOT / 'rocknix/splash/splash-32.raw').read_bytes()
assert boot.stars_for(art), 'Regenerate the native star table for the current artwork first'
# Only stars travel in the animation; the exact PNG underneath paints first.
# Keeping the unchanging 640x480 artwork out of every frame saves transfer bytes.
assert Image.open(ROOT / 'rocknix/splash/preview.png').convert('RGBA').tobytes() == Image.frombytes(
    'RGBA', (boot.WIDTH, boot.HEIGHT), boot.opaque(art), 'raw', 'BGRA').tobytes(), 'Preview and native raster diverged'
pixels = bytearray(boot.WIDTH * boot.HEIGHT * 4)
frames = []
stars = boot.Twinkle(art, boot.stars_for(art))
for tick in range(80):
    for index, star in enumerate(stars.stars):
        level = boot.twinkle_level(boot.twinkle_at(index, tick * boot.FRAME_SECONDS))
        for offset, row in star.at(level):
            opaque = bytearray(row)
            opaque[3::4] = b'\xff' * (len(opaque) // 4)
            pixels[offset:offset + len(opaque)] = opaque
    frames.append(Image.frombytes('RGBA', (boot.WIDTH, boot.HEIGHT), bytes(pixels), 'raw', 'BGRA'))
frames[0].save(ROOT / 'website/boot.webp', save_all=True, append_images=frames[1:],
               duration=100, loop=0, lossless=True, method=6, minimize_size=True)
print('website/boot.webp:', (ROOT / 'website/boot.webp').stat().st_size, 'bytes')
# Decode representative frames to guard against lossy encoding, disposal bugs,
# or accidentally shipping a static WebP. The star bytes must remain exact.
with Image.open(ROOT / 'website/boot.webp') as encoded:
    assert encoded.n_frames == len(frames)
    for index in (0, 7, 34, 79):
        encoded.seek(index)
        assert encoded.convert('RGBA').tobytes() == frames[index].tobytes()
print('80 lossless native-star frames verified against the handheld renderer')
