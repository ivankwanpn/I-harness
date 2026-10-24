//! Heap-stable callbacks. A registration is retired only by an unregister drain ACK.
use super::notifications::Inbox;
use crate::{
    error::{Error, Result},
    ffi::Handle,
};
use std::{
    ffi::c_void,
    ptr::null_mut,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use windows_sys::Win32::{Foundation::*, System::Threading::*};

struct Context {
    signaled: AtomicBool,
    inbox: Arc<Inbox>,
}
pub(crate) struct NativeWait {
    token: HANDLE,
    context: Option<Box<[Context]>>,
    handle: Handle,
    registration_error: Option<Error>,
}
unsafe impl Send for NativeWait {}
#[cfg(test)]
thread_local! { static FAIL_UNREGISTER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
unsafe extern "system" fn completed(context: *mut c_void, _: bool) {
    // Context stays allocated until UnregisterWaitEx(INVALID_HANDLE_VALUE) ACK.
    // No user code, queue capacity wait, OS handle close or status I/O here.
    let context = unsafe { &*(context as *const Context) };
    context.signaled.store(true, Ordering::Release);
    context.inbox.wake();
}
impl NativeWait {
    pub(crate) fn new(handle: HANDLE, inbox: Arc<Inbox>) -> Result<Self> {
        let mut storage = Vec::new();
        storage
            .try_reserve_exact(1)
            .map_err(|_| Error::state("wait callback allocation failed"))?;
        storage.push(Context {
            signaled: AtomicBool::new(false),
            inbox,
        });
        let context = storage.into_boxed_slice();
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate = null_mut();
        if unsafe {
            DuplicateHandle(
                process,
                handle,
                process,
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(Error::native("DuplicateHandle(wait)"));
        }
        let handle = Handle(duplicate);
        let mut wait = Self {
            token: null_mut(),
            context: Some(context),
            handle,
            registration_error: None,
        };
        let _ = wait.ensure_registered();
        Ok(wait)
    }
    pub(crate) fn ensure_registered(&mut self) -> Result<()> {
        if !self.token.is_null() {
            return Ok(());
        }
        let context = self
            .context
            .as_ref()
            .ok_or_else(|| Error::state("wait already retired"))?;
        if unsafe {
            RegisterWaitForSingleObject(
                &mut self.token,
                self.handle.0,
                Some(completed),
                context.as_ptr().cast(),
                INFINITE,
                WT_EXECUTEONLYONCE,
            )
        } == 0
        {
            self.token = null_mut();
            let error = Error::native("RegisterWaitForSingleObject");
            self.registration_error = Some(error.clone());
            return Err(error);
        }
        self.registration_error = None;
        Ok(())
    }

    pub(crate) fn signaled(&self) -> bool {
        self.context
            .as_ref()
            .is_some_and(|c| c[0].signaled.load(Ordering::Acquire))
    }
    pub(crate) fn retire(&mut self) -> Result<()> {
        if !self.token.is_null() {
            #[cfg(test)]
            if FAIL_UNREGISTER.with(|flag| flag.replace(false)) {
                return Err(Error::native_code("UnregisterWaitEx", 5));
            }
            if unsafe { UnregisterWaitEx(self.token, INVALID_HANDLE_VALUE) } == 0 {
                return Err(Error::native("UnregisterWaitEx"));
            }
            self.token = null_mut();
            self.context.take();
        }
        self.context.take();
        self.handle.close()
    }
}
impl Drop for NativeWait {
    fn drop(&mut self) {
        if self.retire().is_err() {
            // Failure is not permission to free memory reachable by Windows.
            if let Some(context) = self.context.take() {
                std::mem::forget(context);
            }
            self.handle.0 = null_mut();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn already_signaled_handle_publishes_and_unregisters_before_close() {
        let event = Handle::new(
            unsafe { CreateEventW(null_mut(), 1, 1, std::ptr::null()) },
            "CreateEventW",
        )
        .unwrap();
        let inbox = Inbox::new();
        let mut wait = NativeWait::new(event.0, inbox.clone())
            .expect("an already signaled native handle must register");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !wait.signaled() && Instant::now() < deadline {
            inbox.wait(Some(deadline));
        }
        assert!(wait.signaled());
        wait.retire().unwrap();
        assert!(wait.token.is_null() && wait.context.is_none() && wait.handle.0.is_null());
    }
    #[test]
    fn failed_unregister_keeps_original_callback_and_waited_handle_for_retry() {
        let event = Handle::new(
            unsafe { CreateEventW(null_mut(), 1, 0, std::ptr::null()) },
            "CreateEventW",
        )
        .unwrap();
        let mut wait = NativeWait::new(event.0, Inbox::new()).unwrap();
        let token = wait.token;
        let context = wait.context.as_ref().unwrap().as_ptr();
        let handle = wait.handle.0;
        FAIL_UNREGISTER.with(|flag| flag.set(true));
        assert_eq!(wait.retire().unwrap_err().api, "UnregisterWaitEx");
        assert_eq!(wait.token, token);
        assert_eq!(wait.context.as_ref().unwrap().as_ptr(), context);
        assert_eq!(wait.handle.0, handle);
        wait.retire().unwrap();
    }
}
