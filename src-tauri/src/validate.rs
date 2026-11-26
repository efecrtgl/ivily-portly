//! Input validation shared by every IPC command. The UI also validates, but
//! the backend never trusts it.

use crate::error::{invalid, AppResult};
use std::net::IpAddr;
use std::path::Path;

pub const MAX_NAME: usize = 100;
pub const MAX_TEXT: usize = 4000;
pub const MAX_SHORT: usize = 200;

pub fn port(p: i64) -> AppResult<u16> {
    if (1..=65535).contains(&p) {
        Ok(p as u16)
    } else {
        invalid(format!("port must be between 1 and 65535 (got {p})"))
    }
}

pub fn port_range(start: i64, end: i64) -> AppResult<(u16, u16)> {
    let (s, e) = (port(start)?, port(end)?);
    if s > e {
        return invalid("range start must not exceed range end");
    }
    Ok((s, e))
}

pub fn protocol(p: &str) -> AppResult<&'static str> {
    match p.to_ascii_lowercase().as_str() {
        "tcp" => Ok("tcp"),
        "udp" => Ok("udp"),
        _ => invalid("protocol must be tcp or udp"),
    }
}

fn no_control(s: &str, field: &str, allow_newlines: bool) -> AppResult<()> {
    if s.chars().any(|c| c.is_control() && !(allow_newlines && (c == '\n' || c == '\r' || c == '\t'))) {
        return invalid(format!("{field} contains control characters"));
    }
    Ok(())
}

/// Required single-line name.
pub fn name(s: &str, field: &str) -> AppResult<String> {
    let t = s.trim();
    if t.is_empty() {
        return invalid(format!("{field} is required"));
    }
    if t.chars().count() > MAX_NAME {
        return invalid(format!("{field} must be at most {MAX_NAME} characters"));
    }
    no_control(t, field, false)?;
    Ok(t.to_string())
}

/// Optional single-line short text.
pub fn short(s: &str, field: &str) -> AppResult<String> {
    let t = s.trim();
    if t.chars().count() > MAX_SHORT {
        return invalid(format!("{field} must be at most {MAX_SHORT} characters"));
    }
    no_control(t, field, false)?;
    Ok(t.to_string())
}

/// Optional multi-line text.
pub fn text(s: &str, field: &str) -> AppResult<String> {
    if s.chars().count() > MAX_TEXT {
        return invalid(format!("{field} must be at most {MAX_TEXT} characters"));
    }
    no_control(s, field, true)?;
    Ok(s.trim_end().to_string())
}

/// Hosts that health checks may contact: loopback only. Health monitoring
/// is for *local* development servers; it must not become a network scanner.
pub fn local_host(h: &str) -> AppResult<String> {
    let t = h.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if t == "localhost" {
        return Ok(t);
    }
    match t.parse::<IpAddr>() {
        Ok(ip) if ip.is_loopback() => Ok(ip.to_string()),
        Ok(_) => invalid("only loopback hosts (localhost, 127.0.0.1, ::1) can be monitored"),
        Err(_) => invalid("host must be localhost or a loopback IP address"),
    }
}

/// HTTP path for health checks: must start with `/`, printable ASCII, no
/// spaces, bounded length.
pub fn http_path(p: &str) -> AppResult<String> {
    let t = p.trim();
    let t = if t.is_empty() { "/" } else { t };
    if !t.starts_with('/') || t.len() > 512 || !t.chars().all(|c| c.is_ascii_graphic()) {
        return invalid("health path must start with / and contain only printable ASCII without spaces");
    }
    Ok(t.to_string())
}

/// Absolute path to an existing directory.
pub fn existing_dir(p: &str) -> AppResult<String> {
    let t = p.trim();
    let path = Path::new(t);
    if !path.is_absolute() {
        return invalid("directory must be an absolute path");
    }
    if t.contains('\0') {
        return invalid("directory contains invalid characters");
    }
    if !path.is_dir() {
        return invalid(format!("directory does not exist: {t}"));
    }
    Ok(t.to_string())
}

pub fn check_kind(k: &str) -> AppResult<&'static str> {
    match k {
        "none" => Ok("none"),
        "tcp" => Ok("tcp"),
        "http" => Ok("http"),
        _ => invalid("health check must be none, tcp or http"),
    }
}

/// Metadata: a flat JSON object of string → string with bounded size.
pub fn metadata(v: &serde_json::Value) -> AppResult<String> {
    let obj = match v {
        serde_json::Value::Null => return Ok("{}".into()),
        serde_json::Value::Object(o) => o,
        _ => return invalid("metadata must be an object"),
    };
    if obj.len() > 50 {
        return invalid("metadata may have at most 50 entries");
    }
    for (k, val) in obj {
        name(k, "metadata key")?;
        match val {
            serde_json::Value::String(s) => {
                short(s, "metadata value")?;
            }
            _ => return invalid("metadata values must be strings"),
        }
    }
    Ok(serde_json::to_string(obj)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports() {
        assert!(port(0).is_err() && port(65536).is_err() && port(-1).is_err());
        assert_eq!(port(65535).unwrap(), 65535);
        assert!(port_range(10, 5).is_err());
        assert_eq!(port_range(3000, 3000).unwrap(), (3000, 3000));
    }

    #[test]
    fn names_and_text() {
        assert!(name("   ", "Name").is_err());
        assert!(name(&"x".repeat(101), "Name").is_err());
        assert!(name("bad\u{0007}", "Name").is_err());
        assert_eq!(name("  My API  ", "Name").unwrap(), "My API");
        assert!(text("line1\nline2\ttab", "Notes").is_ok());
        assert!(short("a\nb", "Label").is_err());
    }

    #[test]
    fn hosts_are_loopback_only() {
        assert_eq!(local_host("localhost").unwrap(), "localhost");
        assert_eq!(local_host("127.0.0.1").unwrap(), "127.0.0.1");
        assert_eq!(local_host("[::1]").unwrap(), "::1");
        assert!(local_host("192.168.1.1").is_err());
        assert!(local_host("example.com").is_err());
        assert!(local_host("0.0.0.0").is_err());
    }

    #[test]
    fn http_paths() {
        assert_eq!(http_path("").unwrap(), "/");
        assert!(http_path("/health").is_ok());
        assert!(http_path("health").is_err());
        assert!(http_path("/a b").is_err());
        assert!(http_path("/x\r\nHost: evil").is_err(), "no header injection");
    }

    #[test]
    fn dirs_and_metadata() {
        let d = tempfile::tempdir().unwrap();
        assert!(existing_dir(d.path().to_str().unwrap()).is_ok());
        assert!(existing_dir("relative\\path").is_err());
        assert!(existing_dir(&format!("{}\\missing", d.path().display())).is_err());
        assert!(metadata(&serde_json::json!({"owner": "me"})).is_ok());
        assert!(metadata(&serde_json::json!({"n": 1})).is_err());
        assert!(metadata(&serde_json::json!([1])).is_err());
        assert!(protocol("TCP").is_ok() && protocol("icmp").is_err());
    }
}
