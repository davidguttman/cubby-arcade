#!/usr/bin/env python3
"""Maintainer release builder for the handheld; private signing key is never copied.

Writes one version's two signed manifests:
  update.json   platform.zip  read by devices on the guarded layout
  manifest.json app.zip       read by the old baseline coordinator, which only
                              accepts its short file list and the baseline runtime

A release that needs a new runtime writes only the platform pair, so devices
still on the old coordinator stay on the last release that can bridge them.

Usage: python -m rocknix.update_release --source . --output OUT --version 1.0.0
  --sequence 1 --archive-url https://our-host/releases/app.zip --key /private/key.pem
"""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import zipfile
from rocknix.updates import DEVICE_BUNDLE, DEVICE_REQUIRED, RUNTIME, app_path, validate_manifest

VERSION_FILE='runtime/version.json'
# Image-building and on-card material, none of it read by a running device.
NOT_PLATFORM=('rocknix/device/','rocknix/splash/','rocknix/patches/','rocknix/setup/','rocknix/runtime.json')
NOT_DEVICE={'release-key.pem'}


def source_files(source):
    for top in ['runtime','rocknix','hosting']:
        for p in sorted((source/top).rglob('*')):
            if p.is_symlink(): raise ValueError('Source contains symlink')
            if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc':
                yield p.relative_to(source).as_posix(),p


def device_entries(source):
    device=source/'rocknix/device'
    if not all((device/name).is_file() for name in DEVICE_REQUIRED): return []
    return [(DEVICE_BUNDLE+'/'+p.name,p) for p in sorted(device.iterdir())
            if p.is_file() and p.name not in NOT_DEVICE]


def app_entries(source):
    named=[]
    for name,p in source_files(source):
        try: app_path(name)
        except ValueError: continue
        named.append((name,p))
    return named+device_entries(source)


def platform_entries(source):
    named=[(n,p) for n,p in source_files(source) if not n.startswith(NOT_PLATFORM)
           and (not n.startswith('hosting/') or n=='hosting/catalog.yaml')]
    return named+device_entries(source)


def write_archive(archive,named,version):
    # The device only sees its app directory, so the version has to travel inside it.
    stamp=json.dumps({'version':version}).encode()
    entries=[(name,p.read_bytes(),0o755 if p.stat().st_mode&0o111 else 0o644) for name,p in named]
    entries.append((VERSION_FILE,stamp,0o644))
    files={}
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for name,body,mode in entries:
            info=zipfile.ZipInfo(name); info.create_system=3; info.external_attr=(stat.S_IFREG|mode)<<16
            info.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(info,body)
            files[name]={'sha256':hashlib.sha256(body).hexdigest(),'size':len(body),'mode':mode}
    return files


def archive_fields(archive,url,files):
    return {'url':url,'size':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
            'unpacked_size':sum(i['size'] for i in files.values())}


def sign(m,manifest,key):
    validate_manifest(m)
    raw=json.dumps(m,sort_keys=True,separators=(',',':')).encode()
    if len(raw)>1024**2: raise ValueError('Manifest exceeds device limit')
    manifest.write_bytes(raw)
    subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(key),'-in',str(manifest),
                    '-out',str(manifest.with_name(manifest.name+'.sig'))],check=True)
    return m


def runtime_spec(source):
    path=source/'rocknix/runtime.json'
    if not path.is_file(): return {'sha256':RUNTIME,'url':None,'size':0,'unpacked_size':0}
    return json.loads(path.read_text())


def build(source,output,version,sequence,url,key,trust=None,fallback=False):
    source,output,key=Path(source),Path(output),Path(key)
    if key.resolve().is_relative_to(source.resolve()):
        raise ValueError('Private signing key must be outside the source tree')
    output.mkdir(parents=True,exist_ok=True)
    if any((output/name).exists() for name in ['app.zip','manifest.json','manifest.json.sig','platform.zip','update.json','update.json.sig']):
        raise ValueError('Refusing to overwrite immutable release output')
    runtime=runtime_spec(source)
    common={'channel':'stable','sequence':sequence,'version':version,'architecture':'aarch64',
            'rocknix':'20261101','product':'cubby-rg353v'}
    legacy=None
    if runtime['sha256']==RUNTIME:
        archive=output/'app.zip'
        files=write_archive(archive,app_entries(source),version)
        legacy=sign({**common,'schema':1,'kind':'app','runtime_sha256':RUNTIME,'supervisor_api':1,
                     'archive':archive_fields(archive,url,files),'files':files},output/'manifest.json',key)
    platform=None
    if device_entries(source):
        archive=output/'platform.zip'
        files=write_archive(archive,platform_entries(source),version)
        platform=sign({**common,'schema':2,'kind':'platform','supervisor_api':2,'runtime':runtime,'trust':trust,
                       'fallback':fallback,'archive':archive_fields(archive,url.rsplit('/',1)[0]+'/platform.zip',files),
                       'files':files},output/'update.json',key)
    if not legacy and not platform: raise ValueError('Nothing to release')
    return legacy or platform

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['source','output','version','archive-url','key']:p.add_argument('--'+name,required=True)
    p.add_argument('--sequence',type=int,required=True)
    a=p.parse_args(); build(a.source,a.output,a.version,a.sequence,a.archive_url,a.key)
