#!/usr/bin/env python3
"""Build the cloud launcher from source plus verified, independent game releases."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import vm
import web
from runtime import catalog


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


def legacy_manifests(urls):
    """Freeze only compatibility endpoints; current catalogs use publisher URLs.

    Resolve at the final publisher URL before exporting: a static copy must not
    reinterpret relative download paths against Cubby's unrelated origin.
    Invalid or unavailable metadata fails the build, never creates a fake offer.
    """
    result = {}
    with tempfile.TemporaryDirectory(prefix='cubby-metadata-') as temporary:
        for game, url in urls.items():
            target = Path(temporary) / 'manifest.json'
            final_url = catalog.download(url, target, catalog.MAX_RELEASE)
            result[game] = catalog.validate_release(json.loads(target.read_bytes()), game,
                                                    manifest_url=final_url)
    return result


def build(output=None):
    output = Path(output) if output is not None else ROOT / '.cache/web'
    # Build/cache outputs stay in this checkout, not the development VM's state.
    vm.fetch_games()
    current = vm.build_example(ROOT / '.cache/packages')
    urls = web.default_manifest_urls()
    snapshots = legacy_manifests(urls)
    result = web.build(output, [*retained_archives(), current],
                       base_url='https://cubby.david.app', manifest_urls=urls,
                       registry=web.default_registry())
    for game, document in snapshots.items():
        destination = result / 'store' / game / 'manifest.json'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(document, sort_keys=True) + '\n')
    # Native cache keys remain /index.html, but native transport is a distinct
    # physical file. Root becomes the adult landing page with no runtime router.
    shutil.copyfile(result / 'site/index.html', result / 'index.html')
    shutil.copyfile(result / 'site/favicon.ico', result / 'favicon.ico')
    # The grown-ups' app a phone opens by scanning the Cubby's code. A game's own grown-ups page
    # (catalog `parents`) is served under /parents/<id>/ by a rewrite on the host, so it shares the pairing.
    # web.build already includes the companion and all install assets.
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--output', type=Path)
    print(build(parser.parse_args().output))
