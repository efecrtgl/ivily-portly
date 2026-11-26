//! Application error type. Errors are serialized to the UI as
//! `{ code, message }` so the frontend can branch on a stable code.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Invalid(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Access denied: {0}")]
    AccessDenied(String),
    #[error("Protected: {0}")]
    Protected(String),
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Operating system error: {0}")]
    Os(String),
    #[error("Database error: {0}")]
    Db(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Unsupported: {0}")]
    Unsupported(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Invalid(_) => "invalid",
            AppError::NotFound(_) => "not_found",
            AppError::AccessDenied(_) => "access_denied",
            AppError::Protected(_) => "protected",
            AppError::Conflict(_) => "conflict",
            AppError::Os(_) => "os",
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::Unsupported(_) => "unsupported",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("record".into()),
            other => AppError::Db(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Invalid(format!("JSON: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Shorthand for returning a validation error.
pub fn invalid<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(msg.into()))
}
