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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rocknix.provision import Blocked, Journal

PENDING = ['physical_controls', 'audible_speaker', 'sleep_wake', 'game_save_persistence',
           'signed_update_rollback']
NATIVE = Path(__file__).with_name('device')/'commissioning.py'


class Remote:
    def __init__(self, args):
        self.args=args

    def call(self, action, data, expected):
        args=self.args
        command=['ssh','-p','2223','-i',str(args.identity),'-o','IdentitiesOnly=yes',
                 '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                 '-o','UserKnownHostsFile='+str(args.job/'known_hosts'),'-o','ConnectTimeout=8',
                 'root@'+args.host,'python3 -c '+shlex.quote(NATIVE.read_text())]
        try:
            result=subprocess.run(command,input=json.dumps(dict(action=action,data=data,expected=expected)).encode(),
                                  capture_output=True,timeout=240)
            if result.returncode: raise Blocked('commissioning_transport_failed')
            response=json.loads(result.stdout)
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


def wait_reboot(remote, expected, old_boot, timeout=240):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            snapshot=remote.call('snapshot',{},expected)
            if snapshot.get('boot_id') and snapshot['boot_id'] != old_boot:
                return snapshot
        except Blocked:
            pass
        time.sleep(min(3,max(0,deadline-time.monotonic())))
    raise Blocked('commissioning_reboot_not_observed')


def checked_snapshot(snapshot):
    checks=snapshot.get('checks',{})
    required={'no_failed_units','artwork','boot_progress','management','updater',
              'controller_presence','audio_presence','power_presence'}
    if set(checks)!=required or not all(value is True for value in checks.values()):
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
        snapshot=remote.call('snapshot',{},expected)
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
