//! Port conflict intelligence.
//!
//! A pure function of the current snapshot and the user's configuration.
//! Every conflict has a stable `id` (so the UI and notifications can tell
//! new conflicts from known ones), a plain-language explanation and safe
//! suggestions. Suggestions never include automatic actions.

use crate::health::{CheckResult, Status};
use crate::monitor::model::Snapshot;
use crate::net::excluded::ExclusionReport;
use crate::net::{BindScope, Protocol};
use crate::store::plans::{Plan, PlanEntry};
use crate::store::ports::Reservation;
use crate::store::projects::{Project, ProjectPort};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub kind: &'static str,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    pub suggestions: Vec<String>,
    pub protocol: Option<Protocol>,
    pub port: Option<u16>,
    pub project_ids: Vec<i64>,
    pub pids: Vec<u32>,
    /// A verified-free alternative, filled in by the monitor when relevant.
    pub alternative_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthState {
    pub last: Option<CheckResult>,
    /// The server answered at least once during this session.
    pub seen_up: bool,
    pub down_since: Option<i64>,
    pub up_since: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipChange {
    pub protocol: Protocol,
    pub port: u16,
    pub from: Vec<(u32, String)>,
    pub to: Vec<(u32, String)>,
    pub ts: i64,
}

pub struct Input<'a> {
    pub snapshot: &'a Snapshot,
    pub projects: &'a [Project],
    pub plans: &'a [Plan],
    pub reservations: &'a [Reservation],
    pub health: &'a HashMap<i64, HealthState>,
    pub excluded: &'a ExclusionReport,
    pub ownership_changes: &'a [OwnershipChange],
}

fn proto(s: &str) -> Protocol {
    Protocol::parse(s).unwrap_or(Protocol::Tcp)
}

fn name_matches(expected: &str, actual: &str) -> bool {
    let norm = |s: &str| s.trim().to_ascii_lowercase().trim_end_matches(".exe").to_string();
    norm(expected) == norm(actual)
}

fn conflict(id: String, kind: &'static str, severity: Severity, title: String, detail: String) -> Conflict {
    Conflict {
        id,
        kind,
        severity,
        title,
        detail,
        suggestions: vec![],
        protocol: None,
        port: None,
        project_ids: vec![],
        pids: vec![],
        alternative_port: None,
    }
}

