"""Generate a game-owned file release. Standalone, Python standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from urllib.parse import quote, urlsplit

MAX_BYTES = 128 * 1024 * 1024
MAX_MANIFEST = 256 * 1024
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,79}')
VERSION = re.compile(r'[a-z0-9][a-z0-9.-]{0,79}')


def safe_path(name):
    if (not isinstance(name, str) or not name or '\\' in name or '\0' in name
            or re.search(r'[%?#\x00-\x1f\x7f]', name) or name.endswith(' ')
            or name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/'))):
        raise ValueError('Invalid file path')
    return name


def check_url(value, developer=False):
    if not isinstance(value, str):
        raise ValueError('Invalid URL')
    url = urlsplit(value)
    if url.username or url.password or url.fragment:
        raise ValueError('URL credentials/fragments rejected')
    if url.scheme == 'https' and url.hostname:
        return value
    if developer and ((url.scheme == 'file' and not url.netloc and url.path.startswith('/'))
                      or (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1'))):
        return value
    raise ValueError('HTTPS required')


def validate(document, game_id, developer=False):
    if (not isinstance(document, dict) or type(document.get('schema_version')) is not int
            or document['schema_version'] != 2 or document.get('runtime') != 'web'
            or not isinstance(game_id, str) or not ID.fullmatch(game_id) or document.get('id') != game_id):
        raise ValueError('Invalid file release identity/runtime')
    version = document.get('version')
    if not isinstance(version, str) or not VERSION.fullmatch(version) or '..' in version:
        raise ValueError('Invalid release version')
    files = document.get('files')
    if 'package' in document or not isinstance(files, dict) or not 1 <= len(files) <= 1000:
        raise ValueError('Invalid file inventory')
    total = 0
    for name, item in files.items():
        safe_path(name)
        if name == 'manifest.json' or name.startswith('manifest.json/'):
            raise ValueError('Reserved manifest path')
        parts = name.split('/')
        if any('/'.join(parts[:i]) in files for i in range(1, len(parts))):
            raise ValueError('Conflicting file paths')
        if (not isinstance(item, dict) or type(item.get('size')) is not int or item['size'] < 0
                or not isinstance(item.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', item['sha256'])):
            raise ValueError('Invalid file metadata')
        total += item['size']
        if total > MAX_BYTES:
            raise ValueError('Release too large')
        check_url(item.get('url'), developer)
    for key in ('entrypoint', 'artwork', 'attract'):
        if key != 'attract' or key in document:
            if safe_path(document.get(key)) not in files:
                raise ValueError('Missing game asset: ' + key)
    screenshots = document.get('screenshots', [])
    if not isinstance(screenshots, list) or len(screenshots) > 12:
        raise ValueError('Invalid screenshots')
    for name in screenshots:
        if safe_path(name) not in files:
            raise ValueError('Missing screenshot')
    if len(encode(document)) > MAX_MANIFEST:
        raise ValueError('Manifest too large')
    return document


def encode(document):
    return (json.dumps(document, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')


def inventory(document):
    return {**{key: document[key] for key in ('id', 'version', 'runtime', 'entrypoint', 'artwork', 'attract', 'screenshots') if key in document},
            'schema_version': 1, 'files': {name: item['sha256'] for name, item in document['files'].items()}}


def no_symlinks(root, target):
    root, target = Path(root).absolute(), Path(target).absolute()
    relative = target.relative_to(root)
    current = root
    for piece in (None, *relative.parts):
        if piece is not None:
            current = current / piece
        if current.is_symlink():
            raise ValueError('Symlinked file path')


def generate(build, game_id, version, entrypoint, artwork, base_url, attract=None, screenshots=None):
    build = Path(build).absolute()
    no_symlinks(Path(build.anchor), build)
    if not build.is_dir():
        raise ValueError('Build directory required')
    check_url(base_url)
    parsed = urlsplit(base_url)
    if parsed.query:
        raise ValueError('Base URL must not contain a query')
    files, total = {}, 0
    for directory, dirs, names in os.walk(build, followlinks=False):
        for name in dirs + names:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError('Only regular files/directories allowed')
        for name in sorted(names):
            path = Path(directory) / name
            relative = path.relative_to(build).as_posix()
            safe_path(relative)
            if relative == 'manifest.json' or relative.startswith('manifest.json/'):
                raise ValueError('Reserved manifest path')
            size = path.stat().st_size
            total += size
            if total > MAX_BYTES or len(files) >= 1000:
                raise ValueError('Release too large')
            content = path.read_bytes()
            if len(content) != size:
                raise ValueError('Build changed during manifest generation')
            files[relative] = dict(url=base_url.rstrip('/') + '/' + quote(relative, safe='/'), size=size,
                                   sha256=hashlib.sha256(content).hexdigest())
    result = dict(schema_version=2, id=game_id, version=version, runtime='web', entrypoint=entrypoint, artwork=artwork, files=files)
    if attract is not None:
        result['attract'] = attract
    if screenshots is not None:
        result['screenshots'] = screenshots
    return validate(result, game_id)


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('build', type=Path)
    for name in ('id', 'version', 'entrypoint', 'artwork', 'base-url'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--attract')
    parser.add_argument('--screenshot', action='append', default=None)
    parser.add_argument('--output', type=Path, required=True, help='Manifest destination outside the build directory')
    args = parser.parse_args()
    try:
        output = args.output.absolute()
        if output.resolve().is_relative_to(args.build.resolve()):
            raise ValueError('Output manifest must be outside the payload build directory')
        document = generate(args.build, args.id, args.version, args.entrypoint, args.artwork, args.base_url, args.attract, args.screenshot)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as temporary:
            temporary.write(encode(document))
            staged = Path(temporary.name)
        try:
            os.replace(staged, output)
        finally:
            staged.unlink(missing_ok=True)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
