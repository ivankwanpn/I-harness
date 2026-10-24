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
    accepted_cancel: Option<u64>,
    last_returned: Option<(u64, Option<u32>)>,
}
pub(crate) struct Gate {
    state: Mutex<State>,
    inbox: Arc<Inbox>,
    #[cfg(test)]
    return_barrier: Mutex<
        Option<(
            std::sync::mpsc::Sender<Option<u32>>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
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
            #[cfg(test)]
            return_barrier: Mutex::new(None),
        })
    }
    pub(crate) fn begin(self: &Arc<Self>) -> Option<Operation> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped {
            return None;
        }
        state.sequence += 1;
        state.in_call = true;
        state.accepted_cancel = None;
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
    pub(crate) fn cancel(&self, thread: windows_sys::Win32::Foundation::HANDLE) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let sequence = state.sequence;
        if !state.stopped || !state.in_call || state.stop_sequence != Some(sequence) {
            return;
        }
        // CancelSynchronousIo requests cancellation without waiting for return.
        // Keep this tiny gate across the API and its result publication so the
        // worker cannot classify before this exact native acknowledgment exists.
        let accepted = unsafe { windows_sys::Win32::System::IO::CancelSynchronousIo(thread) } != 0;
        let code = if accepted {
            0
        } else {
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        };
        state.cancel_calls += 1;
        state.last_cancel = Some((sequence, code));
        if accepted {
            state.accepted_cancel = Some(sequence);
        }
    }
    #[cfg(test)]
    pub(crate) fn record_cancel(&self, code: u32) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.cancel_calls += 1;
        state.last_cancel = Some((state.sequence, code));
    }
}
impl Operation {
    pub(crate) fn returned(&self, native_code: Option<u32>) -> bool {
        #[cfg(test)]
        if let Some((captured, resume)) = self.gate.return_barrier.lock().unwrap().take() {
            captured.send(native_code).unwrap();
            resume.recv().unwrap();
        }
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.sequence != self.sequence || !state.in_call {
            return false;
        }
        state.last_returned = Some((self.sequence, native_code));
        native_code == Some(windows_sys::Win32::Foundation::ERROR_OPERATION_ABORTED)
            && state.stopped
            && state.stop_sequence == Some(self.sequence)
            && state.accepted_cancel == Some(self.sequence)
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
    #[test]
    fn accepted_native_cancel_survives_later_not_found_for_the_same_original_read() {
        use std::{
            io::Read,
            os::windows::io::AsRawHandle,
            sync::mpsc,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::Foundation::*;
        let inbox = Inbox::new();
        let gate = Gate::new(inbox.clone());
        let (read, _write) = super::super::pipe(false).unwrap();
        let (admit_tx, admit_rx) = mpsc::channel();
        let (return_tx, return_rx) = mpsc::channel();
        let (publish_tx, publish_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            let operation = worker_gate.begin().unwrap();
            let mut file = super::super::into_file(read);
            let mut buffer = [0u8; 8];
            admit_tx.send(()).unwrap();
            let code = file.read(&mut buffer).unwrap_err().raw_os_error().unwrap() as u32;
            return_tx.send(code).unwrap();
            publish_rx.recv().unwrap();
            result_tx.send(operation.returned(Some(code))).unwrap();
        });
        admit_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut wait =
            crate::runner::waits::NativeWait::new(worker.as_raw_handle(), inbox.clone()).unwrap();
        gate.stop();
        let deadline = Instant::now() + Duration::from_secs(2);
        let code = loop {
            if let Ok(code) = return_rx.try_recv() {
                break code;
            }
            assert!(Instant::now() < deadline);
            gate.cancel(worker.as_raw_handle());
            std::thread::sleep(Duration::from_millis(1));
        };
        gate.cancel(worker.as_raw_handle());
        let state = gate.state.lock().unwrap();
        let accepted = state.accepted_cancel;
        let last = state.last_cancel;
        drop(state);
        publish_tx.send(()).unwrap();
        while !wait.signaled() && Instant::now() < deadline {
            inbox.wait(Some(deadline));
        }
        let exited = wait.signaled();
        worker.join().unwrap();
        wait.retire().unwrap();
        assert_eq!(code, ERROR_OPERATION_ABORTED);
        assert_eq!(accepted, Some(1));
        assert_eq!(last, Some((1, ERROR_NOT_FOUND)));
        assert!(exited && result_rx.recv().unwrap());
        eprintln!(
            "native cancel binding: acceptedOriginalSequence=1, laterNative1168=true, nativeRead995=true, actualThreadExitAndJoin=true"
        );
    }
    #[test]
    fn an_old_accepted_generation_cannot_own_a_new_abort_or_other_error() {
        let gate = Gate::new(Inbox::new());
        let stale = gate.begin().unwrap();
        let current = gate.begin().unwrap();
        {
            let mut state = gate.state.lock().unwrap();
            state.accepted_cancel = Some(stale.sequence);
        }
        gate.stop();
        assert!(
            !current.returned(Some(995)),
            "old generation authorization must not transfer"
        );
        drop(stale);
        assert!(
            gate.state.lock().unwrap().in_call,
            "stale guard cannot clear the current generation"
        );
        // Classification predicate counterfactual, not a fabricated OS result:
        // even an accepted same-generation cancellation cannot suppress code5
        // or convert a successful read/EOF into an abort acknowledgment.
        gate.state.lock().unwrap().accepted_cancel = Some(current.sequence);
        assert!(!current.returned(Some(5)));
        assert!(!current.returned(Some(0)));
        drop(current);
    }
    #[test]
    fn stop_after_actual_foreign_abort_cannot_reclassify_the_captured_error() {
        use std::{
            io::Read,
            os::windows::io::AsRawHandle,
            sync::mpsc,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{Foundation::*, System::IO::CancelSynchronousIo};
        let inbox = Inbox::new();
        let gate = Gate::new(inbox.clone());
        let (read, _write) = super::super::pipe(false).unwrap();
        let (returned_tx, returned_rx) = mpsc::channel();
        let (publish_tx, publish_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            let operation = worker_gate.begin().unwrap();
            let mut file = super::super::into_file(read);
            let mut buffer = [0u8; 8];
            let code = file.read(&mut buffer).unwrap_err().raw_os_error().unwrap() as u32;
            returned_tx.send(code).unwrap();
            publish_rx.recv().unwrap();
            let classified_owned = operation.returned(Some(code));
            result_tx.send((code, classified_owned)).unwrap();
        });
        let mut wait =
            crate::runner::waits::NativeWait::new(worker.as_raw_handle(), inbox.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let captured = loop {
            if let Ok(code) = returned_rx.try_recv() {
                break code;
            }
            assert!(
                Instant::now() < deadline,
                "foreign cancellation did not return"
            );
            unsafe {
                CancelSynchronousIo(worker.as_raw_handle());
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        // Native read has ALREADY returned 995. The worker holds its guard but
        // is blocked on a condition, with no pending synchronous native I/O.
        gate.stop();
        super::super::cancel_worker(&worker, &gate);
        let late_cancel = gate.state.lock().unwrap().last_cancel;
        publish_tx.send(()).unwrap();
        while !wait.signaled() && Instant::now() < deadline {
            inbox.wait(Some(deadline));
        }
        let actual_exit = wait.signaled();
        worker.join().unwrap();
        let result = result_rx.recv().unwrap();
        wait.retire().unwrap();
        assert_eq!(captured, ERROR_OPERATION_ABORTED);
        assert_eq!(late_cancel, Some((1, ERROR_NOT_FOUND)));
        assert!(actual_exit);
        eprintln!(
            "late Stop barrier: capturedNative995BeforeStop=true, lateCancelNative1168=true, classifiedOwned={}, actualThreadExitAndJoin=true",
            result.1
        );
        assert!(
            !result.1,
            "late Stop retroactively owned an already captured foreign read995"
        );
    }
    fn real_reader_abort(owned_stop: bool, late_stop: bool) -> (bool, bool, Option<u32>) {
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
        let (captured_tx, captured_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        if late_stop {
            *io.gates[1].return_barrier.lock().unwrap() = Some((captured_tx, resume_rx));
        }
        io.stop_input();
        if owned_stop && !late_stop {
            io.cancel_output();
        }
        let mut late_stopped = false;
        while !io.settled() && Instant::now() < deadline {
            if late_stop && !late_stopped {
                if let Ok(code) = captured_rx.try_recv() {
                    assert_eq!(code, Some(995));
                    io.cancel_output();
                    assert_eq!(
                        io.gates[1].state.lock().unwrap().last_cancel,
                        Some((1, 1168))
                    );
                    resume_tx.send(()).unwrap();
                    late_stopped = true;
                } else {
                    unsafe {
                        CancelSynchronousIo(io.readers[0].as_raw_handle());
                    }
                }
            } else if owned_stop {
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
        assert_eq!(state.accepted_cancel.is_some(), owned_stop && !late_stop);
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
        let (joined, abandoned, error) = real_reader_abort(true, false);
        assert!(joined && abandoned);
        assert_eq!(
            error, None,
            "the owned stopped read ACK must not become an I/O failure"
        );
    }
    #[test]
    fn actual_aborted_read_without_owned_stop_remains_an_io_failure() {
        let (joined, abandoned, error) = real_reader_abort(false, false);
        assert!(joined && !abandoned);
        assert_eq!(
            error,
            Some(995),
            "995 without this operation's Stop must remain an error"
        );
    }
    #[test]
    fn actual_reader_keeps_foreign995_when_output_stop_arrives_after_native_return() {
        let (joined, abandoned, error) = real_reader_abort(true, true);
        assert!(joined && abandoned);
        assert_eq!(
            error,
            Some(995),
            "the actual Reader terminal must retain its pre-Stop error despite later abandonment"
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
