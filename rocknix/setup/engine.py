"""Download official ROCKNIX and compose locally using our separately shipped files.

No function in this module opens physical disks or changes internal Android.
The payload is an ordinary directory, not an untrusted archive to extract.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from rocknix import image

ROCKNIX_FILENAME = 'ROCKNIX-RK3566.aarch64-20261101-Generic.img.gz'
ROCKNIX_URL = 'https://github.com/ROCKNIX/distribution/releases/download/20261101/' + ROCKNIX_FILENAME
MAX_ROCKNIX_BYTES = 3 * 1024 ** 3
MAX_PAYLOAD_BYTES = 2 * 1024 ** 3
MAX_PAYLOAD_FILES = 2000
BLOCK = 1024 * 1024


def _hash(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch_rocknix(cache: Path, progress=None) -> Path:
    """Use a checksum-verified cache, or atomically cache a bounded official download.

    A corrupt cache entry is discarded. A failed/partial download is never made
    available under the cache filename. No caller-supplied download URL exists.
    """
    report = progress or (lambda message: None)
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / ROCKNIX_FILENAME
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError('ROCKNIX cache entry must be a regular file, not a symlink')
    if target.exists():
        report('Checking cached official ROCKNIX image...')
        if target.stat().st_size <= MAX_ROCKNIX_BYTES and _hash(target) == image.ROCKNIX_SHA256:
            return target
        report('Discarding corrupt ROCKNIX cache entry; downloading again...')
        target.unlink()
    report('Downloading official ROCKNIX directly from GitHub...')
    request = Request(ROCKNIX_URL, headers={'User-Agent': 'Cubby-Setup/1', 'Accept-Encoding': 'identity'})
    fd, name = tempfile.mkstemp(prefix='rocknix-', suffix='.part', dir=cache)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'wb') as destination, urlopen(request, timeout=60) as response:
            final = urlsplit(response.geturl())
            if final.scheme != 'https' or final.hostname not in ('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'):
                raise ValueError('Official ROCKNIX download redirected outside GitHub HTTPS assets')
            header = response.headers.get('Content-Length')
            length = None if header is None else int(header)
            if length is not None and not 0 < length <= MAX_ROCKNIX_BYTES:
                raise ValueError('Invalid or oversized official ROCKNIX download')
            count = 0
            digest = hashlib.sha256()
            while block := response.read(BLOCK):
                count += len(block)
                if count > MAX_ROCKNIX_BYTES:
                    raise ValueError('Official ROCKNIX download exceeds size limit')
                destination.write(block)
                digest.update(block)
            if length is not None and count != length:
                raise ValueError('Truncated official ROCKNIX download')
            if digest.hexdigest() != image.ROCKNIX_SHA256:
                raise ValueError('Official ROCKNIX checksum mismatch; nothing was composed')
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, target)
        report('Official ROCKNIX checksum verified.')
        return target
    finally:
        temporary.unlink(missing_ok=True)


def _allowed_name(name: str) -> bool:
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != name:
        return False
    if (any(part in ('.cache', '.git', '__pycache__') for part in path.parts)
            or name.endswith(('.pyc', '.img', '.img.gz'))):
        return False
    return name == 'rootfs.tar.xz' or name == 'app/hosting/catalog.yaml' or name.startswith(('app/runtime/', 'app/rocknix/'))


def _inventory(payload: Path) -> dict:
    result = {}
    total = 0
    for path in sorted(payload.rglob('*')):
        if path.is_symlink():
            raise ValueError('Payload cannot contain symlinks')
        if path.is_dir():
            continue
        name = path.relative_to(payload).as_posix()
        if name == 'payload.json':
            continue
        if not path.is_file() or not _allowed_name(name):
            raise ValueError('Unexpected payload member: ' + name)
        size = path.stat().st_size
        total += size
        if total > MAX_PAYLOAD_BYTES or len(result) >= MAX_PAYLOAD_FILES:
            raise ValueError('Payload exceeds size/file limits')
        result[name] = {'sha256': _hash(path), 'size': size, 'mode': stat.S_IMODE(path.stat().st_mode)}
    return result


def make_payload(rootfs: Path, output: Path, source_root: Path = image.ROOT) -> Path:
    """Maintainer packaging: emit only WPE/Cubby sources plus a hash/mode inventory.

    No official ROCKNIX image or combined disk is copied. The later Linux app
    packages this directory alongside its interpreter and filesystem helpers.
    """
    image.verify(rootfs, image.ROOTFS_SHA256)
    output = Path(output)
    source_root = Path(source_root)
    if output.exists() or output.is_symlink():
        raise ValueError('Refusing to replace existing payload output')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cubby-payload-', dir=output.parent) as directory:
        stage = Path(directory) / 'payload'
        stage.mkdir()
        shutil.copy2(rootfs, stage / 'rootfs.tar.xz')
        for name in ('runtime', 'rocknix'):
            shutil.copytree(source_root / name, stage / 'app' / name, symlinks=True,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (stage / 'app/hosting').mkdir()
        shutil.copy2(source_root / 'hosting/catalog.yaml', stage / 'app/hosting/catalog.yaml')
        manifest = {
            'schema_version': 1,
            'rocknix_sha256': image.ROCKNIX_SHA256,
            'rootfs_sha256': image.ROOTFS_SHA256,
            'source': image.source_provenance(source_root),
            'files': _inventory(stage),
        }
        (stage / 'payload.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        validate_payload(stage)
        if output.exists() or output.is_symlink():
            raise ValueError('Refusing to replace existing payload output')
        stage.rename(output)
    return output


def validate_payload(payload: Path) -> dict:
    """Verify our packaged files before composition, without requiring a checkout."""
    payload = Path(payload)
    manifest_path = payload / 'payload.json'
    if payload.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 2 * 1024 ** 2:
        raise ValueError('Missing or invalid Cubby payload manifest')
    try:
        manifest = json.loads(manifest_path.read_text())
    except (ValueError, UnicodeError) as error:
        raise ValueError('Invalid Cubby payload manifest') from error
    if not isinstance(manifest, dict) or manifest.get('schema_version') != 1:
        raise ValueError('Unsupported Cubby payload schema')
    files = manifest.get('files')
    source = manifest.get('source')
    if not isinstance(files, dict) or not files or len(files) > MAX_PAYLOAD_FILES or not isinstance(source, dict):
        raise ValueError('Invalid Cubby payload inventory/provenance')
    image.source_provenance(payload / 'app', source)
    if manifest.get('rootfs_sha256') != image.ROOTFS_SHA256 or manifest.get('rocknix_sha256') != image.ROCKNIX_SHA256:
        raise ValueError('Payload targets different pinned inputs')
    if any(not isinstance(name, str) or not _allowed_name(name) for name in files):
        raise ValueError('Unsafe or unexpected payload inventory path')
    required = {'rootfs.tar.xz', 'app/runtime/server.py', 'app/rocknix/session.sh',
                'app/rocknix/device/launch.sh', 'app/hosting/catalog.yaml'}
    if not required <= files.keys() or _inventory(payload) != files:
        raise ValueError('Cubby payload inventory/checksum/mode mismatch')
    image.verify(payload / 'rootfs.tar.xz', image.ROOTFS_SHA256)
    return manifest


def compose_image(upstream: Path, payload: Path, output: Path, storage_gib: int = 6, progress=None) -> Path:
    """Worker API: call inside the Linux root-mapped namespace, never real disks."""
    manifest = validate_payload(payload)
    return image.build(upstream, payload / 'rootfs.tar.xz', output, storage_gib,
                       source_root=payload / 'app', source_info=manifest['source'], progress=progress)


def _run_worker(command: list[str], progress=None) -> None:
    report = progress or (lambda message: None)
    tail = deque(maxlen=20)
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as process:
        for line in process.stdout:
            tail.append(line.rstrip())
            report(line.rstrip())
        code = process.wait()
    if code:
        raise RuntimeError('Image composition failed (exit %s):\n%s' % (code, '\n'.join(tail)))


def compose(payload: Path, cache: Path, output: Path, storage_gib: int = 6,
            progress=None, worker_command: list[str] | None = None) -> Path:
    """UI API: fetch official ROCKNIX and run a packaged interpreter worker.

    The default command is ``sys.executable -m rocknix.setup``. A launcher may
    supply its own entry point. No shell interpolation, sudo or global install.
    """
    if not sys.platform.startswith('linux'):
        raise ValueError('Cubby Setup currently supports Linux only')
    payload, output = Path(payload).resolve(), Path(output).absolute()
    validate_payload(payload)
    if any(path.is_symlink() or path.exists()
           for path in (output, output.with_name(output.name + '.sha256'))):
        raise ValueError('Refusing to replace an existing composed image')
    if not 4 <= storage_gib <= 64:
        raise ValueError('STORAGE size must be between 4 and 64 GiB')
    upstream = fetch_rocknix(Path(cache), progress)
    if os.geteuid() == 0:
        compose_image(upstream, payload, output, storage_gib, progress)
    else:
        command = ['unshare', '--map-auto', '--map-root-user']
        command += worker_command if worker_command is not None else [sys.executable, '-m', 'rocknix.setup']
        command += ['worker', '--upstream', str(upstream.resolve()), '--payload', str(payload),
                    '--output', str(output), '--storage-gib', str(storage_gib)]
        _run_worker(command, progress)
    sidecar = output.with_name(output.name + '.sha256')
    if not output.is_file() or output.is_symlink() or not sidecar.is_file() or sidecar.is_symlink() or sidecar.stat().st_size > 4096:
        raise ValueError('Image worker produced no verified output')
    record = sidecar.read_text().strip().split('  ', 1)
    if len(record) != 2 or record[1] != output.name or len(record[0]) != 64:
        raise ValueError('Image worker produced no verified output checksum')
    image.verify(output, record[0])
    return output


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    payload = sub.add_parser('payload', help='Maintainer: package only our additions')
    payload.add_argument('--rootfs', type=Path, required=True)
    payload.add_argument('--source', type=Path, default=image.ROOT)
    payload.add_argument('--output', type=Path, required=True)
    fetch = sub.add_parser('fetch', help='Download/checksum official ROCKNIX directly')
    fetch.add_argument('--cache', type=Path, required=True)
    for name in ('compose', 'worker'):
        task = sub.add_parser(name)
        task.add_argument('--payload', type=Path, required=True)
        task.add_argument('--output', type=Path, required=True)
        task.add_argument('--storage-gib', type=int, default=6)
        if name == 'worker':
            task.add_argument('--upstream', type=Path, required=True)
        else:
            task.add_argument('--cache', type=Path, required=True)
    args = parser.parse_args(argv)
    report = lambda message: print(message, flush=True)
    if args.action == 'payload':
        print(make_payload(args.rootfs, args.output, args.source))
    elif args.action == 'fetch':
        print(fetch_rocknix(args.cache, report))
    elif args.action == 'compose':
        print(compose(args.payload, args.cache, args.output, args.storage_gib, report))
    else:
        print(compose_image(args.upstream, args.payload, args.output, args.storage_gib, report))
