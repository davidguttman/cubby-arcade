"""Pinned RG353V image identities and narrow device-tree compatibility change."""
import hashlib
import re
import struct
import uuid

DTB_SHA256 = '28231fca8be6365b7bda931d136395b4f0b7246084a59c029de102c4cd10863a'
WIFI_PROFILE = 'rg353v-sdio-hs25'


def media_identities():
    suffix = uuid.uuid4().hex[:8].upper()
    return {'boot_label': 'CB'+suffix, 'storage_label': 'CS'+suffix,
            'fat_serial': uuid.uuid4().hex[:8].upper(),
            'storage_uuid': str(uuid.uuid4()), 'disk_guid': str(uuid.uuid4()),
            'partition_guids': [str(uuid.uuid4()), str(uuid.uuid4())]}


def rewrite_boot_labels(config, identities):
    lines=[]
    count=0
    for line in config.splitlines(keepends=True):
        if re.match(r'^\s*APPEND\s',line,re.I):
            if len(re.findall(r'\bboot=LABEL=ROCKNIX\b',line)) != 1 or len(re.findall(r'\bdisk=LABEL=STORAGE\b',line)) != 1:
                raise ValueError('Unexpected upstream Extlinux boot/storage references')
            line=re.sub(r'\bboot=LABEL=ROCKNIX\b','boot=LABEL='+identities['boot_label'],line)
            line=re.sub(r'\bdisk=LABEL=STORAGE\b','disk=LABEL='+identities['storage_label'],line)
            count+=1
        lines.append(line)
    if not count:
        raise ValueError('Missing Extlinux APPEND line')
    return ''.join(lines)


def _fdt_records(blob):
    if len(blob)<40:
        raise ValueError('Truncated DTB')
    magic,total,off_struct,off_strings,_,version,_,_,size_strings,size_struct=struct.unpack_from('>10I',blob)
    if magic!=0xd00dfeed or version!=17 or total!=len(blob) or not (40<=off_struct<off_strings<=total) or off_struct+size_struct>off_strings or off_strings+size_strings>total:
        raise ValueError('Unsupported DTB layout')
    strings=blob[off_strings:off_strings+size_strings]
    stack=[]; records=[]; pos=off_struct; end=pos+size_struct
    while pos<end:
        begin=pos
        token=struct.unpack_from('>I',blob,pos)[0]; pos+=4
        if token==1:
            stop=blob.find(b'\0',pos,end)
            if stop<0: raise ValueError('Invalid DT node')
            stack.append(blob[pos:stop].decode('ascii')); pos=(stop+4)&~3
        elif token==2:
            if not stack: raise ValueError('Unbalanced DT')
            stack.pop()
        elif token==3:
            if pos+8>end or not stack: raise ValueError('Invalid DT property')
            length,nameoff=struct.unpack_from('>II',blob,pos); pos+=8
            if nameoff>=size_strings or pos+length>end: raise ValueError('Invalid DT property bounds')
            stop=strings.find(b'\0',nameoff)
            if stop<0: raise ValueError('Invalid DT property name')
            name=strings[nameoff:stop].decode('ascii')
            value=blob[pos:pos+length]; pos=(pos+length+3)&~3
            records.append((('/'+'/'.join(stack[1:]),name),value,begin,pos))
        elif token==4: pass
        elif token==9:
            if stack: raise ValueError('Unbalanced DT end')
            return records
        else: raise ValueError('Invalid DT token')
    raise ValueError('Missing DT end')


def fdt_properties(blob):
    records=_fdt_records(blob)
    result={key:value for key,value,_,_ in records}
    if len(result)!=len(records): raise ValueError('Duplicate DT property')
    return result


def rg353v_wifi_profile(original):
    if hashlib.sha256(original).hexdigest()!=DTB_SHA256:
        raise ValueError('Unexpected pinned RG353V DTB checksum')
    before=fdt_properties(original)
    if before.get(('/','model'))!=b'Anbernic RG353V\0' or before.get(('/mmc@fe000000','sd-uhs-sdr50'))!=b'' or before.get(('/mmc@fe000000','max-frequency'))!=struct.pack('>I',150000000):
        raise ValueError('Unexpected RG353V Wi-Fi timing profile')
    records=_fdt_records(original)
    patched=bytearray(original)
    for key,_,begin,end in reversed(records):
        if key==('/mmc@fe000000','max-frequency'):
            patched[begin+12:begin+16]=struct.pack('>I',25000000)
        elif key==('/mmc@fe000000','sd-uhs-sdr50'):
            # NOP tokens retain the binary layout, reserve map and string table.
            patched[begin:end]=struct.pack('>I',4)*((end-begin)//4)
    after=fdt_properties(patched)
    changed={key for key in before.keys()|after.keys() if before.get(key)!=after.get(key)}
    if changed!={('/mmc@fe000000','max-frequency'),('/mmc@fe000000','sd-uhs-sdr50')}:
        raise ValueError('Unexpected DT structural changes')
    return bytes(patched)
