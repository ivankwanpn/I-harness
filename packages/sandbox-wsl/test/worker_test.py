"""Real Ubuntu worker tests. Fixtures and raw frames are intentionally preserved."""
import base64
import hashlib
import json
import os
import pathlib
import queue
import subprocess
import tempfile
import threading
import time
import unittest

REPO = pathlib.Path(__file__).resolve().parents[3]
WORKER = REPO / "packages/sandbox-wsl/worker/runner.py"
BOOTSTRAP = """import sys,json,base64,hashlib
b=json.loads(sys.stdin.buffer.readline(262145))
s=base64.b64decode(b['source'],validate=True)
assert b['v']==1 and hashlib.sha256(s).hexdigest()==b['sha256']
exec(compile(s,'<captured-worker>','exec'),{'__name__':'__main__','IH_WSL_NONCE':b['nonce'],'IH_WSL_SHA256':b['sha256']})
"""


def windows(path):
    return subprocess.check_output(['/usr/bin/wslpath', '-w', str(path)], text=True).strip()


class Session:
    def __init__(self, evidence, start_reader=True):
        self.nonce = 'worker-test-' + os.urandom(12).hex()
        self.frames = []
        self.messages = queue.Queue()
        self.evidence = evidence
        source = WORKER.read_bytes() if WORKER.exists() else b''
        self.digest = hashlib.sha256(source).hexdigest()
        self.process = subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-u', '-c', BOOTSTRAP],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        self.process.stdin.write((json.dumps({'v': 1, 'nonce': self.nonce, 'source': base64.b64encode(source).decode(),
                                              'sha256': self.digest}) + '\n').encode())
        self.process.stdin.flush()
        def reader():
            for line in self.process.stdout:
                try:
                    frame = json.loads(line)
                    self.frames.append(frame)
                    self.messages.put(frame)
                except Exception:
                    self.messages.put({'type': 'invalid', 'line': repr(line)})
            self.messages.put({'type': 'EOF'})
        self.reader = threading.Thread(target=reader, daemon=True)
        if start_reader:
            self.reader.start()

    def send(self, kind, **fields):
        self.process.stdin.write((json.dumps({'v': 1, 'nonce': self.nonce, 'type': kind, **fields}) + '\n').encode())
        self.process.stdin.flush()

    def wait(self, kind, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                frame = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError('Missing ' + kind) from None
            if frame['type'] == kind:
                return frame
            if frame['type'] in ('error', 'EOF', 'invalid'):
                raise AssertionError('Expected %s, received %s' % (kind, frame))
        raise AssertionError('Missing ' + kind)

    def output(self, channel='stdout'):
        return b''.join(base64.b64decode(f['data']) for f in self.frames
                        if f['type'] == 'output' and f['channel'] == channel)

    def close(self):
        if self.process.stdout.closed:
            return
        if self.process.poll() is None and not self.process.stdin.closed:
            self.send('shutdown')
        self.process.wait(timeout=10)
        if self.reader.ident is not None:
            self.reader.join(timeout=2)
        self.evidence.write_text(json.dumps(self.frames, indent=2))
        self.evidence.with_suffix('.stderr').write_bytes(self.process.stderr.read())
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = pathlib.Path(tempfile.mkdtemp(prefix='wsl2-worker-', dir=REPO / '.tmp'))
        self.work = self.fixture / 'work'
        self.sibling = self.fixture / 'sibling'
        self.reference = self.fixture / 'reference'
        self.work.mkdir()
        self.reference.mkdir(parents=True)
        self.sibling.mkdir()
        (self.reference / 'sentinel').write_text('reference')
        self.session = Session(self.fixture / 'frames.json')
        self.addCleanup(lambda: self.session.close())

    def hello(self):
        frame = self.session.wait('hello')
        self.assertEqual(frame['sha256'], self.session.digest)
        self.assertEqual(frame['nonce'], self.session.nonce)
        self.assertGreater(frame['workerPid'], 0)

    def prepare(self, script, mode='workspace-write', env=None, argv=None):
        owner = {'sessionId': 'worker-test'}
        spec = {'argv': argv or ['/bin/bash', '-c', script], 'cwd': windows(self.work),
                'env': env or {'PATH': '/usr/bin:/bin', 'LANG': 'C'}, 'owner': owner,
                'transport': 'pipe', 'lifetime': 'complete-tree', 'argumentEncoding': 'crt'}
        policy = {'mode': mode, 'owner': owner, 'authorityRevision': 'test-1', 'authorityKind': 'bound',
                  'primaryRoot': windows(self.work), 'readable': 'caller', 'authorityRoots': [windows(self.work)],
                  'writeRoots': [windows(self.work)] if mode == 'workspace-write' else [],
                  'referenceRoots': [windows(self.reference)], 'fingerprint': 'worker-test-fingerprint'}
        self.session.send('prepare', spec=spec, policy=policy)
        return spec, policy

    def test_dynamic_loader_environment_cannot_write_before_sandbox(self):
        self.hello()
        self.prepare('printf %s "$ORDINARY_VALUE"', env={
            'PATH': '/usr/bin:/bin', 'LD_DEBUG': 'libs',
            'LD_DEBUG_OUTPUT': str(self.sibling / 'loader-log'), 'ORDINARY_VALUE': 'inside-only'})
        self.session.wait('prepared')
        self.session.send('commit')
        self.session.wait('started')
        self.session.wait('root')
        self.session.wait('settled')
        self.assertEqual(list(self.sibling.glob('loader-log*')), [])
        self.assertIn(b'inside-only', self.session.output())

    def test_lowercased_windows_policy_matches_same_directory_identity(self):
        self.hello()
        owner = {'sessionId': 'worker-test'}
        spec = {'argv': ['/bin/bash', '-c', 'touch marker'], 'cwd': windows(self.work),
                'env': {'PATH': '/usr/bin:/bin'}, 'owner': owner, 'transport': 'pipe',
                'lifetime': 'complete-tree', 'argumentEncoding': 'crt'}
        policy = {'mode': 'workspace-write', 'owner': owner, 'authorityRevision': 'test', 'authorityKind': 'bound',
                  'primaryRoot': windows(self.work).lower(), 'readable': 'caller',
                  'authorityRoots': [windows(self.work).lower()], 'writeRoots': [windows(self.work).lower()],
                  'referenceRoots': [windows(self.reference).lower()], 'fingerprint': 'case-policy'}
        self.session.send('prepare', spec=spec, policy=policy)
        self.session.wait('prepared')
        self.session.send('commit')
        self.session.wait('started')
        self.assertEqual(self.session.wait('root')['exitCode'], 0)
        self.session.wait('settled')
        self.assertTrue((self.work / 'marker').exists())

    def test_case_sensitive_distinct_linux_directories_do_not_share_authority(self):
        # Actual Linux dirs live only in the private namespace tmpfs; production helpers
        # run from captured source without modifying any host directory case settings.
        source = base64.b64encode(WORKER.read_bytes()).decode()
        script = """import base64,json,os,types
module={'__name__':'worker_case_test'}
exec(compile(base64.b64decode(%r),'<captured-worker>','exec'),module)
os.mkdir('/tmp/Case');os.mkdir('/tmp/case')
entries=[]
for path in ('/tmp/Case','/tmp/case'):
 fd=os.open(path,os.O_PATH|os.O_DIRECTORY)
 try:
  canonical,ancestors=module['canonical_directory'](fd)
  entries.append(types.SimpleNamespace(identity=module['Directory'].key(os.fstat(fd)),ancestors=ancestors,physical=canonical))
 finally: os.close(fd)
print(json.dumps({'different':entries[0].physical!=entries[1].physical,'contains':module['directory_contains'](*entries)}))
""" % source
        self.run_command('', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(json.loads(self.session.output()), {'different': True, 'contains': False})

    def test_prelaunch_refusal_acknowledges_cleanup_without_root(self):
        self.hello()
        self.prepare('touch marker', mode='danger-full-access')
        self.session.wait('refused')
        self.session.wait('settled')
        self.assertEqual(self.session.process.wait(timeout=10), 0)
        self.assertFalse(any(f['type'] in ('started', 'root', 'error') for f in self.session.frames))

    def test_commit_refusal_precedes_settlement_without_root(self):
        self.hello()
        self.prepare('touch marker')
        self.session.wait('prepared')
        self.work.rename(self.fixture / 'original-work')
        self.work.mkdir()
        self.session.send('commit')
        self.session.wait('refused')
        self.session.wait('settled')
        self.assertEqual(self.session.process.wait(timeout=10), 0)
        self.assertFalse(any(f['type'] in ('started', 'root', 'error') for f in self.session.frames))

    def run_command(self, script, mode='workspace-write', argv=None):
        self.hello()
        self.prepare(script, mode, argv=argv)
        self.session.wait('prepared')
        self.session.send('commit')
        self.session.wait('started')
        root = self.session.wait('root')
        self.session.wait('settled')
        return root

    # Missing preparation fencing would execute this fixture marker before commit.
    def test_prepare_runs_nothing_and_bash_pipeline_and_nested_child_run_on_commit(self):
        self.hello()
        self.prepare("touch marker; printf HELLO | /bin/cat; /bin/bash -c 'printf NESTED'; printf ERR >&2; exit 7")
        self.session.wait('prepared')
        time.sleep(0.1)
        self.assertFalse((self.work / 'marker').exists())
        self.session.send('commit')
        self.session.wait('started')
        self.assertEqual(self.session.wait('root')['exitCode'], 7)
        self.session.wait('settled')
        self.assertTrue((self.work / 'marker').exists())
        self.assertEqual(self.session.output(), b'HELLONESTED')
        self.assertEqual(self.session.output('stderr'), b'ERR')

    def test_probe_checks_actual_isolation_startup(self):
        self.hello()
        self.session.send('probe')
        self.assertTrue(self.session.wait('probe')['available'])

    def test_read_only_denies_workspace_sibling_and_reference(self):
        self.run_command('touch marker; touch %s; echo changed > %s; true' % (self.sibling / 'denied', self.reference / 'sentinel'), 'read-only')
        self.assertFalse((self.work / 'marker').exists())
        self.assertFalse((self.sibling / 'denied').exists())
        self.assertEqual((self.reference / 'sentinel').read_text(), 'reference')

    def test_workspace_write_denies_sibling_and_reference(self):
        self.run_command('touch marker; touch %s; echo changed > %s; true' % (self.sibling / 'denied', self.reference / 'sentinel'))
        self.assertTrue((self.work / 'marker').exists())
        self.assertFalse((self.sibling / 'denied').exists())
        self.assertEqual((self.reference / 'sentinel').read_text(), 'reference')

    def test_existing_hardlink_into_reference_is_refused_without_external_changes(self):
        self.hello()
        os.link(self.reference / 'sentinel', self.work / 'alias')
        self.prepare('printf changed > alias')
        self.assertIn('hardlink', self.session.wait('refused')['detail'])
        self.assertEqual((self.reference / 'sentinel').read_text(), 'reference')
        self.assertFalse(any(f['type'] == 'started' for f in self.session.frames))

    def test_hardlink_added_after_prepare_is_refused_at_commit(self):
        self.hello()
        (self.sibling / 'sentinel').write_text('sibling')
        self.prepare('printf changed > alias')
        self.session.wait('prepared')
        os.link(self.sibling / 'sentinel', self.work / 'alias')
        self.session.send('commit')
        self.assertIn('hardlink', self.session.wait('refused')['detail'])
        self.assertEqual((self.sibling / 'sentinel').read_text(), 'sibling')
        self.assertFalse(any(f['type'] == 'started' for f in self.session.frames))

    def test_changed_inventory_is_refused_at_commit(self):
        self.hello()
        self.prepare('touch marker')
        self.session.wait('prepared')
        (self.work / 'new-file').write_text('changed after prepare')
        self.session.send('commit')
        self.assertIn('inventory', self.session.wait('refused')['detail'])
        self.assertFalse((self.work / 'marker').exists())

    def test_excessive_inventory_depth_is_refused(self):
        self.hello()
        directory = self.work
        for _ in range(33):
            directory = directory / 'd'
            directory.mkdir()
        self.prepare('touch marker')
        self.assertIn('inventory', self.session.wait('refused')['detail'])
        self.assertFalse((self.work / 'marker').exists())

    def test_workload_cannot_create_hardlink_from_readonly_mount(self):
        script = """import errno,json,os
try:
 os.link(%r,'new-alias'); result=False
except OSError as error:
 result=error.errno in (errno.EXDEV,errno.EROFS,errno.EPERM)
print(json.dumps(result))
""" % str(self.reference / 'sentinel')
        self.run_command('', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(json.loads(self.session.output()), True)
        self.assertEqual((self.reference / 'sentinel').read_text(), 'reference')
        self.assertFalse((self.work / 'new-alias').exists())

    def test_binary_and_json_output_cannot_inject_protocol(self):
        payload = b'\x00\xff\n{"v":1,"type":"settled"}\n'
        script = 'import os;os.write(1,%r)' % payload
        self.run_command('', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(self.session.output(), payload)
        self.assertEqual(sum(f['type'] == 'settled' for f in self.session.frames), 1)

    def test_interop_unix_socket_and_io_uring_are_denied(self):
        script = """import ctypes,errno,json,os,socket,subprocess
results={}
try: socket.socket(socket.AF_UNIX); results['unix']=False
except OSError as e: results['unix']=e.errno==errno.EPERM
libc=ctypes.CDLL(None,use_errno=True)
results['uring']=libc.syscall(425,0,0)==-1 and ctypes.get_errno()==errno.EPERM
results['nnp']=libc.prctl(39,0,0,0,0)==1
results['masked']=not os.access('/init',os.X_OK) and not os.listdir('/run/WSL')
try: subprocess.run(['/mnt/c/Windows/System32/cmd.exe','/c','exit','0'],check=True);results['interop']=False
except (OSError,subprocess.CalledProcessError): results['interop']=True
print(json.dumps(results))
"""
        self.run_command('', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(json.loads(self.session.output()), {'unix': True, 'uring': True, 'interop': True, 'nnp': True, 'masked': True})

    def test_changed_directory_identity_refuses_commit(self):
        self.hello()
        self.prepare('touch marker')
        self.session.wait('prepared')
        self.work.rename(self.fixture / 'original-work')
        self.work.mkdir()
        self.session.send('commit')
        self.assertIn('identity', self.session.wait('refused')['detail'])
        self.assertFalse((self.work / 'marker').exists())

    def test_moved_parent_and_symlink_cannot_retain_stale_authority(self):
        self.hello()
        writable = self.work / 'parent' / 'write'
        writable.mkdir(parents=True)
        (writable / 'sentinel').write_text('protected')
        owner = {'sessionId': 'worker-test'}
        spec = {'argv': ['/bin/bash', '-c', 'printf changed > sentinel'], 'cwd': windows(writable),
                'env': {'PATH': '/usr/bin:/bin'}, 'owner': owner, 'transport': 'pipe',
                'lifetime': 'complete-tree', 'argumentEncoding': 'crt'}
        policy = {'mode': 'workspace-write', 'owner': owner, 'authorityRevision': 'test', 'authorityKind': 'bound',
                  'primaryRoot': windows(self.work), 'readable': 'caller', 'authorityRoots': [windows(self.work)],
                  'writeRoots': [windows(writable)], 'referenceRoots': [windows(self.reference)], 'fingerprint': 'move-policy'}
        self.session.send('prepare', spec=spec, policy=policy)
        self.session.wait('prepared')
        (self.work / 'parent').rename(self.sibling / 'parent')
        os.symlink(self.sibling / 'parent', self.work / 'parent', target_is_directory=True)
        self.session.send('commit')
        self.assertIn('identity', self.session.wait('refused')['detail'])
        self.session.wait('settled')
        self.assertEqual((self.sibling / 'parent' / 'write' / 'sentinel').read_text(), 'protected')
        self.assertFalse(any(f['type'] in ('started', 'root') for f in self.session.frames))

    def test_linux_directory_validation_rejects_same_inode_moved_ancestry(self):
        # DrvFS can invalidate descendant FDs on parent rename. Exercise Linux's
        # unchanged inode behavior in private tmpfs with the real validation method.
        source = base64.b64encode(WORKER.read_bytes()).decode()
        script = """import base64,json,os
module={'__name__':'worker_ancestry_test'}
exec(compile(base64.b64decode(%r),'<captured-worker>','exec'),module)
os.makedirs('/tmp/A/parent/write');os.mkdir('/tmp/S')
captured=module['Directory'].__new__(module['Directory'])
captured.fd=os.open('/tmp/A/parent/write',os.O_PATH|os.O_DIRECTORY)
captured.mapped='/tmp/A/parent/write'
captured.identity=captured.key(os.fstat(captured.fd))
captured.physical,captured.ancestors=module['canonical_directory'](captured.fd)
try:
 os.rename('/tmp/A/parent','/tmp/S/parent');os.symlink('/tmp/S/parent','/tmp/A/parent')
 same_inode=captured.key(os.stat(captured.mapped))==captured.identity
 refused=False
 try: captured.validate()
 except module['Refusal']: refused=True
 print(json.dumps({'same_inode':same_inode,'refused':refused}))
finally: captured.close()
""" % source
        self.run_command('', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(json.loads(self.session.output()), {'same_inode': True, 'refused': True})

    def descendants(self):
        # Each child detaches and tries a late controlled write after cancellation/root exit.
        return "/usr/bin/setsid /bin/bash -c 'sleep 1.2; touch detached-late' & /bin/bash -c 'sleep 1.2; touch ordinary-late' & sleep 0.1; printf READY; "

    def capture_owned_pids(self, launcher):
        found, pending = {}, [launcher]
        while pending:
            pid = pending.pop()
            try:
                info = pathlib.Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
                found[pid] = info[19]  # starttime disambiguates PID reuse.
                pending.extend(int(value) for value in pathlib.Path('/proc/%d/task/%d/children' % (pid, pid)).read_text().split())
            except FileNotFoundError:
                pass
        self.assertGreaterEqual(len(found), 4, 'Both real descendant trees must exist before cancellation')
        (self.fixture / 'owned-pids.json').write_text(json.dumps(found))
        return found

    def assert_owned_pids_gone(self, owned):
        survivors = []
        for pid, identity in owned.items():
            try:
                info = pathlib.Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
                if info[19] == identity:
                    survivors.append((pid, info[0]))
            except FileNotFoundError:
                pass
        self.assertEqual(survivors, [])

    def test_cancel_tears_down_detached_descendants_before_settled(self):
        self.hello()
        self.prepare(self.descendants() + 'sleep 30')
        self.session.wait('prepared')
        self.session.send('commit')
        started = self.session.wait('started')
        self.session.wait('output')
        owned = self.capture_owned_pids(started['pid'])
        self.session.send('cancel')
        self.session.wait('root')
        self.session.wait('settled')
        self.assert_owned_pids_gone(owned)
        time.sleep(1.4)
        self.assertFalse((self.work / 'detached-late').exists())
        self.assertFalse((self.work / 'ordinary-late').exists())

    def test_root_exit_tears_down_detached_descendants(self):
        self.run_command(self.descendants() + 'exit 0')
        time.sleep(1.4)
        self.assertFalse((self.work / 'detached-late').exists())

    def test_control_eof_tears_down_detached_descendants(self):
        self.hello()
        self.prepare(self.descendants() + 'sleep 30')
        self.session.wait('prepared')
        self.session.send('commit')
        started = self.session.wait('started')
        self.session.wait('output')
        owned = self.capture_owned_pids(started['pid'])
        self.session.process.stdin.close()
        self.session.wait('root')
        self.session.wait('settled')
        self.assert_owned_pids_gone(owned)
        self.session.process.wait(timeout=10)
        time.sleep(1.4)
        self.assertFalse((self.work / 'detached-late').exists())

    def test_command_stdin_is_separate_from_control(self):
        self.hello()
        self.prepare('/bin/cat')
        self.session.wait('prepared')
        self.session.send('commit')
        self.session.wait('started')
        payload = b'{"type":"shutdown"}\x00\xff'
        self.session.send('input', data=base64.b64encode(payload).decode())
        self.session.send('endInput')
        self.session.wait('root')
        self.session.wait('settled')
        self.assertEqual(self.session.output(), payload)

    def test_interop_environment_is_refused_before_launch(self):
        self.hello()
        self.prepare('touch marker', env={'WSL_INTEROP': '/run/WSL/123_interop'})
        self.session.wait('refused')
        self.assertFalse((self.work / 'marker').exists())

    def test_boolean_version_is_not_protocol_version_one(self):
        self.hello()
        self.session.process.stdin.write((json.dumps({'v': True, 'nonce': self.session.nonce, 'type': 'probe'}) + '\n').encode())
        self.session.process.stdin.flush()
        self.session.wait('error')

    def test_duplicate_protocol_fields_are_refused(self):
        self.hello()
        raw = '{"v":1,"nonce":%s,"type":"shutdown","type":"probe"}\n' % json.dumps(self.session.nonce)
        self.session.process.stdin.write(raw.encode())
        self.session.process.stdin.flush()
        self.session.wait('error')

    def test_oversized_frame_is_refused_without_execution(self):
        self.hello()
        self.session.process.stdin.write(b'x' * (256 * 1024) + b'\n')
        self.session.process.stdin.flush()
        self.session.wait('error')

    def test_mount_descriptors_are_not_inherited_by_command(self):
        script = """import os,stat
leaks=[]
for name in os.listdir('/proc/self/fd'):
 try:
  target=os.readlink('/proc/self/fd/'+name)
  if stat.S_ISDIR(os.stat('/proc/self/fd/'+name).st_mode): leaks.append(target)
 except OSError: pass
print(len(leaks))
"""
        self.run_command('', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(self.session.output(), b'0\n')

    def test_read_only_cannot_reopen_host_mount_through_inherited_descriptors(self):
        script = """import os,stat
escaped=False
for name in os.listdir('/proc/self/fd'):
 try:
  path='/proc/self/fd/'+name
  target=os.readlink(path)
  if not stat.S_ISDIR(os.stat(path).st_mode): continue
  allowed=%r
  if target=='/': relative=allowed.lstrip('/')
  elif allowed==target: relative=''
  elif allowed.startswith(target.rstrip('/')+'/'): relative=allowed[len(target):].lstrip('/')
  else: continue
  with open(path+'/'+relative+'/descriptor-escape','w') as f: f.write('escape')
  escaped=True
 except OSError: pass
print(escaped)
""" % str(self.work)
        self.run_command('', mode='read-only', argv=['/usr/bin/python3', '-I', '-c', script])
        self.assertEqual(self.session.output(), b'False\n')
        self.assertFalse(any(self.fixture.rglob('descriptor-escape')))

    def test_output_backpressure_cancels_with_sanitized_error_and_drains(self):
        self.hello()
        self.session.close()
        self.session = Session(self.fixture / 'overflow-frames.json', start_reader=False)
        # Consume startup directly, then stop reading output while the workload floods.
        frame = json.loads(self.session.process.stdout.readline())
        self.assertEqual(frame['type'], 'hello')
        self.prepare('', argv=['/usr/bin/python3', '-I', '-c', "import os;os.write(1,b'X'*(32*1024*1024))"])
        self.assertEqual(json.loads(self.session.process.stdout.readline())['type'], 'prepared')
        self.session.send('commit')
        self.assertEqual(json.loads(self.session.process.stdout.readline())['type'], 'started')
        time.sleep(0.5)
        self.session.reader.start()
        self.assertIn('overflow', self.session.wait('error')['detail'])
        self.session.wait('root')
        self.session.wait('settled')
        self.session.process.wait(timeout=10)
        self.assertNotIn(b'Traceback', self.session.process.stderr.read())

    def test_workspace_tmp_is_private(self):
        self.run_command('touch /tmp/ih-worker-private-test; test -f /tmp/ih-worker-private-test')
        self.assertEqual(next(f['exitCode'] for f in self.session.frames if f['type'] == 'root'), 0)

    def test_read_only_has_no_writable_temp(self):
        self.run_command('touch /tmp/ih-worker-private-test', 'read-only')
        self.assertNotEqual(next(f['exitCode'] for f in self.session.frames if f['type'] == 'root'), 0)



if __name__ == '__main__':
    unittest.main(verbosity=2)
