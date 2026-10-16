use super::{
    control::Control,
    prepared::Prepared,
    running::Running,
    status::{failure, status},
};
use crate::{
    error::{Error, Result},
    protocol::{self, Action},
    transport::{Event, Input},
};
use std::{collections::HashSet, sync::mpsc::SyncSender};

pub(super) struct Dispatch {
    prepared: Option<Prepared>,
    prepared_once: bool,
    commit_allowed: bool,
    ids: HashSet<String>,
    eof: bool,
    release_ids: Vec<String>,
}
impl Dispatch {
    pub(super) fn new() -> Self {
        Self {
            prepared: None,
            prepared_once: false,
            commit_allowed: false,
            ids: HashSet::new(),
            eof: false,
            release_ids: vec![],
        }
    }
    pub(super) fn handle(
        &mut self,
        control: Control,
        running: &mut Option<Running>,
        events_tx: &SyncSender<Event>,
        output: &mut Option<std::fs::File>,
    ) -> Result<()> {
        match control {
            Control::Eof => {
                self.eof = true;
                if let Some(r) = running.as_mut() {
                    r.begin_close();
                }
            }
            Control::Command(Err(e)) => {
                failure("protocol", e)?;
                self.eof = true;
                if let Some(r) = running.as_mut() {
                    r.begin_close();
                }
            }
            Control::Command(Ok(command)) => {
                let id = command.id;
                if self.ids.len() >= 65536 || !self.ids.insert(id.clone()) {
                    failure(&id, Error::invalid("duplicate id or session command limit"))?;
                    return Ok(());
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
                            self.prepare(&id, engine, spec, policy, protection, console_mode)?;
                        }
                        Action::Commit {
                            effective_policy_digest,
                        } => {
                            self.commit(&id, effective_policy_digest, running, events_tx, output)?;
                        }
                        Action::Input { data } => {
                            active(running)?.send_input(Input::Bytes(id.clone(), data))?
                        }
                        Action::EndInput => active(running)?.send_input(Input::End(id.clone()))?,
                        Action::Resize { cols, rows } => {
                            if !active(running)?.resize(id.clone(), cols, rows)? {
                                status(&id, "ack", serde_json::json!({}))?;
                            }
                        }
                        Action::Signal { signal } => {
                            if active(running)?.signal(&id, &signal)? {
                                status(&id, "ack", serde_json::json!({}))?;
                            }
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
                                self.commit_allowed = false;
                                if let Some(p) = self.prepared.as_mut() {
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
                                r.begin_close();
                                self.release_ids.push(id.clone());
                            } else {
                                self.commit_allowed = false;
                                let (released, errors) = if let Some(p) = self.prepared.as_mut() {
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
                                    self.prepared.take();
                                    self.eof = true;
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
        Ok(())
    }
    fn prepare(
        &mut self,
        id: &str,
        engine: String,
        spec: protocol::Spec,
        policy: protocol::Policy,
        protection: protocol::Protection,
        console_mode: Option<String>,
    ) -> Result<()> {
        if self.prepared_once {
            return Err(Error::state("only one prepare is permitted"));
        }
        self.prepared_once = true;
        let p = Prepared::new(engine.clone(), spec, policy, protection, console_mode)?;
        self.prepared = Some(p);
        let p = self.prepared.as_mut().unwrap();
        if let Err(mut error) = p.initialize(&engine) {
            p.release();
            error.cleanup.extend(p.errors.clone());
            return Err(error);
        }
        status(
            id,
            "ready",
            serde_json::json!({"effectivePolicyDigest":p.effective.digest,"policyFingerprint":p.effective.policy.fingerprint,"helperSha256":p.effective.protection.helper_sha256}),
        )?;
        self.commit_allowed = true;
        Ok(())
    }
    fn commit(
        &mut self,
        id: &str,
        effective_policy_digest: String,
        running: &mut Option<Running>,
        events_tx: &SyncSender<Event>,
        output: &mut Option<std::fs::File>,
    ) -> Result<()> {
        if !self.commit_allowed {
            return Err(Error::state("commit requires unconsumed prepared state"));
        }
        self.commit_allowed = false;
        let p = self
            .prepared
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
        let p = self.prepared.take().unwrap();
        let r = p.into_running(
            info,
            id.to_owned(),
            events_tx.clone(),
            output.take().expect("one commit consumes private output"),
        );
        *running = Some(r);
        let r = running.as_mut().unwrap();
        if let Err(mut error) = r.resume() {
            r.remember(error.clone());
            r.stop(true);
            error.cleanup.extend(r.errors().iter().skip(1).cloned());
            return Err(error);
        }
        status(id, "started", serde_json::json!({"pid":r.pid()}))?;
        Ok(())
    }
    pub(super) fn release_running(&mut self, running: &mut Option<Running>) -> Result<bool> {
        if running
            .as_ref()
            .is_some_and(|r| r.ready_to_release(self.eof))
        {
            let r = running.as_mut().unwrap();
            let released = r.release();
            let errors = r.errors().to_vec();
            let id = r.id().to_owned();
            if self.release_ids.is_empty() {
                self.release_ids.push(id);
            }
            for release_id in self.release_ids.drain(..) {
                status(
                    &release_id,
                    "released",
                    serde_json::json!({"resourcesReleased":released,"errors":errors}),
                )?;
            }
            if released {
                running.take();
                return Ok(true);
            }
            if self.eof {
                let mut e = Error::state("release failed after control EOF");
                e.cleanup = errors;
                return Err(e);
            }
            // Preserve the owner and all failed handles. A new release request is
            // a cleanup retry, never permission to prepare/launch again.
            running.as_mut().unwrap().retry_close();
        }

        Ok(false)
    }
    pub(super) fn check_timeout(&mut self, running: &mut Option<Running>) -> Result<()> {
        if let Some(r) = running.as_ref() {
            if let Some(error) = r.timeout_error() {
                if self.eof {
                    return Err(error);
                }
                failure(r.id(), error.clone())?;
                for release_id in self.release_ids.drain(..) {
                    status(
                        &release_id,
                        "released",
                        serde_json::json!({"resourcesReleased":false,"errors":[error]}),
                    )?;
                }
                let r = running.as_mut().unwrap();
                r.clear_timeout();
            }
        }

        Ok(())
    }
    pub(super) fn finish_prepared_on_eof(&mut self) -> Result<bool> {
        if self.eof {
            if let Some(p) = self.prepared.as_mut() {
                if !p.release() {
                    let mut error = Error::state("prepared rollback failed after control EOF");
                    error.cleanup = p.errors.clone();
                    return Err(error);
                }
            }
            self.prepared.take();
            return Ok(true);
        }

        Ok(false)
    }
}
fn active(running: &mut Option<Running>) -> Result<&mut Running> {
    running
        .as_mut()
        .ok_or_else(|| Error::state("workload not active"))
}
