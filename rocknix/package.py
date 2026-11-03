#!/usr/bin/env python3
"""Assemble a tested ARM64 rootfs and this checkout into an adult install kit."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def package(rootfs: Path, output: Path) -> Path:
    if not rootfs.is_file():
        raise ValueError('Build the WPE ARM64 rootfs first; rootfs archive is missing.')
    output.mkdir(parents=True, exist_ok=True)
    bundle = output / 'cubby-rg353v.tar.gz'
    with tempfile.TemporaryDirectory(prefix='cubby-kit-') as directory:
        stage = Path(directory)
        shutil.copy2(rootfs, stage / 'rootfs.tar.xz')
        for name in ['runtime', 'rocknix']:
            shutil.copytree(ROOT / name, stage / 'app' / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (stage / 'app/hosting').mkdir()
        shutil.copy2(ROOT / 'hosting/catalog.yaml', stage / 'app/hosting/catalog.yaml')
        shutil.copytree(ROOT / 'rocknix/device', stage / 'device')
        files = sorted(p for p in stage.rglob('*') if p.is_file())
        hashes = []
        for path in files:
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            hashes.append(f'{digest}  {path.relative_to(stage).as_posix()}\n')
        (stage / 'SHA256SUMS').write_text(''.join(hashes))
        with tarfile.open(bundle, 'w:gz', compresslevel=1) as archive:
            for path in sorted(stage.iterdir()):
                archive.add(path, arcname=path.name, recursive=True)
    with bundle.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    (output / 'cubby-rg353v.tar.gz.sha256').write_text(f'{digest}  {bundle.name}\n')
    shutil.copy2(ROOT / 'rocknix/install.py', output / 'install.py')
    shutil.copytree(ROOT / 'rocknix/device', output / 'device', dirs_exist_ok=True)
    shutil.copy2(ROOT / 'docs/rg353v-install.md', output / 'START-HERE.md')
    return bundle


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rootfs', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/rg353v-kit')
    args = parser.parse_args()
    print(package(args.rootfs, args.output))
