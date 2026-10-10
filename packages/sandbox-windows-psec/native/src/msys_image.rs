//! A single-slot derivation of the shipped template, owned until native release.
use crate::{
    error::{Error, Result},
    ffi::Handle,
    policy::hash,
};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    mem::ManuallyDrop,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle},
    },
    path::PathBuf,
    ptr::null_mut,
};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*, System::LibraryLoader::*};

fn u16_at(bytes: &[u8], at: usize) -> Result<u16> {
    bytes
        .get(at..at + 2)
        .and_then(|b| b.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or_else(|| Error::invalid("truncated adapter PE"))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    bytes
        .get(at..at + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| Error::invalid("truncated adapter PE"))
}
pub fn bind(bytes: &[u8], runtime: &str) -> Result<Vec<u8>> {
    // PE import names use the Windows loader's ANSI encoding. ASCII is an exact
    // subset on every supported host; do not replace unrepresentable characters.
    if !runtime.is_ascii() || runtime.as_bytes().contains(&0) || runtime.len() >= 260 {
        return Err(Error::invalid(
            "MSYS absolute import path must be ASCII and shorter than 260 bytes",
        ));
    }
    crate::policy::path_syntax(runtime)?;
    if bytes.len() > 8 * 1024 * 1024 || bytes.get(..2) != Some(b"MZ") {
        return Err(Error::invalid("invalid adapter image"));
    }
    let pe = u32_at(bytes, 0x3c)? as usize;
    if bytes.get(pe..pe + 4) != Some(b"PE\0\0") || u16_at(bytes, pe + 4)? != 0x8664 {
        return Err(Error::invalid("adapter must be x86-64 PE"));
    }
    let optional = pe + 24;
    if u16_at(bytes, optional)? != 0x20b {
        return Err(Error::invalid("adapter must be PE32+"));
    }
    let count = u16_at(bytes, pe + 6)? as usize;
    if count == 0 || count > 96 {
        return Err(Error::invalid("adapter section count"));
    }
    let table = optional + u16_at(bytes, pe + 20)? as usize;
    let mut sections = Vec::new();
    let mut slot = None;
    for i in 0..count {
        let at = table + i * 40;
        let va = u32_at(bytes, at + 12)? as usize;
        let length = u32_at(bytes, at + 16)? as usize;
        let raw = u32_at(bytes, at + 20)? as usize;
        if raw.checked_add(length).is_none_or(|end| end > bytes.len()) {
            return Err(Error::invalid("adapter section outside image"));
        }
        if bytes.get(at..at + 8) == Some(b".ihmsys\0") {
            if slot.is_some() || length != 32768 || u32_at(bytes, at + 36)? & 0x80000000 != 0 {
                return Err(Error::invalid("adapter import slot layout changed"));
            }
            slot = Some((va, raw, length));
        }
        sections.push((va, raw, length));
    }
    let (slot_va, slot_raw, slot_len) =
        slot.ok_or_else(|| Error::invalid("adapter import slot absent"))?;
    let marker = b"IH_MSYS_ABSOLUTE_IMPORT_V1";
    if bytes.get(slot_raw..slot_raw + marker.len()) != Some(marker)
        || bytes[slot_raw + marker.len()..slot_raw + slot_len]
            .iter()
            .any(|&b| b != 0)
    {
        return Err(Error::invalid(
            "adapter import slot is not the shipped template",
        ));
    }
    let offset = |rva: usize| -> Result<usize> {
        sections
            .iter()
            .find_map(|&(va, raw, len)| (rva >= va && rva - va < len).then(|| raw + rva - va))
            .ok_or_else(|| Error::invalid("adapter RVA outside image"))
    };
    let imports = u32_at(bytes, optional + 120)? as usize;
    let limit = u32_at(bytes, optional + 124)? as usize / 20;
    if limit == 0 || limit > 128 {
        return Err(Error::invalid("adapter import table bounds"));
    }
    let mut descriptor = None;
    for i in 0..limit {
        let at = offset(imports + i * 20)?;
        let name = u32_at(bytes, at + 12)? as usize;
        if name == 0 {
            break;
        }
        let start = offset(name)?;
        let text = bytes
            .get(start..(start + 512).min(bytes.len()))
            .ok_or_else(|| Error::invalid("adapter import name"))?;
        let end = text
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| Error::invalid("unterminated adapter import name"))?;
        let name = std::str::from_utf8(&text[..end])
            .map_err(|_| Error::invalid("invalid adapter import name"))?;
        if name.eq_ignore_ascii_case("msys-2.0.dll") {
            if descriptor.replace(at + 12).is_some() {
                return Err(Error::invalid("multiple MSYS imports"));
            }
        } else if !name.eq_ignore_ascii_case("kernel32.dll") {
            return Err(Error::invalid(
                "adapter has an ambient non-system dependency",
            ));
        }
    }
    let descriptor = descriptor.ok_or_else(|| Error::invalid("adapter MSYS import absent"))?;
    let mut bound = bytes.to_vec();
    bound[descriptor..descriptor + 4].copy_from_slice(&(slot_va as u32).to_le_bytes());
    bound[slot_raw..slot_raw + slot_len].fill(0);
    bound[slot_raw..slot_raw + runtime.len()].copy_from_slice(runtime.as_bytes());
    Ok(bound)
}

