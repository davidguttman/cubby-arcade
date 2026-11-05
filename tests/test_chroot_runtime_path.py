import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]


class SharedRuntimeMountTests(unittest.TestCase):
    def test_first_mount_uses_canonical_runtime_path_after_layout_migration(self):
        with tempfile.TemporaryDirectory(prefix='cubby path ') as temporary:
            base=Path(temporary); release=base/'releases/current'; runtime=base/'runtimes/sha256'
            release.mkdir(parents=True); runtime.mkdir(parents=True)
            (release/'rootfs').symlink_to('../../runtimes/sha256')
            self.check_mount(base,release,runtime)
    def test_legacy_real_runtime_path_still_mounts(self):
        with tempfile.TemporaryDirectory(prefix='cubby path ') as temporary:
            base=Path(temporary); release=base/'releases/current'; runtime=release/'rootfs'
            runtime.mkdir(parents=True)
            self.check_mount(base,release,runtime)
    def check_mount(self,base,release,runtime):
        tools=base/'tools';tools.mkdir()
        for name,body in {'mkdir':'exit 0','mount': 'printf \'%s\\n\' "$@"; exit 97'}.items():
            # Stop immediately at the first mount: no mount or host path is mutated.
            p=tools/name
            p.write_text('#!/bin/sh\n'+body+'\n');p.chmod(0o755)
        result=subprocess.run(['bash',str(ROOT/'rocknix/device/chroot-run.sh'),str(release)],
            env={**os.environ,'CUBBY_MOUNT_NAMESPACE':'yes','PATH':str(tools)+':'+os.environ['PATH']},
            capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,97,result.stderr)
        self.assertEqual(result.stdout.splitlines(),['--bind',str(runtime),str(runtime)])
