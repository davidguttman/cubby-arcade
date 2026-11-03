"""Archive the complete portable app, keeping its top-level folder."""
import hashlib
from pathlib import Path
import sys
import tarfile
import zipfile

folder = Path(sys.argv[1]).resolve()
kind = sys.argv[2] if len(sys.argv) > 2 else 'zip'
if kind not in ('zip', 'tar.gz'):
    raise SystemExit('Archive format must be zip or tar.gz')
archive = folder.with_name(folder.name + '.' + kind)
if kind == 'tar.gz':
    # Tar retains Linux executable bits and symlinks; never dereference links.
    with tarfile.open(archive, 'w:gz', dereference=False) as output:
        output.add(folder, arcname=folder.name)
else:
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for source in sorted(folder.rglob('*')):
            if source.is_file():
                output.write(source, source.relative_to(folder.parent))
with archive.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
Path(str(archive) + '.sha256').write_text(f'{digest}  {archive.name}\n')
print(f'{archive} ({archive.stat().st_size} bytes; SHA-256 {digest})')
