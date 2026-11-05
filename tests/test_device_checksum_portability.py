"""Exercise the launcher's checksum invocation with BusyBox's option contract."""
import hashlib
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DeviceChecksumPortabilityTests(unittest.TestCase):
    def test_gpu_checks_accept_valid_and_reject_corrupt_file_on_busybox(self):
        source = (ROOT / 'rocknix/device/chroot-run.sh').read_text()
        command = next(line.split('|', 1)[1].strip() for line in source.splitlines()
                       if '| sha256sum ' in line)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / 'graphics library'
            payload.write_bytes(b'known graphics bytes')
            expected = hashlib.sha256(payload.read_bytes()).hexdigest()
            # Model only BusyBox's supported option surface; delegate actual
            # checksum parsing/comparison to the host checksum implementation.
            checker = root / 'sha256sum'
            checker.write_text('#!/usr/bin/python3\n'
                               'import os, sys\n'
                               'if sys.argv[1:] != ["-c", "-s"]: sys.exit(2)\n'
                               f'os.execv({shutil.which("sha256sum")!r}, ["sha256sum", "-c", "--status"])\n')
            checker.chmod(0o755)
            import os
            env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'])
            for digest, wanted in [(expected, 0), ('0' * 64, 1)]:
                with self.subTest(valid=wanted == 0):
                    result = subprocess.run(shlex.split(command),
                                            input=f'{digest}  {payload}\n',
                                            text=True, capture_output=True, env=env)
                    self.assertEqual(result.returncode, wanted, result.stderr)


if __name__ == '__main__':
    unittest.main()
