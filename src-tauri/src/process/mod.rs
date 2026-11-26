//! Process inspection.
//!
//! Uses only rights a standard user has (`PROCESS_QUERY_LIMITED_INFORMATION`).
//! When Windows denies access (elevated, protected or other-user processes)
//! the corresponding fields are `None` and `access` says why — Portly never
//! elevates to fill them in.

pub mod devserver;
pub mod icon;
pub mod protect;
#[cfg(windows)]
mod win;

use crate::error::AppResult;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Path, times and memory were readable.
    Full,
    /// The process exists but Windows denied query access.
    Denied,
    /// Pseudo-processes (Idle, System) that cannot be opened.
    System,
}

/// Cheap per-process facts from a Toolhelp snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessBasic {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
    pub threads: u32,
}

/// Facts that require opening the process.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetails {
    pub path: Option<String>,
    /// Unix epoch milliseconds.
    pub start_time: Option<i64>,
    pub memory_bytes: Option<u64>,
    /// Kernel + user CPU time in milliseconds.
    pub cpu_time_ms: Option<u64>,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub parent_name: Option<String>,
    pub name: String,
    pub threads: u32,
    pub access: Access,
    #[serde(flatten)]
    pub details: ProcessDetails,
}

#[cfg(windows)]
pub fn snapshot() -> AppResult<HashMap<u32, ProcessBasic>> {
    win::snapshot()
}
#[cfg(not(windows))]
pub fn snapshot() -> AppResult<HashMap<u32, ProcessBasic>> {
    Err(crate::error::AppError::Unsupported("Windows only".into()))
}

/// Opens the process for limited query and reads path, times and memory.
/// `with_owner` additionally resolves the token user (slightly costlier).
#[cfg(windows)]
pub fn details(pid: u32, with_owner: bool) -> (Access, ProcessDetails) {
    win::details(pid, with_owner)
}
#[cfg(not(windows))]
pub fn details(_pid: u32, _with_owner: bool) -> (Access, ProcessDetails) {
    (Access::Denied, ProcessDetails::default())
}

/// Terminates `pid` only if it is still the same process instance that the
/// user confirmed (matching start time), guarding against PID reuse.
#[cfg(windows)]
pub fn terminate(pid: u32, expected_start: Option<i64>) -> AppResult<()> {
    win::terminate(pid, expected_start)
}
#[cfg(not(windows))]
pub fn terminate(_pid: u32, _expected_start: Option<i64>) -> AppResult<()> {
    Err(crate::error::AppError::Unsupported("Windows only".into()))
}

/// Name of the account running Portly, e.g. `DESKTOP\\alice`.
#[cfg(windows)]
pub fn current_user() -> Option<String> {
    win::details(std::process::id(), true).1.owner
}
#[cfg(not(windows))]
pub fn current_user() -> Option<String> {
    None
}

/// Assembles a full [`ProcessInfo`] for one PID.
pub fn inspect(pid: u32, snap: &HashMap<u32, ProcessBasic>) -> Option<ProcessInfo> {
    let basic = snap.get(&pid)?;
    let (access, details) = if pid == 0 || pid == 4 { (Access::System, ProcessDetails::default()) } else { details(pid, true) };
    let parent = (basic.parent_pid != 0 && basic.parent_pid != pid).then_some(basic.parent_pid);
    Some(ProcessInfo {
        pid,
        parent_pid: parent,
        parent_name: parent.and_then(|p| snap.get(&p)).map(|p| p.name.clone()),
        name: basic.name.clone(),
        threads: basic.threads,
        access,
        details,
    })
}

/// Converts a Windows FILETIME (100 ns since 1601-01-01) to Unix ms.
pub fn filetime_to_unix_ms(ft: u64) -> Option<i64> {
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
    if ft < EPOCH_DIFF_100NS {
        return None;
    }
    Some(((ft - EPOCH_DIFF_100NS) / 10_000) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_conversion() {
        // 2024-01-01T00:00:00Z
        let ft = 133_485_408_000_000_000u64;
        assert_eq!(filetime_to_unix_ms(ft), Some(1_704_067_200_000));
        assert_eq!(filetime_to_unix_ms(5), None);
    }

    #[cfg(windows)]
    #[test]
    fn inspects_own_process() {
        let snap = snapshot().unwrap();
        let me = std::process::id();
        let info = inspect(me, &snap).expect("own process in snapshot");
        assert_eq!(info.access, Access::Full);
        let path = info.details.path.expect("own path readable");
        assert!(path.to_ascii_lowercase().ends_with(".exe"));
        assert!(info.details.start_time.unwrap() > 1_600_000_000_000);
        assert!(info.details.memory_bytes.unwrap() > 0);
        assert!(info.details.owner.is_some());
        assert!(info.parent_pid.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn system_process_is_marked() {
        let snap = snapshot().unwrap();
        if let Some(info) = inspect(4, &snap) {
            assert_eq!(info.access, Access::System);
        }
    }

    #[cfg(windows)]
    #[test]
    fn terminate_refuses_mismatched_start_time() {
        // Spawn a harmless child and try to kill it with a wrong start time.
        let mut child = std::process::Command::new("cmd").args(["/C", "ping -n 30 127.0.0.1 >NUL"]).spawn().unwrap();
        let pid = child.id();
        let err = terminate(pid, Some(1)).unwrap_err();
        assert_eq!(err.code(), "conflict");
        // Correct start time terminates it.
        let (_, d) = details(pid, false);
        terminate(pid, d.start_time).unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
    }
}
