#!/usr/bin/env python3
"""Maintainer app-only release builder; private signing key is never copied.

Usage: python -m rocknix.update_release --source . --output OUT --version 1.0.0
  --sequence 1 --archive-url https://our-host/releases/1.zip --key /private/key.pem
"""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import zipfile
from rocknix.updates import app_path, validate_manifest, RUNTIME

VERSION_FILE='runtime/version.json'


def build(source,output,version,sequence,url,key):
    source,output,key=Path(source),Path(output),Path(key)
    if key.resolve().is_relative_to(source.resolve()):
        raise ValueError('Private signing key must be outside the source tree')
    output.mkdir(parents=True,exist_ok=True)
    archive=output/'app.zip'
    if any((output/name).exists() for name in ['app.zip','manifest.json','manifest.json.sig']):
        raise ValueError('Refusing to overwrite immutable release output')
    files={}
    paths=[]
    for top in ['runtime','rocknix','hosting']:
        for p in sorted((source/top).rglob('*')):
            if p.is_symlink(): raise ValueError('Source contains symlink')
            if not p.is_file() or '__pycache__' in p.parts:continue
            name=p.relative_to(source).as_posix()
            try:app_path(name)
            except ValueError:continue
            paths.append((name,p))
    # The device only sees its app directory, so the version has to travel inside it.
    stamp=json.dumps({'version':version}).encode()
    entries=[(name,p.read_bytes(),0o755 if p.stat().st_mode&0o111 else 0o644) for name,p in paths]
    entries.append((VERSION_FILE,stamp,0o644))
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for name,body,mode in entries:
            info=zipfile.ZipInfo(name); info.create_system=3; info.external_attr=(stat.S_IFREG|mode)<<16
            info.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(info,body)
            files[name]={'sha256':hashlib.sha256(body).hexdigest(),'size':len(body),'mode':mode}
    m={'schema':1,'product':'cubby-rg353v','kind':'app','channel':'stable','sequence':sequence,
       'version':version,'architecture':'aarch64','rocknix':'20261101','runtime_sha256':RUNTIME,
       'supervisor_api':1,'archive':{'url':url,'size':archive.stat().st_size,
       'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'unpacked_size':sum(i['size'] for i in files.values())},'files':files}
    validate_manifest(m)
    raw=json.dumps(m,sort_keys=True,separators=(',',':')).encode()
    if len(raw)>1024**2: raise ValueError('Manifest exceeds device limit')
    manifest=output/'manifest.json'; manifest.write_bytes(raw)
    subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(key),'-in',str(manifest),'-out',str(output/'manifest.json.sig')],check=True)
    return m

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['source','output','version','archive-url','key']:p.add_argument('--'+name,required=True)
    p.add_argument('--sequence',type=int,required=True)
    a=p.parse_args(); build(a.source,a.output,a.version,a.sequence,a.archive_url,a.key)
