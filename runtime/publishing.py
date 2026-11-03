"""Publish validated game bytes into an explicitly selected static host directory.

No upload credentials or remote writes: deploy/serve this directory separately.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import urllib.parse
import zipfile
from . import catalog, packages


def encoded(document):
    return (json.dumps(document, sort_keys=True, indent=2) + '\n').encode()


def replace_bytes(target, content):
    """Replace one pointer atomically; never expose a partially written JSON file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.publish-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def publish(archive, output, base_url, developer=False):
    # Publishing uses a POSIX directory lock. Shell-only desktop exports do not
    # publish packages and must remain buildable without this platform module.
    import fcntl

    output = Path(output).resolve()
    if not (output / '.handheld-web-export').is_file():
        raise ValueError('Publish requires an existing generated web export; run web.py build first')
    catalog.check_url(base_url, developer)
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.query or parsed.fragment:
        raise ValueError('Base URL cannot contain query/fragment')
    base_url = base_url.rstrip('/') + '/'
    # Serialize cooperating local publishers without creating a served lock file.
    directory_fd = os.open(output, os.O_RDONLY)
    try:
        fcntl.flock(directory_fd, fcntl.LOCK_EX)
        return _publish(archive, output, base_url, developer)
    finally:
        os.close(directory_fd)


def confined(output, target):
    for candidate in (target, *target.parents):
        if candidate == output:
            return
        if candidate.is_symlink():
            raise ValueError('Symlinked publication path rejected')
    raise ValueError('Publication outside selected export')


def _publish(archive, output, base_url, developer):
    registry_file = output / 'catalog'
    confined(output, registry_file)
    if registry_file.exists() and registry_file.stat().st_size > catalog.MAX_CATALOG:
        raise ValueError('Registry too large')
    registry = catalog.validate_registry(json.loads(registry_file.read_text()), developer) if registry_file.exists() else []
    # Parse the shell inventory before writing anything; invalid deployment data
    # must not leave a partially published new catalog.
    shell_file = output / 'hub-manifest.json'
    confined(output, shell_file)
    if shell_file.exists() and shell_file.stat().st_size > 65536:
        raise ValueError('Shell inventory too large')
    shell = json.loads(shell_file.read_text()) if shell_file.exists() else None
    if shell is not None and (not isinstance(shell, dict) or not isinstance(shell.get('files'), dict) or '/catalog' not in shell['files']):
        raise ValueError('Invalid shell inventory')
    with tempfile.TemporaryDirectory(prefix='.publish-', dir=output.parent) as temporary:
        stage = Path(temporary)
        staged_archive = stage / 'game.zip'
        shutil.copyfile(archive, staged_archive)
        if staged_archive.stat().st_size > packages.MAX_BYTES:
            raise ValueError('Archive too large')
        manifest = packages.install(staged_archive, stage / 'validated')
        if not catalog.ID.fullmatch(manifest['id']):
            raise ValueError('Invalid registry game id')
        game_id, version = manifest['id'], manifest['version']
        if version == 'manifest.json':
            raise ValueError('Version conflicts with stable manifest path')
        relative = f'store/{game_id}/{version}'
        url = lambda name: urllib.parse.urljoin(base_url, urllib.parse.quote(name, safe='/'))
        folder = stage / 'release'
        folder.mkdir()
        archive_name = f'{game_id}-{version}.game.zip'
        shutil.copyfile(staged_archive, folder / archive_name)
        installed = stage / 'validated' / game_id / 'current'
        media = [manifest['artwork']]
        if 'attract' in manifest:
            media.append(manifest['attract'])
        screenshots = manifest.get('screenshots', [])
        if not isinstance(screenshots, list) or len(screenshots) > 12:
            raise ValueError('Invalid screenshots')
        for name in screenshots:
            if packages.safe_path(name) not in manifest['files']:
                raise ValueError('Screenshot missing from package inventory')
        media += screenshots
        for name in set(media):
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if target == folder / archive_name:
                raise ValueError('Discovery media conflicts with archive filename')
            shutil.copyfile(installed / name, target)
        content = staged_archive.read_bytes()
        release = dict(schema_version=1, id=game_id, version=version,
                       runtime=manifest['runtime'], entrypoint=manifest['entrypoint'],
                       package=dict(url=url(f'{relative}/{archive_name}'), size=len(content),
                                    sha256=hashlib.sha256(content).hexdigest()))
        catalog.validate_release(release, game_id, developer)
        existing = next((entry for entry in registry if entry['id'] == game_id), None)
        entry = existing or dict(id=game_id, title=game_id,
            manifest_url=url(f'store/{game_id}/manifest.json'),
            artwork=url(f'{relative}/{manifest["artwork"]}'),
            **({'attract': url(f'{relative}/{manifest["attract"]}')} if 'attract' in manifest else {}),
            screenshots=[url(f'{relative}/{name}') for name in screenshots])
        if existing and existing['manifest_url'] != url(f'store/{game_id}/manifest.json'):
            raise ValueError('Existing manifest URL differs; use the original base URL')
        new_registry = registry if existing else sorted([*registry, entry], key=lambda item: item['id'])
        catalog.validate_registry(new_registry, developer)
        if len(encoded(new_registry)) > catalog.MAX_CATALOG:
            raise ValueError('Registry too large')
        destination = output / relative
        confined(output, destination)
        confined(output, output / f'store/{game_id}/manifest.json')
        # Whole immutable version directory is the publication unit. Compare all
        # bytes (including archive) before publishing any pointer or new files.
        if destination.exists():
            if any(p.is_symlink() for p in destination.rglob('*')):
                raise ValueError('Symlinked publication file rejected')
            previous = {p.relative_to(destination).as_posix(): p.read_bytes() for p in destination.rglob('*') if p.is_file()}
            incoming = {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob('*') if p.is_file()}
            if previous != incoming:
                raise ValueError('Published package version already has different bytes')
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            folder.rename(destination)
        replace_bytes(output / f'store/{game_id}/manifest.json', encoded(release))
        if not existing:
            replace_bytes(registry_file, encoded(new_registry))
        if shell is not None:
            registry_bytes = registry_file.read_bytes()
            shell['files']['/catalog'] = dict(size=len(registry_bytes), sha256=hashlib.sha256(registry_bytes).hexdigest())
            replace_bytes(shell_file, encoded(shell))
        return entry


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base-url', required=True, help='Public HTTPS root serving the selected export')
    parser.add_argument('--developer-local', action='store_true')
    args = parser.parse_args()
    try:
        entry = publish(args.package, args.output, args.base_url, args.developer_local)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, str(error) + '\n')
    print(json.dumps(entry, indent=2))


if __name__ == '__main__':
    main()
