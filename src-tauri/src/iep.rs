//! Ivily Ecosystem Protocol (IEP) 0.1 — Portly provider.
//!
//! Same transport and envelope as the other Ivily apps (see `docs/IEP.md`):
//! `ivily-portly.exe --iep describe` prints one JSON descriptor;
//! `ivily-portly.exe --iep request` reads one request (≤ 64 KB) from stdin and
//! prints one response. No window opens, no single-instance lock is taken,
//! nothing listens in the background, and the database is opened read-only
//! (`query_only`, no migrations). All methods are read-only summaries:
//! no executable paths, command lines, directories or notes are shared.

use crate::db::SCHEMA_VERSION;
use crate::monitor::model::{self, Snapshot};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub const PROTOCOL: &str = "iep";
pub const PROTOCOL_VERSION: &str = "0.1.0";
pub const MIN_COMPATIBLE: &str = "0.1.0";
pub const APP_ID: &str = "com.efecrtgl.ivilyportly";
pub const PRODUCT: &str = "ivily-portly";
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const METHODS: &[&str] = &["describe", "health", "capabilities", "ports.summary", "projects.summary"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: &'static str,
    pub version: &'static str,
    pub access: &'static str,
    pub status: &'static str,
    pub description: &'static str,
}

pub fn capabilities(enabled: bool) -> Vec<Capability> {
    let gated = if enabled { "available" } else { "disabled" };
    vec![
        Capability { id: "app.identity", version: "1", access: "read", status: "available", description: "Application identity, version and protocol version." },
        Capability { id: "app.capabilities", version: "1", access: "read", status: "available", description: "Supported capabilities." },
        Capability { id: "app.health", version: "1", access: "read", status: "available", description: "Data folder and database state." },
        Capability { id: "update.metadata", version: "1", access: "read", status: gated, description: "Result of the last update check. No network request is made." },
        Capability { id: "ports.summary", version: "1", access: "read", status: gated, description: "Counts of listening ports, development servers and exposed listeners, plus the user's registered ports and whether they are occupied. No process paths." },
        Capability { id: "projects.summary", version: "1", access: "read", status: gated, description: "Registered project names with their configured ports and occupancy. No directories, commands or notes." },
        Capability { id: "activity.summary", version: "1", access: "read", status: gated, description: "Event counts by kind for the last 7 days." },
        Capability { id: "integration.status", version: "1", access: "read", status: "available", description: "Whether IEP summaries are enabled by the user." },
        Capability { id: "operation.request", version: "1", access: "user-approved", status: "planned", description: "Center suggests an action; Portly shows it and acts only with user approval." },
    ]
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: &'static str,
    pub data_dir_exists: bool,
    /// `missing`, `ok`, `needs-migration`, `newer-schema`, `unreadable`
    pub database: &'static str,
    pub schema_version: Option<i64>,
    pub expected_schema_version: i64,
}

struct Ctx {
    conn: Option<rusqlite::Connection>,
    health: Health,
    enabled: bool,
    settings: Option<crate::settings::Settings>,
}

fn open(data_dir: &Path) -> Ctx {
    let mut h = Health {
        status: "ok",
        data_dir_exists: data_dir.is_dir(),
        database: "missing",
        schema_version: None,
        expected_schema_version: SCHEMA_VERSION,
    };
    let path = data_dir.join("portly.db");
    let mut ctx = Ctx { conn: None, health: Health::default(), enabled: true, settings: None };
    if path.exists() {
        match rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(c) => {
                let _ = c.pragma_update(None, "query_only", "ON");
                let v: Option<i64> = c.pragma_query_value(None, "user_version", |r| r.get(0)).ok();
                h.schema_version = v;
                h.database = match v {
                    None => "unreadable",
                    Some(v) if v > SCHEMA_VERSION => "newer-schema",
                    Some(v) if v < SCHEMA_VERSION => "needs-migration",
                    Some(_) => "ok",
                };
                if h.database == "ok" {
                    let raw: Option<String> = c.query_row("SELECT value FROM settings WHERE key='app'", [], |r| r.get(0)).ok();
                    let s: crate::settings::Settings = raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
                    ctx.enabled = s.ecosystem.iep_enabled;
                    ctx.settings = Some(s);
                    ctx.conn = Some(c);
                }
            }
            Err(_) => h.database = "unreadable",
        }
    }
    if matches!(h.database, "newer-schema" | "unreadable") {
        h.status = "degraded";
    }
    ctx.health = h;
    ctx
}

