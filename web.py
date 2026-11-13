#!/usr/bin/env -S uv run python
"""Export Cubby Arcade and validated game packages for a static web host."""
import argparse
import http.server
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from runtime import publishing, public_site, catalog

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / '.cache/web'
DEFAULT_ORIGIN = 'https://cubby.david.app'


def build(output, archives=(), base_url=DEFAULT_ORIGIN, manifest_urls=None, registry=None):
    archives = list(archives)
    output = Path(output).resolve()
    if output == HERE or HERE.is_relative_to(output):
        raise ValueError('Output cannot replace the source tree')
    if output.exists() and not (output / '.handheld-web-export').is_file():
        raise ValueError('Refusing to replace an unrelated output directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Validate everything before replacing a previous export.
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.web-') as temporary:
        stage = Path(temporary)
        site = stage / 'site'
        site.mkdir()
        shutil.copyfile(HERE / 'runtime/index.html', site / 'index.html')
        shutil.copytree(HERE / 'runtime/core', site / 'runtime/core', ignore=shutil.ignore_patterns('__pycache__'))
        (site / '.handheld-web-export').write_text('generated\n')
        (site / 'library').write_text(json.dumps([]) + '\n')
        for archive in archives:
            publishing.publish(archive, site, base_url)
        if not archives:
            (site / 'catalog').write_text('[]\n')
        public_site.build(site)
        # The phone companion has its own narrowly scoped install/offline shell.
        shutil.copytree(HERE / 'parents', site / 'parents')
        # A catalog can discover a game whose publisher owns its live release
        # pointer. Installed game bytes remain pinned, validated and offline.
        urls = manifest_urls if manifest_urls is not None else default_manifest_urls()
        registry = list(registry) if registry is not None else json.loads((site / 'catalog').read_text())
        for entry in registry:
            if entry['id'] in urls:
                entry['manifest_url'] = urls[entry['id']]
        catalog.validate_registry(registry)
        (site / 'catalog').write_bytes(publishing.encoded(registry))
        # Beta discovery is independent of archive discovery and stable lock
        # overrides. Every export includes it, even an empty desktop fallback.
        beta = default_beta_registry()
        (site / 'beta').mkdir()
        (site / 'beta/catalog').write_bytes(publishing.encoded(beta))

        # Browser worker has its own explicit offline shell; native hosts bypass it.
        # Hash the shell bytes so independently deployed builds never share caches.
        browser_paths = ['/play', '/play/', '/native/index.html', '/catalog', '/beta/catalog',
                         *['/' + p.relative_to(site).as_posix() for p in sorted((site / 'runtime/core').glob('*')) if p.is_file()]]
        browser_hash = hashlib.sha256(b''.join(
            (site / name.lstrip('/')).read_bytes() for name in browser_paths
            if name not in ('/play', '/play/'))).hexdigest()
        (site / 'cubby-worker.js').write_text(
            "importScripts('/runtime/core/link.js','/runtime/core/browser-store.js');\n" +
            'HandheldBrowserStore.attachWorker(self,' + json.dumps({
                'shellVersion': browser_hash, 'shellPaths': browser_paths}) + ');\n')

        # Small coherent cloud-shell inventory: game payloads are deliberately excluded.
        # Older native clients whitelist these paths. Beta catalogs use the feed
        # manager's independent last-good cache, not the native shell inventory.
        shell = [site / 'index.html', site / 'catalog', *sorted((site / 'runtime/core').glob('*'))]
        cloud_files = {'/' + p.relative_to(site).as_posix(): {'size': p.stat().st_size,
            'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in shell if p.is_file()}
        (site / 'hub-manifest.json').write_text(json.dumps({'schema_version': 1,
            'bridge_version': 1, 'files': cloud_files}, sort_keys=True) + '\n')
        # The output directory is generated, never source, and explicitly selected.
        if output.exists():
            shutil.rmtree(output)
        site.rename(output)
    return output


def default_manifest_urls():
    lock = json.loads((HERE / 'games.lock.json').read_text())
    return {lock['game']: lock['manifest_url']} if 'manifest_url' in lock else {}


def default_registry():
    """Reviewed discovery pointers; downloading/installing remains explicit."""
    return read_registry('catalog.yaml')


def default_beta_registry():
    """Opt-in early-release discovery, never merged into the stable catalog."""
    return read_registry('beta-catalog.yaml')


def read_registry(filename):
    # Only builds parse hand-authored YAML; static serving remains stdlib-only.
    import yaml
    try:
        registry = yaml.safe_load((HERE / 'hosting' / filename).read_text())
    except yaml.YAMLError as error:
        raise ValueError(f'Invalid Store catalog YAML: {filename}') from error
    catalog.validate_registry(registry)
    return registry


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Browser system-menu returns here; keep static previews usable too.
        if path.split('?', 1)[0] in ('/play', '/play/'):
            path = '/index.html'
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        # VM diagnostic reports are unnecessary on a hosted static preview.
        if self.path != '/report':
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()
        self.close_connection = True


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('command', choices=['build', 'serve'])
    parser.add_argument('packages', nargs='*', type=Path)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--base-url', default=DEFAULT_ORIGIN, help='Public HTTPS root hosting the generated store')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    if args.command == 'build':
        # The desktop fallback is a shell and discovery metadata, not game payloads.
        print(build(args.output, args.packages, args.base_url,
                    registry=None if args.packages else default_registry()))
    else:
        if not (args.output / 'library').is_file():
            parser.error('Build the web output first')
        from functools import partial
        http.server.ThreadingHTTPServer((args.bind, args.port),
            partial(PreviewHandler, directory=str(args.output))).serve_forever()


if __name__ == '__main__':
    main()
