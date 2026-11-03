#!/usr/bin/env python3
"""Build the cloud launcher from source plus verified, independent game releases."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import vm
import web


def retained_archives():
    archives = []
    directory = ROOT / 'hosting'
    for item in json.loads((directory / 'releases.json').read_text()):
        archive = (directory / item['path']).resolve()
        if not archive.is_relative_to(directory.resolve()) or not archive.is_file():
            raise ValueError('Invalid retained release path')
        data = archive.read_bytes()
        if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Retained release checksum/size mismatch: ' + item['path'])
        archives.append(archive)
    return archives


def build(output=None):
    output = Path(output) if output is not None else ROOT / '.cache/web'
    # Build/cache outputs stay in this checkout, not the development VM's state.
    vm.fetch_games()
    current = vm.build_example(ROOT / '.cache/packages')
    urls = web.default_manifest_urls()
    result = web.build(output, [*retained_archives(), current], manifest_urls=urls)
    redirects = {f'/store/{game}/manifest.json': url for game, url in urls.items()}
    (result / '.manifest-redirects.json').write_text(json.dumps(redirects, sort_keys=True) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--output', type=Path)
    print(build(parser.parse_args().output))
