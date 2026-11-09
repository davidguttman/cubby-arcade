#!/usr/bin/env python3
"""Serial-bound stock Android installer. Linux host; no host block-device writes.

An install is deliberately not a commissioning/customer-ready certification.
Only the explicitly characterized RG353V/Android11 entry profile is supported.
"""
from __future__ import annotations
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BLOCK = '/dev/block/mmcblk0'
MOUNT = '/run/cubby-provision-storage'
PROFILE = 'rg353v-android11'
MAX_RAW = 64 * 1024**3


class Blocked(ValueError):
    """A sanitized machine-readable blocker, never raw subprocess output."""


def select_device(output):
    rows = [line.split() for line in output.splitlines()
            if line.strip() and not line.startswith('List of devices attached')]
    if len(rows) != 1 or len(rows[0]) < 2 or rows[0][1] not in ('device', 'recovery'):
        raise Blocked('adb_device_ambiguous_or_unavailable')
    serial = rows[0][0]
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', serial):
        raise Blocked('adb_serial_unsupported')
    return serial


def identity(facts):
    return {name: facts[name] for name in ('cid', 'name', 'sectors', 'removable')}


def same_storage(before, after):
    if identity(before) != identity(after):
        raise Blocked('storage_identity_changed')


def validate_storage(facts, raw_size):
    # This intentionally narrow profile does not guess support for other MMCs.
    if (facts.get('name') != 'BJTD4R' or facts.get('removable') != 0
            or facts.get('sectors') != 61071360
            or not re.fullmatch('[0-9a-f]{32}', str(facts.get('cid', '')))):
        raise Blocked('unsupported_internal_emmc')
    if facts.get('mounted') or facts.get('sd'):
        raise Blocked('target_mounted_or_sd_present')
    if not isinstance(facts.get('battery'), int) or not 30 <= facts['battery'] <= 100:
        raise Blocked('battery_below_30_or_unknown')
    if not 0 < raw_size <= facts['sectors'] * 512:
        raise Blocked('image_does_not_fit')


def validate_stock(facts, profile):
    # RG353P is a shared stock firmware identifier, NOT a physical-model proof.
    # The operator/supervisor must select the already-characterized physical model.
    if profile != PROFILE:
        raise Blocked('explicit_supported_physical_profile_required')
    if (facts.get('android') != '11' or facts.get('product') != 'RG353P'
            or facts.get('platform') != 'rk3566'):
        raise Blocked('unsupported_stock_android_fingerprint')
    stock_storage = dict(facts, mounted=False)
    validate_storage(stock_storage, 512)


def raw_digest(path):
    total = 0; digest = hashlib.sha256()
    try:
        with gzip.open(path, 'rb') as stream:
            while block := stream.read(8 * 1024 * 1024):
                total += len(block)
                if total > MAX_RAW:
                    raise Blocked('raw_image_too_large')
                digest.update(block)
    except (OSError, EOFError) as error:
        raise Blocked('invalid_gzip_image') from error
    if not total or total % 512:
        raise Blocked('raw_image_not_sector_aligned')
    return total, digest.hexdigest()


def image_geometry(path):
    """Read offsets from validated primary AND backup GPT, never a receipt field."""
    from rocknix.image import generated_gpt_layout
    with gzip.open(path, 'rb') as stream:
        parts = generated_gpt_layout(stream)[3]
    return {f'mmcblk0p{index}': tuple(part) for index, part in enumerate(parts, 1)}


def probe_recovery_tools(adb):
    # Execute the actual ioctl on the unmounted stock table before destructive
    # writing. A listed binary/help option alone does not prove kernel support.
    adb.command('exec-out','sh','-c',quote(
        'set -o pipefail; set -eu; test -b /dev/block/mmcblk0; '
        'for t in gzip dd sync mount umount sha256sum readlink blockdev; '
        'do command -v "$t" >/dev/null; done; '
        'blockdev --rereadpt /dev/block/mmcblk0'))


PARTITION_PROBE = '''set -eu
for p in /sys/block/mmcblk0/mmcblk0p*; do
 test -d "$p" || continue
 printf '%s=' "${p##*/}"
 start=$(cat "$p/start"); size=$(cat "$p/size")
 printf '%s:%s\\n' "$start" "$size"
done
'''


