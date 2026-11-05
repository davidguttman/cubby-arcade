"""Fetch apt's exact resolved archives with bounded, checksum-verified fallback.

Called only after apt has authenticated the pinned package indexes. Never
refreshes metadata or changes package selection; mirror bytes must match those
indexes. The subsequent installer is explicitly forbidden from downloading.
"""
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

SNAPSHOT = '20261027T000000Z'
MAX_PACKAGE = 256 * 1024 * 1024
MAX_PACKAGES = 600


@dataclass(frozen=True)
class Archive:
    url: str
    name: str
    size: int
    sha256: str


def urls(url):
    parsed = urlsplit(url)
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('Unexpected package URL components')
    path = unquote(parsed.path)
    if parsed.port or parsed.scheme not in ('http', 'https'):
        raise ValueError('Unexpected archive scheme or port')
    if any(part in ('.', '..', '') for part in path.split('/')[1:]):
        raise ValueError('Unsafe archive path')
    if re.search(r'[^A-Za-z0-9/_.+~:=@-]', path):
        raise ValueError('Unexpected archive path characters')
    if parsed.hostname == 'snapshot.debian.org':
        match = re.fullmatch(r'/archive/(debian|debian-security)/'+SNAPSHOT+r'/(pool/.+\.deb)', path)
        if not match:
            raise ValueError('Package is outside the pinned snapshot')
        archive, relative = match.groups()
        return [url, 'https://deb.debian.org/'+archive+'/'+relative]
    if parsed.hostname == 'deb.debian.org' and parsed.scheme == 'https':
        if re.fullmatch(r'/(debian|debian-security)/pool/.+\.deb', path):
            return [url]
    raise ValueError('Unapproved package host')


def _stanzas(text):
    for block in text.strip().split('\n\n'):
        fields = {}
        for line in block.splitlines():
            if line and not line[0].isspace() and ': ' in line:
                key, value = line.split(': ', 1)
                fields[key] = value
        yield fields


def plan(packages, runner=subprocess.run):
    if not packages or len(packages) > MAX_PACKAGES or any(
            not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?(?:=[A-Za-z0-9.+:~_-]+)?', name)
            for name in packages):
        raise ValueError('Invalid package selection')
    # apt omits cached archives from --print-uris. Resolve against an empty
    # cache so every archive, including previously downloaded files, receives
    # our size/SHA256 verification before --no-download installation.
    with tempfile.TemporaryDirectory(prefix='cubby-apt-plan-') as empty:
        printed = runner(['apt-get', '-o', 'Dir::Cache::archives='+empty,
                          '--yes', '--no-install-recommends', '--print-uris', 'install', *packages],
                         check=True, capture_output=True, text=True, timeout=90).stdout
    pending = []
    selectors = []
    for line in printed.splitlines():
        if not line.startswith("'"):
            continue
        parts = shlex.split(line)
        if len(parts) not in (3, 4):
            raise ValueError('Unexpected apt URI record')
        url, name, size = parts[:3]
        urls(url)
        if '/' in name or '\\' in name or not re.fullmatch(r'[A-Za-z0-9_.+:%~=-]+\.deb', name):
            raise ValueError('Unsafe apt cache name')
        decoded = unquote(urlsplit(url).path.rsplit('/', 1)[1])
        try:
            package, version, architecture = unquote(name)[:-4].split('_')
            # Debian pool filenames omit version epochs; apt cache names retain
            # them. Only this canonical difference is accepted.
            pool_name = f'{package}_{re.sub(r"^[0-9]+:", "", version)}_{architecture}.deb'
            if decoded != unquote(name) and decoded != pool_name:
                raise ValueError('Apt cache/archive name disagreement')
            length = int(size)
        except ValueError as error:
            raise ValueError('Invalid apt archive record') from error
        if not 0 < length <= MAX_PACKAGE:
            raise ValueError('Package size outside bound')
        selectors.append(f'{package}:{architecture}={version}')
        pending.append((url, name, length, decoded))
    if len(pending) > MAX_PACKAGES or len({item[1] for item in pending}) != len(pending):
        raise ValueError('Duplicate or excessive package archives')
    if not pending:
        return []
    metadata = runner(['apt-cache', 'show', *selectors], check=True, capture_output=True,
                      text=True, timeout=90).stdout
    records = {}
    for fields in _stanzas(metadata):
        if 'Filename' not in fields:
            continue
        name = fields['Filename'].rsplit('/', 1)[-1]
        records.setdefault(unquote(name), []).append(fields)
    result = []
    for url, name, size, decoded in pending:
        matches = [fields for fields in records.get(decoded, [])
                   if unquote(urlsplit(url).path).endswith('/'+unquote(fields['Filename']))]
        hashes = {fields.get('SHA256') for fields in matches}
        if (len(hashes) != 1 or not re.fullmatch(r'[0-9a-f]{64}', next(iter(hashes)) or '')
                or any(fields.get('Size') != str(size) for fields in matches)):
            raise ValueError('Missing or conflicting authenticated archive hash/size')
        result.append(Archive(url, name, size, next(iter(hashes))))
    return result


