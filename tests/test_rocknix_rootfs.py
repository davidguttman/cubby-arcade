"""The downloaded Debian artifact must be verified before extraction/building."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class RootfsBuildTests(unittest.TestCase):
    def test_runtime_sanitation_removes_probe_output_and_rejects_other_files(self):
        source = (Path(__file__).resolve().parents[1] / 'rocknix/build-rootfs.sh').read_text()
        gate = source.split('# A probe without /dev mounted', 1)[1].split('tar --numeric-owner', 1)[0]
        gate = '# A probe without /dev mounted' + gate
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['dev', 'proc', 'sys', 'run']:
                (root / name).mkdir()
            (root / 'run/shm').symlink_to('/dev/shm')
            (root / 'dev/null').write_text('transient probe output')
            result = subprocess.run(['bash', '-ec', gate], env=dict(os.environ, root=directory),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / 'dev/null').exists())
            (root / 'run/private-data').write_text('must not be archived')
            result = subprocess.run(['bash', '-ec', gate], env=dict(os.environ, root=directory),
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Refusing to archive', result.stderr)

    def test_missing_cog_dependency_stops_before_packaging(self):
        script = Path(__file__).resolve().parents[1] / 'rocknix/build-rootfs.sh'
        source = script.read_text()
        gate = source.split('  ldd /usr/bin/cog', 1)[1].split(
            '  mkdir -p /usr/share/cubby-build', 1)[0]
        gate = 'ldd /usr/bin/cog' + gate
        with tempfile.TemporaryDirectory() as directory:
            gate = gate.replace('/tmp/cog-libraries.txt', str(Path(directory) / 'libraries'))
            for report, accepted in [('libwpe.so => not found', False),
                                     ('libwpe.so => /usr/lib/libwpe.so (0x1234)', True)]:
                with self.subTest(report=report):
                    command = ('ldd() { printf "%s\\n" "$LIBRARY_REPORT"; }\n'
                               + gate + '\necho build-continued\n')
                    result = subprocess.run(['/bin/sh', '-ec', command],
                                            env=dict(os.environ, LIBRARY_REPORT=report),
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, accepted)
                    self.assertEqual('build-continued' in result.stdout, accepted)

    def test_corrupt_cached_base_does_not_replace_existing_bundle(self):
        script = Path(__file__).resolve().parents[1] / 'rocknix/build-rootfs.sh'
        with tempfile.TemporaryDirectory() as directory:
            output, cache = Path(directory) / 'output', Path(directory) / 'cache'
            output.mkdir()
            cache.mkdir()
            previous = output / 'rootfs.tar.xz'
            previous.write_bytes(b'previous verified archive')
            (cache / 'debian-arm64-e36653f9967231373aeba7cff2102fd004ac4f4a.tar.gz').write_bytes(b'corrupt download')
            result = subprocess.run(['bash', str(script), str(output), str(cache)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(previous.read_bytes(), b'previous verified archive')
            self.assertEqual(list(cache.glob('rootfs.*')), [])


if __name__ == '__main__':
    unittest.main()
