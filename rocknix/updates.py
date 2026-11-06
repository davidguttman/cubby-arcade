"""Signed updates for everything Cubby owns under /storage/cubby.

A release directory is the unit of update: its app, Cog, coordinator (this file,
inside the app), device files, runtime link and trust all switch together when
`current` flips, and all switch back on rollback. See docs/rg353v-updates.md.

Only explicit configuration enables production updates; no test key or unsigned
fallback is shipped. This module is stdlib-only on the ROCKNIX host.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import signal
import socket
import socketserver
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

RUNTIME = 'e1859403acf7593e5b2ad9b932092258302f415a093959de24fd402b7475ee92'
MAX_ARCHIVE = 128 * 1024**2
MAX_EXPANDED = 512 * 1024**2
RESERVE = 128 * 1024**2
# A runtime is a whole browser stack, so it has its own bounds and never sits in memory.
MAX_RUNTIME_ARCHIVE = 2 * 1024**3
MAX_RUNTIME_EXPANDED = 6 * 1024**3
RUNTIME_RESERVE = 512 * 1024**2
RUNTIME_TIMEOUT = 3600
DEVICE_BUNDLE = 'runtime/native/rg353v/device'
DEVICE_REQUIRED = ('chroot-run.sh', 'launch.sh', 'guard.py', 'bwrap-dma-heap.py')
BRIDGED_SUFFIX = '-p2'
SOCKET = os.environ.get('CUBBY_UPDATER_SOCKET', '/run/cubby-updater/socket')
STOCK = os.environ.get('CUBBY_STOCK', '/usr/bin/start_es.sh')
HEALTH_PORT = int(os.environ.get('CUBBY_HEALTH_PORT', 8080))
RESTART = 75  # Tells the boot guard to start whatever `current` now is.
CLIENT_UID = int(os.environ.get('CUBBY_UPDATER_UID', 0))
FIELDS = {'schema','product','kind','channel','sequence','version','architecture','rocknix',
          'runtime_sha256','supervisor_api','archive','files'}
DIGEST = re.compile(r'[a-f0-9]{64}\Z')
RELEASE = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\Z')
PLATFORM_FIELDS = {'schema','product','kind','channel','sequence','version','architecture','rocknix',
                   'supervisor_api','archive','files','runtime','trust','fallback'}
# Installed at updater/coordinator.py, which every older launch.sh already runs.
# It is deliberately tiny: it only has to reach the guard, or the retained baseline.
TRAMPOLINE = b"""#!/usr/bin/python3
# Cubby boot entry. Written by rocknix/updates.py; see docs/rg353v-updates.md.
import os, signal, subprocess, sys
from pathlib import Path
updater = Path(__file__).resolve().parent
boot = updater.parent / 'boot'
env = dict(os.environ, CUBBY_BASE=str(updater.parent))
for name in ('guard.py', 'guard.previous.py'):
    if (boot / name).is_file():
        try:
            guard = subprocess.Popen([sys.executable, '-I', str(boot / name)], env=env)
        except OSError:
            continue
        stopping = []
        signal.signal(signal.SIGTERM, lambda signum, frame: (stopping.append(True), guard.terminate()))
        code = guard.wait()
        # Zero: the session ended on purpose, or this was a probe. Anything else: it could not do its job.
        if code == 0 or stopping:
            sys.exit(code)
if os.environ.get('CUBBY_ENTRY_PROBE'):
    sys.exit(1)
