#!/usr/bin/env python3
"""Reflash internal eMMC only from independently proven SD Linux recovery.

Not the factory Android entry path, and not a customer-readiness certificate.
No host block writes. Requires an existing, independently trusted recovery key.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from rocknix import provision as p
from rocknix.provision import Blocked

CID='150100424a5444345200ec55ccb75600'
TARGET='/dev/mmcblk0'
PROBE=Path(__file__).with_name('device')/'linux_rescue_probe.py'


def validate_rescue(data,size):
    if (data.get('probe_complete') is not True or data.get('sd') is not True
            or data.get('flash')!='/dev/mmcblk1p1' or data.get('storage')!='/dev/mmcblk1p2'
            or data.get('root_disks')!=['mmcblk1']
            or not isinstance(data.get('active_disks'),list)
            or 'mmcblk0' in data['active_disks'] or data.get('holders')!=[]
            or data.get('mounted') is not False or data.get('cid')!=CID
            or data.get('type')!='MMC'):
        raise Blocked('independent_sd_recovery_not_proven')
    # Only this adapter clears SD presence after its stricter Linux checks. The
    # shared Android guard remains unchanged and continues rejecting any SD.
    clean=dict(data,sd=False)
    p.validate_storage(clean,size)
    return clean


def distinct_media(data,plan):
    current=data.get('media_ids')
    if not isinstance(current,list) or not current or not all(isinstance(v,str) and v for v in current):
        raise Blocked('recovery_media_identity_unknown')
    ids=plan.get('media_identities',{})
    incoming=[v for v in ids.values() if isinstance(v,str)]+ids.get('partition_guids',[])
    normalize=lambda value: value.lower().replace('-','')
    if {normalize(v) for v in current} & {normalize(v) for v in incoming}:
        raise Blocked('recovery_and_target_media_identity_collision')


class Ssh(p.Adb):
    """Shared finite stream/readback implementation over pinned non-PTY SSH."""
    def __init__(self,args,plan,size):
        self.args_config=args; self.plan=plan; self.size=size
        self.shell_v2_verified=False

    def args(self,*args):
        a=self.args_config
        return ['ssh','-F','/dev/null','-T','-p',str(a.recovery_port),'-i',str(a.identity),
                '-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                '-o','UserKnownHostsFile='+str(a.recovery_known_hosts),'-o','ConnectTimeout=8',
                '-o','ClearAllForwardings=yes','root@'+a.host,*args]

    def require_shell_v2(self):
        if self.shell_v2_verified:return
        payload=b'cubby-ssh-binary\x00\r\n\xff'
        try:
            reply=subprocess.run(self.args("sh -c 'cat; printf cubby-ssh-stderr >&2; exit 73'"),
                                 input=payload,capture_output=True,timeout=30)
        except (OSError,subprocess.TimeoutExpired) as error:
            raise Blocked('pinned_rescue_ssh_unavailable') from error
        if (reply.returncode,reply.stdout,reply.stderr)!=(73,payload,b'cubby-ssh-stderr'):
            raise Blocked('rescue_ssh_binary_semantics_failed')
        self.shell_v2_verified=True

    def shell_args(self,*args):
        self.require_shell_v2()
        # Callers supply static shell tokens with the script already quoted.
        return self.args(' '.join(args).replace(p.BLOCK,TARGET))

    def command(self,*args,timeout=30):
        if not args or args[0]!='shell':raise Blocked('unsupported_rescue_command')
        try:
            reply=subprocess.run(self.shell_args(*args[1:]),stdin=subprocess.DEVNULL,
                                 capture_output=True,timeout=timeout)
        except (OSError,subprocess.TimeoutExpired) as error:
            raise Blocked('rescue_command_unavailable') from error
        if reply.returncode:raise Blocked('rescue_command_failed')
        return reply.stdout

    def facts(self,recovery=True):
        raw=self.command('shell','python3','-c',p.quote(PROBE.read_text()))
        try:data=json.loads(raw)
        except (ValueError,UnicodeError) as error:raise Blocked('invalid_rescue_probe') from error
        clean=validate_rescue(data,self.size)
        distinct_media(data,self.plan)
        p.validate_device_binding(self.plan,clean)
        return clean


def private_file(path):
    if (path.is_symlink() or not path.is_file() or path.stat().st_uid!=os.getuid()
            or path.stat().st_mode & 0o077):raise Blocked('private_regular_file_required')


def run(args):
    if not re.fullmatch(r'[0-9a-f]{40}',args.expect_commit):raise Blocked('exact_commit_required')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',args.expect_version):raise Blocked('exact_version_required')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*',args.host):raise Blocked('invalid_usb_host')
    if args.recovery_port not in (2222,2223):raise Blocked('unsupported_recovery_port')
    if not 10<=args.reconnect_timeout<=900:raise Blocked('invalid_reconnect_timeout')
    for path in (args.identity,args.recovery_known_hosts):private_file(path)
    from rocknix.production_image import verify,public_keys
    plan=verify(args.image,args.manifest,expected_version=args.expect_version,expected_commit=args.expect_commit)
    keys=public_keys(args.public_key)
    if plan['flash_files'].get('cubby-setup/authorized_keys')!=hashlib.sha256(keys).hexdigest():
        raise Blocked('image_missing_selected_management_public_key')
    public=p.checked_run(['ssh-keygen','-y','-P','','-f',str(args.identity)]).split()[:2]
    if public not in [line.split()[:2] for line in keys.splitlines() if line.strip()]:
        raise Blocked('management_identity_does_not_match_image')
    size,digest=p.raw_digest(args.image); geometry=p.image_geometry(args.image)
    remote=Ssh(args,plan,size)
    binding=dict(serial='linux-rescue-'+CID,image_sha256=plan['image']['sha256'],
                 profile='rg353v-linux-sd-recovery',version=args.expect_version,
                 commit=args.expect_commit,public_key_sha256=hashlib.sha256(keys).hexdigest())
    if args.action=='plan':
        facts=remote.facts()
        return dict(stage='planned',binding=binding,storage=p.identity(facts),raw_size=size,raw_sha256=digest)
    with p.Journal(args.job,binding) as journal:
        original=journal.state.get('storage')
        if journal.state['stage'] in ('awaiting_internal_boot','rebooting','commissioning_pending'):
            if not original:raise Blocked('missing_verified_target_identity')
            return p.reconnect(args,journal,original)
        if args.action=='verify':raise Blocked('verified_install_checkpoint_required')
        fresh=remote.facts()
        if original:p.same_storage(original,fresh)
        else:original=fresh; journal.save('rescue_verified',storage=p.identity(original))
        p.probe_recovery_tools(remote)
        remote.command('shell','sh','-c',p.quote('set -eu; command -v systemctl >/dev/null; test -d /run/systemd/system'))
        host_key,host_digest=p.prepare_host_identity(journal,args.host)
        p.write_verified(remote,args.image,size,digest,original,journal,plan['image']['sha256'])
        p.enroll_host_identity(remote,host_key,original,size,journal,geometry)
        p.same_storage(original,remote.facts())
        # Never reboot with SD inserted: it would simply boot recovery again.
        journal.save('awaiting_internal_boot',host_public_sha256=host_digest)
        try:remote.command('shell','sh','-c',p.quote('sync; systemctl poweroff'),timeout=30)
        except Blocked:
            # Poweroff may close SSH before status arrives. Receipt authorizes
            # only pinned internal verification next, never an unchecked write.
            pass
        return dict(journal.state,next_step='Remove SD after shutdown, then power on; resume with verify')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['plan','install','verify'],nargs='?',default='plan')
    for name in ('image','manifest','public-key','identity','recovery-known-hosts','job'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--expect-version',required=True);parser.add_argument('--expect-commit',required=True)
    parser.add_argument('--host',default='169.254.170.2')
    parser.add_argument('--recovery-port',type=int,default=2223)
    parser.add_argument('--reconnect-timeout',type=int,default=240)
    args=parser.parse_args()
    try:print(json.dumps(run(args),indent=2))
    except (Blocked,OSError,ValueError,KeyError) as error:
        reason=str(error) if isinstance(error,Blocked) else 'rescue_preflight_failed'
        print(json.dumps(dict(stage='blocked',reason=reason)),file=sys.stderr);sys.exit(1)


if __name__=='__main__':main()
