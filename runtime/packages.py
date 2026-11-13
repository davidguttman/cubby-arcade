"""Local web-game packages. Integrity checks are not publisher authentication."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import zipfile
if __package__:
    from .file_manifest import validate_companion
else:  # Legacy device CLI executes packages.py directly.
    from file_manifest import validate_companion

GAMES = Path('/var/lib/handheld/games')
MAX_BYTES = 128 * 1024 * 1024


def safe_path(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError('Invalid package path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('Invalid package path')
    return value


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise ValueError('Invalid game manifest')
    if manifest.get('schema_version') != 1 or manifest.get('runtime') != 'web':
        raise ValueError('Unsupported game manifest/runtime')
    for key in ('id', 'version'):
        if not isinstance(manifest.get(key), str) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,79}', manifest[key]) or '..' in manifest[key]:
            raise ValueError('Invalid game ' + key)
    files = manifest.get('files')
    if not isinstance(files, dict) or not files or len(files) > 1000:
        raise ValueError('Invalid file inventory')
    for name, digest in files.items():
        safe_path(name)
        if name == 'manifest.json' or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('Invalid file inventory')
    for key in ('entrypoint', 'artwork', 'attract'):
        if key in manifest or key != 'attract':
            if safe_path(manifest.get(key)) not in files:
                raise ValueError('Missing ' + key)
    if 'companion' in manifest:
        validate_companion(manifest['companion'])
    return manifest


def install(package, root=GAMES):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.install-', dir=root) as temporary:
        stage = Path(temporary) / 'release'
        stage.mkdir()
        with zipfile.ZipFile(package) as archive:
            items = archive.infolist()
            if len(items) > 1001 or sum(i.file_size for i in items) > MAX_BYTES:
                raise ValueError('Package too large')
            names = [safe_path(i.filename) for i in items]
            if len(names) != len(set(names)) or 'manifest.json' not in names:
                raise ValueError('Duplicate entries or missing manifest')
            for item in items:
                if item.is_dir() or ((item.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError('Directories and symlinks are not package files')
            manifest_bytes = archive.read('manifest.json')
            if len(manifest_bytes) > 256 * 1024:
                raise ValueError('Manifest too large')
            manifest = validate_manifest(json.loads(manifest_bytes))
            if set(names) != set(manifest['files']) | {'manifest.json'}:
                raise ValueError('Package inventory mismatch')
            for name, digest in manifest['files'].items():
                content = archive.read(name)
                if hashlib.sha256(content).hexdigest() != digest:
                    raise ValueError('Package checksum mismatch: ' + name)
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            (stage / 'manifest.json').write_bytes(manifest_bytes)
        game = root / manifest['id']
        releases = game / 'releases'
        releases.mkdir(parents=True, exist_ok=True)
        release = releases / manifest['version']
        if release.exists():
            existing = {p.relative_to(release).as_posix(): p.read_bytes() for p in release.rglob('*') if p.is_file()}
            incoming = {p.relative_to(stage).as_posix(): p.read_bytes() for p in stage.rglob('*') if p.is_file()}
            if existing != incoming:
                raise ValueError('Version already installed with different bytes')
        else:
            # Packages are not writable by the runtime's arcade user.
            for path in stage.rglob('*'):
                path.chmod(0o755 if path.is_dir() else 0o444)
            stage.chmod(0o755)
            stage.rename(release)
        selector = game / ('.current-' + Path(temporary).name)
        try:
            selector.symlink_to('releases/' + manifest['version'])
            os.replace(selector, game / 'current')
        finally:
            selector.unlink(missing_ok=True)
        return manifest


def library(root=GAMES):
    result = []
    for game in sorted(Path(root).glob('*/current')):
        try:
            release = game.resolve(strict=True)
            if not release.is_relative_to((game.parent / 'releases').resolve()):
                continue
            manifest = validate_manifest(json.loads((release / 'manifest.json').read_text()))
            if manifest['id'] != game.parent.name:
                continue
            base = '/games/' + manifest['id'] + '/'
            result.append({k: manifest[k] for k in ('id', 'version', 'runtime')} | {
                'entrypoint': base + manifest['entrypoint'],
                'artwork': base + manifest['artwork'],
                **({'companion': manifest['companion']} if 'companion' in manifest else {}),
                **({'attract': base + manifest['attract']} if 'attract' in manifest else {})})
        except (ValueError, OSError, KeyError, TypeError):
            continue
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--root', type=Path, default=GAMES)
    args = parser.parse_args()
    print(json.dumps(install(args.package, args.root)))