def refresh_partitions(adb, geometry):
    """Raw writes don't update kernel partition devices; never mount stale p2."""
    adb.command('exec-out','sh','-c',quote(
        'set -eu; blockdev --rereadpt /dev/block/mmcblk0'))
    output = adb.command('exec-out','sh','-c',quote(PARTITION_PROBE))
    try:
        actual = {}
        for line in output.decode('ascii').splitlines():
            name, extent = line.split('=')
            if name in actual or not re.fullmatch(r'mmcblk0p[0-9]+', name):
                raise ValueError()
            values = extent.split(':')
            if len(values) != 2 or not all(re.fullmatch(r'[0-9]+', value) for value in values):
                raise ValueError()
            actual[name] = tuple(map(int, values))
        if actual != geometry:
            raise ValueError()
    except (UnicodeError, ValueError) as error:
        raise Blocked('kernel_partition_geometry_mismatch') from error


class Journal:
    """Exclusive, private, atomic checkpoints. Checkpoints never authorize a skip."""
    def __init__(self, directory, binding):
        self.directory = Path(directory); self.binding = binding

    def __enter__(self):
        if self.directory.is_symlink():
            raise Blocked('unsafe_job_directory')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.directory.stat().st_uid != os.getuid() or self.directory.stat().st_mode & 0o077:
            raise Blocked('job_directory_must_be_private')
        for name in ('lock', 'state.json', 'host', 'host.pub', 'known_hosts'):
            if (self.directory/name).is_symlink():
                raise Blocked('unsafe_job_file')
        self.lock = (self.directory/'lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.state = json.loads((self.directory/'state.json').read_text()) if (self.directory/'state.json').exists() else {'binding': self.binding, 'stage':'new'}
            if self.state.get('binding') != self.binding:
                raise Blocked('checkpoint_binding_mismatch')
        except BaseException:
            self.lock.close(); raise
        return self

    def save(self, stage, **facts):
        self.state.update(stage=stage, **facts)
        fd, name = tempfile.mkstemp(prefix='.state-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(self.state, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
            os.replace(name, self.directory/'state.json')
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        finally:
            Path(name).unlink(missing_ok=True)

    def __exit__(self, *args):
        self.lock.close()


# Static shell text only. Target is never a CLI-provided arbitrary block path.
PROBE = r'''
set -eu
command -v readlink >/dev/null
printf 'cid='; cat /sys/block/mmcblk0/device/cid
printf 'name='; cat /sys/block/mmcblk0/device/name
printf 'sectors='; cat /sys/block/mmcblk0/size
printf 'removable='; cat /sys/block/mmcblk0/removable
printf 'type='; cat /sys/block/mmcblk0/device/type
printf 'battery='; cat /sys/class/power_supply/battery/capacity
printf 'charging='; cat /sys/class/power_supply/battery/status
printf 'mounted='
mounted=0
while read -r source rest; do
 case "$source" in /dev/*) canonical=$(readlink -f "$source");; *) continue;; esac
 case "$canonical" in /dev/block/mmcblk0|/dev/block/mmcblk0p[0-9]*|/dev/mmcblk0|/dev/mmcblk0p[0-9]*) mounted=1;; esac
done < /proc/mounts
echo "$mounted"
printf 'sd='; if test -e /sys/block/mmcblk1; then echo 1; else echo 0; fi
'''


def parse_facts(output):
    try:
        values = dict(line.split('=', 1) for line in output.decode().splitlines())
        if values.pop('type') != 'MMC': raise ValueError()
        for key in ('sectors', 'removable', 'battery'):
            values[key] = int(values[key])
        for key in ('mounted', 'sd'):
            if values[key] not in ('0','1'): raise ValueError()
            values[key] = values[key] == '1'
        values['charging'] = values['charging'] in ('Charging', 'Full')
        return values
    except (UnicodeError, ValueError, KeyError) as error:
        raise Blocked('invalid_storage_probe') from error


class Adb:
    def __init__(self, executable, serial):
        self.executable, self.serial = executable, serial
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', serial): raise Blocked('invalid_serial')

    def args(self, *args): return [self.executable, '-s', self.serial, *args]

    def command(self, *args, timeout=30):
        try:
            result = subprocess.run(self.args(*args), stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Blocked('adb_command_unavailable_or_timeout') from error
        if result.returncode: raise Blocked('adb_command_failed')
        return result.stdout

    def facts(self, recovery=True):
        if recovery:
            if self.command('shell', 'id', '-u').strip() != b'0': raise Blocked('recovery_root_unavailable')
            mode = self.command('shell','getprop','ro.bootmode').strip()
            if mode != b'recovery': raise Blocked('not_android_recovery')
            return parse_facts(self.command('exec-out', 'sh', '-c', quote(PROBE)))
        if self.command('shell','su','0','id','-u').strip() != b'0':
            raise Blocked('stock_root_unavailable')
        data = parse_facts(self.command('exec-out', 'su', '0', 'sh', '-c', quote(PROBE)))
        for name, prop in [('android','ro.build.version.release'), ('product','ro.product.model'),
                           ('platform','ro.board.platform')]:
            data[name] = self.command('shell','getprop',prop).decode().strip()
        return data

    def stream(self, script, source):
        # stdout/stderr bounded by using files, never log provider/tool contents.
        with tempfile.TemporaryFile() as output:
            try:
                result = subprocess.run(self.args('exec-out','sh','-c',quote(script)),
                                        stdin=source, stdout=output, stderr=output, timeout=1800)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise Blocked('adb_stream_interrupted') from error
            if result.returncode: raise Blocked('adb_stream_failed')

    def readback(self, size):
        # 512-byte blocks include the final non-MiB-aligned GPT sectors exactly.
        script = f'set -eu; dd if={BLOCK} bs=512 count={size//512}'
        digest = hashlib.sha256(); total = 0
        with tempfile.TemporaryFile() as errors:
            try:
                process = subprocess.Popen(self.args('exec-out','sh','-c',quote(script)),
                                           stdout=subprocess.PIPE, stderr=errors)
                # dd is finite, but use a watchdog so a hung USB read cannot block forever.
                import threading
                expired = threading.Event()
                def stop():
                    expired.set(); process.kill()
                timer = threading.Timer(1800, stop); timer.start()
                try:
                    while block := process.stdout.read(1024*1024):
                        total += len(block)
                        if total > size: raise Blocked('readback_exceeded_expected_size')
                        digest.update(block)
                    code = process.wait(timeout=10)
                    if code or expired.is_set(): raise Blocked('readback_interrupted')
                finally:
                    timer.cancel(); process.stdout.close()
                    if process.poll() is None: process.kill(); process.wait()
            except (OSError, subprocess.TimeoutExpired) as error:
                raise Blocked('readback_unavailable') from error
        return total, digest.hexdigest()


def quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


def write_verified(adb, artifact, size, expected, original, journal, compressed_hash=None):
    fresh = adb.facts(); validate_storage(fresh, size); same_storage(original, fresh)
    # An interrupted/completed checkpoint never skips the raw write. Recovery may
    # hold a partially written image, so always re-establish every byte in recovery.
    journal.save('writing', storage=identity(fresh))
    with artifact.open('rb') as stream:
        if compressed_hash and hashlib.file_digest(stream, 'sha256').hexdigest() != compressed_hash:
            raise Blocked('image_changed_before_write')
        stream.seek(0)
        adb.stream(f'set -o pipefail; gzip -dc | dd of={BLOCK} bs=1048576 conv=fsync', stream)
    journal.save('written')
    fresh = adb.facts(); validate_storage(fresh, size); same_storage(original, fresh)
    actual_size, actual_hash = adb.readback(size)
    if actual_size != size or actual_hash != expected: raise Blocked('readback_mismatch')
    journal.save('verified', raw_size=size, raw_sha256=actual_hash)


def checked_run(args, **kwargs):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, **kwargs)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Blocked('host_tool_unavailable_or_timeout') from error
    if result.returncode: raise Blocked('host_tool_failed')
    return result.stdout


def prepare_host_identity(journal, host):
    path = journal.directory/'host'
    if not path.exists():
        checked_run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(path)])
    if path.stat().st_mode & 0o077: raise Blocked('host_private_key_permissions')
    public = checked_run(['ssh-keygen','-y','-P','','-f',str(path)]).decode().strip()
    if not public.startswith('ssh-ed25519 '): raise Blocked('invalid_host_key')
    known = journal.directory/'known_hosts'
    known.write_text(f'[{host}]:2223 {public}\n'); known.chmod(0o600)
    return path, hashlib.sha256(public.encode()).hexdigest()


