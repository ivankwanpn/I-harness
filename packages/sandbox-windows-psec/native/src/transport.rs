use crate::{
    error::{Error, Result},
    ffi::Handle,
    protocol::Spec,
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle},
    ptr::null_mut,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{
        Console::*, IO::CancelSynchronousIo, Pipes::CreatePipe, Threading::GetCurrentProcess,
    },
};
pub const CHUNK: usize = 16384;
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
fn close_worker_file(file: std::fs::File, events: &SyncSender<Event>) -> Result<()> {
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
    pub fn start(mut self, events: SyncSender<Event>, mut out: std::fs::File) -> RunningIo {
        let pending_handles = std::mem::take(&mut self.child);
        let discard = Arc::new(AtomicBool::new(false));
        let stop_input = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(32);
        let discard_out = discard.clone();
        let dropped_out = dropped.clone();
        let out_events = events.clone();
        let output = thread::spawn(move || {
            let result = (|| -> Result<()> {
                for frame in frame_rx {
                    if discard_out.load(Ordering::Acquire) {
                        dropped_out.fetch_add(frame.data.len() as u64, Ordering::Relaxed);
                        continue;
                    }
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
                if !discard_out.load(Ordering::Acquire) {
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
        for (channel, handle) in self.outputs.drain(..) {
            let tx = frame_tx.clone();
            let events = events.clone();
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
                        let n = match file.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(e) if e.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => break,
                            Err(e) => return Err(Error::io("read workload output", e)),
                        };
                        let mut frame = Frame {
                            channel,
                            data: buf[..n].to_vec(),
                        };
                        loop {
                            if discard.load(Ordering::Acquire) {
                                dropped.fetch_add(n as u64, Ordering::Relaxed);
                                break;
                            }
                            match tx.try_send(frame) {
                                Ok(()) => break,
                                Err(TrySendError::Full(f)) => {
                                    frame = f;
                                    thread::sleep(Duration::from_millis(5));
                                }
                                Err(TrySendError::Disconnected(_)) => {
                                    return Err(Error::state("output writer disconnected"));
                                }
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
        drop(frame_tx);
        let (input_tx, input_rx) = mpsc::sync_channel::<Input>(8);
        let input_handle = self.input.take().expect("prepared input ownership");
        let input_events = events.clone();
        let input_stop = stop_input.clone();
        let msys = self.msys;
        let input = thread::spawn(move || {
            let mut file = into_file(input_handle);
            loop {
                match input_rx.recv_timeout(Duration::from_millis(10)) {
                    Ok(command) if msys => {
                        let id = match &command {
                            Input::Bytes(id, _)
                            | Input::End(id)
                            | Input::Resize(id, _, _)
                            | Input::Stop(id) => id.clone(),
                        };
                        let result = if input_stop.load(Ordering::Acquire) {
                            Err(Error::state("input cancelled"))
                        } else {
                            crate::msys::packet(&command).and_then(|bytes| {
                                file.write_all(&bytes)
                                    .map_err(|e| Error::io("write MSYS controller", e))
                            })
                        };
                        // Success is acknowledged by the adapter after delivery/ioctl.
                        if result.is_err() {
                            let _ = input_events.send(Event::Input(id, result));
                        }
                    }
                    Ok(Input::Bytes(id, data)) => {
                        let result = if input_stop.load(Ordering::Acquire) {
                            Err(Error::state("input cancelled"))
                        } else {
                            file.write_all(&data)
                                .map_err(|e| Error::io("write workload stdin", e))
                        };
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
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if input_stop.load(Ordering::Acquire) {
                            break;
                        }
                    }
                }
            }
            if let Err(error) = close_worker_file(file, &input_events) {
                let _ = input_events.send(Event::Reader(Err(error)));
            }
            let _ = input_events.send(Event::InputClosed);
        });
        RunningIo {
            pending_handles,
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
    pub pending_handles: Vec<Handle>,
    pub input_tx: Option<SyncSender<Input>>,
    input: Option<JoinHandle<()>>,
    output: Option<JoinHandle<()>>,
    readers: Vec<JoinHandle<()>>,
    console: Option<Console>,
    console_thread: Option<JoinHandle<()>>,
    events: SyncSender<Event>,
    discard: Arc<AtomicBool>,
    stop_input: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    input_ended: bool,
    msys: bool,
}
impl RunningIo {
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
    pub fn send(&mut self, input: Input) -> Result<()> {
        if self.input_ended && !matches!(input, Input::Resize(..) | Input::Stop(..)) {
            if let Input::End(id) = input
                && self.stop_input.load(Ordering::Acquire)
            {
                // Natural root/tree completion may close stdin before its owner
                // sends EOF. EOF is an idempotent close, never another delivery.
                self.events
                    .send(Event::Input(id, Ok(())))
                    .map_err(|_| Error::state("input observer disconnected"))?;
                return Ok(());
            }
            return Err(Error::state("input already ended"));
        }
        let end = matches!(&input, Input::End(_));
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
                Ok(())
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
        self.input_tx.take();
        self.input_ended = true;
        if let Some(thread) = &self.input {
            unsafe {
                CancelSynchronousIo(thread.as_raw_handle());
            }
        }
    }
    pub fn seal_input(&mut self) {
        // Reject workload data while retaining the private MSYS controller so
        // its observer can report waitpid after the workload Job is cancelled.
        self.input_ended = true;
    }
    pub fn cancel_output(&self) {
        self.discard.store(true, Ordering::Release);
        if let Some(thread) = &self.output {
            unsafe {
                CancelSynchronousIo(thread.as_raw_handle());
            }
        }
    }
    pub fn close_console(&mut self) {
        if let Some(console) = self.console.take() {
            let events = self.events.clone();
            self.console_thread = Some(thread::spawn(move || {
                drop(console);
                let _ = events.send(Event::ConsoleClosed);
            }));
        }
    }
    pub fn settled(&self) -> bool {
        self.input.as_ref().is_none_or(JoinHandle::is_finished)
            && self.output.as_ref().is_none_or(JoinHandle::is_finished)
            && self.readers.iter().all(JoinHandle::is_finished)
            && self
                .console_thread
                .as_ref()
                .is_none_or(JoinHandle::is_finished)
            && self.console.is_none()
    }
    pub fn discarded(&self) -> u64 {
        self.dropped.load(Ordering::Acquire)
    }
    pub fn abandoned(&self) -> bool {
        self.discard.load(Ordering::Acquire)
    }
    pub fn join(&mut self) -> Result<()> {
        let threads = self
            .input
            .take()
            .into_iter()
            .chain(self.output.take())
            .chain(self.readers.drain(..))
            .chain(self.console_thread.take());
        for t in threads {
            if t.join().is_err() {
                return Err(Error::state("I/O thread panicked"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
