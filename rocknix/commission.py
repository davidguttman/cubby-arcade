#!/usr/bin/env python3
"""Commission a bound internal installation through its pinned recovery identity.

No block-device writes. Presence probes are not physical acceptance evidence.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rocknix.provision import Blocked, Journal

PENDING = ['physical_controls', 'audible_speaker', 'sleep_wake', 'game_save_persistence',
           'signed_update_rollback']
NATIVE = Path(__file__).with_name('device')/'commissioning.py'


class Remote:
    def __init__(self, args):
        self.args=args

    def call(self, action, data, expected, *, timeout=240):
        args=self.args
        command=['ssh','-p','2223','-i',str(args.identity),'-o','IdentitiesOnly=yes',
                 '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                 '-o','UserKnownHostsFile='+str(args.job/'known_hosts'),'-o','ConnectTimeout=8',
                 'root@'+args.host,'python3 -c '+shlex.quote(NATIVE.read_text())]
        try:
            result=subprocess.run(command,input=json.dumps(dict(action=action,data=data,expected=expected)).encode(),
                                  capture_output=True,timeout=timeout)
            if result.returncode:
                stderr=result.stderr.lower() if isinstance(result.stderr,bytes) else b''
                if any(marker in stderr for marker in (b'host key',b'host identification',b'permission denied',
                        b'authentication failed',b'identity file',b'load key',b'bad permissions')):
                    raise Blocked('commissioning_authentication_failed')
                # Native target validation failures must not turn into a retry.
                try: response=json.loads(result.stdout)
                except (ValueError,TypeError): response=None
                if isinstance(response,dict) and response.get('error'):
                    raise Blocked('commissioning_native_failed')
                raise Blocked('commissioning_transport_failed')
            try: response=json.loads(result.stdout)
            except (ValueError,TypeError):
                raise Blocked('commissioning_native_failed') from None
            if not isinstance(response,dict) or response.get('error'):
                raise Blocked('commissioning_native_failed')
            return response
        except (OSError,ValueError,subprocess.TimeoutExpired) as error:
            if isinstance(error,Blocked): raise
            raise Blocked('commissioning_transport_failed') from None


def receipt(state, snapshot, handoff=None):
    return dict(schema=1, binding=state['binding'], cid=state['storage']['cid'],
                automated=snapshot, bench=state.get('commissioning',{}).get('bench'),
                handoff=handoff, pending=list(PENDING), customer_ready=False)


def wait_ready(remote, expected, *, old_boot=None, timeout=240):
    """Wait only for read-only readiness; never repeat a mutating action.

    Recovery SSH can answer before the application services finish starting.
    Native identity failures and SSH authentication errors remain terminal.
    """
    deadline=time.monotonic()+timeout
    observed_boot=False
    while time.monotonic()<deadline:
        try:
            snapshot=remote.call('snapshot',{},expected,
                                 timeout=max(.01,deadline-time.monotonic()))
            validate_snapshot(snapshot, expected)
            if old_boot is None or snapshot['boot_id'] != old_boot:
                observed_boot=True
                if all(snapshot['checks'].values()): return snapshot
        except Blocked as error:
            if str(error)!='commissioning_transport_failed': raise
        time.sleep(min(3,max(0,deadline-time.monotonic())))
    if old_boot is not None and not observed_boot:
        raise Blocked('commissioning_reboot_not_observed')
    raise Blocked('commissioning_readiness_timeout')


def wait_reboot(remote, expected, old_boot, timeout=240):
    return wait_ready(remote,expected,old_boot=old_boot,timeout=timeout)


REQUIRED_CHECKS={'no_failed_units','artwork','boot_progress','management','updater',
                 'controller_presence','audio_presence','power_presence'}


def validate_snapshot(snapshot, expected):
    """A successful response must be a complete native snapshot, even on the old boot.

    Only well-formed boolean false checks mean services are still starting.
    Missing identity, boot or profile fields are never readiness signals.
    """
    if not isinstance(snapshot, dict): raise Blocked('commissioning_native_failed')
    identity=snapshot.get('identity')
    if (not isinstance(identity,dict)
            or any(not isinstance(expected.get(key),str) or not expected[key]
                   or identity.get(key)!=expected[key] for key in ('version','commit','cid'))
            or identity.get('bound_cid')!=expected['cid']
            or identity.get('flash')!='/dev/mmcblk0p1'
            or identity.get('storage')!='/dev/mmcblk0p2'):
        raise Blocked('commissioning_native_failed')
    boot=snapshot.get('boot_id')
    if not isinstance(boot,str) or not re.fullmatch(r'[A-Za-z0-9-]{1,128}',boot):
        raise Blocked('commissioning_native_failed')
    checks=snapshot.get('checks')
    if (not isinstance(checks,dict) or set(checks)!=REQUIRED_CHECKS
            or any(type(value) is not bool for value in checks.values())):
        raise Blocked('commissioning_automated_gate_failed')
    profiles=snapshot.get('profile_ids')
    if not isinstance(profiles,list): raise Blocked('commissioning_native_failed')
    try:
        if (any(not isinstance(uid,str) or str(uuid.UUID(uid))!=uid for uid in profiles)
                or len(set(profiles))!=len(profiles)):
            raise ValueError('invalid_profile_ids')
    except (ValueError,TypeError,AttributeError):
        raise Blocked('commissioning_native_failed') from None


def checked_snapshot(snapshot):
    checks=snapshot.get('checks',{})
    if set(checks)!=REQUIRED_CHECKS or not all(value is True for value in checks.values()):
        raise Blocked('commissioning_automated_gate_failed')


def validate_args(args):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*',args.host): raise Blocked('invalid_usb_host')
    for path in (args.identity,args.job/'known_hosts',args.job/'state.json'):
        if path.is_symlink() or not path.is_file() or path.stat().st_uid!=os.getuid() or path.stat().st_mode & 0o077:
            raise Blocked('private_provisioning_artifacts_required')
    # Journal also rejects symlink directory/lock and checks its owner/mode.
    state=json.loads((args.job/'state.json').read_text())
    binding=state['binding']; storage=state['storage']
    if (not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',binding['version'])
            or not re.fullmatch('[a-f0-9]{40}',binding['commit'])
            or not re.fullmatch('[a-f0-9]{64}',binding['image_sha256'])
            or not re.fullmatch('[a-f0-9]{32}',storage['cid'])
            or state.get('stage')!='commissioning_pending'):
        raise Blocked('verified_install_checkpoint_required')
    return binding,dict(version=binding['version'],commit=binding['commit'],cid=storage['cid'])


def run(args):
    binding,expected=validate_args(args)
    remote=Remote(args)
    with Journal(args.job,binding) as journal:
        if journal.state.get('stage') != 'commissioning_pending':
            raise Blocked('verified_install_checkpoint_required')
        snapshot=wait_ready(remote,expected)
        checked_snapshot(snapshot)
        data=journal.state.get('commissioning',{})
        if data.get('phase')=='reboot_pending':
            snapshot=wait_reboot(remote,expected,data['boot_before'])
            checked_snapshot(snapshot)
            wifi=remote.call('wifi',{},expected)
            if (not wifi.get('internet') or not wifi.get('wifi_enabled')
                    or not set(data['bench']['profile_ids']) <= set(wifi['profile_ids'])):
                raise Blocked('bench_wifi_reboot_persistence_failed')
            data.update(phase='checked',boot_after=snapshot['boot_id'],wifi_reboot=True)
            journal.save('commissioning_pending',commissioning=data)
        if args.action=='bench':
            if data.get('bench'): raise Blocked('bench_already_connected_use_check_or_handoff')
            credentials=json.load(sys.stdin)
            if (set(credentials)!= {'ssid','password'} or not all(isinstance(v,str) for v in credentials.values())):
                raise Blocked('bench_credentials_required_on_stdin')
            data.update(phase='bench_connecting',baseline=snapshot['profile_ids'])
            journal.save('commissioning_pending',commissioning=data)
            credentials['baseline']=snapshot['profile_ids']
            bench=remote.call('bench',credentials,expected)
            del credentials
            data.update(phase='reboot_pending',bench=bench,boot_before=snapshot['boot_id'])
            journal.save('commissioning_pending',commissioning=data)
            try: remote.call('reboot',{},expected)
            except Blocked:
                # Disconnect may race the successful reboot response; only a
                # new authenticated boot ID permits continuation.
                pass
            snapshot=wait_reboot(remote,expected,data['boot_before'])
            checked_snapshot(snapshot)
            wifi=remote.call('wifi',{},expected)
            if (not wifi.get('internet') or not wifi.get('wifi_enabled')
                    or not set(bench['profile_ids']) <= set(wifi.get('profile_ids',[]))):
                raise Blocked('bench_wifi_reboot_persistence_failed')
            data.update(phase='checked',boot_after=snapshot['boot_id'],wifi_reboot=True)
        handoff=None
        if args.action=='handoff':
            if data.get('phase')=='bench_connecting': raise Blocked('interrupted_bench_connect_requires_diagnosis')
            owned=data.get('bench',{}).get('profile_ids',[])
            handoff=remote.call('handoff',{'profile_ids':owned},expected)
            if handoff.get('clean') is not True: raise Blocked('handoff_not_clean')
            data.update(phase='handoff_clean',handoff=handoff)
        elif data.get('phase')!='handoff_clean':
            data.setdefault('phase','checked')
        result=receipt(journal.state,snapshot,handoff or data.get('handoff'))
        data['receipt']=result
        journal.save('commissioning_pending',commissioning=data)
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['check','bench','handoff'])
    parser.add_argument('--job',type=Path,required=True)
    parser.add_argument('--identity',type=Path,required=True)
    parser.add_argument('--host',default='169.254.170.2')
    args=parser.parse_args()
    try: print(json.dumps(run(args),indent=2))
    except Exception as error:
        print(json.dumps({'stage':'blocked','reason':str(error) if isinstance(error,Blocked)
                          else 'commissioning_validation_failed'}),file=sys.stderr)
        sys.exit(1)


if __name__=='__main__': main()
