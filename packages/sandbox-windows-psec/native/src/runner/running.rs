use super::status::{failure, status};
#[cfg(test)]
use super::{FAIL_ASSIGN, FAIL_RESUME};
use crate::{
    error::{Error, Result},
    ffi::{Handle, Psec},
    job::Job,
    policy::Effective,
    transport::{Input, RunningIo},
};
use std::{
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::*, System::Threading::*};

pub(super) struct Running {
    pub(super) process: Handle,
    primary_thread: Handle,
    assigned: bool,
    pid: u32,
    pub(super) root_reported: bool,
    pub(super) tree_reported: bool,
    pub(super) io_reported: bool,
    pub(super) io: RunningIo,
    pub(super) owner: PreparedOwner,
    id: String,
    cancelled: bool,
    job_termination: JobTermination,
    closing: bool,
    pub(super) errors: Vec<Error>,
    stop_at: Option<Instant>,
    msys_done: bool,
    msys_root: Option<u32>,
    msys_stop_at: Option<Instant>,
    msys_stop_sent: bool,
}
enum JobTermination {
    Pending,
    Submitted,
    Empty,
}
pub(super) struct PreparedOwner {
    pub(super) _effective: Effective,
    pub(super) _psec: Option<Psec>,
    pub(super) job: Job,
    pub(super) workload_job: Option<Job>,
}
impl Running {
    pub(super) fn new(
        process: Handle,
        primary_thread: Handle,
        pid: u32,
        io: RunningIo,
        owner: PreparedOwner,
        id: String,
        errors: Vec<Error>,
    ) -> Self {
        Self {
            process,
            primary_thread,
            assigned: false,
            pid,
            root_reported: false,
            tree_reported: false,
            io_reported: false,
            io,
            owner,
            id,
            cancelled: false,
            job_termination: JobTermination::Pending,
            closing: false,
            errors,
            stop_at: None,
            msys_done: false,
            msys_root: None,
            msys_stop_at: None,
            msys_stop_sent: false,
        }
    }

