//! Operating-system port exclusions.
//!
//! Windows can exclude port ranges from use (commonly Hyper-V, WSL, Docker or
//! WinNAT reservations, or administrator-defined exclusions). These are the
//! **only** ranges Portly ever labels as "reserved by the OS". They are read
//! with a fixed, argument-free invocation of `netsh` from System32; no user
//! input reaches the command line.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedRange {
    pub protocol: &'static str,
    pub family: &'static str,
    pub start: u16,
    pub end: u16,
    /// Marked with `*` by netsh: added by an administrator (persistent).
    pub administered: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionReport {
    pub ranges: Vec<ExcludedRange>,
    /// Whether netsh could be queried successfully.
    pub verified: bool,
    pub error: Option<String>,
}

impl ExclusionReport {
    pub fn find(&self, protocol: &str, port: u16) -> Option<&ExcludedRange> {
        self.ranges.iter().find(|r| r.protocol == protocol && port >= r.start && port <= r.end)
    }
}

/// Parses `netsh interface ipvX show excludedportrange protocol=Y` output.
/// The header text is localized, so only lines that start with two port
/// numbers are considered.
pub fn parse(output: &str, protocol: &'static str, family: &'static str) -> Vec<ExcludedRange> {
    output
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let start: u16 = it.next()?.parse().ok()?;
            let end: u16 = it.next()?.parse().ok()?;
            if end < start {
                return None;
            }
            let administered = it.next() == Some("*");
            Some(ExcludedRange { protocol, family, start, end, administered })
        })
        .collect()
}

#[cfg(windows)]
pub fn query() -> ExclusionReport {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let netsh = std::path::Path::new(&root).join("System32").join("netsh.exe");
    let mut report = ExclusionReport::default();
    let mut any_ok = false;
    for (family, fam_arg) in [("ipv4", "ipv4"), ("ipv6", "ipv6")] {
        for proto in ["tcp", "udp"] {
            let out = std::process::Command::new(&netsh)
                .args(["interface", fam_arg, "show", "excludedportrange", &format!("protocol={proto}")])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    any_ok = true;
                    let text = String::from_utf8_lossy(&o.stdout);
                    let p: &'static str = if proto == "tcp" { "tcp" } else { "udp" };
                    report.ranges.extend(parse(&text, p, family));
                }
                Ok(o) => report.error = Some(format!("netsh exited with {}", o.status)),
                Err(e) => report.error = Some(format!("netsh could not be started: {e}")),
            }
        }
    }
    report.verified = any_ok;
    report
}

#[cfg(not(windows))]
pub fn query() -> ExclusionReport {
    ExclusionReport { ranges: vec![], verified: false, error: Some("Windows only".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     50000       50059     *
     61234       61333

* - Administered port exclusions.
";

    #[test]
    fn parses_ranges_and_admin_marker() {
        let r = parse(SAMPLE, "tcp", "ipv4");
        assert_eq!(r.len(), 3);
        assert_eq!((r[0].start, r[0].end, r[0].administered), (5357, 5357, false));
        assert_eq!((r[1].start, r[1].end, r[1].administered), (50000, 50059, true));
        assert_eq!(r[2].end, 61333);
    }

    #[test]
    fn localized_headers_are_ignored() {
        let tr = "Protokol tcp Bağlantı Noktası Dışlama Aralıkları\n\nBaşlangıç  Bitiş\n---------- --------\n  1000  1099\n";
        let r = parse(tr, "tcp", "ipv4");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].start, 1000);
    }

    #[test]
    fn find_respects_protocol() {
        let rep = ExclusionReport { ranges: parse(SAMPLE, "tcp", "ipv4"), verified: true, error: None };
        assert!(rep.find("tcp", 50010).is_some());
        assert!(rep.find("udp", 50010).is_none());
        assert!(rep.find("tcp", 50060).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn live_query_runs() {
        // Must not panic; netsh may be unavailable in some sandboxes.
        let r = query();
        if r.verified {
            assert!(r.ranges.iter().all(|x| x.start <= x.end));
        }
    }
}
