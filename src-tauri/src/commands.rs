//! IPC commands. Every argument is validated here or in the store layer;
//! nothing the UI sends is trusted. Commands that touch the OS (bind tests,
//! netsh, process inspection, file IO) are `async` so they never block the
//! UI thread.

use crate::conflicts::{self, Conflict, HealthState};
use crate::error::{invalid, AppError, AppResult};
use crate::exchange;
use crate::monitor::model::Snapshot;
use crate::net::excluded::ExclusionReport;
use crate::net::Protocol;
use crate::planner::{self, Availability, Claim};
use crate::process::{self, protect};
use crate::settings::Settings;
use crate::state::AppState;
use crate::store::events::{self, kind, EventFilter, EventPage, NewEvent};
use crate::store::{plans, ports, profiles, projects};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;
use tauri::State;

type S<'a> = State<'a, AppState>;

fn proto(p: &str) -> AppResult<Protocol> {
    Protocol::parse(p).ok_or_else(|| AppError::Invalid("protocol must be tcp or udp".into()))
}

fn config_event(st: &AppState, msg: String) {
    if st.monitor.settings.read().history.enabled && st.db.is_persistent() {
        let _ =
            events::insert(&st.db, &NewEvent { kind: kind::CONFIG.into(), severity: "info".into(), message: msg, ..Default::default() });
    }
}

fn changed(st: &AppState, msg: String) {
    config_event(st, msg);
    st.monitor.mark_config_dirty();
}

// ------------------------------------------------------------------- app

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    data_dir: String,
    db: crate::db::DbStatus,
    current_user: Option<String>,
    windows_dir: String,
    monitor_error: Option<String>,
    iep_version: &'static str,
}

#[tauri::command]
pub async fn app_info(state: S<'_>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: crate::APP_NAME,
        version: crate::APP_VERSION,
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        db: state.db.status(),
        current_user: process::current_user(),
        windows_dir: state.monitor.windows_dir.clone(),
        monitor_error: state.monitor.last_error(),
        iep_version: crate::iep::PROTOCOL_VERSION,
    })
}

