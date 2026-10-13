use super::running::{PreparedOwner, Running};
use crate::{
    command_line::quote,
    error::{Error, Result},
    ffi::{Attributes, Handle, Psec, PsecApi, wide},
    job::Job,
    policy::Effective,
    protocol,
    transport::{Event, PreparedIo},
};
use std::{
    mem::{size_of, zeroed},
    ptr::null,
    sync::mpsc::SyncSender,
};
use windows_sys::Win32::{
    Foundation::*,
    System::{Console::SetConsoleCtrlHandler, Threading::*},
};

pub(super) struct Prepared {
    pub(super) effective: Effective,
    pub(super) psec: Option<Psec>,
    job: Option<Job>,
    workload_job: Option<Job>,
    io: PreparedIo,
    pub(super) errors: Vec<Error>,
}
impl Prepared {
    pub(super) fn new(
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
            workload_job: None,
            io: PreparedIo::empty(),
            errors: vec![],
        })
    }
    pub(super) fn initialize(&mut self, engine: &str) -> Result<()> {
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
        if self.effective.spec.msys_pty.is_some() {
            self.workload_job = Some(Job::new()?);
            let job = self.workload_job.as_ref().unwrap();
            job.configure()?;
            if unsafe { SetHandleInformation(job.0.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(Error::native("SetHandleInformation(MSYS workload Job)"));
            }
            self.effective.prepare_msys_image(job.0.0 as usize)?;
        }
        self.io.initialize(&self.effective.spec)
    }
    pub(super) fn release(&mut self) -> bool {
        let mut errors = self.io.release();
        if let Some(job) = self.job.as_mut() {
            if let Err(e) = job.0.close() {
                errors.push(e);
            }
        }
        errors.extend(self.effective.release());
        if let Some(job) = self.workload_job.as_mut() {
            if let Err(e) = job.0.close() {
                errors.push(e);
            }
        }
        let released = errors.is_empty();
        self.errors.extend(errors);
        if released {
            self.psec.take();
        }
        released
    }
    pub(super) fn create_suspended(&mut self, digest: &str) -> Result<PROCESS_INFORMATION> {
        if digest != self.effective.digest {
            return Err(Error::state("effective policy digest mismatch"));
        }
        self.effective.recheck()?;
        let spec = &self.effective.spec;
        let argv = self.effective.spawn_argv.as_ref().unwrap_or(&spec.argv);
        let line = if spec.argument_encoding == "crt" {
            argv.iter()
                .map(|s| {
                    if spec.msys_pty.is_some() {
                        crate::command_line::quote_always(s)
                    } else {
                        quote(s)
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            format!("{} /d /s /c {}", quote(&spec.argv[0]), spec.argv[4])
        };
        if line.encode_utf16().count() >= 32767 {
            return Err(Error::invalid("command line exceeds 32766 UTF16 units"));
        }
        let mut command = wide(&line);
        let executable = wide(&argv[0]);
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
        if let Some(job) = &self.workload_job {
            inherited.push(job.0.0);
        }
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
        // CTRL+C's ignore attribute is inherited independently of handles, even
        // when attaching the child to our new pseudoconsole. A launcher in a
        // new process group can leave it set. Reset only this dedicated helper
        // before its ConPTY child is created; existing callers are unaffected.
        if pty && unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
            return Err(Error::native("SetConsoleCtrlHandler(ConPTY)"));
        }
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
    pub(super) fn into_running(
        self,
        info: PROCESS_INFORMATION,
        id: String,
        events: SyncSender<Event>,
        output: std::fs::File,
    ) -> Running {
        let io = self.io.start(events, output);
        Running::new(
            Handle(info.hProcess),
            Handle(info.hThread),
            info.dwProcessId,
            io,
            PreparedOwner {
                _effective: self.effective,
                _psec: self.psec,
                job: self.job.expect("initialized job"),
                workload_job: self.workload_job,
            },
            id,
            self.errors,
        )
    }
}