def enroll_host_identity(adb, host_key, original, size, journal, geometry):
    fresh = adb.facts(); validate_storage(fresh, size); same_storage(original, fresh)
    refresh_partitions(adb, geometry)
    journal.save('partitions_ready', partition_geometry=geometry)
    # Explicit per-device personalization AFTER raw verification. The receipt
    # never claims that the final personalized disk still equals the raw image.
    target = MOUNT + '/cubby/recovery/private'
    script = f'''set -eu
 test -b {BLOCK}p2
 test ! -e {MOUNT}
 mkdir {MOUNT}
 mount -t ext4 {BLOCK}p2 {MOUNT}
 trap 'umount {MOUNT}; rmdir {MOUNT}' 0
 test ! -L {MOUNT}/cubby
 test ! -L {MOUNT}/cubby/recovery
 mkdir -p {target}
 test ! -L {target}
 chmod 700 {MOUNT}/cubby/recovery {target}
 umask 077
 cat > {target}/ssh_host_ed25519_key
 sync
 umount {MOUNT}
 rmdir {MOUNT}
 trap - 0
'''
    with host_key.open('rb') as stream: adb.stream(script, stream)
    # Fresh read-only remount verifies actual persisted key bytes, not an echo.
    verify_script = f'''set -eu
 mkdir {MOUNT}
 mount -t ext4 -o ro {BLOCK}p2 {MOUNT}
 trap 'umount {MOUNT}; rmdir {MOUNT}' 0
 sha256sum {target}/ssh_host_ed25519_key
 umount {MOUNT}
 rmdir {MOUNT}
 trap - 0
'''
    result = adb.command('exec-out','sh','-c',quote(verify_script))
    expected = hashlib.sha256(host_key.read_bytes()).hexdigest()
    if result.split()[:1] != [expected.encode()]: raise Blocked('host_identity_enrollment_mismatch')
    journal.save('enrolled', personalization={'host_private_sha256':expected,
                                            'raw_hash_is_pre_personalization':True})


