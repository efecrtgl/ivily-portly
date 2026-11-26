//! Windows process APIs.

use super::{filetime_to_unix_ms, Access, ProcessBasic, ProcessDetails};
use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE};
use windows::Win32::Security::{GetTokenInformation, LookupAccountSidW, TokenUser, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

/// Closes a handle on drop.
struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

pub fn snapshot() -> AppResult<HashMap<u32, ProcessBasic>> {
    let snap =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|e| AppError::Os(format!("process snapshot failed: {e}")))?;
    let snap = Owned(snap);
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut out = HashMap::with_capacity(512);
    let mut ok = unsafe { Process32FirstW(snap.0, &mut entry) }.is_ok();
    while ok {
        out.insert(
            entry.th32ProcessID,
            ProcessBasic {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                name: wide_to_string(&entry.szExeFile),
                threads: entry.cntThreads,
            },
        );
        ok = unsafe { Process32NextW(snap.0, &mut entry) }.is_ok();
    }
    Ok(out)
}

fn ft_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

fn open_limited(pid: u32) -> Result<Owned, bool> {
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(h) => Ok(Owned(h)),
        Err(e) => Err(e.code() == ERROR_ACCESS_DENIED.to_hresult()),
    }
}

fn image_path(h: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

fn times(h: HANDLE) -> (Option<i64>, Option<u64>) {
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) }.is_err() {
        return (None, None);
    }
    let cpu_ms = (ft_u64(k) + ft_u64(u)) / 10_000;
    (filetime_to_unix_ms(ft_u64(c)), Some(cpu_ms))
}

fn memory(h: HANDLE) -> Option<u64> {
    let mut pmc = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
    unsafe { K32GetProcessMemoryInfo(h, &mut pmc, pmc.cb) }.as_bool().then_some(pmc.WorkingSetSize as u64)
}

fn owner(h: HANDLE) -> Option<String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(h, TOKEN_QUERY, &mut token) }.ok()?;
    let token = Owned(token);
    let mut len = 0u32;
    let _ = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut len) };
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    unsafe { GetTokenInformation(token.0, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len) }.ok()?;
    let tu = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let (mut name, mut domain) = (vec![0u16; 256], vec![0u16; 256]);
    let (mut nl, mut dl) = (name.len() as u32, domain.len() as u32);
    let mut use_ = SID_NAME_USE::default();
    unsafe {
        LookupAccountSidW(None, tu.User.Sid, Some(PWSTR(name.as_mut_ptr())), &mut nl, Some(PWSTR(domain.as_mut_ptr())), &mut dl, &mut use_)
    }
    .ok()?;
    let n = wide_to_string(&name);
    let d = wide_to_string(&domain);
    Some(if d.is_empty() { n } else { format!("{d}\\{n}") })
}

pub fn details(pid: u32, with_owner: bool) -> (Access, ProcessDetails) {
    let h = match open_limited(pid) {
        Ok(h) => h,
        Err(_) => return (Access::Denied, ProcessDetails::default()),
    };
    let (start_time, cpu_time_ms) = times(h.0);
    (
        Access::Full,
        ProcessDetails {
            path: image_path(h.0),
            start_time,
            memory_bytes: memory(h.0),
            cpu_time_ms,
            owner: if with_owner { owner(h.0) } else { None },
        },
    )
}

pub fn terminate(pid: u32, expected_start: Option<i64>) -> AppResult<()> {
    // Re-verify identity immediately before acting.
    let current =
        match open_limited(pid) {
            Ok(h) => times(h.0).0,
            Err(true) => return Err(AppError::AccessDenied(
                "Windows denied access to this process. It may be elevated, protected or owned by another user; Portly does not elevate."
                    .into(),
            )),
            Err(false) => return Err(AppError::NotFound(format!("process {pid} is no longer running"))),
        };
    if expected_start.is_some() && current != expected_start {
        return Err(AppError::Conflict(format!("PID {pid} now belongs to a different process instance; nothing was terminated")));
    }
    let h = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }.map_err(|e| {
        if e.code() == ERROR_ACCESS_DENIED.to_hresult() {
            AppError::AccessDenied("Windows denied permission to terminate this process. Portly does not elevate privileges.".into())
        } else {
            AppError::Os(format!("could not open process: {e}"))
        }
    })?;
    let h = Owned(h);
    unsafe { TerminateProcess(h.0, 1) }.map_err(|e| AppError::Os(format!("termination failed: {e}")))
}
