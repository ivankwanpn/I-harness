"""Actual Worker.run, with only child preparation/process/transport boundaries injected."""
import importlib.util
import json
import os
import selectors
import sys
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('loop_worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
REAL_READ, REAL_WRITE, REAL_CLOSE, REAL_BLOCK = os.read, os.write, os.close, os.set_blocking
REAL_SELECTOR = selectors.DefaultSelector

class Fixture:
    def __init__(self, order='root-first', setup_failure=None, cancel_error=None, input_error=None):
        self.control_r, self.control_w = os.pipe()
        self.wire_r, self.wire_w = os.pipe()
        self.selector = REAL_SELECTOR()
        self.gate, self.entered = threading.Event(), threading.Event()
        self.waits, self.kills, self.selects = 0, 0, []
        self.order, self.setup_failure = order, setup_failure
        self.cancel_error, self.input_error = cancel_error, input_error
        self.wire, self.backpressure, self.released = bytearray(), True, False
        self.failure = None
        self.outputs = []
        for _ in range(2):
            r, w = os.pipe()
            self.outputs.append((os.fdopen(r, 'rb', buffering=0), w))
        r, w = os.pipe()
        self.stdin_r = r
        self.input_file = os.fdopen(w, 'wb', buffering=0)
        self.child = mock.Mock(pid=123, stdin=self.input_file, stdout=self.outputs[0][0], stderr=self.outputs[1][0])
        self.child.poll.side_effect = AssertionError('no process state poll')
        def wait():
            self.waits += 1
            self.entered.set()
            self.gate.wait()
            return 23
        self.child.wait.side_effect = wait
        self.prepared = mock.Mock(writes=[], references=[], runtimes=[])
        self.prepared.close.side_effect = lambda: setattr(self, 'released', True)
        self.loop = None
        self.stage = 0
        self.control_closed = False
        self.configure = lambda loop: None
        self.wire_error = None
        self.fd_close_error = None
        self.retained_fd = None
        self.block_failure = False

    def register(self, obj, events, data):
        if data == self.setup_failure:
            raise RuntimeError('setup ' + data)
        actual = self.control_r if obj == 0 else self.wire_w if obj == 1 else obj
        return self.selector.register(actual, events, (data, obj))

    def unregister(self, obj):
        actual = self.control_r if obj == 0 else self.wire_w if obj == 1 else obj
        return self.selector.unregister(actual)

    def close_outputs(self):
        for _, fd in self.outputs:
            if fd is not None:
                REAL_CLOSE(fd)
        self.outputs = [(stream, None) for stream, _ in self.outputs]

    def select(self, timeout=None):
        self.selects.append(timeout)
        if self.loop.child is not None and self.stage == 0 and not self.loop.failed:
            self.assert_entered()
            self.stage = 1
            if self.order == 'control-eof':
                REAL_CLOSE(self.control_w); self.control_closed = True
            elif self.order == 'eof-first':
                self.close_outputs()
            else:
                self.gate.set()
        if self.stage == 1:
            if self.order == 'root-first' and self.loop.root_sent:
                REAL_WRITE(self.outputs[0][1], b'tail')
                self.close_outputs(); self.stage = 2
            elif self.order == 'eof-first' and self.loop.streams == 0:
                self.gate.set(); self.stage = 2
        if self.loop.phase == 'settled' and not self.control_closed:
            REAL_CLOSE(self.control_w); self.control_closed = True
        keys = self.selector.select(timeout)
        return [(selectors.SelectorKey(original, original if isinstance(original, int) else key.fd, key.events, name), events)
                for key, events in keys for name, original in [key.data]]

    def assert_entered(self):
        if not self.entered.wait(2):
            raise AssertionError('original wait not entered')

    def read(self, fd, count):
        return REAL_READ(self.control_r if fd == 0 else fd, count)

    def write(self, fd, data):
        if fd != 1:
            return REAL_WRITE(fd, data)
        if self.wire_error is not None:
            error, self.wire_error = self.wire_error, None
            raise error
        if self.backpressure:
            self.backpressure = False
            raise BlockingIOError()
        count = min(7, len(data))
        self.wire.extend(data[:count])
        return count

    def kill(self, *_):
        self.kills += 1
        if self.cancel_error:
            raise self.cancel_error
        self.gate.set()
        self.close_outputs()

    def set_blocking(self, fd, flag):
        if self.block_failure and fd == self.child.stdout.fileno():
            raise RuntimeError('nonblocking setup refused')
        if fd not in (0, 1):
            REAL_BLOCK(fd, flag)

    def close_fd(self, fd):
        if self.fd_close_error is not None and self.loop is not None and fd == self.loop.wait_read:
            error, self.fd_close_error = self.fd_close_error, None
            self.retained_fd = fd
            raise error
        return REAL_CLOSE(fd)

    def execute(self):
        frame = json.dumps({'v': 1, 'nonce': 'n', 'type': 'commit'}).encode() + b'\n'
        REAL_WRITE(self.control_w, frame)
        with mock.patch.object(worker.selectors, 'DefaultSelector', return_value=self), \
             mock.patch.object(worker.os, 'set_blocking', side_effect=self.set_blocking), \
             mock.patch.object(worker.os, 'close', side_effect=self.close_fd), \
             mock.patch.object(worker.os, 'read', side_effect=self.read), \
             mock.patch.object(worker.os, 'write', side_effect=self.write), \
             mock.patch.object(worker.os, 'killpg', side_effect=self.kill), \
             mock.patch.object(worker, 'probe', return_value=(True, 'fixture')), \
             mock.patch.object(worker, 'seccomp_fd', side_effect=lambda: os.open('/dev/null', os.O_RDONLY)), \
             mock.patch.object(worker, 'command', return_value=[]), \
             mock.patch.object(worker.subprocess, 'Popen', return_value=self.child):
            self.loop = worker.Worker('n', 'd')
            self.loop.phase, self.loop.prepared = 'prepared', self.prepared
            self.loop.checkpoint = lambda: None
            self.configure(self.loop)
            if self.input_error:
                self.loop.close_input = mock.Mock(side_effect=self.input_error)
            try:
                self.loop.run()
            except BaseException as error:
                self.failure = error
        self.partial = self.wire.split(b'\n')[-1]
        return [json.loads(line) for line in self.wire.split(b'\n')[:-1]]

    def close(self):
        self.gate.set()
        if self.loop and self.loop.wait_thread:
            self.loop.wait_thread.join(2)
            with mock.patch.object(worker.os, 'killpg', side_effect=self.kill):
                try:
                    self.loop.cleanup()
                except BaseException:
                    pass
        self.close_outputs()
        for fd in (self.control_r, None if self.control_closed else self.control_w, self.wire_r, self.wire_w, self.stdin_r):
            if fd is not None:
                try: REAL_CLOSE(fd)
                except OSError: pass
        for stream, _ in self.outputs:
            stream.close()
        self.input_file.close()
        self.selector.close()
        if self.retained_fd is not None:
            try: REAL_CLOSE(self.retained_fd)
            except OSError: pass

class RunTests(unittest.TestCase):
    def test_both_root_eof_orders_and_partial_wire_backpressure(self):
        for order in ('root-first', 'eof-first'):
            f = Fixture(order)
            try:
                frames = f.execute()
                self.assertIsNone(f.failure)
                kinds = [frame['type'] for frame in frames]
                self.assertEqual(kinds.count('root'), 1)
                self.assertEqual(kinds.count('settled'), 1)
                self.assertLess(kinds.index('root'), kinds.index('settled'))
                if order == 'root-first':
                    self.assertIn('output', kinds)
                self.assertEqual(f.waits, 1)
                self.assertTrue(f.released)
                self.assertTrue(all(timeout is None for timeout in f.selects))
                f.child.poll.assert_not_called()
            finally: f.close()

    def test_control_eof_cancels_before_original_wait_join(self):
        f = Fixture('control-eof')
        try:
            frames = f.execute()
            self.assertIsNone(f.failure)
            self.assertEqual(f.kills, 1)
            self.assertEqual(f.waits, 1)
            self.assertEqual([frame['type'] for frame in frames].count('settled'), 1)
        finally: f.close()

    def test_partial_stream_setup_is_failed_never_positive_settlement(self):
        for name in ('stdout', 'stderr'):
            f = Fixture(setup_failure=name)
            try:
                frames = f.execute()
                self.assertIsNotNone(f.failure)
                self.assertNotIn('settled', [frame['type'] for frame in frames])
                self.assertNotIn('started', [frame['type'] for frame in frames])
                self.assertTrue(f.loop.failed)
                self.assertEqual(f.partial, b'', repr(f.failure))
                self.assertEqual(f.waits, 1)
            finally: f.close()

    def test_cancel_and_input_failure_do_not_mask_primary_or_close_live_notifier(self):
        primary = RuntimeError('setup stderr')
        stop_error = PermissionError('kill refused')
        input_error = RuntimeError('input close refused')
        f = Fixture(setup_failure='stderr', cancel_error=stop_error, input_error=input_error)
        try:
            f.execute()
            self.assertIsNotNone(f.failure)
            self.assertIn('setup stderr', str(f.failure.exceptions[0]))
            self.assertFalse(f.released)
            self.assertIsNotNone(f.loop.wait_write)
            self.assertFalse(f.loop.wait_consumed)
            self.assertEqual(f.waits, 1)
            f.cancel_error = None
            f.loop.close_input = worker.Worker.close_input.__get__(f.loop)
        finally: f.close()

    def test_root_admission_and_prepared_close_failures_cannot_settle(self):
        for stage in ('root', 'prepared'):
            f = Fixture()
            original = RuntimeError(stage + ' failure')
            def configure(loop):
                if stage == 'prepared':
                    f.prepared.close.side_effect = original
                else:
                    emit = loop.emit
                    def refused(kind, **fields):
                        if kind == 'root':
                            raise original
                        emit(kind, **fields)
                    loop.emit = refused
            f.configure = configure
            try:
                frames = f.execute()
                self.assertNotIn('settled', [frame['type'] for frame in frames])
                self.assertIn(original, f.loop.failures)
                self.assertEqual(f.partial, b'')
                if stage == 'root':
                    self.assertFalse(f.loop.root_sent)
            finally: f.close()

    def test_wire_broken_pipe_preserves_exact_error_and_runs_cleanup(self):
        f = Fixture()
        original = BrokenPipeError('wire')
        f.wire_error = original
        try:
            f.execute()
            self.assertIn(original, f.loop.failures)
            self.assertTrue(f.loop.failed)
            self.assertEqual(f.waits, 1)
        finally: f.close()

    def test_primary_and_descriptor_retirement_failure_are_both_retained(self):
        f = Fixture(setup_failure='stderr')
        original = OSError('descriptor close unknown')
        f.fd_close_error = original
        try:
            frames = f.execute()
            self.assertIsNotNone(f.failure)
            self.assertIn('setup stderr', str(f.loop.failures[0]))
            self.assertIn('wait_read', f.loop.wait_close_unknown)
            self.assertNotIn('settled', [frame['type'] for frame in frames])
            self.assertEqual(f.waits, 1)
        finally: f.close()

    def test_partial_notifier_acquisition_has_only_one_proven_fallback_wait(self):
        for stage in ('pipe', 'register', 'thread'):
            f = Fixture(setup_failure='completion' if stage == 'register' else None)
            try:
                if stage == 'pipe':
                    with mock.patch.object(worker.os, 'pipe', side_effect=OSError('pipe failure')):
                        frames = f.execute()
                elif stage == 'thread':
                    with mock.patch.object(worker.threading, 'Thread', side_effect=RuntimeError('constructor failure')):
                        frames = f.execute()
                else:
                    frames = f.execute()
                self.assertIsNotNone(f.failure)
                self.assertEqual(f.waits, 1)
                self.assertNotIn('started', [frame['type'] for frame in frames])
                self.assertNotIn('settled', [frame['type'] for frame in frames])
                self.assertIsNone(f.loop.wait_read)
                self.assertIsNone(f.loop.wait_write)
            finally: f.close()

    def test_nonblocking_setup_failure_is_failed_owner_not_positive_completion(self):
        f = Fixture()
        f.block_failure = True
        try:
            frames = f.execute()
            self.assertIsNotNone(f.failure)
            self.assertNotIn('started', [frame['type'] for frame in frames])
            self.assertNotIn('settled', [frame['type'] for frame in frames])
            self.assertEqual(f.waits, 1)
        finally: f.close()

if __name__ == '__main__':
    print('INJECTED_WORKER_RUN_CASES=9', flush=True)
    sys.argv = sys.argv[:1]
    unittest.main()
