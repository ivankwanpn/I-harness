mod control;
mod dispatch;
mod event_drain;
pub(crate) mod notifications;
mod prepared;
mod running;
mod status;
mod tree;
pub(crate) mod waits;

use crate::{
    error::{Error, Result},
    transport::PrivateIo,
};
use control::controls;
use dispatch::Dispatch;
use event_drain::drain_events;
use running::Running;
use std::time::{Duration, Instant};

#[cfg(test)]
use {
    crate::{protocol, transport::Event},
    prepared::Prepared,
    std::thread,
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
    let inbox = notifications::Inbox::new();
    let mut controls = controls(private.control, inbox.clone())?;
    let events_tx = inbox.sender();
    let mut dispatch = Dispatch::new();
    let mut running: Option<Running> = None;
    let result = (|| -> Result<()> {
        loop {
            if inbox.take_failure() {
                return Err(Error::state("native lifecycle publication failed"));
            }
            drain_events(&inbox, &mut running)?;
            if let Some(r) = running.as_mut() {
                r.observe()?;
            }
            if running.as_ref().is_some_and(Running::waiting_for_io) {
                running.as_mut().unwrap().join_io();
                drain_events(&inbox, &mut running)?;
                running.as_mut().unwrap().report_io_settled()?;
            }
            if dispatch.release_running(&mut running)? {
                return Ok(());
            }
            dispatch.check_timeout(&mut running)?;
            if running.is_none() && dispatch.finish_prepared_on_eof()? {
                return Ok(());
            }
            if let Some(control) = inbox.take_control() {
                dispatch.handle(control, &mut running, &events_tx, &mut output)?;
                continue;
            }
            inbox.wait(running.as_ref().and_then(Running::deadline));
        }
    })();
    // One explicit fatal owner, with a single absolute drain bound. No status
    // output is attempted after status/transport failure.
    let deadline = Instant::now() + Duration::from_secs(5);
    if result.is_err() {
        if let Some(r) = running.as_mut() {
            r.stop(true);
        }
        while let Some(r) = running.as_mut() {
            event_drain::drain_quiet(&inbox, r);
            let _ = r.advance(false);
            if r.waiting_for_io() {
                r.join_io();
                event_drain::drain_quiet(&inbox, r);
                r.mark_quiet_io();
            }
            if r.release() {
                running.take();
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            inbox.take_failure();
            inbox.wait(Some(
                r.deadline()
                    .filter(|at| *at > Instant::now())
                    .unwrap_or(deadline)
                    .min(deadline),
            ));
        }
    }
    controls.stop();
    let mut step = 0u32;
    while !controls.finished() && Instant::now() < deadline {
        // STOP-ONLY: cover the admitted synchronous read's check-to-call race.
        controls.stop();
        let delay = Duration::from_millis((1u64 << step.min(7)).min(100));
        step += 1;
        inbox.wait(Some((Instant::now() + delay).min(deadline)));
        while inbox.try_recv().is_ok() {}
        while inbox.take_control().is_some() {}
    }
    if controls.finished() {
        if let Err(error) = controls.join() {
            std::mem::forget(controls);
            return Err(error);
        }
    } else {
        std::mem::forget(controls);
        return Err(Error::state(
            "control reader actual exit remains unconfirmed",
        ));
    }
    // Running's dependent fields are retained on incomplete teardown.
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dispatch_services_eof_cancel_and_release_with_a_saturated_controller_backlog() {
        // STATUS belongs to one helper process. Isolate this real status-writer
        // cut so existing tests still detect unmatched output via uninitialized
        // status, and the parent suite never inherits this fixture's OnceLock.
        if std::env::var_os("IH_NATIVE_DISPATCH_STATUS_CHILD").is_none() {
            use std::{
                os::windows::{io::AsRawHandle, process::CommandExt},
                process::Command,
            };
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "runner::tests::dispatch_services_eof_cancel_and_release_with_a_saturated_controller_backlog", "--nocapture"])
                .env("IH_NATIVE_DISPATCH_STATUS_CHILD", "1").creation_flags(CREATE_NO_WINDOW).spawn().unwrap();
            let exited =
                unsafe { WaitForSingleObject(child.as_raw_handle(), 10000) } == WAIT_OBJECT_0;
            if !exited {
                child.kill().unwrap();
            }
            let result = child.wait().unwrap();
            assert!(
                exited,
                "isolated Dispatch fixture exceeded its owned process watchdog"
            );
            assert!(
                result.success(),
                "isolated Dispatch fixture failed: {result}"
            );
            return;
        }
        use std::sync::mpsc;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let actor = thread::spawn(move || {
            let (mut r, inbox) = event_fixture("never-read", "unused");
            r.resume().unwrap();
            r.stop(true);
            let watchdog = Instant::now() + Duration::from_secs(5);
            while Instant::now() < watchdog {
                event_drain::drain_quiet(&inbox, &mut r);
                r.advance(false).unwrap();
                if r.waiting_for_io() {
                    r.join_io();
                    event_drain::drain_quiet(&inbox, &mut r);
                    r.mark_quiet_io();
                }
                if r.root_reported && r.tree_reported && r.io_reported {
                    break;
                }
                inbox.wait(Some(r.deadline().unwrap_or(watchdog).min(watchdog)));
            }
            assert!(r.root_reported && r.tree_reported && r.io_reported);
            let status_path =
                std::path::Path::new(&r.owner._effective.spec.cwd).join("actor-status.jsonl");
            status::initialize(std::fs::File::create(&status_path).unwrap()).unwrap();
            ready_tx.send(inbox.clone()).unwrap();
            continue_rx.recv().unwrap();
            let mut running = Some(r);
            let mut dispatch = Dispatch::new();
            let mut output = None;
            let events = inbox.sender();
            for body in [
                br#"{"version":1,"id":"automatic-eof","type":"end-input"}"#.as_slice(),
                br#"{"version":1,"id":"cancel-after-eof","type":"cancel","reason":"cancelled"}"#
                    .as_slice(),
                br#"{"version":1,"id":"release-after-eof","type":"release"}"#.as_slice(),
            ] {
                dispatch
                    .handle(
                        control::Control::Command(protocol::parse(body)),
                        &mut running,
                        &events,
                        &mut output,
                    )
                    .unwrap();
                drain_events(&inbox, &mut running).unwrap();
            }
            assert!(dispatch.release_running(&mut running).unwrap());
            assert!(running.is_none());
            let statuses = std::fs::read_to_string(&status_path)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
                .collect::<Vec<_>>();
            done_tx.send(statuses).unwrap();
        });
        let inbox = ready_rx.recv_timeout(Duration::from_secs(6)).unwrap();
        // A private controller producer runs after the previous reactor drain
        // and before the already admitted EOF action reaches Dispatch.
        for n in 0..32 {
            inbox
                .send(Event::Bridge(crate::msys::Observation::Ack(
                    format!("earlier-{n}"),
                    Ok(()),
                )))
                .unwrap();
        }
        continue_tx.send(()).unwrap();
        let timely = done_rx.recv_timeout(Duration::from_millis(500));
        let progressed = timely.is_ok();
        let statuses = timely.unwrap_or_else(|_| {
            while let Ok(event) = inbox.try_recv() {
                if matches!(event, Event::Bridge(crate::msys::Observation::Ack(..))) {
                    break;
                }
            }
            done_rx.recv_timeout(Duration::from_secs(3)).unwrap()
        });
        actor.join().unwrap();
        assert!(
            progressed,
            "actual Dispatch blocked on its own full reply Inbox before EOF/cancel/release could complete"
        );
        let ids = statuses
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        let expected = (0..32)
            .map(|n| format!("earlier-{n}"))
            .chain([
                "automatic-eof".into(),
                "cancel-after-eof".into(),
                "release-after-eof".into(),
            ])
            .collect::<Vec<_>>();
        assert_eq!(ids, expected);
        assert!(statuses[..34].iter().all(|value| value["type"] == "ack"));
        assert_eq!(statuses[34]["type"], "released");
        assert_eq!(statuses[34]["resourcesReleased"], true);
        eprintln!(
            "connected Dispatch: queuedControllerReplies=32, EOF/cancel ACKs=1/1, release=true, exactOrderedResponses={}",
            statuses.len()
        );
    }
    pub(super) fn event_fixture(
        mode: &str,
        argument: &str,
    ) -> (Running, std::sync::Arc<notifications::Inbox>) {
        let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/win32-x64/i-harness-windows-helper.exe")
            .canonicalize()
            .unwrap();
        let helper = helper
            .to_str()
            .unwrap()
            .strip_prefix("\\\\?\\")
            .unwrap_or(helper.to_str().unwrap())
            .to_owned();
        let (mut prepared, path) = prepared_fixture_with_argv(
            "unrestricted",
            Some(vec![
                helper,
                "--self-child".into(),
                mode.into(),
                argument.into(),
            ]),
        );
        let info = prepared
            .create_suspended(&prepared.effective.digest.clone())
            .unwrap();
        let inbox = notifications::Inbox::new();
        let running = prepared.into_running(
            info,
            "controlled-event-owner".into(),
            inbox.sender(),
            std::fs::File::create(path.join("output.bin")).unwrap(),
        );
        (running, inbox)
    }
    fn settle_event_fixture(running: &mut Running, inbox: &notifications::Inbox) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut root_before_tree = false;
        while Instant::now() < deadline {
            event_drain::drain_quiet(inbox, running);
            running.advance(false).unwrap();
            root_before_tree |= running.root_reported && !running.tree_reported;
            if running.waiting_for_io() {
                running.join_io();
                event_drain::drain_quiet(inbox, running);
                running.mark_quiet_io();
            }
            if running.root_reported && running.tree_reported && running.io_reported {
                assert!(running.release());
                return root_before_tree;
            }
            inbox.wait(Some(running.deadline().unwrap_or(deadline).min(deadline)));
        }
        running.stop(true);
        panic!("event owner did not obtain root/tree/I/O ACK before controlled deadline");
    }
    #[test]
    fn owned_member_exit_completes_retained_tree_with_no_job_hint_source() {
        let (mut running, inbox) = event_fixture("spawn-descendant", "350");
        running.resume().unwrap();
        assert!(
            settle_event_fixture(&mut running, &inbox),
            "original root exit must precede the retained descendant's factual exit"
        );
    }
    #[test]
    fn cancellation_before_root_exit_settles_from_native_waits_without_job_hints() {
        let (mut running, inbox) = event_fixture("never-read", "unused");
        running.resume().unwrap();
        running.stop(true);
        settle_event_fixture(&mut running, &inbox);
        assert!(running.root_reported && running.tree_reported && running.io_reported);
    }
    #[test]
    fn private_msys_stop_write_failure_does_not_emit_an_unmatched_public_response() {
        let rx = notifications::Inbox::new();
        let tx = rx.sender();
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
        let rx = notifications::Inbox::new();
        let tx = rx.sender();
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
        let rx = notifications::Inbox::new();
        let tx = rx.sender();
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