fn identity() -> serde_json::Value {
    serde_json::json!({
        "id": APP_ID, "product": PRODUCT, "name": crate::APP_NAME, "version": crate::APP_VERSION,
        "platform": "windows", "repository": "https://github.com/efecrtgl/ivily-portly"
    })
}

/// Live one-shot scan (no process paths are emitted).
fn live_snapshot() -> Option<Snapshot> {
    let sockets = crate::net::read_sockets().ok()?;
    let procs = crate::process::snapshot().unwrap_or_default();
    let wd = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let mut details = HashMap::new();
    for pid in sockets.iter().map(|s| s.pid).filter(|p| *p > 4) {
        details.entry(pid).or_insert_with(|| crate::process::details(pid, false));
    }
    Some(model::build(model::BuildInput {
        sockets,
        procs: &procs,
        details: &details,
        cpu: &HashMap::new(),
        windows_dir: &wd,
        include_udp: true,
        ts: crate::db::now_ms(),
        seq: 0,
    }))
}

fn registered(conn: &rusqlite::Connection) -> Vec<(String, u16, String, String)> {
    conn.prepare("SELECT p.name, pp.port, pp.protocol, pp.role FROM project_ports pp JOIN projects p ON p.id = pp.project_id ORDER BY p.name, pp.port")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u16, r.get(2)?, r.get(3)?)))?.collect())
        .unwrap_or_default()
}

fn ports_summary(ctx: &Ctx, snap: Option<&Snapshot>) -> serde_json::Value {
    let Some(snap) = snap else { return serde_json::json!({ "available": false, "reason": "socket tables could not be read" }) };
    let occupied = |port: u16, proto: &str| snap.ports.iter().any(|u| u.port == port && u.protocol.as_str() == proto);
    let reg = ctx.conn.as_ref().map(registered).unwrap_or_default();
    serde_json::json!({
        "available": true,
        "tcpListening": snap.stats.tcp_listeners,
        "udpBound": snap.stats.udp_bound,
        "established": snap.stats.established,
        "devServers": snap.stats.dev_servers,
        "exposedListeners": snap.stats.exposed,
        "registeredPorts": reg.iter().map(|(_, port, proto, role)| serde_json::json!({ "port": port, "protocol": proto, "role": role, "occupied": occupied(*port, proto) })).collect::<Vec<_>>(),
    })
}

fn projects_summary(ctx: &Ctx, snap: Option<&Snapshot>) -> serde_json::Value {
    let reg = ctx.conn.as_ref().map(registered).unwrap_or_default();
    let mut by: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
    for (name, port, proto, role) in reg {
        let occ = snap.map(|s| s.ports.iter().any(|u| u.port == port && u.protocol.as_str() == proto));
        by.entry(name).or_default().push(serde_json::json!({ "port": port, "protocol": proto, "role": role, "occupied": occ }));
    }
    serde_json::json!({ "projects": by.into_iter().map(|(name, ports)| serde_json::json!({ "name": name, "ports": ports })).collect::<Vec<_>>() })
}

