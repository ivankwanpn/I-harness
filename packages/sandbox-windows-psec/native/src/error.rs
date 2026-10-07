use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: &'static str,
    pub api: String,
    pub native_code: Option<u32>,
    pub detail: String,
    pub cleanup: Vec<Error>,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn invalid(detail: impl Into<String>) -> Self {
        Self {
            code: "invalid-request",
            api: "validation".into(),
            native_code: None,
            detail: detail.into(),
            cleanup: vec![],
        }
    }
    pub fn state(detail: &str) -> Self {
        Self {
            code: "invalid-state",
            ..Self::invalid(detail)
        }
    }
    pub fn native(api: &str) -> Self {
        Self::native_code(api, unsafe {
            windows_sys::Win32::Foundation::GetLastError()
        })
    }
    pub fn native_code(api: &str, code: u32) -> Self {
        Self {
            code: "native-failure",
            api: api.into(),
            native_code: Some(code),
            detail: format!("{api} failed (0x{code:08x})"),
            cleanup: vec![],
        }
    }
    pub fn io(api: &str, error: std::io::Error) -> Self {
        Self {
            code: "io-failure",
            api: api.into(),
            native_code: error.raw_os_error().map(|v| v as u32),
            detail: format!("{api} failed"),
            cleanup: vec![],
        }
    }
}
