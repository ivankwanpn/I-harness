//! Exact owned-Job snapshot fallback. No Job message or PID is completion authority.
use super::{notifications::Inbox, waits::NativeWait};
use crate::{
    error::{Error, Result},
    ffi::Handle,
    job::Job,
};
use std::{
    collections::{HashMap, HashSet},
    mem::zeroed,
    sync::Arc,
};
use windows_sys::Win32::{
    Foundation::*,
    System::{JobObjects::IsProcessInJob, Threading::*},
};

pub(super) struct Tree {
    members: HashMap<(u32, u64), NativeWait>,
    pending_pin: Option<Handle>,
    inbox: Arc<Inbox>,
    dirty: bool,
    observed: HashSet<(u32, u64)>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffi::wide;
    use std::{
        ptr::null,
        time::{Duration, Instant},
    };
    struct Processes {
        job: Job,
        processes: Vec<Handle>,
    }
    impl Drop for Processes {
        fn drop(&mut self) {
            let _ = self.job.terminate();
            for process in &self.processes {
                unsafe {
                    WaitForSingleObject(process.0, 5000);
                }
            }
        }
    }
    #[test]
    fn snapshot_grows_and_member_waits_complete_more_than_63_actual_members() {
        let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/win32-x64/i-harness-windows-helper.exe")
            .canonicalize()
            .unwrap();
        let helper = helper
            .to_str()
            .unwrap()
            .strip_prefix("\\\\?\\")
            .unwrap_or(helper.to_str().unwrap());
        let executable = wide(helper);
        let job = Job::new().unwrap();
        job.configure().unwrap();
        let mut fixture = Processes {
            job,
            processes: vec![],
        };
        for _ in 0..70 {
            let mut command = wide(&format!(
                "{} --self-child descendant 30000",
                crate::command_line::quote(helper)
            ));
            let mut startup: STARTUPINFOW = unsafe { zeroed() };
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
            assert_ne!(
                unsafe {
                    CreateProcessW(
                        executable.as_ptr(),
                        command.as_mut_ptr(),
                        null(),
                        null(),
                        0,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED,
                        null(),
                        null(),
                        &startup,
                        &mut info,
                    )
                },
                0
            );
            let process = Handle(info.hProcess);
            let thread = Handle(info.hThread);
            fixture.job.assign(process.0).unwrap();
            assert_ne!(unsafe { ResumeThread(thread.0) }, u32::MAX);
            fixture.processes.push(process);
        }
        let snapshot = fixture.job.members().unwrap();
        assert!(snapshot.len() >= 70);
        for process in &fixture.processes {
            assert!(snapshot.contains(&unsafe { GetProcessId(process.0) }));
        }
        let inbox = Inbox::new();
        let mut tree = Tree::new(inbox.clone());
        assert!(!tree.reconcile(&fixture.job).unwrap());
        assert!(tree.members.len() >= 70);
        eprintln!(
            "controlled exact Job: requestedRoots=70, actualSnapshotMembers={}, registeredMemberWaits={}, advisoryHintSource=absent",
            snapshot.len(),
            tree.members.len()
        );
        fixture.job.terminate().unwrap();
        tree.request();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut empty = false;
        while Instant::now() < deadline {
            if tree.changed() && tree.reconcile(&fixture.job).unwrap() {
                empty = true;
                break;
            }
            inbox.wait(Some(deadline));
        }
        assert!(
            empty,
            "actual member exit events must lead to a complete factual zero snapshot"
        );
        assert!(tree.retire().is_empty());
        eprintln!("controlled exact Job: factualZeroSnapshot={empty}, observerRetirementErrors=0");
    }
}
impl Tree {
    pub(super) fn new(inbox: Arc<Inbox>) -> Self {
        Self {
            members: HashMap::new(),
            pending_pin: None,
            inbox,
            dirty: false,
            observed: HashSet::new(),
        }
    }
    pub(super) fn request(&mut self) {
        self.dirty = true;
    }
    pub(super) fn changed(&self) -> bool {
        self.dirty
            || self
                .members
                .iter()
                .any(|(key, wait)| wait.signaled() && !self.observed.contains(key))
    }
    pub(super) fn reconcile(&mut self, job: &Job) -> Result<bool> {
        self.dirty = false;
        for (key, wait) in &self.members {
            if wait.signaled() {
                self.observed
                    .try_reserve(1)
                    .map_err(|_| Error::state("member observation allocation failed"))?;
                self.observed.insert(*key);
            }
        }
        for _ in 0..32 {
            if let Some(handle) = self.pending_pin.as_mut() {
                handle.close()?;
                self.pending_pin.take();
            }
            let pids = job.members()?;
            let mut listed = HashSet::new();
            listed
                .try_reserve(pids.len())
                .map_err(|_| Error::state("member identity allocation failed"))?;
            let mut catch_up = false;
            for pid in &pids {
                let raw = unsafe {
                    OpenProcess(
                        PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        *pid,
                    )
                };
                if raw.is_null() {
                    let code = unsafe { GetLastError() };
                    if code == ERROR_INVALID_PARAMETER {
                        catch_up = true;
                        continue;
                    }
                    return Err(Error::native_code("OpenProcess(Job member)", code));
                }
                self.pending_pin = Some(Handle(raw));
                let handle = self.pending_pin.as_ref().unwrap();
                let result = (|| -> Result<Option<(u32, u64)>> {
                    let mut belongs = 0;
                    if unsafe { IsProcessInJob(handle.0, job.0.0, &mut belongs) } == 0 {
                        return Err(Error::native("IsProcessInJob"));
                    }
                    if belongs == 0 {
                        return Ok(None);
                    }
                    let (mut created, mut exited, mut kernel, mut user): (
                        FILETIME,
                        FILETIME,
                        FILETIME,
                        FILETIME,
                    ) = unsafe { (zeroed(), zeroed(), zeroed(), zeroed()) };
                    if unsafe {
                        GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user)
                    } == 0
                    {
                        return Err(Error::native("GetProcessTimes(Job member)"));
                    }
                    Ok(Some((
                        *pid,
                        (u64::from(created.dwHighDateTime) << 32)
                            | u64::from(created.dwLowDateTime),
                    )))
                })();
                let outcome = match result {
                    Ok(Some(key)) => {
                        listed.insert(key);
                        if let Some(wait) = self.members.get_mut(&key) {
                            catch_up |= wait.signaled();
                            wait.ensure_registered()
                        } else if self.members.len() >= 65536 {
                            Err(Error::state("member wait capacity exceeded"))
                        } else {
                            self.members
                                .try_reserve(1)
                                .map_err(|_| Error::state("member wait allocation failed"))?;
                            NativeWait::new(handle.0, self.inbox.clone()).and_then(|mut wait| {
                                let result = wait.ensure_registered();
                                self.members.insert(key, wait);
                                result
                            })
                        }
                    }
                    Ok(None) => {
                        catch_up = true;
                        Ok(())
                    }
                    Err(error) => Err(error),
                };
                self.pending_pin.as_mut().unwrap().close()?;
                self.pending_pin.take();
                outcome?;
            }
            let mut departed = Vec::new();
            departed
                .try_reserve_exact(self.members.len())
                .map_err(|_| Error::state("departed member allocation failed"))?;
            departed.extend(
                self.members
                    .keys()
                    .filter(|key| !listed.contains(key))
                    .copied(),
            );
            for key in departed {
                let wait = self.members.get_mut(&key).unwrap();
                // A complete zero snapshot is factual even if the callback is queued.
                wait.retire()?;
                self.members.remove(&key);
                self.observed.remove(&key);
            }
            if !catch_up {
                return Ok(pids.is_empty());
            }
        }
        Err(Error::state(
            "Job membership did not stabilize within 32 causal catch-up rounds",
        ))
    }
    pub(super) fn retire(&mut self) -> Vec<Error> {
        let mut errors = vec![];
        self.members.retain(|_, wait| match wait.retire() {
            Ok(()) => false,
            Err(error) => {
                errors.push(error);
                true
            }
        });
        for handle in self.pending_pin.iter_mut() {
            if let Err(error) = handle.close() {
                errors.push(error);
            }
        }
        if self
            .pending_pin
            .as_ref()
            .is_some_and(|handle| handle.0.is_null())
        {
            self.pending_pin.take();
        }
        errors
    }
}
