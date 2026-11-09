"""Explicitly provisioned, native key-only management; never enabled by an app alone.

Owned by network.py, not a persistent service. Keep private host identity outside
the browser-bound state directory. No credentials or startup hooks are written
to /flash, and no stock USB initialization is repeated.
"""
from __future__ import annotations
import base64
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading


def valid_keys(text):
    """Accept bare public keys, not authorized_keys options or private material."""
    if not text or len(text.encode()) > 65536:
        return False
    lines = [line.split() for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if not lines:
        return False
    for fields in lines:
        if len(fields) < 2 or fields[0] not in {
            'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'
        }:
            return False
        try:
            base64.b64decode(fields[1], validate=True)
        except ValueError:
            return False
        # Validate every line: ssh-keygen accepts a file containing one good
        # key and another malformed line, which is too permissive here.
        with tempfile.NamedTemporaryFile(mode='w') as stream:
            stream.write(' '.join(fields[:2]) + '\n')
            stream.flush()
            result = subprocess.run(['/usr/bin/ssh-keygen', '-l', '-f', stream.name],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if result.returncode:
                return False
    return True


def quoted(path):
    return '"' + str(path).replace('\\', '\\\\').replace('"', '\\"') + '"'


class Management:
    def __init__(self, app, flash=Path('/flash'), gadgets=Path('/sys/kernel/config/usb_gadget')):
        self.port = 2222
        self.app = Path(app).resolve()
        self.release = self.app.parent
        self.base = self.release.parent.parent
        self.flash, self.gadgets = Path(flash), Path(gadgets)
        self.private = self.base/'management/private'
        self.host_key = self.private/'ssh_host_ed25519_key'
        self.keys, self.config = self.private/'authorized_keys', self.private/'sshd_config'
        self.stop = threading.Event()
        self.thread = None
        self.process = None
        self.lock = None
        self.usb_ready = False
        self.active_keys = None

    def confirmed(self):
        return (self.app.name == 'app' and self.release.parent.name == 'releases'
                and (self.base/'current').resolve() == self.release
                and not (self.base/'updates/pending.json').exists())

    def prepare(self, keys):
        for directory in [self.private.parent, self.private]:
            if directory.is_symlink():
                raise ValueError('Management directory must not be a symlink')
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory.chmod(0o700)
        for path in [self.host_key, self.keys, self.config, self.private/'owner.lock']:
            if path.is_symlink():
                raise ValueError('Management file must not be a symlink')
        if self.lock is None:
            lock = (self.private/'owner.lock').open('a')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                lock.close()
                raise
            self.lock = lock
            os.fchmod(lock.fileno(), 0o600)
        if not self.host_key.exists():
            with tempfile.TemporaryDirectory(dir=self.private) as directory:
                path = Path(directory)/'host'
                subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(path)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                os.replace(path, self.host_key)
        self.host_key.chmod(0o600)
        self.keys.write_text(keys)
        self.keys.chmod(0o600)
        self.config.write_text('\n'.join([
            'Port ' + str(self.port), 'AddressFamily any',
            'HostKey ' + quoted(self.host_key), 'PidFile ' + quoted(self.private/'sshd.pid'),
            'AuthorizedKeysFile ' + quoted(self.keys),
            'AllowUsers root', 'PermitRootLogin prohibit-password', 'PubkeyAuthentication yes',
            'AuthenticationMethods publickey', 'PasswordAuthentication no',
            'KbdInteractiveAuthentication no', 'PermitEmptyPasswords no', 'UsePAM no',
            'HostbasedAuthentication no', 'StrictModes yes', 'UseDNS no',
            'AllowTcpForwarding no', 'X11Forwarding no', 'PermitTunnel no', 'LogLevel ERROR', ''
        ]))
        self.config.chmod(0o600)
        subprocess.run(['/usr/sbin/sshd', '-t', '-f', str(self.config)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)

    def restore_usb(self, run=subprocess.run):
        if (self.flash/'CUBBY-USB-DISABLED').exists():
            return True
        status = run(['/usr/bin/systemctl', 'show', '-p', 'ActiveState', '--value', 'rocknix-autostart.service'],
                     capture_output=True, text=True, timeout=10)
        if status.returncode or status.stdout.strip() != 'active':
            return False
        controllers = list(self.gadgets.glob('*/UDC'))
        if len(controllers) != 1:
            return False  # Stock must have prepared configfs. Never initialize it here.
        if controllers[0].read_text().strip():
            return True
        result = run(['/usr/bin/usbgadget', 'network'], capture_output=True, text=True, timeout=10)
        return result.returncode == 0

    def stop_listener(self):
        process, self.process = self.process, None
        self.active_keys = None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            else:
                process.wait()

    def tick(self):
        source = self.flash/'cubby-setup/authorized_keys'
        enabled = self.confirmed() and not (self.flash/'CUBBY-MANAGEMENT-DISABLED').exists()
        try:
            keys = source.read_text() if enabled and source.is_file() and not source.is_symlink() else ''
        except (OSError, UnicodeError):
            keys = ''
        if not enabled or not valid_keys(keys):
            self.stop_listener()
            return
        if self.process is not None and self.process.poll() is not None:
            self.stop_listener()
        if self.process is not None and keys != self.active_keys:
            self.stop_listener()
        if self.process is None:
            self.prepare(keys)
            if not self.stop.is_set():
                self.process = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(self.config)],
                                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                close_fds=True)
                self.active_keys = keys
        # Wi-Fi management must not depend on successful USB recovery.
        if not self.usb_ready:
            try:
                self.usb_ready = self.restore_usb()
            except Exception as error:
                print('Cubby optional USB recovery retry:', error, file=sys.stderr)

    def run(self):
        try:
            while not self.stop.is_set():
                try:
                    self.tick()
                except Exception as error:
                    self.stop_listener()
                    print('Cubby optional management retry:', error, file=sys.stderr)
                self.stop.wait(5)
        finally:
            self.stop_listener()
            if self.lock:
                self.lock.close()
                self.lock = None

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join()
        else:
            self.stop_listener()
            if self.lock:
                self.lock.close()
                self.lock = None


def start(app):
    worker = Management(app)
    worker.thread = threading.Thread(target=worker.run, daemon=True)
    worker.thread.start()
    return worker


class RecoveryManagement(Management):
    """FAT-backed maintenance listener independent of any app or trial lifecycle.

    This is a second port, identity, and owner lock. USB diagnostics owns gadget
    recovery, so this listener must never race it or stock USB initialization.
    """
    def __init__(self, base=Path('/storage/cubby'), flash=Path('/flash')):
        super().__init__(Path(base)/'releases/recovery/app', flash=flash)
        self.base = Path(base)
        self.port = 2223
        self.private = self.base/'recovery/private'
        self.host_key = self.private/'ssh_host_ed25519_key'
        self.keys, self.config = self.private/'authorized_keys', self.private/'sshd_config'

    def confirmed(self):
        return True  # Recovery must work when Cubby cannot start or confirm.

    def restore_usb(self):
        return True  # The independent USB diagnostics unit owns this.


if __name__ == '__main__':
    import argparse
    import signal
    parser = argparse.ArgumentParser(description='Provisioned key-only recovery access')
    parser.add_argument('--recovery', action='store_true', required=True)
    parser.add_argument('--base', type=Path, default=Path('/storage/cubby'))
    args = parser.parse_args()
    worker = RecoveryManagement(args.base)
    signal.signal(signal.SIGTERM, lambda *_: worker.stop.set())
    signal.signal(signal.SIGINT, lambda *_: worker.stop.set())
    worker.run()
