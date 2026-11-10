"""Pinned CI image inputs and fail-closed full-image publication gate."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

from rocknix import image, production_image
from rocknix.setup.engine import fetch_rocknix

RUNTIME_URL = 'https://github.com/davidguttman/cubby-arcade/releases/download/rg353v-runtime-e1859403acf7/rootfs-gtk4-kiosk.tar.xz'
RUNTIME_SIZE = 290611992


def fetch_runtime(cache):
    cache = Path(cache); cache.mkdir(parents=True, exist_ok=True)
    target = cache/'rootfs-gtk4-kiosk.tar.xz'
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError('Expected regular runtime cache')
    if target.exists():
        try:
            image.verify(target, image.ROOTFS_SHA256)
            if target.stat().st_size <= RUNTIME_SIZE:
                return target
        except ValueError:
            pass
        target.unlink()
    deadline = time.monotonic() + 15*60
    fd, name = tempfile.mkstemp(prefix='runtime-', suffix='.part', dir=cache)
    partial = Path(name)
    try:
        with os.fdopen(fd, 'wb') as output, urlopen(Request(RUNTIME_URL, headers={'Accept-Encoding':'identity'}), timeout=60) as response:
            final = urlsplit(response.geturl())
            if final.scheme != 'https' or final.hostname not in ('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'):
                raise ValueError('Runtime redirected outside GitHub HTTPS')
            length = response.headers.get('Content-Length')
            if length is not None and not 0 < int(length) <= RUNTIME_SIZE:
                raise ValueError('Invalid runtime download size')
            count = 0
            while block := response.read(1024*1024):
                if time.monotonic() > deadline:
                    raise ValueError('Runtime download exceeded time budget')
                count += len(block)
                if count > RUNTIME_SIZE:
                    raise ValueError('Runtime exceeds size limit')
                output.write(block)
            if length is not None and count != int(length):
                raise ValueError('Truncated runtime download')
            output.flush(); os.fsync(output.fileno())
        image.verify(partial, image.ROOTFS_SHA256)
        os.replace(partial, target)
        return target
    finally:
        partial.unlink(missing_ok=True)


def release_files(root, directory, version, source):
    """Validate before any tag/API write; no locally provisioned image is public."""
    directory = Path(directory)
    plan = production_image.source_plan(root, version)
    if plan['source_commit'] != source:
        raise ValueError('Image source differs from publication commit')
    name = production_image.image_name(plan)
    names = (name, name+'.json', name+'.sha256')
    actual = {p.name for p in directory.glob('*.img.gz*')}
    if actual != set(names):
        raise ValueError('Exactly the selected release image trio is required')
    paths = [directory/n for n in names]
    if any(p.is_symlink() or not p.is_file() or not p.stat().st_size for p in paths):
        raise ValueError('Missing or invalid release image trio')
    if paths[0].stat().st_size >= 2*1024**3:
        raise ValueError('Image exceeds GitHub release asset limit')
    receipt = json.loads(paths[1].read_text())
    production_image.validate_binding(receipt, public=True)
    # Media IDs are fresh build randomness, not source inventories. Recompute
    # their one machine-only record while retaining exact source comparisons.
    if 'media_identities' in receipt:
        plan['media_identities'] = receipt['media_identities']
        record = production_image.image.media_identity_record(plan)
        plan['storage_files']['cubby/image-provenance/device.json'] = production_image.digest(
            json.dumps(record, sort_keys=True).encode())
    if {k:v for k,v in receipt.items() if k != 'image'} != plan:
        raise ValueError('Image receipt differs from clean release source inventories')
    if receipt['image']['filename'] != name:
        raise ValueError('Unexpected image filename')
    if paths[2].read_text() != receipt['image']['sha256']+'  '+name+'\n':
        raise ValueError('Image checksum sidecar differs')
    production_image.verify(paths[0], paths[1], expected_version=version,
                            expected_commit=source, public=True)
    return names


def build_release(cache, output, version, source):
    if production_image.source_plan(production_image.ROOT, version)['source_commit'] != source:
        raise ValueError('Build checkout does not match event source')
    upstream = fetch_rocknix(Path(cache))
    runtime = fetch_runtime(Path(cache))
    artifact = production_image.build(upstream, runtime, output, expected_version=version)
    release_files(production_image.ROOT, output, version, source)
    return artifact


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    print(build_release(args.cache, args.output, args.version, args.commit))
