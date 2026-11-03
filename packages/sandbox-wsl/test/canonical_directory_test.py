"""Original selected-location proof, using private directories and injected syscalls only."""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('selected_worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
FIXTURE_ROOT = sys.argv[2]
REAL_CLOSE, REAL_OPEN, REAL_METADATA = os.close, os.open, worker.metadata


class SelectedLocationTests(unittest.TestCase):
    def setUp(self):
        # Linux case semantics; fresh six-root Windows evidence remains separate.
        self.temp = tempfile.TemporaryDirectory(prefix='selected-location-')
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.path = self.root + '/Selected'
        os.mkdir(self.path)
        os.mkdir(self.root + '/Other')
        self.fd = REAL_OPEN(self.path, os.O_PATH | os.O_DIRECTORY)
        self.addCleanup(REAL_CLOSE, self.fd)

    def test_selected_names_need_no_sibling_metadata_or_inode(self):
        original_scan = os.scandir
        class NamesOnly:
            def __init__(self, entry): self.name = entry.name
            def __getattr__(self, name): raise AssertionError('unselected entry metadata: ' + name)
        class Scan:
            def __init__(self, fd): self.scan = original_scan(fd)
            def __enter__(self): return (NamesOnly(entry) for entry in self.scan)
            def __exit__(self, *args): self.scan.close()
        def metadata(fd, name=''):
            if os.fsencode(name) == b'Other': raise PermissionError(13, 'controlled sibling denial')
            return REAL_METADATA(fd, name)
        with mock.patch.object(worker.os, 'scandir', side_effect=Scan), \
             mock.patch.object(worker.os, 'stat', side_effect=AssertionError('global sibling stat')), \
             mock.patch.object(worker, 'metadata', side_effect=metadata):
            physical, _ = worker.canonical_directory(self.fd)
        self.assertEqual(physical, self.path)

    def test_nonexact_case_hint_never_guesses(self):
        os.mkdir(self.root + '/selected')
        with mock.patch.object(worker.os, 'readlink', return_value=os.fsencode(self.root + '/selected')):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)

    def test_case_insensitive_open_cannot_replace_exact_enumerated_spelling(self):
        # Controlled DrvFS-style lookup: open would accept selected, but NAME is Selected.
        def open_fd(path, flags, *args, **kwargs):
            return REAL_OPEN(b'Selected' if os.fsencode(path) == b'selected' else path, flags, *args, **kwargs)
        with mock.patch.object(worker.os, 'readlink', return_value=os.fsencode(self.root + '/selected')), \
             mock.patch.object(worker.os, 'open', side_effect=open_fd):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)

    def test_same_object_sibling_selection_keeps_distinct_locations(self):
        physical, ancestry = worker.canonical_directory(self.fd)
        # Inject a second directory attachment with the same object. No mount/ACL operation.
        def open_fd(path, flags, *args, **kwargs):
            return REAL_OPEN(b'Selected' if os.fsencode(path) == b'Other' else path, flags, *args, **kwargs)
        def metadata(fd, name=''):
            return REAL_METADATA(fd, b'Selected' if os.fsencode(name) == b'Other' else name)
        with mock.patch.object(worker.os, 'readlink', return_value=os.fsencode(self.root + '/Other')), \
             mock.patch.object(worker.os, 'open', side_effect=open_fd), \
             mock.patch.object(worker, 'metadata', side_effect=metadata):
            alias_path, alias_ancestry = worker.canonical_directory(self.fd)
        a = types.SimpleNamespace(physical=physical, ancestors=ancestry, identity=worker.Directory.key(os.fstat(self.fd)))
        b = types.SimpleNamespace(physical=alias_path, ancestors=alias_ancestry, identity=a.identity)
        self.assertEqual(alias_path, self.root + '/Other')
        self.assertFalse(worker.directory_contains(a, b))
        self.assertTrue(worker.directory_object_contains(a, b))

    def test_exact_case_sensitive_locations_do_not_grant_each_other(self):
        os.mkdir(self.root + '/selected')
        a, b = worker.Directory(self.path, linux=True), worker.Directory(self.root + '/selected', linux=True)
        try:
            self.assertFalse(worker.directory_contains(a, b))
            self.assertFalse(worker.directory_contains(b, a))
        finally: a.close(); b.close()

    def test_missing_deleted_relative_and_non_normal_hints_refuse(self):
        for hint in (b'relative', b'/missing-selected-location', os.fsencode(self.path) + b' (deleted)',
                     os.fsencode(self.root) + b'/./Selected', os.fsencode(self.root) + b'//Selected'):
            with self.subTest(hint=hint), mock.patch.object(worker.os, 'readlink', return_value=hint):
                with self.assertRaises((worker.Refusal, OSError)): worker.canonical_directory(self.fd)

    def test_selected_access_denial_is_preserved(self):
        def open_fd(path, flags, *args, **kwargs):
            if os.fsencode(path) == b'Selected': raise PermissionError(13, 'selected denied')
            return REAL_OPEN(path, flags, *args, **kwargs)
        with mock.patch.object(worker.os, 'open', side_effect=open_fd):
            with self.assertRaises(PermissionError): worker.canonical_directory(self.fd)
        os.fstat(self.fd)

    def test_selected_mount_replacement_refuses_even_same_object(self):
        calls = 0
        def metadata(fd, name=''):
            nonlocal calls
            value, mount = REAL_METADATA(fd, name)
            if os.fsencode(name) == b'Selected':
                calls += 1
                if calls > 1: mount += 100000
            return value, mount
        with mock.patch.object(worker, 'metadata', side_effect=metadata):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)

    def test_unavailable_mount_identity_refuses(self):
        def metadata(fd, name=''):
            info, _ = REAL_METADATA(fd, name)
            return info, 0
        with mock.patch.object(worker, 'metadata', side_effect=metadata):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)

    def test_entry_time_and_depth_limits_retire_temporaries(self):
        class ManyNames:
            def __enter__(inner):
                return (types.SimpleNamespace(name='unselected') for _ in range(8193))
            def __exit__(inner, *args): pass
        with mock.patch.object(worker.os, 'scandir', return_value=ManyNames()):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)
        with mock.patch.object(worker.time, 'monotonic', side_effect=[0, 0, 3]):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)
        with mock.patch.object(worker.os, 'readlink', return_value=b'/' + b'/'.join([b'x'] * 128)):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)
        os.fstat(self.fd)

    def test_selected_symlink_swap_after_enumeration_refuses(self):
        original_scan = os.scandir
        swapped = False
        class Scan:
            def __init__(inner, fd): inner.scan = original_scan(fd)
            def __enter__(inner):
                nonlocal swapped
                entries = list(inner.scan)
                if not swapped and any(entry.name == 'Selected' for entry in entries):
                    swapped = True
                    os.rename(self.path, self.root + '/Moved')
                    os.symlink('Moved', self.path)
                return iter(entries)
            def __exit__(inner, *args): inner.scan.close()
        with mock.patch.object(worker.os, 'scandir', side_effect=Scan):
            with self.assertRaises((worker.Refusal, OSError)): worker.canonical_directory(self.fd)

    def test_hint_changed_before_publication_refuses(self):
        original = os.fsencode(self.path)
        calls = 0
        def hint(_):
            nonlocal calls
            calls += 1
            return original if calls == 1 else os.fsencode(self.root + '/Other')
        with mock.patch.object(worker.os, 'readlink', side_effect=hint):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)

    def test_cache_cannot_skip_fresh_proof_or_recapture_moved_location(self):
        cache = {}
        entry = worker.Directory(self.path, cache, linux=True)
        try:
            captured = entry.physical, entry.ancestors
            os.rename(self.path, self.root + '/Moved')
            os.symlink('Moved', self.path)
            with self.assertRaises(worker.Refusal): entry.validate(cache)
            self.assertEqual((entry.physical, entry.ancestors), captured)
        finally: entry.close()

    def test_cache_hit_still_observes_proof_failure(self):
        cache = {}
        entry = worker.Directory(self.path, cache, linux=True)
        try:
            with mock.patch.object(worker, 'canonical_directory', side_effect=worker.Refusal('fresh failure')):
                with self.assertRaises(worker.Refusal): entry.validate(cache)
        finally: entry.close()

    def test_location_grants_distinguish_same_object_alias_but_overlap_does_not(self):
        root = types.SimpleNamespace(identity=(1, 2), physical='/allowed/alias', ancestors=((1, 1, 10), (1, 2, 20)))
        other = types.SimpleNamespace(identity=(1, 2), physical='/protected/tree', ancestors=((1, 1, 10), (1, 2, 30)))
        child = types.SimpleNamespace(identity=(1, 3), physical='/protected/tree/child', ancestors=other.ancestors + ((1, 3, 30),))
        self.assertFalse(worker.directory_contains(root, other))
        self.assertFalse(worker.directory_contains(root, child))
        self.assertTrue(worker.directory_contains(other, child))
        self.assertTrue(worker.directory_object_contains(root, child))
        self.assertTrue(worker.directory_object_contains(other, root))

    def test_close_unknown_consumption_is_retained_without_numeric_retry(self):
        closed, replacement = [], []
        cause = OSError('controlled close acknowledgment lost')
        def close(fd):
            closed.append(fd)
            REAL_CLOSE(fd)
            if not replacement:
                new = REAL_OPEN('/dev/null', os.O_RDONLY)
                if new != fd: os.dup2(new, fd); REAL_CLOSE(new)
                replacement.append(fd)
                raise cause
        try:
            with mock.patch.object(worker.os, 'close', side_effect=close):
                with self.assertRaises(worker.WorkerFailure) as failure: worker.canonical_directory(self.fd)
                owner = failure.exception.owner
                first = list(closed)
                with self.assertRaises(worker.WorkerFailure): owner.close()
                self.assertEqual(closed, first)
                self.assertEqual(len(owner.directories), 1)
                os.fstat(replacement[0])
            os.fstat(self.fd)
        finally:
            for fd in replacement: REAL_CLOSE(fd)

    def test_acquisition_failure_retires_existing_temporaries_not_borrowed_fd(self):
        acquired, closed = [], []
        def open_fd(path, flags, *args, **kwargs):
            if len(acquired) == 2: raise OSError(24, 'controlled acquisition failure')
            fd = REAL_OPEN(path, flags, *args, **kwargs)
            acquired.append(fd)
            return fd
        def close(fd): closed.append(fd); return REAL_CLOSE(fd)
        with mock.patch.object(worker.os, 'open', side_effect=open_fd), mock.patch.object(worker.os, 'close', side_effect=close):
            with self.assertRaises(OSError): worker.canonical_directory(self.fd)
        self.assertEqual(sorted(closed), sorted(acquired))
        os.fstat(self.fd)

    def test_validation_rejects_mapped_alias_even_with_equal_object_and_mount(self):
        entry = worker.Directory(self.path, linux=True)
        original = worker.canonical_directory
        try:
            def proof(fd):
                value = original(fd)
                return value if fd == entry.fd else (self.root + '/alias', value[1])
            with mock.patch.object(worker, 'canonical_directory', side_effect=proof):
                with self.assertRaises(worker.Refusal): entry.validate({})
        finally: entry.close()

    def test_parent_edge_mismatch_refuses(self):
        def open_fd(path, flags, *args, **kwargs):
            if os.fsencode(path) == b'..': return REAL_OPEN('/dev', flags)
            return REAL_OPEN(path, flags, *args, **kwargs)
        with mock.patch.object(worker.os, 'open', side_effect=open_fd):
            with self.assertRaises(worker.Refusal): worker.canonical_directory(self.fd)

    def test_metadata_failure_and_unknown_cleanup_preserve_primary_and_owner(self):
        primary, cleanup = OSError('selected metadata failed'), OSError('close outcome unknown')
        calls, originals = [], []
        def metadata(fd, name=''):
            if fd != self.fd: raise primary
            return REAL_METADATA(fd, name)
        def close(fd):
            calls.append(fd)
            REAL_CLOSE(fd)
            originals.append(fd)
            raise cleanup
        with mock.patch.object(worker, 'metadata', side_effect=metadata), mock.patch.object(worker.os, 'close', side_effect=close):
            with self.assertRaises(worker.WorkerFailure) as failure: worker.canonical_directory(self.fd)
            self.assertIs(failure.exception.exceptions[0], primary)
            self.assertIs(failure.exception.exceptions[1].exceptions[0], cleanup)
            owner = failure.exception.owner
            with self.assertRaises(worker.WorkerFailure): owner.close()
        self.assertEqual(calls, originals)
        self.assertEqual(len(calls), 1)
        os.fstat(self.fd)

    def test_inventory_still_refuses_external_file_hardlinks(self):
        with open(self.root + '/Other/protected', 'w') as file: file.write('unchanged')
        os.link(self.root + '/Other/protected', self.path + '/alias')
        entry = worker.Directory(self.path, linux=True)
        try:
            with self.assertRaises(worker.Refusal): worker.write_inventory([entry])
            with open(self.root + '/Other/protected') as file: self.assertEqual(file.read(), 'unchanged')
        finally: entry.close()

    def test_inventory_still_refuses_same_device_nested_mount(self):
        os.mkdir(self.path + '/nested')
        entry = worker.Directory(self.path, linux=True)
        def metadata(fd, name=''):
            info, mount = REAL_METADATA(fd, name)
            return info, mount + 10000 if os.fsencode(name) == b'nested' else mount
        try:
            with mock.patch.object(worker, 'metadata', side_effect=metadata):
                with self.assertRaises(worker.Refusal): worker.write_inventory([entry])
        finally: entry.close()


