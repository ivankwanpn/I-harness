"""Actual Directory/Prepared retirement, including the Worker.run caller."""
import importlib.util
import os
import sys
import unittest
from unittest import mock

fixture_spec = importlib.util.spec_from_file_location('retirement_loop_fixture', os.path.join(os.path.dirname(__file__), 'exit_run_test.py'))
loop = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(loop)
worker = loop.worker
REAL_CLOSE = os.close

def directory(fd):
    entry = worker.Directory.__new__(worker.Directory)
    entry.fd = fd
    entry.close_state = 'live'
    entry.close_error = None
    return entry

def prepared(entries):
    owner = worker.Prepared.__new__(worker.Prepared)
    owner.directories = list(entries)
    owner.writes = owner.references = owner.runtimes = []
    owner.validate = lambda checkpoint: None
    return owner

def errors(error):
    nested = getattr(error, 'exceptions', None)
    return [error] if nested is None else [value for child in nested for value in errors(child)]

class RetirementTests(unittest.TestCase):
    def test_partial_close_retains_unknown_and_attempts_all_independent_entries(self):
        entries = [directory(201), directory(202), directory(203)]
        owner = prepared(entries)
        original = OSError('unknown original descriptor consumption')
        calls = []
        def close(fd):
            calls.append(fd)
            if fd == 202:
                raise original
        with mock.patch.object(worker.os, 'close', side_effect=close):
            with self.assertRaises(worker.WorkerFailure) as first:
                owner.close()
            self.assertEqual(calls, [201, 202, 203])
            self.assertIn(original, errors(first.exception))
            self.assertEqual(owner.directories, [entries[1]])
            self.assertEqual([entry.close_state for entry in entries], ['closed', 'unknown', 'closed'])
            self.assertIs(entries[1].close_error, original)
            self.assertEqual([entry.fd for entry in entries], [None, 202, None])
            for _ in range(2):
                with self.assertRaises(worker.WorkerFailure) as repeated:
                    owner.close()
                self.assertIn(original, errors(repeated.exception))
            self.assertEqual(calls, [201, 202, 203])

    def test_numeric_reuse_after_acknowledged_or_unknown_consumption_is_not_closed(self):
        for uncertain in (False, True):
            original_fd = os.open('/dev/null', os.O_RDONLY)
            entry = directory(original_fd)
            replacement = []
            cause = OSError('close returned no acknowledgment after consumption')
            def close(fd):
                self.assertEqual(fd, original_fd)
                REAL_CLOSE(fd)
                new = os.open('/dev/null', os.O_RDONLY)
                if new != original_fd:
                    os.dup2(new, original_fd)
                    REAL_CLOSE(new)
                replacement.append(original_fd)
                if uncertain:
                    raise cause
            owner = prepared([entry])
            try:
                with mock.patch.object(worker.os, 'close', side_effect=close) as native_close:
                    observed = []
                    for _ in range(3):
                        try:
                            owner.close()
                        except BaseException as error:
                            observed.append(error)
                        os.fstat(original_fd)  # Replacement capability remains live.
                    try:
                        entry.close()  # Other retained aliases must also refuse replay.
                    except BaseException as error:
                        observed.append(error)
                    self.assertEqual(native_close.call_count, 1)
                    os.fstat(original_fd)
                    if uncertain:
                        self.assertEqual(len(observed), 4)
                        self.assertTrue(all(cause in errors(error) for error in observed))
                    else:
                        self.assertEqual(observed, [])
            finally:
                for fd in set(replacement):
                    REAL_CLOSE(fd)

    def test_all_acknowledged_double_cleanup_is_idempotent(self):
        owner = prepared([directory(301), directory(302), directory(303)])
        with mock.patch.object(worker.os, 'close', return_value=None) as native_close:
            owner.close()
            owner.close()
            self.assertEqual([call.args[0] for call in native_close.call_args_list], [301, 302, 303])
            self.assertEqual(owner.directories, [])

    def test_actual_run_settlement_cleanup_and_explicit_retry_keep_original_entries(self):
        f = loop.Fixture()
        entries = [directory(401), directory(402), directory(403)]
        owner = prepared(entries)
        cause = OSError('original directory close unknown')
        calls = []
        ordinary_close = f.close_fd
        def close(fd):
            if fd in (401, 402, 403):
                calls.append(fd)
                if fd == 402:
                    raise cause
                return None
            return ordinary_close(fd)
        f.prepared = owner
        f.close_fd = close
        try:
            frames = f.execute()
            self.assertNotIn('settled', [frame['type'] for frame in frames])
            self.assertIs(f.loop.prepared, owner)
            self.assertEqual(calls, [401, 402, 403])
            self.assertIn(cause, errors(f.failure))
            with mock.patch.object(worker.os, 'close', side_effect=close), mock.patch.object(worker.os, 'killpg', side_effect=f.kill):
                with self.assertRaises(worker.WorkerFailure) as retry:
                    f.loop.cleanup()
            self.assertIn(cause, errors(retry.exception))
            self.assertEqual(calls, [401, 402, 403])
        finally:
            with mock.patch.object(worker.os, 'close', side_effect=close):
                f.close()

    def test_initialization_primary_and_unknown_close_keep_original_directory_owner(self):
        primary, cleanup = OSError('fstat failed'), OSError('close consumption unknown')
        with mock.patch.object(worker.os.path, 'realpath', return_value='/owned'), \
             mock.patch.object(worker.os, 'open', return_value=501), \
             mock.patch.object(worker.os, 'fstat', side_effect=primary), \
             mock.patch.object(worker.os, 'close', side_effect=cleanup) as close:
            with self.assertRaises(worker.WorkerFailure) as failure:
                worker.Directory('/owned', linux=True)
            self.assertEqual(failure.exception.exceptions, (primary, cleanup))
            original_owner = failure.exception.owner
            self.assertEqual(original_owner.fd, 501)
            self.assertEqual(original_owner.close_state, 'unknown')
            with self.assertRaises(OSError) as repeated:
                original_owner.close()
            self.assertIs(repeated.exception, cleanup)
            self.assertEqual(close.call_count, 1)

    def test_actual_run_primary_root_error_and_actual_prepared_cleanup_errors_survive(self):
        f = loop.Fixture()
        primary, cleanup = RuntimeError('root frame refused'), OSError('directory unknown')
        owner = prepared([directory(601), directory(602), directory(603)])
        calls, ordinary = [], f.close_fd
        def close(fd):
            if fd in (601, 602, 603):
                calls.append(fd)
                if fd == 602:
                    raise cleanup
                return None
            return ordinary(fd)
        def configure(w):
            emit = w.emit
            def refuse_root(kind, **fields):
                if kind == 'root':
                    raise primary
                emit(kind, **fields)
            w.emit = refuse_root
        f.configure, f.prepared, f.close_fd = configure, owner, close
        try:
            frames = f.execute()
            self.assertIn(primary, errors(f.failure))
            self.assertIn(cleanup, errors(f.failure))
            self.assertEqual(calls, [601, 602, 603])
            self.assertIs(f.loop.prepared, owner)
            self.assertNotIn('settled', [frame['type'] for frame in frames])
        finally:
            with mock.patch.object(worker.os, 'close', side_effect=close):
                f.close()

    def test_prepared_phase_cancellation_does_not_replay_partial_closes(self):
        owner = prepared([directory(701), directory(702), directory(703)])
        w = worker.Worker.__new__(worker.Worker)
        w.child, w.wait_result, w.cancel_acknowledged = None, None, False
        w.input, w.ended, w.phase, w.failed, w.prepared = bytearray(), False, 'prepared', False, owner
        w.close_input = lambda: None
        frames = []
        w.emit = lambda *args, **kwargs: frames.append(args)
        calls = []
        def close(fd):
            calls.append(fd)
            if fd == 702:
                raise OSError('unknown cancellation cleanup')
        with mock.patch.object(worker.os, 'close', side_effect=close):
            for _ in range(2):
                with self.assertRaises(worker.WorkerFailure):
                    w.stop()
        self.assertEqual(calls, [701, 702, 703])
        self.assertIs(w.prepared, owner)
        self.assertEqual(frames, [])

if __name__ == '__main__':
    print('INJECTED_PREPARED_RETIREMENT_CASES=7', flush=True)
    sys.argv = sys.argv[:1]
    unittest.main()
