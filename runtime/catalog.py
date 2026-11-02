"""Adult/developer catalog management. Hashes verify bytes, not publisher identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from . import packages

MAX_CATALOG = 1024 * 1024
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,79}')
VERSION = re.compile(r'[a-z0-9][a-z0-9.-]{0,79}')


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

    def __init__(self, developer):
        self.developer = developer

    def redirect_request(self, request, response, code, message, headers, newurl):
        check_url(newurl, self.developer)
        # HTTP redirects must never open files, even in local development mode.
        if urllib.parse.urlsplit(newurl).scheme == 'file':
            raise ValueError('Redirect to file rejected')
        return super().redirect_request(request, response, code, message, headers, newurl)


def download(url, destination, limit, developer=False, expected_size=None, digest=None):
    check_url(url, developer)
    opener = urllib.request.build_opener(Redirects(developer))
    deadline = time.monotonic() + 120
    size, checksum = 0, hashlib.sha256()
    with opener.open(url, timeout=20) as response, Path(destination).open('wb') as output:
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


def load(url, developer=False):
    with tempfile.TemporaryDirectory(prefix='hub-catalog-') as temporary:
        target = Path(temporary) / 'catalog.json'
        download(url, target, MAX_CATALOG, developer)
        return validate(json.loads(target.read_text()), developer)


def install_entry(entry, root=packages.GAMES, developer=False, update=False):
    validate({'schema_version': 1, 'games': [entry]}, developer)
    root = Path(root)
    if update and not any(item['id'] == entry['id'] for item in packages.library(root)):
        raise ValueError('Update requires an installed game; use install first')
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
        return packages.install(archive, root)


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
