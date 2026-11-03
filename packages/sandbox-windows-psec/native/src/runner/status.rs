use crate::error::{Error, Result};
use std::{
    io::Write,
    sync::{Mutex, OnceLock},
};

static STATUS: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

pub(super) fn initialize(file: std::fs::File) -> Result<()> {
    STATUS
        .set(Mutex::new(file))
        .map_err(|_| Error::state("private status already initialized"))
}

pub(super) fn status(id: &str, kind: &str, fields: serde_json::Value) -> Result<()> {
    let mut v = fields;
    let map = v.as_object_mut().expect("internal status object");
    map.insert("version".into(), 1.into());
    map.insert("id".into(), id.into());
    map.insert("type".into(), kind.into());
    let bytes = serde_json::to_vec(&v).map_err(|_| Error::state("status serialization failed"))?;
    if bytes.len() > 65536 {
        return Err(Error::state("status too large"));
    }
    let mut stdout = STATUS
        .get()
        .ok_or_else(|| Error::state("private status unavailable"))?
        .lock()
        .map_err(|_| Error::state("private status lock poisoned"))?;
    stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .map_err(|e| Error::io("write status", e))
}
pub(super) fn failure(id: &str, error: Error) -> Result<()> {
    status(id, "error", serde_json::json!({"error":error}))
}
