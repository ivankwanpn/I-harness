"""Captured, standard-library WSL2 worker. One admitted execution per process."""
import base64
import ctypes
import errno
import hashlib
import json
import os
import platform
import re
import select
import selectors
import signal
import stat
import struct
import subprocess
import sys
import time

MAX_FRAME = 256 * 1024
CHUNK = 32 * 1024
MAX_PENDING = 4 * 1024 * 1024
MAX_INPUT = 1024 * 1024
MAX_INVENTORY_ENTRIES = 1_000_000
MAX_INVENTORY_DIRECTORIES = 100_000
MAX_INVENTORY_DEPTH = 128
MAX_INVENTORY_SECONDS = 45.0
SAFE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C'}

# Linux statx gives metadata and the kernel mount ID in one descriptor-relative
# lookup. Never replace the mount ID with st_dev: same-device binds must refuse.
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
LIBC.statx.restype = ctypes.c_int


def metadata(fd, name=''):
    data = ctypes.create_string_buffer(256)
    flags = 0x100 | (0x1000 if not name else 0)  # NOFOLLOW, EMPTY_PATH
    if LIBC.statx(fd, os.fsencode(name), flags, 0x7ff | 0x1000, data) != 0:
        raise OSError(ctypes.get_errno(), 'statx unavailable')
    mask, = struct.unpack_from('I', data.raw, 0)
    require(mask & 0x1000 and mask & 0x7ff == 0x7ff, 'kernel mount metadata unavailable')
    nlink, = struct.unpack_from('I', data.raw, 16)
    mode, = struct.unpack_from('H', data.raw, 28)
    ino, size = struct.unpack_from('QQ', data.raw, 32)
    devmajor, devminor = struct.unpack_from('II', data.raw, 136)
    mount, = struct.unpack_from('Q', data.raw, 144)
    csec, cnsec = struct.unpack_from('qI', data.raw, 96)
    msec, mnsec = struct.unpack_from('qI', data.raw, 112)
    return (os.makedev(devmajor, devminor), ino, mode, nlink, size,
            msec * 1_000_000_000 + mnsec, csec * 1_000_000_000 + cnsec), mount


class Refusal(Exception):
    pass


class AdmissionCancelled(Exception):
    pass


def require(condition, detail):
    if not condition:
        raise Refusal(detail)


def text(value):
    return isinstance(value, str) and bool(value) and '\0' not in value


def contains(root, child):
    return child == root or child.startswith(root.rstrip('/') + '/')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate protocol field')
        result[key] = value
    return result


def parse_mount_id(info):
    values = [line.split(':', 1)[1].strip() for line in info.splitlines() if line.startswith('mnt_id:')]
    require(len(values) == 1 and re.fullmatch(r'[0-9]{1,20}', values[0]) is not None,
            'descriptor mount identity unavailable')
    identity = int(values[0])
    require(0 < identity < 2 ** 64, 'descriptor mount identity unavailable')
    return identity


def read_mount_id(fd):
    try:
        identity = metadata(fd)[1]
        require(identity > 0, 'descriptor mount identity unavailable')
        return identity
    except OSError:
        raise Refusal('descriptor mount identity unavailable') from None


def require_same_mount(fd, expected):
    require(type(expected) is int and expected > 0 and read_mount_id(fd) == expected,
            'writable inventory crosses mount identity')


