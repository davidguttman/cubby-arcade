"""Publish a complete, verified desktop release; never overwrite release bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ARCHIVES = ('CubbyArcade-win32-x64.zip', 'CubbyArcade-linux-x64.tar.gz')
TAG = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')


class GitHubError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def github(args, document=None):
    command = ['gh', *args]
    if document is not None:
        command += ['--input', '-']
    result = subprocess.run(command, input=json.dumps(document) if document is not None else None,
                            text=True, capture_output=True)
    if result.returncode:
        match = re.search(r'\(HTTP ([0-9]{3})\)', result.stderr)
        raise GitHubError(result.stderr.strip(), int(match[1]) if match else None)
    return json.loads(result.stdout) if args[0] == 'api' and result.stdout.strip() else None


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def publish(tag, repository, directory, package, gh=github, extra_files=()):
    if not TAG.fullmatch(tag) or tag[1:] != json.loads(Path(package).read_text())['version']:
        raise ValueError('Stable release tag must equal package.json version')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid GitHub repository')
    directory = Path(directory)
    expected = {}
    for name in ARCHIVES:
        file, checksum = directory / name, directory / (name + '.sha256')
        if any(not p.is_file() or p.is_symlink() or p.stat().st_size == 0 for p in (file, checksum)):
            raise ValueError('Missing release archive/checksum: ' + name)
        value = digest(file)
        if checksum.read_text().strip() != value + '  ' + name:
            raise ValueError('Release checksum mismatch: ' + name)
        for path in (file, checksum):
            expected[path.name] = {'size': path.stat().st_size, 'digest': 'sha256:' + digest(path)}

    for name in extra_files:
        if name not in ('app.zip', 'manifest.json', 'manifest.json.sig', 'platform.zip', 'update.json', 'update.json.sig'):
            raise ValueError('Unexpected additional release asset')
        path = directory / name
        if not path.is_file() or path.is_symlink() or not path.stat().st_size:
            raise ValueError('Missing additional release asset: ' + name)
        expected[name] = {'size': path.stat().st_size, 'digest': 'sha256:' + digest(path)}

    base = 'repos/' + repository
    # Do not let the Releases API implicitly create a missing tag.
    gh(['api', base + '/git/ref/tags/' + tag])
    try:
        release = gh(['api', base + '/releases/tags/' + tag])
    except GitHubError as error:
        if error.status != 404:
            raise
        # Drafts are not discoverable by the by-tag endpoint. Inspect every
        # authenticated release-list page before creating a draft on retries.
        pages = gh(['api', '--paginate', '--slurp', base + '/releases?per_page=100'])
        matches = [item for page in pages for item in page if item['tag_name'] == tag]
        if len(matches) > 1:
            raise ValueError('Multiple releases match this tag; refusing to choose')
        release = matches[0] if matches else gh(['api', '--method', 'POST', base + '/releases'], {
            'tag_name': tag, 'name': 'Cubby Arcade ' + tag[1:], 'draft': True,
            'prerelease': False, 'make_latest': 'false'})

    def assets(document):
        if document['tag_name'] != tag or document.get('prerelease'):
            raise ValueError('Unexpected release identity')
        result = {}
        for asset in document['assets']:
            name = asset['name']
            if name in expected:
                if name in result or any(asset.get(k) != v for k, v in expected[name].items()):
                    raise ValueError('Existing release asset differs: ' + name)
                result[name] = asset
        return result

    existing = assets(release)
    if not release['draft']:
        if set(existing) != set(expected):
            raise ValueError('Published release is incomplete; refusing to modify it')
        print('Published release already matches verified artifacts: ' + tag)
        return
    for name in expected:
        if name not in existing:
            gh(['release', 'upload', tag, str(directory / name), '--repo', repository])
    verified = gh(['api', base + '/releases/' + str(release['id'])])
    if verified['id'] != release['id'] or not verified['draft'] or set(assets(verified)) != set(expected):
        raise ValueError('Draft release does not contain every verified artifact')
    gh(['api', '--method', 'PATCH', base + '/releases/' + str(release['id'])],
       {'draft': False, 'make_latest': 'true'})
    print('Published complete Cubby release: ' + tag)


if __name__ == '__main__':
    tag = os.environ.get('GITHUB_REF_NAME', '')
    if os.environ.get('GITHUB_EVENT_NAME') != 'push' or os.environ.get('GITHUB_REF') != 'refs/tags/' + tag:
        raise SystemExit('Release publication requires a tag-push event')
    root = Path(__file__).resolve().parent.parent
    publish(tag, os.environ['GITHUB_REPOSITORY'], root / 'dist/release', root / 'package.json')
