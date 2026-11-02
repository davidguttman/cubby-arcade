#!/usr/bin/env -S uv run python
"""Export the shared launcher and validated game packages for a static web host."""
import argparse
import http.server
import json
from pathlib import Path
import shutil
import tempfile
from runtime import packages

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / '.cache/web'


def build(output, archives):
    output = Path(output).resolve()
    if output == HERE or HERE.is_relative_to(output):
        raise ValueError('Output cannot replace the source tree')
    if output.exists() and not (output / '.handheld-web-export').is_file():
        raise ValueError('Refusing to replace an unrelated output directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Validate everything before replacing a previous export.
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.web-') as temporary:
        stage = Path(temporary)
        installed = stage / 'installed'
        for archive in archives:
            packages.install(archive, installed)
        site = stage / 'site'
        site.mkdir()
        shutil.copyfile(HERE / 'runtime/index.html', site / 'index.html')
        shutil.copytree(HERE / 'runtime/core', site / 'runtime/core', ignore=shutil.ignore_patterns('__pycache__'))
        library = packages.library(installed)
        for entry in library:
            release = (installed / entry['id'] / 'current').resolve()
            manifest = packages.validate_manifest(json.loads((release / 'manifest.json').read_text()))
            target = site / 'games' / entry['id']
            for name in manifest['files']:
                destination = target / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(release / name, destination)
        (site / '.handheld-web-export').write_text('generated\n')
        (site / 'library').write_text(json.dumps(library, sort_keys=True) + '\n')
        # The output directory is generated, never source, and explicitly selected.
        if output.exists():
            shutil.rmtree(output)
        site.rename(output)
    return output


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
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
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    if args.command == 'build':
        archives = args.packages
        if not archives:
            from vm import build_example
            archives = [build_example()]
        print(build(args.output, archives))
    else:
        if not (args.output / 'library').is_file():
            parser.error('Build the web output first')
        from functools import partial
        http.server.ThreadingHTTPServer((args.bind, args.port),
            partial(PreviewHandler, directory=str(args.output))).serve_forever()


if __name__ == '__main__':
    main()
