"""App-only signed updates. Copied outside replaceable apps as the baseline supervisor.

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
import urllib.parse
import urllib.request
import zipfile

RUNTIME = 'e1859403acf7593e5b2ad9b932092258302f415a093959de24fd402b7475ee92'
MAX_ARCHIVE = 128 * 1024**2
MAX_EXPANDED = 512 * 1024**2
RESERVE = 128 * 1024**2
FIELDS = {'schema','product','kind','channel','sequence','version','architecture','rocknix',
          'runtime_sha256','supervisor_api','archive','files'}
DIGEST = re.compile(r'[a-f0-9]{64}\Z')
RELEASE = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\Z')


def app_path(name):
    if not isinstance(name, str) or len(name)>240 or '\\' in name or any(ord(c)<32 for c in name):
        raise ValueError('Invalid app path')
    path = PurePosixPath(name)
    if path.is_absolute() or any(p in {'', '.', '..'} for p in name.split('/')):
        raise ValueError('Invalid app path')
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


def validate_manifest(m):
    if not isinstance(m, dict) or set(m) != FIELDS:
        raise ValueError('Invalid update manifest')
    expected = {'schema': 1, 'product':'cubby-rg353v', 'kind':'app', 'channel':'stable',
                'architecture':'aarch64', 'rocknix':'20261101', 'runtime_sha256':RUNTIME, 'supervisor_api':1}
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
        app_path(name)
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
    return m


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(json.dumps(value,sort_keys=True).encode()); f.flush(); os.fsync(f.fileno())
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


def fetch(url, maximum, exact=None):
    https(url)
    with urllib.request.build_opener(SecureRedirect()).open(url,timeout=45) as r:
        data = r.read(maximum+1)
    if len(data)>maximum or (exact is not None and len(data)!=exact):
        raise ValueError('Truncated or oversized download')
    return data


class Manager:
    def __init__(self,base='/storage/cubby',openssl=None):
        self.base=Path(base); self.dir=self.base/'updates'; self.dir.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock(); self.phase=None; self.error=None; self.ready=None
        self.restart=threading.Event(); self.openssl=openssl
        candidate=read_json(self.dir/'candidate.json')
        record=self.read_record()
        if candidate:
            validate_manifest(candidate)
            release=self.release_id(candidate)
            if (candidate['sequence']>record.get('sequence',0) and release not in record.get('rejected',[]) and
                    (self.base/'releases'/release).is_dir()):
                self.phase='staged'
        if self.phase is None and record.get('failure'): self.phase='rolled_back'
    def config(self):
        c=read_json(self.base/'updater/config.json')
        if set(c)!={'feed','public_key'} or c['public_key']!='release-key.pem':
            raise ValueError('Updates not configured')
        https(c['feed'])
        key=self.base/'updater/release-key.pem'
        if not key.is_file(): raise ValueError('Missing release key')
        text=key.read_text().strip()
        if not text.startswith('-----BEGIN PUBLIC KEY-----') or not text.endswith('-----END PUBLIC KEY-----'):
            raise ValueError('Invalid release key')
        try: der=base64.b64decode(''.join(text.splitlines()[1:-1]),validate=True)
        except ValueError: raise ValueError('Invalid release key') from None
        if len(der)!=44 or not der.startswith(bytes.fromhex('302a300506032b6570032100')):
            raise ValueError('Ed25519 release key required')
        return c
    def read_record(self): return read_json(self.dir/'record.json')
    def status(self):
        try: self.config(); configured=True
        except (ValueError,OSError,TypeError): configured=False
        return {'phase':self.phase or ('idle' if configured else 'unconfigured'),
                'error':self.error,'configured':configured,
                'version':read_json(self.dir/'candidate.json').get('version'),
                'sequence':self.read_record().get('sequence',0)}
    def verify(self, raw, signature, *, allow_installed=False):
        c=self.config()
        with tempfile.TemporaryDirectory(dir=self.dir) as t:
            d=Path(t); (d/'manifest').write_bytes(raw); (d/'signature').write_bytes(signature)
            if self.openssl:
                cmd=[*self.openssl,'pkeyutl','-verify','-pubin','-rawin','-inkey',str(self.base/'updater'/c['public_key']),'-in',str(d/'manifest'),'-sigfile',str(d/'signature')]
            else:
                root=(self.base/'current/rootfs').resolve(strict=True)
                # Verification runs inside the known runtime, not the candidate.
                temporary=root/'run/cubby-signature'
                temporary.mkdir(parents=True,exist_ok=True)
                for source,target in [(d/'manifest','manifest'),(d/'signature','signature'),(self.base/'updater'/c['public_key'],'key')]:
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
        installed=(allow_installed and m['sequence']==sequence and
                   (self.base/'current').resolve().name==self.release_id(m))
        if m['sequence']<=sequence and not installed: raise ValueError('Replayed update')
        if self.release_id(m) in self.read_record().get('rejected',[]): raise ValueError('Previously rejected update')
        return m
    @staticmethod
    def release_id(m): return 'app-'+str(m['sequence'])+'-'+m['archive']['sha256'][:16]
    def check(self):
        with self.lock:
            c=self.config()
            raw=fetch(c['feed'],1024**2); signature=fetch(c['feed']+'.sig',64,64)
            m=self.verify(raw,signature,allow_installed=True)
            if m['sequence']==self.read_record().get('sequence',0):
                self.phase='idle'; self.error=None; return self.status()
            # Keep the authenticated exact bytes, never rely on reserialization.
            atomic(self.dir/'candidate.json',m)
            (self.dir/'manifest.raw').write_bytes(raw); (self.dir/'manifest.sig').write_bytes(signature)
            self.phase='available'; self.error=None
            return self.status()
    def layout(self):
        current=(self.base/'current').resolve(strict=True)
        if current.parent != (self.base/'releases').resolve(): raise ValueError('Invalid current release')
        runtimes=self.base/'runtimes'; runtimes.mkdir(exist_ok=True)
        root=current/'rootfs'; shared=runtimes/RUNTIME
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
    def stage(self):
        with self.lock:
            m=self.verify((self.dir/'manifest.raw').read_bytes(),(self.dir/'manifest.sig').read_bytes())
            if m!=read_json(self.dir/'candidate.json'): raise ValueError('Candidate changed')
            a=m['archive']
            if shutil.disk_usage(self.base).free < a['size']+a['unpacked_size']+RESERVE:
                raise ValueError('Not enough free storage')
            self.phase='downloading'
            data=fetch(a['url'],MAX_ARCHIVE,a['size'])
            if hashlib.sha256(data).hexdigest()!=a['sha256']: raise ValueError('Archive checksum mismatch')
            self.layout()
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
                        name=app_path(info.filename)
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
                (stage/'rootfs').symlink_to('../../runtimes/'+RUNTIME)
                (stage/'device').symlink_to('../../updater/device')
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
            m=self.verify((self.dir/'manifest.raw').read_bytes(),(self.dir/'manifest.sig').read_bytes())
            target=self.base/'releases'/self.release_id(m)
            self.validate_release(target,m)
            self.validate_baseline_device()
            self.activate(target.name,m['sequence']); self.phase='trial'; self.restart.set()
            return {'restarting':True}
    def recover(self):
        with self.lock:
            p=read_json(self.dir/'pending.json')
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
        if device.is_symlink():
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
                    if uid!=0: raise ValueError('Root client required')
                raw=self.rfile.readline(2049)
                if len(raw)>2048:raise ValueError('Oversized request')
                result=manager.dispatch(json.loads(raw))
            except (OSError,ValueError,TypeError,KeyError): result={'error':'Update operation unavailable'}
            self.wfile.write(json.dumps(result).encode()+b'\n')
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists(): path.unlink()
    server=socketserver.ThreadingUnixStreamServer(str(path),Handler); path.chmod(0o600)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server


def server_alive():
    try:
        c=http.client.HTTPConnection('127.0.0.1',8080,timeout=1)
        try:
            c.request('GET','/health',headers={'Host':'127.0.0.1:8080'})
            return c.getresponse().status==200
        finally: c.close()
    except OSError: return False


# Covers compositor readiness (30s), HTTP startup (30s), confirmation (10s),
# and mount/helper scheduling slack. Trial state remains durable across reboot.
TRIAL_STARTUP_TIMEOUT = 120


def watch_trial(manager,process,timeout=TRIAL_STARTUP_TIMEOUT,stable=10,health=server_alive,interval=.5):
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


def supervisor(base):
    manager=Manager(base); manager.recover()
    server=serve(manager,'/run/cubby-updater/socket')
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
                continue
            try: code=process.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL); code=process.wait()
            if (manager.dir/'pending.json').exists(): manager.recover(); continue
            if code==0: break
            failures+=1; time.sleep(2)
    finally:
        terminate(process)
        server.shutdown(); server.server_close()
    os.execv('/usr/bin/start_es.sh',['/usr/bin/start_es.sh'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base',type=Path,default=Path('/storage/cubby'))
    parser.add_argument('command',choices=['supervise'])
    args=parser.parse_args()
    try: supervisor(args.base)
    except (OSError,ValueError,KeyError,TypeError):
        import sys
        print('Cubby supervisor failed; returning to ROCKNIX.',file=sys.stderr)
        os.execv('/usr/bin/start_es.sh',['/usr/bin/start_es.sh'])

if __name__=='__main__':main()
