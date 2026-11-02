import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import web

class WebHostTests(unittest.TestCase):
    def test_export_validates_and_copies_exact_package_and_shared_launcher(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / 'demo.game.zip'
            payload = {'index.html': b'<canvas></canvas>', 'cover.svg': b'<svg/>'}
            manifest = dict(schema_version=1, id='demo', version='1.0.0', runtime='web',
                            entrypoint='index.html', artwork='cover.svg', files={k:hashlib.sha256(v).hexdigest() for k,v in payload.items()})
            with zipfile.ZipFile(package, 'w') as archive:
                for name, value in payload.items(): archive.writestr(name, value)
                archive.writestr('manifest.json', json.dumps(manifest))
            output = root / 'output'
            web.build(output, [package])
            self.assertEqual((output / 'index.html').read_bytes(), (web.HERE / 'runtime/index.html').read_bytes())
            self.assertEqual((output / 'games/demo/index.html').read_bytes(), payload['index.html'])
            self.assertEqual(json.loads((output / 'library').read_text())[0]['entrypoint'], '/games/demo/index.html')
            self.assertEqual(json.loads((output / 'catalog').read_text()), json.loads((output / 'library').read_text()))
            self.assertEqual((output / 'runtime/core/hub.js').read_bytes(), (web.HERE / 'runtime/core/hub.js').read_bytes())
            self.assertFalse((output / 'vm.py').exists())
            self.assertEqual((output / 'runtime/core/input.js').read_bytes(), (web.HERE / 'runtime/core/input.js').read_bytes())
            self.assertEqual((output / 'runtime/core/screen.css').read_bytes(), (web.HERE / 'runtime/core/screen.css').read_bytes())
            self.assertEqual((output / 'runtime/core/preferences.js').read_bytes(), (web.HERE / 'runtime/core/preferences.js').read_bytes())
            # An invalid replacement must leave the previous export intact.
            with zipfile.ZipFile(package, 'a') as archive: archive.writestr('bad.txt', 'extra')
            with self.assertRaises(ValueError): web.build(output, [package])
            self.assertEqual((output / 'games/demo/index.html').read_bytes(), payload['index.html'])
            unrelated = root / 'unrelated'
            unrelated.mkdir()
            with self.assertRaises(ValueError): web.build(unrelated, [])

if __name__ == '__main__': unittest.main()
