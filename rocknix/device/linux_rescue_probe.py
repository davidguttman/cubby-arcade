"""Read-only, fail-closed block dependency collector for SD recovery."""
import json
import fcntl
import os
from pathlib import Path
import re
import stat
import struct
import subprocess


def unescape(value):
    return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),value)


def loop_backing_device(name):
    """Get backing filesystem dev_t from the loop driver, never its filename.

    sysfs backing_file can name a detached/foreign-namespace filesystem.
    LOOP_GET_STATUS64's lo_device remains authoritative in those cases.
    """
    if not re.fullmatch(r'loop[0-9]+',name):
        raise ValueError('loop_device_unknown')
    fd=os.open('/dev/'+name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if (not stat.S_ISBLK(info.st_mode) or os.major(info.st_rdev)!=7
                or os.minor(info.st_rdev)!=int(name[4:])):
            raise ValueError('loop_device_mismatch')
        # Linux UAPI loop_info64: native byte order, fixed-width fields.
        status=fcntl.ioctl(fd,0x4C05,bytes(232)) # LOOP_GET_STATUS64
        if len(status)!=232: raise ValueError('loop_status_incomplete')
        device=struct.unpack_from('=Q',status)[0]
        number=struct.unpack_from('=I',status,40)[0]
        if number!=int(name[4:]) or not os.major(device):
            raise ValueError('loop_backing_device_unknown')
        return f'{os.major(device)}:{os.minor(device)}'
    finally:
        os.close(fd)


def collect():
    if os.geteuid()!=0: raise ValueError('root_required')
    def mount_table(path):
        result=[]
        for line in path.read_text().splitlines():
            left,right=line.split(' - ',1); fields=left.split(); detail=right.split()
            result.append(dict(dev=fields[2],path=unescape(fields[4]),source=unescape(detail[1])))
        return result
    mounts=mount_table(Path('/proc/self/mountinfo'))
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
        if re.fullmatch(r'loop[0-9]+',name):
            return disks(loop_backing_device(name),seen+(dev,))
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
    def reference(info):
        # st_dev retains the backing filesystem even after lazy unmount; using
        # path ownership here would miss deleted/detached mounts.
        dev=info.st_rdev if stat.S_ISBLK(info.st_mode) else info.st_dev
        if os.major(dev):
            return disks(f'{os.major(dev)}:{os.minor(dev)}')
        return set() # tmpfs, procfs and other anonymous pseudo-filesystems
    # Mounts can be hidden in private namespaces. Open files, cwd/root/exe and
    # mappings can retain a detached filesystem after its last mount disappears.
    # Permission errors and unresolved block dependencies deliberately propagate.
    for process in Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try:
            for m in mount_table(process/'mountinfo'):
                if not m['dev'].startswith('0:'): active |= disks(m['dev'])
            for fd in (process/'fd').iterdir():
                try:
                    info=fd.stat()
                except FileNotFoundError: pass # process/FD exited during read
                else: active |= reference(info)
            for name in ('cwd','root','exe'):
                try: info=(process/name).stat()
                except FileNotFoundError: pass # kernel thread, zombie or exited process
                else: active |= reference(info)
            for line in (process/'maps').read_text().splitlines():
                fields=line.split(None,5)
                major,minor=(int(part,16) for part in fields[3].split(':'))
                if major: active |= disks(f'{major}:{minor}')
        except FileNotFoundError:
            # Only a vanished process is safe to omit. A live process with an
            # incomplete namespace/maps/fd view cannot establish exclusivity.
            if process.exists(): raise ValueError('process_dependencies_unresolved')
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
