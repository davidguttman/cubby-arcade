"""Generate an isolated demo package for the packaged installer smoke."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
files = {'index.html': b'<canvas id="screen" width="80" height="80"></canvas>',
         'art.svg': b'<svg xmlns="http://www.w3.org/2000/svg"/>'}
manifest = dict(schema_version=1, id='demo', version='1', runtime='web',
                entrypoint='index.html', artwork='art.svg',
                files={name: hashlib.sha256(data).hexdigest() for name, data in files.items()})
with zipfile.ZipFile(directory / 'demo-1.zip', 'w') as output:
    output.writestr('manifest.json', json.dumps(manifest))
    for name, data in files.items():
        output.writestr(name, data)
