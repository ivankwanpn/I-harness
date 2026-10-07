use crate::{
    command_line::quote,
    error::{Error, Result},
    ffi::{Attributes, Handle, Psec, PsecApi, wide},
    job::Job,
    policy::Effective,
    protocol::{self, Action, Command},
    transport::{Event, Input, PreparedIo, PrivateIo, RunningIo},
};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Write},
    mem::{size_of, zeroed},
    ptr::null,
    sync::{
        Mutex, OnceLock,
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::*, System::Threading::*};
static STATUS: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

struct Prepared {
    effective: Effective,
    psec: Option<Psec>,
    job: Job,
    io: PreparedIo,
}
struct Running {
    process: Handle,
    pid: u32,
    root_reported: bool,
    tree_reported: bool,
    io_reported: bool,
    io: RunningIo,
    owner: PreparedOwner,
    id: String,
    cancelled: bool,
    closing: bool,
    errors: Vec<Error>,
    stop_at: Option<Instant>,
}
struct PreparedOwner {
    _effective: Effective,
    _psec: Option<Psec>,
    job: Job,
}
impl Prepared {
    fn new(
        engine: String,
        spec: protocol::Spec,
        policy: protocol::Policy,
        protection: protocol::Protection,
        console_mode: Option<String>,
    ) -> Result<Self> {
        let effective = Effective::new(
            &engine,
            spec,
            policy,
            protection,
            console_mode.unwrap_or_else(|| "no-window".into()),
        )?;
        let psec = if engine == "psec" {
            let api = PsecApi::load()?;
            if api.flags & 1 == 0 {
                return Err(Error::native_code("PSEC support flags", 50));
            }
            if !effective.protection.deny_paths.is_empty() && api.flags & 2 == 0 {
                return Err(Error::native_code("PSEC deny paths unsupported", 50));
            }
            Some(api.create(&effective.bytes)?)
        } else {
            None
        };
        let job = Job::new()?;
        let io = PreparedIo::new(&effective.spec)?;
        Ok(Self {
            effective,
            psec,
            job,
            io,
        })
    }
    fn launch(
        mut self,
        id: String,
        digest: &str,
        events: SyncSender<Event>,
        output: std::fs::File,
    ) -> Result<Running> {
        if digest != self.effective.digest {
            return Err(Error::state("effective policy digest mismatch"));
        }
        self.effective.recheck()?;
        let spec = &self.effective.spec;
        let line = if spec.argument_encoding == "crt" {
            spec.argv
                .iter()
                .map(|s| quote(s))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            format!("{} /d /s /c {}", quote(&spec.argv[0]), spec.argv[4])
        };
        if line.encode_utf16().count() >= 32767 {
            return Err(Error::invalid("command line exceeds 32766 UTF16 units"));
        }
        let mut command = wide(&line);
        let executable = wide(&spec.argv[0]);
        let cwd = wide(&spec.cwd);
        let mut env = vec![];
        let mut keys = spec.env.keys().collect::<Vec<_>>();
        keys.sort_by_key(|k| k.to_lowercase());
        for k in keys {
            env.extend(format!("{}={}", k, spec.env[k]).encode_utf16());
            env.push(0);
        }
        env.push(0);
        if env.len() == 1 {
            env.push(0);
        }
        let pty = self.io.console.is_some();
        let mut inherited: Vec<HANDLE> = self.io.child.iter().map(|h| h.0).collect();
        let mut attrs = Attributes::new(1 + u32::from(self.psec.is_some()))?;
        if let Some(psec) = &mut self.psec {
            unsafe {
                attrs.add(
                    0x20023,
                    (&*psec.handle as *const HANDLE).cast(),
                    size_of::<HANDLE>(),
                )?;
            }
        }
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        if let Some(console) = &self.io.console {
            unsafe {
                attrs.add(
                    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                    console.0 as *const _,
                    size_of::<isize>(),
                )?;
            }
        } else {
            unsafe {
                attrs.add(
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    inherited.as_mut_ptr().cast(),
                    inherited.len() * size_of::<HANDLE>(),
                )?;
            }
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = inherited[0];
            startup.StartupInfo.hStdOutput = inherited[1];
            startup.StartupInfo.hStdError = inherited[2];
            if self.effective.console_mode == "hidden-console" {
                startup.StartupInfo.dwFlags |= STARTF_USESHOWWINDOW;
                startup.StartupInfo.wShowWindow =
                    windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE as u16;
            }
        }
        startup.lpAttributeList = attrs.ptr();
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        let flags = EXTENDED_STARTUPINFO_PRESENT
            | CREATE_UNICODE_ENVIRONMENT
            | CREATE_SUSPENDED
            | if pty {
                0
            } else if self.effective.console_mode == "hidden-console" {
                CREATE_NEW_CONSOLE
            } else {
                CREATE_NO_WINDOW
            };
        let created = unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                (!pty) as i32,
                flags,
                env.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        };
        if created == 0 {
            return Err(Error::native("CreateProcessW"));
        }
        let process = Handle(info.hProcess);
        let primary_thread = Handle(info.hThread);
        // No security attribute may be removed on failure, and no unassigned suspended child survives.
        if let Err(mut e) = self.job.assign(process.0) {
            rollback_process(&process, &mut e);
            return Err(e);
        }
        let io = self.io.start(events, output);
        if unsafe { ResumeThread(primary_thread.0) } == u32::MAX {
            let mut e = Error::native("ResumeThread");
            rollback_process(&process, &mut e);
            drop(primary_thread);
            let mut running = Running {
                process,
                pid: info.dwProcessId,
                root_reported: false,
                tree_reported: false,
                io_reported: false,
                io,
                owner: PreparedOwner {
                    _effective: self.effective,
                    _psec: self.psec,
                    job: self.job,
                },
                id,
                cancelled: false,
                closing: true,
                errors: vec![],
                stop_at: None,
            };
            running.stop(true);
            let deadline = Instant::now() + Duration::from_secs(10);
            while !running.io.settled() && Instant::now() < deadline {
                running.io.stop_input();
                running.io.cancel_output();
                if running.owner.job.active().ok() == Some(0) {
                    running.tree_reported = true;
                    running.io.close_console();
                }
                thread::sleep(Duration::from_millis(10));
            }
            if running.io.settled() {
                if let Err(cleanup) = running.io.join() {
                    e.cleanup.push(cleanup);
                }
                running.io_reported = true;
            } else {
                e.cleanup.push(Error::state(
                    "resume failure cleanup incomplete after 10 seconds",
                ));
            }
            e.cleanup.append(&mut running.errors);
            return Err(e);
        }
        drop(primary_thread);
        drop(attrs);
        Ok(Running {
            process,
            pid: info.dwProcessId,
            root_reported: false,
            tree_reported: false,
            io_reported: false,
            io,
            owner: PreparedOwner {
                _effective: self.effective,
                _psec: self.psec,
                job: self.job,
            },
            id,
            cancelled: false,
            closing: false,
            errors: vec![],
            stop_at: None,
        })
    }
}
fn rollback_process(process: &Handle, error: &mut Error) {
    if unsafe { TerminateProcess(process.0, 137) } == 0 {
        error
            .cleanup
            .push(Error::native("TerminateProcess(rollback)"));
    }
    if unsafe { WaitForSingleObject(process.0, 5000) } != WAIT_OBJECT_0 {
        error.cleanup.push(Error::native_code(
            "WaitForSingleObject(rollback)",
            WAIT_TIMEOUT,
        ));
    }
}
fn status(id: &str, kind: &str, fields: serde_json::Value) -> Result<()> {
    let mut v = fields;
    let map = v.as_object_mut().expect("internal status object");
    map.insert("version".into(), 1.into());
    map.insert("id".into(), id.into());
    map.insert("type".into(), kind.into());
    let bytes = serde_json::to_vec(&v).map_err(|_| Error::state("status serialization failed"))?;
    if bytes.len() > 65536 {
        return Err(Error::state("status too large"));
    }
    let mut stdout = STATUS
        .get()
        .ok_or_else(|| Error::state("private status unavailable"))?
        .lock()
        .map_err(|_| Error::state("private status lock poisoned"))?;
    stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .map_err(|e| Error::io("write status", e))
}
pub fn fatal(error: Error) {
    let _ = failure("helper", error);
}
fn failure(id: &str, error: Error) -> Result<()> {
    status(id, "error", serde_json::json!({"error":error}))
}
enum Control {
    Command(Result<Command>),
    Eof,
}
fn controls(file: std::fs::File) -> Receiver<Control> {
    let (tx, rx) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut input = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            let buf = match input.fill_buf() {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Control::Command(Err(Error::io("read control", e))));
                    break;
                }
            };
            if buf.is_empty() {
                if !line.is_empty() {
                    let _ = tx.send(Control::Command(Err(Error::invalid(
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
                let _ = tx.send(Control::Command(Err(Error::invalid(
                    "control line limit exceeded",
                ))));
                break;
            }
            line.extend_from_slice(&buf[..n]);
            input.consume(n);
            if complete {
                let command = protocol::parse(&line);
                line.clear();
                if tx.send(Control::Command(command)).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Control::Eof);
    });
    rx
}
impl Running {
    fn stop(&mut self, discard: bool) {
        if !self.cancelled {
            self.cancelled = true;
            if let Err(e) = self.owner.job.terminate() {
                self.errors.push(e);
                self.stop_at = Some(Instant::now());
            }
        }
        self.io.stop_input();
        if discard {
            self.stop_at.get_or_insert_with(Instant::now);
            self.io.cancel_output();
        }
    }
    fn tick(&mut self) -> Result<()> {
        if self.cancelled {
            self.io.stop_input();
            if self.io.abandoned() {
                self.io.cancel_output();
            }
        }
        if !self.root_reported {
            let wait = unsafe { WaitForSingleObject(self.process.0, 0) };
            if wait == WAIT_OBJECT_0 {
                let mut exit = 0;
                let observation = if unsafe { GetExitCodeProcess(self.process.0, &mut exit) } == 0 {
                    Some(Error::native("GetExitCodeProcess"))
                } else {
                    None
                };
                status(
                    &self.id,
                    "root-exit",
                    serde_json::json!({"exitCode":if observation.is_none(){Some(exit)}else{None},"observationError":observation}),
                )?;
                self.root_reported = true;
                if self.owner._effective.spec.lifetime == "complete-tree" {
                    self.stop(false);
                }
            } else if wait == WAIT_FAILED {
                return Err(Error::native("WaitForSingleObject(root)"));
            }
        }
        if !self.tree_reported && self.owner.job.active()? == 0 {
            self.tree_reported = true;
            status(
                &self.id,
                "tree-empty",
                serde_json::json!({"activeProcesses":0}),
            )?;
            self.io.stop_input();
            self.io.close_console();
        }
        if self.tree_reported {
            self.io.stop_input();
        }
        Ok(())
    }
    fn release(&mut self) -> bool {
        let mut released = true;
        // No process can use PSEC/Job now: tree accounting and I/O joins were both confirmed.
        self.owner._psec.take();
        for handle in [&mut self.process, &mut self.owner.job.0] {
            if let Err(e) = handle.close() {
                self.errors.push(e);
                released = false;
            }
        }
        released
    }
}
// Last-resort owner: closing the Job kills descendants even after protocol/status failure.
impl Drop for Running {
    fn drop(&mut self) {
        if !self.tree_reported {
            let _ = self.owner.job.terminate();
        }
        if self.io_reported {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            self.io.stop_input();
            self.io.cancel_output();
            if self.tree_reported || self.owner.job.active().ok() == Some(0) {
                self.io.close_console();
            }
            if self.io.settled() {
                let _ = self.io.join();
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn drain_events(events: &Receiver<Event>, running: &mut Option<Running>) -> Result<()> {
    while let Ok(event) = events.try_recv() {
        match event {
            Event::Input(id, result) => match result {
                Ok(()) => status(&id, "ack", serde_json::json!({}))?,
                Err(e) => failure(&id, e)?,
            },
            Event::Reader(result) | Event::Output(result) => {
                if let Err(e) = result {
                    if let Some(r) = running.as_mut() {
                        r.errors.push(e);
                        r.stop(true);
                    }
                }
            }
            Event::InputClosed | Event::ConsoleClosed => {}
        }
    }
    Ok(())
}

pub fn run() -> Result<()> {
    let private = PrivateIo::capture()?;
    STATUS
        .set(Mutex::new(private.status))
        .map_err(|_| Error::state("private status already initialized"))?;
    let mut output = Some(private.output);
    let controls = controls(private.control);
    let (events_tx, events) = mpsc::sync_channel(64);
    let mut prepared: Option<Prepared> = None;
    let mut running: Option<Running> = None;
    let mut prepared_once = false;
    let mut ids = HashSet::new();
    let mut eof = false;
    let mut release_ids = vec![];
    loop {
        drain_events(&events, &mut running)?;
        if let Some(r) = running.as_mut() {
            if let Err(e) = r.tick() {
                failure(&r.id, e.clone())?;
                if r.errors.len() < 16 {
                    r.errors.push(e);
                }
                r.stop(true);
                r.closing = true;
            }
        }
        if running
            .as_ref()
            .is_some_and(|r| r.tree_reported && !r.io_reported && r.io.settled())
        {
            // Thread completion happens after its final event. Join, then drain those events before settlement.
            if let Some(r) = running.as_mut() {
                if let Err(e) = r.io.join() {
                    r.errors.push(e);
                }
            }
            drain_events(&events, &mut running)?;
            if let Some(r) = running.as_mut() {
                r.io_reported = true;
                status(
                    &r.id,
                    "io-settled",
                    serde_json::json!({"outputAbandoned":r.io.abandoned(),"discardedBytes":r.io.discarded(),"errors":r.errors}),
                )?;
            }
        }
        if running.as_ref().is_some_and(|r| {
            r.root_reported && r.tree_reported && r.io_reported && (r.closing || eof)
        }) {
            let mut r = running.take().unwrap();
            let released = r.release();
            let errors = r.errors.clone();
            let id = r.id.clone();
            drop(r);
            if release_ids.is_empty() {
                release_ids.push(id);
            }
            for release_id in release_ids.drain(..) {
                status(
                    &release_id,
                    "released",
                    serde_json::json!({"resourcesReleased":released,"errors":errors}),
                )?;
            }
            return Ok(());
        }
        if let Some(r) = running.as_ref() {
            if r.stop_at
                .is_some_and(|t| t.elapsed() > Duration::from_secs(10))
                && (!r.tree_reported || !r.io_reported)
            {
                let mut error =
                    Error::state("native cancellation did not settle within 10 seconds");
                error.code = "settlement-incomplete";
                error.cleanup = r.errors.clone();
                return Err(error);
            }
        }
        if eof && running.is_none() {
            drop(prepared.take());
            return Ok(());
        }
        let control = match controls.recv_timeout(Duration::from_millis(10)) {
            Ok(c) => c,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => Control::Eof,
        };
        match control {
            Control::Eof => {
                eof = true;
                if let Some(r) = running.as_mut() {
                    r.closing = true;
                    r.stop(true);
                } else {
                    drop(prepared.take());
                }
            }
            Control::Command(Err(e)) => {
                failure("protocol", e)?;
                eof = true;
                if let Some(r) = running.as_mut() {
                    r.closing = true;
                    r.stop(true);
                } else {
                    drop(prepared.take());
                }
            }
            Control::Command(Ok(command)) => {
                let id = command.id;
                if ids.len() >= 65536 || !ids.insert(id.clone()) {
                    failure(&id, Error::invalid("duplicate id or session command limit"))?;
                    continue;
                }
                let result = (|| -> Result<()> {
                    match command.action {
                        Action::Prepare {
                            engine,
                            spec,
                            policy,
                            protection,
                            console_mode,
                        } => {
                            if prepared_once {
                                return Err(Error::state("only one prepare is permitted"));
                            }
                            prepared_once = true;
                            let p = Prepared::new(engine, spec, policy, protection, console_mode)?;
                            status(
                                &id,
                                "ready",
                                serde_json::json!({"effectivePolicyDigest":p.effective.digest,"policyFingerprint":p.effective.policy.fingerprint,"helperSha256":p.effective.protection.helper_sha256}),
                            )?;
                            prepared = Some(p);
                        }
                        Action::Commit {
                            effective_policy_digest,
                        } => {
                            let p = prepared
                                .take()
                                .ok_or_else(|| Error::state("commit requires prepared state"))?;
                            let r = p.launch(
                                id.clone(),
                                &effective_policy_digest,
                                events_tx.clone(),
                                output
                                    .take()
                                    .ok_or_else(|| Error::state("output already consumed"))?,
                            )?;
                            status(&id, "started", serde_json::json!({"pid":r.pid}))?;
                            running = Some(r);
                        }
                        Action::Input { data } => running
                            .as_mut()
                            .ok_or_else(|| Error::state("workload not active"))?
                            .io
                            .send(Input::Bytes(id.clone(), data))?,
                        Action::EndInput => running
                            .as_mut()
                            .ok_or_else(|| Error::state("workload not active"))?
                            .io
                            .send(Input::End(id.clone()))?,
                        Action::Resize { cols, rows } => {
                            running
                                .as_ref()
                                .ok_or_else(|| Error::state("workload not active"))?
                                .io
                                .resize(cols, rows)?;
                            status(&id, "ack", serde_json::json!({}))?;
                        }
                        Action::Signal { signal } => {
                            let r = running
                                .as_mut()
                                .ok_or_else(|| Error::state("workload not active"))?;
                            match signal.as_str() {
                                "TERM" | "KILL" => r.stop(true),
                                "INT" if r.owner._effective.spec.transport == "pty" => {
                                    return r.io.send(Input::Bytes(id.clone(), vec![3]));
                                }
                                _ => {
                                    return Err(Error::invalid(
                                        "signal unsupported; pipe supports TERM/KILL, PTY also supports INT byte",
                                    ));
                                }
                            };
                            status(&id, "ack", serde_json::json!({}))?;
                        }
                        Action::Cancel { reason } => {
                            if !matches!(
                                reason.as_str(),
                                "cancelled"
                                    | "timeout"
                                    | "output-limit"
                                    | "authority-revoked"
                                    | "shutdown"
                            ) {
                                return Err(Error::invalid("invalid cancellation reason"));
                            }
                            if let Some(r) = running.as_mut() {
                                r.stop(true);
                            } else {
                                drop(prepared.take());
                            }
                            status(&id, "ack", serde_json::json!({}))?;
                        }
                        Action::Release => {
                            if let Some(r) = running.as_mut() {
                                r.closing = true;
                                r.stop(true);
                                release_ids.push(id.clone());
                            } else {
                                drop(prepared.take());
                                status(
                                    &id,
                                    "released",
                                    serde_json::json!({"resourcesReleased":true,"errors":[]}),
                                )?;
                                eof = true;
                            }
                        }
                    }
                    Ok(())
                })();
                if let Err(e) = result {
                    failure(&id, e)?;
                }
            }
        }
    }
}
