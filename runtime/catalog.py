"""Adult/developer catalog management. Hashes verify bytes, not publisher identity."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from . import packages, file_manifest

MAX_CATALOG = 1024 * 1024
MAX_RELEASE = 256 * 1024
DOWNLOAD_WORKERS = 6
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,79}')
VERSION = re.compile(r'[a-z0-9][a-z0-9.-]{0,79}')
MEDIA_LIMITS = {'thumbnail': 64 * 1024, 'artwork': 512 * 1024, 'attract': 8 * 1024 * 1024}


def validate_media(media):
    """Optional discovery derivatives; never part of a game's immutable inventory."""
    if not isinstance(media, dict) or not media.keys() <= MEDIA_LIMITS.keys():
        raise ValueError('Invalid media variants')
    for name, item in media.items():
        if (not isinstance(item, dict) or set(item) != {'url', 'size', 'sha256', 'source_sha256'}
                or type(item.get('size')) is not int or not 0 < item['size'] <= MEDIA_LIMITS[name]):
            raise ValueError('Invalid media size/descriptor')
        file_manifest.resolve_url(item['url'])
        for key in ('sha256', 'source_sha256'):
            if not isinstance(item.get(key), str) or not re.fullmatch('[0-9a-f]{64}', item[key]):
                raise ValueError('Invalid media checksum')
    return media


def check_url(url, developer=False):
    if not isinstance(url, str):
        raise ValueError('Invalid URL')
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError('URL credentials/fragments are not supported')
    if parsed.scheme == 'https' and parsed.hostname:
        return url
    if developer and parsed.scheme == 'file' and not parsed.netloc and parsed.path.startswith('/'):
        return url
    if developer and parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1'):
        return url
    raise ValueError('HTTPS required; local transports require --developer-local')


class Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 3
    max_repeats = 1

    def __init__(self, developer, allow_redirects=True):
        self.developer = developer
        self.allow_redirects = allow_redirects

    def redirect_request(self, request, response, code, message, headers, newurl):
        if not self.allow_redirects:
            raise ValueError('Release file redirects rejected')
        check_url(newurl, self.developer)
        # HTTP redirects must never open files, even in local development mode.
        if urllib.parse.urlsplit(newurl).scheme == 'file':
            raise ValueError('Redirect to file rejected')
        return super().redirect_request(request, response, code, message, headers, newurl)


