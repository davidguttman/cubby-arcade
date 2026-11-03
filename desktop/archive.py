"""Archive the complete portable app, keeping its top-level folder."""
import hashlib
from pathlib import Path
import sys
import zipfile

folder = Path(sys.argv[1]).resolve()
archive = folder.with_suffix('.zip')
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
    for source in sorted(folder.rglob('*')):
        if source.is_file():
            output.write(source, source.relative_to(folder.parent))
digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
print(f'{archive} ({archive.stat().st_size} bytes; SHA-256 {digest})')