pub fn detect(inp: &Input) -> Vec<Conflict> {
    let mut out = Vec::new();
    let snap = inp.snapshot;
    let usage: HashMap<(Protocol, u16), &crate::monitor::model::PortUsage> = snap.ports.iter().map(|u| ((u.protocol, u.port), u)).collect();
    let pname = |pid: u32| snap.process(pid).map(|p| p.name.clone()).unwrap_or_else(|| format!("PID {pid}"));

    // Index configured ports.
    let mut by_port: BTreeMap<(Protocol, u16), Vec<(&Project, &ProjectPort)>> = BTreeMap::new();
    for p in inp.projects {
        for pp in &p.ports {
            by_port.entry((proto(&pp.protocol), pp.port)).or_default().push((p, pp));
        }
    }

    // 1. Several projects configure the same port.
    for ((pr, port), users) in &by_port {
        let mut ids: Vec<i64> = users.iter().map(|(p, _)| p.id).collect();
        ids.dedup();
        if ids.len() > 1 {
            let names: Vec<&str> = users.iter().map(|(p, _)| p.name.as_str()).collect();
            let mut c = conflict(
                format!("shared:{}:{port}", pr.as_str()),
                "shared_project_port",
                Severity::Warning,
                format!("Port {port} is configured for {} projects", ids.len()),
                format!("{} all expect port {port}/{}. Only one of them can run at a time.", names.join(", "), pr.as_str()),
            );
            c.suggestions = vec![
                "Assign a different port to all but one of these projects.".into(),
                "Or keep them in separate profiles if they never run together.".into(),
            ];
            c.protocol = Some(*pr);
            c.port = Some(*port);
            c.project_ids = ids;
            out.push(c);
        }
    }

    for p in inp.projects {
        for pp in &p.ports {
            let pr = proto(&pp.protocol);
            let key = format!("{}:{}:{}", p.id, pr.as_str(), pp.port);
            let base = |c: &mut Conflict| {
                c.protocol = Some(pr);
                c.port = Some(pp.port);
                c.project_ids = vec![p.id];
            };

            // 2. Windows excluded port range.
            if let Some(r) = inp.excluded.find(pr.as_str(), pp.port) {
                let mut c = conflict(
                    format!("excluded:{key}"),
                    "os_excluded_port",
                    Severity::Error,
                    format!("{}: port {} is excluded by Windows", p.name, pp.port),
                    format!(
                        "Windows has excluded ports {}–{} ({}). Binding to {} fails with an access-denied error regardless of which program tries.",
                        r.start, r.end, if r.administered { "administrator-defined" } else { "typically reserved by Hyper-V, WSL, Docker or WinNAT" }, pp.port
                    ),
                );
                c.suggestions = vec![
                    "Move this service to a port outside the excluded range.".into(),
                    "Excluded ranges can change after a reboot; Portly re-checks them periodically.".into(),
                ];
                base(&mut c);
                out.push(c);
            }

            let occupant = usage.get(&(pr, pp.port));
            let occupant_names: Vec<String> = occupant.map(|u| u.pids.iter().map(|pid| pname(*pid)).collect()).unwrap_or_default();

            // 3. Occupied by an unrelated process.
            if let (Some(u), Some(expected)) = (occupant, pp.expected_process.as_deref()) {
                if !occupant_names.iter().any(|n| name_matches(expected, n)) {
                    let mut c = conflict(
                        format!("occupant:{key}"),
                        "unexpected_occupant",
                        Severity::Warning,
                        format!("{}: port {} is used by another program", p.name, pp.port),
                        format!("{} expects {expected} on port {}, but it's held by {}.", p.name, pp.port, occupant_names.join(", ")),
                    );
                    c.suggestions = vec![
                        "Stop the other program if you started it by accident, or".into(),
                        "use a different port for this project (see the suggested alternative).".into(),
                    ];
                    base(&mut c);
                    c.pids = u.pids.clone();
                    out.push(c);
                }
            }

            // 4–6. Health-derived conflicts.
            if let Some(h) = inp.health.get(&pp.id) {
                if let Some(last) = &h.last {
                    if last.status == Status::Down && occupant.is_some() && pp.check_kind == "http" {
                        let mut c = conflict(
                            format!("noresponse:{key}"),
                            "unexpected_response",
                            Severity::Warning,
                            format!("{}: port {} is open but not answering HTTP", p.name, pp.port),
                            format!(
                                "{} holds the port, but an HTTP request to {}{} failed{}.",
                                occupant_names.join(", "),
                                pp.host,
                                pp.http_path,
                                last.error.as_deref().map(|e| format!(" ({e})")).unwrap_or_default()
                            ),
                        );
                        c.suggestions = vec![
                            "Check that the right program is running on this port.".into(),
                            "If the server doesn't speak HTTP, switch its health check to TCP.".into(),
                        ];
                        base(&mut c);
                        c.pids = occupant.map(|u| u.pids.clone()).unwrap_or_default();
                        out.push(c);
                    } else if last.status == Status::Down && h.seen_up {
                        let mut c = conflict(
                            format!("down:{key}"),
                            "server_not_responding",
                            Severity::Warning,
                            format!("{} stopped responding on port {}", p.name, pp.port),
                            "The server answered earlier in this session but doesn't anymore. It may have crashed or been stopped.".into(),
                        );
                        c.suggestions = vec!["Check the server's terminal for errors and restart it yourself if needed.".into()];
                        base(&mut c);
                        out.push(c);
                    } else if last.status == Status::Degraded {
                        let mut c = conflict(
                            format!("degraded:{key}"),
                            "server_error_response",
                            Severity::Info,
                            format!("{} returns server errors on port {}", p.name, pp.port),
                            format!("The health check got HTTP {}.", last.http_status.unwrap_or(500)),
                        );
                        base(&mut c);
                        out.push(c);
                    }
                }
            }

            // 7. Unexpected address family / interface.
            if let Some(u) = occupant {
                let has = |pred: &dyn Fn(&str, BindScope) -> bool| u.bindings.iter().any(|b| pred(&b.addr, b.scope));
                let v4_ok = has(&|a, _| a == "127.0.0.1" || a == "0.0.0.0");
                let v6_ok = has(&|a, _| a == "::1" || a == "::");
                let mismatch = match pp.host.as_str() {
                    "127.0.0.1" if !v4_ok && v6_ok => Some("::1 (IPv6) only, but the project is configured for 127.0.0.1"),
                    "::1" if !v6_ok && v4_ok => Some("IPv4 only, but the project is configured for ::1"),
                    "localhost" if !v4_ok && !v6_ok => Some("a specific network interface only, so localhost requests don't reach it"),
                    _ => None,
                };
                if let Some(why) = mismatch {
                    let mut c = conflict(
                        format!("address:{key}"),
                        "unexpected_address",
                        Severity::Warning,
                        format!("{}: server answers on an unexpected address", p.name),
                        format!("Port {} is bound to {why}.", pp.port),
                    );
                    c.suggestions = vec![
                        "Configure the server to bind to the expected address, or".into(),
                        "change the project's host to match where the server actually listens (\"localhost\" accepts both).".into(),
                    ];
                    base(&mut c);
                    c.pids = u.pids.clone();
                    out.push(c);
                }
            }
        }
    }

    // 8. Ownership changes on registered ports (recent).
    for oc in inp.ownership_changes {
        let Some(users) = by_port.get(&(oc.protocol, oc.port)) else { continue };
        let names = |v: &[(u32, String)]| v.iter().map(|(pid, n)| format!("{n} ({pid})")).collect::<Vec<_>>().join(", ");
        let mut c = conflict(
            format!("owner:{}:{}:{}", oc.protocol.as_str(), oc.port, oc.ts),
            "ownership_changed",
            Severity::Info,
            format!("Port {} changed owner", oc.port),
            format!(
                "Registered for {}. It moved from {} to {}.",
                users.iter().map(|(p, _)| p.name.as_str()).collect::<Vec<_>>().join(", "),
                names(&oc.from),
                names(&oc.to)
            ),
        );
        c.protocol = Some(oc.protocol);
        c.port = Some(oc.port);
        c.project_ids = users.iter().map(|(p, _)| p.id).collect();
        c.pids = oc.to.iter().map(|(p, _)| *p).collect();
        c.suggestions = vec!["Usually harmless after a restart. If unexpected, inspect the new process.".into()];
        out.push(c);
    }

    // 9. Plans: duplicates and OS exclusions.
    for plan in inp.plans {
        for issue in validate_plan_entries(&plan.entries, inp.excluded).into_iter().filter(|i| i.severity == Severity::Error) {
            let e = &plan.entries[issue.index];
            let mut c = conflict(
                format!("plan:{}:{}:{}", plan.id, issue.code, issue.index),
                "plan_collision",
                Severity::Error,
                format!("Plan \"{}\": {}", plan.name, issue.message),
                format!("Entry \"{}\" uses port {}/{}.", e.service, e.port, e.protocol),
            );
            c.protocol = Some(proto(&e.protocol));
            c.port = Some(e.port as u16);
            c.suggestions = vec!["Edit the plan and pick another port (Portly can suggest a verified free one).".into()];
            out.push(c);
        }
    }

    // 10. Personal reservations occupied by unrelated processes.
    for r in inp.reservations {
        let pr = proto(&r.protocol);
        for u in snap.ports.iter().filter(|u| u.protocol == pr && (u.port as i64) >= r.port_start && (u.port as i64) <= r.port_end) {
            // Occupied by a project that owns the reservation is fine.
            let owned = r.project_id.is_some_and(|pid| by_port.get(&(pr, u.port)).is_some_and(|v| v.iter().any(|(p, _)| p.id == pid)));
            if owned {
                continue;
            }
            let mut c = conflict(
                format!("reservation:{}:{}", r.id, u.port),
                "reservation_occupied",
                Severity::Info,
                format!("Reserved port {} is in use", u.port),
                format!(
                    "You reserved {} for \"{}\" in Portly, and {} is using it. Portly reservations are personal notes; they don't stop other programs from binding.",
                    if r.port_start == r.port_end { format!("port {}", r.port_start) } else { format!("{}–{}", r.port_start, r.port_end) },
                    r.label,
                    u.pids.iter().map(|p| pname(*p)).collect::<Vec<_>>().join(", ")
                ),
            );
            c.protocol = Some(pr);
            c.port = Some(u.port);
            c.pids = u.pids.clone();
            out.push(c);
        }
    }

    out.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.port.cmp(&b.port)).then(a.id.cmp(&b.id)));
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanIssue {
    pub index: usize,
    pub code: &'static str,
    pub severity: Severity,
    pub message: String,
}