def canonical_directory(fd):
    """Resolve spelling from verified directory entries, preserving Linux case rules."""
    current = os.dup(fd)
    names, ancestors, examined = [], [], 0
    deadline = time.monotonic() + 2.0
    try:
        for _ in range(128):
            child_identity = Directory.key(os.fstat(current))
            ancestors.append(child_identity)
            parent = os.open('..', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            try:
                if Directory.key(os.fstat(parent)) == child_identity:
                    os.close(parent)
                    return '/' + '/'.join(reversed(names)), tuple(ancestors)
                matches = []
                with os.scandir(parent) as entries:
                    for entry in entries:
                        examined += 1
                        require(examined <= 8192 and time.monotonic() <= deadline,
                                'directory canonicalization limit exceeded')
                        info = os.stat(entry.name, dir_fd=parent, follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode) and Directory.key(info) == child_identity:
                            matches.append(entry.name)
                require(len(matches) == 1, 'ambiguous directory identity')
                names.append(matches[0])
            except Exception:
                os.close(parent)
                raise
            os.close(current)
            current = parent
        raise Refusal('directory canonicalization limit exceeded')
    finally:
        os.close(current)


def directory_contains(root, child):
    return root.identity in child.ancestors


class Directory:
    def __init__(self, windows_path, canonical_cache=None, linux=False):
        if linux:
            require(text(windows_path) and windows_path.startswith('/')
                    and not any(c in windows_path for c in '\r\n:'), 'invalid runtime directory')
            mapped = windows_path
        else:
            require(text(windows_path) and re.fullmatch(r'[A-Za-z]:[\\/].*', windows_path) is not None
                    and not any(c in windows_path for c in '\r\n'), 'invalid local-drive directory')
            mapped = subprocess.run(['/usr/bin/wslpath', '-u', windows_path], env=SAFE_ENV,
                                    capture_output=True, timeout=5, check=True).stdout.decode().strip()
        require(mapped.startswith('/'), 'invalid mapped directory')
        self.mapped = mapped
        self.physical = os.path.realpath(mapped, strict=True)
        self.fd = os.open(self.physical, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        self.identity = self.key(os.fstat(self.fd))
        try:
            self.mount_identity = read_mount_id(self.fd)
            if canonical_cache is not None and self.identity in canonical_cache:
                self.physical, self.ancestors = canonical_cache[self.identity]
            else:
                self.physical, self.ancestors = canonical_directory(self.fd)
                if canonical_cache is not None:
                    canonical_cache[self.identity] = self.physical, self.ancestors
            self.validate(canonical_cache)
        except Exception:
            os.close(self.fd)
            raise

    @staticmethod
    def key(info):
        return info.st_dev, info.st_ino

    def validate(self, canonical_cache=None):
        try:
            require(self.key(os.stat(self.mapped)) == self.identity
                    and self.key(os.stat(self.physical)) == self.identity
                    and self.key(os.fstat(self.fd)) == self.identity, 'directory identity changed')
            require_same_mount(self.fd, self.mount_identity)
            # A same-inode mount replacement at either spelling must not pass the fence.
            for path in (os.path.realpath(self.mapped, strict=True), self.physical):
                current_fd = os.open(path, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    require_same_mount(current_fd, self.mount_identity)
                    require(self.key(os.fstat(current_fd)) == self.identity, 'directory identity changed')
                finally:
                    os.close(current_fd)
            if canonical_cache is not None and self.identity in canonical_cache:
                current = canonical_cache[self.identity]
            else:
                current = canonical_directory(self.fd)
                if canonical_cache is not None:
                    canonical_cache[self.identity] = current
            require(current == (self.physical, self.ancestors), 'directory identity or ancestry changed')
        except OSError:
            raise Refusal('directory identity changed') from None

    def close(self):
        os.close(self.fd)


def write_inventory(roots, checkpoint=lambda: None, statistics=None):
    """Inventory every entry, including dependencies, using pinned no-follow statx."""
    deadline = time.monotonic() + MAX_INVENTORY_SECONDS
    count, directories = 0, 0
    digest = hashlib.sha256()
    aliases, seen_entries = {}, set()

    def record(root, relative, info, link=None):
        digest.update(json.dumps([root, relative, info, link], ensure_ascii=True,
                                 separators=(',', ':')).encode() + b'\n')

    def walk(fd, root, relative, device, mount_identity, depth):
        nonlocal count, directories
        checkpoint()
        directories += 1
        require(directories <= MAX_INVENTORY_DIRECTORIES and depth <= MAX_INVENTORY_DEPTH
                and time.monotonic() <= deadline, 'writable inventory limit exceeded')
        before, mount = metadata(fd)
        require(mount == mount_identity, 'writable inventory crosses mount identity')
        require(stat.S_ISDIR(before[2]) and before[0] == device, 'unsupported writable inventory')
        record(root, relative, before)
        with os.scandir(fd) as entries:
            names = []
            for entry in entries:
                checkpoint()
                count += 1
                require(count <= MAX_INVENTORY_ENTRIES and time.monotonic() <= deadline,
                        'writable inventory limit exceeded')
                names.append(entry.name)
        for name in sorted(names):
            checkpoint()
            require(time.monotonic() <= deadline, 'writable inventory limit exceeded')
            initial, mount = metadata(fd, name)
            path = relative + '/' + name
            require(initial[0] == device, 'unsupported writable inventory')
            require(mount == mount_identity, 'writable inventory crosses mount identity')
            if stat.S_ISDIR(initial[2]):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    require(metadata(child) == (initial, mount), 'writable inventory changed')
                    walk(child, root, path, device, mount_identity, depth + 1)
                    require(metadata(fd, name) == metadata(child),
                            'writable inventory changed')
                finally:
                    os.close(child)
            elif stat.S_ISREG(initial[2]):
                identity = initial[:2]
                entry_identity = (before[:2], name)
                if entry_identity not in seen_entries:
                    seen_entries.add(entry_identity)
                    links, expected = aliases.get(identity, (0, initial[3]))
                    require(expected == initial[3], 'writable inventory changed')
                    aliases[identity] = (links + 1, expected)
                record(root, path, initial)
                require(metadata(fd, name) == (initial, mount), 'writable inventory changed')
            elif stat.S_ISLNK(initial[2]):
                # Symlink targets retain the surrounding mount policy; never walk them.
                link = os.readlink(name, dir_fd=fd)
                require(metadata(fd, name) == (initial, mount), 'writable inventory changed')
                record(root, path, initial, link)
            else:
                raise Refusal('unsupported writable inventory')
        require(metadata(fd) == (before, mount_identity), 'writable inventory changed')
        require_same_mount(fd, mount_identity)

    try:
        for root in sorted(roots, key=lambda value: value.physical):
            fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root.fd)
            try:
                require(Directory.key(os.fstat(fd)) == root.identity, 'writable inventory identity changed')
                require_same_mount(fd, root.mount_identity)
                walk(fd, root.physical, '', os.fstat(fd).st_dev, root.mount_identity, 0)
            finally:
                os.close(fd)
        require(all(found == expected for found, expected in aliases.values()), 'external writable hardlink refused')
        if statistics is not None:
            statistics.update(entries=count, directories=directories)
        return digest.hexdigest()
    except OSError:
        raise Refusal('writable inventory unreadable or changed') from None


class Prepared:
    def __init__(self, spec, policy, configuration=None, checkpoint=lambda: None):
        self.directories = []
        try:
            require(isinstance(spec, dict) and isinstance(policy, dict), 'invalid request')
            require(spec.get('owner') == policy.get('owner') and isinstance(spec.get('owner'), dict)
                    and text(spec['owner'].get('sessionId'))
                    and set(spec['owner']) <= {'sessionId', 'parentSessionId'}
                    and ('parentSessionId' not in spec['owner'] or text(spec['owner']['parentSessionId'])), 'invalid owner')
            require(policy.get('mode') in ('read-only', 'workspace-write', 'danger-full-access')
                    and policy.get('readable') == 'caller'
                    and policy.get('authorityKind') in ('bound', 'unbound')
                    and text(policy.get('authorityRevision')) and text(policy.get('fingerprint')), 'unsupported policy')
            require(spec.get('transport') == 'pipe' and spec.get('lifetime') == 'complete-tree'
                    and spec.get('argumentEncoding') == 'crt' and 'pty' not in spec, 'unsupported execution')
            require(not spec.get('denyPaths') and not policy.get('denyPaths')
                    and not spec.get('readIsolation') and not policy.get('readIsolation'), 'unsupported protection')
            argv = spec.get('argv')
            require(isinstance(argv, list) and bool(argv) and all(isinstance(a, str) and '\0' not in a for a in argv)
                    and argv[0].startswith('/') and not argv[0].lower().endswith('.exe'), 'invalid Linux argv')
            environment = spec.get('env')
            require(isinstance(environment, dict) and all(text(k) and '=' not in k and isinstance(v, str) and '\0' not in v
                    and not k.upper().startswith('WSL') for k, v in environment.items()), 'invalid Linux environment')
            self.argv, self.env = list(argv), dict(environment)
            self.mode, self.fingerprint = policy['mode'], policy['fingerprint']
            configuration = configuration or {}
            require(set(configuration) <= {'networkAccess', 'runtimePath'}
                    and type(configuration.get('networkAccess', False)) is bool, 'invalid runtime configuration')
            runtime_path = configuration.get('runtimePath', [])
            require(isinstance(runtime_path, list) and len(runtime_path) <= 16
                    and all(text(path) and path.startswith('/') and ':' not in path for path in runtime_path), 'invalid runtime PATH')
            self.network_access = configuration.get('networkAccess', False)
            self.runtimes = []
            if runtime_path:
                self.env['PATH'] = ':'.join(runtime_path + [self.env.get('PATH', SAFE_ENV['PATH'])])
            canonical_cache = {}
            def capture(path):
                checkpoint()
                entry = Directory(path, canonical_cache)
                self.directories.append(entry)
                return entry
            def roots(key):
                values = policy.get(key)
                require(isinstance(values, list) and len(values) <= 64, 'invalid directory roots')
                return [capture(path) for path in values]
            self.authority = roots('authorityRoots')
            self.writes = roots('writeRoots')
            self.references = roots('referenceRoots')
            require(self.mode != 'danger-full-access' or not self.references, 'full access cannot protect references')
            self.primary = capture(policy.get('primaryRoot'))
            self.cwd = capture(spec.get('cwd'))
            for path in runtime_path:
                checkpoint()
                path = path.rstrip('/') or '/'
                root = os.path.dirname(path) if os.path.basename(path) == 'bin' else path
                require(root not in ('/', '/usr', '/bin', '/tmp', '/proc', '/dev', '/run/WSL'), 'unsupported runtime directory')
                try:
                    directory = Directory(root, canonical_cache, linux=True)
                    self.directories.append(directory)
                    binary_directory = Directory(path, canonical_cache, linux=True)
                    self.directories.append(binary_directory)
                except OSError:
                    raise Refusal('managed runtime directory unavailable or changed') from None
                require(directory_contains(directory, binary_directory), 'managed runtime bin escapes release')
                self.runtimes.append(directory)
            require(self.authority and any(a.identity == self.primary.identity for a in self.authority), 'missing primary authority')
            require(policy['authorityKind'] != 'unbound' or len(self.authority) == 1, 'invalid unbound authority')
            require(any(directory_contains(a, self.cwd) for a in self.authority), 'cwd outside authority')
            require(self.mode != 'read-only' or not self.writes, 'read-only cannot grant writes')
            require(all(any(directory_contains(a, w) for a in self.authority) for w in self.writes), 'write outside authority')
            require(all(not directory_contains(r, w) and not directory_contains(w, r)
                        for w in self.writes for r in self.references), 'write overlaps reference')
            require(all(not contains('/tmp', d.physical) and not contains('/run/WSL', d.physical)
                        and d.physical not in ('/', '/proc', '/dev') for d in self.directories), 'unsupported root location')
            self.inventory_statistics = {}
            self.inventory = write_inventory(self.writes, checkpoint, self.inventory_statistics)
            self.runtime_inventory = write_inventory(self.runtimes, checkpoint)
        except Exception:
            self.close()
            raise

    def validate(self, checkpoint=lambda: None):
        # Each admission fence recomputes location/ancestry; never reuse preparation's cache.
        canonical_cache = {}
        for directory in self.directories:
            checkpoint()
            directory.validate(canonical_cache)
        require(write_inventory(self.writes, checkpoint) == self.inventory, 'writable inventory changed')
        require(write_inventory(self.runtimes, checkpoint) == self.runtime_inventory, 'managed runtime inventory changed')

    def close(self):
        for directory in self.directories:
            directory.close()
        self.directories.clear()


def seccomp_fd():
    require(platform.machine() == 'x86_64', 'unsupported seccomp architecture')
    # Classic BPF on struct seccomp_data. Fail closed on foreign/x32 syscalls.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000)]
    for number in (425, 426, 427):
        instructions += [(0x15, 0, 1, number), (0x06, 0, 0, 0x50000 | errno.EPERM)]
    # socket and socketpair use args[0] for the address family.
    instructions += [(0x15, 1, 0, 41), (0x15, 0, 3, 53), (0x20, 0, 0, 16),
                     (0x15, 0, 1, 1), (0x06, 0, 0, 0x50000 | errno.EPERM), (0x06, 0, 0, 0x7FFF0000)]
    fd = os.memfd_create('ih-wsl-seccomp', os.MFD_CLOEXEC)
    os.write(fd, b''.join(struct.pack('HBBI', *i) for i in instructions))
    os.lseek(fd, 0, os.SEEK_SET)
    return fd


def command(prepared, filter_fd, root_fd):
    args = ['/usr/bin/bwrap', '--unshare-all', '--new-session', '--die-with-parent', '--cap-drop', 'ALL',
            '--bind-fd' if prepared is not None and prepared.mode == 'danger-full-access' else '--ro-bind-fd',
            str(root_fd), '/', '--dev', '/dev', '--proc', '/proc']
    if prepared is not None and (prepared.mode == 'danger-full-access' or prepared.network_access):
        args += ['--share-net']
    if os.path.exists('/init'):
        args += ['--ro-bind', '/dev/null', '/init']
    if os.path.exists('/run/WSL'):
        args += ['--tmpfs', '/run/WSL', '--remount-ro', '/run/WSL']
    if prepared is not None:
        args += ['--clearenv']
        for key, value in sorted(prepared.env.items()):
            args += ['--setenv', key, value]
        if prepared.mode == 'workspace-write':
            args += ['--tmpfs', '/tmp']
        for root in sorted(prepared.writes, key=lambda r: len(r.physical)):
            args += ['--bind-fd', str(root.fd), root.physical]
        for root in sorted(prepared.references, key=lambda r: len(r.physical)):
            args += ['--ro-bind-fd', str(root.fd), root.physical]
        for root in sorted(getattr(prepared, 'runtimes', []), key=lambda r: len(r.physical)):
            args += ['--ro-bind-fd', str(root.fd), root.physical]
        args += ['--chdir', prepared.cwd.physical]
    args += ['--seccomp', str(filter_fd), '--']
    return args + (prepared.argv if prepared is not None else ['/bin/true'])


def probe():
    try:
        require(sys.platform == 'linux' and 'microsoft' in platform.release().lower()
                and 'wsl2' in platform.release().lower(), 'WSL2 required')
        fd = seccomp_fd()
        root_fd = os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            result = subprocess.run(command(None, fd, root_fd), env=SAFE_ENV, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    pass_fds=(fd, root_fd), timeout=5)
            require(result.returncode == 0, 'isolation startup refused')
        finally:
            os.close(fd)
            os.close(root_fd)
        return True, 'WSL2 bubblewrap and x86_64 seccomp startup succeeded'
    except Exception:
        return False, 'WSL2 isolation startup unavailable'


class Worker:
    def __init__(self, nonce, digest):
        self.nonce, self.digest = nonce, digest
        self.selector = selectors.DefaultSelector()
        self.selector.register(0, selectors.EVENT_READ, 'control')
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        self.control, self.pending, self.input = bytearray(), bytearray(), bytearray()
        self.prepared, self.child = None, None
        self.phase, self.exiting, self.ended, self.root_sent = 'idle', False, False, False
        self.failed = False
        self.admitting = False
        self.streams = 0
        self.admission_deadline = 0
        self.progress_at = 0

    def checkpoint(self):
        now = time.monotonic()
        require(now <= self.admission_deadline, 'preparation deadline exceeded')
        # The main loop pauses for descriptor-safe enumeration; poll its bounded
        # control buffer at every entry so cancellation/EOF remain responsive.
        if select.select([0], [], [], 0)[0]:
            data = os.read(0, CHUNK)
            if not data:
                raise AdmissionCancelled()
            self.control.extend(data)
        require(len(self.control) < MAX_FRAME, 'oversized protocol frame')
        while b'\n' in self.control:
            line, _, rest = self.control.partition(b'\n')
            self.control = bytearray(rest)
            frame = json.loads(line, object_pairs_hook=unique_object)
            require(isinstance(frame, dict) and type(frame.get('v')) is int and frame['v'] == 1
                    and frame.get('nonce') == self.nonce and set(frame) == {'v', 'nonce', 'type'}
                    and frame.get('type') in ('cancel', 'shutdown'), 'invalid admission control')
            raise AdmissionCancelled()
        if now >= self.progress_at:
            self.emit('progress', stage='preparing' if self.phase == 'preparing' else 'validating')
            self.progress_at = now + 0.25
        if self.pending:
            try:
                count = os.write(1, self.pending)
                del self.pending[:count]
                if not self.pending:
                    self.selector.unregister(1)
            except BlockingIOError:
                pass

    def emit(self, kind, **fields):
        line = (json.dumps({'v': 1, 'nonce': self.nonce, 'type': kind, **fields}, separators=(',', ':')) + '\n').encode()
        limit = MAX_PENDING if kind in ('error', 'refused', 'root', 'settled') else MAX_PENDING - 4096
        require(len(self.pending) + len(line) <= limit, 'output overflow')
        if not self.pending:
            self.selector.register(1, selectors.EVENT_WRITE, 'wire')
        self.pending.extend(line)

    def stop(self):
        if self.child is not None and self.child.poll() is None:
            # Only the owned launcher/session. Namespace init destruction also kills setsid descendants.
            try:
                os.killpg(self.child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.input.clear()
        self.ended = True
        self.close_input()
        if self.phase == 'prepared':
            self.prepared.close()
            self.prepared = None
            self.phase = 'settled'
            self.emit('settled')

    def fail(self, detail):
        if self.failed:
            return
        self.failed = True
        self.stop()
        self.emit('error', detail=detail)
        self.exiting = True
        try:
            self.selector.unregister(0)
        except KeyError:
            pass

    def refuse(self, detail):
        if self.prepared is not None:
            self.prepared.close()
            self.prepared = None
        self.phase, self.exiting, self.admitting = 'settled', True, False
        self.emit('refused', detail=detail)
        self.emit('settled')
        self.selector.unregister(0)

    def close_input(self):
        if self.child is not None and self.child.stdin is not None and not self.child.stdin.closed:
            try:
                self.selector.unregister(self.child.stdin)
            except KeyError:
                pass
            self.child.stdin.close()

    def receive(self, frame):
        self.admitting = False
        require(isinstance(frame, dict) and type(frame.get('v')) is int and frame.get('v') == 1 and frame.get('nonce') == self.nonce,
                'invalid protocol envelope')
        kind = frame.get('type')
        if kind == 'probe':
            require(self.phase == 'idle', 'invalid protocol phase')
            available, detail = probe()
            self.emit('probe', available=available, detail=detail)
        elif kind == 'prepare':
            require(self.phase == 'idle', 'invalid protocol phase')
            self.admitting = True
            self.phase = 'preparing'
            self.admission_deadline, self.progress_at = time.monotonic() + 55, 0
            self.prepared = Prepared(frame.get('spec'), frame.get('policy'), frame.get('configuration'), self.checkpoint)
            self.admitting = False
            self.phase = 'prepared'
            self.emit('prepared', policyFingerprint=self.prepared.fingerprint,
                      inventoryEntries=self.prepared.inventory_statistics['entries'],
                      inventoryDirectories=self.prepared.inventory_statistics['directories'])
        elif kind == 'commit':
            require(self.phase == 'prepared', 'invalid protocol phase')
            self.admitting = True
            self.admission_deadline, self.progress_at = time.monotonic() + 55, 0
            self.phase = 'validating'
            require(probe()[0], 'isolation startup unavailable')
            self.prepared.validate(self.checkpoint)
            self.checkpoint()
            fd = seccomp_fd()
            root_fd = os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                self.child = subprocess.Popen(command(self.prepared, fd, root_fd), env=SAFE_ENV,
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              pass_fds=(fd, root_fd, *(d.fd for d in self.prepared.writes + self.prepared.references + self.prepared.runtimes)),
                                              start_new_session=True)
                self.admitting = False
            finally:
                os.close(fd)
                os.close(root_fd)
            self.phase = 'active'
            for name in ('stdout', 'stderr'):
                stream = getattr(self.child, name)
                os.set_blocking(stream.fileno(), False)
                self.selector.register(stream, selectors.EVENT_READ, name)
                self.streams += 1
            os.set_blocking(self.child.stdin.fileno(), False)
            self.emit('started', pid=self.child.pid)
        elif kind in ('cancel', 'shutdown'):
            self.stop()
            if kind == 'shutdown':
                self.exiting = True
        elif kind == 'input':
            require(self.phase == 'active' and not self.ended, 'invalid protocol phase')
            require(isinstance(frame.get('data'), str), 'invalid command input')
            try:
                data = base64.b64decode(frame['data'], validate=True)
            except Exception:
                raise Refusal('invalid command input') from None
            require(len(data) <= CHUNK and len(self.input) + len(data) <= MAX_INPUT, 'command input overflow')
            if data:
                if not self.input:
                    self.selector.register(self.child.stdin, selectors.EVENT_WRITE, 'input')
                self.input.extend(data)
        elif kind == 'endInput':
            require(self.phase == 'active' and not self.ended, 'invalid protocol phase')
            self.ended = True
            if not self.input:
                self.close_input()
        else:
            raise Refusal('unknown protocol type')

    def poll_child(self):
        if self.child is None:
            return
        status = self.child.poll()
        if status is not None and not self.root_sent:
            self.child.wait()
            self.root_sent = True
            fields = {'exitCode': status if status >= 0 else None}
            if status < 0:
                fields['signal'] = signal.Signals(-status).name.removeprefix('SIG')
            self.emit('root', **fields)
            self.close_input()
        if self.root_sent and self.streams == 0 and self.phase == 'active':
            self.prepared.close()
            self.prepared = None
            self.phase = 'settled'
            self.emit('settled')

    def run(self):
        self.emit('hello', sha256=self.digest, workerPid=os.getpid())
        try:
            while True:
                self.poll_child()
                if self.exiting and self.phase != 'active' and not self.pending:
                    break
                for key, _ in self.selector.select(0.05):
                    name = key.data
                    try:
                        if name == 'wire':
                            count = os.write(1, self.pending)
                            del self.pending[:count]
                            if not self.pending:
                                self.selector.unregister(1)
                        elif name == 'control':
                            data = os.read(0, CHUNK)
                            if not data:
                                self.selector.unregister(0)
                                self.stop()
                                self.exiting = True
                                continue
                            self.control.extend(data)
                            while b'\n' in self.control:
                                line, _, rest = self.control.partition(b'\n')
                                self.control = bytearray(rest)
                                require(len(line) + 1 <= MAX_FRAME, 'oversized protocol frame')
                                try:
                                    frame = json.loads(line, object_pairs_hook=unique_object)
                                except Exception:
                                    raise Refusal('invalid protocol JSON') from None
                                self.receive(frame)
                                if self.exiting:
                                    self.control.clear()
                                    break
                            require(len(self.control) < MAX_FRAME, 'oversized protocol frame')
                        elif name == 'input':
                            count = os.write(key.fd, self.input)
                            del self.input[:count]
                            if not self.input:
                                self.selector.unregister(key.fileobj)
                                if self.ended:
                                    self.close_input()
                        else:
                            data = os.read(key.fd, CHUNK)
                            if data and not self.failed:
                                self.emit('output', channel=name, data=base64.b64encode(data).decode('ascii'))
                            elif not data:
                                self.selector.unregister(key.fileobj)
                                key.fileobj.close()
                                self.streams -= 1
                    except BlockingIOError:
                        pass
                    except BrokenPipeError:
                        if name == 'wire':
                            self.stop()
                            self.pending.clear()
                            self.selector.unregister(1)
                            self.exiting = True
                        else:
                            self.input.clear()
                            self.close_input()
                    except AdmissionCancelled:
                        if self.prepared is not None:
                            self.prepared.close()
                            self.prepared = None
                        self.admitting = False
                        self.phase, self.exiting = 'settled', True
                        self.emit('settled')
                        try:
                            self.selector.unregister(0)
                        except KeyError:
                            pass
                    except Refusal as error:
                        if self.admitting and self.child is None:
                            self.refuse(str(error))
                        else:
                            self.fail(str(error))
                    except Exception:
                        self.fail('worker operation refused')
        finally:
            self.stop()
            if self.child is not None:
                self.child.wait()
                for stream in (self.child.stdout, self.child.stderr):
                    if not stream.closed:
                        stream.close()
            if self.prepared is not None:
                self.prepared.close()
            self.selector.close()


def main():
    nonce, digest = globals().get('IH_WSL_NONCE'), globals().get('IH_WSL_SHA256')
    if not text(nonce) or not text(digest):
        return 1
    try:
        Worker(nonce, digest).run()
        return 0
    except Exception:
        # Unexpected teardown/transport failures are incomplete exits, without leaking request data.
        return 1


if __name__ == '__main__':
    sys.exit(main())
