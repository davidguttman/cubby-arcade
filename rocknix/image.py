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
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rocknix.device_profile import (media_identities, rewrite_boot_labels,
    rg353v_wifi_profile, fdt_properties, WIFI_PROFILE)
ROCKNIX_SHA256 = 'b573c9656d85bca5fa1aba038aac6cfabd92345d28a55cd74725cc98c618c775'
ROOTFS_SHA256 = 'e1859403acf7593e5b2ad9b932092258302f415a093959de24fd402b7475ee92'
TRAIL_MIX_SHA256 = '0f58736c83f3be504071425310d9a86e5425fc78b5de41ce08e6a1bf47a5da76'
BASE_BOOT_HOOK = '''#!/bin/sh
# Managed by Cubby Arcade RG353V image builder.
# Sourced by ROCKNIX initramfs before /run is moved into the real root.
# Do not populate /storage/.config: stock first-boot resize must run first.
if [ "$(tr -d '\\000' < /proc/device-tree/model)" = 'Anbernic RG353V' ]; then
  # Diagnostics do not depend on Cubby, Sway, or writable /storage setup.
  # Native autostart runs after graphical.target; do not hold up multi-user.
  mkdir -p /run/systemd/system/rocknix.target.wants /run/systemd/system/multi-user.target.wants
  cp /flash/cubby-usb-diagnostics/service /run/systemd/system/cubby-usb-diagnostics.service
  ln -sf ../cubby-usb-diagnostics.service /run/systemd/system/rocknix.target.wants/cubby-usb-diagnostics.service
  cp /flash/cubby-wifi-recovery/service /run/systemd/system/cubby-wifi-recovery.service
  ln -sf ../cubby-wifi-recovery.service /run/systemd/system/multi-user.target.wants/cubby-wifi-recovery.service
  if [ -f /flash/cubby-setup/authorized_keys ] && [ -f /flash/cubby-recovery-management/service ]; then
    cp /flash/cubby-recovery-management/service /run/systemd/system/cubby-recovery-management.service
    ln -sf ../cubby-recovery-management.service /run/systemd/system/rocknix.target.wants/cubby-recovery-management.service
  fi
  mkdir -p /run/systemd/system/essway.service.d
  cat > /run/systemd/system/essway.service.d/10-cubby-wifi.conf <<'UNIT'
[Unit]
Wants=cubby-wifi-recovery.service
After=cubby-wifi-recovery.service
UNIT
fi
if [ "$(tr -d '\\000' < /proc/device-tree/model)" = 'Anbernic RG353V' ] &&
   [ ! -e /flash/CUBBY-DISABLED ]; then
  if [ -f /flash/cubby-boot-screen/service ]; then
    mkdir -p /run/systemd/system/sysinit.target.wants
    cp /flash/cubby-boot-screen/service /run/systemd/system/cubby-boot-screen.service
    ln -sf ../cubby-boot-screen.service /run/systemd/system/sysinit.target.wants/cubby-boot-screen.service
  fi
  mkdir -p /run/systemd/system/essway.service.d
  cat > /run/systemd/system/essway.service.d/90-cubby.conf <<'UNIT'
# Managed by Cubby Arcade RG353V image builder
[Service]
ExecStart=
ExecStart=/storage/cubby/current/device/launch.sh
UNIT
fi
'''


from rocknix.boot_splash import SPLASH_HOOK, installation_files as splash_files
BOOT_HOOK = BASE_BOOT_HOOK + SPLASH_HOOK


def verify(path: Path, expected: str) -> None:
    if not path.is_file() or path.is_symlink():
        raise ValueError('Input must be a regular file')
    with path.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise ValueError(f'Input checksum mismatch: {path.name}')


