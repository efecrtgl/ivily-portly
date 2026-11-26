//! Termination safety rules.
//!
//! Termination is always user-initiated and confirmed in the UI. These rules
//! additionally *block* critical operating-system processes and attach clear
//! risk explanations to everything else. Portly never uses elevation, debug
//! privileges or other workarounds to terminate protected processes.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Low,
    Medium,
    High,
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminationAssessment {
    pub allowed: bool,
    pub risk: Risk,
    pub reasons: Vec<String>,
}

/// Processes whose termination destabilizes or crashes Windows, or that are
/// security components. Lowercase executable names.
const CRITICAL: &[&str] = &[
    "system",
    "idle",
    "registry",
    "secure system",
    "memory compression",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "dwm.exe",
    "fontdrvhost.exe",
    "sihost.exe",
    "msmpeng.exe",
    "nissrv.exe",
    "securityhealthservice.exe",
    "wudfhost.exe",
    "spoolsv.exe",
    "audiodg.exe",
];

/// Shell / session processes: recoverable, but disruptive.
const DISRUPTIVE: &[&str] = &["explorer.exe", "ctfmon.exe", "searchhost.exe", "startmenuexperiencehost.exe", "taskmgr.exe"];

/// Accounts that indicate a Windows service process.
const SERVICE_ACCOUNTS: &[&str] = &["nt authority\\system", "nt authority\\local service", "nt authority\\network service"];

pub struct Subject<'a> {
    pub pid: u32,
    pub name: &'a str,
    pub path: Option<&'a str>,
    pub owner: Option<&'a str>,
    pub current_user: Option<&'a str>,
    pub self_pid: u32,
    pub windows_dir: &'a str,
    pub listening_ports: usize,
}

fn in_windows_dir(path: &str, windows_dir: &str) -> bool {
    let p = path.to_ascii_lowercase().replace('/', "\\");
    let w = windows_dir.to_ascii_lowercase().trim_end_matches('\\').to_string() + "\\";
    p.starts_with(&w)
}

pub fn assess(s: &Subject) -> TerminationAssessment {
    let name = s.name.to_ascii_lowercase();
    let mut reasons = Vec::new();

    if s.pid == 0 || s.pid == 4 {
        return blocked("This is a Windows kernel pseudo-process and cannot be terminated.");
    }
    if s.pid == s.self_pid {
        return blocked("This is Ivily Portly itself. Close the window instead.");
    }
    if CRITICAL.contains(&name.as_str()) {
        match s.path {
            Some(p) if !in_windows_dir(p, s.windows_dir) => {
                // Same name as a critical process but not the real one.
                reasons.push(format!(
                    "Named like the Windows component \"{}\" but runs from outside the Windows directory. Review it carefully before terminating.",
                    s.name
                ));
                return TerminationAssessment { allowed: true, risk: Risk::High, reasons };
            }
            _ => {
                return blocked(&format!(
                "\"{}\" is a critical Windows process. Terminating it can crash or destabilize the system, so Portly blocks this action.",
                s.name
            ))
            }
        }
    }

    let mut risk = Risk::Low;
    if DISRUPTIVE.contains(&name.as_str()) {
        risk = Risk::Medium;
        reasons.push("Part of the Windows shell or session. Terminating it closes visible UI until Windows restarts it.".into());
    }
    if let Some(o) = s.owner {
        let ol = o.to_ascii_lowercase();
        if SERVICE_ACCOUNTS.contains(&ol.as_str()) {
            risk = risk.max(Risk::High);
            reasons.push(format!("Runs as the service account {o}. Windows will usually deny this without administrator rights, and stopping services can affect other software."));
        } else if let Some(me) = s.current_user {
            if !ol.eq_ignore_ascii_case(me) {
                risk = risk.max(Risk::Medium);
                reasons.push(format!("Owned by another account ({o}). Windows may deny the request."));
            }
        }
    } else {
        risk = risk.max(Risk::Medium);
        reasons.push(
            "Owner could not be read — the process is probably elevated or belongs to another account, so Windows may deny the request."
                .into(),
        );
    }
    if s.path.is_some_and(|p| in_windows_dir(p, s.windows_dir)) {
        risk = risk.max(Risk::High);
        reasons.push("The executable lives in the Windows directory; it is likely an operating system component.".into());
    }
    if s.listening_ports > 0 {
        reasons.push(format!("It is listening on {} port(s). Clients connected to it will be disconnected.", s.listening_ports));
    }
    reasons.push("Termination is immediate: unsaved work in the process is lost and it gets no chance to clean up.".into());
    TerminationAssessment { allowed: true, risk, reasons }
}

