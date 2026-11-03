#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyfatfs==1.1.0", "setuptools==80.9.0", "pyyaml==6.0.3"]
# ///
"""Maintainer-only: combine pinned stock ROCKNIX and Cubby into one SD image.

Only regular image files are accepted, never disks. No mount, sudo, or OS rebuild
is needed. Run under a root-mapped user namespace to preserve rootfs ownership:
  unshare --map-auto --map-root-user uv run rocknix/image.py --help
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import zlib
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
ROCKNIX_SHA256 = 'b573c9656d85bca5fa1aba038aac6cfabd92345d28a55cd74725cc98c618c775'
ROOTFS_SHA256 = 'a0976631e2be72ba9d20334609771fab39048d10b2228c9b60942cee60d566bb'
TRAIL_MIX_SHA256 = 'ef805a6f55c518a071b0501fc63a8cdb9dd664095ba6f0405c7f2782693755cd'
BOOT_HOOK = '''#!/bin/sh
# Managed by Cubby Arcade RG353V image builder.
# Sourced by ROCKNIX initramfs before /run is moved into the real root.
# Do not populate /storage/.config: stock first-boot resize must run first.
if [ "$(tr -d '\\000' < /proc/device-tree/model)" = 'Anbernic RG353V' ] &&
   [ ! -e /flash/CUBBY-DISABLED ]; then
  mkdir -p /run/systemd/system/essway.service.d
  cat > /run/systemd/system/essway.service.d/90-cubby.conf <<'UNIT'
# Managed by Cubby Arcade RG353V image builder
[Service]
ExecStart=
ExecStart=/storage/cubby/current/device/launch.sh
UNIT
fi
'''


def verify(path: Path, expected: str) -> None:
    if not path.is_file() or path.is_symlink():
        raise ValueError('Input must be a regular file')
    with path.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise ValueError(f'Input checksum mismatch: {path.name}')


def gpt_layout(source):
    """Validate both primary GPT checksums before trusting image offsets."""
    source.seek(0)
    mbr = source.read(512)
    header = bytearray(source.read(512))
    if mbr[510:] != b'\x55\xaa' or header[:8] != b'EFI PART':
        raise ValueError('Expected stock GPT image')
    header_size = struct.unpack_from('<I', header, 12)[0]
    if not 92 <= header_size <= 512:
        raise ValueError('Invalid GPT header size')
    expected = struct.unpack_from('<I', header, 16)[0]
    struct.pack_into('<I', header, 16, 0)
    if zlib.crc32(header[:header_size]) != expected:
        raise ValueError('GPT header checksum mismatch')
    struct.pack_into('<I', header, 16, expected)
    table_lba, count, entry_size = struct.unpack_from('<QII', header, 72)
    if table_lba != 2 or not 2 <= count <= 128 or entry_size != 128:
        raise ValueError('Unsupported GPT table shape')
    source.seek(table_lba * 512)
    entries = bytearray(source.read(count * entry_size))
    if zlib.crc32(entries) != struct.unpack_from('<I', header, 88)[0]:
        raise ValueError('GPT entries checksum mismatch')
    result = []
    for index in range(count):
        entry = entries[index * entry_size:(index + 1) * entry_size]
        if index > 1:
            if any(entry):
                raise ValueError('Unexpected extra GPT partition')
            continue
        start, end = struct.unpack_from('<QQ', entry, 32)
        result.append((start, end - start + 1))
    if result[0][0] != 32768 or result[0][1] != 4194304 or result[1][0] != sum(result[0]) or result[1][1] != 65536:
        raise ValueError('Unexpected or overlapping pinned ROCKNIX layout')
    return mbr, header, entries, result


def grow_gpt(destination, layout, storage_sectors):
    """Preserve disk/partition GUIDs, bootloader and partition starts; relocate backup GPT."""
    mbr, header, entries, parts = layout
    if storage_sectors < parts[1][1] or storage_sectors > 64 * 1024 ** 3 // 512:
        raise ValueError('Invalid STORAGE extent')
    entries = bytearray(entries)
    header = bytearray(header)
    end = parts[1][0] + storage_sectors - 1
    table_sectors = (len(entries) + 511) // 512
    backup_lba = end + table_sectors + 1
    struct.pack_into('<Q', entries, 128 + 40, end)
    struct.pack_into('<Q', header, 32, backup_lba)
    struct.pack_into('<Q', header, 48, end)
    struct.pack_into('<I', header, 88, zlib.crc32(entries))
    header_size = struct.unpack_from('<I', header, 12)[0]
    def checksum(block):
        struct.pack_into('<I', block, 16, 0)
        struct.pack_into('<I', block, 16, zlib.crc32(block[:header_size]))
    checksum(header)
    backup = bytearray(header)
    struct.pack_into('<Q', backup, 24, backup_lba)
    struct.pack_into('<Q', backup, 32, 1)
    struct.pack_into('<Q', backup, 72, backup_lba - table_sectors)
    checksum(backup)
    protective = bytearray(mbr)
    struct.pack_into('<I', protective, 446 + 12, min(backup_lba, 0xffffffff))
    destination.truncate((backup_lba + 1) * 512)
    destination.seek(0)
    destination.write(protective)
    destination.write(header)
    destination.seek(2 * 512)
    destination.write(entries)
    destination.seek((backup_lba - table_sectors) * 512)
    destination.write(entries)
    destination.seek(backup_lba * 512)
    destination.write(backup)


def copy_range(source: Path, target: Path, offset: int, length: int) -> None:
    with source.open('rb') as incoming, target.open('wb') as outgoing:
        incoming.seek(offset)
        while length:
            block = incoming.read(min(length, 8 * 1024 * 1024))
            if not block:
                raise ValueError('Truncated stock image')
            outgoing.write(block)
            length -= len(block)


def validate_storage_seed(storage: Path) -> None:
    if not (storage / '.please_resize_me').is_file():
        raise ValueError('Missing upstream first-boot resize marker')
    if any((storage / name).exists() for name in ('.config', '.cache')):
        raise ValueError('Preseeded config would prevent stock first-boot resize')


def run(*args: str) -> str:
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.stderr:
        print(result.stderr, file=sys.stderr, end='')
    return result.stdout


def extract_storage(filesystem: Path, storage: Path) -> None:
    # debugfs parses its own command language, not shell syntax.
    # libss represents a literal quote with doubled quotes; backslashes are
    # literal, so shell-style backslash escaping silently changes the path.
    destination = str(storage).replace('"', '""')
    result = subprocess.run(['debugfs', '-R', f'rdump / "{destination}"', str(filesystem)],
                            check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # rdump can exit zero after failing to copy files. Successful debugfs emits
    # only its version banner on stderr; any other diagnostic is a failure.
    diagnostics = [line for line in result.stderr.splitlines()
                   if line.strip() and not re.fullmatch(r'debugfs [0-9][^\r\n]*', line)]
    if diagnostics:
        raise ValueError('Stock storage extraction failed: ' + '\n'.join(diagnostics))
    validate_storage_seed(storage)


def publish_image(compressed: Path, output: Path, digest: str) -> None:
    """Publish complete files without replacing paths created by another build."""
    sidecar = output.with_name(output.name + '.sha256')
    if any(path.is_symlink() or path.exists() for path in (output, sidecar)):
        raise ValueError('Refusing to replace an existing output')
    with tempfile.TemporaryDirectory(prefix='cubby-checksum-', dir=output.parent) as directory:
        staged_checksum = Path(directory) / 'image.sha256'
        staged_checksum.write_text(f'{digest}  {output.name}\n')
        # Hard links publish each whole file atomically and refuse all existing
        # destinations, including dangling symlinks introduced after preflight.
        os.link(compressed, output)
        os.link(staged_checksum, sidecar)


def seed_game(state: Path, provenance: Path) -> None:
    from runtime import catalog
    url = 'https://trailmix.david.app/arcade/manifest.json'
    manifest = provenance / 'trail-mix-release.json'
    final = catalog.download(url, manifest, catalog.MAX_RELEASE)
    verify(manifest, TRAIL_MIX_SHA256)
    release = catalog.validate_release(json.loads(manifest.read_text()), 'trail-mix', manifest_url=final)
    if release['schema_version'] != 2:
        raise ValueError('Offline seed requires a file-inventory release')
    catalog.install_files(release, state / 'games')
    (provenance / 'trail-mix-provenance.json').write_text(json.dumps({
        'manifest_url': final, 'manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
        'id': release['id'], 'version': release['version'],
    }, indent=2) + '\n')


def source_provenance(source_root: Path, supplied: dict | None = None) -> dict:
    """A packaged payload records build provenance; the installer needs no Git."""
    if supplied is not None:
        if not isinstance(supplied, dict):
            raise ValueError('Invalid source provenance')
        commit, dirty = supplied.get('source_commit'), supplied.get('source_dirty')
        if (commit is not None and (not isinstance(commit, str)
                                   or not re.fullmatch(r'(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})', commit))
                or dirty is not None and not isinstance(dirty, bool)):
            raise ValueError('Invalid source provenance')
        return {'source_commit': commit, 'source_dirty': dirty}
    if not (source_root / '.git').exists():
        return {'source_commit': None, 'source_dirty': None}
    try:
        return {
            'source_commit': run('git', '-C', str(source_root), 'rev-parse', 'HEAD').strip(),
            'source_dirty': bool(run('git', '-C', str(source_root), 'status', '--porcelain').strip()),
        }
    except (OSError, subprocess.CalledProcessError):
        return {'source_commit': None, 'source_dirty': None}


def build(upstream: Path, rootfs: Path, output: Path, storage_gib: int = 6,
          *, source_root: Path | None = None, source_info: dict | None = None,
          progress=None) -> Path:
    source_root = ROOT if source_root is None else Path(source_root)
    report = progress or (lambda message: print(message, flush=True))
    if os.geteuid() != 0:
        raise ValueError('Run in a root-mapped user namespace: unshare --map-auto --map-root-user uv run rocknix/image.py ...')
    if not 4 <= storage_gib <= 64:
        raise ValueError('STORAGE size must be between 4 and 64 GiB')
    verify(upstream, ROCKNIX_SHA256)
    verify(rootfs, ROOTFS_SHA256)
    if any(path.is_symlink() or path.exists()
           for path in (output, output.with_name(output.name + '.sha256'))):
        raise ValueError('Refusing to replace an existing output')
    output.parent.mkdir(parents=True, exist_ok=True)
    from pyfatfs.PyFatFS import PyFatFS
    with tempfile.TemporaryDirectory(prefix='cubby-sd-', dir=output.parent) as directory:
        temporary = Path(directory)
        raw = temporary / 'stock.img'
        report('Decompressing pinned ROCKNIX image...')
        with gzip.open(upstream, 'rb') as source, raw.open('wb') as destination:
            shutil.copyfileobj(source, destination, 8 * 1024 * 1024)
        with raw.open('rb') as source:
            layout = gpt_layout(source)
        first, second = layout[3]
        if raw.stat().st_size < (second[0] + second[1]) * 512:
            raise ValueError('Truncated upstream storage partition')
        fat = temporary / 'flash.fat'
        original_storage = temporary / 'stock-storage.ext4'
        copy_range(raw, fat, first[0] * 512, first[1] * 512)
        copy_range(raw, original_storage, second[0] * 512, second[1] * 512)
        stats = run('dumpe2fs', '-h', str(original_storage))
        uuid = re.search(r'^Filesystem UUID:\s+(\S+)', stats, re.MULTILINE).group(1)
        label = re.search(r'^Filesystem volume name:\s+(\S+)', stats, re.MULTILINE).group(1)
        if label != 'STORAGE':
            raise ValueError('Unexpected stock storage label')
        storage = temporary / 'storage'
        storage.mkdir()
        extract_storage(original_storage, storage)
        with PyFatFS(str(fat)) as flash:
            if flash.exists('/post-sysroot.sh'):
                raise ValueError('Refusing to replace upstream post-sysroot hook')
            flash.writetext('/post-sysroot.sh', BOOT_HOOK)
            flash.writetext('/CUBBY-RECOVERY.txt', 'Create an empty file named CUBBY-DISABLED (no extension) beside this file to boot stock ROCKNIX. Power off before editing the card.\n')
        release_id = 'image-' + ROOTFS_SHA256[:12]
        cubby = storage / 'cubby'
        release = cubby / 'releases' / release_id
        release.mkdir(parents=True)
        report('Adding WPE, Cubby, and offline Trail Mix...')
        (release / 'rootfs').mkdir()
        # This archive is maintainer-built and checksum-pinned, not user input.
        # Numeric ownership and symlinks must remain intact for Bubblewrap.
        run('tar', '--numeric-owner', '-xJf', str(rootfs), '-C', str(release / 'rootfs'))
        for name in ('runtime', 'rocknix'):
            shutil.copytree(source_root / name, release / 'app' / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (release / 'app/hosting').mkdir()
        shutil.copy2(source_root / 'hosting/catalog.yaml', release / 'app/hosting/catalog.yaml')
        shutil.copytree(source_root / 'rocknix/device', release / 'device')
        (cubby / 'current').symlink_to('releases/' + release_id)
        (cubby / 'state').mkdir()
        provenance = cubby / 'image-provenance'
        provenance.mkdir()
        seed_game(cubby / 'state', provenance)
        (provenance / 'build.json').write_text(json.dumps({
            'rocknix_release': '20261101', 'rocknix_sha256': ROCKNIX_SHA256,
            'wpe_rootfs_sha256': ROOTFS_SHA256,
            **source_provenance(source_root, source_info),
            'hardware_validated': False,
        }, indent=2) + '\n')
        validate_storage_seed(storage)
        storage_image = temporary / 'storage.ext4'
        size = storage_gib * 1024 ** 3
        with storage_image.open('wb') as destination:
            destination.truncate(size)
        run('mkfs.ext4', '-q', '-F', '-m', '0', '-L', label, '-U', uuid, '-d', str(storage), str(storage_image))
        run('e2fsck', '-f', '-n', str(storage_image))
        # Preserve prefix including stock bootloader and FAT partition start.
        final_raw = temporary / 'cubby.img'
        copy_range(raw, final_raw, 0, second[0] * 512)
        with final_raw.open('r+b') as destination:
            grow_gpt(destination, layout, size // 512)
            destination.seek(first[0] * 512)
            with fat.open('rb') as source:
                shutil.copyfileobj(source, destination, 8 * 1024 * 1024)
            destination.seek(second[0] * 512)
            with storage_image.open('rb') as source:
                shutil.copyfileobj(source, destination, 8 * 1024 * 1024)
        report('Compressing the flashable image...')
        compressed = temporary / 'cubby.img.gz'
        with final_raw.open('rb') as source, compressed.open('wb') as destination:
            with gzip.GzipFile(filename='', mode='wb', fileobj=destination, compresslevel=1, mtime=0) as archive:
                shutil.copyfileobj(source, archive, 8 * 1024 * 1024)
        with compressed.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        publish_image(compressed, output, digest)
        report(f'Built {output} ({output.stat().st_size} bytes); hardware validation outstanding.')
        return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rocknix', required=True, type=Path)
    parser.add_argument('--rootfs', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--storage-gib', type=int, default=6)
    args = parser.parse_args()
    build(args.rocknix.resolve(), args.rootfs.resolve(), args.output.absolute(), args.storage_gib)