def replace_fat_file(flash, path: str, contents: bytes) -> None:
    """Replace a regular boot file without pyfatfs 1.1.0's broken truncation.

    Truncating an existing multi-cluster file frees its tail but leaves the
    first cluster linked to that freed chain. Remove/recreate instead; this
    image is disposable until the complete build is atomically published.
    FAT has no Unix modes. Preserve the existing FAT flags and timestamps
    through the pinned library's directory-entry API.
    """
    entry = flash._get_dir_entry(path)
    metadata = {name: getattr(entry, name) for name in (
        'attr', 'crttimetenth', 'crttime', 'crtdate', 'lstaccessdate',
        'wrttime', 'wrtdate')}
    flash.remove(path)
    flash.writebytes(path, contents)
    entry = flash._get_dir_entry(path)
    for name, value in metadata.items():
        setattr(entry, name, value)
    flash.fs.update_directory_entry(entry.get_parent_dir())


def finalize_fat(path: Path) -> None:
    """Refresh pyfatfs's stale free-space accounting, then require clean FAT."""
    # pyfatfs 1.1.0 does not maintain FAT32's FSInfo free-cluster summary.
    # This is a disposable regular image, never a physical device. Exit 1
    # means fsck made corrections; all other nonzero results abort the build.
    checked = subprocess.run(['fsck.fat', '-a', str(path)], check=False)
    if checked.returncode not in (0, 1):
        raise subprocess.CalledProcessError(checked.returncode, checked.args)
    run('fsck.fat', '-n', str(path))


def _gpt_layout(source, *, generated=False):
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
    if result[0][0] != 32768 or result[0][1] != 4194304 or result[1][0] != sum(result[0]) or (not generated and result[1][1] != 65536):
        raise ValueError('Unexpected or overlapping pinned ROCKNIX layout')
    if generated:
        sectors = result[1][1]
        table_sectors = (len(entries) + 511) // 512
        end = result[1][0] + sectors - 1
        backup_lba = end + table_sectors + 1
        source.seek(0, 2)
        if (not 65536 <= sectors <= 64 * 1024**3 // 512
                or source.tell() != (backup_lba + 1) * 512
                or struct.unpack_from('<QQQQ', header, 24) != (1, backup_lba, 34, end)
                or mbr[450] != 0xee
                or struct.unpack_from('<II', mbr, 454) != (1, min(backup_lba, 0xffffffff))):
            raise ValueError('Invalid generated GPT geometry')
        source.seek((backup_lba - table_sectors) * 512)
        if source.read(len(entries)) != entries:
            raise ValueError('Generated backup GPT table differs')
        source.seek(backup_lba * 512)
        backup = bytearray(source.read(512))
        wanted = bytearray(header)
        struct.pack_into('<Q', wanted, 24, backup_lba)
        struct.pack_into('<Q', wanted, 32, 1)
        struct.pack_into('<Q', wanted, 72, backup_lba - table_sectors)
        struct.pack_into('<I', wanted, 16, 0)
        struct.pack_into('<I', wanted, 16, zlib.crc32(wanted[:header_size]))
        if backup != wanted:
            raise ValueError('Generated backup GPT header differs')
    return mbr, header, entries, result


def gpt_layout(source):
    """Only the exact pinned stock input geometry is accepted."""
    return _gpt_layout(source)


def generated_gpt_layout(source):
    """Validate expanded output and its relocated backup, without weakening input."""
    return _gpt_layout(source, generated=True)


def grow_gpt(destination, layout, storage_sectors, *, identities=None):
    """Keep bootloader/partition starts, assign build-unique IDs, relocate backup GPT."""
    mbr, header, entries, parts = layout
    if storage_sectors < parts[1][1] or storage_sectors > 64 * 1024 ** 3 // 512:
        raise ValueError('Invalid STORAGE extent')
    entries = bytearray(entries)
    header = bytearray(header)
    identities = identities or media_identities()
    header[56:72] = uuid.UUID(identities['disk_guid']).bytes_le
    for index, guid in enumerate(identities['partition_guids']):
        entries[index*128+16:index*128+32] = uuid.UUID(guid).bytes_le
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
    url = 'https://trailmix.david.app/releases/0.9.0/manifest.json'
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