LIVE_PROBE = '''import json,pathlib
p=pathlib.Path('/storage/cubby/current/image.json')
i=json.loads(p.read_text())
m={line.split()[1]:line.split()[0] for line in pathlib.Path('/proc/mounts').read_text().splitlines()}
i.update(flash_source=m.get('/flash'),storage_source=m.get('/storage'),cid=pathlib.Path('/sys/block/mmcblk0/device/cid').read_text().strip())
print(json.dumps(i))'''


def validate_live(data, version, commit, storage):
    if (data.get('version') != version or data.get('source_commit') != commit
            or data.get('cid') != storage['cid']
            or data.get('flash_source') != '/dev/mmcblk0p1'
            or data.get('storage_source') != '/dev/mmcblk0p2'):
        raise Blocked('reconnected_wrong_image_or_storage')


def reconnect(args, journal, storage):
    known = journal.directory/'known_hosts'
    if not known.is_file(): raise Blocked('host_identity_not_enrolled')
    deadline = time.monotonic() + args.reconnect_timeout
    command = ['ssh','-p','2223','-i',str(args.identity),'-o','IdentitiesOnly=yes',
               '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
               '-o','UserKnownHostsFile='+str(known),'-o','ConnectTimeout=5',
               'root@'+args.host, 'python3 -c '+quote(LIVE_PROBE)]
    while time.monotonic() < deadline:
        try:
            data = json.loads(checked_run(command))
        except (Blocked, ValueError, UnicodeError):
            time.sleep(min(3,max(0,deadline-time.monotonic()))); continue
        validate_live(data,args.expect_version,args.expect_commit,storage)
        journal.save('commissioning_pending', installed=data)
        return journal.state
    raise Blocked('reconnect_timeout_not_customer_ready')


def discover(executable):
    return select_device(checked_run([executable,'devices','-l']).decode())


