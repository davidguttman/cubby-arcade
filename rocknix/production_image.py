#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyfatfs==1.1.0", "setuptools==80.9.0", "pyyaml==6.0.3"]
# ///
"""Build a versioned, audited production image; never writes a physical disk."""
from __future__ import annotations
import argparse
import gzip
import importlib.util
import socket
import threading
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rocknix import image
from rocknix.boot_splash import payload
from rocknix.device.management import valid_keys
from release_automation import package_version


def digest(data):
    return hashlib.sha256(data).hexdigest()


def public_keys(path):
    if path is None:
        return None
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Expected regular public key file')
    text = path.read_text()
    if not valid_keys(text):
        raise ValueError('Expected valid SSH public key, never private credentials')
    return text.encode()


def validate_updater(root):
    """Probe the exact client to be flashed, including healthy error:null replies.

    Both paths that caused this recovery incident fail here before an image
    can be distributed. This is not a substitute for the signed boot-trial tests.
    """
    spec = importlib.util.spec_from_file_location('production_updater', root/'rocknix/updates.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ('rocknix/gamepad.js', 'runtime/native/rg353v/device/management.py'):
        module.app_path(name)
    with tempfile.TemporaryDirectory(prefix='cubby-client-probe-') as directory:
        path = Path(directory)/'socket'
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(path)); server.listen(1); server.settimeout(5)
        def reply():
            try:
                with server.accept()[0] as client:
                    client.recv(4096)
                    client.sendall(b'{"error":null,"phase":"idle"}\n')
            finally:
                server.close()
        thread = threading.Thread(target=reply, daemon=True); thread.start()
        try:
            result = module.HostClient(path).dispatch({'action':'status'})
            if result.get('phase') != 'idle':
                raise ValueError('Updater healthy-status probe failed')
        finally:
            thread.join(timeout=6)


