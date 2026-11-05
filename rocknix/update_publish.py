"""Publish a signed app-only release and its stable feed; never handles private keys.

Run after rocknix.update_release. Requires authenticated gh and OpenSSL.
Only one maintainer/publishing host may publish the stable channel at a time.
"""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from rocknix.updates import MAX_ARCHIVE, validate_manifest

REPO = 'davidguttman/cubby-arcade'
CHANNEL = 'cubby-device-stable'
FEED = f'https://github.com/{REPO}/releases/download/{CHANNEL}/manifest.json'
PAIR = ('manifest.json', 'manifest.json.sig')
FILES = ('app.zip', *PAIR)


def archive_url(version):
    return f'https://github.com/{REPO}/releases/download/cubby-device-v{version}/app.zip'


def verify(raw, signature, public_key):
    if len(raw) > 1024**2 or len(signature) != 64:
        raise ValueError('Invalid signed metadata size')
    with tempfile.TemporaryDirectory(prefix='cubby-publish-verify-') as temporary:
        root = Path(temporary)
        (root/'manifest').write_bytes(raw); (root/'signature').write_bytes(signature)
        result = subprocess.run(['openssl','pkeyutl','-verify','-pubin','-rawin',
            '-inkey',str(public_key),'-in',str(root/'manifest'),'-sigfile',str(root/'signature')],
            capture_output=True, timeout=15)
        if result.returncode:
            raise ValueError('Release signature verification failed')
    return validate_manifest(json.loads(raw))


class GitHub:
    def run(self, *args):
        return subprocess.run(['gh',*args],check=True,capture_output=True,timeout=180)
    def assets(self, tag):
        result = subprocess.run(['gh','api',f'repos/{REPO}/releases/tags/{tag}'],
                                capture_output=True,timeout=60)
        if result.returncode:
            if b'HTTP 404' in result.stderr:
                return None
            raise RuntimeError('Cannot inspect release: '+result.stderr.decode(errors='replace'))
        release = json.loads(result.stdout)
        if release['draft']:
            raise ValueError('Existing release is draft; resolve it explicitly')
        return {a['name']: a for a in release['assets']}
    def create(self, tag, target):
        self.run('release','create',tag,'--repo',REPO,'--target',target,
                 '--title', 'Cubby device stable feed' if tag == CHANNEL else tag,
                 '--notes','Signed app-only Cubby device update. Not a ROCKNIX image.',
                 '--latest=false')
    def upload(self, tag, files, clobber=False):
        args = ['release','upload',tag,*[str(p) for p in files],'--repo',REPO]
        if clobber: args.append('--clobber')
        self.run(*args)
    def download(self, tag, name):
        with tempfile.TemporaryDirectory(prefix='cubby-published-') as temporary:
            self.run('release','download',tag,'--repo',REPO,'--pattern',name,'--dir',temporary)
            path=Path(temporary)/name
            maximum = MAX_ARCHIVE if name == 'app.zip' else 1024**2
            if path.stat().st_size > maximum: raise ValueError('Published asset exceeds bound')
            return path.read_bytes()


def publish(output, public_key, target, github=None):
    """Retry-safe immutable upload, followed by stable metadata publication.

    GitHub cannot atomically replace two assets. A transient mismatched pair is
    rejected by device signature verification. On observed failures restore the
    previous verified pair. After uncatchable termination, repair a mismatched
    stable pair explicitly from a verified immutable release (see the runbook). Never replace app.zip or an existing immutable release.
    """
    gh=github or GitHub(); output=Path(output); public_key=Path(public_key)
    if len(target) != 40 or any(c not in '0123456789abcdef' for c in target):
        raise ValueError('Exact source commit SHA required')
    local={}
    for name in FILES:
        path=output/name
        maximum=MAX_ARCHIVE if name=='app.zip' else 1024**2
        if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
            raise ValueError('Invalid release file: '+name)
        local[name]=path.read_bytes()
    manifest=verify(local['manifest.json'],local['manifest.json.sig'],public_key)
    archive=manifest['archive']
    if (archive['url'] != archive_url(manifest['version']) or len(local['app.zip']) != archive['size'] or
            hashlib.sha256(local['app.zip']).hexdigest() != archive['sha256']):
        raise ValueError('Archive content or immutable URL does not match signed manifest')
    tag='cubby-device-v'+manifest['version']
    old_assets=gh.assets(CHANNEL); old=None
    if old_assets is not None:
        if not all(n in old_assets for n in PAIR):
            raise ValueError('Stable feed incomplete; repair explicitly from immutable release')
        old={n:gh.download(CHANNEL,n) for n in PAIR}
        previous=verify(old[PAIR[0]],old[PAIR[1]],public_key)
        if previous['sequence'] >= manifest['sequence']:
            if old == {n:local[n] for n in PAIR}:
                # Do not bypass verification of the immutable release on a retry.
                same=True
            else:
                raise ValueError('Stable sequence must increase; refusing replay/conflict')
        else: same=False
    else: same=False
    assets=gh.assets(tag)
    if assets is not None:
        if set(assets)-set(FILES) or any(gh.download(tag,n)!=local[n] for n in assets):
            raise ValueError('Existing immutable release differs; refusing overwrite')
        missing=[output/n for n in FILES if n not in assets]
        if missing: gh.upload(tag,missing)
    else:
        gh.create(tag,target)
        gh.upload(tag,[output/n for n in FILES])
    if any(gh.download(tag,n)!=local[n] for n in FILES):
        raise ValueError('Uploaded immutable bytes differ')
    if same: return manifest
    if old_assets is None: gh.create(CHANNEL,target)
    try:
        gh.upload(CHANNEL,[output/n for n in PAIR],clobber=True)
        if any(gh.download(CHANNEL,n)!=local[n] for n in PAIR):
            raise ValueError('Published stable feed differs')
    except BaseException:
        if old is not None:
            with tempfile.TemporaryDirectory(prefix='cubby-restore-feed-') as temporary:
                root=Path(temporary)
                for name,body in old.items(): (root/name).write_bytes(body)
                gh.upload(CHANNEL,[root/n for n in PAIR],clobber=True)
                if any(gh.download(CHANNEL,n)!=old[n] for n in PAIR):
                    raise RuntimeError('Stable feed restoration failed; repair from immutable assets')
        raise
    return manifest


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--public-key',type=Path,required=True)
    parser.add_argument('--commit',required=True)
    args=parser.parse_args()
    # Serialize this publishing host; remote publishers must not run concurrently.
    lock=Path.home()/'.local/state/cubby-device-publisher.lock'
    lock.parent.mkdir(parents=True,exist_ok=True)
    with lock.open('a') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        m=publish(args.output,args.public_key,args.commit)
    print(f"Published Cubby device {m['version']} (sequence {m['sequence']}): {FEED}")

if __name__=='__main__': main()
