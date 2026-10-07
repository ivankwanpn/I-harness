use crate::{
    error::{Error, Result},
    ffi::Handle,
};
use std::{
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{Foundation::HANDLE, System::JobObjects::*};
pub struct Job(pub Handle);
#[cfg(test)]
thread_local! {
    pub static FAIL_NEXT_TERMINATE:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};
    pub static TERMINATE_CALLS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};
}
impl Job {
    pub fn new() -> Result<Self> {
        let handle = Handle::new(
            unsafe { CreateJobObjectW(null(), null()) },
            "CreateJobObjectW",
        )?;
        Ok(Self(handle))
    }
    pub fn configure(&self) -> Result<()> {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                self.0.0,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(Error::native("SetInformationJobObject"));
        }
        Ok(())
    }
    pub fn assign(&self, process: HANDLE) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.0, process) } == 0 {
            Err(Error::native("AssignProcessToJobObject"))
        } else {
            Ok(())
        }
    }
    pub fn terminate(&self) -> Result<()> {
        #[cfg(test)]
        {
            TERMINATE_CALLS.with(|n| n.set(n.get() + 1));
            if FAIL_NEXT_TERMINATE.with(|flag| flag.replace(false)) {
                return Err(Error::native_code("TerminateJobObject", 5));
            }
        }
        if unsafe { TerminateJobObject(self.0.0, 137) } == 0 {
            Err(Error::native("TerminateJobObject"))
        } else {
            Ok(())
        }
    }
    pub fn active(&self) -> Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.0.0,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            Err(Error::native("QueryInformationJobObject"))
        } else {
            Ok(info.ActiveProcesses)
        }
    }
}
