"""Read-only, fail-closed block dependency collector for SD recovery."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess


def unescape(value):
    return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),value)


def collect():
    if os.geteuid()!=0: raise ValueError('root_required')
    mounts=[]
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left,right=line.split(' - ',1); fields=left.split(); detail=right.split()
        mounts.append(dict(dev=fields[2],path=unescape(fields[4]),source=unescape(detail[1])))
    def owner(path):
        path=os.path.realpath(path)
        candidates=[m for m in mounts if path==m['path'] or path.startswith(m['path'].rstrip('/')+'/')]
        if not candidates: raise ValueError('backing_mount_unknown')
        # mount overmounts are deliberately not guessed.
        longest=max(len(m['path']) for m in candidates)
        candidates=[m for m in candidates if len(m['path'])==longest]
        if len(candidates)!=1: raise ValueError('ambiguous_backing_mount')
        return candidates[0]
    def disks(dev,seen=()):
        if dev in seen: raise ValueError('block_dependency_cycle')
        node=Path('/sys/dev/block')/dev
        if not node.exists(): raise ValueError('block_dependency_unknown')
        node=node.resolve(); name=node.name
        if (node/'partition').exists():
            return disks((node.parent/'dev').read_text().strip(),seen+(dev,))
        if (node/'loop/backing_file').exists():
            backing=(node/'loop/backing_file').read_text().strip()
            if not backing or backing.endswith(' (deleted)'): raise ValueError('loop_backing_unknown')
            return disks(owner('/'+backing.lstrip('/'))['dev'],seen+(dev,))
        slaves=list((node/'slaves').iterdir())
        if slaves:
            result=set()
            for slave in slaves: result |= disks((slave/'dev').read_text().strip(),seen+(dev,))
            return result
        return {name}
    def dev_of(path):
        info=os.stat(path)
        if stat.S_ISBLK(info.st_mode): return f'{os.major(info.st_rdev)}:{os.minor(info.st_rdev)}'
        return owner(path)['dev']
    active=set()
    for m in mounts:
        if not m['dev'].startswith('0:'): active |= disks(m['dev'])
    for line in Path('/proc/swaps').read_text().splitlines()[1:]:
        active |= disks(dev_of(unescape(line.split()[0])))
    # Open raw block FDs are active consumers even when not mounted/swapped.
    for process in Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try:
            for fd in (process/'fd').iterdir():
                try:
                    info=fd.stat()
                    if stat.S_ISBLK(info.st_mode):
                        active |= disks(f'{os.major(info.st_rdev)}:{os.minor(info.st_rdev)}')
                except FileNotFoundError: pass # process/FD exited during read
        except FileNotFoundError: pass
    holders=[]
    for node in Path('/sys/class/block').iterdir():
        if node.name=='mmcblk0' or re.fullmatch(r'mmcblk0p[0-9]+',node.name):
            holders += [p.name for p in (node/'holders').iterdir()]
    def exact_mount(path):
        found=[m for m in mounts if m['path']==path]
        if len(found)!=1: raise ValueError('boot_mount_unknown')
        return found[0]
    flash=exact_mount('/flash'); storage=exact_mount('/storage'); root=exact_mount('/')
    def text(path): return Path(path).read_text().strip()
    media=[]
    for partition in ('/dev/mmcblk1p1','/dev/mmcblk1p2'):
        reply=subprocess.run(['blkid','-s','UUID','-s','PARTUUID','-s','LABEL','-o','export',partition],
                             check=True,capture_output=True,text=True,timeout=10)
        values=dict(line.split('=',1) for line in reply.stdout.splitlines() if '=' in line)
        if not all(values.get(key) for key in ('UUID','PARTUUID','LABEL')):
            raise ValueError('sd_media_identity_unknown')
        media += [values[key] for key in ('UUID','PARTUUID','LABEL')]
    return dict(cid=text('/sys/block/mmcblk0/device/cid'),name=text('/sys/block/mmcblk0/device/name'),
                sectors=int(text('/sys/block/mmcblk0/size')),removable=int(text('/sys/block/mmcblk0/removable')),
                battery=int(text('/sys/class/power_supply/battery/capacity')),
                charging=text('/sys/class/power_supply/battery/status') in ('Charging','Full'),
                type=text('/sys/block/mmcblk0/device/type'),mounted='mmcblk0' in active,
                sd=Path('/sys/block/mmcblk1').exists(),flash=os.path.realpath(flash['source']),
                storage=os.path.realpath(storage['source']),root_disks=sorted(disks(root['dev'])),
                active_disks=sorted(active),holders=holders,media_ids=media,probe_complete=True)


if __name__=='__main__':
    print(json.dumps(collect()))