def source_plan(root, expected_version=None):
    root = Path(root)
    info = image.source_provenance(root)
    if not info['source_commit'] or info['source_dirty'] is not False:
        raise ValueError('Production images require a clean committed source checkout')
    version = package_version(root/'package.json')
    lock = json.loads((root/'package-lock.json').read_text())
    if lock['version'] != version or lock['packages']['']['version'] != version:
        raise ValueError('Product version and lockfile version disagree')
    if expected_version is not None and version != expected_version:
        raise ValueError('Checkout version does not equal requested version')
    validate_updater(root)
    # Read/validate every mandatory file before starting an expensive build.
    app = {name: digest((root/name).read_bytes()) for name in (
        'rocknix/updates.py', 'rocknix/network.py', 'rocknix/gamepad.js',
        'runtime/native/rg353v/boot-screen/boot-screen.py',
        'runtime/native/rg353v/boot-screen/cubby-boot-screen.service')}
    for top in ('runtime', 'rocknix'):
        for path in sorted((root/top).rglob('*')):
            if '__pycache__' in path.parts or path.suffix == '.pyc':
                continue
            if path.is_symlink():
                raise ValueError('Production source contains symlink: '+str(path))
            if path.is_file():
                app[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    app['hosting/catalog.yaml'] = digest((root/'hosting/catalog.yaml').read_bytes())
    app['runtime/version.json'] = digest(json.dumps({'version': version}).encode())
    flash = {'post-sysroot.sh': digest(image.BOOT_HOOK.encode()),
             'cubby-boot-screen/service':digest((root/'runtime/native/rg353v/boot-screen/cubby-boot-screen.service').read_bytes())}
    flash.update({'cubby-splash/'+name: digest(data) for name, data in payload(root).items()})
    for source, target in [('usb-diagnostics-start.sh','cubby-usb-diagnostics/start.sh'),
                           ('usb-diagnostics.py','cubby-usb-diagnostics/status.py'),
                           ('cubby-usb-diagnostics.service','cubby-usb-diagnostics/service'),
                           ('wifi-recovery.py','cubby-wifi-recovery/recover.py'),
                           ('cubby-wifi-recovery.service','cubby-wifi-recovery/service')]:
        flash[target] = digest((root/'rocknix/device'/source).read_bytes())
    return {'schema':1, 'product':'cubby-arcade', 'model':'RG353V', 'version':version,
            **info, 'rocknix_sha256':image.ROCKNIX_SHA256,
            'runtime_sha256':image.ROOTFS_SHA256, 'hardware_validated':False,
            'flash_files':flash, 'app_files':app,
            'storage_files':{'cubby/updater/coordinator.py':digest((root/'rocknix/updates.py').read_bytes()),
                             'cubby/updater/release-key.pem':digest((root/'rocknix/device/release-key.pem').read_bytes())}}


def image_name(plan):
    return f"Cubby-Arcade-RG353V-v{plan['version']}-{plan['source_commit'][:12]}.img.gz"


def check_hash(actual, expected, name):
    if digest(actual) != expected:
        raise ValueError('Packaged file does not match production manifest: '+name)


def audit_partitions(fat, storage, release_id, plan, *, public=False):
    """Read actual constructed filesystems, not just the pre-filesystem source tree."""
    from pyfatfs.PyFatFS import PyFatFS
    with PyFatFS(str(fat), read_only=True) as flash:
        if public and flash.exists('/cubby-setup/authorized_keys'):
            raise ValueError('Public image contains provisioned management keys')
        for name, expected in plan['flash_files'].items():
            check_hash(flash.readbytes('/'+name), expected, name)
    with tempfile.TemporaryDirectory(prefix='cubby-image-audit-') as directory:
        destination = Path(directory)/'entry'
        files = {'cubby/releases/'+release_id+'/app/'+name: expected
                 for name, expected in plan['app_files'].items()}
        files.update(plan.get('storage_files', {}))
        for name, expected in files.items():
            destination.unlink(missing_ok=True)
            source = '/'+name
            source_arg = source.replace(chr(34), chr(34)*2)
            destination_arg = str(destination).replace(chr(34), chr(34)*2)
            result = subprocess.run(['debugfs', '-R', f'dump "{source_arg}" "{destination_arg}"', str(storage)],
                                    capture_output=True, text=True, check=True)
            diagnostics = [line for line in result.stderr.splitlines()
                           if line.strip() and not re.fullmatch(r'debugfs [0-9][^\r\n]*', line)]
            if diagnostics or not destination.is_file():
                raise ValueError('Cannot inspect packaged file: '+name)
            check_hash(destination.read_bytes(), expected, name)


def build(upstream, rootfs, output_directory, *, source_root=ROOT, expected_version=None,
          management_key=None, storage_gib=6):
    root = Path(source_root)
    plan = source_plan(root, expected_version)
    original_plan = json.loads(json.dumps(plan))
    keys = public_keys(management_key)
    if keys:
        plan['flash_files'].update({
            'cubby-setup/authorized_keys':digest(keys),
            'cubby-recovery-management/management.py':digest((root/'rocknix/device/management.py').read_bytes()),
            'cubby-recovery-management/service':digest((root/'rocknix/device/cubby-recovery-management.service').read_bytes()),
        })
    # An explicit expected version is a caller freshness check, not a claim that
    # a locally built source is the public stable release or hardware certified.
    destination = Path(output_directory)/image_name(plan)
    sidecar = destination.with_name(destination.name+'.json')
    if sidecar.exists() or sidecar.is_symlink():
        raise ValueError('Refusing existing production manifest')
    image.build(Path(upstream), Path(rootfs), destination, storage_gib,
                source_root=root, source_info={k:plan[k] for k in ('source_commit','source_dirty')},
                production_plan=plan, management_keys=keys)
    with destination.open('rb') as stream:
        plan['image'] = {'filename':destination.name, 'size':destination.stat().st_size,
                         'sha256':hashlib.file_digest(stream,'sha256').hexdigest()}
    # Rechecking catches tracked edits made while constructing the image.
    if source_plan(root, expected_version) != original_plan:
        raise ValueError('Source changed during production image build; do not distribute image')
    with sidecar.open('x') as stream:
        json.dump(plan, stream, indent=2); stream.write('\n')
    return destination


def verify(artifact, manifest, *, expected_version, expected_commit=None, public=False):
    """Verify compressed bytes AND filesystems against a selected release manifest.

    The manifest is a local build receipt, not a cryptographic signature. Obtain
    it through the release channel along with its source commit, not from an
    untrusted third party supplying both files.
    """
    artifact, manifest = Path(artifact), Path(manifest)
    if artifact.is_symlink() or not artifact.is_file() or manifest.is_symlink():
        raise ValueError('Expected regular image and manifest files')
    plan = json.loads(manifest.read_text())
    if plan['version'] != expected_version or (expected_commit and plan['source_commit'] != expected_commit):
        raise ValueError('Image is not the requested version/commit')
    if plan['source_dirty'] is not False or not plan['source_commit']:
        raise ValueError('Image did not come from clean committed source')
    if plan['rocknix_sha256'] != image.ROCKNIX_SHA256 or plan['runtime_sha256'] != image.ROOTFS_SHA256:
        raise ValueError('Unexpected pinned firmware/runtime')
    with artifact.open('rb') as stream:
        actual = hashlib.file_digest(stream,'sha256').hexdigest()
    if artifact.stat().st_size != plan['image']['size'] or actual != plan['image']['sha256']:
        raise ValueError('Image hash/size mismatch')
    with tempfile.TemporaryDirectory(prefix='cubby-production-verify-') as directory:
        import shutil
        root = Path(directory); raw = root/'disk.img'
        with gzip.open(artifact,'rb') as source, raw.open('wb') as destination:
            shutil.copyfileobj(source,destination,8*1024*1024)
        with raw.open('rb') as stream:
            layout = image.generated_gpt_layout(stream)
        fat, storage = root/'flash.fat', root/'storage.ext4'
        for destination, (start,count) in zip((fat,storage),layout[3]):
            image.copy_range(raw,destination,start*512,count*512)
        audit_partitions(fat,storage,'image-'+plan['version']+'-'+plan['source_commit'][:12],plan,public=public)
    return plan


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='verify':
        parser=argparse.ArgumentParser(description='Verify an existing production image')
        parser.add_argument('verify')
        parser.add_argument('--image',type=Path,required=True)
        parser.add_argument('--manifest',type=Path,required=True)
        parser.add_argument('--expect-version',required=True)
        parser.add_argument('--expect-commit')
        args=parser.parse_args()
        print(json.dumps(verify(args.image,args.manifest,expected_version=args.expect_version,expected_commit=args.expect_commit),indent=2))
        sys.exit(0)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rocknix', type=Path, required=True)
    parser.add_argument('--rootfs', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--expect-version', required=True)
    parser.add_argument('--management-public-key', type=Path)
    parser.add_argument('--storage-gib', type=int, default=6)
    args=parser.parse_args()
    print(build(args.rocknix.resolve(), args.rootfs.resolve(), args.output_directory.absolute(),
                expected_version=args.expect_version, management_key=args.management_public_key,
                storage_gib=args.storage_gib))
