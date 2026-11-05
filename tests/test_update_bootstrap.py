from pathlib import Path
import tempfile
import unittest
from rocknix import image, updates


class UpdateBootstrapTests(unittest.TestCase):
    def test_default_image_trust_uses_tracked_public_key_and_live_feed(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            image.provision_updater(base,image.ROOT)
            config=updates.Manager(base).config()
            self.assertEqual(config['feed'],image.DEFAULT_UPDATE_FEED)
            self.assertEqual((base/'updater/release-key.pem').read_bytes(),
                             (image.ROOT/'rocknix/device/release-key.pem').read_bytes())
            self.assertNotIn(b'PRIVATE',(base/'updater/release-key.pem').read_bytes())
    def test_explicit_opt_out_has_no_trust_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            image.provision_updater(base,image.ROOT,disabled=True)
            self.assertFalse((base/'updater/config.json').exists())
    def test_explicit_override_and_incomplete_override(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            image.provision_updater(base,image.ROOT,'https://example.com/manifest.json',
                                    image.ROOT/'rocknix/device/release-key.pem')
            self.assertEqual(updates.Manager(base).config()['feed'],'https://example.com/manifest.json')
            with self.assertRaises(ValueError):image.provision_updater(base,image.ROOT,'https://example.com/m',None)
            with self.assertRaises(ValueError):image.provision_updater(base,image.ROOT,'https://example.com/m',None,True)
