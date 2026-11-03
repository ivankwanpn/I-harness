use super::{notifications::Inbox, waits::NativeWait};
use crate::{
    error::{Error, Result},
    protocol::{self, Command},
};
use crate::{
    ffi::Handle,
    transport::{cancel_worker, operations::Gate},
};
use std::{
    io::{BufRead, BufReader},
    os::windows::io::{AsRawHandle, IntoRawHandle},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

pub(super) enum Control {
    Command(Result<Command>),
    Eof,
}
pub(super) struct ControlReader {
    thread: Option<thread::JoinHandle<()>>,
    wait: NativeWait,
    inbox: Arc<Inbox>,
    gate: Arc<Gate>,
    terminal: Arc<AtomicBool>,
    retained: Arc<Mutex<Option<(Handle, Error)>>>,
}
impl ControlReader {
    pub(super) fn stop(&self) {
        self.inbox.close_controls();
        self.gate.stop();
        if let Some(thread) = &self.thread {
            cancel_worker(thread, &self.gate);
        }
    }
    pub(super) fn finished(&self) -> bool {
        self.wait.signaled()
    }
    pub(super) fn join(&mut self) -> Result<()> {
        self.wait.retire()?;
        if let Some((handle, original_error)) = self
            .retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            handle.close().map_err(|mut error| {
                error.cleanup.push(original_error.clone());
                error
            })?;
        }
        if !self.terminal.load(Ordering::Acquire) {
            return Err(Error::state(
                "control reader exited without terminal result",
            ));
        }
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| Error::state("control reader panicked"))?;
        }
        Ok(())
    }
}
pub(super) fn controls(file: std::fs::File, inbox: Arc<Inbox>) -> Result<ControlReader> {
    let tx = inbox.clone();
    let gate = Gate::new(inbox.clone());
    let worker_gate = gate.clone();
    let terminal = Arc::new(AtomicBool::new(false));
    let worker_terminal = terminal.clone();
    let retained = Arc::new(Mutex::new(None));
    let worker_retained = retained.clone();
    let thread = thread::spawn(move || {
        let mut input = BufReader::new(file);
        let mut line = Vec::new();
        (|| {
            loop {
                if tx.controls_closed() {
                    return;
                }
                let Some(operation) = worker_gate.begin() else {
                    return;
                };
                let buf = match input.fill_buf() {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = tx.control(Control::Command(Err(Error::io("read control", e))));
                        break;
                    }
                };
                if buf.is_empty() {
                    if !line.is_empty() {
                        let _ = tx.control(Control::Command(Err(Error::invalid(
                            "truncated control line",
                        ))));
                    }
                    break;
                }
                let n = buf
                    .iter()
                    .position(|b| *b == b'\n')
                    .map_or(buf.len(), |i| i + 1);
                let complete = buf[n - 1] == b'\n';
                if line.len() + n > protocol::MAX_LINE {
                    let _ = tx.control(Control::Command(Err(Error::invalid(
                        "control line limit exceeded",
                    ))));
                    break;
                }
                line.extend_from_slice(&buf[..n]);
                input.consume(n);
                drop(operation);
                if complete {
                    let command = protocol::parse(&line);
                    line.clear();
                    if !tx.control(Control::Command(command)) {
                        return;
                    }
                }
            }
            let _ = tx.control(Control::Eof);
        })();
        let mut handle = Handle(input.into_inner().into_raw_handle());
        if let Err(error) = handle.close() {
            *worker_retained.lock().unwrap_or_else(|e| e.into_inner()) = Some((handle, error));
        }
        worker_terminal.store(true, Ordering::Release);
        tx.wake();
    });
    let mut wait = match NativeWait::new(thread.as_raw_handle(), inbox.clone()) {
        Ok(wait) => wait,
        Err(error) => {
            inbox.close_controls();
            unsafe {
                windows_sys::Win32::System::IO::CancelSynchronousIo(thread.as_raw_handle());
            }
            std::mem::forget(thread);
            return Err(error);
        }
    };
    if let Err(error) = wait.ensure_registered() {
        inbox.close_controls();
        unsafe {
            windows_sys::Win32::System::IO::CancelSynchronousIo(thread.as_raw_handle());
        }
        std::mem::forget(thread);
        std::mem::forget(wait);
        return Err(error);
    }
    Ok(ControlReader {
        thread: Some(thread),
        wait,
        inbox,
        gate,
        terminal,
        retained,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::io::FromRawHandle,
        ptr::null_mut,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    #[test]
    fn explicit_release_retires_blocked_control_reader_without_waiting_for_host_eof() {
        let (mut read, mut write) = (null_mut(), null_mut());
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) },
            0
        );
        let _host_writer = Handle(write);
        let file = unsafe { std::fs::File::from_raw_handle(read) };
        let inbox = Inbox::new();
        let mut reader = controls(file, inbox.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut step = 0u32;
        reader.stop();
        while !reader.finished() && Instant::now() < deadline {
            reader.stop();
            inbox.wait(Some(
                (Instant::now() + Duration::from_millis((1u64 << step.min(7)).min(100)))
                    .min(deadline),
            ));
            step += 1;
        }
        let actual_exit = reader.finished();
        if !actual_exit {
            drop(_host_writer);
        }
        assert!(
            actual_exit,
            "control reader must ACK actual exit while host stdin remains open"
        );
        reader.join().unwrap();
        assert!(reader.thread.is_none());
        eprintln!(
            "controlled control-reader: hostInputOpen=true, actualThreadExitAck={actual_exit}, joined=true"
        );
    }
}