baseline = updater / 'coordinator.baseline.py'
os.execv(sys.executable, [sys.executable, '-I', str(baseline), '--base', str(updater.parent), *sys.argv[1:]])
"""


def safe_relative(name):
    if not isinstance(name, str) or len(name)>240 or '\\' in name or any(ord(c)<32 for c in name):
        raise ValueError('Invalid app path')
    path = PurePosixPath(name)
    if path.is_absolute() or any(p in {'', '.', '..'} for p in name.split('/')):
        raise ValueError('Invalid app path')
    return name


def platform_path(name):
    safe_relative(name)
    if not name.startswith(('runtime/','rocknix/','hosting/')):
        raise ValueError('Not a platform asset')
    return name


def app_path(name):
    safe_relative(name)
    if not (name.startswith('runtime/') or name.startswith('rocknix/adult/') or
            name in {'hosting/catalog.yaml', 'rocknix/server.py', 'rocknix/session.sh',
                     'rocknix/cog.ini', 'rocknix/bridge.js', 'rocknix/gamepad.js', 'rocknix/network.py', 'rocknix/updates.py'}):
        raise ValueError('Not an app asset')
    return name


def https(url):
    if not isinstance(url,str) or len(url)>4096: raise ValueError('Invalid URL')
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or not p.hostname or p.username or p.password or p.fragment:
        raise ValueError('HTTPS URL required')
    return url


def public_key_der(text):
    """The whole check for a usable release key, shared by configured and delivered keys."""
    text=text.strip()
    if not text.startswith('-----BEGIN PUBLIC KEY-----') or not text.endswith('-----END PUBLIC KEY-----'):
        raise ValueError('Invalid release key')
    try: der=base64.b64decode(''.join(text.splitlines()[1:-1]),validate=True)
    except ValueError: raise ValueError('Invalid release key') from None
    if len(der)!=44 or not der.startswith(bytes.fromhex('302a300506032b6570032100')):
        raise ValueError('Ed25519 release key required')
    return der


def validate_runtime(r):
    if not isinstance(r,dict) or set(r)!={'sha256','url','size','unpacked_size'}:
        raise ValueError('Invalid runtime')
    if not isinstance(r['sha256'],str) or not DIGEST.fullmatch(r['sha256']):
        raise ValueError('Invalid runtime digest')
    # The baseline is on every device and is never removed, so it needs no download.
    if r['sha256']==RUNTIME and r['url'] is None and r['size']==0 and r['unpacked_size']==0: return
    https(r['url'])
    for k,maximum in [('size',MAX_RUNTIME_ARCHIVE),('unpacked_size',MAX_RUNTIME_EXPANDED)]:
        if type(r[k]) is not int or not 0 < r[k] <= maximum:
            raise ValueError('Invalid runtime bounds')


def validate_trust(t):
    if t is None: return
    if not isinstance(t,dict) or set(t)!={'feed','public_key'} or not isinstance(t['public_key'],str):
        raise ValueError('Invalid trust')
    https(t['feed']); public_key_der(t['public_key'])


def validate_manifest(m):
    if isinstance(m,dict) and m.get('schema')==2:
        if set(m) != PLATFORM_FIELDS: raise ValueError('Invalid update manifest')
        expected = {'schema': 2, 'product':'cubby-rg353v', 'kind':'platform', 'channel':'stable',
                    'architecture':'aarch64', 'rocknix':'20261101', 'supervisor_api':2}
        allowed = platform_path
        validate_runtime(m['runtime']); validate_trust(m['trust'])
        if type(m['fallback']) is not bool: raise ValueError('Invalid fallback')
    else:
        if not isinstance(m, dict) or set(m) != FIELDS:
            raise ValueError('Invalid update manifest')
        expected = {'schema': 1, 'product':'cubby-rg353v', 'kind':'app', 'channel':'stable',
                    'architecture':'aarch64', 'rocknix':'20261101', 'runtime_sha256':RUNTIME, 'supervisor_api':1}
        allowed = app_path
    if any(type(m[k]) is not type(v) or m[k] != v for k,v in expected.items()):
        raise ValueError('Incompatible update')
    if type(m['sequence']) is not int or not 0 < m['sequence'] < 2**53:
        raise ValueError('Invalid release sequence')
    if not isinstance(m['version'], str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?', m['version']):
        raise ValueError('Invalid version')
    a = m['archive']
    if not isinstance(a,dict) or set(a) != {'url','size','sha256','unpacked_size'}:
        raise ValueError('Invalid archive')
    https(a['url'])
    if not isinstance(a['sha256'],str) or not DIGEST.fullmatch(a['sha256']):
        raise ValueError('Invalid digest')
    for k,maximum in [('size',MAX_ARCHIVE),('unpacked_size',MAX_EXPANDED)]:
        if type(a[k]) is not int or not 0 < a[k] <= maximum:
            raise ValueError('Invalid archive bounds')
    if not isinstance(m['files'],dict) or not 1 <= len(m['files']) <= 20000:
        raise ValueError('Invalid file inventory')
    for name,info in m['files'].items():
        allowed(name)
        if not isinstance(info,dict) or set(info) != {'sha256','size','mode'}:
            raise ValueError('Invalid file inventory')
        if (type(info['mode']) is not int or info['mode'] not in {0o644,0o755} or
            type(info['size']) is not int or not 0 <= info['size'] <= MAX_EXPANDED or
            not isinstance(info['sha256'],str) or not DIGEST.fullmatch(info['sha256'])):
            raise ValueError('Invalid file properties')
    if sum(i['size'] for i in m['files'].values()) != a['unpacked_size']:
        raise ValueError('Invalid expanded size')
    if not {'runtime/index.html','rocknix/server.py','rocknix/session.sh'} <= m['files'].keys():
        raise ValueError('Incomplete app')
    if m['schema']==2 and not {DEVICE_BUNDLE+'/'+name for name in DEVICE_REQUIRED} <= m['files'].keys():
        raise ValueError('Incomplete device files')
    return m


def member_path(m,name):
    return platform_path(name) if m['schema']==2 else app_path(name)


def platform_feed(feed):
    """The signed platform manifest sits beside the legacy one that older coordinators read."""
    return https(feed).rsplit('/',1)[0]+'/update.json'


def atomic(path, value):
    atomic_bytes(path, json.dumps(value,sort_keys=True).encode())


def atomic_bytes(path, data, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        if mode is not None: os.chmod(name,mode)
        os.replace(name,path)
        syncdir(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def syncdir(path):
    fd = os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def link(base, name, target):
    temporary = base / ('.'+name+'-'+secrets.token_hex(8))
    try:
        temporary.symlink_to(target)
        os.replace(temporary,base/name)
        syncdir(base)
    finally: temporary.unlink(missing_ok=True)


def read_json(path, default=None):
    try: return json.loads(path.read_bytes())
    except FileNotFoundError: return {} if default is None else default


class SecureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        https(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def open_url(url):
    return urllib.request.build_opener(SecureRedirect()).open(url,timeout=45)


def fetch(url, maximum, exact=None):
    https(url)
    with open_url(url) as r:
        data = r.read(maximum+1)
    if len(data)>maximum or (exact is not None and len(data)!=exact):
        raise ValueError('Truncated or oversized download')
    return data


def fetch_file(url, path, size, sha256, chunk=1024**2):
    """Stream a large payload to disk; its bytes never collect in memory."""
    https(url)
    digest=hashlib.sha256(); total=0
    with open_url(url) as r, Path(path).open('xb') as f:
        while True:
            block=r.read(chunk)
            if not block: break
            total+=len(block)
            if total>size: raise ValueError('Oversized download')
            digest.update(block); f.write(block)
        f.flush(); os.fsync(f.fileno())
    if total!=size or digest.hexdigest()!=sha256:
        raise ValueError('Runtime checksum mismatch')


RUNTIME_PROBE = r"""set -euo pipefail
ROOT=$1
mount --rbind /dev "$ROOT/dev"
mount --make-rslave "$ROOT/dev"
mount -t proc proc "$ROOT/proc"
chroot "$ROOT" /usr/bin/python3 --version
chroot "$ROOT" /usr/bin/openssl version
chroot "$ROOT" /usr/bin/cog --version
"""


def probe_runtime(root):
    """Private mounts, so a failed probe leaves nothing behind or changes the active release."""
    subprocess.run(['unshare','--mount','--propagation','private','bash','-s','--',str(root)],input=RUNTIME_PROBE,
                   text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120,check=True)


class Manager:
    def __init__(self,base='/storage/cubby',openssl=None,probe=probe_runtime):
        self.base=Path(base); self.dir=self.base/'updates'; self.dir.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock(); self.phase=None; self.error=None; self.ready=None
        self.restart=threading.Event(); self.openssl=openssl; self.probe=probe
        # Own names: a rollback to the baseline coordinator must never read a schema it refuses.
        candidate=read_json(self.dir/'platform-candidate.json')
        record=self.read_record()
        if candidate:
            # After a rollback this may be a schema only a newer coordinator understands.
            # Forget it rather than refuse to start: a later check finds whatever is current.
            try:
                validate_manifest(candidate)
                release=self.release_id(candidate)
                if (candidate['sequence']>record.get('sequence',0) and release not in record.get('rejected',[]) and
                        (self.base/'releases'/release).is_dir()):
                    self.phase='staged'
            except (ValueError,TypeError,KeyError):
                (self.dir/'platform-candidate.json').unlink(missing_ok=True)
        if self.phase is None and record.get('failure'): self.phase='rolled_back'
    def trust_dir(self):
        """Trust travels with the running release, so rollback restores it too."""
        own=self.base/'current/trust'
        return own if own.is_dir() else self.base/'updater'
    def config(self):
        trust=self.trust_dir()
        c=read_json(trust/'config.json')
        if set(c)!={'feed','public_key'} or c['public_key']!='release-key.pem':
            raise ValueError('Updates not configured')
        https(c['feed'])
        key=trust/'release-key.pem'
        if not key.is_file(): raise ValueError('Missing release key')
        public_key_der(key.read_text())
        return c
    def read_record(self): return read_json(self.dir/'record.json')
    def status(self):
        try: self.config(); configured=True
        except (ValueError,OSError,TypeError): configured=False
        return {'phase':self.phase or ('idle' if configured else 'unconfigured'),
                'error':self.error,'configured':configured,
                'version':read_json(self.dir/'platform-candidate.json').get('version'),
                'installed':self.read_record().get('version'),
                'sequence':self.read_record().get('sequence',0)}
    def verify(self, raw, signature, *, allow_installed=False):
        c=self.config()
        with tempfile.TemporaryDirectory(dir=self.dir) as t:
            d=Path(t); (d/'manifest').write_bytes(raw); (d/'signature').write_bytes(signature)
            if self.openssl:
                cmd=[*self.openssl,'pkeyutl','-verify','-pubin','-rawin','-inkey',str(self.trust_dir()/c['public_key']),'-in',str(d/'manifest'),'-sigfile',str(d/'signature')]
            else:
                root=(self.base/'current/rootfs').resolve(strict=True)
                # Verification runs inside the known runtime, not the candidate.
                temporary=root/'run/cubby-signature'
                temporary.mkdir(parents=True,exist_ok=True)
                for source,target in [(d/'manifest','manifest'),(d/'signature','signature'),(self.trust_dir()/c['public_key'],'key')]:
                    shutil.copyfile(source,temporary/target)
                cmd=['chroot',str(root),'/usr/bin/openssl','pkeyutl','-verify','-pubin','-rawin','-inkey','/run/cubby-signature/key','-in','/run/cubby-signature/manifest','-sigfile','/run/cubby-signature/signature']
            result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
            if result.returncode: raise ValueError('Update signature rejected')
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result: raise ValueError('Duplicate manifest key')
                result[key]=value
            return result
        try: m=json.loads(raw,object_pairs_hook=unique)
        except (ValueError,UnicodeError): raise ValueError('Invalid manifest') from None
        validate_manifest(m)
        sequence=self.read_record().get('sequence',0)
        # A bridged release and the same version's platform manifest name different archives.
        installed=(allow_installed and m['sequence']==sequence and
                   read_json(self.base/'current/release.json').get('sequence')==sequence)
        if m['sequence']<=sequence and not installed: raise ValueError('Replayed update')
        if self.release_id(m) in self.read_record().get('rejected',[]): raise ValueError('Previously rejected update')
        return m
    @staticmethod
    def release_id(m): return 'app-'+str(m['sequence'])+'-'+m['archive']['sha256'][:16]
    def check(self):
        with self.lock:
            c=self.config()
            raw,signature=self.fetch_feed(c)
            m=self.verify(raw,signature,allow_installed=True)
            if m['sequence']==self.read_record().get('sequence',0):
                self.phase='idle'; self.error=None; return self.status()
            # Keep the authenticated exact bytes, never rely on reserialization.
            atomic(self.dir/'platform-candidate.json',m)
            (self.dir/'platform-manifest.raw').write_bytes(raw); (self.dir/'platform-manifest.sig').write_bytes(signature)
            self.phase='available'; self.error=None
            return self.status()
    @staticmethod
    def fetch_feed(c):
        url=platform_feed(c['feed'])
        try: return fetch(url,1024**2),fetch(url+'.sig',64,64)
        except urllib.error.HTTPError as error:
            if error.code!=404: raise
        # Signature and sequence checks still apply; this only covers a feed with no platform manifest yet.
        return fetch(c['feed'],1024**2),fetch(c['feed']+'.sig',64,64)
    def layout(self):
        current=(self.base/'current').resolve(strict=True)
        if current.parent != (self.base/'releases').resolve(): raise ValueError('Invalid current release')
        runtimes=self.base/'runtimes'; runtimes.mkdir(exist_ok=True)
        root=current/'rootfs'; shared=runtimes/RUNTIME
        if root.is_symlink() and root.resolve().parent==runtimes.resolve() and root.resolve().is_dir():
            if not (current/'trust').is_dir(): self.ensure_baseline_device()
            return
        if not root.exists() and shared.is_dir():
            root.symlink_to('../../runtimes/'+RUNTIME); syncdir(current)
        if not root.is_symlink():
            if shared.exists(): raise ValueError('Conflicting runtime')
            os.rename(root,shared); syncdir(current); syncdir(runtimes)
            root.symlink_to('../../runtimes/'+RUNTIME); syncdir(current)
        if root.resolve()!=shared.resolve() or not shared.is_dir(): raise ValueError('Incompatible runtime layout')
        self.ensure_baseline_device()

    @staticmethod
    def device_inventory(device):
        if device.is_symlink() or not device.is_dir():
            raise ValueError('Invalid baseline device directory')
        inventory={}
        for p in sorted(device.rglob('*')):
            name=p.relative_to(device).as_posix()
            if name=='.baseline-inventory.json': continue
            mode=p.lstat().st_mode
            if stat.S_ISDIR(mode):
                inventory[name]={'kind':'directory','mode':stat.S_IMODE(mode)}
            elif stat.S_ISREG(mode):
                inventory[name]={'kind':'file','mode':stat.S_IMODE(mode),
                                 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            else: raise ValueError('Unsafe baseline device entry')
        launcher=inventory.get('chroot-run.sh',{})
        if launcher.get('kind')!='file' or not launcher.get('mode',0)&0o111:
            raise ValueError('Incomplete baseline device launcher')
        return inventory

    def validate_baseline_device(self):
        device=self.base/'updater/device'
        try:
            expected=read_json(device/'.baseline-inventory.json')
            if not expected or self.device_inventory(device)!=expected:
                raise ValueError('Baseline device inventory mismatch')
        except (OSError,TypeError,json.JSONDecodeError) as error:
            raise ValueError('Incomplete baseline device copy') from error

    def ensure_baseline_device(self):
        device=self.base/'updater/device'
        try:
            self.validate_baseline_device()
            return
        except ValueError: pass
        # App releases reference the baseline, never supply its replacement.
        # Recover old interrupted copies only from retained real device trees.
        current=(self.base/'current').resolve(strict=True)
        if current.parent != (self.base/'releases').resolve():
            raise ValueError('Invalid current release')
        active=current/'device'
        try:
            inventory=self.device_inventory(active)
            source=active
        except ValueError:
            sources=[]
            for release in sorted((self.base/'releases').iterdir()):
                candidate=release/'device'
                if release.is_symlink() or candidate.is_symlink() or not candidate.is_dir(): continue
                sources.append((candidate,self.device_inventory(candidate)))
            if not sources or any(inv!=sources[0][1] for _,inv in sources):
                raise ValueError('Cannot safely recover baseline device copy')
            source,inventory=sources[0]
        device.parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.device-stage-',dir=device.parent) as name:
            staged=Path(name)/'device'
            shutil.copytree(source,staged)
            if self.device_inventory(staged)!=inventory:
                raise ValueError('Baseline device changed during copy')
            atomic(staged/'.baseline-inventory.json',inventory)
            for directory,_,files in os.walk(staged,topdown=False):
                for filename in files:
                    with (Path(directory)/filename).open('rb') as f: os.fsync(f.fileno())
                syncdir(Path(directory))
            if device.exists() or device.is_symlink():
                # Keep unknown/legacy partial content for inspection, not deletion.
                quarantine=device.parent/('.device-incomplete-'+secrets.token_hex(16))
                os.rename(device,quarantine); syncdir(device.parent)
            os.rename(staged,device); syncdir(device.parent)
        self.validate_baseline_device()
    def install_runtime(self,r):
        """Download, verify, unpack and prove a runtime before anything can point at it."""
        runtimes=self.base/'runtimes'; final=runtimes/r['sha256']
        if final.is_dir(): return
        if r['url'] is None: raise ValueError('Baseline runtime missing')
        runtimes.mkdir(exist_ok=True)
        for stale in runtimes.glob('.runtime-*'):
            if stale.is_dir(): shutil.rmtree(stale)
            else: stale.unlink()
        download=runtimes/('.runtime-'+r['sha256']+'.tar.xz')
        stage=Path(tempfile.mkdtemp(prefix='.runtime-',dir=runtimes))
        try:
            fetch_file(r['url'],download,r['size'],r['sha256'])
            # Unpacking takes minutes on this CPU and may overlap someone playing.
            polite=['nice','-n','19'] if shutil.which('nice') else []
            subprocess.run([*polite,'tar','--numeric-owner','-xJf',str(download),'-C',str(stage)],check=True,
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=RUNTIME_TIMEOUT)
            self.probe(stage)
            for directory,_,files in os.walk(stage,topdown=False):
                for name in files:
                    p=Path(directory)/name
                    if p.is_file() and not p.is_symlink():
                        with p.open('rb') as f: os.fsync(f.fileno())
                syncdir(directory)
            os.rename(stage,final); syncdir(runtimes)
        finally:
            download.unlink(missing_ok=True)
            if stage.exists(): shutil.rmtree(stage)
    def stage_links(self,stage,m,trust=None):
        """The parts of a release that are not app files."""
        runtime=m['runtime']['sha256'] if m['schema']==2 else RUNTIME
        (stage/'rootfs').symlink_to('../../runtimes/'+runtime)
        bundled=(stage/'app'/DEVICE_BUNDLE/'chroot-run.sh').is_file()
        if bundled:
            for name in DEVICE_REQUIRED:
                device=stage/'app'/DEVICE_BUNDLE/name
                if not device.is_file() or not os.access(device,os.X_OK): raise ValueError('Incomplete device files')
            for name in ('chroot-run.sh','launch.sh'):
                subprocess.run(['bash','-n',str(stage/'app'/DEVICE_BUNDLE/name)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
            try:
                compile((stage/'app'/DEVICE_BUNDLE/'guard.py').read_bytes(),'guard.py','exec')
                compile((stage/'app/rocknix/updates.py').read_bytes(),'updates.py','exec')
            except SyntaxError: raise ValueError('Invalid device files') from None
        (stage/'device').symlink_to('app/'+DEVICE_BUNDLE if bundled else '../../updater/device')
        if bundled: self.stage_links_trust(stage,trust)
    def stage_links_trust(self,stage,trust=None):
        directory=stage/'trust'; directory.mkdir()
        if trust:
            key=trust['public_key'].strip().encode()+b'\n'; feed=trust['feed']
        else:
            source=self.trust_dir(); config=read_json(source/'config.json')
            key=(source/'release-key.pem').read_bytes(); feed=config['feed']
        (directory/'release-key.pem').write_bytes(key)
        atomic(directory/'config.json',{'feed':feed,'public_key':'release-key.pem'})
    def stage(self):
        with self.lock:
            m=self.verify((self.dir/'platform-manifest.raw').read_bytes(),(self.dir/'platform-manifest.sig').read_bytes())
            if m!=read_json(self.dir/'platform-candidate.json'): raise ValueError('Candidate changed')
            a=m['archive']
            required=a['size']+a['unpacked_size']+RESERVE
            runtime=m['runtime'] if m['schema']==2 else None
            if runtime and not (self.base/'runtimes'/runtime['sha256']).is_dir():
                required+=runtime['size']+runtime['unpacked_size']+RUNTIME_RESERVE
            if shutil.disk_usage(self.base).free < required:
                raise ValueError('Not enough free storage')
            self.phase='downloading'
            data=fetch(a['url'],MAX_ARCHIVE,a['size'])
            if hashlib.sha256(data).hexdigest()!=a['sha256']: raise ValueError('Archive checksum mismatch')
            self.layout()
            if runtime: self.install_runtime(runtime)
            release=self.base/'releases'/self.release_id(m)
            if release.exists():
                self.validate_release(release,m)
                self.phase='staged'; return self.status()
            with tempfile.TemporaryDirectory(prefix='.stage-',dir=release.parent) as t:
                stage=Path(t); app=stage/'app'; app.mkdir()
                import io
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    infos=archive.infolist()
                    if len(infos)!=len(m['files']) or len({i.filename for i in infos})!=len(infos): raise ValueError('Unexpected or duplicate archive entry')
                    for info in infos:
                        name=member_path(m,info.filename)
                        expected=m['files'].get(name)
                        mode=info.external_attr>>16
                        if (expected is None or info.is_dir() or info.file_size!=expected['size'] or
                            stat.S_IFMT(mode) not in {0,stat.S_IFREG} or stat.S_IMODE(mode)!=expected['mode']):
                            raise ValueError('Archive entry mismatch')
                        body=archive.read(info)
                        if hashlib.sha256(body).hexdigest()!=expected['sha256']: raise ValueError('File checksum mismatch')
                        target=app/name; target.parent.mkdir(parents=True,exist_ok=True)
                        with target.open('xb') as f: f.write(body); f.flush(); os.fsync(f.fileno())
                        target.chmod(expected['mode'])
                self.stage_links(stage,m,m.get('trust'))
                atomic(stage/'release.json',m)
                for directory,_,_ in os.walk(app,topdown=False): syncdir(Path(directory))
                os.rename(stage,release); syncdir(release.parent)
            self.phase='staged'; return self.status()
    def validate_release(self,release,m):
        app=release/'app'
        found=set()
        for p in app.rglob('*'):
            if p.is_symlink(): raise ValueError('Symlink in staged app')
            if not p.is_file(): continue
            name=p.relative_to(app).as_posix(); found.add(name)
            spec=m['files'].get(name)
            if (spec is None or p.stat().st_size!=spec['size'] or
                stat.S_IMODE(p.stat().st_mode)!=spec['mode'] or
                hashlib.sha256(p.read_bytes()).hexdigest()!=spec['sha256']):
                raise ValueError('Staged app changed')
        if found!=set(m['files']): raise ValueError('Incomplete staged app')
        if read_json(release/'release.json')!=m: raise ValueError('Staged metadata changed')
        if (m['schema']==2 and not (release/'rootfs/usr/bin').is_dir()):
            raise ValueError('Staged runtime missing')

    def activate(self,release,sequence):
        if not RELEASE.fullmatch(release) or not (self.base/'releases'/release/'app').is_dir(): raise ValueError('Invalid release')
        old=os.readlink(self.base/'current')
        if not re.fullmatch(r'releases/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}',old): raise ValueError('Invalid previous release')
        token=secrets.token_hex(32)
        pending={'old':old,'new':'releases/'+release,'sequence':sequence,'token':token}
        atomic(self.dir/'pending.json',pending)
        link(self.base,'current',pending['new'])
        self.ready=None
        return token
    def apply(self):
        with self.lock:
            if self.phase!='staged': raise ValueError('No staged update')
            m=self.verify((self.dir/'platform-manifest.raw').read_bytes(),(self.dir/'platform-manifest.sig').read_bytes())
            target=self.base/'releases'/self.release_id(m)
            self.validate_release(target,m)
            if not (target/'trust').is_dir(): self.validate_baseline_device()
            self.activate(target.name,m['sequence']); self.phase='trial'; self.restart.set()
            return {'restarting':True}
    def recover(self,force=False):
        with self.lock:
            p=read_json(self.dir/'pending.json')
            # The guard started this trial on purpose; any other start means it was interrupted.
            if p and not force and os.environ.get('CUBBY_TRIAL_ACTIVE')==p.get('token'): return
            if not p:
                self.repair_runtime_migration()
                self.repair_baseline_device()
                return
            if not re.fullmatch(r'releases/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}',p['old']): raise ValueError('Invalid rollback')
            if not (self.base/p['old']/'app').is_dir(): raise ValueError('Missing rollback release')
            link(self.base,'current',p['old'])
            record=self.read_record(); record.setdefault('rejected',[]).append(p['new'].split('/')[-1])
            record['failure']='startup failed'; atomic(self.dir/'record.json',record)
            (self.dir/'pending.json').unlink(); syncdir(self.dir)
            self.phase='rolled_back'; self.ready=None
            self.repair_runtime_migration()
            self.repair_baseline_device()
    def repair_baseline_device(self):
        device=(self.base/'current/device')
        if device.is_symlink() and not (self.base/'current/trust').is_dir():
            if device.resolve()!=(self.base/'updater/device').resolve():
                raise ValueError('Invalid baseline device link')
            self.ensure_baseline_device()

    def repair_runtime_migration(self):
        """Finish only the rename/link crash window; never start a migration."""
        current=(self.base/'current').resolve(strict=True)
        if current.parent != (self.base/'releases').resolve(): raise ValueError('Invalid current release')
        root=current/'rootfs'; shared=self.base/'runtimes'/RUNTIME
        if not root.exists() and not root.is_symlink() and shared.is_dir():
            syncdir(shared.parent)
            root.symlink_to('../../runtimes/'+RUNTIME)
            syncdir(current)
    def confirm(self,token):
        with self.lock:
            p=read_json(self.dir/'pending.json')
            if not p or not secrets.compare_digest(token,p['token']): raise ValueError('Invalid trial token')
            link(self.base,'previous',p['old'])
            record=self.read_record(); record.pop('failure',None)
            record.update(sequence=p['sequence'],version=read_json(self.base/p['new']/'release.json').get('version'))
            atomic(self.dir/'record.json',record)
            (self.dir/'pending.json').unlink(); syncdir(self.dir)
            self.phase='idle'; self.ready=None
            try: self.after_confirm(p)
            # Housekeeping can never undo a release that has proved itself.
            except (OSError,ValueError,TypeError,KeyError,SyntaxError,subprocess.SubprocessError) as error:
                import sys
                print('Cubby post-update step failed:',error,file=sys.stderr)
    def after_confirm(self,p):
        release=self.base/p['new']
        if not (release/'trust').is_dir(): return
        self.install_boot(release)
        fallback=self.base/'fallback'
        if not fallback.exists(): link(self.base,'fallback',p['old'])
        if read_json(release/'release.json').get('fallback'): link(self.base,'fallback',p['new'])
        self.refresh_fallback_trust(release)
        self.collect_runtimes()
    def install_boot(self,release):
        """Put the guard and the boot entry in place. Both are checked before either replaces anything."""
        body=(release/'app'/DEVICE_BUNDLE/'guard.py').read_bytes()
        compile(body,'guard.py','exec'); compile(TRAMPOLINE,'coordinator.py','exec')
        boot=self.base/'boot'; boot.mkdir(exist_ok=True)
        guard=boot/'guard.py'; previous=boot/'guard.previous.py'
        if guard.is_file() and guard.read_bytes()!=body: atomic_bytes(previous,guard.read_bytes(),0o755)
        if not guard.is_file() or guard.read_bytes()!=body: atomic_bytes(guard,body,0o755)
        if not previous.is_file(): atomic_bytes(previous,body,0o755)
        updater=self.base/'updater'; updater.mkdir(exist_ok=True)
        entry=updater/'coordinator.py'; baseline=updater/'coordinator.baseline.py'
        if not baseline.is_file():
            source=entry if entry.is_file() else release/'app/rocknix/updates.py'
            atomic_bytes(baseline,source.read_bytes(),0o755)
        if not entry.is_file() or entry.read_bytes()!=TRAMPOLINE: atomic_bytes(entry,TRAMPOLINE,0o755)
    def refresh_fallback_trust(self,release):
        """After a key rotation is proved, the retained baseline must trust the same key."""
        updater=self.base/'updater'
        key=(release/'trust/release-key.pem').read_bytes(); config=read_json(release/'trust/config.json')
        if not (updater/'release-key.pem').is_file() or (updater/'release-key.pem').read_bytes()==key and read_json(updater/'config.json')==config: return
        atomic_bytes(updater/'release-key.pem',key,0o644); atomic(updater/'config.json',config)
    def collect_runtimes(self):
        """A runtime is about a gigabyte: keep only what a release could still start from."""
        keep={RUNTIME}
        names=[os.path.join(self.base,n) for n in ('current','previous','fallback')]
        pending=read_json(self.dir/'pending.json')
        names+=[os.path.join(self.base,pending[n]) for n in ('old','new') if n in pending]
        for name in names:
            target=Path(name,'rootfs').resolve()
            if target.parent==(self.base/'runtimes').resolve(): keep.add(target.name)
        candidate=read_json(self.dir/'platform-candidate.json')
        if candidate.get('schema')==2: keep.add(candidate['runtime']['sha256'])
        for entry in (self.base/'runtimes').iterdir():
            if DIGEST.fullmatch(entry.name) and entry.name not in keep and entry.is_dir(): shutil.rmtree(entry)
    def dispatch(self,request):
        if not isinstance(request,dict) or set(request)-{'action','token'}: raise ValueError('Invalid request')
        action=request.get('action')
        if action=='status' and set(request)=={'action'}: return self.status()
        if action=='ready' and set(request)=={'action','token'}:
            with self.lock:
                p=read_json(self.dir/'pending.json')
                if not p or not secrets.compare_digest(request['token'],p['token']): raise ValueError('Invalid trial token')
                self.ready=p['token']; return {'accepted':True}
        if set(request)!={'action'}: raise ValueError('Invalid request')
        if action=='apply': return self.apply()
        if action not in {'check','download'}: raise ValueError('Invalid action')
        if self.phase in {'checking','downloading','trial'}: raise ValueError('Updater busy')
        self.phase='checking' if action=='check' else 'downloading'
        def work():
            try: self.check() if action=='check' else self.stage()
            except (OSError,ValueError,TypeError,KeyError,RuntimeError,http.client.HTTPException,subprocess.SubprocessError,zipfile.BadZipFile):
                self.phase='error'; self.error='Update failed; current Cubby is unchanged.'
        threading.Thread(target=work,daemon=True).start()
        return {'accepted':True}


class Rejected(ValueError):
    """The coordinator explicitly rejected an operation before activation."""


class HostClient:
    def __init__(self,path='/run/cubby-updater/socket'): self.path=path
    def dispatch(self,request):
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(120); s.connect(str(self.path)); s.sendall(json.dumps(request).encode()+b'\n')
            data=b''
            while not data.endswith(b'\n') and len(data)<=65536:
                block=s.recv(8192)
                if not block:break
                data+=block
        result=json.loads(data)
        if result.get('error') is not None: raise Rejected(result['error'])
        return result


def serve(manager,path):
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(10)
            try:
                if hasattr(socket,'SO_PEERCRED'):
                    import struct
                    _,uid,_=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    if uid!=CLIENT_UID: raise ValueError('Root client required')
                raw=self.rfile.readline(2049)
                if len(raw)>2048:raise ValueError('Oversized request')
                result=manager.dispatch(json.loads(raw))
            except (OSError,ValueError,TypeError,KeyError): result={'error':'Update operation unavailable'}
            self.wfile.write(json.dumps(result).encode()+b'\n')
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists() or path.is_symlink(): path.unlink()
    server=socketserver.ThreadingUnixStreamServer(str(path),Handler); path.chmod(0o600)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server


def server_alive():
    try:
        c=http.client.HTTPConnection('127.0.0.1',HEALTH_PORT,timeout=1)
        try:
            c.request('GET','/health',headers={'Host':'127.0.0.1:%d'%HEALTH_PORT})
            return c.getresponse().status==200
        finally: c.close()
    except OSError: return False


# Covers compositor readiness (30s), HTTP startup (30s), confirmation (10s),
# and mount/helper scheduling slack. Trial state remains durable across reboot.
TRIAL_STARTUP_TIMEOUT = 120
TRIAL_STABLE = float(os.environ.get('CUBBY_TRIAL_STABLE', 10))


def watch_trial(manager,process,timeout=TRIAL_STARTUP_TIMEOUT,stable=TRIAL_STABLE,health=server_alive,interval=.5):
    """Neither a live HTTP server nor a readiness token alone proves health."""
    started=time.monotonic(); healthy_since=None
    while process.poll() is None:
        if manager.restart.wait(interval): return 'restart'
        p=read_json(manager.dir/'pending.json')
        if not p: continue
        if manager.ready==p['token'] and health():
            healthy_since=healthy_since or time.monotonic()
            if time.monotonic()-healthy_since>=stable: manager.confirm(p['token'])
        else: healthy_since=None
        if time.monotonic()-started>timeout:return 'timeout'
    return 'exit'


def bridge(base,release=None):
    """Carry an existing device onto the guarded layout, from a release its old coordinator installed.

    network.py calls this outside the chroot, only effective once that release has
    passed its own trial. Nothing changes until the next boot, and the old
    coordinator keeps working until then because `current` does not move here.
    """
    base=Path(base); manager=Manager(base)
    current=(base/'current').resolve(strict=True)
    if release is not None and Path(release).resolve()!=current: return 'other'
    if (manager.dir/'pending.json').exists(): return 'waiting'
    if (current/'trust').is_dir():
        manager.install_boot(current); return 'current'
    meta=read_json(current/'release.json')
    if not meta: return 'unsigned'
    if meta.get('sequence')!=manager.read_record().get('sequence'): return 'waiting'
    if not (current/'app'/DEVICE_BUNDLE/'chroot-run.sh').is_file(): return 'unsupported'
    twin=current.name+BRIDGED_SUFFIX
    if twin in manager.read_record().get('rejected',[]): return 'rejected'
    try: manager.config()
    except (ValueError,OSError,TypeError): return 'unconfigured'
    # Signed at install; make sure what is on disk is still what was signed.
    for name,spec in meta['files'].items():
        p=current/'app'/name
        if (not p.is_file() or stat.S_IMODE(p.stat().st_mode)!=spec['mode']
                or hashlib.sha256(p.read_bytes()).hexdigest()!=spec['sha256']):
            raise ValueError('Bridge release changed on disk')
    releases=base/'releases'; final=releases/twin
    if not final.exists():
        with tempfile.TemporaryDirectory(prefix='.stage-',dir=releases) as t:
            stage=Path(t)
            shutil.copytree(current/'app',stage/'app',ignore=shutil.ignore_patterns('__pycache__'))
            (stage/'rootfs').symlink_to(os.readlink(current/'rootfs'))
            (stage/'device').symlink_to('app/'+DEVICE_BUNDLE)
            manager.stage_links_trust(stage)
            atomic(stage/'release.json',meta)
            for directory,_,_ in os.walk(stage/'app',topdown=False): syncdir(directory)
            os.rename(stage,final); syncdir(releases)
    atomic(base/'boot/activate.json',{'old':'releases/'+current.name,'new':'releases/'+twin,
                                      'sequence':meta['sequence'],'token':secrets.token_hex(32)})
    if not (base/'fallback').exists(): link(base,'fallback','releases/'+current.name)
    # Last: from this write on, the next boot goes through the guard.
    manager.install_boot(current)
    return 'armed'


def supervisor(base):
    manager=Manager(base); manager.recover()
    guarded=os.environ.get('CUBBY_GUARD')=='1'
    if (manager.dir/'pending.json').exists(): manager.phase='trial'
    server=serve(manager,SOCKET)
    failures=0; process=None
    def terminate(child):
        if child is None or child.poll() is not None: return
        try: os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError: return
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
    def interrupted(signum,frame):
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,interrupted)
    signal.signal(signal.SIGINT,interrupted)
    try:
        while failures<3 and not (manager.base/'DISABLED').exists():
            release=(manager.base/'current').resolve(strict=True)
            env=os.environ.copy(); pending=read_json(manager.dir/'pending.json')
            env['CUBBY_UPDATE_TRIAL']=pending.get('token','')
            process=subprocess.Popen([str(release/'device/chroot-run.sh'),str(release)],env=env,start_new_session=True)
            outcome=watch_trial(manager,process)
            if outcome=='timeout': terminate(process)
            if manager.restart.is_set():
                manager.restart.clear()
                terminate(process)
                if guarded: return RESTART
                continue
            try: code=process.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL); code=process.wait()
            if (manager.dir/'pending.json').exists():
                manager.recover(force=True)
                if guarded: return RESTART
                continue
            if code==0: break
            failures+=1; time.sleep(2)
    finally:
        terminate(process)
        server.shutdown(); server.server_close()
    if guarded: return 1 if failures>=3 else 0
    os.execv(STOCK,[STOCK])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base',type=Path,default=Path('/storage/cubby'))
    parser.add_argument('command',choices=['supervise'])
    args=parser.parse_args()
    import sys
    try: code=supervisor(args.base)
    except (OSError,ValueError,KeyError,TypeError):
        print('Cubby supervisor failed; returning to ROCKNIX.',file=sys.stderr)
        if os.environ.get('CUBBY_GUARD')=='1': sys.exit(1)
        os.execv(STOCK,[STOCK])
    sys.exit(code)

if __name__=='__main__':main()
