mod control;
mod dispatch;
mod event_drain;
mod prepared;
mod running;
mod status;

use crate::{
    error::{Error, Result},
    transport::PrivateIo,
};
use control::{Control, controls};
use dispatch::Dispatch;
use event_drain::drain_events;
use running::Running;
use std::{sync::mpsc, time::Duration};

#[cfg(test)]
use {
    crate::{protocol, transport::Event},
    prepared::Prepared,
    std::{thread, time::Instant},
    windows_sys::Win32::{Foundation::*, System::Threading::*},
};
#[cfg(test)]
thread_local! {static FAIL_RESUME:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}
#[cfg(test)]
thread_local! {static FAIL_ASSIGN:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}

pub fn fatal(error: Error) {
    let _ = status::failure("helper", error);
}

pub fn run() -> Result<()> {
    let private = PrivateIo::capture()?;
    status::initialize(private.status)?;
    let mut output = Some(private.output);
    let controls = controls(private.control);
    let (events_tx, events) = mpsc::sync_channel(64);
    let mut dispatch = Dispatch::new();
    let mut running: Option<Running> = None;
    loop {
        drain_events(&events, &mut running)?;
        if let Some(r) = running.as_mut() {
            r.observe()?;
        }
        if running.as_ref().is_some_and(Running::waiting_for_io) {
            // Join before draining the workers' final events and publishing settlement.
            running.as_mut().unwrap().join_io();
            drain_events(&events, &mut running)?;
            running.as_mut().unwrap().report_io_settled()?;
        }
        if dispatch.release_running(&mut running)? {
            return Ok(());
        }
        dispatch.check_timeout(&mut running)?;
        if running.is_none() && dispatch.finish_prepared_on_eof()? {
            return Ok(());
        }
        let control = match controls.recv_timeout(Duration::from_millis(10)) {
            Ok(c) => c,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => Control::Eof,
        };
        dispatch.handle(control, &mut running, &events_tx, &mut output)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_msys_stop_write_failure_does_not_emit_an_unmatched_public_response() {
        let (tx, rx) = mpsc::sync_channel(1);
        tx.send(Event::Input(
            "_owned-stop".into(),
            Err(Error::state("controller closed before delivery")),
        ))
        .unwrap();
        // There is no public pending request for the private controller ID.
        // Routing this to status() would require an unrelated public transport.
        let result = drain_events(&rx, &mut None);
        assert!(
            result.is_ok(),
            "private controller delivery must stay with its native owner: {result:?}"
        );
    }
    fn prepared_fixture(engine: &str) -> (Prepared, std::path::PathBuf) {
        prepared_fixture_with_argv(engine, None)
    }
    fn prepared_fixture_with_argv(
        engine: &str,
        argv: Option<Vec<String>>,
    ) -> (Prepared, std::path::PathBuf) {
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
        let argv = argv.unwrap_or_else(|| vec![exe_text.into(), "--list".into()]);
        let spec=serde_json::from_value(serde_json::json!({"argv":argv,"cwd":cwd,"env":{"SystemRoot":std::env::var("SystemRoot").unwrap(),"LOCALAPPDATA":cwd},"owner":{"sessionId":"native-unit"},"transport":"pipe","lifetime":"retain-tree","argumentEncoding":"crt"})).unwrap();
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
    #[test]
    fn retained_root_exit_does_not_suppress_failed_job_termination_retry() {
        let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/win32-x64/i-harness-windows-helper.exe")
            .canonicalize()
            .unwrap();
        let helper_text = helper
            .to_str()
            .unwrap()
            .strip_prefix("\\\\?\\")
            .unwrap_or(helper.to_str().unwrap())
            .to_owned();
        let (mut p, path) = prepared_fixture_with_argv(
            "unrestricted",
            Some(vec![
                helper_text,
                "--self-child".into(),
                "spawn-descendant".into(),
                "30000".into(),
            ]),
        );
        let info = p.create_suspended(&p.effective.digest.clone()).unwrap();
        let (tx, rx) = mpsc::sync_channel(64);
        let mut r = p.into_running(
            info,
            "retained-retry".into(),
            tx,
            std::fs::File::create(path.join("output.bin")).unwrap(),
        );
        r.resume().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(r.process.0, 5000) },
            WAIT_OBJECT_0
        );
        r.root_reported = true;
        assert!(
            r.owner.job.active().unwrap() > 0,
            "root must leave an actual live descendant"
        );
        crate::job::TERMINATE_CALLS.with(|n| n.set(0));
        crate::job::FAIL_NEXT_TERMINATE.with(|f| f.set(true));
        r.stop(true);
        assert_eq!(crate::job::TERMINATE_CALLS.with(|n| n.get()), 1);
        assert!(r.owner.job.active().unwrap() > 0);
        assert!(!r.tree_reported);
        assert!(
            r.errors
                .iter()
                .any(|e| e.api == "TerminateJobObject" && e.native_code == Some(5))
        );
        // This is the same retry path used by a later cancel/release request.
        r.stop(true);
        assert_eq!(
            crate::job::TERMINATE_CALLS.with(|n| n.get()),
            2,
            "cleanup retry must call the failed native operation even after root exit"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if r.owner.job.active().unwrap() == 0 {
                r.tree_reported = true;
                r.io.close_console();
            }
            r.io.stop_input();
            r.io.cancel_output();
            while let Ok(event) = rx.try_recv() {
                if let Event::RetainedHandle(h) = event {
                    r.io.pending_handles.push(h);
                }
            }
            if r.tree_reported && r.io.settled() {
                r.io.join().unwrap();
                r.io_reported = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(r.tree_reported && r.io_reported);
        r.stop(true);
        assert_eq!(
            crate::job::TERMINATE_CALLS.with(|n| n.get()),
            2,
            "no further termination after confirmed ActiveProcesses0"
        );
        assert!(r.release());
        assert!(
            r.errors
                .iter()
                .any(|e| e.api == "TerminateJobObject" && e.native_code == Some(5))
        );
    }
}