DEFAULT_UPDATE_FEED = 'https://github.com/davidguttman/cubby-arcade/releases/download/cubby-device-stable/manifest.json'


def provision_updater(cubby, source_root, feed=None, key=None, disabled=False):
    """Baseline trust provisioning, not an app-delivered key rotation."""
    if disabled:
        if feed or key: raise ValueError('Cannot combine disabled updates with explicit trust')
        return
    if bool(feed) != bool(key):
        raise ValueError('Update feed and public key must be provided together')
    if feed is None:
        feed = DEFAULT_UPDATE_FEED
        key = Path(source_root) / 'rocknix/device/release-key.pem'
    from rocknix.updates import Manager, atomic
    destination = Path(cubby) / 'updater'
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(key, destination / 'release-key.pem')
    atomic(destination / 'config.json', {'feed': feed, 'public_key': 'release-key.pem'})
    Manager(cubby).config()


def build(upstream: Path, rootfs: Path, output: Path, storage_gib: int = 6,
          *, source_root: Path | None = None, source_info: dict | None = None,
          progress=None, update_feed: str | None = None, update_key: Path | None = None,
          wifi_profile: str = WIFI_PROFILE, disable_updates: bool = False,
          production_plan: dict | None = None, management_keys: bytes | None = None) -> Path:
    if bool(update_feed) != bool(update_key):
        raise ValueError('Update feed and public key must be provided together')
    if wifi_profile not in (WIFI_PROFILE, 'stock'):
        raise ValueError('Unknown Wi-Fi compatibility profile')
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
        label = re.search(r'^Filesystem volume name:\s+(\S+)', stats, re.MULTILINE).group(1)
        if label != 'STORAGE':
            raise ValueError('Unexpected stock storage label')
        identities = media_identities()
        wifi_provenance = {'profile': wifi_profile, 'association_verified': False}
        storage = temporary / 'storage'
        storage.mkdir()
        extract_storage(original_storage, storage)
        with PyFatFS(str(fat)) as flash:
            replace_fat_file(flash, '/EXTLINUX/extlinux.conf', rewrite_boot_labels(
                flash.readtext('/EXTLINUX/extlinux.conf'), identities).encode('utf-8'))
            if wifi_profile == WIFI_PROFILE:
                dtpath = '/device_trees/rk3566-anbernic-rg353v.dtb'
                original = flash.readbytes(dtpath)
                patched = rg353v_wifi_profile(original)
                flash.makedir('/cubby-recovery')
                flash.writebytes('/cubby-recovery/rk3566-anbernic-rg353v.original.dtb', original)
                replace_fat_file(flash, dtpath, patched)
                wifi_provenance.update(original_sha256=hashlib.sha256(original).hexdigest(),
                                       applied_sha256=hashlib.sha256(patched).hexdigest())
            if flash.exists('/post-sysroot.sh'):
                raise ValueError('Refusing to replace upstream post-sysroot hook')
            flash.writetext('/post-sysroot.sh', BOOT_HOOK)
            flash.makedir('/cubby-splash')
            for name, data in splash_files(BASE_BOOT_HOOK.encode(), BOOT_HOOK.encode(), source_root).items():
                flash.writebytes('/cubby-splash/' + name, data)
            flash.makedir('/cubby-boot-screen')
            flash.writebytes('/cubby-boot-screen/service',
                             (source_root / 'runtime/native/rg353v/boot-screen/cubby-boot-screen.service').read_bytes())
            flash.makedir('/cubby-usb-diagnostics')
            for source, destination in (
                ('usb-diagnostics-start.sh', 'start.sh'),
                ('usb-diagnostics.py', 'status.py'),
                ('cubby-usb-diagnostics.service', 'service'),
            ):
                flash.writebytes('/cubby-usb-diagnostics/' + destination,
                                 (source_root / 'rocknix/device' / source).read_bytes())
            flash.makedir('/cubby-wifi-recovery')
            for source, destination in (
                ('wifi-recovery.py', 'recover.py'),
                ('cubby-wifi-recovery.service', 'service'),
            ):
                flash.writebytes('/cubby-wifi-recovery/' + destination,
                                 (source_root / 'rocknix/device' / source).read_bytes())
            if management_keys:
                flash.makedir('/cubby-setup')
                flash.writebytes('/cubby-setup/authorized_keys', management_keys)
                flash.makedir('/cubby-recovery-management')
                for source, target in [('management.py', 'management.py'),
                                       ('cubby-recovery-management.service', 'service')]:
                    flash.writebytes('/cubby-recovery-management/' + target,
                                     (source_root / 'rocknix/device' / source).read_bytes())
            flash.writetext('/CUBBY-RECOVERY.txt', 'Create an empty file named CUBBY-DISABLED (no extension) beside this file to boot stock ROCKNIX. Power off before editing the card.\n')
        run('fatlabel', str(fat), identities['boot_label'])
        run('fatlabel', '--volume-id', str(fat), identities['fat_serial'])
        finalize_fat(fat)
        release_id = ('image-' + production_plan['version'] + '-' + production_plan['source_commit'][:12]
                      if production_plan else 'image-' + ROOTFS_SHA256[:12])
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
        if production_plan:
            (release / 'app/runtime/version.json').write_text(json.dumps({'version': production_plan['version']}))
        (release / 'app/hosting').mkdir()
        shutil.copy2(source_root / 'hosting/catalog.yaml', release / 'app/hosting/catalog.yaml')
        shutil.copytree(source_root / 'rocknix/device', release / 'device')
        (cubby / 'current').symlink_to('releases/' + release_id)
        (cubby / 'updater').mkdir()
        shutil.copy2(source_root / 'rocknix/updates.py', cubby / 'updater/coordinator.py')
        provision_updater(cubby, source_root, update_feed, update_key, disable_updates)
        (cubby / 'state').mkdir()
        provenance = cubby / 'image-provenance'
        provenance.mkdir()
        seed_game(cubby / 'state', provenance)
        (provenance / 'build.json').write_text(json.dumps({
            **({'product_version': production_plan['version']} if production_plan else {}),
            'rocknix_release': '20261101', 'rocknix_sha256': ROCKNIX_SHA256,
            'wpe_rootfs_sha256': ROOTFS_SHA256,
            **source_provenance(source_root, source_info),
            'hardware_validated': False,
            'media_identities': identities, 'wifi_compatibility': wifi_provenance,
        }, indent=2) + '\n')
        validate_storage_seed(storage)
        storage_image = temporary / 'storage.ext4'
        size = storage_gib * 1024 ** 3
        with storage_image.open('wb') as destination:
            destination.truncate(size)
        run('mkfs.ext4', '-q', '-F', '-m', '0', '-L', identities['storage_label'], '-U', identities['storage_uuid'], '-d', str(storage), str(storage_image))
        run('e2fsck', '-f', '-n', str(storage_image))
        if production_plan:
            from rocknix.production_image import audit_partitions
            audit_partitions(fat, storage_image, release_id, production_plan)
        # Preserve prefix including stock bootloader and FAT partition start.
        final_raw = temporary / 'cubby.img'
        copy_range(raw, final_raw, 0, second[0] * 512)
        with final_raw.open('r+b') as destination:
            grow_gpt(destination, layout, size // 512, identities=identities)
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
    parser.add_argument('--wifi-profile', choices=[WIFI_PROFILE, 'stock'], default=WIFI_PROFILE)
    parser.add_argument('--disable-updates', action='store_true', help='Build without production update trust')
    parser.add_argument('--update-feed')
    parser.add_argument('--update-key', type=Path, help='Public Ed25519 key only; never the private signing key')
    args = parser.parse_args()
    build(args.rocknix.resolve(), args.rootfs.resolve(), args.output.absolute(), args.storage_gib,
          update_feed=args.update_feed, update_key=args.update_key, wifi_profile=args.wifi_profile,
          disable_updates=args.disable_updates)
