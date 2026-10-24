//! The admitted-operation gate covers the synchronous API check-to-call gap.
use crate::runner::notifications::Inbox;
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct State {
    sequence: u64,
    stopped: bool,
    in_call: bool,
    cancel_calls: u64,
    last_cancel: Option<(u64, u32)>,
}
pub(crate) struct Gate {
    state: Mutex<State>,
    inbox: Arc<Inbox>,
}
pub(crate) struct Operation(Arc<Gate>);
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
        Some(Operation(self.clone()))
    }
    pub(crate) fn stop(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
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
impl Drop for Operation {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .in_call = false;
        self.0.inbox.wake();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
