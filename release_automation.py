"""One Cubby version, source commit and GitHub release across supported platforms."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from desktop.release import github, GitHubError, digest, publish as publish_release
from rocknix import update_publish, update_release

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
DEVICE_FILES = ('app.zip', 'manifest.json', 'manifest.json.sig')


def sequence(version):
    """SemVer ordered anti-replay value, not another product version counter."""
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError('Expected a stable SemVer version')
    major, minor, patch = map(int, version.split('.'))
    if max(major, minor, patch) >= 10000:
        raise ValueError('Release version components must be below 10000')
    return (major * 10000 + minor) * 10000 + patch + 1


def package_version(package):
    version = json.loads(Path(package).read_text())['version']
    sequence(version)
    return version


def commit(value):
    if not re.fullmatch('[0-9a-f]{40}', value):
        raise ValueError('Exact source commit SHA required')
    return value


def optional_api(endpoint, gh):
    try:
        return gh(['api', endpoint])
    except GitHubError as error:
        if error.status != 404:
            raise
        return None


def tag_commit(repository, tag, gh):
    ref = optional_api(f'repos/{repository}/git/ref/tags/{tag}', gh)
    if ref is None:
        return None
    obj = ref['object']
    # Annotated tags must resolve to a commit, too; reject unexpected chains.
    for _ in range(4):
        if obj['type'] == 'commit':
            return commit(obj['sha'])
        if obj['type'] != 'tag':
            break
        obj = gh(['api', f'repos/{repository}/git/tags/{obj["sha"]}'])['object']
    raise ValueError('Tag does not resolve to a commit')


def plan(package, source, ref, gh=github, repository=update_publish.REPO):
    version = package_version(package); commit(source); tag = 'v' + version
    result = {'version': version, 'tag': tag, 'sequence': str(sequence(version)), 'release': 'false'}
    if ref != 'refs/heads/main' and not ref.startswith('refs/tags/v'):
        return result
    if ref.startswith('refs/tags/') and ref != 'refs/tags/' + tag:
        raise ValueError('Release tag must equal package.json version')
    existing = tag_commit(repository, tag, gh)
    if existing is not None and existing != source:
        release = optional_api(f'repos/{repository}/releases/tags/{tag}', gh)
        if ref == 'refs/heads/main' and release is not None and not release['draft']:
            # Ordinary non-release pushes keep the current version; never republish.
            return result
        raise ValueError('Version tag already belongs to a different source commit')
    # Refuse publishing older/newly invented versions beneath an existing stable release.
    pages = gh(['api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100'])
    for page in pages:
        for release in page:
            name = release.get('tag_name', '')
            if (not release.get('draft') and not release.get('prerelease') and name.startswith('v')
                    and VERSION.fullmatch(name[1:]) and sequence(name[1:]) > sequence(version)):
                raise ValueError('A newer Cubby release already exists')
    result['release'] = 'true'
    return result


def device_url(version):
    return f'https://github.com/{update_publish.REPO}/releases/download/v{version}/app.zip'


def prepare_device(source, output, key):
    source = Path(source)
    version = package_version(source / 'package.json')
    return update_release.build(source, output, version, sequence(version), device_url(version), key)


def verify_device(directory, public_key, version):
    directory = Path(directory)
    raw = (directory / 'manifest.json').read_bytes()
    manifest = update_publish.verify(raw, (directory / 'manifest.json.sig').read_bytes(), public_key)
    archive = directory / 'app.zip'
    if (manifest['version'] != version or manifest['sequence'] != sequence(version)
            or manifest['archive']['url'] != device_url(version)
            or not archive.is_file() or archive.is_symlink()
            or archive.stat().st_size != manifest['archive']['size']
            or digest(archive) != manifest['archive']['sha256']):
        raise ValueError('Signed device artifact/version does not match unified release')
    return manifest


def advance_feed(directory, public_key, source, gh=None):
    """Only advertise already-published, byte-verified unified release assets."""
    gh = gh or update_publish.GitHub()
    directory = Path(directory)
    raw = (directory / 'manifest.json').read_bytes()
    manifest = update_publish.verify(raw, (directory / 'manifest.json.sig').read_bytes(), public_key)
    verify_device(directory, public_key, manifest['version']); commit(source)
    tag = 'v' + manifest['version']
    assets = gh.assets(tag)
    if assets is None or not all(name in assets for name in DEVICE_FILES):
        raise ValueError('Complete published unified release required before feed update')
    local = {name: (directory / name).read_bytes() for name in DEVICE_FILES}
    if any(gh.download(tag, name) != local[name] for name in DEVICE_FILES):
        raise ValueError('Published unified device assets differ')
    old_assets = gh.assets(update_publish.CHANNEL); old = None
    if old_assets is not None:
        if not all(name in old_assets for name in update_publish.PAIR):
            raise ValueError('Stable feed incomplete; explicitly repair from immutable release')
        old = {name: gh.download(update_publish.CHANNEL, name) for name in update_publish.PAIR}
        previous = update_publish.verify(old['manifest.json'], old['manifest.json.sig'], public_key)
        if old == {name: local[name] for name in update_publish.PAIR}:
            return manifest
        if previous['sequence'] >= manifest['sequence']:
            raise ValueError('Stable feed cannot go backwards or reuse a sequence')
    else:
        gh.create(update_publish.CHANNEL, source)
    try:
        gh.upload(update_publish.CHANNEL, [directory / name for name in update_publish.PAIR], clobber=True)
        if any(gh.download(update_publish.CHANNEL, name) != local[name] for name in update_publish.PAIR):
            raise ValueError('Published stable metadata differs')
    except BaseException:
        if old is not None:
            with tempfile.TemporaryDirectory(prefix='cubby-restore-feed-') as temp:
                root = Path(temp)
                for name, body in old.items(): (root / name).write_bytes(body)
                gh.upload(update_publish.CHANNEL, [root / name for name in update_publish.PAIR], clobber=True)
                if any(gh.download(update_publish.CHANNEL, name) != old[name] for name in update_publish.PAIR):
                    raise RuntimeError('Feed restoration failed; repair from immutable release')
        raise
    return manifest


def publish_all(root, directory, source, gh=github):
    root, directory = Path(root), Path(directory)
    version = package_version(root / 'package.json'); tag = 'v' + version; commit(source)
    key = root / 'rocknix/device/release-key.pem'
    verify_device(directory, key, version)
    existing = tag_commit(update_publish.REPO, tag, gh)
    if existing is None:
        gh(['api', '--method', 'POST', f'repos/{update_publish.REPO}/git/refs'],
           {'ref': 'refs/tags/' + tag, 'sha': source})
    elif existing != source:
        raise ValueError('Release tag source differs')
    publish_release(tag, update_publish.REPO, directory, root / 'package.json', gh,
                    extra_files=DEVICE_FILES)
    # The release is public only after all seven assets were verified. This is last.
    return advance_feed(directory, key, source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'device', 'publish'])
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--directory', type=Path, default=Path('dist/release'))
    parser.add_argument('--key', type=Path)
    args = parser.parse_args()
    if args.action == 'plan':
        result = plan(args.root / 'package.json', os.environ['GITHUB_SHA'], os.environ['GITHUB_REF'])
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for name, value in result.items(): output.write(f'{name}={value}\n')
        print('Release plan:', json.dumps(result))
    elif args.action == 'device':
        if args.key is None: parser.error('--key is required for signing')
        prepare_device(args.root, args.directory, args.key)
    else:
        if os.environ.get('GITHUB_EVENT_NAME') not in ('push', 'workflow_dispatch'):
            raise ValueError('Publication requires a push or explicit workflow dispatch')
        source = os.environ['GITHUB_SHA']
        if os.environ['GITHUB_REF'] not in ('refs/heads/main', 'refs/tags/v' + package_version(args.root / 'package.json')):
            raise ValueError('Publication requires main or the matching release tag')
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.root, text=True).strip()
        if actual != source: raise ValueError('Checkout does not match event source commit')
        publish_all(args.root, args.directory, source)

if __name__ == '__main__': main()
