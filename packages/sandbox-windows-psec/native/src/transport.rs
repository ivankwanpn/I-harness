pub(crate) mod operations;
mod queues;
use crate::runner::{notifications::EventSender, waits::NativeWait};
use crate::{
    error::{Error, Result},
    ffi::Handle,
    protocol::Spec,
};
use operations::Gate;
use queues::{Sender, TrySendError};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle},
    ptr::null_mut,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{
        Console::*, IO::CancelSynchronousIo, Pipes::CreatePipe, Threading::GetCurrentProcess,
    },
};
pub const CHUNK: usize = 16384;
pub(crate) fn cancel_worker(worker: &JoinHandle<()>, gate: &Gate) {
    if gate.pending() {
        let ok = unsafe { CancelSynchronousIo(worker.as_raw_handle()) };
        gate.record_cancel(if ok == 0 {
            unsafe { GetLastError() }
        } else {
            0
        });
    }
}
pub enum Event {
    RetainedHandle(Handle),
    Input(String, Result<()>),
    Reader(Result<()>),
    Output(Result<()>),
    InputClosed,
    ConsoleClosed,
    Bridge(crate::msys::Observation),
    BridgeDone(Result<()>),
}
pub enum Input {
    Bytes(String, Vec<u8>),
    End(String),
    Resize(String, i16, i16),
    Stop(String),
}
struct Frame {
    channel: u8,
    data: Vec<u8>,
}
pub struct Console(pub HPCON);
unsafe impl Send for Console {}
impl Drop for Console {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}
fn pipe(inherit: bool) -> Result<(Handle, Handle)> {
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: inherit as i32,
    };
    let (mut read, mut write) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &mut sa, 0) } == 0 {
        return Err(Error::native("CreatePipe"));
    }
    Ok((Handle(read), Handle(write)))
}
fn private(h: &Handle) -> Result<()> {
    if unsafe { SetHandleInformation(h.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
        Err(Error::native("SetHandleInformation"))
    } else {
        Ok(())
    }
}
fn into_file(handle: Handle) -> std::fs::File {
    let raw = handle.0;
    std::mem::forget(handle);
    unsafe { std::fs::File::from_raw_handle(raw) }
}
fn close_worker_file(file: std::fs::File, events: &EventSender) -> Result<()> {
    let mut handle = Handle(file.into_raw_handle());
    match handle.close() {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = events.send(Event::RetainedHandle(handle));
            Err(error)
        }
    }
}
fn with_cleanup(result: Result<()>, cleanup: Result<()>) -> Result<()> {
    match (result, cleanup) {
        (Ok(()), result) | (result, Ok(())) => result,
        (Err(mut error), Err(cause)) => {
            error.cleanup.push(cause);
            Err(error)
        }
    }
}
pub struct PrivateIo {
    pub control: std::fs::File,
    pub status: std::fs::File,
    pub output: std::fs::File,
}
impl PrivateIo {
    pub fn capture() -> Result<Self> {
        let slots = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];
        let mut originals = vec![];
        let mut files = vec![];
        for slot in slots {
            let original = unsafe { GetStdHandle(slot) };
            if original.is_null() || original == INVALID_HANDLE_VALUE {
                return Err(Error::native_code("GetStdHandle(private transport)", 6));
            }
            let mut owned = null_mut();
            let process = unsafe { GetCurrentProcess() };
            if unsafe {
                DuplicateHandle(
                    process,
                    original,
                    process,
                    &mut owned,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
            {
                return Err(Error::native("DuplicateHandle(private transport)"));
            }
            files.push(into_file(Handle(owned)));
            originals.push(original);
        }
        // A redirected parent std-handle slot can be copied into a ConPTY child even with
        // ordinary inheritance disabled. Remove the slots, retaining private owned duplicates.
        for slot in slots {
            if unsafe { SetStdHandle(slot, null_mut()) } == 0 {
                return Err(Error::native("SetStdHandle(private transport)"));
            }
        }
        originals.sort_by_key(|h| *h as usize);
        originals.dedup();
        for original in originals {
            if unsafe { CloseHandle(original) } == 0 {
                return Err(Error::native("CloseHandle(original transport)"));
            }
        }
        let mut files = files.into_iter();
        Ok(Self {
            control: files.next().unwrap(),
            status: files.next().unwrap(),
            output: files.next().unwrap(),
        })
    }
}
pub struct PreparedIo {
    pub child: Vec<Handle>,
    input: Option<Handle>,
    outputs: Vec<(u8, Handle)>,
    pub console: Option<Console>,
    msys: bool,
}
impl PreparedIo {
    pub fn empty() -> Self {
        Self {
            child: vec![],
            input: None,
            outputs: vec![],
            console: None,
            msys: false,
        }
    }
    pub fn release(&mut self) -> Vec<Error> {
        let mut errors = vec![];
        for handle in self
            .child
            .iter_mut()
            .chain(self.input.iter_mut())
            .chain(self.outputs.iter_mut().map(|(_, h)| h))
        {
            if let Err(e) = handle.close() {
                errors.push(e);
            }
        }
        // No workload was resumed in PreparedIo. Closing its readers first lets a
        // prepared pseudoconsole's final bytes fail promptly instead of blocking.
        if errors.is_empty() {
            self.console.take();
        }
        errors
    }
    pub fn initialize(&mut self, spec: &Spec) -> Result<()> {
        let pty = spec.transport == "pty" && spec.msys_pty.is_none();
        self.msys = spec.msys_pty.is_some();
        let (input_read, input_write) = pipe(!pty)?;
        self.child.push(input_read);
        self.input = Some(input_write);
        let (output_read, output_write) = pipe(!pty)?;
        self.child.push(output_write);
        self.outputs
            .push((if pty || self.msys { 2 } else { 0 }, output_read));
        private(self.input.as_ref().unwrap())?;
        private(&self.outputs[0].1)?;
        if pty {
            let size = spec
                .pty
                .as_ref()
                .ok_or_else(|| Error::invalid("PTY dimensions missing"))?;
            let mut console = 0;
            let hr = unsafe {
                CreatePseudoConsole(
                    COORD {
                        X: size.cols,
                        Y: size.rows,
                    },
                    self.child[0].0,
                    self.child[1].0,
                    0,
                    &mut console,
                )
            };
            if hr < 0 {
                return Err(Error::native_code("CreatePseudoConsole", hr as u32));
            }
            self.console = Some(Console(console));
            // Keep even these parent-side pseudoconsole endpoint closes fallible.
            for h in &mut self.child {
                h.close()?;
            }
            self.child.clear();
            Ok(())
        } else {
            let (error_read, error_write) = pipe(true)?;
            self.child.push(error_write);
            self.outputs
                .push((if self.msys { 4 } else { 1 }, error_read));
            private(&self.outputs[1].1)?;
            Ok(())
        }
    }
    pub fn start(mut self, events: EventSender, mut out: std::fs::File) -> RunningIo {
        let pending_handles = std::mem::take(&mut self.child);
        let discard = Arc::new(AtomicBool::new(false));
        let stop_input = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let (frame_tx, frame_rx) = queues::channel::<Frame>(32);
        let discard_out = discard.clone();
        let dropped_out = dropped.clone();
        let out_events = events.worker();
        let output_slot = out_events.clone();
        let output_gate = Gate::new(events.inbox.clone());
        let output_operation = output_gate.clone();
        let output = thread::spawn(move || {
            let result = (|| -> Result<()> {
                while let Ok(frame) = frame_rx.recv() {
                    if discard_out.load(Ordering::Acquire) {
                        dropped_out.fetch_add(frame.data.len() as u64, Ordering::Relaxed);
                        continue;
                    }
                    let Some(_operation) = output_operation.begin() else {
                        dropped_out.fetch_add(frame.data.len() as u64, Ordering::Relaxed);
                        continue;
                    };
                    let mut bytes = Vec::with_capacity(frame.data.len() + 5);
                    bytes.push(frame.channel);
                    bytes.extend_from_slice(&(frame.data.len() as u32).to_le_bytes());
                    bytes.extend_from_slice(&frame.data);
                    if let Err(e) = out.write_all(&bytes) {
                        dropped_out.fetch_add(frame.data.len() as u64, Ordering::Relaxed);
                        if !discard_out.load(Ordering::Acquire) {
                            return Err(Error::io("write workload frame", e));
                        }
                    }
                }
                if let Some(_operation) = output_operation.begin() {
                    out.write_all(&[3, 0, 0, 0, 0])
                        .and_then(|_| out.flush())
                        .map_err(|e| Error::io("write output-end", e))?;
                }
                Ok(())
            })();
            let result = with_cleanup(result, close_worker_file(out, &out_events));
            let _ = out_events.send(Event::Output(result));
        });
        let mut readers = vec![];
        let mut slots = vec![output_slot];
        let mut gates = vec![output_gate];
        let mut reader_controller = vec![];
        for (channel, handle) in self.outputs.drain(..) {
            reader_controller.push(channel == 4);
            let tx = frame_tx.clone();
            let events = events.worker();
            slots.push(events.clone());
            let gate = Gate::new(events.inbox.clone());
            gates.push(gate.clone());
            let discard = discard.clone();
            let dropped = dropped.clone();
            readers.push(thread::spawn(move || {
                let mut file = into_file(handle);
                if channel == 4 {
                    let result = (|| -> Result<()> {
                        let mut reader = BufReader::new(&mut file);
                        let mut line = Vec::new();
                        let mut ready = false;
                        let mut root = false;
                        loop {
                            let Some(_operation) = gate.begin() else {
                                break;
                            };
                            let available = reader
                                .fill_buf()
                                .map_err(|e| Error::io("read MSYS controller", e))?;
                            if available.is_empty() {
                                if !line.is_empty() {
                                    return Err(Error::state("truncated MSYS controller"));
                                }
                                break;
                            }
                            let n = available
                                .iter()
                                .position(|b| *b == b'\n')
                                .map_or(available.len(), |i| i + 1);
                            if line.len() + n > 256 {
                                return Err(Error::state("MSYS controller line limit exceeded"));
                            }
                            let complete = available[n - 1] == b'\n';
                            line.extend_from_slice(&available[..n]);
                            reader.consume(n);
                            if complete {
                                let observation = crate::msys::observation(&line)?;
                                line.clear();
                                match &observation {
                                    crate::msys::Observation::Ready if !ready => ready = true,
                                    crate::msys::Observation::Ack(..) if ready => {}
                                    crate::msys::Observation::Root(_) if ready && !root => {
                                        root = true
                                    }
                                    _ => {
                                        return Err(Error::state(
                                            "MSYS controller lifecycle order violated",
                                        ));
                                    }
                                }
                                events
                                    .send(Event::Bridge(observation))
                                    .map_err(|_| Error::state("MSYS observer disconnected"))?;
                            }
                        }
                        Ok(())
                    })();
                    let result = with_cleanup(result, close_worker_file(file, &events));
                    drop(tx);
                    let _ = events.send(Event::BridgeDone(result));
                    return;
                }
                let mut buf = [0u8; CHUNK];
                let result = (|| -> Result<()> {
                    loop {
                        let Some(operation) = gate.begin() else {
                            break;
                        };
                        let n = match file.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(e) if e.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => break,
                            Err(e) => return Err(Error::io("read workload output", e)),
                        };
                        drop(operation);
                        let frame = Frame {
                            channel,
                            data: buf[..n].to_vec(),
                        };
                        if let Err(frame) = tx.send(frame) {
                            if discard.load(Ordering::Acquire) {
                                dropped.fetch_add(frame.data.len() as u64, Ordering::Relaxed);
                            } else {
                                return Err(Error::state("output writer disconnected"));
                            }
                        }
                    }
                    Ok(())
                })();
                let result = with_cleanup(result, close_worker_file(file, &events));
                drop(tx);
                let _ = events.send(Event::Reader(result));
            }));
        }
        let frame_tx_keep = frame_tx.controller();
        drop(frame_tx);
        let (input_tx, input_rx) = queues::channel::<Input>(8);
        let input_handle = self.input.take().expect("prepared input ownership");
        let input_events = events.worker();
        slots.push(input_events.clone());
        let input_gate = Gate::new(events.inbox.clone());
        gates.push(input_gate.clone());
        let input_stop = stop_input.clone();
        let sealed = Arc::new(AtomicBool::new(false));
        let input_sealed = sealed.clone();
        let msys = self.msys;
        let input = thread::spawn(move || {
            let mut file = into_file(input_handle);
            loop {
                match input_rx.recv() {
                    Ok(command) if msys => {
                        let id = match &command {
                            Input::Bytes(id, _)
                            | Input::End(id)
                            | Input::Resize(id, _, _)
                            | Input::Stop(id) => id.clone(),
                        };
                        let operation = input_gate.begin();
                        let result = if operation.is_none()
                            || input_stop.load(Ordering::Acquire)
                            || (input_sealed.load(Ordering::Acquire)
                                && !matches!(command, Input::Stop(_)))
                        {
                            Err(Error::state("input cancelled"))
                        } else {
                            crate::msys::packet(&command).and_then(|bytes| {
                                file.write_all(&bytes)
                                    .map_err(|e| Error::io("write MSYS controller", e))
                            })
                        };
                        drop(operation);
                        // Success is acknowledged by the adapter after delivery/ioctl.
                        if result.is_err() {
                            let _ = input_events.send(Event::Input(id, result));
                        }
                    }
                    Ok(Input::Bytes(id, data)) => {
                        let operation = input_gate.begin();
                        let result = if operation.is_none() || input_stop.load(Ordering::Acquire) {
                            Err(Error::state("input cancelled"))
                        } else {
                            file.write_all(&data)
                                .map_err(|e| Error::io("write workload stdin", e))
                        };
                        drop(operation);
                        let _ = input_events.send(Event::Input(id, result));
                    }
                    Ok(Input::End(id)) => {
                        let result = close_worker_file(file, &input_events);
                        let _ = input_events.send(Event::Input(id, result));
                        let _ = input_events.send(Event::InputClosed);
                        return;
                    }
                    Ok(Input::Resize(..)) => unreachable!("ConPTY resize never enters input queue"),
                    Ok(Input::Stop(..)) => {
                        unreachable!("MSYS cancellation only enters its controller queue")
                    }
                    Err(()) => break,
                }
            }
            if let Err(error) = close_worker_file(file, &input_events) {
                let _ = input_events.send(Event::Reader(Err(error)));
            }
            let _ = input_events.send(Event::InputClosed);
        });
        let mut waits = vec![];
        for worker in std::iter::once(&output)
            .chain(readers.iter())
            .chain(std::iter::once(&input))
        {
            waits.push(NativeWait::new(
                worker.as_raw_handle(),
                events.inbox.clone(),
            ));
        }
        RunningIo {
            pending_handles,
            frames: frame_tx_keep,
            waits,
            slots,
            joined: false,
            gates,
            reader_controller,
            sealed,
            input_tx: Some(input_tx),
            input: Some(input),
            output: Some(output),
            readers,
            console: self.console.take(),
            console_thread: None,
            events,
            discard,
            stop_input,
            dropped,
            input_ended: false,
            msys,
        }
    }
}
pub struct RunningIo {
    frames: Sender<Frame>,
    waits: Vec<Result<NativeWait>>,
    slots: Vec<EventSender>,
    joined: bool,
    gates: Vec<Arc<Gate>>,
    reader_controller: Vec<bool>,
    sealed: Arc<AtomicBool>,
    pub pending_handles: Vec<Handle>,
    input_tx: Option<Sender<Input>>,
    input: Option<JoinHandle<()>>,
    output: Option<JoinHandle<()>>,
    readers: Vec<JoinHandle<()>>,
    console: Option<Console>,
    console_thread: Option<JoinHandle<()>>,
    events: EventSender,
    discard: Arc<AtomicBool>,
    stop_input: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    input_ended: bool,
    msys: bool,
}
impl RunningIo {
    pub fn ensure_waits(&mut self) -> Result<()> {
        let mut errors = vec![];
        for wait in &mut self.waits {
            match wait {
                Ok(wait) => {
                    if let Err(error) = wait.ensure_registered() {
                        errors.push(error);
                    }
                }
                Err(error) => errors.push(error.clone()),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            let mut error = Error::state("worker exit registration failed");
            error.cleanup = errors;
            Err(error)
        }
    }
    pub fn close_pending_handles(&mut self) -> Vec<Error> {
        let mut errors = vec![];
        for h in &mut self.pending_handles {
            if let Err(e) = h.close() {
                errors.push(e);
            }
        }
        self.pending_handles.retain(|h| !h.0.is_null());
        errors
    }
    pub fn send(&mut self, input: Input) -> Result<Option<Event>> {
        if self.input_ended && !matches!(input, Input::Resize(..) | Input::Stop(..)) {
            if let Input::End(id) = input
                && self.stop_input.load(Ordering::Acquire)
            {
                // Natural root/tree completion may close stdin before its owner
                // sends EOF. EOF is an idempotent close, never another delivery.
                return Ok(self
                    .events
                    .inbox
                    .publish_from_consumer(Event::Input(id, Ok(()))));
            }
            return Err(Error::state("input already ended"));
        }
        let end = matches!(&input, Input::End(_));
        if matches!(&input, Input::Stop(_)) {
            return self
                .input_tx
                .as_ref()
                .ok_or_else(|| Error::state("input closed"))?
                .priority(input)
                .map(|()| None)
                .map_err(|_| Error::state("private stop already pending or input closed"));
        }
        match self
            .input_tx
            .as_ref()
            .ok_or_else(|| Error::state("input closed"))?
            .try_send(input)
        {
            Ok(()) => {
                if end {
                    self.input_ended = true;
                }
                Ok(None)
            }
            Err(TrySendError::Full(_)) => Err(Error {
                code: "input-backpressure",
                ..Error::state("input queue full; retry after outstanding acknowledgements")
            }),
            Err(TrySendError::Disconnected(_)) => Err(Error::state("input writer ended")),
        }
    }
    pub fn resize(&mut self, id: String, cols: i16, rows: i16) -> Result<bool> {
        if self.msys {
            self.send(Input::Resize(id, cols, rows))?;
            return Ok(true);
        }
        let console = self
            .console
            .as_ref()
            .ok_or_else(|| Error::state("PTY is not active"))?;
        let hr = unsafe { ResizePseudoConsole(console.0, COORD { X: cols, Y: rows }) };
        if hr < 0 {
            Err(Error::native_code("ResizePseudoConsole", hr as u32))
        } else {
            Ok(false)
        }
    }
    pub fn stop_input(&mut self) {
        self.stop_input.store(true, Ordering::Release);
        self.gates.last().unwrap().stop();
        if let Some(tx) = self.input_tx.take() {
            tx.close(false);
        }
        self.input_ended = true;
        if let Some(thread) = &self.input {
            cancel_worker(thread, self.gates.last().unwrap());
        }
    }
    pub fn seal_input(&mut self) {
        self.sealed.store(true, Ordering::Release);
        // Reject workload data while retaining the private MSYS controller so
        // its observer can report waitpid after the workload Job is cancelled.
        self.input_ended = true;
    }
    pub fn cancel_output(&self) {
        self.discard.store(true, Ordering::Release);
        for (index, gate) in self.gates[..self.gates.len() - 1].iter().enumerate() {
            if index == 0 || !self.reader_controller[index - 1] {
                gate.stop();
            }
        }
        for frame in self.frames.close(true) {
            self.dropped
                .fetch_add(frame.data.len() as u64, Ordering::Relaxed);
        }
        if let Some(thread) = &self.output {
            cancel_worker(thread, &self.gates[0]);
        }
        for (index, thread) in self.readers.iter().enumerate() {
            if !self.reader_controller[index] {
                cancel_worker(thread, &self.gates[index + 1]);
            }
        }
    }
    pub fn cancellation_pending(&self) -> bool {
        self.gates.iter().any(|gate| gate.pending())
    }
    pub fn retry_cancel(&mut self) {
        let workers = self
            .output
            .iter()
            .chain(self.readers.iter())
            .chain(self.input.iter())
            .chain(self.console_thread.iter());
        for (index, worker) in workers.enumerate() {
            if self.waits[index].is_err() {
                self.waits[index] =
                    NativeWait::new(worker.as_raw_handle(), self.events.inbox.clone());
            }
            if let Ok(wait) = &mut self.waits[index] {
                let _ = wait.ensure_registered();
            }
            if let Some(gate) = self.gates.get(index) {
                if gate.pending() {
                    cancel_worker(worker, gate);
                }
            }
        }
    }
    pub fn close_console(&mut self) {
        if let Some(console) = self.console.take() {
            let events = self.events.worker();
            self.slots.push(events.clone());
            self.console_thread = Some(thread::spawn(move || {
                drop(console);
                let _ = events.send(Event::ConsoleClosed);
            }));
            self.waits.push(NativeWait::new(
                self.console_thread.as_ref().unwrap().as_raw_handle(),
                self.events.inbox.clone(),
            ));
        }
    }
    pub fn settled(&self) -> bool {
        (self.joined
            || self
                .waits
                .iter()
                .all(|wait| wait.as_ref().is_ok_and(NativeWait::signaled)))
            && self.console.is_none()
    }
    pub fn fully_joined(&self) -> bool {
        self.joined && self.waits.is_empty()
    }
    pub fn inbox(&self) -> Arc<crate::runner::notifications::Inbox> {
        self.events.inbox.clone()
    }

    pub fn discarded(&self) -> u64 {
        self.dropped.load(Ordering::Acquire)
    }
    pub fn abandoned(&self) -> bool {
        self.discard.load(Ordering::Acquire)
    }
    pub fn join(&mut self) -> Result<()> {
        let mut errors = vec![];
        if !self.joined {
            if !self.settled() {
                return Err(Error::state("worker actual thread exit is unconfirmed"));
            }
            for slot in &self.slots {
                if !slot.terminal_published() {
                    errors.push(Error::state("worker exited without terminal result"));
                }
            }
            errors.extend(join_workers(
                self.input
                    .take()
                    .into_iter()
                    .chain(self.output.take())
                    .chain(self.readers.drain(..))
                    .chain(self.console_thread.take()),
            ));
            self.joined = true;
        }
        self.waits.retain_mut(|wait| match wait {
            Ok(wait) => match wait.retire() {
                Ok(()) => false,
                Err(error) => {
                    errors.push(error);
                    true
                }
            },
            Err(error) => {
                errors.push(error.clone());
                true
            }
        });
        if errors.is_empty() {
            Ok(())
        } else {
            let mut error = Error::state("I/O worker cleanup failed");
            error.cleanup = errors;
            Err(error)
        }
    }
}

fn join_workers(workers: impl IntoIterator<Item = JoinHandle<()>>) -> Vec<Error> {
    let mut errors = vec![];
    for worker in workers {
        if worker.join().is_err() {
            errors.push(Error::state("I/O thread panicked"));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reactor_automatic_eof_cannot_wait_for_its_own_full_reply_queue() {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        let inbox = crate::runner::notifications::Inbox::new();
        let (input_read, input_write) = pipe(false).unwrap();
        let prepared = PreparedIo {
            child: vec![],
            input: Some(input_write),
            outputs: vec![],
            console: None,
            msys: false,
        };
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp")
            .join(format!(
                "native-eof-reply-capacity-{}-{}",
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
        io.stop_input();
        // Model the reactor's completed drain, then the private controller
        // publisher filling capacity before the queued EndInput is handled.
        while inbox.try_recv().is_ok() {}
        for n in 0..32 {
            inbox
                .send(Event::Input(format!("earlier-{n}"), Ok(())))
                .unwrap();
        }
        let reactor_inbox = inbox.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let reactor = thread::spawn(move || {
            let sent = io.send(Input::End("automatic-eof".into()));
            let mut replies = vec![];
            let mut record = |event| {
                if let Event::Input(id, result) = event {
                    result.unwrap();
                    replies.push(id);
                }
            };
            let send_ok = sent.is_ok();
            if let Some(current) = sent.unwrap() {
                record(current);
            }
            while let Ok(event) = reactor_inbox.try_recv() {
                record(event);
            }
            io.stop_input(); // Cancellation remains serviceable on the same consumer.
            let deadline = Instant::now() + Duration::from_secs(2);
            while !io.settled() && Instant::now() < deadline {
                reactor_inbox.wait(Some(deadline));
                while let Ok(event) = reactor_inbox.try_recv() {
                    record(event);
                }
            }
            io.join().unwrap();
            while let Ok(event) = reactor_inbox.try_recv() {
                record(event);
            }
            done_tx.send((send_ok, replies, io.fully_joined())).unwrap();
        });
        let timely = done_rx.recv_timeout(Duration::from_millis(500));
        let progressed_without_another_consumer = timely.is_ok();
        let result = timely.unwrap_or_else(|_| {
            // RED containment only: the real reactor was blocked. Free one
            // capacity entry so its owned threads can still exit and join.
            while let Ok(event) = inbox.try_recv() {
                if matches!(event, Event::Input(..)) {
                    break;
                }
            }
            done_rx.recv_timeout(Duration::from_secs(3)).unwrap()
        });
        reactor.join().unwrap();
        drop(input_read);
        assert!(
            progressed_without_another_consumer,
            "sole reactor blocked publishing automatic EOF into its own full 32-reply Inbox"
        );
        assert!(result.0 && result.2);
        let expected = (0..32)
            .map(|n| format!("earlier-{n}"))
            .chain(std::iter::once("automatic-eof".into()))
            .collect::<Vec<_>>();
        assert_eq!(
            result.1, expected,
            "every prior response and EOF must be delivered exactly once in queue order"
        );
    }
    #[test]
    fn one_failed_join_cannot_skip_later_started_workers() {
        let workers = [
            thread::spawn(|| panic!("first worker failure")),
            thread::spawn(|| panic!("second worker failure")),
        ];
        let errors = join_workers(workers);
        assert_eq!(
            errors.len(),
            2,
            "both started workers must be joined and both failures retained"
        );
    }
    #[test]
    fn prepared_close_failure_keeps_handle_for_retry() {
        let (read, write) = pipe(false).unwrap();
        let mut io = PreparedIo {
            child: vec![read],
            input: Some(write),
            outputs: vec![],
            console: None,
            msys: false,
        };
        crate::ffi::FAIL_NEXT_CLOSE.with(|flag| flag.set(true));
        let errors = io.release();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].api, "CloseHandle");
        assert!(
            !io.child[0].0.is_null(),
            "failed close must retain the actual handle"
        );
        assert!(io.release().is_empty());
        assert!(io.child[0].0.is_null());
    }
}
