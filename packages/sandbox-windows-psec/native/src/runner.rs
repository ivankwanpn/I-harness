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
#[cfg(test)]
thread_local! {static FAIL_RESUME:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}
#[cfg(test)]
thread_local! {static FAIL_ASSIGN:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}

struct Prepared {
    effective: Effective,
    psec: Option<Psec>,
    job: Option<Job>,
    io: PreparedIo,
    errors: Vec<Error>,
}
struct Running {
    process: Handle,
    primary_thread: Handle,
    assigned: bool,
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
        Ok(Self {
            effective,
            psec: None,
            job: None,
            io: PreparedIo::empty(),
            errors: vec![],
        })
    }
    fn initialize(&mut self, engine: &str) -> Result<()> {
        self.psec = if engine == "psec" {
            let api = PsecApi::load()?;
            if api.flags & 1 == 0 {
                return Err(Error::native_code("PSEC support flags", 50));
            }
            if !self.effective.protection.deny_paths.is_empty() && api.flags & 2 == 0 {
                return Err(Error::native_code("PSEC deny paths unsupported", 50));
            }
            Some(api.create(&self.effective.bytes)?)
        } else {
            None
        };
        self.job = Some(Job::new()?);
        self.job.as_ref().unwrap().configure()?;
        self.io.initialize(&self.effective.spec)
    }
    fn release(&mut self) -> bool {
        let mut errors = self.io.release();
        if let Some(job) = self.job.as_mut() {
            if let Err(e) = job.0.close() {
                errors.push(e);
            }
        }
        errors.extend(self.effective.release());
        let released = errors.is_empty();
        self.errors.extend(errors);
        if released {
            self.psec.take();
        }
        released
    }
    fn create_suspended(&mut self, digest: &str) -> Result<PROCESS_INFORMATION> {
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
        // LastError is captured before DeleteProcThreadAttributeList. The list is
        // gone before any backing owner moves into the running/rollback state.
        attrs.finish_create(created)?;
        Ok(info)
    }
    fn into_running(
        self,
        info: PROCESS_INFORMATION,
        id: String,
        events: SyncSender<Event>,
        output: std::fs::File,
    ) -> Running {
        let io = self.io.start(events, output);
        Running {
            process: Handle(info.hProcess),
            primary_thread: Handle(info.hThread),
            assigned: false,
            pid: info.dwProcessId,
            root_reported: false,
            tree_reported: false,
            io_reported: false,
            io,
            owner: PreparedOwner {
                _effective: self.effective,
                _psec: self.psec,
                job: self.job.expect("initialized job"),
            },
            id,
            cancelled: false,
            closing: false,
            errors: self.errors,
            stop_at: None,
        }
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
    fn resume(&mut self) -> Result<()> {
        let errors = self.io.close_pending_handles();
        if !errors.is_empty() {
            let mut error = Error::state("failed to close parent workload endpoints");
            error.cleanup = errors;
            return Err(error);
        }
        #[cfg(test)]
        if FAIL_ASSIGN.with(|flag| flag.replace(false)) {
            return Err(Error::native_code("AssignProcessToJobObject", 5));
        }
        self.owner.job.assign(self.process.0)?;
        self.assigned = true;
        #[cfg(test)]
        if FAIL_RESUME.with(|flag| flag.replace(false)) {
            return Err(Error::native_code("ResumeThread", 6));
        }
        if unsafe { ResumeThread(self.primary_thread.0) } == u32::MAX {
            return Err(Error::native("ResumeThread"));
        }
        self.primary_thread.close()
    }
    fn remember(&mut self, error: Error) {
        if self.errors.len() < 16 {
            self.errors.push(error);
        }
    }
    fn terminate_owned(&mut self) {
        // Assignment can fail after process creation. Such a suspended process is
        // not in the Job, so Job termination alone is never treated as rollback.
        if !self.assigned && unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            if unsafe { TerminateProcess(self.process.0, 137) } == 0 {
                self.remember(Error::native("TerminateProcess(rollback)"));
            }
        }
        if let Err(e) = self.owner.job.terminate() {
            self.remember(e);
        }
    }
    fn stop(&mut self, discard: bool) {
        if !self.cancelled {
            self.cancelled = true;
            self.terminate_owned();
        }
        self.io.stop_input();
        if discard {
            self.stop_at.get_or_insert_with(Instant::now);
            self.io.cancel_output();
        }
    }
    fn tick(&mut self) -> Result<()> {
        if self.cancelled {
            for e in self.io.close_pending_handles() {
                self.remember(e);
            }
            if !self.root_reported {
                self.terminate_owned();
            }
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
        if !self.tree_reported && self.root_reported && self.owner.job.active()? == 0 {
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
        if !self.root_reported || !self.tree_reported || !self.io_reported {
            return false;
        }
        let mut released = true;
        // No process can use PSEC/Job now: tree accounting and I/O joins were both confirmed.
        for e in self.io.close_pending_handles() {
            self.errors.push(e);
            released = false;
        }
        for handle in [
            &mut self.primary_thread,
            &mut self.process,
            &mut self.owner.job.0,
        ] {
            if let Err(e) = handle.close() {
                self.errors.push(e);
                released = false;
            }
        }
        let errors = self.owner._effective.release();
        if !errors.is_empty() {
            released = false;
            self.errors.extend(errors);
        }
        if released {
            self.owner._psec.take();
        }
        released
    }
}
// Last-resort owner: closing the Job kills descendants even after protocol/status failure.
impl Drop for Running {
    fn drop(&mut self) {
        if !self.tree_reported {
            self.terminate_owned();
        }
        if self.io_reported {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            for e in self.io.close_pending_handles() {
                self.remember(e);
            }
            self.io.stop_input();
            self.io.cancel_output();
            if self.tree_reported
                || (unsafe { WaitForSingleObject(self.process.0, 0) } == WAIT_OBJECT_0
                    && self.owner.job.active().ok() == Some(0))
            {
                self.io.close_console();
            }
            if self.io.settled() {
                let _ = self.io.join();
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        // A fatal channel/EOF failure can prevent further release retries. Never
        // explicitly close PSEC while an observed tree or drain is incomplete.
        let tree_empty = self.tree_reported
            || (unsafe { WaitForSingleObject(self.process.0, 0) } == WAIT_OBJECT_0
                && self.owner.job.active().ok() == Some(0));
        if !tree_empty || !self.io.settled() {
            if let Some(psec) = self.owner._psec.take() {
                std::mem::forget(psec);
            }
        }
    }
}

fn drain_events(events: &Receiver<Event>, running: &mut Option<Running>) -> Result<()> {
    while let Ok(event) = events.try_recv() {
        match event {
            Event::RetainedHandle(handle) => {
                if let Some(r) = running.as_mut() {
                    r.io.pending_handles.push(handle);
                }
            }
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
    let mut commit_allowed = false;
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
            let r = running.as_mut().unwrap();
            let released = r.release();
            let errors = r.errors.clone();
            let id = r.id.clone();
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
            if released {
                running.take();
                return Ok(());
            }
            if eof {
                let mut e = Error::state("release failed after control EOF");
                e.cleanup = errors;
                return Err(e);
            }
            // Preserve the owner and all failed handles. A new release request is
            // a cleanup retry, never permission to prepare/launch again.
            running.as_mut().unwrap().closing = false;
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
                if eof {
                    return Err(error);
                }
                failure(&r.id, error.clone())?;
                for release_id in release_ids.drain(..) {
                    status(
                        &release_id,
                        "released",
                        serde_json::json!({"resourcesReleased":false,"errors":[error]}),
                    )?;
                }
                let r = running.as_mut().unwrap();
                r.closing = false;
                r.stop_at = None;
            }
        }
        if eof && running.is_none() {
            if let Some(p) = prepared.as_mut() {
                if !p.release() {
                    let mut error = Error::state("prepared rollback failed after control EOF");
                    error.cleanup = p.errors.clone();
                    return Err(error);
                }
            }
            prepared.take();
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
                }
            }
            Control::Command(Err(e)) => {
                failure("protocol", e)?;
                eof = true;
                if let Some(r) = running.as_mut() {
                    r.closing = true;
                    r.stop(true);
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
                            let p = Prepared::new(
                                engine.clone(),
                                spec,
                                policy,
                                protection,
                                console_mode,
                            )?;
                            prepared = Some(p);
                            let p = prepared.as_mut().unwrap();
                            if let Err(mut error) = p.initialize(&engine) {
                                p.release();
                                error.cleanup.extend(p.errors.clone());
                                return Err(error);
                            }
                            status(
                                &id,
                                "ready",
                                serde_json::json!({"effectivePolicyDigest":p.effective.digest,"policyFingerprint":p.effective.policy.fingerprint,"helperSha256":p.effective.protection.helper_sha256}),
                            )?;
                            commit_allowed = true;
                        }
                        Action::Commit {
                            effective_policy_digest,
                        } => {
                            if !commit_allowed {
                                return Err(Error::state(
                                    "commit requires unconsumed prepared state",
                                ));
                            }
                            commit_allowed = false;
                            let p = prepared
                                .as_mut()
                                .ok_or_else(|| Error::state("prepared owner missing"))?;
                            let info = match p.create_suspended(&effective_policy_digest) {
                                Ok(info) => info,
                                Err(mut error) => {
                                    p.release();
                                    error.cleanup.extend(p.errors.clone());
                                    return Err(error);
                                }
                            };
                            let p = prepared.take().unwrap();
                            let r = p.into_running(
                                info,
                                id.clone(),
                                events_tx.clone(),
                                output.take().expect("one commit consumes private output"),
                            );
                            running = Some(r);
                            let r = running.as_mut().unwrap();
                            if let Err(mut error) = r.resume() {
                                r.remember(error.clone());
                                r.stop(true);
                                error.cleanup.extend(r.errors.iter().skip(1).cloned());
                                return Err(error);
                            }
                            status(&id, "started", serde_json::json!({"pid":r.pid}))?;
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
                                commit_allowed = false;
                                if let Some(p) = prepared.as_mut() {
                                    if !p.release() {
                                        let mut error =
                                            Error::state("prepared cancellation cleanup failed");
                                        error.cleanup = p.errors.clone();
                                        return Err(error);
                                    }
                                }
                            }
                            status(&id, "ack", serde_json::json!({}))?;
                        }
                        Action::Release => {
                            if let Some(r) = running.as_mut() {
                                r.closing = true;
                                r.stop(true);
                                release_ids.push(id.clone());
                            } else {
                                commit_allowed = false;
                                let (released, errors) = if let Some(p) = prepared.as_mut() {
                                    (p.release(), p.errors.clone())
                                } else {
                                    (true, vec![])
                                };
                                status(
                                    &id,
                                    "released",
                                    serde_json::json!({"resourcesReleased":released,"errors":errors}),
                                )?;
                                if released {
                                    prepared.take();
                                    eof = true;
                                }
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

#[cfg(test)]
mod tests {
    use super::*;
    fn prepared_fixture(engine: &str) -> (Prepared, std::path::PathBuf) {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = repo.join(format!(
            ".tmp/sandbox-redesign-native-unit-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        let cwd = path
            .to_str()
            .unwrap()
            .strip_prefix("\\\\?\\")
            .unwrap_or(path.to_str().unwrap());
        let exe = std::env::current_exe().unwrap();
        let exe_text = exe
            .to_str()
            .unwrap()
            .strip_prefix("\\\\?\\")
            .unwrap_or(exe.to_str().unwrap());
        let spec=serde_json::from_value(serde_json::json!({"argv":[exe_text,"--list"],"cwd":cwd,"env":{"SystemRoot":std::env::var("SystemRoot").unwrap(),"LOCALAPPDATA":cwd},"owner":{"sessionId":"native-unit"},"transport":"pipe","lifetime":"retain-tree","argumentEncoding":"crt"})).unwrap();
        let policy=serde_json::from_value(serde_json::json!({"mode":if engine=="psec"{"workspace-write"}else{"danger-full-access"},"owner":{"sessionId":"native-unit"},"authorityRevision":"test","authorityKind":"bound","primaryRoot":cwd,"readable":"caller","authorityRoots":[cwd],"writeRoots":[cwd],"referenceRoots":[],"fingerprint":"native-unit"})).unwrap();
        let protection = protocol::Protection {
            read_only_paths: vec![],
            deny_paths: vec![],
            helper_sha256: crate::policy::file_hash(&exe).unwrap(),
        };
        let mut p = Prepared::new(engine.into(), spec, policy, protection, None).unwrap();
        p.initialize(engine).unwrap();
        (p, path)
    }
    #[test]
    fn prepared_owner_reports_close_failure_and_recovers_without_drop() {
        let (mut p, _path) = prepared_fixture("psec");
        crate::ffi::FAIL_NEXT_CLOSE.with(|flag| flag.set(true));
        assert!(!p.release());
        assert_eq!(p.errors[0].api, "CloseHandle");
        assert_eq!(p.errors[0].native_code, Some(5));
        assert!(
            p.psec.is_some(),
            "PSEC must remain owned until every retained handle is closed"
        );
        assert!(p.release());
        assert!(p.psec.is_none());
        assert!(
            !p.errors.is_empty(),
            "retry preserves the earlier close cause"
        );
    }
    fn failed_launch_releases_only_after_observed_exit_and_drain(assign_failure: bool) {
        let (mut p, path) = prepared_fixture("psec");
        let digest = p.effective.digest.clone();
        let info = p.create_suspended(&digest).unwrap();
        assert_eq!(
            crate::ffi::live_attributes(),
            0,
            "attribute list must be destroyed before the PSEC backing owner moves"
        );
        let (tx, rx) = mpsc::sync_channel(64);
        let mut r = p.into_running(
            info,
            "failed-commit".into(),
            tx,
            std::fs::File::create(path.join("output.bin")).unwrap(),
        );
        if assign_failure {
            FAIL_ASSIGN.with(|flag| flag.set(true));
        } else {
            FAIL_RESUME.with(|flag| flag.set(true));
        }
        let error = r.resume().unwrap_err();
        assert_eq!(
            error.api,
            if assign_failure {
                "AssignProcessToJobObject"
            } else {
                "ResumeThread"
            }
        );
        assert!(
            !r.release(),
            "a created process cannot be released before verified settlement"
        );
        assert!(r.owner._psec.is_some());
        r.stop(true);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            r.io.stop_input();
            r.io.cancel_output();
            assert!(r.io.close_pending_handles().is_empty());
            r.root_reported = unsafe { WaitForSingleObject(r.process.0, 0) } == WAIT_OBJECT_0;
            if r.root_reported && r.owner.job.active().unwrap() == 0 {
                r.tree_reported = true;
                r.io.close_console();
            }
            while let Ok(event) = rx.try_recv() {
                if let Event::RetainedHandle(handle) = event {
                    r.io.pending_handles.push(handle);
                }
            }
            if r.tree_reported && r.io.settled() {
                r.io.join().unwrap();
                while let Ok(event) = rx.try_recv() {
                    if let Event::RetainedHandle(handle) = event {
                        r.io.pending_handles.push(handle);
                    }
                }
                r.io_reported = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(r.root_reported && r.tree_reported && r.io_reported);
        assert!(r.owner._psec.is_some());
        crate::ffi::FAIL_NEXT_CLOSE.with(|flag| flag.set(true));
        assert!(!r.release());
        assert!(r.owner._psec.is_some());
        assert_eq!(r.errors.last().unwrap().api, "CloseHandle");
        assert!(r.release());
        assert!(r.owner._psec.is_none());
    }
    #[test]
    fn resume_failure_retains_owner_until_retryable_release() {
        failed_launch_releases_only_after_observed_exit_and_drain(false);
    }
    #[test]
    fn assignment_failure_reaps_unassigned_child_before_release() {
        failed_launch_releases_only_after_observed_exit_and_drain(true);
    }
}
