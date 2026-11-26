//! Configuration import/export.
//!
//! Format `ivily-portly-export` v1: a JSON document with groups, projects,
//! profiles, port notes, reservations, ranges, plans and (optionally)
//! settings. References between records use **names**, not database ids, so
//! exports are portable between machines. Every imported record passes
//! through the same validators as the UI.

use crate::db::{now_ms, Db};
use crate::error::{invalid, AppError, AppResult};
use crate::settings::Settings;
use crate::store::{plans, ports, profiles, projects};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub const FORMAT: &str = "ivily-portly-export";
pub const VERSION: u32 = 1;
pub const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExPort {
    pub port: i64,
    #[serde(default = "tcp")]
    pub protocol: String,
    #[serde(default)]
    pub role: String,
    #[serde(default = "localhost")]
    pub host: String,
    #[serde(default = "tcpcheck")]
    pub check_kind: String,
    #[serde(default = "slash")]
    pub http_path: String,
    #[serde(default)]
    pub expected_process: Option<String>,
}
fn tcp() -> String {
    "tcp".into()
}
fn tcpcheck() -> String {
    "tcp".into()
}
fn localhost() -> String {
    "localhost".into()
}
fn slash() -> String {
    "/".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExProject {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub start_command: Option<String>,
    #[serde(default)]
    pub ports: Vec<ExPort>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExProfile {
    pub name: String,
    #[serde(default = "custom")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub startup: serde_json::Value,
    #[serde(default = "yes")]
    pub monitor_health: bool,
    #[serde(default)]
    pub projects: Vec<String>,
}
fn custom() -> String {
    "custom".into()
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExReservation {
    #[serde(default = "tcp")]
    pub protocol: String,
    pub port_start: i64,
    pub port_end: i64,
    pub label: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExPlan {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub entries: Vec<plans::PlanEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDoc {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub exported_at: i64,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub projects: Vec<ExProject>,
    #[serde(default)]
    pub profiles: Vec<ExProfile>,
    #[serde(default)]
    pub port_notes: Vec<ports::PortNote>,
    #[serde(default)]
    pub reservations: Vec<ExReservation>,
    #[serde(default)]
    pub ranges: Vec<ports::PortRange>,
    #[serde(default)]
    pub plans: Vec<ExPlan>,
    #[serde(default)]
    pub settings: Option<Settings>,
}

pub fn export(db: &Db, include_settings: bool) -> AppResult<ExportDoc> {
    let projects = projects::list(db)?;
    let pname: HashMap<i64, String> = projects.iter().map(|p| (p.id, p.name.clone())).collect();
    let profiles = profiles::list(db)?;
    let prname: HashMap<i64, String> = profiles.iter().map(|p| (p.id, p.name.clone())).collect();
    Ok(ExportDoc {
        format: FORMAT.into(),
        version: VERSION,
        app_version: crate::APP_VERSION.into(),
        exported_at: now_ms(),
        groups: projects::groups(db)?.into_iter().map(|g| g.name).collect(),
        projects: projects
            .iter()
            .map(|p| ExProject {
                name: p.name.clone(),
                description: p.description.clone(),
                directory: p.directory.clone(),
                group: p.group_name.clone(),
                favorite: p.favorite,
                metadata: p.metadata.clone(),
                start_command: p.start_command.clone(),
                ports: p
                    .ports
                    .iter()
                    .map(|pp| ExPort {
                        port: pp.port as i64,
                        protocol: pp.protocol.clone(),
                        role: pp.role.clone(),
                        host: pp.host.clone(),
                        check_kind: pp.check_kind.clone(),
                        http_path: pp.http_path.clone(),
                        expected_process: pp.expected_process.clone(),
                    })
                    .collect(),
            })
            .collect(),
        profiles: profiles
            .iter()
            .map(|p| ExProfile {
                name: p.name.clone(),
                kind: p.kind.clone(),
                description: p.description.clone(),
                notes: p.notes.clone(),
                startup: p.startup.clone(),
                monitor_health: p.monitor_health,
                projects: p.project_ids.iter().filter_map(|id| pname.get(id).cloned()).collect(),
            })
            .collect(),
        port_notes: ports::notes(db)?,
        reservations: ports::reservations(db)?
            .into_iter()
            .map(|r| ExReservation {
                protocol: r.protocol,
                port_start: r.port_start,
                port_end: r.port_end,
                label: r.label,
                note: r.note,
                project: r.project_id.and_then(|id| pname.get(&id).cloned()),
            })
            .collect(),
        ranges: ports::ranges(db)?,
        plans: plans::list(db)?
            .into_iter()
            .map(|p| ExPlan {
                name: p.name,
                description: p.description,
                project: p.project_id.and_then(|id| pname.get(&id).cloned()),
                profile: p.profile_id.and_then(|id| prname.get(&id).cloned()),
                entries: p.entries,
            })
            .collect(),
        settings: include_settings.then(|| Settings::load(db)),
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: HashMap<String, u32>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
    pub backup: Option<String>,
}

impl ImportReport {
    fn ok(&mut self, kind: &str) {
        *self.imported.entry(kind.into()).or_default() += 1;
    }
}

/// Parses and checks the envelope of an export document.
pub fn parse(json: &str) -> AppResult<ExportDoc> {
    let doc: ExportDoc = serde_json::from_str(json).map_err(|e| AppError::Invalid(format!("not a valid Portly export: {e}")))?;
    if doc.format != FORMAT {
        return invalid("this file is not an Ivily Portly export");
    }
    if doc.version == 0 || doc.version > VERSION {
        return invalid(format!("export format version {} is not supported by this version of Portly (supports 1–{VERSION})", doc.version));
    }
    Ok(doc)
}

/// Imports a document. `replace` wipes existing configuration first (after
/// a safety backup); otherwise records whose names already exist are skipped.
pub fn import(db: &Db, doc: &ExportDoc, replace: bool, apply_settings: bool) -> AppResult<ImportReport> {
    let mut rep = ImportReport::default();
    if replace {
        if db.is_persistent() {
            let dir = db.backups_dir();
            std::fs::create_dir_all(&dir)?;
            let dest = dir.join(format!("portly-before-import-{}.db", now_ms()));
            db.backup_to(&dest)?;
            rep.backup = Some(dest.to_string_lossy().into_owned());
        }
        db.conn.lock().execute_batch(
            "BEGIN; DELETE FROM plans; DELETE FROM reservations; DELETE FROM port_ranges; DELETE FROM port_notes; DELETE FROM profiles; DELETE FROM projects; DELETE FROM groups; COMMIT;",
        )?;
    }

    let mut groups: HashMap<String, i64> = projects::groups(db)?.into_iter().map(|g| (g.name.to_lowercase(), g.id)).collect();
    for g in &doc.groups {
        if groups.contains_key(&g.to_lowercase()) {
            continue;
        }
        match projects::group_save(db, None, g) {
            Ok(id) => {
                groups.insert(g.to_lowercase(), id);
                rep.ok("groups");
            }
            Err(e) => rep.skipped.push(format!("group \"{g}\": {e}")),
        }
    }

    let mut project_ids: HashMap<String, i64> = projects::list(db)?.into_iter().map(|p| (p.name.to_lowercase(), p.id)).collect();
    for p in &doc.projects {
        if project_ids.contains_key(&p.name.to_lowercase()) {
            rep.skipped.push(format!("project \"{}\" already exists", p.name));
            continue;
        }
        let mut directory = p.directory.clone();
        if let Some(d) = &directory {
            if !Path::new(d).is_dir() {
                rep.warnings.push(format!("project \"{}\": directory {d} doesn't exist on this machine and was cleared", p.name));
                directory = None;
            }
        }
        let input = projects::ProjectInput {
            name: p.name.clone(),
            description: p.description.clone(),
            directory,
            group_id: p.group.as_ref().and_then(|g| groups.get(&g.to_lowercase()).copied()),
            favorite: p.favorite,
            metadata: p.metadata.clone(),
            start_command: p.start_command.clone(),
            ports: p
                .ports
                .iter()
                .map(|x| projects::ProjectPortInput {
                    port: x.port,
                    protocol: x.protocol.clone(),
                    role: x.role.clone(),
                    host: x.host.clone(),
                    check_kind: x.check_kind.clone(),
                    http_path: x.http_path.clone(),
                    expected_process: x.expected_process.clone(),
                })
                .collect(),
        };
        match projects::create(db, &input) {
            Ok(created) => {
                project_ids.insert(created.name.to_lowercase(), created.id);
                rep.ok("projects");
            }
            Err(e) => rep.skipped.push(format!("project \"{}\": {e}", p.name)),
        }
    }

    let mut profile_ids: HashMap<String, i64> = profiles::list(db)?.into_iter().map(|p| (p.name.to_lowercase(), p.id)).collect();
    for p in &doc.profiles {
        if profile_ids.contains_key(&p.name.to_lowercase()) {
            rep.skipped.push(format!("profile \"{}\" already exists", p.name));
            continue;
        }
        let input = profiles::ProfileInput {
            name: p.name.clone(),
            kind: p.kind.clone(),
            description: p.description.clone(),
            notes: p.notes.clone(),
            startup: p.startup.clone(),
            monitor_health: p.monitor_health,
            project_ids: p.projects.iter().filter_map(|n| project_ids.get(&n.to_lowercase()).copied()).collect(),
        };
        match profiles::save(db, None, &input) {
            Ok(created) => {
                profile_ids.insert(created.name.to_lowercase(), created.id);
                rep.ok("profiles");
            }
            Err(e) => rep.skipped.push(format!("profile \"{}\": {e}", p.name)),
        }
    }

    let existing_notes: Vec<(String, u16)> = ports::notes(db)?.into_iter().map(|n| (n.protocol, n.port)).collect();
    for n in &doc.port_notes {
        if existing_notes.contains(&(n.protocol.clone(), n.port)) {
            rep.skipped.push(format!("note for port {}/{} already exists", n.port, n.protocol));
            continue;
        }
        match ports::note_save(db, n) {
            Ok(_) => rep.ok("portNotes"),
            Err(e) => rep.skipped.push(format!("note for port {}: {e}", n.port)),
        }
    }

    for r in &doc.reservations {
        let res = ports::Reservation {
            id: 0,
            protocol: r.protocol.clone(),
            port_start: r.port_start,
            port_end: r.port_end,
            label: r.label.clone(),
            note: r.note.clone(),
            project_id: r.project.as_ref().and_then(|n| project_ids.get(&n.to_lowercase()).copied()),
            created_at: 0,
        };
        match ports::reservation_save(db, &res) {
            Ok(_) => rep.ok("reservations"),
            Err(e) => rep.skipped.push(format!("reservation \"{}\": {e}", r.label)),
        }
    }

    for r in &doc.ranges {
        match ports::range_save(db, &ports::PortRange { id: 0, ..r.clone() }) {
            Ok(_) => rep.ok("ranges"),
            Err(e) => rep.skipped.push(format!("range \"{}\": {e}", r.name)),
        }
    }

    let existing_plans: Vec<String> = plans::list(db)?.into_iter().map(|p| p.name.to_lowercase()).collect();
    for p in &doc.plans {
        if existing_plans.contains(&p.name.to_lowercase()) {
            rep.skipped.push(format!("plan \"{}\" already exists", p.name));
            continue;
        }
        let input = plans::PlanInput {
            name: p.name.clone(),
            description: p.description.clone(),
            project_id: p.project.as_ref().and_then(|n| project_ids.get(&n.to_lowercase()).copied()),
            profile_id: p.profile.as_ref().and_then(|n| profile_ids.get(&n.to_lowercase()).copied()),
            entries: p.entries.clone(),
        };
        match plans::save(db, None, &input) {
            Ok(_) => rep.ok("plans"),
            Err(e) => rep.skipped.push(format!("plan \"{}\": {e}", p.name)),
        }
    }

    if apply_settings {
        if let Some(s) = &doc.settings {
            s.save(db)?;
            rep.ok("settings");
        }
    }
    Ok(rep)
}

// -------------------------------------------------------- plan rendering

fn csv_field(s: &str) -> String {
    // Neutralize spreadsheet formula injection and quote as needed.
    let mut v = s.to_string();
    if v.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        v.insert(0, '\'');
    }
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

pub fn plan_csv(p: &plans::Plan) -> String {
    let mut out = String::from("service,type,host,port,protocol,note\r\n");
    for e in &p.entries {
        out.push_str(&format!("{},{},{},{},{},{}\r\n", csv_field(&e.service), e.kind, e.host, e.port, e.protocol, csv_field(&e.note)));
    }
    out
}

pub fn plan_markdown(p: &plans::Plan) -> String {
    let esc = |s: &str| s.replace('|', "\\|").replace('\n', " ");
    let mut out = format!("# {}\n\n", esc(&p.name));
    if !p.description.is_empty() {
        out.push_str(&format!("{}\n\n", p.description));
    }
    out.push_str("| Service | Type | Address | Protocol | Note |\n|---|---|---|---|---|\n");
    for e in &p.entries {
        let host = if e.host.contains(':') { format!("[{}]", e.host) } else { e.host.clone() };
        out.push_str(&format!("| {} | {} | {}:{} | {} | {} |\n", esc(&e.service), e.kind, host, e.port, e.protocol, esc(&e.note)));
    }
    out
}

/// Validates a user-chosen file path for reading an import.
pub fn check_import_path(path: &str) -> AppResult<std::path::PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() || !p.is_file() {
        return invalid("choose an existing file");
    }
    let len = std::fs::metadata(p)?.len();
    if len > MAX_IMPORT_BYTES {
        return invalid("file is larger than 10 MB");
    }
    Ok(p.to_path_buf())
}

/// Validates a user-chosen destination and its extension.
pub fn check_export_path(path: &str, allowed: &[&str]) -> AppResult<std::path::PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return invalid("destination must be an absolute path");
    }
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if !allowed.contains(&ext.as_str()) {
        return invalid(format!("file must have one of these extensions: {}", allowed.join(", ")));
    }
    if !p.parent().is_some_and(|d| d.is_dir()) {
        return invalid("destination folder does not exist");
    }
    Ok(p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(db: &Db) {
        let g = projects::group_save(db, None, "Work").unwrap();
        let p = projects::create(
            db,
            &projects::ProjectInput {
                name: "Shop".into(),
                description: "d".into(),
                directory: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                group_id: Some(g),
                favorite: true,
                metadata: serde_json::json!({"team": "a"}),
                start_command: Some("npm run dev".into()),
                ports: vec![projects::ProjectPortInput {
                    port: 3000,
                    protocol: "tcp".into(),
                    role: "web".into(),
                    host: "localhost".into(),
                    check_kind: "http".into(),
                    http_path: "/".into(),
                    expected_process: Some("node.exe".into()),
                }],
            },
        )
        .unwrap();
        profiles::save(
            db,
            None,
            &profiles::ProfileInput {
                name: "Web".into(),
                kind: "web".into(),
                description: String::new(),
                notes: String::new(),
                startup: serde_json::Value::Null,
                monitor_health: true,
                project_ids: vec![p.id],
            },
        )
        .unwrap();
        ports::note_save(
            db,
            &ports::PortNote {
                protocol: "tcp".into(),
                port: 5432,
                label: "PG".into(),
                note: String::new(),
                category: "db".into(),
                favorite: true,
                updated_at: 0,
            },
        )
        .unwrap();
        ports::reservation_save(
            db,
            &ports::Reservation {
                id: 0,
                protocol: "tcp".into(),
                port_start: 3000,
                port_end: 3009,
                label: "Front".into(),
                note: String::new(),
                project_id: Some(p.id),
                created_at: 0,
            },
        )
        .unwrap();
        ports::range_save(
            db,
            &ports::PortRange { id: 0, name: "APIs".into(), port_start: 8000, port_end: 8099, purpose: String::new(), created_at: 0 },
        )
        .unwrap();
        plans::save(
            db,
            None,
            &plans::PlanInput {
                name: "Shop map".into(),
                description: String::new(),
                project_id: Some(p.id),
                profile_id: None,
                entries: vec![plans::PlanEntry {
                    id: 0,
                    service: "Web".into(),
                    kind: "website".into(),
                    port: 3000,
                    protocol: "tcp".into(),
                    host: "localhost".into(),
                    note: String::new(),
                }],
            },
        )
        .unwrap();
    }

    #[test]
    fn round_trip_into_empty_database() {
        let a = Db::open_memory();
        seed(&a);
        let doc = export(&a, true).unwrap();
        let json = serde_json::to_string(&doc).unwrap();
        let b = Db::open_memory();
        let rep = import(&b, &parse(&json).unwrap(), false, true).unwrap();
        assert!(rep.skipped.is_empty(), "{:?}", rep.skipped);
        for k in ["groups", "projects", "profiles", "portNotes", "reservations", "ranges", "plans", "settings"] {
            assert_eq!(rep.imported.get(k), Some(&1), "{k}");
        }
        let p = &projects::list(&b).unwrap()[0];
        assert_eq!(p.group_name.as_deref(), Some("Work"));
        assert_eq!(p.ports[0].expected_process.as_deref(), Some("node.exe"));
        assert_eq!(profiles::list(&b).unwrap()[0].project_ids, vec![p.id]);
        assert_eq!(ports::reservations(&b).unwrap()[0].project_id, Some(p.id));
        assert_eq!(plans::list(&b).unwrap()[0].project_id, Some(p.id));
    }

    #[test]
    fn merge_skips_existing_and_replace_wipes() {
        let db = Db::open_memory();
        seed(&db);
        let doc = export(&db, false).unwrap();
        let rep = import(&db, &doc, false, false).unwrap();
        assert!(rep.skipped.iter().any(|s| s.contains("project \"Shop\" already exists")));
        assert_eq!(projects::list(&db).unwrap().len(), 1);
        let rep = import(&db, &doc, true, false).unwrap();
        assert_eq!(rep.imported.get("projects"), Some(&1));
        assert_eq!(projects::list(&db).unwrap().len(), 1);
        assert_eq!(ports::reservations(&db).unwrap().len(), 1, "replace did not duplicate");
    }

    #[test]
    fn rejects_foreign_and_future_documents_and_cleans_bad_records() {
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"format":"other","version":1}"#).is_err());
        assert!(parse(r#"{"format":"ivily-portly-export","version":99}"#).is_err());
        let doc = parse(r#"{"format":"ivily-portly-export","version":1,
            "projects":[{"name":"Far","directory":"Z:\\nope\\never","ports":[{"port":99999}]},{"name":"Ok","directory":"Z:\\nope\\never"}]}"#).unwrap();
        let db = Db::open_memory();
        let rep = import(&db, &doc, false, false).unwrap();
        assert_eq!(rep.imported.get("projects"), Some(&1));
        assert!(rep.skipped.iter().any(|s| s.contains("Far")));
        assert!(rep.warnings.iter().any(|w| w.contains("doesn't exist")));
    }

    #[test]
    fn plan_renderers_escape() {
        let p = plans::Plan {
            id: 1,
            name: "A|B".into(),
            description: String::new(),
            project_id: None,
            profile_id: None,
            created_at: 0,
            updated_at: 0,
            entries: vec![plans::PlanEntry {
                id: 0,
                service: "=cmd()".into(),
                kind: "api".into(),
                port: 80,
                protocol: "tcp".into(),
                host: "::1".into(),
                note: "a,b".into(),
            }],
        };
        let csv = plan_csv(&p);
        assert!(csv.contains("'=cmd()"), "formula neutralized");
        assert!(csv.contains("\"a,b\""));
        let md = plan_markdown(&p);
        assert!(md.contains("# A\\|B"));
        assert!(md.contains("[::1]:80"));
    }

    #[test]
    fn path_checks() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("x.json");
        std::fs::write(&f, "{}").unwrap();
        assert!(check_import_path(f.to_str().unwrap()).is_ok());
        assert!(check_import_path("relative.json").is_err());
        assert!(check_export_path(d.path().join("o.json").to_str().unwrap(), &["json"]).is_ok());
        assert!(check_export_path(d.path().join("o.exe").to_str().unwrap(), &["json"]).is_err());
        assert!(check_export_path("Z:\\missing\\dir\\o.json", &["json"]).is_err());
    }
}