fn nonce() -> Result<String> {
    unsafe {
        let module = LoadLibraryExW(
            crate::ffi::wide("advapi32.dll").as_ptr(),
            null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
        if module.is_null() {
            return Err(Error::native("LoadLibraryExW(random)"));
        }
        let random = GetProcAddress(module, c"SystemFunction036".as_ptr().cast());
        let mut bytes = [0u8; 16];
        let result = random.map(|p| {
            std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                unsafe extern "system" fn(*mut u8, u32) -> u8,
            >(p)(bytes.as_mut_ptr(), 16)
        });
        FreeLibrary(module);
        if result != Some(1) {
            return Err(Error::native("RtlGenRandom"));
        }
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
}
fn disposition(handle: &Handle) -> Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            handle.0,
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(Error::native("SetFileInformationByHandle(owned adapter)"));
    }
    Ok(())
}
fn reopen(handle: HANDLE, access: u32, share: u32) -> Result<Handle> {
    Handle::new(
        unsafe { ReOpenFile(handle, access, share, 0) },
        "ReOpenFile(owned adapter)",
    )
}
pub struct Derived {
    pub path: PathBuf,
    pub sha256: String,
    directory: Option<Handle>,
    file: Option<Handle>,
    pending: Option<Handle>,
    temporary: Option<Handle>,
    directory_path: Option<PathBuf>,
}
fn local_path(path: &std::path::Path) -> Result<String> {
    let value = path
        .to_str()
        .ok_or_else(|| Error::invalid("adapter path is not Unicode"))?;
    let value = value.strip_prefix("\\\\?\\").unwrap_or(value);
    crate::policy::path_syntax(value)?;
    Ok(value.into())
}
impl Derived {
    pub fn empty() -> Self {
        Self {
            path: PathBuf::new(),
            sha256: String::new(),
            directory: None,
            file: None,
            pending: None,
            temporary: None,
            directory_path: None,
        }
    }
    pub fn initialize(&mut self, bytes: &[u8]) -> Result<()> {
        let requested_root = std::env::temp_dir();
        local_path(&requested_root)?;
        let root = requested_root
            .canonicalize()
            .map_err(|e| Error::io("canonicalize adapter temp root", e))?;
        local_path(&root)?;
        let directory = root.join(format!("i-harness-msys-{}", nonce()?));
        std::fs::create_dir(&directory)
            .map_err(|e| Error::io("create private adapter directory", e))?;
        self.path = directory.join("i-harness-msys-pty.exe");
        self.directory_path = Some(directory.clone());
        let owner = OpenOptions::new()
            .access_mode(GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&directory)
            .map_err(|e| Error::io("pin adapter directory", e))?;
        self.directory = Some(Handle(owner.into_raw_handle()));
        let writer = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&self.path)
            .map_err(|e| Error::io("create derived adapter", e))?;
        // Store ownership immediately; subsequent failure remains in Prepared.
        self.pending = Some(Handle(writer.into_raw_handle()));
        let handle = self.pending.as_ref().unwrap().0;
        let mut writer = ManuallyDrop::new(unsafe { File::from_raw_handle(handle) });
        writer
            .write_all(bytes)
            .and_then(|_| writer.sync_all())
            .map_err(|e| Error::io("write derived adapter", e))?;
        // Transition by object handles, never close then look the pathname up.
        self.temporary = Some(reopen(
            handle,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )?);
        self.pending.as_mut().unwrap().close()?;
        self.pending.take();
        let pinned = reopen(
            self.temporary.as_ref().unwrap().0,
            GENERIC_READ | DELETE,
            FILE_SHARE_READ,
        )?;
        self.file = Some(pinned);
        self.temporary.as_mut().unwrap().close()?;
        self.temporary.take();
        let expected = hash(bytes);
        let mut file =
            ManuallyDrop::new(unsafe { File::from_raw_handle(self.file.as_ref().unwrap().0) });
        file.seek(SeekFrom::Start(0))
            .map_err(|e| Error::io("seek pinned adapter", e))?;
        let mut actual = Vec::new();
        file.read_to_end(&mut actual)
            .map_err(|e| Error::io("read pinned adapter", e))?;
        self.sha256 = hash(&actual);
        if self.sha256 != expected {
            return Err(Error::state(
                "derived adapter bytes changed before strict pin",
            ));
        }
        Ok(())
    }
    pub fn check(&self) -> Result<()> {
        let expected = self
            .file
            .as_ref()
            .ok_or_else(|| Error::state("derived adapter is not pinned"))?;
        let current = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(&self.path)
            .map_err(|e| Error::io("recheck derived adapter path", e))?;
        let mut old = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        let mut now = old;
        if unsafe { GetFileInformationByHandle(expected.0, &mut old) } == 0
            || unsafe { GetFileInformationByHandle(current.as_raw_handle(), &mut now) } == 0
        {
            return Err(Error::native("GetFileInformationByHandle(derived adapter)"));
        }
        if old.dwVolumeSerialNumber != now.dwVolumeSerialNumber
            || old.nFileIndexHigh != now.nFileIndexHigh
            || old.nFileIndexLow != now.nFileIndexLow
        {
            return Err(Error::state("derived adapter pathname identity changed"));
        }
        Ok(())
    }
    pub fn release(&mut self) -> Result<()> {
        if self.file.is_none() && self.pending.is_none() {
            if let Some(handle) = &self.temporary {
                self.file = Some(reopen(
                    handle.0,
                    GENERIC_READ | DELETE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                )?);
            }
        }
        if let Some(handle) = self.temporary.as_mut() {
            handle.close()?;
            self.temporary.take();
        }
        for slot in [&mut self.file, &mut self.pending] {
            if let Some(handle) = slot.as_mut() {
                disposition(handle)?;
                handle.close()?;
                slot.take();
            }
        }
        if self.directory.is_none() {
            if let Some(path) = &self.directory_path {
                let file = OpenOptions::new()
                    .access_mode(GENERIC_READ | DELETE)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(path)
                    .map_err(|e| Error::io("retry adapter directory ownership", e))?;
                self.directory = Some(Handle(file.into_raw_handle()));
            }
        }
        if let Some(handle) = self.directory.as_mut() {
            disposition(handle)?;
            handle.close()?;
            self.directory.take();
            self.directory_path.take();
        }
        Ok(())
    }
}
impl Drop for Derived {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derived_ownership_pins_bytes_and_deletes_by_handle() {
        let mut image = Derived::empty();
        image.initialize(b"owned bytes").unwrap();
        let path = image.path.clone();
        let parent = path.parent().unwrap().to_path_buf();
        image.check().unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::rename(&path, parent.join("other")).is_err());
        image.release().unwrap();
        assert!(!path.exists());
        assert!(!parent.exists());
    }
    #[test]
    fn encoding_and_corrupt_templates_fail_before_derivation() {
        assert!(bind(b"x", "C:\\运行\\msys-2.0.dll").is_err());
        assert!(bind(b"x", "C:\\Git\\msys-2.0.dll").is_err());
    }
    #[test]
    fn temp_and_spawn_names_must_remain_local_absolute_drive_paths() {
        assert_eq!(
            local_path(std::path::Path::new("\\\\?\\C:\\Temp")).unwrap(),
            "C:\\Temp"
        );
        for path in [
            "\\\\server\\share\\temp",
            "\\\\?\\UNC\\server\\share\\temp",
            "UNC\\server\\share\\temp",
            "C:relative",
            "C:\\Temp:stream",
        ] {
            assert!(local_path(std::path::Path::new(path)).is_err());
        }
    }
    #[test]
    fn failed_stage_transition_retains_object_handles_until_retry() {
        let mut image = Derived::empty();
        crate::ffi::FAIL_NEXT_CLOSE.with(|flag| flag.set(true));
        assert!(image.initialize(b"owned stage failure").is_err());
        let path = image.path.clone();
        assert!(path.exists());
        assert!(image.pending.as_ref().is_some_and(|h| !h.0.is_null()));
        assert!(image.temporary.as_ref().is_some_and(|h| !h.0.is_null()));
        image.release().unwrap();
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
    }
}
