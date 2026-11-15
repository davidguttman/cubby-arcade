#!/usr/bin/python3
"""Stable per-unit identity, independent of releases and customer state."""
import json
import os
from pathlib import Path
import re
import secrets
import tempfile


def new_identity():
    suffix = secrets.token_hex(6)
    return {'serial': 'CB-' + suffix.upper(), 'hostname': 'cubby-' + suffix}


def validate_identity(value):
    if (not isinstance(value, dict) or set(value) != {'serial', 'hostname'}
            or not isinstance(value['serial'], str)
            or not re.fullmatch(r'CB-[0-9A-F]{12}', value['serial'])
            or value['hostname'] != 'cubby-' + value['serial'][3:].lower()):
        raise ValueError('Invalid device network identity')
    return value


def ensure_identity(record):
    """Generic public images personalize on first boot; bound images are audited."""
    record = Path(record)
    if record.is_symlink() or not record.is_file():
        raise ValueError('Missing regular device provenance record')
    value = json.loads(record.read_text())
    if not isinstance(value, dict):
        raise ValueError('Invalid device provenance record')
    if 'network_identity' in value:
        return validate_identity(value['network_identity'])
    if value.get('device_cid') is not None:
        raise ValueError('Bound device lacks audited network identity')
    network = new_identity()
    value['network_identity'] = network
    fd, name = tempfile.mkstemp(prefix='.device-', dir=record.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, record)
        directory = os.open(record.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return network


if __name__ == '__main__':
    print(ensure_identity('/storage/cubby/image-provenance/device.json')['hostname'])
