#!/usr/bin/env -S uv run --with pycdlib==1.14.0 --with pillow==11.3.0 --with vncdotool==1.2.0 python
"""Cubby Arcade reproducible, rootless QEMU ARM64 development appliance."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile
import zipfile
from urllib.parse import urlsplit
from runtime import packages

HERE = Path(__file__).resolve().parent
GAME_LOCK = HERE / 'games.lock.json'
GAME_CACHE = HERE / '.cache/games'
STATE = Path(os.environ.get('CUBBY_ARCADE_VM_DIR', os.environ.get('HANDHELD_VM_DIR', '/mnt/data/vms/cubby-arcade'))).resolve()
IMAGE = 'debian-13-generic-arm64-20261026-2643.qcow2'
IMAGE_URL = 'https://cloud.debian.org/images/cloud/trixie/20261026-2643/' + IMAGE
IMAGE_SHA512 = '5fc0eba340b16651f1b4163f3249b0c8fb91acd2bc5898b609181ee47ac50a5bf3e24166ba8647279db05e883883e22e9308193ef4ad75293cb254b919e358d8'
SSH_PORT, VNC_DISPLAY = 12222, 7


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def toolchain():
    root = STATE / 'toolchain/root/usr'
    env = os.environ.copy()
    if (root / 'bin/qemu-system-aarch64').exists():
        env['LD_LIBRARY_PATH'] = str(root / 'lib')
        env['QEMU_MODULE_DIR'] = str(root / 'lib/qemu')
        return root / 'bin', root / 'share/edk2/aarch64', root / 'share/qemu', env
    binary = shutil.which('qemu-system-aarch64')
    if not binary:
        raise SystemExit('Install qemu-system-aarch64, qemu-img and AArch64 EDK2 firmware, or provide the documented rootless toolchain.')
    firmware = Path(os.environ.get('CUBBY_ARCADE_FIRMWARE_DIR', os.environ.get('HANDHELD_FIRMWARE_DIR', '/usr/share/edk2/aarch64')))
    return Path(binary).parent, firmware, Path('/usr/share/qemu'), env


def game_manifest():
    manifest = json.loads(GAME_LOCK.read_text())
    if manifest.get('schema_version') != 1 or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('commit', '')):
        raise SystemExit('Game lock requires schema 1 and a full pinned commit.')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', manifest.get('repository', '')):
        raise SystemExit('Game lock requires an owner/repository name.')
    for asset in manifest['assets']:
        path = Path(asset['path'])
        if path.is_absolute() or '..' in path.parts or not path.parts or not re.fullmatch(r'[0-9a-f]{64}', asset['sha256']):
            raise SystemExit('Game lock contains an invalid asset path or SHA-256.')
        if 'url' in asset:
            url = urlsplit(asset['url'])
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                raise SystemExit('External game assets require a public HTTPS URL.')
        if 'rendition' in asset:
            rendition = asset['rendition']
            path = Path(rendition['path'])
            if path.is_absolute() or '..' in path.parts or not path.parts or not re.fullmatch(r'[0-9a-f]{64}', rendition['sha256']) or rendition['recipe'] != 'silent-vp8-480x300-30fps-v1':
                raise SystemExit('Invalid locked media rendition.')
    return manifest


def verified(path, expected):
    if not path.is_file():
        return False
    with path.open('rb') as content:
        return hashlib.file_digest(content, 'sha256').hexdigest() == expected


def fetch_games():
    manifest = game_manifest()
    for asset in manifest['assets']:
        destination = GAME_CACHE / asset['path']
        if verified(destination, asset['sha256']):
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.part')
        endpoint = f"repos/{manifest['repository']}/contents/{asset['path']}?ref={manifest['commit']}"
        try:
            with temporary.open('wb') as output:
                if 'url' in asset:
                    run(['curl', '--fail', '--location', '--silent', '--show-error',
                         '--proto', '=https', '--proto-redir', '=https', asset['url']], stdout=output)
                else:
                    run(['gh', 'api', endpoint, '-H', 'Accept: application/vnd.github.raw'], stdout=output)
            if not verified(temporary, asset['sha256']):
                raise SystemExit(f"Game asset checksum mismatch: {asset['path']}")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    for asset in manifest['assets']:
        if 'rendition' not in asset:
            continue
        rendition = asset['rendition']
        destination = GAME_CACHE / rendition['path']
        if verified(destination, rendition['sha256']):
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.stem + '.part.webm')
        try:
            run(['ffmpeg', '-v', 'error', '-y', '-i', GAME_CACHE / asset['path'], '-an',
                 '-vf', 'fps=30,scale=480:300:flags=neighbor', '-c:v', 'libvpx',
                 '-crf', '20', '-b:v', '500k',
                 '-threads', '1', '-map_metadata', '-1', '-fflags', '+bitexact',
                 '-flags:v', '+bitexact', temporary])
            if not verified(temporary, rendition['sha256']):
                raise SystemExit('Media rendition checksum mismatch; use the FFmpeg version recorded in games.lock.json.')
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    print('Pinned game assets verified in', GAME_CACHE)


def build_example():
    manifest = game_manifest()
    files = {}
    for asset in manifest['assets']:
        source = GAME_CACHE / asset['path']
        if not source.is_file():
            raise SystemExit(f"Missing game asset {asset['path']}; run ./vm.py fetch-games first.")
        if not verified(source, asset['sha256']):
            raise SystemExit(f"Game asset checksum mismatch: {asset['path']}; run ./vm.py fetch-games to repair.")
        if 'rendition' in asset:
            rendition = asset['rendition']
            source = GAME_CACHE / rendition['path']
            if not verified(source, rendition['sha256']):
                raise SystemExit('Media rendition missing or checksum mismatch; run ./vm.py fetch-games.')
        name = Path(asset.get('rendition', asset)['path']).name
        files[name] = source.read_bytes()
    for source in sorted((HERE / 'examples/line-cutter').iterdir()):
        if source.is_file():
            files[source.name] = source.read_bytes()
    # Package the same SDK source used by the launcher; no generated fork.
    for source in sorted((HERE / 'runtime/core').iterdir()):
        if source.is_file() and source.suffix in {'.js', '.css'}:
            files['core/' + source.name] = source.read_bytes()
    metadata = dict(schema_version=1, id='line-cutter', version='0.2.0',
        runtime='web', entrypoint='play.html', artwork='cover.png',
        capabilities=['canvas2d', 'web-audio', 'local-storage', 'gamepad', 'video'],
        provenance={'repository': manifest['repository'], 'commit': manifest['commit'],
                    'external_assets': [asset for asset in manifest['assets'] if 'url' in asset]},
        files={name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())})
    # Discovery previews need a media asset, not the interactive HTML title page.
    trailer = next((name for name in files if Path(name).suffix in {'.webm', '.mp4'}), None)
    if trailer:
        metadata['attract'] = trailer
    packages.validate_manifest(metadata)
    files['manifest.json'] = (json.dumps(metadata, sort_keys=True, indent=2) + '\n').encode()
    STATE.mkdir(parents=True, exist_ok=True)
    destination = STATE / 'line-cutter-0.2.0.game.zip'
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content)
    print(destination)
    return destination


def install_game(package):
    if not pid():
        raise SystemExit('VM is not running.')
    # Guest installer revalidates all content before changing the active selector.
    with Path(package).open('rb') as content:
        ssh(['cat > /tmp/handheld-install.game.zip'], stdin=content)
    ssh(['sudo python3 /opt/handheld/runtime/packages.py /tmp/handheld-install.game.zip && '
         'sudo systemctl restart handheld-kiosk'])


def bundle():
    destination = STATE / 'bundle.tar.gz'
    with tarfile.open(destination, 'w:gz') as archive:
        for folder in ('runtime', 'guest'):
            archive.add(HERE / folder, arcname=folder, filter=lambda item: None if '__pycache__' in item.name else item)
    return destination


def seed():
    import pycdlib
    key = (STATE / 'id_ed25519.pub').read_text().strip()
    bootstrap = (HERE / 'guest/bootstrap.sh').read_text()
    user_data = '#cloud-config\n' + json.dumps({
        'hostname': 'cubby-arcade-dev', 'manage_etc_hosts': True,
        'users': [{'name': 'arcade', 'groups': ['sudo', 'audio', 'video', 'render', 'input'],
                   'shell': '/bin/bash', 'lock_passwd': True,
                   'sudo': ['ALL=(ALL) NOPASSWD:ALL'], 'ssh_authorized_keys': [key]}],
        'ssh_pwauth': False, 'disable_root': True,
        'write_files': [{'path': '/usr/local/sbin/handheld-bootstrap', 'permissions': '0755', 'content': bootstrap}],
        'runcmd': [['/usr/local/sbin/handheld-bootstrap']],
    })
    # Preserve cloud-init identity when regenerating a migrated VM's seed.
    metadata_path = STATE / 'meta-data'
    metadata = metadata_path.read_text() if metadata_path.exists() else json.dumps({'instance-id': 'cubby-arcade-v1', 'local-hostname': 'cubby-arcade-dev'})
    (STATE / 'user-data').write_text(user_data)
    (STATE / 'meta-data').write_text(metadata)
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, rock_ridge='1.09', vol_ident='cidata')
    for path, iso_name in [(STATE/'user-data', 'USERDATA.;1'), (STATE/'meta-data', 'METADATA.;1'), (bundle(), 'BUNDLE.TGZ;1')]:
        iso.add_file(str(path), iso_path='/' + iso_name, rr_name=path.name, joliet_path='/' + path.name)
    iso.write(str(STATE / 'seed.iso'))
    iso.close()


def init():
    if pid():
        raise SystemExit('Stop this VM before regenerating its attached seed image.')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    image = STATE / IMAGE
    if not image.exists():
        run(['curl', '-fL', '--retry', '3', '-o', str(image)+'.part', IMAGE_URL])
        Path(str(image)+'.part').rename(image)
    print('Checking pinned Debian image SHA-512…', flush=True)
    if hashlib.file_digest(image.open('rb'), 'sha512').hexdigest() != IMAGE_SHA512:
        raise SystemExit('Debian image checksum mismatch; preserve/inspect the file before replacing it.')
    binary, firmware, _, env = toolchain()
    if not (STATE/'disk.qcow2').exists():
        run([binary/'qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, STATE/'disk.qcow2', '12G'], env=env)
    if not (STATE/'QEMU_VARS.fd').exists():
        shutil.copy2(firmware/'QEMU_VARS.fd', STATE/'QEMU_VARS.fd')
    if not (STATE/'id_ed25519').exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'cubby-arcade-vm-only', '-f', STATE/'id_ed25519'])
    seed()
    (STATE/'image.lock.json').write_text(json.dumps({'url': IMAGE_URL, 'sha512': IMAGE_SHA512, 'debian_snapshot': '20261027T000000Z'}, indent=2)+'\n')
    print('Initialized:', STATE)


def pid():
    try:
        value = int((STATE/'qemu.pid').read_text())
        command = Path(f'/proc/{value}/cmdline').read_bytes()
        if b'qemu-system-aarch64' not in command or str(STATE/'disk.qcow2').encode() not in command:
            return None
        return value
    except (OSError, ValueError):
        return None


def qmp(command, arguments=None):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(10)
        sock.connect(str(STATE/'qmp.sock'))
        stream = sock.makefile('rwb')
        stream.readline()
        def request(name, args=None):
            stream.write((json.dumps({'execute': name, **({'arguments': args} if args else {})})+'\n').encode())
            stream.flush()
            while True:
                data = json.loads(stream.readline())
                if 'error' in data:
                    raise RuntimeError(data['error'])
                if 'return' in data:
                    return data['return']
        request('qmp_capabilities')
        return request(command, arguments)


def start():
    if pid():
        print('Already running, PID', pid())
        return
    if not (STATE/'disk.qcow2').exists():
        raise SystemExit('Run init first.')
    binary, firmware, roms, env = toolchain()
    arguments = [binary/'qemu-system-aarch64', '-L', roms, '-name', 'cubby-arcade',
        '-machine', 'virt', '-cpu', 'cortex-a55', '-accel', 'tcg,thread=multi', '-smp', '4', '-m', '2048',
        '-drive', f'if=pflash,format=raw,readonly=on,file={firmware}/QEMU_EFI.fd',
        '-drive', f'if=pflash,format=raw,file={STATE}/QEMU_VARS.fd',
        '-drive', f'if=none,id=os,format=qcow2,file={STATE}/disk.qcow2', '-device', 'virtio-blk-pci,drive=os',
        '-drive', f'if=none,id=seed,format=raw,readonly=on,file={STATE}/seed.iso', '-device', 'virtio-blk-pci,drive=seed',
        '-netdev', f'user,id=net0,hostfwd=tcp:127.0.0.1:{SSH_PORT}-:22', '-device', 'virtio-net-pci,netdev=net0',
        '-device', 'virtio-gpu-pci,xres=640,yres=480', '-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet',
        '-device', 'intel-hda', '-device', 'hda-duplex,audiodev=audio0', '-audiodev', 'pa,id=audio0',
        '-display', 'none', '-vnc', f'127.0.0.1:{VNC_DISPLAY}', '-serial', f'file:{STATE}/serial.log',
        '-qmp', f'unix:{STATE}/qmp.sock,server=on,wait=off', '-pidfile', STATE/'qemu.pid', '-daemonize']
    try:
        with (STATE/'qemu-start.log').open('a') as log:
            run(arguments, env=env, stdout=log, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError:
        print(f'QEMU failed to start; inspect {STATE}/qemu-start.log', file=sys.stderr)
        raise
    print(f'Started PID {pid()}; SSH 127.0.0.1:{SSH_PORT}; VNC 127.0.0.1:{5900+VNC_DISPLAY}')


def ssh_argv(arguments, connect_timeout=10):
    return ['ssh', '-p', str(SSH_PORT), '-i', str(STATE/'id_ed25519'), '-o', 'IdentitiesOnly=yes',
        '-o', 'ForwardAgent=no', '-o', 'BatchMode=yes', '-o', f'ConnectTimeout={connect_timeout}',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', f'UserKnownHostsFile={STATE}/known_hosts',
        'arcade@127.0.0.1', *arguments]


def ssh(arguments, **kwargs):
    return run(ssh_argv(arguments), **kwargs)


def sync():
    if not pid():
        raise SystemExit('VM is not running.')
    with bundle().open('rb') as content:
        ssh(['cat > /tmp/handheld-bundle.tar.gz'], stdin=content)
    ssh(['sudo tar xzf /tmp/handheld-bundle.tar.gz -C /opt/handheld && '
         'sudo chown -R arcade:arcade /opt/handheld && '
         'sudo install -m644 /opt/handheld/guest/weston.ini /opt/handheld/guest/cog.ini /etc/handheld/ && '
         'sudo install -m755 /opt/handheld/guest/run-kiosk.sh /usr/local/bin/handheld-kiosk && '
         'sudo install -m644 /opt/handheld/guest/handheld-http.service /opt/handheld/guest/handheld-kiosk.service /etc/systemd/system/ && '
         'sudo systemctl daemon-reload && sudo systemctl restart handheld-http handheld-kiosk'])
    print('Synced OS runtime only; installed games and saves unchanged.')


def status():
    print(json.dumps({'running': bool(pid()), 'pid': pid(), 'state_dir': str(STATE),
                      'ssh_port': SSH_PORT, 'vnc_port': 5900+VNC_DISPLAY}, indent=2))
    if pid():
        result = subprocess.run(ssh_argv([
            'test -f /var/lib/handheld/bootstrap.complete && systemctl is-active handheld-http handheld-kiosk; cat /var/lib/handheld/browser-report.json 2>/dev/null'],
            connect_timeout=3),
            text=True, capture_output=True)
        print(result.stdout or result.stderr)


def screenshot():
    if not pid():
        raise SystemExit('VM is not running.')
    output = STATE/'screenshot.png'
    # Capture through the same display protocol used by the viewer. Requesting
    # a complete VNC update also avoids partial/stale QMP scanout captures.
    run(['vncdo', '-s', f'127.0.0.1::{5900+VNC_DISPLAY}', 'capture', output])
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['build-example','install-game','fetch-games','init','start','status','ssh','sync','stop','view','screenshot','key'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'install-game':
        if len(args.arguments) != 1:
            raise SystemExit('install-game requires a local .game.zip package')
        install_game(args.arguments[0])
    elif args.command == 'ssh':
        ssh(args.arguments)
    elif args.command == 'view':
        run(['vncviewer', f'127.0.0.1:{VNC_DISPLAY}'])
    elif args.command == 'stop':
        if pid():
            qmp('system_powerdown')
            print('Requested clean shutdown of this VM.')
        else:
            print('VM not running.')
    elif args.command == 'key':
        if not args.arguments:
            raise SystemExit('key requires QEMU qcode, e.g. ret, esc, z, up')
        qmp('send-key', {'keys': [{'type':'qcode','data':args.arguments[0]}], 'hold-time':100})
    else:
        globals()[args.command.replace('-', '_')]()


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Preserve guest command exit codes without echoing possibly-sensitive
        # interactive SSH arguments in a Python traceback.
        sys.exit(error.returncode)
    except (OSError, RuntimeError) as error:
        raise SystemExit(str(error))