def run(args):
    if args.profile != PROFILE: raise Blocked('explicit_supported_physical_profile_required')
    if not re.fullmatch(r'[0-9a-f]{40}',args.expect_commit): raise Blocked('exact_commit_required')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',args.expect_version): raise Blocked('exact_version_required')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*',args.host): raise Blocked('invalid_usb_host')
    if (args.identity.is_symlink() or not args.identity.is_file()
            or args.identity.stat().st_uid != os.getuid()
            or args.identity.stat().st_mode & 0o077):
        raise Blocked('client_identity_must_be_private_regular_file')
    from rocknix.production_image import verify, public_keys
    key = public_keys(args.public_key)
    plan = verify(args.image,args.manifest,expected_version=args.expect_version,expected_commit=args.expect_commit)
    if plan['flash_files'].get('cubby-setup/authorized_keys') != hashlib.sha256(key).hexdigest():
        raise Blocked('image_missing_selected_management_public_key')
    private_public = checked_run(['ssh-keygen','-y','-P','','-f',str(args.identity)]).split()
    if private_public[:2] not in [line.split()[:2] for line in key.splitlines() if line.strip()]:
        raise Blocked('management_identity_does_not_match_image')
    size, digest = raw_digest(args.image)
    geometry = image_geometry(args.image)
    serial = args.serial
    # Linux no longer exposes ADB. An explicitly selected serial + matching
    # locked receipt permits only pinned SSH verification, never another write.
    resuming_linux = False
    state_path = args.job/'state.json'
    if (serial and not args.job.is_symlink() and not state_path.is_symlink()
            and state_path.is_file() and args.job.stat().st_uid == os.getuid()
            and not args.job.stat().st_mode & 0o077):
        state = json.loads(state_path.read_text())
        resuming_linux = state.get('stage') in ('rebooting','commissioning_pending')
    if not resuming_linux:
        found = discover(args.adb)
        if serial and found != serial: raise Blocked('selected_serial_mismatch')
        serial = found
    adb = Adb(args.adb, serial)
    binding = dict(serial=serial, image_sha256=plan['image']['sha256'],
                   profile=args.profile, version=args.expect_version, commit=args.expect_commit,
                   public_key_sha256=hashlib.sha256(key).hexdigest())
    # A plan is truly read-only: no root daemon restart, reboot or checkpoint.
    if args.action == 'plan':
        stock = adb.facts(recovery=False); validate_stock(stock,args.profile)
        return dict(stage='planned',binding=binding,storage=identity(stock),raw_size=size,raw_sha256=digest)
    with Journal(args.job,binding) as journal:
        if 'storage' in journal.state:
            original = journal.state['storage']
        else:
            original = adb.facts(recovery=False); validate_stock(original,args.profile)
            journal.save('stock_verified',storage=identity(original))
        # Verify a completed Linux target via pinned SSH rather than flashing again.
        if journal.state['stage'] in ('rebooting','commissioning_pending'):
            return reconnect(args,journal,original)
        mode = adb.command('shell','getprop','ro.bootmode').strip()
        if mode != b'recovery':
            stock = adb.facts(recovery=False); validate_stock(stock,args.profile); same_storage(original,stock)
            journal.save('entering_recovery')
            adb.command('reboot','recovery')
            adb.command('wait-for-device',timeout=120)
        adb.command('root'); adb.command('wait-for-device',timeout=120)
        facts = adb.facts(); validate_storage(facts,size); same_storage(original,facts)
        # Probe required recovery primitives before the first write.
        probe_recovery_tools(adb)
        host_key, host_public_digest = prepare_host_identity(journal,args.host)
        write_verified(adb,args.image,size,digest,original,journal,plan['image']['sha256'])
        enroll_host_identity(adb,host_key,original,size,journal,geometry)
        fresh = adb.facts(); validate_storage(fresh,size); same_storage(original,fresh)
        journal.save('rebooting',host_public_sha256=host_public_digest)
        adb.command('reboot')
        return reconnect(args,journal,original)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['plan','install'],nargs='?',default='plan')
    parser.add_argument('--profile',required=True,choices=[PROFILE])
    parser.add_argument('--image',type=Path,required=True)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--expect-version',required=True)
    parser.add_argument('--expect-commit',required=True)
    parser.add_argument('--public-key',type=Path,required=True)
    parser.add_argument('--identity',type=Path,required=True)
    parser.add_argument('--serial')
    parser.add_argument('--adb',default='adb')
    parser.add_argument('--job',type=Path,default=Path('.cache/provision-job'))
    parser.add_argument('--host',default='169.254.170.2')
    parser.add_argument('--reconnect-timeout',type=int,default=240)
    args=parser.parse_args()
    try:
        if not 10 <= args.reconnect_timeout <= 900: raise Blocked('invalid_reconnect_timeout')
        result=run(args)
        print(json.dumps(result,indent=2))
    except (Blocked,OSError,ValueError,KeyError) as error:
        reason=str(error) if isinstance(error,Blocked) else 'preflight_or_filesystem_validation_failed'
        print(json.dumps({'stage':'blocked','reason':reason}),file=sys.stderr)
        sys.exit(1)


if __name__=='__main__': main()
