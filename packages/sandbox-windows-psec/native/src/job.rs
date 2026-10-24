use crate::{
    error::{Error, Result},
    ffi::Handle,
};
use std::{
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{Foundation::*, System::JobObjects::*};
pub struct Job(pub Handle);
#[cfg(test)]
thread_local! {
    pub static FAIL_NEXT_TERMINATE:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};
    pub static TERMINATE_CALLS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};
}
impl Job {
    pub(crate) fn members(&self) -> Result<Vec<u32>> {
        let mut capacity = 16usize;
        loop {
            let bytes = 8usize
                .checked_add(
                    capacity
                        .checked_mul(size_of::<usize>())
                        .ok_or_else(|| Error::state("Job snapshot overflow"))?,
                )
                .ok_or_else(|| Error::state("Job snapshot overflow"))?;
            if capacity > 65536 || bytes > 8 * 1024 * 1024 {
                return Err(Error::state("Job snapshot capacity exceeded"));
            }
            let mut buffer = Vec::<usize>::new();
            buffer
                .try_reserve_exact(bytes.div_ceil(size_of::<usize>()))
                .map_err(|_| Error::state("Job snapshot allocation failed"))?;
            buffer.resize(bytes.div_ceil(size_of::<usize>()), 0);
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0.0,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    bytes as u32,
                    null_mut(),
                )
            };
            let code = if ok == 0 {
                unsafe { GetLastError() }
            } else {
                0
            };
            let counts = buffer.as_ptr().cast::<u32>();
            let assigned = unsafe { *counts } as usize;
            let listed = unsafe { *counts.add(1) } as usize;
            if code == ERROR_MORE_DATA || assigned > listed {
                capacity = capacity.checked_mul(2).unwrap_or(65537).max(assigned);
                continue;
            }
            if ok == 0 {
                return Err(Error::native_code(
                    "QueryInformationJobObject(PID list)",
                    code,
                ));
            }
            if listed > capacity {
                return Err(Error::state("invalid Job snapshot population"));
            }
            return buffer[1..1 + listed]
                .iter()
                .map(|pid| u32::try_from(*pid).map_err(|_| Error::state("invalid Job member PID")))
                .collect();
        }
    }
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