def download(url, destination, limit, developer=False, expected_size=None, digest=None, allow_redirects=True, timeout=20):
    """Download verified bytes and return their final response URL."""
    check_url(url, developer)
    opener = urllib.request.build_opener(Redirects(developer, allow_redirects))
    deadline = time.monotonic() + 120
    size, checksum = 0, hashlib.sha256()
    with opener.open(url, timeout=timeout) as response, Path(destination).open('wb') as output:
        final_url = response.geturl()
        length = response.headers.get('Content-Length')
        if length is not None and (int(length) > limit or (expected_size is not None and int(length) != expected_size)):
            raise ValueError('Download size mismatch')
        while True:
            if time.monotonic() > deadline:
                raise ValueError('Download deadline exceeded')
            chunk = response.read(min(64 * 1024, limit - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError('Download too large')
            checksum.update(chunk)
            output.write(chunk)
    if expected_size is not None and size != expected_size:
        raise ValueError('Download size mismatch')
    if digest is not None and checksum.hexdigest() != digest:
        raise ValueError('Download checksum mismatch')
    return final_url


def validate(document, developer=False):
    if not isinstance(document, dict) or document.get('schema_version') != 1:
        raise ValueError('Unsupported catalog')
    games = document.get('games')
    if not isinstance(games, list) or len(games) > 1000:
        raise ValueError('Invalid catalog entries')
    seen = set()
    for entry in games:
        if not isinstance(entry, dict):
            raise ValueError('Invalid catalog entry')
        if not isinstance(entry.get('id'), str) or not ID.fullmatch(entry['id']) or entry['id'] in seen:
            raise ValueError('Invalid/duplicate game id')
        seen.add(entry['id'])
        if not isinstance(entry.get('version'), str) or not VERSION.fullmatch(entry['version']) or '..' in entry['version']:
            raise ValueError('Invalid game version')
        if not isinstance(entry.get('title'), str) or not 1 <= len(entry['title']) <= 120:
            raise ValueError('Invalid adult catalog title')
        if type(entry.get('size')) is not int or not 0 < entry['size'] <= packages.MAX_BYTES:
            raise ValueError('Invalid package size')
        if not isinstance(entry.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', entry['sha256']):
            raise ValueError('Invalid package checksum')
        check_url(entry.get('url'), developer)
    return games


def validate_registry(document, developer=False):
    """Browsing validates discovery metadata only; it never follows manifest URLs."""
    if not isinstance(document, list) or len(document) > 1000:
        raise ValueError('Invalid registry')
    seen = set()
    for entry in document:
        if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not ID.fullmatch(entry['id']) or entry['id'] in seen:
            raise ValueError('Invalid/duplicate registry identity')
        seen.add(entry['id'])
        if not isinstance(entry.get('title'), str) or not 1 <= len(entry['title']) <= 120:
            raise ValueError('Invalid adult registry title')
        for key in ('manifest_url', 'artwork'):
            check_url(entry.get(key), developer)
        if 'attract' in entry:
            check_url(entry['attract'], developer)
        if 'media' in entry:
            validate_media(entry['media'])
        if 'parents' in entry:   # Legacy registry field; companion discovery uses installed manifests.
            check_url(entry['parents'], developer)
        screenshots = entry.get('screenshots', [])
        if not isinstance(screenshots, list) or len(screenshots) > 12:
            raise ValueError('Invalid screenshots')
        for url in screenshots:
            check_url(url, developer)
        # Earlier manifest addresses, so installs pinned to them keep updating.
        moved = entry.get('moved_from', [])
        if not isinstance(moved, list) or len(moved) > 8:
            raise ValueError('Invalid moved manifests')
        for url in moved:
            check_url(url, developer)
    return document


def validate_release(document, game_id, developer=False, manifest_url=None):
    if isinstance(document, dict) and document.get('schema_version') == 2:
        return file_manifest.validate(document, game_id, developer, manifest_url)
    if not isinstance(document, dict) or document.get('schema_version') != 1 or document.get('runtime') != 'web':
        raise ValueError('Unsupported release manifest/runtime')
    if document.get('id') != game_id or not isinstance(game_id, str) or not ID.fullmatch(game_id):
        raise ValueError('Registry/release identity mismatch')
    version = document.get('version')
    if not isinstance(version, str) or not VERSION.fullmatch(version) or '..' in version:
        raise ValueError('Invalid release version')
    packages.safe_path(document.get('entrypoint'))
    if 'files' in document:
        raise ValueError('Ambiguous release manifest')
    package = document.get('package')
    if not isinstance(package, dict):
        raise ValueError('Invalid release package')
    # Reuse the legacy package transport checks, not its discovery shape.
    resolved = dict(package, url=file_manifest.resolve_url(package.get('url'), manifest_url, developer))
    validate({'schema_version': 1, 'games': [dict(resolved, id=game_id, version=version, title=game_id)]}, developer)
    return dict(document, package=resolved,
                **({'companion': file_manifest.validate_companion(document['companion'], manifest_url)} if 'companion' in document else {}))


def resolve_entry(entry, developer=False):
    """Resolve the stable URL immediately before downloading a release."""
    if 'manifest_url' not in entry:
        validate({'schema_version': 1, 'games': [entry]}, developer)
        return entry
    validate_registry([entry], developer)
    with tempfile.TemporaryDirectory(prefix='hub-release-') as temporary:
        target = Path(temporary) / 'release.json'
        manifest_url = download(entry['manifest_url'], target, MAX_RELEASE, developer)
        release = validate_release(json.loads(target.read_text()), entry['id'], developer,
                                   manifest_url if manifest_url is not None else entry['manifest_url'])
    if release['schema_version'] == 2:
        return release
    return dict(release['package'], id=release['id'], version=release['version'],
                title=entry['title'], runtime=release['runtime'], entrypoint=release['entrypoint'],
                **({'companion': release['companion']} if 'companion' in release else {}))


def load(url, developer=False):
    with tempfile.TemporaryDirectory(prefix='hub-catalog-') as temporary:
        target = Path(temporary) / 'catalog.json'
        download(url, target, MAX_CATALOG, developer)
        document = json.loads(target.read_text())
        return validate_registry(document, developer) if isinstance(document, list) else validate(document, developer)


def install_entry(entry, root=packages.GAMES, developer=False, update=False):
    entry = resolve_entry(entry, developer)
    root = Path(root)
    if update and not any(item['id'] == entry['id'] for item in packages.library(root)):
        raise ValueError('Update requires an installed game; use install first')
    if entry.get('schema_version') == 2:
        return install_files(entry, root, developer)
    with tempfile.TemporaryDirectory(prefix='hub-download-') as temporary:
        archive = Path(temporary) / 'game.zip'
        download(entry['url'], archive, entry['size'], developer, entry['size'], entry['sha256'])
        with zipfile.ZipFile(archive) as zipped:
            # Bound metadata before reading it; the installer validates all other files.
            if zipped.getinfo('manifest.json').file_size > 256 * 1024:
                raise ValueError('Manifest too large')
            manifest = packages.validate_manifest(json.loads(zipped.read('manifest.json')))
        if (manifest['id'], manifest['version']) != (entry['id'], entry['version']):
            raise ValueError('Catalog/package identity mismatch')
        if 'runtime' in entry and (manifest['runtime'], manifest['entrypoint']) != (entry['runtime'], entry['entrypoint']):
            raise ValueError('Release/package runtime or entrypoint mismatch')
        if 'companion' in entry and manifest.get('companion') != entry['companion']:
            raise ValueError('Release/package companion mismatch')
        return packages.install(archive, root)


def read_inventory(root, directory):
    target = directory / 'manifest.json'
    file_manifest.no_symlinks(root, target)
    if not target.is_file() or target.stat().st_size > MAX_RELEASE:
        raise ValueError('Invalid installed manifest')
    document = packages.validate_manifest(json.loads(target.read_text()))
    for name in document['files']:
        file_manifest.safe_path(name)
    return document


def comparable_inventory(document):
    return {key: document.get(key, [] if key == 'screenshots' else None)
            for key in ('schema_version', 'id', 'version', 'runtime', 'entrypoint', 'artwork', 'attract', 'screenshots', 'companion', 'files')}


def install_files(release, root, developer=False):
    """Adult CLI installation; callers must not update a running game."""
    manifest = stage_files(release, root, developer)
    activate_release(root, release['id'], release['version'])
    return manifest


def stage_entry(entry, root, developer=False):
    """Download and verify a game's current file release without activating it.

    Returns its inventory, or None for a legacy ZIP release, which has no separate
    stage. An unchanged current release costs one manifest and no file reads.
    """
    release = resolve_entry(entry, developer)
    if release.get('schema_version') != 2:
        return None
    root = Path(root).absolute()
    manifest = file_manifest.inventory(release)
    try:
        current = root / release['id'] / 'releases' / release['version']
        if ((root / release['id'] / 'current').resolve(strict=True) == current.resolve(strict=True)
                and comparable_inventory(read_inventory(root, current)) == comparable_inventory(manifest)):
            return manifest
    except (ValueError, OSError):
        pass
    return stage_files(release, root, developer)


def activate_release(root, game_id, version):
    """Atomically point a game at a staged release."""
    game = Path(root).absolute() / game_id
    selector = game / ('.current-' + secrets.token_hex(8))
    try:
        selector.symlink_to('releases/' + version)
        os.replace(selector, game / 'current')
    finally:
        selector.unlink(missing_ok=True)


def stage_files(release, root, developer=False):
    file_manifest.validate(release, release['id'], developer)
    root = Path(root).absolute()
    file_manifest.no_symlinks(root, root)
    root.mkdir(parents=True, exist_ok=True)
    manifest = file_manifest.inventory(release)
    game = root / release['id']
    releases = game / 'releases'
    target = releases / release['version']
    file_manifest.no_symlinks(root, target)
    if target.exists() and comparable_inventory(read_inventory(root, target)) != comparable_inventory(manifest):
        raise ValueError('Immutable release conflict')
    previous, old = None, None
    try:
        current = game / 'current'
        if current.is_symlink():
            previous = current.resolve(strict=True)
            previous.relative_to(releases.absolute())
            file_manifest.no_symlinks(root, previous)
            old = read_inventory(root, previous)
            if old['id'] != release['id']:
                previous, old = None, None
    except (ValueError, OSError):
        previous, old = None, None
    with tempfile.TemporaryDirectory(prefix='.install-files-', dir=root) as temporary:
        stage = Path(temporary) / 'release'
        stage.mkdir()
        fetch = []
        for name, item in release['files'].items():
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            reused = False
            if old and old['files'].get(name) == item['sha256']:
                try:
                    source = previous / name
                    file_manifest.no_symlinks(root, source)
                    if source.is_file() and source.stat().st_size == item['size']:
                        content = source.read_bytes()
                        if hashlib.sha256(content).hexdigest() == item['sha256']:
                            destination.write_bytes(content)
                            reused = True
                except OSError:
                    pass
                except ValueError:
                    pass
            if not reused:
                fetch.append((destination, item))
        # Games ship as many small files, so a serial fetch is all round trips.
        # A few at once fills the link; the first failure cancels the queue.
        if fetch:
            with concurrent.futures.ThreadPoolExecutor(min(DOWNLOAD_WORKERS, len(fetch))) as pool:
                jobs = [pool.submit(download, item['url'], destination, item['size'], developer, item['size'], item['sha256'], allow_redirects=False) for destination, item in fetch]
                try:
                    for job in concurrent.futures.as_completed(jobs):
                        job.result()
                except BaseException:
                    pool.shutdown(cancel_futures=True)
                    raise
        for name, item in release['files'].items():
            destination = stage / name
            # Validate copied bytes too, not just the transport's declaration.
            if destination.stat().st_size != item['size'] or hashlib.sha256(destination.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('File checksum/size mismatch')
            destination.chmod(0o444)
        (stage / 'manifest.json').write_bytes(file_manifest.encode(manifest))
        file_manifest.no_symlinks(root, target)
        releases.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if comparable_inventory(read_inventory(root, target)) != comparable_inventory(manifest):
                raise ValueError('Immutable release conflict')
            for name, item in release['files'].items():
                existing = target / name
                file_manifest.no_symlinks(root, existing)
                if not existing.is_file() or existing.stat().st_size != item['size'] or hashlib.sha256(existing.read_bytes()).hexdigest() != item['sha256']:
                    raise ValueError('Existing release checksum mismatch')
        else:
            stage.rename(target)
    return manifest


def remove(game_id, root=packages.GAMES):
    if not isinstance(game_id, str) or not ID.fullmatch(game_id):
        raise ValueError('Invalid game id')
    root = Path(root)
    game = root / game_id
    if game.is_symlink():
        raise ValueError('Symlinked game directory rejected')
    if not game.is_dir():
        raise ValueError('Game is not installed')
    # Rename away from discovery first. Never touch sibling saves or browser profile.
    with tempfile.TemporaryDirectory(prefix='.remove-', dir=root) as temporary:
        retired = Path(temporary) / game_id
        game.rename(retired)
        shutil.rmtree(retired)


def create(archives, output, base_url=None):
    """Publish already validated archives and metadata into an explicit output folder."""
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    entries = []
    with tempfile.TemporaryDirectory(prefix='.hub-publish-', dir=output.parent) as temporary:
        stage = Path(temporary)
        pending = []
        for index, archive in enumerate(archives):
            # Validate the exact staged bytes that will be published, not a source
            # file which could change between validation and copying.
            staged = stage / str(index)
            shutil.copyfile(archive, staged)
            manifest = packages.install(staged, stage / 'validated')
            name = manifest['id'] + '-' + manifest['version'] + '.game.zip'
            destination = output.parent / name
            content = staged.read_bytes()
            pending.append((staged, destination))
            entries.append(dict(id=manifest['id'], version=manifest['version'], title=manifest['id'],
                                size=len(content), sha256=hashlib.sha256(content).hexdigest(),
                                url=urllib.parse.urljoin(base_url.rstrip('/') + '/', name) if base_url else destination.as_uri()))
        document = dict(schema_version=1, games=entries)
        validate(document, developer=base_url is None)
        # Reject every conflicting immutable path before publishing any files.
        for staged, destination in pending:
            if destination.exists() and destination.read_bytes() != staged.read_bytes():
                raise ValueError('Published package version already has different bytes')
        for staged, destination in pending:
            try:
                # Exclusive creation also protects against concurrent publishers;
                # an existing archive is never overwritten.
                os.link(staged, destination)
            except FileExistsError:
                if destination.read_bytes() != staged.read_bytes():
                    raise ValueError('Published package version already has different bytes')
        staged_catalog = stage / 'catalog.json'
        staged_catalog.write_text(json.dumps(document, sort_keys=True, indent=2) + '\n')
        staged_catalog.replace(output)
    return document


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--root', type=Path, default=packages.GAMES, help='Installed games, never saves/profile')
    parser.add_argument('--developer-local', action='store_true', help='Allow file URLs and loopback HTTP only')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('list', 'install', 'update'):
        command = commands.add_parser(name)
        command.add_argument('catalog', help='Trusted HTTPS catalog URL (file URI with --developer-local)')
        if name != 'list':
            command.add_argument('game')
    commands.add_parser('installed')
    command = commands.add_parser('remove')
    command.add_argument('game')
    command = commands.add_parser('create')
    command.add_argument('packages', nargs='+', type=Path)
    command.add_argument('--output', required=True, type=Path)
    command.add_argument('--base-url', help='HTTPS directory URL where archives will be hosted')
    args = parser.parse_args()
    try:
        if args.command == 'create':
            result = create(args.packages, args.output, args.base_url)
        elif args.command == 'installed':
            result = packages.library(args.root)
        elif args.command == 'remove':
            remove(args.game, args.root)
            result = {'removed': args.game, 'saves': 'preserved'}
        else:
            entries = load(args.catalog, args.developer_local)
            if args.command == 'list':
                result = entries
            else:
                match = next((item for item in entries if item['id'] == args.game), None)
                if match is None:
                    raise ValueError('Game not in catalog')
                manifest = install_entry(match, args.root, args.developer_local, update=args.command == 'update')
                result = {'installed': manifest['id'], 'version': manifest['version']}
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