fn activity(ctx: &Ctx) -> serde_json::Value {
    let Some(c) = &ctx.conn else { return serde_json::Value::Null };
    let since = crate::db::now_ms() - 7 * 86_400_000;
    let by: BTreeMap<String, i64> = c
        .prepare("SELECT kind, COUNT(*) FROM events WHERE ts >= ?1 GROUP BY kind")
        .and_then(|mut st| st.query_map([since], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .unwrap_or_default();
    serde_json::json!({ "windowDays": 7, "total": by.values().sum::<i64>(), "byKind": by })
}

fn update(ctx: &Ctx) -> serde_json::Value {
    let Some(s) = &ctx.settings else { return serde_json::Value::Null };
    let latest = s.updates.latest_version.clone();
    serde_json::json!({
        "currentVersion": crate::APP_VERSION,
        "latestVersion": latest,
        "updateAvailable": latest.as_deref().is_some_and(|l| version_gt(l, crate::APP_VERSION)),
        "checkedAt": s.updates.last_checked_at,
    })
}

pub fn describe(data_dir: &Path) -> serde_json::Value {
    let ctx = open(data_dir);
    let snap = if ctx.enabled { live_snapshot() } else { None };
    let gate = |v: serde_json::Value| if ctx.enabled { v } else { serde_json::Value::Null };
    serde_json::json!({
        "protocol": { "name": PROTOCOL, "version": PROTOCOL_VERSION, "minCompatible": MIN_COMPATIBLE },
        "app": identity(),
        "transport": { "kind": "cli", "describe": ["--iep", "describe"], "request": ["--iep", "request"], "backgroundService": false },
        "capabilities": capabilities(ctx.enabled),
        "integration": { "enabled": ctx.enabled },
        "health": ctx.health,
        "update": gate(update(&ctx)),
        "ports": gate(ports_summary(&ctx, snap.as_ref())),
        "activity": gate(activity(&ctx)),
        "generatedAt": crate::db::now_ms() / 1000,
    })
}

// --------------------------------------------------------------- requests

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: String,
    version: String,
    id: String,
    method: String,
    #[serde(default)]
    params: Option<serde_json::Value>,
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.');
    let v = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
    it.next().is_none().then_some(v)
}

pub fn version_gt(a: &str, b: &str) -> bool {
    match (parse_semver(a.trim_start_matches('v')), parse_semver(b.trim_start_matches('v'))) {
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

/// Same major; while 0.x the minor must match too; client ≥ minCompatible.
pub fn compatible(client: &str) -> bool {
    let (Some(c), Some(s), Some(min)) = (parse_semver(client), parse_semver(PROTOCOL_VERSION), parse_semver(MIN_COMPATIBLE)) else {
        return false;
    };
    c.0 == s.0 && (s.0 > 0 || c.1 == s.1) && c >= min
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn error(id: Option<&str>, code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "protocol": PROTOCOL, "version": PROTOCOL_VERSION, "id": id, "ok": false, "error": { "code": code, "message": message } })
}

pub fn handle(raw: &[u8], data_dir: &Path) -> (serde_json::Value, bool) {
    if raw.len() > MAX_REQUEST_BYTES {
        return (error(None, "too_large", "request exceeds 64 KB"), false);
    }
    let req: Request = match serde_json::from_slice(raw) {
        Ok(r) => r,
        Err(e) => return (error(None, "invalid_request", &format!("invalid request: {e}")), false),
    };
    if req.protocol != PROTOCOL {
        return (error(None, "unsupported_protocol", "protocol must be \"iep\""), false);
    }
    if !valid_id(&req.id) {
        return (error(None, "invalid_id", "id must be 1–64 characters of letters, digits, '-', '_' or '.'"), false);
    }
    let id = Some(req.id.as_str());
    if !compatible(&req.version) {
        return (error(id, "incompatible_version", &format!("client speaks IEP {}, server speaks {PROTOCOL_VERSION}", req.version)), false);
    }
    if !METHODS.contains(&req.method.as_str()) {
        return (error(id, "unknown_method", &format!("unknown method; supported: {}", METHODS.join(", "))), false);
    }
    match &req.params {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(o)) if o.is_empty() => {}
        _ => return (error(id, "invalid_params", "IEP 0.1 methods take no parameters"), false),
    }
    let ctx = open(data_dir);
    let gated = matches!(req.method.as_str(), "ports.summary" | "projects.summary");
    if gated && !ctx.enabled {
        return (error(id, "disabled", "the user has disabled IEP summaries in Portly's settings"), false);
    }
    let result = match req.method.as_str() {
        "describe" => {
            drop(ctx);
            describe(data_dir)
        }
        "health" => serde_json::to_value(&ctx.health).unwrap_or_default(),
        "capabilities" => serde_json::json!({ "capabilities": capabilities(ctx.enabled) }),
        "ports.summary" => ports_summary(&ctx, live_snapshot().as_ref()),
        "projects.summary" => projects_summary(&ctx, live_snapshot().as_ref()),
        _ => unreachable!(),
    };
    (serde_json::json!({ "protocol": PROTOCOL, "version": PROTOCOL_VERSION, "id": req.id, "ok": true, "result": result }), true)
}

/// Entry point for `--iep …`. Returns the process exit code, or `None` if
/// the arguments are not an IEP invocation.
pub fn maybe_run_from_args(data_dir: &Path) -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--iep") {
        return None;
    }
    use std::io::{Read, Write};
    let mut out = std::io::stdout();
    let (value, code) = match args.get(1).map(String::as_str) {
        Some("describe") if args.len() == 2 => (describe(data_dir), 0),
        Some("request") if args.len() == 2 => {
            let mut buf = Vec::new();
            let _ = std::io::stdin().take(MAX_REQUEST_BYTES as u64 + 1).read_to_end(&mut buf);
            let (v, ok) = handle(&buf, data_dir);
            (v, if ok { 0 } else { 1 })
        }
        _ => (error(None, "usage", "usage: --iep describe | --iep request (JSON on stdin)"), 2),
    };
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str) -> Vec<u8> {
        format!(r#"{{"protocol":"iep","version":"0.1.0","id":"t-1","method":"{method}","params":{{}}}}"#).into_bytes()
    }

    #[test]
    fn versioning() {
        assert!(compatible("0.1.0") && compatible("0.1.7"));
        assert!(!compatible("0.2.0") && !compatible("1.0.0") && !compatible("x"));
        assert!(version_gt("0.2.0", "0.1.9") && !version_gt("0.1.0", "0.1.0") && version_gt("v1.0.0", "0.9.9"));
    }

    #[test]
    fn validation_errors() {
        let d = tempfile::tempdir().unwrap();
        let code = |raw: &[u8]| handle(raw, d.path()).0["error"]["code"].as_str().unwrap_or("").to_string();
        assert_eq!(code(&vec![b' '; MAX_REQUEST_BYTES + 1]), "too_large");
        assert_eq!(code(b"nope"), "invalid_request");
        assert_eq!(code(br#"{"protocol":"iep","version":"0.1.0","id":"a","method":"health","extra":1}"#), "invalid_request");
        assert_eq!(code(br#"{"protocol":"x","version":"0.1.0","id":"a","method":"health"}"#), "unsupported_protocol");
        assert_eq!(code(br#"{"protocol":"iep","version":"0.1.0","id":"bad id!","method":"health"}"#), "invalid_id");
        assert_eq!(code(br#"{"protocol":"iep","version":"0.2.0","id":"a","method":"health"}"#), "incompatible_version");
        assert_eq!(code(br#"{"protocol":"iep","version":"0.1.0","id":"a","method":"process.kill"}"#), "unknown_method");
        assert_eq!(code(br#"{"protocol":"iep","version":"0.1.0","id":"a","method":"health","params":{"x":1}}"#), "invalid_params");
    }

    #[test]
    fn health_without_database() {
        let d = tempfile::tempdir().unwrap();
        let (v, ok) = handle(&req("health"), d.path());
        assert!(ok);
        assert_eq!(v["result"]["database"], "missing");
        assert_eq!(v["id"], "t-1");
    }

    #[test]
    fn summaries_respect_opt_out_and_hide_private_fields() {
        let d = tempfile::tempdir().unwrap();
        {
            let db = crate::db::Db::open(d.path()).unwrap();
            crate::store::projects::create(
                &db,
                &crate::store::projects::ProjectInput {
                    name: "Secret Dir Project".into(),
                    description: "private".into(),
                    directory: Some(d.path().to_string_lossy().into_owned()),
                    group_id: None,
                    favorite: false,
                    metadata: serde_json::Value::Null,
                    start_command: Some("npm start".into()),
                    ports: vec![crate::store::projects::ProjectPortInput {
                        port: 3999,
                        protocol: "tcp".into(),
                        role: "web".into(),
                        host: "localhost".into(),
                        check_kind: "tcp".into(),
                        http_path: "/".into(),
                        expected_process: None,
                    }],
                },
            )
            .unwrap();
        }
        let (v, ok) = handle(&req("projects.summary"), d.path());
        assert!(ok, "{v}");
        let s = v.to_string();
        assert!(s.contains("Secret Dir Project") && s.contains("3999"));
        assert!(!s.contains("npm start") && !s.contains("private") && !s.contains(&*d.path().to_string_lossy().replace('\\', "\\\\")));
        let desc = describe(d.path());
        assert_eq!(desc["health"]["database"], "ok");
        assert_eq!(desc["transport"]["backgroundService"], false);
        // Opt out.
        {
            let db = crate::db::Db::open(d.path()).unwrap();
            let mut s = crate::settings::Settings::default();
            s.ecosystem.iep_enabled = false;
            s.save(&db).unwrap();
        }
        let (v, ok) = handle(&req("ports.summary"), d.path());
        assert!(!ok);
        assert_eq!(v["error"]["code"], "disabled");
        assert!(describe(d.path())["ports"].is_null());
    }

    #[test]
    fn iep_never_modifies_the_database() {
        let d = tempfile::tempdir().unwrap();
        {
            let mut c = rusqlite::Connection::open(d.path().join("portly.db")).unwrap();
            crate::db::schema_for_tests(&mut c);
            c.pragma_update(None, "user_version", 0i64).unwrap();
        }
        let before = std::fs::read(d.path().join("portly.db")).unwrap();
        let _ = describe(d.path());
        let after = std::fs::read(d.path().join("portly.db")).unwrap();
        assert_eq!(before, after);
    }
}