class PreparedPolicyTests(unittest.TestCase):
    def setUp(self):
        self.closed = []
        def entry(path, identity, chain, fd):
            return types.SimpleNamespace(physical=path, identity=identity, ancestors=chain,
                                         fd=fd, close=lambda: self.closed.append(fd))
        self.root_chain = ((1, 1, 10),)
        allowed = self.root_chain + ((1, 2, 20),)
        work = allowed + ((1, 3, 20),)
        self.entries = {
            'authority': entry('/allowed', (1, 2), allowed, 501),
            'primary': entry('/allowed', (1, 2), allowed, 502),
            'cwd': entry('/allowed/work', (1, 3), work, 503),
            'write': entry('/allowed/work', (1, 3), work, 504),
            'reference': entry('/protected', (1, 9), self.root_chain + ((1, 9, 30),), 505),
        }
        self.policy = dict(owner={'sessionId': 'selected-policy'}, mode='workspace-write', readable='caller',
                           authorityKind='bound', authorityRevision='fixture', fingerprint='fixture',
                           authorityRoots=['authority'], primaryRoot='primary', writeRoots=['write'], referenceRoots=['reference'])
        self.spec = dict(owner=self.policy['owner'], argv=['/bin/true'], cwd='cwd', env={},
                         transport='pipe', lifetime='complete-tree', argumentEncoding='crt')

    def prepare(self):
        with mock.patch.object(worker, 'Directory', side_effect=lambda path, *args, **kwargs: self.entries[path]), \
             mock.patch.object(worker, 'write_inventory', return_value='controlled-inventory'):
            return worker.Prepared(self.spec, self.policy)

    def alias(self, key, object_key=(1, 2)):
        item = self.entries[key]
        item.identity = object_key
        item.physical = '/other/alias'
        item.ancestors = self.root_chain + (object_key + (30,),)

    def test_primary_requires_same_selected_authority_location(self):
        self.alias('primary')
        with self.assertRaises(worker.Refusal): self.prepare()
        self.assertEqual(len(self.closed), 5)

    def test_cwd_and_write_cannot_gain_authority_from_object_alias(self):
        for key in ('cwd', 'write'):
            with self.subTest(key=key):
                self.setUp()
                self.alias(key)
                with self.assertRaises(worker.Refusal): self.prepare()

    def test_protected_reference_aliases_refuse_in_both_object_ancestry_directions(self):
        self.alias('reference')  # Same object as authority, distinct mount/location.
        with self.assertRaises(worker.Refusal): self.prepare()
        self.setUp()
        reference = self.entries['reference']
        reference.ancestors = self.root_chain + ((1, 3, 30), (1, 9, 30))
        with self.assertRaises(worker.Refusal): self.prepare()

    def test_valid_policy_keeps_original_bind_sources_destinations_and_cwd(self):
        prepared = self.prepare()
        try:
            args = worker.command(prepared, 900, 901)
            write = args.index('--bind-fd')
            self.assertEqual(args[write:write + 3], ['--bind-fd', '504', '/allowed/work'])
            reference = args.index('505') - 1
            self.assertEqual(args[reference:reference + 3], ['--ro-bind-fd', '505', '/protected'])
            self.assertEqual(args[args.index('--chdir') + 1], '/allowed/work')
        finally: prepared.close()


if __name__ == '__main__':
    print('INJECTED_SELECTED_LOCATION_CASES=26', flush=True)
    sys.argv = sys.argv[:1]
    unittest.main()
