//! Transparent, rule-based indicators for local listeners.
//!
//! These are *review hints*, not malware detection. Each indicator names the
//! rule that produced it and the evidence, so the user can judge for
//! themselves. Portly performs no packet inspection or traffic capture.

use crate::net::BindScope;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndicatorLevel {
    /// Worth knowing (e.g. reachable from the network).
    Info,
    /// Unusual; worth reviewing.
    Review,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Indicator {
    pub rule: &'static str,
    pub level: IndicatorLevel,
    pub title: String,
    pub detail: String,
}

const SYSTEM_NAMES: &[&str] = &[
    "svchost.exe",
    "lsass.exe",
    "csrss.exe",
    "services.exe",
    "winlogon.exe",
    "smss.exe",
    "wininit.exe",
    "spoolsv.exe",
    "explorer.exe",
    "dwm.exe",
    "taskhostw.exe",
    "conhost.exe",
    "rundll32.exe",
];

const TEMP_MARKERS: &[(&str, &str)] = &[
    ("\\appdata\\local\\temp\\", "a temporary folder"),
    ("\\windows\\temp\\", "the Windows temporary folder"),
    ("\\downloads\\", "a Downloads folder"),
    ("\\$recycle.bin\\", "the Recycle Bin"),
];

pub struct ListenerFacts<'a> {
    pub name: &'a str,
    pub path: Option<&'a str>,
    pub path_exists: Option<bool>,
    pub windows_dir: &'a str,
    pub scopes: &'a [BindScope],
    pub listen_ports: &'a [u16],
    pub likely_dev_server: bool,
}

pub fn indicators(f: &ListenerFacts) -> Vec<Indicator> {
    let mut out = Vec::new();
    if f.listen_ports.is_empty() {
        return out;
    }
    let lname = f.name.to_ascii_lowercase();
    let lpath = f.path.map(|p| p.to_ascii_lowercase().replace('/', "\\"));
    let wdir = f.windows_dir.to_ascii_lowercase().trim_end_matches('\\').to_string() + "\\";

    if let Some(p) = lpath.as_deref() {
        if SYSTEM_NAMES.contains(&lname.as_str()) && !p.starts_with(&wdir) {
            out.push(Indicator {
                rule: "system-name-outside-windows",
                level: IndicatorLevel::Review,
                title: "Windows component name outside the Windows folder".into(),
                detail: format!(
                    "\"{}\" normally runs from {}, but this one runs from {}.",
                    f.name,
                    f.windows_dir,
                    f.path.unwrap_or_default()
                ),
            });
        }
        if let Some((_, where_)) = TEMP_MARKERS.iter().find(|(m, _)| p.contains(m)) {
            out.push(Indicator {
                rule: "listener-in-temporary-location",
                level: IndicatorLevel::Review,
                title: "Listening program runs from a temporary location".into(),
                detail: format!("The executable is in {where_}. Installed software rarely runs from there; it may be a one-off tool or installer — verify you recognize it."),
            });
        }
    }
    if f.path_exists == Some(false) {
        out.push(Indicator {
            rule: "executable-missing",
            level: IndicatorLevel::Review,
            title: "Executable no longer exists on disk".into(),
            detail: "The file this process was started from has been moved or deleted while it keeps listening.".into(),
        });
    }
    if f.scopes.contains(&BindScope::AllInterfaces) {
        out.push(Indicator {
            rule: "reachable-from-network",
            level: IndicatorLevel::Info,
            title: "Reachable from other devices".into(),
            detail: if f.likely_dev_server {
                "Bound to all interfaces (0.0.0.0 / ::). Other devices on your network can reach this development server unless the firewall blocks it. Bind to 127.0.0.1 if that is not intended.".into()
            } else {
                "Bound to all interfaces (0.0.0.0 / ::), so it can accept connections from the network subject to Windows Firewall rules.".into()
            },
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(name: &'a str, path: Option<&'a str>, scopes: &'a [BindScope]) -> ListenerFacts<'a> {
        ListenerFacts {
            name,
            path,
            path_exists: Some(true),
            windows_dir: "C:\\Windows",
            scopes,
            listen_ports: &[4444],
            likely_dev_server: false,
        }
    }

    #[test]
    fn impersonation_and_temp_location() {
        let r = indicators(&facts("svchost.exe", Some("C:\\Users\\me\\AppData\\Local\\Temp\\svchost.exe"), &[BindScope::Loopback]));
        let rules: Vec<_> = r.iter().map(|i| i.rule).collect();
        assert_eq!(rules, vec!["system-name-outside-windows", "listener-in-temporary-location"]);
        assert!(r.iter().all(|i| i.level == IndicatorLevel::Review));
    }

    #[test]
    fn genuine_system_process_is_quiet() {
        assert!(indicators(&facts("svchost.exe", Some("C:\\Windows\\System32\\svchost.exe"), &[BindScope::Loopback])).is_empty());
    }

    #[test]
    fn exposure_is_info_only() {
        let r = indicators(&facts("node.exe", Some("C:\\Program Files\\nodejs\\node.exe"), &[BindScope::AllInterfaces]));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].level, IndicatorLevel::Info);
    }

    #[test]
    fn missing_executable_and_no_listeners() {
        let mut f = facts("x.exe", Some("D:\\x.exe"), &[BindScope::Loopback]);
        f.path_exists = Some(false);
        assert_eq!(indicators(&f)[0].rule, "executable-missing");
        f.listen_ports = &[];
        assert!(indicators(&f).is_empty(), "non-listeners are not assessed");
    }
}
