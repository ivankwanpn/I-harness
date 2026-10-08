"""Captured, standard-library WSL2 worker. One admitted execution per process."""
import base64
import errno
import hashlib
import json
import os
import platform
import re
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
MAX_INVENTORY_ENTRIES = 4096
MAX_INVENTORY_DIRECTORIES = 512
MAX_INVENTORY_DEPTH = 32
MAX_INVENTORY_SECONDS = 2.0
SAFE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C'}


class Refusal(Exception):
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
        with open('/proc/self/fdinfo/' + str(fd), 'rb') as info:
            data = info.read(8193)
        require(len(data) <= 8192, 'descriptor mount metadata oversized')
        return parse_mount_id(data.decode('ascii'))
    except (OSError, UnicodeError):
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
    def __init__(self, windows_path, canonical_cache=None):
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


def write_inventory(roots):
    """Refuse writable inode aliases; inventory via pinned, no-follow descriptors."""
    deadline = time.monotonic() + MAX_INVENTORY_SECONDS
    count, directories = 0, 0
    digest = hashlib.sha256()

    def stamp(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def record(root, relative, info, link=None):
        digest.update(json.dumps([root, relative, stamp(info), link], ensure_ascii=True,
                                 separators=(',', ':')).encode() + b'\n')

    def walk(fd, root, relative, device, mount_identity, depth):
        nonlocal count, directories
        directories += 1
        require(directories <= MAX_INVENTORY_DIRECTORIES and depth <= MAX_INVENTORY_DEPTH
                and time.monotonic() <= deadline, 'writable inventory limit exceeded')
        before = os.fstat(fd)
        require_same_mount(fd, mount_identity)
        require(stat.S_ISDIR(before.st_mode) and before.st_dev == device, 'unsupported writable inventory')
        record(root, relative, before)
        with os.scandir(fd) as entries:
            names = []
            for entry in entries:
                count += 1
                require(count <= MAX_INVENTORY_ENTRIES and time.monotonic() <= deadline,
                        'writable inventory limit exceeded')
                names.append(entry.name)
        for name in sorted(names):
            require(time.monotonic() <= deadline, 'writable inventory limit exceeded')
            initial = os.stat(name, dir_fd=fd, follow_symlinks=False)
            path = relative + '/' + name
            require(initial.st_dev == device, 'unsupported writable inventory')
            if stat.S_ISDIR(initial.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    require(stamp(os.fstat(child)) == stamp(initial), 'writable inventory changed')
                    walk(child, root, path, device, mount_identity, depth + 1)
                    require(stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) == stamp(os.fstat(child)),
                            'writable inventory changed')
                finally:
                    os.close(child)
            elif stat.S_ISREG(initial.st_mode):
                # NONBLOCK avoids a raced-in FIFO blocking the trusted worker.
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
                try:
                    current = os.fstat(child)
                    require_same_mount(child, mount_identity)
                    require(stat.S_ISREG(current.st_mode) and stamp(current) == stamp(initial),
                            'writable inventory changed')
                    require(current.st_nlink == 1, 'writable hardlink refused')
                    record(root, path, current)
                    require(stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) == stamp(current)
                            and stamp(os.fstat(child)) == stamp(current), 'writable inventory changed')
                finally:
                    os.close(child)
            elif stat.S_ISLNK(initial.st_mode):
                # Symlink targets retain the surrounding mount policy; never walk them.
                child = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    require_same_mount(child, mount_identity)
                    require(stamp(os.fstat(child)) == stamp(initial), 'writable inventory changed')
                    link = os.readlink(name, dir_fd=fd)
                    require(stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) == stamp(initial),
                            'writable inventory changed')
                    record(root, path, initial, link)
                finally:
                    os.close(child)
            else:
                raise Refusal('unsupported writable inventory')
        require(stamp(os.fstat(fd)) == stamp(before), 'writable inventory changed')
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
        return digest.hexdigest()
    except OSError:
        raise Refusal('writable inventory unreadable or changed') from None


class Prepared:
    def __init__(self, spec, policy):
        self.directories = []
        try:
            require(isinstance(spec, dict) and isinstance(policy, dict), 'invalid request')
            require(spec.get('owner') == policy.get('owner') and isinstance(spec.get('owner'), dict)
                    and text(spec['owner'].get('sessionId'))
                    and set(spec['owner']) <= {'sessionId', 'parentSessionId'}
                    and ('parentSessionId' not in spec['owner'] or text(spec['owner']['parentSessionId'])), 'invalid owner')
            require(policy.get('mode') in ('read-only', 'workspace-write')
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
            canonical_cache = {}
            def capture(path):
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
            self.primary = capture(policy.get('primaryRoot'))
            self.cwd = capture(spec.get('cwd'))
            require(self.authority and any(a.identity == self.primary.identity for a in self.authority), 'missing primary authority')
            require(policy['authorityKind'] != 'unbound' or len(self.authority) == 1, 'invalid unbound authority')
            require(any(directory_contains(a, self.cwd) for a in self.authority), 'cwd outside authority')
            require(self.mode != 'read-only' or not self.writes, 'read-only cannot grant writes')
            require(all(any(directory_contains(a, w) for a in self.authority) for w in self.writes), 'write outside authority')
            require(all(not directory_contains(r, w) and not directory_contains(w, r)
                        for w in self.writes for r in self.references), 'write overlaps reference')
            require(all(not contains('/tmp', d.physical) and not contains('/run/WSL', d.physical)
                        and d.physical not in ('/', '/proc', '/dev') for d in self.directories), 'unsupported root location')
            self.inventory = write_inventory(self.writes)
        except Exception:
            self.close()
            raise

    def validate(self):
        # Each admission fence recomputes location/ancestry; never reuse preparation's cache.
        canonical_cache = {}
        for directory in self.directories:
            directory.validate(canonical_cache)
        require(write_inventory(self.writes) == self.inventory, 'writable inventory changed')

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
            '--ro-bind-fd', str(root_fd), '/', '--dev', '/dev', '--proc', '/proc']
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
            self.prepared = Prepared(frame.get('spec'), frame.get('policy'))
            self.admitting = False
            self.phase = 'prepared'
            self.emit('prepared', policyFingerprint=self.prepared.fingerprint)
        elif kind == 'commit':
            require(self.phase == 'prepared', 'invalid protocol phase')
            self.admitting = True
            require(probe()[0], 'isolation startup unavailable')
            self.prepared.validate()
            fd = seccomp_fd()
            root_fd = os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                self.child = subprocess.Popen(command(self.prepared, fd, root_fd), env=SAFE_ENV,
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              pass_fds=(fd, root_fd, *(d.fd for d in self.prepared.writes + self.prepared.references)),
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
