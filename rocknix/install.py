#!/usr/bin/env python3
"""Adult RG353V setup helper. Requires Python 3 and OpenSSH on the computer."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path, PurePosixPath
import re
import os
import tempfile
from contextlib import contextmanager
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
MAX_BUNDLE = 6 * 1024**3
REQUIRED = {'rootfs.tar.xz', 'SHA256SUMS', 'app/rocknix/session.sh',
            'device/launch.sh', 'device/chroot-run.sh'}


def validate_bundle(path: Path, expected: str) -> str:
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
        raise ValueError('Supply the published bundle SHA-256, not a URL or filename.')
    if not 0 < path.stat().st_size <= MAX_BUNDLE:
        raise ValueError('Invalid or oversized bundle.')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != expected.lower():
        raise ValueError('Bundle SHA-256 mismatch; nothing was sent to the device.')
    names = set()
    total = 0
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            parts = PurePosixPath(name)
            if parts.is_absolute() or '..' in parts.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe bundle member: ' + member.name)
            if name in names:
                raise ValueError('Duplicate bundle member: ' + name)
            names.add(name)
            total += member.size
            if total > 12 * 1024**3:
                raise ValueError('Unpacked bundle exceeds size limit.')
    if not REQUIRED <= names:
        raise ValueError('Incomplete Cubby bundle: ' + ', '.join(sorted(REQUIRED - names)))
    return digest


def connection(host: str, port: int) -> list[str]:
    # No custom commands, option injection, usernames or interpolation in target.
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*', host):
        raise ValueError('Use the handheld IP address or hostname, without a username.')
    return ['ssh', '-p', str(port), '-o', 'StrictHostKeyChecking=ask', 'root@' + host]


def remote_script(ssh: list[str], name: str, *args: str) -> None:
    # Arguments are fixed names or a validated hexadecimal digest.
    with (HERE / 'device' / name).open('rb') as stream:
        subprocess.run(ssh + ['bash', '-s', '--', *args], stdin=stream, check=True)


@contextmanager
def session(host: str, port: int):
    ssh = connection(host, port)
    if os.name == 'nt':
        # Native Windows OpenSSH does not support Unix ControlPath sockets.
        yield ssh
        return
    with tempfile.TemporaryDirectory(prefix='cubby-ssh-') as directory:
        ssh += ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=60',
                '-o', 'ControlPath=' + directory + '/socket']
        try:
            yield ssh
        finally:
            try:
                subprocess.run(ssh + ['-O', 'exit'], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, check=False)
            except OSError:
                pass


def install(host: str, port: int, bundle: Path, expected: str) -> None:
    digest = validate_bundle(bundle, expected)
    with session(host, port) as ssh:
        remote_script(ssh, 'preflight.sh')
        with bundle.open('rb') as stream:
            subprocess.run(ssh + ['cat > /storage/cubby-upload-' + digest + '.tar.gz'],
                           stdin=stream, check=True)
        remote_script(ssh, 'install.sh', digest)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'uninstall', 'check'])
    parser.add_argument('host', help='ROCKNIX IP address shown in Network Settings')
    parser.add_argument('--port', type=int, default=22)
    parser.add_argument('--bundle', type=Path, default=HERE / 'cubby-rg353v.tar.gz')
    parser.add_argument('--sha256', help='Published SHA-256 of the complete bundle')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('Port must be 1–65535')
    try:
        if args.action == 'install':
            expected = args.sha256
            if expected is None:
                checksum = args.bundle.with_name(args.bundle.name + '.sha256')
                expected = checksum.read_text().split()[0]
            install(args.host, args.port, args.bundle, expected)
        else:
            with session(args.host, args.port) as ssh:
                remote_script(ssh, 'preflight.sh', *(['recovery'] if args.action == 'uninstall' else []))
                if args.action == 'uninstall':
                    remote_script(ssh, 'uninstall.sh')
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Installation stopped: {error}\n')


if __name__ == '__main__':
    main()