/// Static validation of a plan's entries (no live state).
pub fn validate_plan_entries(entries: &[PlanEntry], excl: &ExclusionReport) -> Vec<PlanIssue> {
    let mut out = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        if let Some(j) = entries[..i].iter().position(|o| o.port == e.port && o.protocol == e.protocol) {
            out.push(PlanIssue {
                index: i,
                code: "duplicate",
                severity: Severity::Error,
                message: format!("port {} is assigned twice (\"{}\" and \"{}\")", e.port, entries[j].service, e.service),
            });
        }
        if (1..=65535).contains(&e.port) {
            if let Some(r) = excl.find(&e.protocol, e.port as u16) {
                out.push(PlanIssue {
                    index: i,
                    code: "os_excluded",
                    severity: Severity::Error,
                    message: format!("port {} is inside a Windows excluded range ({}–{})", e.port, r.start, r.end),
                });
            }
            if crate::net::classify::is_dynamic(e.port as u16) {
                out.push(PlanIssue {
                    index: i,
                    code: "dynamic",
                    severity: Severity::Warning,
                    message: format!(
                        "port {} is in the dynamic range (49152–65535) that Windows hands out to outgoing connections",
                        e.port
                    ),
                });
            }
            if e.port < 1024 {
                out.push(PlanIssue {
                    index: i,
                    code: "privileged",
                    severity: Severity::Info,
                    message: format!("port {} is a well-known system port; many conflict with system services", e.port),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::CheckResult;
    use crate::monitor::model::tests::{snapshot_of, sock};
    use crate::net::excluded::ExcludedRange;
    use crate::net::SocketState;

    fn pport(id: i64, project_id: i64, port: u16, host: &str, check: &str, expected: Option<&str>) -> ProjectPort {
        ProjectPort {
            id,
            project_id,
            port,
            protocol: "tcp".into(),
            role: String::new(),
            host: host.into(),
            check_kind: check.into(),
            http_path: "/".into(),
            expected_process: expected.map(Into::into),
        }
    }
    fn project(id: i64, name: &str, ports: Vec<ProjectPort>) -> Project {
        Project {
            id,
            name: name.into(),
            description: String::new(),
            directory: None,
            group_id: None,
            group_name: None,
            favorite: false,
            metadata: serde_json::json!({}),
            start_command: None,
            ports,
            profile_ids: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }
    fn excl() -> ExclusionReport {
        ExclusionReport {
            ranges: vec![ExcludedRange { protocol: "tcp", family: "ipv4", start: 50000, end: 50059, administered: false }],
            verified: true,
            error: None,
        }
    }
    fn run(
        snap: &Snapshot,
        projects: &[Project],
        plans: &[Plan],
        res: &[Reservation],
        health: &HashMap<i64, HealthState>,
        oc: &[OwnershipChange],
    ) -> Vec<Conflict> {
        detect(&Input { snapshot: snap, projects, plans, reservations: res, health, excluded: &excl(), ownership_changes: oc })
    }
    fn kinds(c: &[Conflict]) -> Vec<&'static str> {
        c.iter().map(|c| c.kind).collect()
    }

    #[test]
    fn shared_port_between_projects() {
        let snap = snapshot_of(vec![], &[]);
        let ps = vec![
            project(1, "A", vec![pport(1, 1, 3000, "localhost", "tcp", None)]),
            project(2, "B", vec![pport(2, 2, 3000, "localhost", "tcp", None)]),
        ];
        let c = run(&snap, &ps, &[], &[], &HashMap::new(), &[]);
        assert_eq!(kinds(&c), vec!["shared_project_port"]);
        assert_eq!(c[0].project_ids, vec![1, 2]);
    }

    #[test]
    fn unexpected_occupant_respects_expected_process() {
        let snap = snapshot_of(vec![sock(Protocol::Tcp, "127.0.0.1", 3000, SocketState::Listen, 9)], &[(9, "python.exe")]);
        let ps = vec![project(1, "Web", vec![pport(1, 1, 3000, "localhost", "tcp", Some("node"))])];
        let c = run(&snap, &ps, &[], &[], &HashMap::new(), &[]);
        assert_eq!(kinds(&c), vec!["unexpected_occupant"]);
        assert_eq!(c[0].pids, vec![9]);
        let ps = vec![project(1, "Web", vec![pport(1, 1, 3000, "localhost", "tcp", Some("PYTHON.exe"))])];
        assert!(run(&snap, &ps, &[], &[], &HashMap::new(), &[]).is_empty(), "matching occupant is fine");
    }

    #[test]
    fn os_excluded_project_port_is_error() {
        let snap = snapshot_of(vec![], &[]);
        let ps = vec![project(1, "Api", vec![pport(1, 1, 50010, "localhost", "tcp", None)])];
        let c = run(&snap, &ps, &[], &[], &HashMap::new(), &[]);
        assert_eq!(c[0].kind, "os_excluded_port");
        assert_eq!(c[0].severity, Severity::Error);
    }

    #[test]
    fn health_transitions() {
        let snap = snapshot_of(vec![], &[]);
        let ps = vec![project(1, "Api", vec![pport(7, 1, 8000, "localhost", "tcp", None)])];
        let down = CheckResult {
            status: Status::Down,
            latency_ms: None,
            http_status: None,
            responded: vec![],
            failed: vec!["127.0.0.1".into()],
            error: Some("refused".into()),
            checked_at: 0,
        };
        let mut h = HashMap::new();
        h.insert(7, HealthState { last: Some(down.clone()), seen_up: false, down_since: Some(0), up_since: None });
        assert!(run(&snap, &ps, &[], &[], &h, &[]).is_empty(), "never-started server is not a conflict");
        h.insert(7, HealthState { last: Some(down), seen_up: true, down_since: Some(0), up_since: None });
        assert_eq!(kinds(&run(&snap, &ps, &[], &[], &h, &[])), vec!["server_not_responding"]);
    }

    #[test]
    fn http_down_while_occupied_is_unexpected_response() {
        let snap = snapshot_of(vec![sock(Protocol::Tcp, "127.0.0.1", 8000, SocketState::Listen, 3)], &[(3, "redis-server.exe")]);
        let ps = vec![project(1, "Api", vec![pport(7, 1, 8000, "localhost", "http", None)])];
        let down = CheckResult {
            status: Status::Down,
            latency_ms: None,
            http_status: None,
            responded: vec![],
            failed: vec![],
            error: Some("response was not HTTP".into()),
            checked_at: 0,
        };
        let h: HashMap<_, _> = [(7, HealthState { last: Some(down), ..Default::default() })].into_iter().collect();
        assert_eq!(kinds(&run(&snap, &ps, &[], &[], &h, &[])), vec!["unexpected_response"]);
    }

    #[test]
    fn address_mismatch() {
        let snap = snapshot_of(vec![sock(Protocol::Tcp, "::1", 5173, SocketState::Listen, 3)], &[(3, "node.exe")]);
        let ps = vec![project(1, "Vite", vec![pport(7, 1, 5173, "127.0.0.1", "tcp", None)])];
        assert_eq!(kinds(&run(&snap, &ps, &[], &[], &HashMap::new(), &[])), vec!["unexpected_address"]);
        let ps = vec![project(1, "Vite", vec![pport(7, 1, 5173, "localhost", "tcp", None)])];
        assert!(run(&snap, &ps, &[], &[], &HashMap::new(), &[]).is_empty(), "localhost accepts ::1");
    }

    #[test]
    fn ownership_changes_only_for_registered_ports() {
        let snap = snapshot_of(vec![], &[]);
        let ps = vec![project(1, "Api", vec![pport(7, 1, 8000, "localhost", "tcp", None)])];
        let oc = vec![
            OwnershipChange { protocol: Protocol::Tcp, port: 8000, from: vec![(1, "a.exe".into())], to: vec![(2, "b.exe".into())], ts: 5 },
            OwnershipChange { protocol: Protocol::Tcp, port: 9999, from: vec![], to: vec![], ts: 5 },
        ];
        let c = run(&snap, &ps, &[], &[], &HashMap::new(), &oc);
        assert_eq!(kinds(&c), vec!["ownership_changed"]);
    }

    #[test]
    fn reservations_and_plans() {
        let snap = snapshot_of(vec![sock(Protocol::Tcp, "127.0.0.1", 4001, SocketState::Listen, 3)], &[(3, "x.exe")]);
        let res = vec![Reservation {
            id: 1,
            protocol: "tcp".into(),
            port_start: 4000,
            port_end: 4010,
            label: "Mine".into(),
            note: String::new(),
            project_id: None,
            created_at: 0,
        }];
        let e = |s: &str, p: i64| PlanEntry {
            id: 0,
            service: s.into(),
            kind: "api".into(),
            port: p,
            protocol: "tcp".into(),
            host: "localhost".into(),
            note: String::new(),
        };
        let plans = vec![Plan {
            id: 1,
            name: "P".into(),
            description: String::new(),
            project_id: None,
            profile_id: None,
            entries: vec![e("a", 3000), e("b", 3000), e("c", 50001)],
            created_at: 0,
            updated_at: 0,
        }];
        let c = run(&snap, &[], &plans, &res, &HashMap::new(), &[]);
        let k = kinds(&c);
        assert_eq!(k.iter().filter(|k| **k == "plan_collision").count(), 2);
        assert!(k.contains(&"reservation_occupied"));
        assert_eq!(c[0].severity, Severity::Error, "sorted by severity");
    }

    #[test]
    fn plan_validation_warnings() {
        let e = |p: i64| PlanEntry {
            id: 0,
            service: "s".into(),
            kind: "api".into(),
            port: p,
            protocol: "tcp".into(),
            host: "localhost".into(),
            note: String::new(),
        };
        let issues = validate_plan_entries(&[e(80), e(60000)], &excl());
        assert_eq!(issues.iter().map(|i| i.code).collect::<Vec<_>>(), vec!["privileged", "dynamic"]);
    }
}
