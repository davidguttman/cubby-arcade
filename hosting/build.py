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

PLAY_ORIGIN = 'https://play.cubbyarcade.com'


def marketing_build(output):
    """An independent static artifact: no launcher, feeds, tools or docs."""
    output = output.resolve()
    if output == ROOT or ROOT.is_relative_to(output):
        raise ValueError('Output cannot replace the source tree')
    if output.exists() and not (output / '.handheld-web-export').is_file():
        raise ValueError('Refusing to replace an unrelated output directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.marketing-') as tmp:
        stage = Path(tmp) / 'site'
        stage.mkdir()
        # Keep this explicit: adding an interactive page to website must never
        # accidentally publish it on the marketing origin.
        assets = ('index.html', 'style.css', 'desktop-download.js', 'waitlist.js',
                  'favicon.ico', 'favicon.svg', 'apple-touch-icon.png',
                  'og-cubby-buddy.jpg', 'trail-mix-poster.png',
                  'spell-castle-cover.jpg', 'waddle-wars-cover.jpg')
        (stage / 'site').mkdir()
        for name in assets:
            shutil.copyfile(ROOT / 'website' / name, stage / 'site' / name)
        shutil.copyfile(stage / 'site/index.html', stage / 'index.html')
        shutil.copyfile(stage / 'site/favicon.ico', stage / 'favicon.ico')
        # A cross-origin redirect is invalid for service-worker updates. Serve a
        # same-origin retirement script so previously cached /play stops running.
        shutil.copyfile(ROOT / 'hosting/retire-worker.js', stage / 'cubby-worker.js')
        # The companion owns a second worker scoped to /parents/. It needs its
        # own same-origin retirement response before the /parents/* redirect.
        (stage / 'parents').mkdir()
        shutil.copyfile(ROOT / 'hosting/retire-worker.js', stage / 'parents/worker.js')
        (stage / '.handheld-web-export').write_text('generated\n')
        if output.exists():
            shutil.rmtree(output)
        stage.rename(output)
    return output


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


def build(output=None, *, surface='combined'):
    if surface not in ('combined', 'marketing', 'play'):
        raise ValueError('Unknown hosting surface')
    output = Path(output) if output is not None else ROOT / '.cache' / {
        'combined': 'web', 'marketing': 'marketing', 'play': 'play'}[surface]
    if surface == 'marketing':
        return marketing_build(output)
    # Build/cache outputs stay in this checkout, not the development VM's state.
    vm.fetch_games()
    current = vm.build_example(ROOT / '.cache/packages')
    urls = web.default_manifest_urls()
    snapshots = legacy_manifests(urls)
    result = web.build(output, [*retained_archives(), current],
                       base_url=PLAY_ORIGIN,
                       manifest_urls=urls, registry=web.default_registry(),
                       browser_root=surface == 'play')
    for game, document in snapshots.items():
        destination = result / 'store' / game / 'manifest.json'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(document, sort_keys=True) + '\n')
    # Native cache keys remain /index.html, but native transport is a distinct
    # physical file. Root becomes the adult landing page with no runtime router.
    shutil.copyfile(result / ('site/play.html' if surface == 'play' else 'site/index.html'),
                    result / 'index.html')
    shutil.copyfile(result / 'site/favicon.ico', result / 'favicon.ico')
    if surface == 'play':
        # Interactive pages retain only their own website assets, never the
        # marketing landing page, tracking SDK or waitlist submission script.
        keep = {'play.html', 'cubby-buddy.webp', 'style.css', 'favicon.ico',
                'favicon.svg', 'apple-touch-icon.png'}
        for asset in (result / 'site').iterdir():
            if asset.name not in keep:
                asset.unlink()
    # web.build includes only the generic phone dashboard and install assets.
    # Game-owned companions come from installed manifests, never per-game rewrites.

    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--surface', choices=('combined', 'marketing', 'play'), default='combined')
    args = parser.parse_args()
    print(build(args.output, surface=args.surface))
