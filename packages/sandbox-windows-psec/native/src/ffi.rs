//! Minimal pinned PSEC ABI. The loaded module outlives every resolved function and environment.
use crate::error::{Error, Result};
use std::{
    ffi::c_void,
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::*, Threading::*},
};
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
impl Handle {
    pub fn new(raw: HANDLE, api: &str) -> Result<Self> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(Error::native(api))
        } else {
            Ok(Self(raw))
        }
    }
    pub fn close(&mut self) -> Result<()> {
        if self.0.is_null() {
            return Ok(());
        }
        #[cfg(test)]
        if FAIL_NEXT_CLOSE.with(|flag| flag.replace(false)) {
            return Err(Error::native_code("CloseHandle", 5));
        }
        if unsafe { CloseHandle(self.0) } == 0 {
            return Err(Error::native("CloseHandle"));
        }
        self.0 = null_mut();
        Ok(())
    }
}
#[cfg(test)]
thread_local! {pub static FAIL_NEXT_CLOSE:std::cell::Cell<bool>=const {std::cell::Cell::new(false)}; static LIVE_ATTRIBUTES:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};}
#[cfg(test)]
pub fn live_attributes() -> usize {
    LIVE_ATTRIBUTES.with(|n| n.get())
}
impl Drop for Handle {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
type Create = unsafe extern "system" fn(*const c_void, u32, u32, *mut HANDLE) -> i32;
type Query = unsafe extern "system" fn(*mut u64) -> i32;
type Close = unsafe extern "system" fn(HANDLE);
pub struct PsecApi {
    module: HMODULE,
    create: Create,
    close: Close,
    pub flags: u64,
}
impl PsecApi {
    pub fn load() -> Result<Self> {
        unsafe {
            // Check the official API set separately; exports alone are insufficient.
            let base = LoadLibraryExW(
                wide("kernelbase.dll").as_ptr(),
                null_mut(),
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if base.is_null() {
                return Err(Error::native("LoadLibraryExW(kernelbase)"));
            }
            let check = GetProcAddress(base, c"IsApiSetImplemented".as_ptr().cast());
            let supported = check
                .map(|p| {
                    std::mem::transmute::<
                        unsafe extern "system" fn() -> isize,
                        unsafe extern "system" fn(*const u8) -> i32,
                    >(p)(
                        c"api-win-appmodel-processmodel~securityenvironment"
                            .as_ptr()
                            .cast(),
                    )
                })
                .unwrap_or(0);
            FreeLibrary(base);
            if supported == 0 {
                return Err(Error::native_code("IsApiSetImplemented", 50));
            }
            let module = LoadLibraryExW(
                wide("processmodel.dll").as_ptr(),
                null_mut(),
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if module.is_null() {
                return Err(Error::native("LoadLibraryExW(processmodel)"));
            }
            let create =
                GetProcAddress(module, c"CreateProcessSecurityEnvironment".as_ptr().cast());
            let query = GetProcAddress(
                module,
                c"QueryProcessSecurityEnvironmentSupport".as_ptr().cast(),
            );
            let close = GetProcAddress(module, c"CloseProcessSecurityEnvironment".as_ptr().cast());
            let (Some(create), Some(query), Some(close)) = (create, query, close) else {
                FreeLibrary(module);
                return Err(Error::native_code("GetProcAddress(PSEC)", 127));
            };
            let query: Query = std::mem::transmute(query);
            let mut flags = 0;
            let hr = query(&mut flags);
            if hr < 0 {
                FreeLibrary(module);
                return Err(Error::native_code(
                    "QueryProcessSecurityEnvironmentSupport",
                    hr as u32,
                ));
            }
            Ok(Self {
                module,
                create: std::mem::transmute(create),
                close: std::mem::transmute(close),
                flags,
            })
        }
    }
    pub fn create(self, bytes: &[u8]) -> Result<Psec> {
        let mut handle = null_mut();
        let hr = unsafe {
            (self.create)(
                bytes.as_ptr().cast(),
                bytes
                    .len()
                    .try_into()
                    .map_err(|_| Error::invalid("PSEC specification too large"))?,
                0,
                &mut handle,
            )
        };
        if hr < 0 {
            return Err(Error::native_code(
                "CreateProcessSecurityEnvironment",
                hr as u32,
            ));
        }
        if handle.is_null() {
            return Err(Error::native_code(
                "CreateProcessSecurityEnvironment(null)",
                6,
            ));
        }
        Ok(Psec {
            api: self,
            handle: Box::new(handle),
        })
    }
}
impl Drop for PsecApi {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.module);
        }
    }
}
pub struct Psec {
    api: PsecApi,
    pub handle: Box<HANDLE>,
}
impl Drop for Psec {
    fn drop(&mut self) {
        unsafe {
            (self.api.close)(*self.handle);
        }
    }
}

pub struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    pub fn new(count: u32) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(Error::native("InitializeProcThreadAttributeList(size)"));
        }
        let mut this = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(this.ptr(), count, 0, &mut bytes) } == 0 {
            return Err(Error::native("InitializeProcThreadAttributeList"));
        }
        this.initialized = true;
        #[cfg(test)]
        LIVE_ATTRIBUTES.with(|n| n.set(n.get() + 1));
        Ok(this)
    }
    pub fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    /// Capture CreateProcessW's error before cleanup can overwrite LastError, and
    /// destroy the list before the caller can move any of its borrowed value storage.
    pub fn finish_create(self, created: i32) -> Result<()> {
        let error = if created == 0 {
            Some(Error::native("CreateProcessW"))
        } else {
            None
        };
        drop(self);
        error.map_or(Ok(()), Err)
    }
    // Caller owns each stable value until this attribute list is dropped.
    pub unsafe fn add(&mut self, key: usize, value: *const c_void, bytes: usize) -> Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(self.ptr(), 0, key, value, bytes, null_mut(), null())
        } == 0
        {
            Err(Error::native("UpdateProcThreadAttribute"))
        } else {
            Ok(())
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr());
            }
            #[cfg(test)]
            LIVE_ATTRIBUTES.with(|n| n.set(n.get() - 1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn create_failure_destroys_attributes_before_backing_can_be_released() {
        let attrs = Attributes::new(1).unwrap();
        assert_eq!(LIVE_ATTRIBUTES.with(|n| n.get()), 1);
        unsafe {
            SetLastError(203);
        }
        let error = attrs.finish_create(0).unwrap_err();
        assert_eq!(error.native_code, Some(203));
        assert_eq!(LIVE_ATTRIBUTES.with(|n| n.get()), 0);
    }
}
