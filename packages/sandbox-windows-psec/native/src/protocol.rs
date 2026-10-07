use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const MAX_LINE: usize = 262144;
pub const MAX_INPUT: usize = 16384;
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub session_id: String,
    pub parent_session_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Size {
    pub cols: i16,
    pub rows: i16,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub owner: Owner,
    pub transport: String,
    pub lifetime: String,
    pub argument_encoding: String,
    pub pty: Option<Size>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub mode: String,
    pub owner: Owner,
    pub authority_revision: String,
    pub authority_kind: String,
    pub primary_root: String,
    pub readable: String,
    pub authority_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub reference_roots: Vec<String>,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Protection {
    pub read_only_paths: Vec<String>,
    pub deny_paths: Vec<String>,
    pub helper_sha256: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Prepare {
        engine: String,
        spec: Spec,
        policy: Policy,
        protection: Protection,
        #[serde(rename = "consoleMode")]
        console_mode: Option<String>,
    },
    Commit {
        #[serde(rename = "effectivePolicyDigest")]
        effective_policy_digest: String,
    },
    Input {
        data: Vec<u8>,
    },
    EndInput,
    Resize {
        cols: i16,
        rows: i16,
    },
    Signal {
        signal: String,
    },
    Cancel {
        reason: String,
    },
    Release,
}
pub struct Command {
    pub id: String,
    pub action: Action,
}
struct StrictValue(serde_json::Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, StrictValue>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate object key"));
                    }
                }
                Ok(StrictValue(values.into()))
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut seq: S,
            ) -> std::result::Result<Self::Value, S::Error> {
                let mut values = vec![];
                while let Some(value) = seq.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(values.into()))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                v: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                v: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                let n = serde_json::Number::from_f64(v)
                    .ok_or_else(|| E::custom("nonfinite JSON number"))?;
                Ok(StrictValue(n.into()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(serde_json::Value::Null))
            }
        }
        d.deserialize_any(Visitor)
    }
}
pub fn parse(bytes: &[u8]) -> Result<Command> {
    if bytes.len() > MAX_LINE {
        return Err(Error::invalid("command exceeds 262144 bytes"));
    }
    let mut v = serde_json::from_slice::<StrictValue>(bytes)
        .map_err(|_| Error::invalid("invalid JSON command or duplicate fields"))?
        .0;
    let map = v
        .as_object_mut()
        .ok_or_else(|| Error::invalid("command must be an object"))?;
    if map.remove("version") != Some(serde_json::json!(1)) {
        return Err(Error::invalid("version must be 1"));
    }
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| Error::invalid("id required"))?;
    if id.is_empty()
        || id.len() > 128
        || matches!(id.as_str(), "protocol" | "helper")
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        return Err(Error::invalid(
            "id must contain 1..128 ASCII identifier characters and not be reserved",
        ));
    }
    let fields: &[&str] = match map.get("type").and_then(|v| v.as_str()) {
        Some("prepare") => &[
            "type",
            "engine",
            "spec",
            "policy",
            "protection",
            "consoleMode",
        ],
        Some("commit") => &["type", "effectivePolicyDigest"],
        Some("input") => &["type", "data"],
        Some("resize") => &["type", "cols", "rows"],
        Some("signal") => &["type", "signal"],
        Some("cancel") => &["type", "reason"],
        Some("end-input" | "release") => &["type"],
        _ => return Err(Error::invalid("unknown command")),
    };
    if map.keys().any(|k| !fields.contains(&k.as_str())) {
        return Err(Error::invalid("unknown command field"));
    }
    let action: Action = serde_json::from_value(v)
        .map_err(|_| Error::invalid("unknown command or malformed fields"))?;
    if let Action::Input { data } = &action {
        if data.len() > MAX_INPUT {
            return Err(Error::invalid("input exceeds 16384 bytes"));
        }
    }
    if let Action::Resize { cols, rows } = &action {
        size(*cols, *rows)?;
    }
    Ok(Command { id, action })
}
pub fn size(cols: i16, rows: i16) -> Result<()> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        Err(Error::invalid("PTY dimensions must be 1..1000"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_rejects_unknown_and_bad_version() {
        assert!(parse(br#"{"version":2,"id":"a","type":"release"}"#).is_err());
        assert!(parse(br#"{"version":1,"id":"a","type":"release","extra":true}"#).is_err());
        assert!(parse(br#"{"version":1,"id":"a","type":"input","data":[256]}"#).is_err());
    }
    #[test]
    fn finite_bounds() {
        assert!(size(0, 80).is_err());
        assert!(size(80, 1001).is_err());
        let data =
            serde_json::json!({"version":1,"id":"a","type":"input","data":vec![0; MAX_INPUT+1]});
        assert!(parse(data.to_string().as_bytes()).is_err());
    }
    #[test]
    fn valid_input() {
        assert!(parse(br#"{"version":1,"id":"a","type":"input","data":[0,255]}"#).is_ok());
    }
    #[test]
    fn duplicate_fields_are_ambiguous() {
        assert!(parse(br#"{"version":1,"id":"old","id":"new","type":"release"}"#).is_err());
    }
}
