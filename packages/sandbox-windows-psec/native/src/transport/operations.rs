//! The admitted-operation gate covers the synchronous API check-to-call gap.
use crate::runner::notifications::Inbox;
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct State {
    sequence: u64,
    stopped: bool,
    stop_sequence: Option<u64>,
    in_call: bool,
    cancel_calls: u64,
    last_cancel: Option<(u64, u32)>,
    last_returned: Option<(u64, Option<u32>)>,
}
pub(crate) struct Gate {
    state: Mutex<State>,
    inbox: Arc<Inbox>,
}
pub(crate) struct Operation {
    gate: Arc<Gate>,
    sequence: u64,
}
impl Gate {
    pub(crate) fn new(inbox: Arc<Inbox>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            inbox,
        })
    }
    pub(crate) fn begin(self: &Arc<Self>) -> Option<Operation> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped {
            return None;
        }
        state.sequence += 1;
        state.in_call = true;
        Some(Operation {
            gate: self.clone(),
            sequence: state.sequence,
        })
    }
    pub(crate) fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.stopped {
            state.stop_sequence = state.in_call.then_some(state.sequence);
            state.stopped = true;
        }
    }
    pub(crate) fn pending(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped && state.in_call
    }
    pub(crate) fn record_cancel(&self, code: u32) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.cancel_calls += 1;
        state.last_cancel = Some((state.sequence, code));
    }
}
impl Operation {
    pub(crate) fn returned(&self, native_code: Option<u32>) -> bool {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.sequence != self.sequence || !state.in_call {
            return false;
        }
        state.last_returned = Some((self.sequence, native_code));
        state.stopped && state.stop_sequence == Some(self.sequence)
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.sequence == self.sequence {
            state.in_call = false;
        }
        drop(state);
        self.gate.inbox.wake();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn real_reader_abort(owned_stop: bool) -> (bool, bool, Option<u32>) {
        use super::super::{Event, PreparedIo};
        use std::{
            os::windows::io::AsRawHandle,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::System::IO::CancelSynchronousIo;
        let inbox = Inbox::new();
        let (_input_read, input_write) = super::super::pipe(false).unwrap();
        let (output_read, _output_write) = super::super::pipe(false).unwrap();
        let prepared = PreparedIo {
            child: vec![],
            input: Some(input_write),
            outputs: vec![(0, output_read)],
            console: None,
            msys: false,
        };
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp")
            .join(format!(
                "reader-abort-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&root).unwrap();
        let mut io = prepared.start(
            inbox.sender(),
            std::fs::File::create(root.join("output.bin")).unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while !io.gates[1].state.lock().unwrap().in_call && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(io.gates[1].state.lock().unwrap().in_call);
        io.stop_input();
        if owned_stop {
            io.cancel_output();
        }
        while !io.settled() && Instant::now() < deadline {
            if owned_stop {
                io.retry_cancel();
            } else {
                unsafe {
                    CancelSynchronousIo(io.readers[0].as_raw_handle());
                }
            }
            inbox.wait(Some(
                (Instant::now() + Duration::from_millis(2)).min(deadline),
            ));
        }
        let actual_exit = io.settled();
        if !actual_exit {
            drop(_output_write);
        }
        assert!(actual_exit, "actual cancelled reader thread did not exit");
        io.join().unwrap();
        let state = io.gates[1].state.lock().unwrap();
        assert!(matches!(state.last_returned, Some((_, Some(995)))));
        assert_eq!(state.stop_sequence.is_some(), owned_stop);
        eprintln!(
            "actual reader abort: nativeReturn=995, ownedStopSequence={:?}, actualThreadExitAndJoin=true, abandoned={}",
            state.stop_sequence,
            io.abandoned()
        );
        drop(state);
        let mut code = None;
        while let Ok(event) = inbox.try_recv() {
            if let Event::Reader(Err(error)) = event {
                code = error.native_code;
            }
        }
        (io.fully_joined(), io.abandoned(), code)
    }
    #[test]
    fn owned_output_stop_accepts_actual_aborted_read_only_after_thread_ack() {
        let (joined, abandoned, error) = real_reader_abort(true);
        assert!(joined && abandoned);
        assert_eq!(
            error, None,
            "the owned stopped read ACK must not become an I/O failure"
        );
    }
    #[test]
    fn actual_aborted_read_without_owned_stop_remains_an_io_failure() {
        let (joined, abandoned, error) = real_reader_abort(false);
        assert!(joined && !abandoned);
        assert_eq!(
            error,
            Some(995),
            "995 without this operation's Stop must remain an error"
        );
    }
    #[test]
    fn stop_before_native_call_keeps_admitted_operation_pending_until_ack() {
        let gate = Gate::new(Inbox::new());
        let operation = gate.begin().unwrap();
        gate.stop();
        gate.record_cancel(1168);
        assert!(gate.pending());
        assert!(gate.begin().is_none());
        drop(operation);
        assert!(!gate.pending());
        let state = gate.state.lock().unwrap();
        assert_eq!(state.last_cancel, Some((1, 1168)));
    }
    #[test]
    fn cancel_before_blocked_write_is_retried_until_original_operation_and_thread_ack() {
        use std::{
            io::Write,
            os::windows::io::AsRawHandle,
            sync::mpsc,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{Foundation::*, System::IO::CancelSynchronousIo};
        let inbox = Inbox::new();
        let gate = Gate::new(inbox.clone());
        let (read, write) = super::super::pipe(false).unwrap();
        let (admitted_tx, admitted_rx) = mpsc::channel();
        let (enter_tx, enter_rx) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            let _operation = worker_gate.begin().unwrap();
            let mut file = super::super::into_file(write);
            let buffer = vec![7u8; 1024 * 1024];
            admitted_tx.send(()).unwrap();
            enter_rx.recv().unwrap();
            file.write_all(&buffer)
        });
        admitted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut wait =
            crate::runner::waits::NativeWait::new(worker.as_raw_handle(), inbox.clone()).unwrap();
        gate.stop();
        assert_eq!(unsafe { CancelSynchronousIo(worker.as_raw_handle()) }, 0);
        let initial = unsafe { GetLastError() };
        assert_eq!(initial, ERROR_NOT_FOUND);
        gate.record_cancel(initial);
        enter_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut step = 0u32;
        while !wait.signaled() && Instant::now() < deadline {
            let ok = unsafe { CancelSynchronousIo(worker.as_raw_handle()) };
            gate.record_cancel(if ok == 0 {
                unsafe { GetLastError() }
            } else {
                0
            });
            inbox.wait(Some(
                (Instant::now() + Duration::from_millis((1u64 << step.min(7)).min(100)))
                    .min(deadline),
            ));
            step += 1;
        }
        let acknowledged = wait.signaled();
        drop(read); // Failed cut containment: unblock the exact owned writer before joining.
        let result = worker.join().unwrap();
        wait.retire().unwrap();
        assert!(
            acknowledged,
            "stop-only retry failed to obtain the native thread-exit ACK"
        );
        assert_eq!(
            result.unwrap_err().raw_os_error(),
            Some(ERROR_OPERATION_ABORTED as i32)
        );
        assert!(!gate.pending());
        let state = gate.state.lock().unwrap();
        eprintln!(
            "controlled synchronous cancellation: initialNativeCode={initial}, retryCalls={}, lastCancel={:?}, originalOperationCode=995, actualThreadExitAck={acknowledged}",
            state.cancel_calls, state.last_cancel
        );
    }
}