#[tauri::command]
pub async fn db_backup(state: S<'_>, path: Option<String>) -> AppResult<String> {
    let dest = match path {
        Some(p) => exchange::check_export_path(&p, &["db"])?,
        None => {
            let dir = state.db.backups_dir();
            std::fs::create_dir_all(&dir)?;
            dir.join(format!("portly-manual-{}.db", crate::db::now_ms()))
        }
    };
    state.db.backup_to(&dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn db_backups(state: S<'_>) -> AppResult<Vec<crate::db::BackupFile>> {
    Ok(state.db.list_backups())
}

#[tauri::command]
pub async fn db_restore(state: S<'_>, path: String) -> AppResult<String> {
    let p = exchange::check_import_path(&path)?;
    let safety = state.db.restore_from(&p)?;
    let s = Settings::load(&state.db);
    state.monitor.set_settings(s);
    changed(&state, "Database restored from a backup".into());
    Ok(safety)
}

#[tauri::command]
pub async fn open_data_dir(state: S<'_>) -> AppResult<()> {
    std::fs::create_dir_all(&state.data_dir)?;
    open_in_explorer(&state.data_dir.to_string_lossy(), false)
}

// --------------------------------------------------------------- monitor

#[tauri::command]
pub fn monitor_snapshot(state: S<'_>) -> Arc<Snapshot> {
    state.monitor.latest()
}

#[tauri::command]
pub fn monitor_conflicts(state: S<'_>) -> Vec<Conflict> {
    state.monitor.conflicts()
}

#[tauri::command]
pub fn monitor_health(state: S<'_>) -> HashMap<i64, HealthState> {
    state.monitor.health()
}

#[tauri::command]
pub fn monitor_refresh(state: S<'_>) {
    state.monitor.refresh_now();
    state.monitor.health_now();
}

#[tauri::command]
pub fn monitor_set_visible(state: S<'_>, visible: bool) {
    state.monitor.set_visible(visible);
}

#[tauri::command]
pub async fn exclusions_get(state: S<'_>, refresh: bool) -> AppResult<Arc<ExclusionReport>> {
    Ok(if refresh { state.monitor.exclusions_refresh() } else { state.monitor.exclusions() })
}

// --------------------------------------------------------------- process

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessView {
    info: process::ProcessInfo,
    icon: Option<String>,
    summary: Option<crate::monitor::model::ProcSummary>,
    termination: protect::TerminationAssessment,
    projects: Vec<ProjectRef>,
    children: Vec<(u32, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    id: i64,
    name: String,
    directory: Option<String>,
    ports: Vec<u16>,
}

#[tauri::command]
pub async fn process_inspect(state: S<'_>, pid: u32, record: Option<bool>) -> AppResult<ProcessView> {
    let snap_procs = process::snapshot()?;
    let info = process::inspect(pid, &snap_procs).ok_or_else(|| AppError::NotFound(format!("process {pid} is not running")))?;
    let snap = state.monitor.latest();
    let summary = snap.process(pid).cloned();
    let listening = summary.as_ref().map(|s| s.listen_ports.len() + s.udp_ports.len()).unwrap_or(0);
    let me = process::current_user();
    let termination = protect::assess(&protect::Subject {
        pid,
        name: &info.name,
        path: info.details.path.as_deref(),
        owner: info.details.owner.as_deref(),
        current_user: me.as_deref(),
        self_pid: std::process::id(),
        windows_dir: &state.monitor.windows_dir,
        listening_ports: listening,
    });
    let icon = info.details.path.as_deref().and_then(|p| state.icon_for(p));
    let ports_of: Vec<u16> =
        summary.as_ref().map(|s| s.listen_ports.iter().chain(s.udp_ports.iter()).copied().collect()).unwrap_or_default();
    let cfg = state.monitor.config();
    let projects = cfg
        .projects
        .iter()
        .filter_map(|p| {
            let hit: Vec<u16> = p.ports.iter().map(|pp| pp.port).filter(|port| ports_of.contains(port)).collect();
            (!hit.is_empty()).then(|| ProjectRef { id: p.id, name: p.name.clone(), directory: p.directory.clone(), ports: hit })
        })
        .collect();
    let mut children: Vec<(u32, String)> =
        snap_procs.values().filter(|b| b.parent_pid == pid && b.pid != pid).map(|b| (b.pid, b.name.clone())).collect();
    children.sort();
    children.truncate(50);
    if record.unwrap_or(true) && state.db.is_persistent() {
        let _ = events::inspection_record(&state.db, pid, &info.name, info.details.start_time);
    }
    Ok(ProcessView { info, icon, summary, termination, projects, children })
}

#[tauri::command]
pub async fn process_icons(state: S<'_>, paths: Vec<String>) -> AppResult<HashMap<String, Option<String>>> {
    if paths.len() > 300 {
        return invalid("too many icons requested");
    }
    // Only icons for executables that currently own sockets may be read.
    let snap = state.monitor.latest();
    let known: std::collections::HashSet<&str> = snap.processes.iter().filter_map(|p| p.path.as_deref()).collect();
    Ok(paths
        .into_iter()
        .filter(|p| known.contains(p.as_str()))
        .map(|p| {
            let v = state.icon_for(&p);
            (p, v)
        })
        .collect())
}

fn open_in_explorer(target: &str, select: bool) -> AppResult<()> {
    let p = Path::new(target);
    if !p.is_absolute() || target.contains('"') || !p.exists() {
        return Err(AppError::NotFound(format!("{target} is not accessible")));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let explorer = Path::new(&root).join("explorer.exe");
        let mut cmd = std::process::Command::new(explorer);
        if select {
            cmd.raw_arg(format!("/select,\"{target}\""));
        } else {
            cmd.raw_arg(format!("\"{target}\""));
        }
        cmd.spawn().map_err(|e| AppError::Os(format!("could not open Explorer: {e}")))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = select;
        Err(AppError::Unsupported("Windows only".into()))
    }
}

/// Opens Explorer at the process executable. The path is read from the
/// process by the backend; the UI only supplies the PID.
#[tauri::command]
pub async fn process_open_location(pid: u32) -> AppResult<()> {
    let (access, d) = process::details(pid, false);
    if access != process::Access::Full {
        return Err(AppError::AccessDenied("Windows does not allow reading this process's executable path without elevation.".into()));
    }
    let path = d.path.ok_or_else(|| AppError::NotFound("executable path unavailable".into()))?;
    open_in_explorer(&path, true)
}

#[tauri::command]
pub async fn project_open_dir(state: S<'_>, project_id: i64) -> AppResult<()> {
    let p = projects::get(&state.db, project_id)?;
    let dir = p.directory.ok_or_else(|| AppError::NotFound("this project has no directory set".into()))?;
    if !Path::new(&dir).is_dir() {
        return Err(AppError::NotFound(format!("directory no longer exists: {dir}")));
    }
    open_in_explorer(&dir, false)
}

/// Terminates a process after explicit confirmation. The safety assessment
/// is recomputed here (never trusted from the UI) and the start time must
/// match the instance the user confirmed.
#[tauri::command]
pub async fn process_terminate(state: S<'_>, pid: u32, start_time: Option<i64>, confirmed: bool) -> AppResult<()> {
    if !confirmed {
        return invalid("termination requires explicit confirmation");
    }
    let snap = process::snapshot()?;
    let info = process::inspect(pid, &snap).ok_or_else(|| AppError::NotFound(format!("process {pid} is no longer running")))?;
    let me = process::current_user();
    let live = state.monitor.latest();
    let ports: Vec<u16> = live.process(pid).map(|s| s.listen_ports.iter().chain(s.udp_ports.iter()).copied().collect()).unwrap_or_default();
    let a = protect::assess(&protect::Subject {
        pid,
        name: &info.name,
        path: info.details.path.as_deref(),
        owner: info.details.owner.as_deref(),
        current_user: me.as_deref(),
        self_pid: std::process::id(),
        windows_dir: &state.monitor.windows_dir,
        listening_ports: ports.len(),
    });
    if !a.allowed {
        return Err(AppError::Protected(a.reasons.join(" ")));
    }
    if start_time.is_none() && info.details.start_time.is_some() {
        return invalid("the confirmed process instance is unknown; refresh and try again");
    }
    process::terminate(pid, start_time)?;
    if state.db.is_persistent() && state.monitor.settings.read().history.enabled {
        let _ = events::insert(
            &state.db,
            &NewEvent {
                kind: kind::PROCESS_TERMINATED.into(),
                severity: "warning".into(),
                pid: Some(pid),
                process: Some(info.name.clone()),
                port: ports.first().copied(),
                message: format!(
                    "Terminated {} (PID {pid}) at the user's request{}",
                    info.name,
                    if ports.is_empty() {
                        String::new()
                    } else {
                        format!("; it held port(s) {}", ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", "))
                    }
                ),
                ..Default::default()
            },
        );
    }
    state.monitor.refresh_now();
    Ok(())
}

// ----------------------------------------------------------------- ports

fn claims_for(cfg: &crate::monitor::ConfigCache, protocol: Protocol, port: u16) -> Vec<Claim> {
    let p = protocol.as_str();
    let mut out = Vec::new();
    for pr in &cfg.projects {
        if pr.ports.iter().any(|pp| pp.port == port && pp.protocol == p) {
            out.push(Claim { source: "project", id: pr.id, label: pr.name.clone() });
        }
    }
    for r in &cfg.reservations {
        if r.protocol == p && (port as i64) >= r.port_start && (port as i64) <= r.port_end {
            out.push(Claim { source: "reservation", id: r.id, label: r.label.clone() });
        }
    }
    for pl in &cfg.plans {
        if pl.entries.iter().any(|e| e.port == port as i64 && e.protocol == p) {
            out.push(Claim { source: "plan", id: pl.id, label: pl.name.clone() });
        }
    }
    out
}

fn live_sockets(snap: &Snapshot) -> Vec<crate::net::SocketEntry> {
    // Fresh read for accuracy; fall back to the snapshot.
    crate::net::read_sockets().unwrap_or_else(|_| {
        let mut v: Vec<_> = snap.connections.iter().map(|c| c.socket.clone()).collect();
        for u in &snap.ports {
            for b in &u.bindings {
                if let Ok(ip) = b.addr.parse() {
                    v.push(crate::net::make_entry(u.protocol, ip, u.port, None, crate::net::SocketState::Listen, b.pid));
                }
            }
        }
        v
    })
}

#[tauri::command]
pub async fn port_check(state: S<'_>, protocol: String, port: i64) -> AppResult<Availability> {
    let pr = proto(&protocol)?;
    let port = crate::validate::port(port)?;
    let cfg = state.monitor.config();
    let excl = state.monitor.exclusions();
    let sockets = live_sockets(&state.monitor.latest());
    Ok(planner::assess(pr, port, &sockets, &excl, claims_for(&cfg, pr, port), true))
}

#[tauri::command]
pub async fn port_check_many(state: S<'_>, protocol: String, ports: Vec<i64>) -> AppResult<Vec<Availability>> {
    if ports.len() > 200 {
        return invalid("at most 200 ports per check");
    }
    let pr = proto(&protocol)?;
    let cfg = state.monitor.config();
    let excl = state.monitor.exclusions();
    let sockets = live_sockets(&state.monitor.latest());
    ports
        .into_iter()
        .map(|p| {
            let port = crate::validate::port(p)?;
            Ok(planner::assess(pr, port, &sockets, &excl, claims_for(&cfg, pr, port), true))
        })
        .collect()
}

#[tauri::command]
pub async fn port_suggest(state: S<'_>, protocol: String, start: i64, end: i64, count: Option<u32>) -> AppResult<Vec<u16>> {
    let pr = proto(&protocol)?;
    let (s, e) = crate::validate::port_range(start, end)?;
    let cfg = state.monitor.config();
    let excl = state.monitor.exclusions();
    let sockets = live_sockets(&state.monitor.latest());
    let claimed = |p: u16| cfg.claimed(pr, p);
    Ok(planner::suggest(pr, s, e, count.unwrap_or(5).clamp(1, 20) as usize, &sockets, &excl, &claimed, true))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortDetail {
    usage: Option<crate::monitor::model::PortUsage>,
    note: Option<ports::PortNote>,
    claims: Vec<Claim>,
    history: Vec<events::Event>,
    os_excluded: Option<crate::net::excluded::ExcludedRange>,
    os_exclusions_verified: bool,
}

#[tauri::command]
pub async fn port_detail(state: S<'_>, protocol: String, port: i64) -> AppResult<PortDetail> {
    let pr = proto(&protocol)?;
    let port = crate::validate::port(port)?;
    let snap = state.monitor.latest();
    let cfg = state.monitor.config();
    let excl = state.monitor.exclusions();
    Ok(PortDetail {
        usage: snap.ports.iter().find(|u| u.protocol == pr && u.port == port).cloned(),
        note: cfg.notes.iter().find(|n| n.port == port && n.protocol == pr.as_str()).cloned(),
        claims: claims_for(&cfg, pr, port),
        history: events::list(&state.db, &EventFilter { port: Some(port), limit: Some(50), ..Default::default() })?.events,
        os_excluded: excl.find(pr.as_str(), port).cloned(),
        os_exclusions_verified: excl.verified,
    })
}

#[tauri::command]
pub fn port_notes(state: S<'_>) -> AppResult<Vec<ports::PortNote>> {
    ports::notes(&state.db)
}

#[tauri::command]
pub fn port_note_save(state: S<'_>, note: ports::PortNote) -> AppResult<Option<ports::PortNote>> {
    let r = ports::note_save(&state.db, &note)?;
    state.monitor.mark_config_dirty();
    Ok(r)
}

#[tauri::command]
pub fn reservations_list(state: S<'_>) -> AppResult<Vec<ports::Reservation>> {
    ports::reservations(&state.db)
}

#[tauri::command]
pub fn reservation_save(state: S<'_>, reservation: ports::Reservation) -> AppResult<i64> {
    let id = ports::reservation_save(&state.db, &reservation)?;
    changed(
        &state,
        format!("Personal reservation \"{}\" saved ({}–{})", reservation.label.trim(), reservation.port_start, reservation.port_end),
    );
    Ok(id)
}

#[tauri::command]
pub fn reservation_delete(state: S<'_>, id: i64) -> AppResult<()> {
    ports::reservation_delete(&state.db, id)?;
    changed(&state, "Personal reservation removed".into());
    Ok(())
}

#[tauri::command]
pub fn ranges_list(state: S<'_>) -> AppResult<Vec<ports::PortRange>> {
    ports::ranges(&state.db)
}

#[tauri::command]
pub fn range_save(state: S<'_>, range: ports::PortRange) -> AppResult<i64> {
    let id = ports::range_save(&state.db, &range)?;
    state.monitor.mark_config_dirty();
    Ok(id)
}

#[tauri::command]
pub fn range_delete(state: S<'_>, id: i64) -> AppResult<()> {
    ports::range_delete(&state.db, id)?;
    state.monitor.mark_config_dirty();
    Ok(())
}

// -------------------------------------------------------------- projects

#[tauri::command]
pub fn projects_list(state: S<'_>) -> AppResult<Vec<projects::Project>> {
    projects::list(&state.db)
}

#[tauri::command]
pub fn project_save(state: S<'_>, id: Option<i64>, input: projects::ProjectInput) -> AppResult<projects::Project> {
    let p = match id {
        Some(id) => projects::update(&state.db, id, &input)?,
        None => projects::create(&state.db, &input)?,
    };
    changed(&state, format!("Project \"{}\" {}", p.name, if id.is_some() { "updated" } else { "registered" }));
    Ok(p)
}

#[tauri::command]
pub fn project_delete(state: S<'_>, id: i64) -> AppResult<()> {
    let name = projects::get(&state.db, id).map(|p| p.name).unwrap_or_default();
    projects::delete(&state.db, id)?;
    changed(&state, format!("Project \"{name}\" removed"));
    Ok(())
}

#[tauri::command]
pub fn project_favorite(state: S<'_>, id: i64, favorite: bool) -> AppResult<()> {
    projects::set_favorite(&state.db, id, favorite)?;
    state.monitor.mark_config_dirty();
    Ok(())
}

#[tauri::command]
pub fn groups_list(state: S<'_>) -> AppResult<Vec<projects::Group>> {
    projects::groups(&state.db)
}

#[tauri::command]
pub fn group_save(state: S<'_>, id: Option<i64>, name: String) -> AppResult<i64> {
    let r = projects::group_save(&state.db, id, &name)?;
    state.monitor.mark_config_dirty();
    Ok(r)
}

#[tauri::command]
pub fn group_delete(state: S<'_>, id: i64) -> AppResult<()> {
    projects::group_delete(&state.db, id)?;
    state.monitor.mark_config_dirty();
    Ok(())
}

#[tauri::command]
pub fn health_history(state: S<'_>, project_port_id: i64, hours: Option<u32>) -> AppResult<Vec<events::HealthSample>> {
    let h = hours.unwrap_or(24).clamp(1, 24 * 30) as i64;
    events::health_history(&state.db, project_port_id, crate::db::now_ms() - h * 3_600_000)
}

// -------------------------------------------------------------- profiles

#[tauri::command]
pub fn profiles_list(state: S<'_>) -> AppResult<Vec<profiles::Profile>> {
    profiles::list(&state.db)
}

#[tauri::command]
pub fn profile_save(state: S<'_>, id: Option<i64>, input: profiles::ProfileInput) -> AppResult<profiles::Profile> {
    let p = profiles::save(&state.db, id, &input)?;
    changed(&state, format!("Profile \"{}\" saved", p.name));
    Ok(p)
}

#[tauri::command]
pub fn profile_delete(state: S<'_>, id: i64) -> AppResult<()> {
    profiles::delete(&state.db, id)?;
    let mut s = state.monitor.settings.read().clone();
    if s.general.active_profile_id == Some(id) {
        s.general.active_profile_id = None;
        let s = s.save(&state.db)?;
        state.monitor.set_settings(s);
    }
    changed(&state, "Profile removed".into());
    Ok(())
}

/// Activates a profile (focus for dashboard + health monitoring). Never
/// starts anything.
#[tauri::command]
pub fn profile_activate(state: S<'_>, id: Option<i64>) -> AppResult<Settings> {
    let name = match id {
        Some(i) => Some(profiles::get(&state.db, i)?.name),
        None => None,
    };
    let mut s = state.monitor.settings.read().clone();
    s.general.active_profile_id = id;
    let s = s.save(&state.db)?;
    state.monitor.set_settings(s.clone());
    changed(
        &state,
        match name {
            Some(n) => format!("Profile \"{n}\" activated"),
            None => "Active profile cleared".into(),
        },
    );
    Ok(s)
}

// ----------------------------------------------------------------- plans

#[tauri::command]
pub fn plans_list(state: S<'_>) -> AppResult<Vec<plans::Plan>> {
    plans::list(&state.db)
}

#[tauri::command]
pub fn plan_save(state: S<'_>, id: Option<i64>, input: plans::PlanInput) -> AppResult<plans::Plan> {
    let p = plans::save(&state.db, id, &input)?;
    changed(&state, format!("Port plan \"{}\" saved", p.name));
    Ok(p)
}

#[tauri::command]
pub fn plan_delete(state: S<'_>, id: i64) -> AppResult<()> {
    plans::delete(&state.db, id)?;
    changed(&state, "Port plan removed".into());
    Ok(())
}

/// Validates plan entries: static rules plus live occupancy and claims by
/// other projects/plans. `plan_id` excludes the plan's own saved claims.
#[tauri::command]
pub async fn plan_validate(
    state: S<'_>,
    plan_id: Option<i64>,
    project_id: Option<i64>,
    entries: Vec<plans::PlanEntry>,
) -> AppResult<Vec<conflicts::PlanIssue>> {
    if entries.len() > 200 {
        return invalid("too many entries");
    }
    let excl = state.monitor.exclusions();
    let mut issues = conflicts::validate_plan_entries(&entries, &excl);
    let snap = state.monitor.latest();
    let cfg = state.monitor.config();
    for (i, e) in entries.iter().enumerate() {
        let Ok(port) = crate::validate::port(e.port) else {
            issues.push(conflicts::PlanIssue {
                index: i,
                code: "invalid",
                severity: conflicts::Severity::Error,
                message: "port must be 1–65535".into(),
            });
            continue;
        };
        let pr = Protocol::parse(&e.protocol).unwrap_or(Protocol::Tcp);
        if let Some(u) = snap.ports.iter().find(|u| u.protocol == pr && u.port == port) {
            let names: Vec<String> =
                u.pids.iter().map(|p| snap.process(*p).map(|x| x.name.clone()).unwrap_or_else(|| format!("PID {p}"))).collect();
            issues.push(conflicts::PlanIssue {
                index: i,
                code: "occupied",
                severity: conflicts::Severity::Warning,
                message: format!("port {port} is currently in use by {}", names.join(", ")),
            });
        }
        for c in claims_for(&cfg, pr, port) {
            let own = (c.source == "plan" && Some(c.id) == plan_id) || (c.source == "project" && Some(c.id) == project_id);
            if !own && c.source != "reservation" {
                issues.push(conflicts::PlanIssue {
                    index: i,
                    code: "claimed",
                    severity: conflicts::Severity::Warning,
                    message: format!("port {port} is also used by {} \"{}\"", c.source, c.label),
                });
            }
        }
    }
    issues.sort_by_key(|i| i.index);
    Ok(issues)
}

#[tauri::command]
pub async fn plan_export(state: S<'_>, id: i64, format: String, path: String) -> AppResult<()> {
    let plan = plans::get(&state.db, id)?;
    let (body, exts): (String, &[&str]) = match format.as_str() {
        "json" => (
            serde_json::to_string_pretty(
                &serde_json::json!({ "format": "ivily-portly-plan", "version": 1, "plan": { "name": plan.name, "description": plan.description, "entries": plan.entries } }),
            )?,
            &["json"],
        ),
        "csv" => (exchange::plan_csv(&plan), &["csv"]),
        "markdown" => (exchange::plan_markdown(&plan), &["md", "markdown"]),
        _ => return invalid("format must be json, csv or markdown"),
    };
    let dest = exchange::check_export_path(&path, exts)?;
    std::fs::write(dest, body)?;
    Ok(())
}

// --------------------------------------------------------------- activity

#[tauri::command]
pub fn events_list(state: S<'_>, filter: EventFilter) -> AppResult<EventPage> {
    events::list(&state.db, &filter)
}

#[tauri::command]
pub fn events_clear(state: S<'_>, filter: EventFilter) -> AppResult<usize> {
    events::clear(&state.db, &filter)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStats {
    hourly: Vec<i64>,
    counts: BTreeMap<String, i64>,
    inspections: Vec<events::Inspection>,
}

#[tauri::command]
pub fn activity_stats(state: S<'_>, hours: Option<u32>) -> AppResult<ActivityStats> {
    let h = hours.unwrap_or(24).clamp(1, 168);
    Ok(ActivityStats {
        hourly: events::hourly(&state.db, h)?,
        counts: events::counts_since(&state.db, crate::db::now_ms() - h as i64 * 3_600_000)?,
        inspections: events::inspections(&state.db)?,
    })
}

// --------------------------------------------------------------- settings

#[tauri::command]
pub fn settings_get(state: S<'_>) -> Settings {
    state.monitor.settings.read().clone()
}

#[tauri::command]
pub fn settings_update(state: S<'_>, settings: Settings) -> AppResult<Settings> {
    let before = state.monitor.settings.read().clone();
    let saved = settings.save(&state.db)?;
    if before.monitoring != saved.monitoring || before.history != saved.history || before.ecosystem != saved.ecosystem {
        config_event(&state, "Monitoring or privacy settings changed".into());
    }
    if before.history.retention_days != saved.history.retention_days || before.history.max_events != saved.history.max_events {
        let _ = events::prune(&state.db, saved.history.retention_days, saved.history.max_events);
    }
    state.monitor.set_settings(saved.clone());
    Ok(saved)
}

#[tauri::command]
pub fn settings_reset(state: S<'_>) -> AppResult<Settings> {
    let saved = Settings::default().save(&state.db)?;
    state.monitor.set_settings(saved.clone());
    config_event(&state, "Settings reset to defaults".into());
    Ok(saved)
}

/// Records the outcome of an update check performed by the UI updater.
#[tauri::command]
pub fn update_record(state: S<'_>, latest_version: Option<String>) -> AppResult<()> {
    if let Some(v) = &latest_version {
        if v.len() > 40 || !v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')) {
            return invalid("invalid version string");
        }
    }
    let mut s = state.monitor.settings.read().clone();
    s.updates.last_checked_at = Some(crate::db::now_ms());
    s.updates.latest_version = latest_version;
    let s = s.save(&state.db)?;
    *state.monitor.settings.write() = s;
    Ok(())
}

// --------------------------------------------------------------- exchange

#[tauri::command]
pub async fn config_export(state: S<'_>, path: String, include_settings: bool) -> AppResult<()> {
    let dest = exchange::check_export_path(&path, &["json"])?;
    let doc = exchange::export(&state.db, include_settings)?;
    std::fs::write(dest, serde_json::to_string_pretty(&doc)?)?;
    Ok(())
}

#[tauri::command]
pub async fn config_import(state: S<'_>, path: String, replace: bool, apply_settings: bool) -> AppResult<exchange::ImportReport> {
    let p = exchange::check_import_path(&path)?;
    let raw = std::fs::read_to_string(p).map_err(|e| AppError::Invalid(format!("could not read file as UTF-8 text: {e}")))?;
    let doc = exchange::parse(&raw)?;
    let rep = exchange::import(&state.db, &doc, replace, apply_settings)?;
    if apply_settings {
        state.monitor.set_settings(Settings::load(&state.db));
    }
    changed(&state, format!("Configuration imported ({})", if replace { "replace" } else { "merge" }));
    Ok(rep)
}