def _verified(path, item):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != item.size:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == item.sha256


def _download(descriptor, url, size_limit, expected_hash, timeout):
    """Run in a disposable interpreter; only the parent publishes the result."""
    with os.fdopen(descriptor, 'wb') as output, urlopen(url, timeout=timeout) as response:
        digest = hashlib.sha256(); size = 0
        while chunk := response.read(65536):
            size += len(chunk)
            if size > size_limit:
                raise ValueError('Archive exceeds authenticated size')
            output.write(chunk); digest.update(chunk)
        if size != size_limit or digest.hexdigest() != expected_hash:
            raise ValueError('Archive checksum/size mismatch')
        output.flush(); os.fsync(output.fileno())


def _attempt(descriptor, url, item, deadline):
    # Socket timeouts bound inactivity, not DNS/header/body wall time: a peer
    # can otherwise trickle forever inside read(). Isolate all blocking I/O in
    # an exec'd interpreter, safe in both main-thread and threaded callers.
    command = [sys.executable, str(Path(__file__).resolve()), '_download',
               str(descriptor), url, str(item.size), item.sha256,
               str(min(15, max(.001, deadline-time.monotonic())))]
    worker = subprocess.Popen(command, pass_fds=(descriptor,),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        try:
            _out, error = worker.communicate(timeout=max(0, deadline-time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise TimeoutError('Package download deadline exceeded') from error
        if time.monotonic() >= deadline:
            raise TimeoutError('Package download deadline exceeded')
        if worker.returncode:
            raise OSError(error.decode('utf-8', errors='replace')[:1000])
    finally:
        # Reap before removing temporary files: no timed-out child may keep
        # writing after fetch returns, including when the caller cancels.
        if worker.poll() is None:
            worker.kill()
        worker.communicate()


def fetch(item, cache, deadline=None):
    deadline = time.monotonic()+900 if deadline is None else deadline
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache/item.name
    if destination.is_symlink():
        raise ValueError('Refusing symlink in package cache')
    if _verified(destination, item):
        return destination
    failures = []
    for url in urls(item.url):
        if time.monotonic() >= deadline:
            raise TimeoutError('Package download deadline exceeded')
        descriptor, name = tempfile.mkstemp(prefix='.cubby-archive-', dir=cache)
        temporary = Path(name)
        try:
            _attempt(descriptor, url, item, deadline)
            os.replace(temporary, destination)
            return destination
        except (OSError, ValueError) as error:
            if time.monotonic() >= deadline:
                raise TimeoutError('Package download deadline exceeded') from error
            failures.append(f'{url}: {error}')
        finally:
            os.close(descriptor)
            temporary.unlink(missing_ok=True)
    raise RuntimeError('Verified archive fetch failed: '+'; '.join(failures))


def install(packages):
    deadline = time.monotonic()+900
    for item in plan(packages):
        print('Fetching authenticated archive '+item.name, flush=True)
        fetch(item, Path('/var/cache/apt/archives'), deadline=deadline)
    subprocess.run(['apt-get', '--yes', '--no-install-recommends', '--no-download',
                    'install', *packages], check=True, timeout=600)


if __name__ == '__main__':
    if sys.argv[1:2] == ['_download']:
        try:
            _download(int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), sys.argv[5], float(sys.argv[6]))
        except Exception as error:
            print(str(error)[:1000], file=sys.stderr)
            raise SystemExit(1)
        raise SystemExit(0)
    if sys.argv[1:2] != ['install']:
        raise SystemExit('Usage: apt_archives.py install PACKAGE...')
    install(sys.argv[2:])
