import importlib.util
import os
import selectors
import sys
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('worker_under_test', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class Child:
    def __init__(self, status=23):
        self.status, self.calls = status, 0
        self.stdin = None
    def wait(self):
        self.calls += 1
        return self.status

class Tests(unittest.TestCase):
    def make_worker(self, child, streams):
        w = worker.Worker.__new__(worker.Worker)
        w.selector = selectors.DefaultSelector()
        w.child = child
        w.root_sent, w.streams, w.phase = False, streams, 'active'
        w.failed, w.setup_complete = False, True
        w.wait_result, w.cancel_acknowledged = None, False
        w.prepared = mock.Mock()
        w.frames = []
        w.emit = lambda kind, **fields: w.frames.append((kind, fields))
        return w

    def test_already_exited_child_is_reported_once_after_registration(self):
        w = self.make_worker(Child(), 1)
        w.start_waiter()
        self.assertTrue(w.selector.select(2), 'completion did not wake selector')
        w.consume_waiter()
        self.assertEqual(w.child.calls, 1)
        self.assertEqual(w.frames, [('root', {'exitCode': 23})])
        w.streams = 0
        w.settle_if_complete()
        self.assertEqual([x[0] for x in w.frames], ['root', 'settled'])
        w.close_waiter()
        w.close_waiter()
        w.selector.close()

    def test_eof_before_root_settles_only_after_wait(self):
        w = self.make_worker(Child(0), 0)
        w.settle_if_complete()
        self.assertEqual(w.frames, [])
        w.start_waiter()
        self.assertTrue(w.selector.select(2))
        w.consume_waiter()
        self.assertEqual([x[0] for x in w.frames], ['root', 'settled'])
        w.close_waiter()
        w.selector.close()

    def test_failed_wake_closes_writer_and_retains_error(self):
        w = self.make_worker(Child(), 0)
        with mock.patch.object(worker.os, 'write', side_effect=OSError('wake failed')):
            w.start_waiter()
            self.assertTrue(w.selector.select(2), 'writer EOF must wake selector')
            with self.assertRaisesRegex(Exception, 'notification failed'):
                w.consume_waiter()
        self.assertEqual(w.frames, [])
        w.close_waiter()
        w.selector.close()

    def test_wait_failure_never_emits_root_or_settled(self):
        child = Child()
        child.wait = mock.Mock(side_effect=OSError('wait failed'))
        w = self.make_worker(child, 0)
        w.start_waiter()
        self.assertTrue(w.selector.select(2))
        with self.assertRaisesRegex(Exception, 'notification failed'):
            w.consume_waiter()
        self.assertEqual(w.frames, [])
        w.close_waiter()
        w.selector.close()

    def test_held_child_has_one_wait_and_no_readiness_until_cancelled(self):
        gate = threading.Event()
        entered = threading.Event()
        child = Child(-9)
        child.pid = 123
        child.poll = mock.Mock(return_value=None)
        def wait():
            child.calls += 1
            entered.set()
            gate.wait()
            return -9
        child.wait = wait
        w = self.make_worker(child, 0)
        w.input, w.ended = bytearray(), False
        w.start_waiter()
        self.assertTrue(entered.wait(2))
        self.assertEqual(w.selector.select(0), [])
        self.assertEqual(child.calls, 1)
        with mock.patch.object(worker.os, 'killpg', side_effect=lambda *_: gate.set()) as kill:
            w.stop()
        kill.assert_called_once_with(123, worker.signal.SIGKILL)
        self.assertTrue(w.selector.select(2))
        w.consume_waiter()
        self.assertEqual([x[0] for x in w.frames], ['root', 'settled'])
        self.assertEqual(child.calls, 1)
        w.close_waiter()
        w.selector.close()

    def test_read_failure_propagates_without_root(self):
        w = self.make_worker(Child(), 0)
        w.start_waiter()
        self.assertTrue(w.selector.select(2))
        with mock.patch.object(worker.os, 'read', side_effect=OSError('read failed')):
            with self.assertRaisesRegex(OSError, 'read failed'):
                w.consume_waiter()
        self.assertEqual(w.frames, [])
        w.close_waiter()
        w.selector.close()

    def test_original_wait_and_wake_double_fault_remain_separate_and_owned(self):
        original, wake, closing = OSError('original wait'), OSError('write wake'), OSError('close wake')
        child = Child()
        child.wait = mock.Mock(side_effect=original)
        w = self.make_worker(child, 0)
        real_close = os.close
        with mock.patch.object(worker.os, 'write', side_effect=wake), mock.patch.object(worker.os, 'close', side_effect=closing) as close:
            w.start_waiter()
            keys = w.selector.select(2)
            self.assertTrue(keys, 'owned secondary channel must wake indefinite select')
            with self.assertRaises(worker.WorkerFailure) as failure:
                w.consume_waiter(keys[0][0].fileobj)
            self.assertIs(w.wait_result[1], original)
            self.assertIs(w.wait_errors[0], wake)
            self.assertIs(w.wait_errors[1], closing)
            self.assertIs(failure.exception.exceptions[0], original)
            self.assertEqual(close.call_count, 2)
        retained = w.wait_write
        with self.assertRaises(worker.WorkerFailure):
            w.close_waiter()
        self.assertEqual(w.wait_write, retained)
        real_close(retained)  # Fixture-only cleanup of known pre-call injected refusal.
        w.wait_write = None
        real_close(w.wait_read)
        w.wait_read = None
        w.selector.close()

    def test_successful_status_survives_failed_notification(self):
        w = self.make_worker(Child(259), 0)
        with mock.patch.object(worker.os, 'write', side_effect=OSError('wake')):
            w.start_waiter()
            keys = w.selector.select(2)
            with self.assertRaises(worker.WorkerFailure):
                w.consume_waiter(keys[0][0].fileobj)
        self.assertEqual(w.wait_result, (259, None))
        self.assertEqual(w.frames, [])
        w.close_waiter()
        w.selector.close()

    def test_thread_capability_is_installed_before_interrupted_start(self):
        w = self.make_worker(Child(), 0)
        original_start = threading.Thread.start
        def interrupted(thread):
            self.assertIs(w.wait_thread, thread)
            original_start(thread)
            raise RuntimeError('start interrupted after launch')
        with mock.patch.object(worker.threading.Thread, 'start', interrupted):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                w.start_waiter()
        w.wait_thread.join(2)
        w.close_waiter()
        self.assertEqual(w.child.calls, 1)
        w.selector.close()

    def test_start_exception_without_ident_cannot_authorize_a_fallback_reaper(self):
        w = self.make_worker(Child(), 0)
        with mock.patch.object(worker.threading.Thread, 'start', side_effect=RuntimeError('not launched')):
            with self.assertRaises(RuntimeError):
                w.start_waiter()
        self.assertEqual(w.wait_state, 'start-unknown')
        w.cancel_acknowledged = True
        with self.assertRaisesRegex(RuntimeError, 'remains live'):
            w.close_waiter()
        self.assertEqual(w.child.calls, 0)
        # Injected start was known by the fixture not to launch. Dispose its
        # resources explicitly without upgrading the production unknown state.
        for fd in (w.wait_read, w.wait_write):
            os.close(fd)
        for endpoint in w.failure_sockets:
            endpoint.close()
        w.selector.close()

    def test_actual_root_frame_overflow_does_not_set_root_queued(self):
        w = self.make_worker(Child(), 0)
        w.nonce = 'n'
        w.pending = bytearray(b'x' * (worker.MAX_PENDING - 8))
        w.emit = worker.Worker.emit.__get__(w)
        w.start_waiter()
        keys = w.selector.select(2)
        with self.assertRaisesRegex(worker.Refusal, 'overflow'):
            w.consume_waiter(keys[0][0].fileobj)
        self.assertFalse(w.root_sent)
        w.prepared.close.assert_not_called()
        w.close_waiter()
        w.selector.close()

if __name__ == '__main__':
    print('INJECTED_WORKER_HELPERS=11', flush=True)
    sys.argv = sys.argv[:1]
    unittest.main()