    pub(super) fn resume(&mut self) -> Result<()> {
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
    pub(super) fn remember(&mut self, error: Error) {
        if self.errors.len() < 16 {
            self.errors.push(error);
        }
    }
    pub(super) fn id(&self) -> &str {
        &self.id
    }
    pub(super) fn pid(&self) -> u32 {
        self.pid
    }
    pub(super) fn errors(&self) -> &[Error] {
        &self.errors
    }
    pub(super) fn send_input(&mut self, input: Input) -> Result<()> {
        self.io.send(input)
    }
    pub(super) fn resize(&mut self, id: String, cols: i16, rows: i16) -> Result<bool> {
        self.io.resize(id, cols, rows)
    }
    // true requires a public ack; INT is acknowledged by its input worker.
    pub(super) fn signal(&mut self, id: &str, signal: &str) -> Result<bool> {
        match signal {
            "TERM" | "KILL" => self.stop(true),
            "INT" if self.owner._effective.spec.transport == "pty" => {
                self.io.send(Input::Bytes(id.to_owned(), vec![3]))?;
                return Ok(false);
            }
            _ => {
                return Err(Error::invalid(
                    "signal unsupported; pipe supports TERM/KILL, PTY also supports INT byte",
                ));
            }
        }
        Ok(true)
    }
    pub(super) fn begin_close(&mut self) {
        self.closing = true;
        self.stop(true);
    }
    pub(super) fn observe(&mut self) -> Result<()> {
        if let Err(e) = self.tick() {
            failure(&self.id, e.clone())?;
            self.remember(e);
            self.stop(true);
            self.closing = true;
        }
        Ok(())
    }
    pub(super) fn waiting_for_io(&self) -> bool {
        self.tree_reported && !self.io_reported && self.io.settled()
    }
    pub(super) fn join_io(&mut self) {
        if let Err(e) = self.io.join() {
            self.errors.push(e);
        }
    }
    pub(super) fn report_io_settled(&mut self) -> Result<()> {
        self.io_reported = true;
        status(
            &self.id,
            "io-settled",
            serde_json::json!({
                "outputAbandoned":self.io.abandoned(),"discardedBytes":self.io.discarded(),"errors":self.errors
            }),
        )
    }
    pub(super) fn ready_to_release(&self, eof: bool) -> bool {
        self.root_reported && self.tree_reported && self.io_reported && (self.closing || eof)
    }
    pub(super) fn retry_close(&mut self) {
        self.closing = false;
    }
    pub(super) fn timeout_error(&self) -> Option<Error> {
        if self
            .stop_at
            .is_some_and(|t| t.elapsed() > Duration::from_secs(10))
            && (!self.tree_reported || !self.io_reported)
        {
            let mut error = Error::state("native cancellation did not settle within 10 seconds");
            error.code = "settlement-incomplete";
            error.cleanup = self.errors.clone();
            Some(error)
        } else {
            None
        }
    }
    pub(super) fn clear_timeout(&mut self) {
        self.closing = false;
        self.stop_at = None;
    }
    pub(super) fn retain_handle(&mut self, handle: Handle) {
        self.io.pending_handles.push(handle);
    }
    pub(super) fn output_failed(&mut self, error: Error) {
        self.errors.push(error);
        self.stop(true);
    }
    pub(super) fn observe_msys_root(&mut self, code: u32) {
        self.msys_root = Some(code);
    }
    pub(super) fn observe_bridge_done(&mut self, result: Result<()>) {
        self.msys_done = true;
        if let Err(e) = result {
            if !self.cancelled {
                self.remember(e);
                self.stop(true);
            }
        }
    }
    fn observing_msys_exit(&self) -> bool {
        self.assigned
            && self.owner.workload_job.is_some()
            && !self.msys_done
            && self
                .msys_stop_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
            && unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0
    }
    fn stop_workload_input(&mut self) {
        if self.observing_msys_exit() {
            self.io.seal_input();
        } else {
            self.io.stop_input();
        }
    }
    fn terminate_owned(&mut self, preserve_observer: bool) {
        // Assignment can fail after process creation. Such a suspended process is
        // not in the Job, so Job termination alone is never treated as rollback.
        if !self.assigned && unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            if unsafe { TerminateProcess(self.process.0, 137) } == 0 {
                self.remember(Error::native("TerminateProcess(rollback)"));
            }
        }
        if preserve_observer && self.observing_msys_exit() {
            // Keep the trusted relay/reaper alive while killing only admitted
            // workload processes. Repeat accounting/termination for a child
            // that joins its Job during an early cancellation. The outer Job
            // remains the fallback owner if the adapter fails to report/exit.
            if self.msys_root.is_none() {
                if !self.msys_stop_sent {
                    match self.io.send(Input::Stop("_owned-stop".into())) {
                        Ok(()) => self.msys_stop_sent = true,
                        Err(error) if error.code == "input-backpressure" => {}
                        Err(error) => self.remember(error),
                    }
                }
                return;
            }
            let workload = self.owner.workload_job.as_ref().unwrap();
            let result = workload.active().and_then(|active| {
                if active == 0 {
                    Ok(())
                } else {
                    workload.terminate()
                }
            });
            if let Err(error) = result {
                self.remember(error);
            }
            return;
        }
        if self.tree_reported {
            self.job_termination = JobTermination::Empty;
        }
        if matches!(self.job_termination, JobTermination::Pending) {
            match self.owner.job.active() {
                Ok(0) => self.job_termination = JobTermination::Empty,
                Ok(_) => match self.owner.job.terminate() {
                    Ok(()) => self.job_termination = JobTermination::Submitted,
                    Err(error) => self.remember(error),
                },
                Err(error) => self.remember(error),
            }
        }
    }
    pub(super) fn stop(&mut self, discard: bool) {
        self.cancelled = true;
        if self.owner.workload_job.is_some() {
            self.msys_stop_at.get_or_insert_with(Instant::now);
        }
        // A prior cancellation request/root exit says nothing about whether a
        // failed Job termination has been retried. Keep that obligation separate.
        self.terminate_owned(true);
        self.stop_workload_input();
        if discard {
            self.stop_at.get_or_insert_with(Instant::now);
            self.io.cancel_output();
        }
    }
    pub(super) fn tick(&mut self) -> Result<()> {
        if self.cancelled {
            for e in self.io.close_pending_handles() {
                self.remember(e);
            }
            self.terminate_owned(true);
            self.stop_workload_input();
            if self.io.abandoned() {
                self.io.cancel_output();
            }
        }
        if !self.root_reported {
            let wait = unsafe { WaitForSingleObject(self.process.0, 0) };
            let adapter = self.owner._effective.spec.msys_pty.is_some();
            if self.msys_root.is_some() || (wait == WAIT_OBJECT_0 && (!adapter || self.msys_done)) {
                let mut exit = 0;
                let observation = if let Some(code) = self.msys_root {
                    exit = code;
                    None
                } else if adapter {
                    Some(Error::state(
                        "MSYS adapter ended before observing child exit",
                    ))
                } else if unsafe { GetExitCodeProcess(self.process.0, &mut exit) } == 0 {
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
                if self.owner._effective.spec.lifetime == "complete-tree"
                    && self.owner.workload_job.is_none()
                {
                    self.stop(false);
                }
            } else if wait == WAIT_FAILED {
                return Err(Error::native("WaitForSingleObject(root)"));
            }
        }
        if self.root_reported
            && !self.cancelled
            && self.owner._effective.spec.lifetime == "complete-tree"
        {
            if let Some(job) = &self.owner.workload_job {
                if job.active()? > 0 {
                    job.terminate()?;
                }
            }
        }
        if !self.tree_reported && self.root_reported && self.owner.job.active()? == 0 {
            self.tree_reported = true;
            self.job_termination = JobTermination::Empty;
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
    pub(super) fn release(&mut self) -> bool {
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
        if let Some(job) = self.owner.workload_job.as_mut() {
            if let Err(e) = job.0.close() {
                self.errors.push(e);
                released = false;
            }
        }
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
            self.terminate_owned(false);
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
