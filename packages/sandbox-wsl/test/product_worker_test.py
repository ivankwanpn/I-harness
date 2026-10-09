"""Product regression fixtures and evidence stay in repository-owned task directories."""
import json
import os
import pathlib
import tempfile
import time
import unittest
import sys
import socket
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from worker_test import WorkerTests, Session, WORKER, REPO, windows


class ProductWorkerTests(WorkerTests):
    def setUp(self):
        self.fixture = pathlib.Path(tempfile.mkdtemp(prefix='wsl-product-engine-', dir=REPO / '.tmp'))
        self.work, self.sibling, self.reference = [self.fixture / x for x in ('work', 'sibling', 'reference')]
        for path in (self.work, self.sibling, self.reference): path.mkdir()
        (self.reference / 'sentinel').write_text('reference')
        self.session = Session(self.fixture / 'frames.json')
        self.addCleanup(lambda: self.session.close())

    def test_internal_hardlinks_are_admitted_and_external_aliases_refused(self):
        module = self.worker_module()
        (self.work / 'a').write_text('data')
        os.link(self.work / 'a', self.work / 'b')
        root = module['Directory'](windows(self.work))
        try:
            self.assertEqual(len(module['write_inventory']([root])), 64)
            os.link(self.work / 'a', self.sibling / 'outside')
            with self.assertRaisesRegex(module['Refusal'], 'hardlink'):
                module['write_inventory']([root])
        finally: root.close()

    def test_desktop_project_prepares_with_finite_inventory_budget(self):
        self.hello()
        owner = {'sessionId': 'worker-test'}
        root = windows(REPO / 'packages/desktop')
        spec = {'argv': ['/bin/true'], 'cwd': root, 'env': {'PATH': '/usr/bin:/bin'},
                'owner': owner, 'transport': 'pipe', 'lifetime': 'complete-tree', 'argumentEncoding': 'crt'}
        policy = {'mode': 'workspace-write', 'owner': owner, 'authorityRevision': 'r', 'authorityKind': 'bound',
                  'primaryRoot': root, 'readable': 'caller', 'authorityRoots': [root], 'writeRoots': [root],
                  'referenceRoots': [], 'fingerprint': 'desktop-product'}
        started = time.monotonic()
        self.session.send('prepare', spec=spec, policy=policy)
        prepared = self.session.wait('prepared', timeout=60)
        self.assertLess(time.monotonic() - started, 60)
        self.assertGreater(prepared.get('inventoryEntries',0),4096)
        preparation_seconds=time.monotonic()-started
        commit_started=time.monotonic()
        self.session.send('commit')
        self.session.wait('started',timeout=60)
        commit_seconds=time.monotonic()-commit_started
        self.assertEqual(self.session.wait('root')['exitCode'],0)
        self.session.wait('settled')
        (self.fixture / 'timing.json').write_text(json.dumps({'prepareSeconds':preparation_seconds,
            'commitSeconds':commit_seconds,'entries':prepared['inventoryEntries'],'directories':prepared['inventoryDirectories']}))

    def test_full_access_writes_caller_sibling_without_reference_locks(self):
        self.hello()
        spec, policy = self.prepare('true', mode='read-only')
        self.session.wait('prepared')
        self.session.close()
        self.session = Session(self.fixture / 'full-frames.json')
        self.hello()
        spec['argv'] = ['/bin/bash', '-c', 'touch '+str(self.sibling / 'allowed')]
        policy['mode'], policy['referenceRoots'] = 'danger-full-access', []
        self.session.send('prepare', spec=spec, policy=policy)
        self.session.wait('prepared')
        self.session.send('commit')
        self.session.wait('started')
        self.assertEqual(self.session.wait('root')['exitCode'], 0)
        self.session.wait('settled')
        self.assertTrue((self.sibling / 'allowed').exists())

    def test_network_option_changes_namespace_while_unix_sockets_remain_denied(self):
        self.hello()
        module = self.worker_module()
        prepared = type('P', (), {'mode':'workspace-write','env':{},'writes':[], 'references':[],
                                'cwd':type('D', (), {'physical':str(self.work)})(), 'argv':['/bin/true'], 'network_access':True})()
        self.assertIn('--share-net', module['command'](prepared, 10, 11))
        prepared.network_access = False
        self.assertNotIn('--share-net', module['command'](prepared, 10, 11))
        prepared.mode = 'danger-full-access'
        self.assertIn('--share-net', module['command'](prepared, 10, 11))

    def test_cancel_during_preparation_is_acknowledged_promptly(self):
        self.hello()
        for directory in range(80):
            target = self.work / str(directory)
            target.mkdir()
            for number in range(60): (target / str(number)).write_text('inventory')
        self.prepare('touch should-never-run')
        self.session.wait('progress')
        started = time.monotonic()
        self.session.send('shutdown')
        self.session.wait('settled', timeout=3)
        self.assertLess(time.monotonic()-started, 3)
        self.assertFalse(any(frame['type'] in ('started', 'error') for frame in self.session.frames))
        self.assertFalse((self.work / 'should-never-run').exists())

    def product_prepare(self, argv, mode='workspace-write', network=False, runtime_path=None):
        owner={'sessionId':'worker-test'}
        root=windows(self.work)
        spec={'argv':argv,'cwd':root,'env':{'PATH':'/usr/bin:/bin'},'owner':owner,
              'transport':'pipe','lifetime':'complete-tree','argumentEncoding':'crt'}
        policy={'mode':mode,'owner':owner,'authorityRevision':'r','authorityKind':'bound',
                'primaryRoot':root,'readable':'caller','authorityRoots':[root],
                'writeRoots':[root] if mode=='workspace-write' else [],'referenceRoots':[], 'fingerprint':'product-test'}
        self.session.send('prepare',spec=spec,policy=policy,configuration={'networkAccess':network,'runtimePath':runtime_path or []})
        self.session.wait('prepared',timeout=60)
        self.session.send('commit')
        self.session.wait('started',timeout=60)
        root=self.session.wait('root')
        self.session.wait('settled')
        return root

    def test_confined_network_off_and_opt_in_on_full_on_with_unix_denial(self):
        listener=socket.socket(socket.AF_INET)
        listener.bind(('127.0.0.1',0));listener.listen()
        self.addCleanup(listener.close)
        port=listener.getsockname()[1]
        script="""import errno,json,socket
r={}
s=socket.socket();s.settimeout(1)
try:s.connect(('127.0.0.1',%d));r['tcp']=True
except OSError:r['tcp']=False
finally:s.close()
try:socket.socket(socket.AF_UNIX);r['unixDenied']=False
except OSError as e:r['unixDenied']=e.errno==errno.EPERM
print(json.dumps(r))
""" % port
        for mode,network,expected in [('workspace-write',False,False),('read-only',False,False),
                                      ('workspace-write',True,True),('read-only',True,True),('danger-full-access',False,True)]:
            self.hello()
            self.product_prepare(['/usr/bin/python3','-I','-c',script],mode,network)
            self.assertEqual(json.loads(self.session.output()),{'tcp':expected,'unixDenied':True})
            self.session.close()
            self.session=Session(self.fixture / ('net-'+mode+'-'+str(network)+'.json'))
        self.hello()

    def test_captured_managed_runtime_is_readonly_and_on_task_path(self):
        self.assert_managed_runtime_readonly('workspace-write')

    def test_full_access_managed_runtime_is_readonly(self):
        self.assert_managed_runtime_readonly('danger-full-access')

    def test_full_access_keeps_interop_and_io_uring_protections(self):
        self.hello()
        script="""import ctypes,errno,json,os,socket
r={}
try:socket.socket(socket.AF_UNIX);r['unix']=False
except OSError as e:r['unix']=e.errno==errno.EPERM
libc=ctypes.CDLL(None,use_errno=True)
r['uring']=libc.syscall(425,0,0)==-1 and ctypes.get_errno()==errno.EPERM
r['masked']=not os.access('/init',os.X_OK) and not os.listdir('/run/WSL')
print(json.dumps(r))
"""
        self.product_prepare(['/usr/bin/python3','-I','-c',script],mode='danger-full-access')
        self.assertEqual(json.loads(self.session.output()),{'unix':True,'uring':True,'masked':True})

    def test_missing_or_escaping_managed_bin_refuses_preparation(self):
        self.hello()
        release=self.work / 'managed' / 'node'
        release.mkdir(parents=True)
        owner={'sessionId':'worker-test'}
        spec={'argv':['/bin/true'],'cwd':windows(self.work),'env':{},'owner':owner,
              'transport':'pipe','lifetime':'complete-tree','argumentEncoding':'crt'}
        policy={'mode':'read-only','owner':owner,'authorityRevision':'r','authorityKind':'bound',
                'primaryRoot':windows(self.work),'readable':'caller','authorityRoots':[windows(self.work)],
                'writeRoots':[],'referenceRoots':[],'fingerprint':'runtime-missing'}
        self.session.send('prepare',spec=spec,policy=policy,configuration={'runtimePath':[str(release / 'bin')]})
        self.session.wait('refused')
        self.assertFalse(any(f['type']=='prepared' for f in self.session.frames))
        self.session.close()
        self.session=Session(self.fixture / 'runtime-escaping-frames.json')
        self.hello()
        os.symlink(self.sibling,release / 'bin',target_is_directory=True)
        self.session.send('prepare',spec=spec,policy=policy,configuration={'runtimePath':[str(release / 'bin')]})
        self.assertIn('escapes',self.session.wait('refused')['detail'])
        self.assertFalse(any(f['type']=='prepared' for f in self.session.frames))

    def assert_managed_runtime_readonly(self, mode):
        self.hello()
        release=self.work / 'managed' / 'node'
        binaries=release / 'bin';binaries.mkdir(parents=True)
        executable=binaries / 'ih-test-runtime'
        executable.write_text('#!/bin/bash\nprintf MANAGED')
        executable.chmod(0o755)
        result=self.product_prepare(['/bin/bash','-c','ih-test-runtime; touch '+str(release / 'changed')+'; touch task-write'],mode=mode,runtime_path=[str(binaries)])
        self.assertEqual(result['exitCode'],0)
        self.assertEqual(self.session.output(),b'MANAGED')
        self.assertFalse((release / 'changed').exists())
        self.assertTrue((self.work / 'task-write').exists())


if __name__ == '__main__': unittest.main(verbosity=2)
