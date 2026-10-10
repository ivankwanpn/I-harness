use crate::{
    error::{Error, Result},
    ffi::Handle,
    protocol::{Policy, Protection, Spec},
};
use process_security_environment_spec::process_security_environment_layout::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, IntoRawHandle},
    },
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::*;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn file_hash(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| Error::io("open helper", e))?;
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 65536];
    loop {
        let n = file
            .read(&mut chunk)
            .map_err(|e| Error::io("hash helper", e))?;
        if n == 0 {
            break;
        }
        hash.update(&chunk[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn path_syntax(path: &str) -> Result<()> {
    let b = path.as_bytes();
    if path.contains('\0')
        || b.len() < 3
        || !b[0].is_ascii_alphabetic()
        || b[1] != b':'
        || !matches!(b[2], b'\\' | b'/')
        || path[2..].contains(':')
    {
        return Err(Error::invalid(
            "paths must be absolute local drive paths without NUL or alternate streams",
        ));
    }
    Ok(())
}
pub fn normalized(path: &str) -> Result<String> {
    path_syntax(path)?;
    let p = std::fs::canonicalize(path).map_err(|e| Error::io("canonicalize path", e))?;
    let s = p
        .to_str()
        .ok_or_else(|| Error::invalid("path is not Unicode"))?;
    Ok(s.strip_prefix("\\\\?\\").unwrap_or(s).to_string())
}
fn within(path: &str, root: &str) -> bool {
    let p = path.trim_end_matches('\\').to_lowercase();
    let r = root.trim_end_matches('\\').to_lowercase();
    p == r || p.starts_with(&(r + "\\"))
}
pub struct Identity {
    original: String,
    canonical: String,
    serial: u32,
    index: u64,
    _file: Handle,
}
impl Identity {
    fn read(path: &str) -> Result<Self> {
        let canonical = normalized(path)?;
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&canonical)
            .map_err(|e| Error::io("open path identity", e))?;
        let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(Error::native("GetFileInformationByHandle"));
        }
        Ok(Self {
            original: path.into(),
            canonical,
            serial: info.dwVolumeSerialNumber,
            index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            _file: Handle(file.into_raw_handle()),
        })
    }
    fn check(&self) -> Result<()> {
        let current = Self::read(&self.original)?;
        if !current.canonical.eq_ignore_ascii_case(&self.canonical)
            || current.serial != self.serial
            || current.index != self.index
        {
            Err(Error::state("filesystem identity changed since prepare"))
        } else {
            Ok(())
        }
    }
}
pub struct Effective {
    pub spec: Spec,
    pub policy: Policy,
    pub protection: Protection,
    pub console_mode: String,
    pub digest: String,
    pub bytes: Vec<u8>,
    identities: Vec<Identity>,
}
impl Effective {
    pub fn release(&mut self) -> Vec<Error> {
        let mut errors = vec![];
        for identity in &mut self.identities {
            if let Err(e) = identity._file.close() {
                errors.push(e);
            }
        }
        errors
    }
    pub fn new(
        engine: &str,
        mut spec: Spec,
        mut policy: Policy,
        mut protection: Protection,
        console_mode: String,
    ) -> Result<Self> {
        validate(engine, &spec, &policy)?;
        validate_console(engine, &spec.transport, &console_mode)?;
        if engine == "unrestricted"
            && (!policy.reference_roots.is_empty()
                || !protection.read_only_paths.is_empty()
                || !protection.deny_paths.is_empty())
        {
            return Err(Error::invalid(
                "unrestricted engine cannot enforce reference or protection path restrictions",
            ));
        }
        let helper = std::env::current_exe().map_err(|e| Error::io("current_exe", e))?;
        if protection.helper_sha256 != file_hash(&helper)? {
            return Err(Error::state(
                "helper SHA256 does not match protection identity",
            ));
        }
        let mut identities = vec![];
        let mut canonical = |path: &str| -> Result<String> {
            let identity = Identity::read(path)?;
            let result = identity.canonical.clone();
            identities.push(identity);
            Ok(result)
        };
        spec.argv[0] = canonical(&spec.argv[0])?;
        spec.cwd = canonical(&spec.cwd)?;
        policy.primary_root = canonical(&policy.primary_root)?;
        for list in [
            &mut policy.authority_roots,
            &mut policy.write_roots,
            &mut policy.reference_roots,
            &mut protection.read_only_paths,
            &mut protection.deny_paths,
        ] {
            if list.len() > 128 {
                return Err(Error::invalid("at most 128 paths per list"));
            }
            for path in list.iter_mut() {
                *path = canonical(path)?;
            }
            list.sort_by_key(|s| s.to_lowercase());
            list.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        }
        let helper_path = canonical(
            helper
                .to_str()
                .ok_or_else(|| Error::invalid("helper path not Unicode"))?,
        )?;
        // Always protect the running executable, even if a consumer omits it.
        if engine == "psec" {
            protection.read_only_paths.push(helper_path);
        }
        for w in &policy.write_roots {
            if !policy.authority_roots.iter().any(|r| within(w, r)) {
                return Err(Error::invalid("write root exceeds authority"));
            }
            if policy
                .reference_roots
                .iter()
                .any(|r| within(w, r) || within(r, w))
            {
                return Err(Error::invalid("reference and write roots overlap"));
            }
            if protection.read_only_paths.iter().any(|r| within(w, r)) {
                return Err(Error::invalid("write root overrides protected root"));
            }
        }
        if protection
            .deny_paths
            .iter()
            .any(|p| within(&spec.argv[0], p) || within(&spec.cwd, p))
        {
            return Err(Error::invalid("executable or cwd is denied"));
        }
        let mut read_only = volume_roots()?;
        read_only.extend(policy.reference_roots.iter().cloned());
        read_only.extend(protection.read_only_paths.iter().cloned());
        let bytes = serialize(&policy.write_roots, &read_only, &protection.deny_paths);
        let digest=hash(&serde_json::to_vec(&serde_json::json!({"engine":engine,"consoleMode":console_mode,"spec":spec,"policy":policy,"protection":protection,"schemaSha256":hash(&bytes)})).map_err(|_|Error::invalid("effective policy serialization"))?);
        Ok(Self {
            spec,
            policy,
            protection,
            console_mode,
            digest,
            bytes,
            identities,
        })
    }
    pub fn recheck(&self) -> Result<()> {
        for i in &self.identities {
            i.check()?;
        }
        let helper = std::env::current_exe().map_err(|e| Error::io("current_exe", e))?;
        if file_hash(&helper)? != self.protection.helper_sha256 {
            return Err(Error::state("helper content changed"));
        }
        Ok(())
    }
}
pub fn validate_console(engine: &str, transport: &str, mode: &str) -> Result<()> {
    match (mode, engine, transport) {
        ("no-window", _, _) | ("hidden-console", "unrestricted", "pipe") => Ok(()),
        _ => Err(Error::invalid(
            "hidden-console is supported only for trusted unrestricted pipe execution; unknown console modes are rejected",
        )),
    }
}
pub fn validate(engine: &str, spec: &Spec, policy: &Policy) -> Result<()> {
    if engine == "psec" && spec.transport == "pty" {
        return Err(Error {
            code: "unsupported-transport",
            ..Error::invalid(
                "PSEC plus ConPTY is not qualified; this helper supports confined pipe execution only",
            )
        });
    }
    if !matches!(
        (engine, policy.mode.as_str()),
        ("psec", "read-only" | "workspace-write") | ("unrestricted", "danger-full-access")
    ) {
        return Err(Error::invalid("engine and policy mode do not match"));
    }
    if policy.readable != "caller"
        || !matches!(policy.authority_kind.as_str(), "bound" | "unbound")
        || policy.fingerprint.is_empty()
        || policy.fingerprint.len() > 256
        || policy.authority_revision.is_empty()
    {
        return Err(Error::invalid("invalid policy authority fields"));
    }
    if spec.owner.session_id != policy.owner.session_id
        || spec.owner.parent_session_id != policy.owner.parent_session_id
        || spec.owner.session_id.is_empty()
    {
        return Err(Error::invalid("owner mismatch"));
    }
    if policy.mode == "read-only" && !policy.write_roots.is_empty() {
        return Err(Error::invalid("read-only policy contains write roots"));
    }
    if engine == "unrestricted" && !policy.reference_roots.is_empty() {
        return Err(Error::invalid(
            "unrestricted engine cannot enforce reference locks",
        ));
    }
    if !matches!(spec.lifetime.as_str(), "complete-tree" | "retain-tree")
        || !matches!(spec.transport.as_str(), "pipe" | "pty")
    {
        return Err(Error::invalid("unknown lifetime or transport"));
    }
    if spec.argv.is_empty() || spec.argv.len() > 4096 {
        return Err(Error::invalid("argv requires 1..4096 entries"));
    }
    for arg in &spec.argv {
        if arg.contains('\0') {
            return Err(Error::invalid("argument contains NUL"));
        }
    }
    path_syntax(&spec.argv[0])?;
    path_syntax(&spec.cwd)?;
    if !matches!(spec.argument_encoding.as_str(), "crt" | "cmd-verbatim") {
        return Err(Error::invalid("invalid argument encoding"));
    }
    if spec.argument_encoding == "cmd-verbatim"
        && (!spec.argv[0].to_lowercase().ends_with("\\cmd.exe")
            || spec.argv.len() != 5
            || spec.argv[1..4]
                .iter()
                .map(|s| s.to_lowercase())
                .collect::<Vec<_>>()
                != ["/d", "/s", "/c"])
    {
        return Err(Error::invalid(
            "cmd-verbatim requires cmd.exe /d /s /c and one raw command argument",
        ));
    }
    if spec.transport == "pty" {
        let p = spec
            .pty
            .as_ref()
            .ok_or_else(|| Error::invalid("PTY size required"))?;
        crate::protocol::size(p.cols, p.rows)?;
    } else if spec.pty.is_some() {
        return Err(Error::invalid("pipe transport cannot carry PTY dimensions"));
    }
    let mut names = std::collections::BTreeSet::new();
    let mut env_len = 1usize;
    for (k, v) in &spec.env {
        if k.is_empty()
            || k.contains(['\0', '='])
            || v.contains('\0')
            || !names.insert(k.to_lowercase())
        {
            return Err(Error::invalid("invalid or duplicate environment key/value"));
        }
        env_len += k.encode_utf16().count() + v.encode_utf16().count() + 2;
    }
    if env_len > 32767 {
        return Err(Error::invalid("environment exceeds 32767 UTF16 units"));
    }
    Ok(())
}
pub fn volume_roots() -> Result<Vec<String>> {
    let mut buffer = vec![0u16; 1024];
    let n = unsafe { GetLogicalDriveStringsW(buffer.len() as u32, buffer.as_mut_ptr()) } as usize;
    if n == 0 || n >= buffer.len() {
        return Err(Error::native("GetLogicalDriveStringsW"));
    }
    Ok(buffer[..n]
        .split(|c| *c == 0)
        .filter(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect())
}
pub fn serialize(write: &[String], read: &[String], deny: &[String]) -> Vec<u8> {
    let mut egress = EndpointPolicyT::default();
    egress.default_action = FilterAction::deny;
    let mut network = NetworkPolicyT::default();
    network.egress = Some(Box::new(egress));
    let mut p = ProcessSecurityEnvironmentT::default();
    p.version.major = 1;
    p.version.minor = 0;
    p.capabilities = Some("registryRead".into());
    p.disallow_win32k_system_calls = false;
    p.ui_restrictions = 0;
    p.fs_read_write = Some(write.to_vec());
    p.fs_read_only = Some(read.to_vec());
    p.fs_deny = Some(deny.to_vec());
    p.network_policy = Some(Box::new(network));
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let root = p.pack(&mut builder);
    finish_process_security_environment_buffer(&mut builder, root);
    builder.finished_data().to_vec()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_console_is_confined_to_trusted_unrestricted_pipes() {
        assert!(validate_console("unrestricted", "pipe", "hidden-console").is_ok());
        assert!(validate_console("unrestricted", "pipe", "no-window").is_ok());
        assert!(validate_console("unrestricted", "pty", "hidden-console").is_err());
        assert!(validate_console("psec", "pipe", "hidden-console").is_err());
        assert!(validate_console("unrestricted", "pipe", "visible").is_err());
    }
    #[test]
    fn schema_has_explicit_network_deny_and_rules() {
        let bytes = serialize(
            &["D:\\rw".into()],
            &["C:\\".into()],
            &["D:\\rw\\secret".into()],
        );
        assert_eq!(&bytes[4..8], b"PSEC");
        let p = root_as_process_security_environment(&bytes).unwrap();
        assert_eq!(p.version().major(), 1);
        assert_eq!(p.fs_read_write().unwrap().get(0), "D:\\rw");
        assert_eq!(p.fs_deny().unwrap().get(0), "D:\\rw\\secret");
        assert_eq!(
            p.network_policy()
                .unwrap()
                .egress()
                .unwrap()
                .default_action(),
            FilterAction::deny
        );
        assert_eq!(p.capabilities(), Some("registryRead"));
    }
    #[test]
    fn rejects_relative_device_and_stream_paths() {
        for p in [
            "x",
            "D:foo",
            "\\\\server\\share",
            "D:\\x:stream",
            "\\\\?\\C:\\x",
        ] {
            assert!(path_syntax(p).is_err(), "{p}");
        }
        assert!(path_syntax("D:\\x").is_ok());
    }
    #[test]
    fn containment_uses_components() {
        assert!(within("D:\\a\\b", "d:\\a"));
        assert!(!within("D:\\ab", "D:\\a"));
    }
    #[test]
    fn engine_and_reference_admission() {
        let spec:Spec=serde_json::from_value(serde_json::json!({"argv":["D:\\helper.exe"],"cwd":"D:\\work","env":{},"owner":{"sessionId":"x"},"transport":"pipe","lifetime":"retain-tree","argumentEncoding":"crt"})).unwrap();
        let mut p:Policy=serde_json::from_value(serde_json::json!({"mode":"danger-full-access","owner":{"sessionId":"x"},"authorityRevision":"1","authorityKind":"bound","primaryRoot":"D:\\work","readable":"caller","authorityRoots":["D:\\work"],"writeRoots":[],"referenceRoots":[],"fingerprint":"fp"})).unwrap();
        assert!(validate("unrestricted", &spec, &p).is_ok());
        assert!(validate("psec", &spec, &p).is_err());
        p.reference_roots.push("D:\\reference".into());
        assert!(validate("unrestricted", &spec, &p).is_err());
        p.mode = "read-only".into();
        assert!(validate("psec", &spec, &p).is_ok());
        p.write_roots.push("D:\\work".into());
        assert!(validate("psec", &spec, &p).is_err());
    }
}
