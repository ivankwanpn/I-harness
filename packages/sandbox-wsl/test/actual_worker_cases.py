"""Named real-worker cases. Import/source-check never constructs a Session."""
import importlib.util
import base64
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('original_worker_tests', pathlib.Path(__file__).with_name('worker_test.py'))
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
CASES = {
    'A0': 'test_probe_checks_actual_isolation_startup',
    'A1': 'test_command_stdin_is_separate_from_control',
    'A2': 'test_cancel_tears_down_detached_descendants_before_settled',
    'A3': 'test_control_eof_tears_down_detached_descendants',
    'A4': 'test_root_exit_tears_down_detached_descendants',
}

def identity(pid):
    root = pathlib.Path('/proc') / str(pid)
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'parentPid': int(fields[1]), 'startTicks': fields[19],
            'executable': os.readlink(root / 'exe'),
            'argv': (root / 'cmdline').read_bytes().decode(errors='backslashreplace').split('\0')[:-1]}

class CleanupIncomplete(Exception):
    def __init__(self, message, failures=()):
        super().__init__(message)
        self.failures = tuple(failures)

class GuardedSession(original.Session):
    def __init__(self, evidence):
        self.evidence = evidence
        self.events = evidence.with_suffix('.ownership.jsonl')
        self.lock = threading.Lock()
        self.evidence_errors = []
        self.owned = {}
        self.stderr_bytes = bytearray()
        self.stderr_reader = None
        self.stdout_eof, self.stderr_eof = False, False
        self.reader_errors, self.protocol_errors, self.raw_lines, self.observed = [], [], [], []
        self.process_lock = threading.Lock()
        self.watchdog_stop, self.watchdog_expired = threading.Event(), threading.Event()
        self.watchdog, self.watchdog_errors = None, []
        self.cleanup_done, self.cleanup_error = False, None
        self.forced = False
        self.process = None
        try:
            super().__init__(evidence, on_acquired=self.acquired, on_line=self.observe_line, on_reader_end=self.reader_end)
        except BaseException as primary:
            try:
                self.close()
            except BaseException as cleanup:
                raise CleanupIncomplete('session setup and cleanup failed', (primary, cleanup)) from primary
            raise

    def record(self, event, **fields):
        try:
            with self.lock:
                with self.events.open('a') as out:
                    out.write(json.dumps({'event': event, 'at': time.time(), 'monotonic': time.monotonic(), **fields}) + '\n')
        except BaseException as error:
            self.evidence_errors.append(error)

    def acquired(self, process):
        self.process = process  # Original Popen precedes any fallible inspection.
        original_wait = process.wait
        def serialized_wait(*args, **kwargs):
            # All original-case waits (including A3's direct call) use this
            # exact Popen's bound wait, serialized against watchdog signaling.
            with self.process_lock:
                result = original_wait(*args, **kwargs)
                self.watchdog_stop.set()
                return result
        process.wait = serialized_wait
        def deadline():
            if self.watchdog_stop.wait(25):
                return
            self.watchdog_expired.set()  # FAIL latched before I/O or signaling.
            try:
                with self.process_lock:
                    if process.returncode is None:
                        # This exact child has not been reaped. The same lock
                        # protects every wait, so its PID cannot be reused.
                        # No second wait/poll/reaper, PID reopen or lookup.
                        self.forced = True
                        os.kill(process.pid, signal.SIGKILL)
            except BaseException as error:
                self.watchdog_errors.append(error)
            self.record('session-watchdog-failure', pid=process.pid, forced=self.forced)
        self.watchdog = threading.Thread(target=deadline, daemon=True)
        try:
            self.watchdog.start()  # Active BEFORE metadata/evidence/bootstrap.
        except BaseException as error:
            self.watchdog_expired.set()
            self.watchdog_errors.append(error)
            with self.process_lock:
                if process.returncode is None:
                    self.forced = True
                    os.kill(process.pid, signal.SIGKILL)
            raise
        self.record('popen-acquired', pid=process.pid, parentPid=os.getpid(), args=process.args, cwd=os.getcwd(), workerSha256=self.digest)
        captured = identity(process.pid)
        if captured['parentPid'] != os.getpid():
            raise CleanupIncomplete('original worker parentage mismatch')
        if captured['argv'] != process.args or captured['executable'] != os.path.realpath(process.args[0]):
            raise CleanupIncomplete('original worker command/executable mismatch')
        self.owned[process.pid] = captured
        self.record('worker-identity', identity=captured)
        def stderr_reader():
            try:
                while True:
                    chunk = process.stderr.read(4096)
                    if not chunk:
                        self.stderr_eof = True
                        break
                    self.stderr_bytes.extend(chunk)
            except BaseException as error:
                self.reader_errors.append(error)
                self.record('stderr-reader-failure', detail=repr(error))
        self.stderr_reader = threading.Thread(target=stderr_reader, daemon=True)
        self.stderr_reader.start()

    def observe_line(self, line):
        self.raw_lines.append(bytes(line))
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('duplicate protocol field')
                result[key] = value
            return result
        try:
            if not line.endswith(b'\n'):
                raise ValueError('incomplete protocol line')
            frame = json.loads(line, object_pairs_hook=unique)
            if not isinstance(frame, dict) or type(frame.get('v')) is not int or frame['v'] != 1 or frame.get('nonce') != self.nonce:
                raise ValueError('invalid protocol envelope')
            if frame.get('type') not in ('hello', 'probe', 'progress', 'prepared', 'started', 'output', 'root', 'settled', 'error', 'refused'):
                raise ValueError('unknown protocol frame')
            if len(line) > 262144:
                raise ValueError('oversized protocol line')
            if frame['type'] == 'hello' and (type(frame.get('workerPid')) is not int or frame['workerPid'] != self.process.pid or frame.get('sha256') != self.digest):
                raise ValueError('hello ownership/digest mismatch')
            if frame['type'] == 'started' and (type(frame.get('pid')) is not int or frame['pid'] <= 0):
                raise ValueError('invalid launcher PID')
            if frame['type'] == 'output':
                if frame.get('channel') not in ('stdout', 'stderr') or not isinstance(frame.get('data'), str):
                    raise ValueError('invalid output frame')
                base64.b64decode(frame['data'], validate=True)
            self.observed.append(frame)
        except BaseException as error:
            self.protocol_errors.append(error)

    def reader_end(self, error):
        if error is not None:
            self.reader_errors.append(error)
        else:
            self.stdout_eof = True

    def audit(self, selected):
        failures = list(self.protocol_errors) + list(self.reader_errors)
        kinds = [frame['type'] for frame in self.observed]
        if not self.cleanup_done or self.cleanup_error or not self.stdout_eof or not self.stderr_eof:
            failures.append(ValueError('original cleanup/reader EOF incomplete'))
        if self.stderr_bytes:
            failures.append(ValueError('unexpected worker stderr'))
        if any(kind in ('error', 'refused') for kind in kinds):
            failures.append(ValueError('error/refused in complete protocol'))
        if selected == 'A0':
            probes = [frame for frame in self.observed if frame['type'] == 'probe']
            if len(probes) != 1 or probes[0].get('available') is not True or 'output' in kinds:
                failures.append(ValueError('invalid startup probe outcome'))
        expected = {'hello': 1, 'probe': 1 if selected == 'A0' else 0, 'prepared': 0 if selected == 'A0' else 1,
                    'started': 0 if selected == 'A0' else 1, 'root': 0 if selected == 'A0' else 1, 'settled': 0 if selected == 'A0' else 1}
        for kind, count in expected.items():
            if kinds.count(kind) != count:
                failures.append(ValueError('unexpected frame count: ' + kind))
        if selected != 'A0' and all(kinds.count(kind) == 1 for kind in ('hello', 'prepared', 'started', 'root', 'settled')):
            if [kinds.index(kind) for kind in ('hello', 'prepared', 'started', 'root', 'settled')] != sorted(kinds.index(kind) for kind in ('hello', 'prepared', 'started', 'root', 'settled')):
                failures.append(ValueError('invalid lifecycle frame order'))
            settled = kinds.index('settled')
            if any(kind != 'settled' for kind in kinds[settled:]):
                failures.append(ValueError('late protocol frame after settled'))
            root = next(frame for frame in self.observed if frame['type'] == 'root')
            if 'exitCode' not in root:
                failures.append(ValueError('missing root exitCode field'))
            if root.get('exitCode') is not None and type(root.get('exitCode')) is not int:
                failures.append(ValueError('invalid root exit code type'))
            expected_root = {'exitCode': None, 'signal': 'KILL'} if selected in ('A2', 'A3') else {'exitCode': 0}
            if any(root.get(key) != value for key, value in expected_root.items()) or ('signal' not in expected_root and 'signal' in root):
                failures.append(ValueError('unexpected original root outcome'))
        self.record('protocol-audit', case=selected, acknowledged=not failures, errors=[repr(error) for error in failures], counts={kind: kinds.count(kind) for kind in set(kinds)})
        failures.extend(self.evidence_errors)
        if failures:
            raise CleanupIncomplete('complete protocol audit failed', failures)
        print('ACTUAL_WORKER_PROTOCOL=acknowledged', flush=True)

    def snapshot_lineage(self, pid):
        pending = [(pid, None)]
        while pending:
            current, expected_parent = pending.pop()
            try:
                captured = identity(current)
                previous = self.owned.get(current)
                if previous is not None and captured['startTicks'] != previous['startTicks']:
                    self.record('owned-identity-no-longer-matches', pid=current)
                    continue
                if expected_parent is not None and captured['parentPid'] != expected_parent:
                    self.record('lineage-parent-no-longer-matches', pid=current, expectedParent=expected_parent)
                    continue
                if previous is None:
                    self.owned[current] = captured
                children = pathlib.Path('/proc/%d/task/%d/children' % (current, current)).read_text()
                pending.extend((int(value), current) for value in children.split())
            except (FileNotFoundError, ProcessLookupError):
                self.record('lineage-already-exited', pid=current)
        self.record('owned-identities', values=list(self.owned.values()))

    def wait(self, kind, timeout=10):
        frame = super().wait(kind, timeout)
        if self.protocol_errors:
            raise CleanupIncomplete('invalid raw protocol before requested frame', self.protocol_errors)
        self.record('frame-observed', frame=frame)
        if kind == 'hello' and frame['workerPid'] != self.process.pid:
            raise CleanupIncomplete('hello does not identify original Popen')
        if kind == 'started':
            self.snapshot_lineage(self.process.pid)
            self.record('launcher-started', pid=frame['pid'])
        return frame

    def close(self):
        if self.cleanup_done:
            if self.cleanup_error:
                raise self.cleanup_error
            return
        errors = []
        process = self.process
        if process is None:
            self.cleanup_done = True
            return
        self.record('cleanup-begin', pid=process.pid)
        try:
            self.snapshot_lineage(process.pid)
        except BaseException as error:
            errors.append(('lineage', repr(error)))
        # Do not poll/reap from another thread. The held Popen remains the only
        # harness reaping authority; timeout waits are fixture failure guards.
        if process.returncode is None and not process.stdin.closed:
            try:
                self.send('shutdown')
                self.record('shutdown-sent')
            except BaseException as error:
                errors.append(('shutdown', repr(error)))
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.record('shutdown-deadline-failure')
            errors.append(('deadline', 'shutdown did not acknowledge within 5s'))
            try:
                if not process.stdin.closed:
                    self.send('cancel')
                    self.record('cancel-sent')
            except BaseException as error:
                errors.append(('cancel', repr(error)))
            try:
                if not process.stdin.closed:
                    process.stdin.close()
                    self.record('control-eof-closed')
            except BaseException as error:
                errors.append(('control-eof', repr(error)))
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    # Only the original unreaped child; full identity check
                    # immediately before any forced signal, never a PID guess.
                    captured = identity(process.pid)
                    original_identity = self.owned.get(process.pid)
                    if original_identity is None or captured != original_identity:
                        raise CleanupIncomplete('forced cleanup identity mismatch')
                    self.record('forced-original-worker-kill', identity=captured)
                    self.forced = True
                    with self.process_lock:
                        if process.returncode is None:
                            os.kill(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                except BaseException as error:
                    errors.append(('forced-cleanup', repr(error)))
        except BaseException as error:
            errors.append(('wait', repr(error)))
        if process.returncode is not None:
            self.watchdog_stop.set()
        if self.watchdog is not None and self.watchdog.ident is not None:
            self.watchdog.join(timeout=2)
            if self.watchdog.is_alive():
                errors.append(('watchdog', 'original failure guard remains live'))
        if self.watchdog_expired.is_set():
            errors.append(('watchdog-deadline', 'session deadline latched failure'))
        errors.extend(('watchdog-error', repr(error)) for error in self.watchdog_errors)
        for label, thread in (('stdout', getattr(self, 'reader', None)), ('stderr', self.stderr_reader)):
            if thread is not None and thread.ident is not None:
                thread.join(timeout=2)
                if thread.is_alive():
                    errors.append((label, 'reader EOF not acknowledged'))
        survivors = []
        for pid, captured in self.owned.items():
            try:
                current = identity(pid)
                if current['startTicks'] == captured['startTicks']:
                    survivors.append(current)
            except (FileNotFoundError, ProcessLookupError):
                pass
            except BaseException as error:
                errors.append(('identity-check', repr(error)))
        if survivors:
            errors.append(('owned-survivors', survivors))
        if process.returncode != 0:
            errors.append(('worker-exit', process.returncode))
        if self.forced:
            errors.append(('forced-exit', 'forced cleanup never makes a passing case'))
        for path, body in ((self.evidence, json.dumps(getattr(self, 'frames', []), indent=2).encode()),
                           (self.evidence.with_suffix('.stderr'), bytes(self.stderr_bytes)),
                           (self.evidence.with_suffix('.raw.jsonl'), b''.join(self.raw_lines))):
            try:
                path.write_bytes(body)
            except BaseException as error:
                errors.append(('evidence', repr(error)))
        if process.returncode is not None:
            readers = {'stdout': getattr(self, 'reader', None), 'stderr': self.stderr_reader}
            for name in ('stdin', 'stdout', 'stderr'):
                stream = getattr(process, name)
                thread = readers.get(name)
                if thread is not None and thread.is_alive():
                    errors.append(('retained-stream', name))
                    continue
                try:
                    stream.close()
                except BaseException as error:
                    errors.append(('stream-close', repr(error)))
        self.cleanup_done = True
        errors.extend(('evidence-write', repr(error)) for error in self.evidence_errors)
        self.record('cleanup-outcome', acknowledged=not errors, forced=self.forced, errors=errors, workerExit=process.returncode)
        if errors:
            self.cleanup_error = CleanupIncomplete(repr(errors))
            raise self.cleanup_error
        print('ACTUAL_WORKER_CLEANUP=acknowledged', flush=True)

class ActualWorkerCases(original.WorkerTests):
    def setUp(self):
        parent = original.REPO / '.tmp'
        parent.mkdir(exist_ok=True)
        self.fixture = pathlib.Path(tempfile.mkdtemp(prefix='wsl-actual-exit-', dir=parent))
        print('ACTUAL_WORKER_FIXTURE=' + str(self.fixture), flush=True)
        self.work, self.sibling, self.reference = [self.fixture / name for name in ('work', 'sibling', 'reference')]
        for path in (self.work, self.sibling, self.reference):
            path.mkdir()
        (self.reference / 'sentinel').write_text('reference')
        self.session = GuardedSession(self.fixture / 'frames.json')
        self.addCleanup(self.session.close)

    def capture_owned_pids(self, launcher):
        captured = super().capture_owned_pids(launcher)
        # Original existing case remains the PID/start-time oracle; also retain
        # its current original worker lineage for the outer cleanup guard.
        self.session.snapshot_lineage(self.session.process.pid)
        return captured

def main():
    if sys.argv[1:] == ['--source-check']:
        print('ACTUAL_WORKER_SOURCE_CHECK=' + ','.join(CASES), flush=True)
        return 0
    if len(sys.argv) != 3 or sys.argv[1] not in CASES or sys.argv[2] != '--allow-actual-current-worker':
        raise SystemExit('requires named A0-A4 and explicit --allow-actual-current-worker')
    selected = sys.argv[1]
    print('ACTUAL_WORKER_CASE=' + selected, flush=True)
    case = ActualWorkerCases(CASES[selected])
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([case]))
    if not result.wasSuccessful():
        return 1  # No success-only audit after failed setup/body/cleanup.
    try:
        case.session.audit(selected)
    except BaseException as error:
        print('ACTUAL_WORKER_PROTOCOL=failed:' + repr(error), file=sys.stderr, flush=True)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