fn blocked(msg: &str) -> TerminationAssessment {
    TerminationAssessment { allowed: false, risk: Risk::Blocked, reasons: vec![msg.to_string()] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subj<'a>(pid: u32, name: &'a str, path: Option<&'a str>, owner: Option<&'a str>) -> Subject<'a> {
        Subject { pid, name, path, owner, current_user: Some("PC\\dev"), self_pid: 999, windows_dir: "C:\\Windows", listening_ports: 1 }
    }

    #[test]
    fn blocks_kernel_and_self() {
        assert!(!assess(&subj(0, "Idle", None, None)).allowed);
        assert!(!assess(&subj(4, "System", None, None)).allowed);
        assert!(!assess(&subj(999, "ivily-portly.exe", None, None)).allowed);
    }

    #[test]
    fn blocks_critical_system_processes() {
        let a = assess(&subj(700, "lsass.exe", Some("C:\\Windows\\System32\\lsass.exe"), None));
        assert!(!a.allowed);
        assert_eq!(a.risk, Risk::Blocked);
        // Path unknown (access denied) is still blocked.
        assert!(!assess(&subj(800, "csrss.exe", None, None)).allowed);
        // Case-insensitive.
        assert!(!assess(&subj(801, "SVCHOST.EXE", Some("c:/windows/system32/svchost.exe"), None)).allowed);
    }

    #[test]
    fn impersonating_name_outside_windows_is_allowed_with_high_risk() {
        let a = assess(&subj(1200, "svchost.exe", Some("C:\\Users\\dev\\AppData\\Local\\Temp\\svchost.exe"), Some("PC\\dev")));
        assert!(a.allowed);
        assert_eq!(a.risk, Risk::High);
    }

    #[test]
    fn dev_server_is_low_risk() {
        let a = assess(&subj(5000, "node.exe", Some("C:\\Program Files\\nodejs\\node.exe"), Some("PC\\dev")));
        assert!(a.allowed);
        assert_eq!(a.risk, Risk::Low);
        assert!(a.reasons.iter().any(|r| r.contains("listening")));
    }

    #[test]
    fn service_accounts_and_unknown_owner_raise_risk() {
        let a = assess(&subj(5001, "postgres.exe", Some("C:\\PG\\postgres.exe"), Some("NT AUTHORITY\\NETWORK SERVICE")));
        assert_eq!(a.risk, Risk::High);
        let b = assess(&subj(5002, "app.exe", None, None));
        assert_eq!(b.risk, Risk::Medium);
        let c = assess(&subj(5003, "app.exe", Some("D:\\x\\app.exe"), Some("PC\\other")));
        assert_eq!(c.risk, Risk::Medium);
    }

    #[test]
    fn shell_processes_are_medium() {
        let a = assess(&subj(6000, "explorer.exe", Some("D:\\custom\\explorer.exe"), Some("PC\\dev")));
        assert_eq!(a.risk, Risk::Medium);
        let b = assess(&subj(6001, "explorer.exe", Some("C:\\Windows\\explorer.exe"), Some("PC\\dev")));
        assert_eq!(b.risk, Risk::High);
    }
}
