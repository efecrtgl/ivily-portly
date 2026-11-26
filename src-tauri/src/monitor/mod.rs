//! Monitoring engine.
//!
//! Two lightweight threads live only while the app runs (no service, no
//! tray residency):
//! - **scan**: reads socket + process tables at the configured interval
//!   (slower while the window is hidden), diffs listeners, records events,
//!   evaluates conflicts and pushes a snapshot to the UI only when something
//!   changed (plus a periodic refresh for CPU/memory figures).
//! - **health**: probes registered project ports on loopback.

pub mod diff;
pub mod model;

use crate::conflicts::{self, Conflict, HealthState, OwnershipChange};
use crate::db::{now_ms, Db};
use crate::health::{self, Status};
use crate::net::excluded::{self, ExclusionReport};
use crate::net::Protocol;
use crate::process::{self, Access, ProcessDetails};
use crate::settings::Settings;
use crate::store::events::{self, kind, NewEvent};
use crate::store::{plans, ports, profiles, projects};
use model::Snapshot;
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Receives monitor output (implemented by the Tauri layer).
pub trait Sink: Send + Sync + 'static {
    fn snapshot(&self, s: &Snapshot);
    fn conflicts(&self, c: &[Conflict]);
    fn health(&self, h: &HashMap<i64, HealthState>);
    fn event(&self, e: &NewEvent);
    fn notify(&self, title: &str, body: &str);
}

/// User configuration relevant to monitoring, reloaded when marked dirty.
#[derive(Default, Clone)]
pub struct ConfigCache {
    pub projects: Vec<projects::Project>,
    pub plans: Vec<plans::Plan>,
    pub reservations: Vec<ports::Reservation>,
    pub notes: Vec<ports::PortNote>,
    pub profiles: Vec<profiles::Profile>,
}

impl ConfigCache {
    fn load(db: &Db) -> ConfigCache {
        ConfigCache {
            projects: projects::list(db).unwrap_or_default(),
            plans: plans::list(db).unwrap_or_default(),
            reservations: ports::reservations(db).unwrap_or_default(),
            notes: ports::notes(db).unwrap_or_default(),
            profiles: profiles::list(db).unwrap_or_default(),
        }
    }

    /// Ports the user cares about: registered, favorite/annotated, reserved
    /// or planned. Port events for other ports are only recorded when
    /// "record all ports" is enabled.
    pub fn interesting(&self, protocol: Protocol, port: u16) -> bool {
        let p = protocol.as_str();
        self.projects.iter().any(|x| x.ports.iter().any(|pp| pp.port == port && pp.protocol == p))
            || self.notes.iter().any(|n| n.port == port && n.protocol == p)
            || self.reservations.iter().any(|r| r.protocol == p && (port as i64) >= r.port_start && (port as i64) <= r.port_end)
            || self.plans.iter().any(|pl| pl.entries.iter().any(|e| e.port == port as i64 && e.protocol == p))
    }

    pub fn registered_project(&self, protocol: Protocol, port: u16) -> Option<i64> {
        self.projects.iter().find(|x| x.ports.iter().any(|pp| pp.port == port && pp.protocol == protocol.as_str())).map(|x| x.id)
    }

    /// Whether a port is claimed in Portly (used to keep suggestions clean).
    pub fn claimed(&self, protocol: Protocol, port: u16) -> bool {
        self.interesting(protocol, port)
    }
}

pub struct Monitor {
    pub db: Arc<Db>,
    pub settings: RwLock<Settings>,
    latest: RwLock<Arc<Snapshot>>,
    conflicts: RwLock<Vec<Conflict>>,
    health: RwLock<HashMap<i64, HealthState>>,
    last_sample: Mutex<HashMap<i64, (i64, Status)>>,
    ownership: Mutex<Vec<OwnershipChange>>,
    known_conflicts: Mutex<HashSet<String>>,
    alternatives: Mutex<HashMap<String, Option<u16>>>,
    config: RwLock<Arc<ConfigCache>>,
    config_dirty: AtomicBool,
    visible: AtomicBool,
    wake: (Mutex<bool>, Condvar),
    health_wake: (Mutex<bool>, Condvar),
    exclusions: RwLock<(Option<Instant>, Arc<ExclusionReport>)>,
    cpu_prev: Mutex<HashMap<u32, CpuSample>>,
    seq: AtomicU64,
    last_error: RwLock<Option<String>>,
    pub windows_dir: String,
}

/// (start time, cumulative CPU ms, sampled at) per PID.
type CpuSample = (Option<i64>, u64, Instant);

const OWNERSHIP_TTL_MS: i64 = 10 * 60 * 1000;

fn windows_dir() -> String {
    std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())
}

impl Monitor {
    pub fn new(db: Arc<Db>) -> Arc<Monitor> {
        let settings = Settings::load(&db);
        let config = Arc::new(ConfigCache::load(&db));
        Arc::new(Monitor {
            db,
            settings: RwLock::new(settings),
            latest: RwLock::new(Arc::new(Snapshot::default())),
            conflicts: RwLock::new(vec![]),
            health: RwLock::new(HashMap::new()),
            last_sample: Mutex::new(HashMap::new()),
            ownership: Mutex::new(vec![]),
            known_conflicts: Mutex::new(HashSet::new()),
            alternatives: Mutex::new(HashMap::new()),
            config: RwLock::new(config),
            config_dirty: AtomicBool::new(false),
            visible: AtomicBool::new(true),
            wake: (Mutex::new(false), Condvar::new()),
            health_wake: (Mutex::new(false), Condvar::new()),
            exclusions: RwLock::new((None, Arc::new(ExclusionReport::default()))),
            cpu_prev: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            last_error: RwLock::new(None),
            windows_dir: windows_dir(),
        })
    }

    // ------------------------------------------------------------ accessors

    pub fn latest(&self) -> Arc<Snapshot> {
        self.latest.read().clone()
    }
    pub fn conflicts(&self) -> Vec<Conflict> {
        self.conflicts.read().clone()
    }
    pub fn health(&self) -> HashMap<i64, HealthState> {
        self.health.read().clone()
    }
    pub fn config(&self) -> Arc<ConfigCache> {
        self.config.read().clone()
    }
    pub fn last_error(&self) -> Option<String> {
        self.last_error.read().clone()
    }

    /// Windows excluded port ranges, refreshed at most every 5 minutes.
    pub fn exclusions(&self) -> Arc<ExclusionReport> {
        {
            let g = self.exclusions.read();
            if g.0.is_some_and(|t| t.elapsed() < Duration::from_secs(300)) {
                return g.1.clone();
            }
        }
        let fresh = Arc::new(excluded::query());
        *self.exclusions.write() = (Some(Instant::now()), fresh.clone());
        fresh
    }

    pub fn exclusions_refresh(&self) -> Arc<ExclusionReport> {
        self.exclusions.write().0 = None;
        self.exclusions()
    }

    /// Call after any configuration write. Reloads lazily on the next tick.
    pub fn mark_config_dirty(&self) {
        self.config_dirty.store(true, Ordering::SeqCst);
        self.alternatives.lock().clear();
        self.refresh_now();
        self.health_now();
    }

    pub fn reload_config_if_dirty(&self) {
        if self.config_dirty.swap(false, Ordering::SeqCst) {
            *self.config.write() = Arc::new(ConfigCache::load(&self.db));
        }
    }

    pub fn set_settings(&self, s: Settings) {
        *self.settings.write() = s;
        self.refresh_now();
        self.health_now();
    }

    pub fn set_visible(&self, v: bool) {
        let was = self.visible.swap(v, Ordering::SeqCst);
        if v && !was {
            self.refresh_now();
        }
    }

    pub fn refresh_now(&self) {
        let (m, c) = &self.wake;
        *m.lock() = true;
        c.notify_all();
    }

    pub fn health_now(&self) {
        let (m, c) = &self.health_wake;
        *m.lock() = true;
        c.notify_all();
    }

    fn record(&self, sink: &dyn Sink, e: NewEvent) {
        let (enabled, store_paths) = {
            let s = self.settings.read();
            (s.history.enabled, s.history.store_paths)
        };
        let mut e = e;
        if !store_paths {
            if let Some(serde_json::Value::Object(m)) = e.data.as_mut() {
                m.remove("path");
            }
        }
        if enabled && self.db.is_persistent() {
            let _ = events::insert(&self.db, &e);
        }
        sink.event(&e);
    }

    // ----------------------------------------------------------------- scan

    /// One monitoring pass. Returns the new snapshot.
    pub fn tick(&self, sink: &dyn Sink, first: bool) -> Arc<Snapshot> {
        self.reload_config_if_dirty();
        let started = Instant::now();
        let include_udp = self.settings.read().monitoring.include_udp;
        let sockets = match crate::net::read_sockets() {
            Ok(s) => s,
            Err(e) => {
                *self.last_error.write() = Some(e.to_string());
                return self.latest();
            }
        };
        let procs = process::snapshot().unwrap_or_default();
        *self.last_error.write() = None;

        let mut pids: Vec<u32> = sockets.iter().map(|s| s.pid).filter(|p| *p > 4).collect();
        pids.sort_unstable();
        pids.dedup();
        let mut details: HashMap<u32, (Access, ProcessDetails)> = HashMap::with_capacity(pids.len());
        let mut cpu: HashMap<u32, f32> = HashMap::new();
        let ncpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
        {
            let mut prev = self.cpu_prev.lock();
            let now = Instant::now();
            let mut next = HashMap::with_capacity(pids.len());
            for pid in pids {
                let d = process::details(pid, false);
                if let Some(cpu_ms) = d.1.cpu_time_ms {
                    if let Some((st, prev_ms, t)) = prev.get(&pid) {
                        let wall = now.duration_since(*t).as_millis() as f32;
                        if *st == d.1.start_time && wall > 50.0 && cpu_ms >= *prev_ms {
                            cpu.insert(pid, ((cpu_ms - prev_ms) as f32 / wall / ncpu * 100.0).min(100.0));
                        }
                    }
                    next.insert(pid, (d.1.start_time, cpu_ms, now));
                }
                details.insert(pid, d);
            }
            *prev = next;
        }

        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut snap = model::build(model::BuildInput {
            sockets,
            procs: &procs,
            details: &details,
            cpu: &cpu,
            windows_dir: &self.windows_dir,
            include_udp,
            ts: now_ms(),
            seq,
        });
        snap.stats.scan_ms = started.elapsed().as_millis() as u32;
        let snap = Arc::new(snap);
        let prev = self.latest();

        if !first {
            self.record_changes(sink, &prev, &snap);
        }
        let changed = first || prev.fingerprint() != snap.fingerprint();
        *self.latest.write() = snap.clone();
        self.evaluate_conflicts(sink, &snap, first);
        if changed || seq % 3 == 0 {
            sink.snapshot(&snap);
        }
        snap
    }

    fn record_changes(&self, sink: &dyn Sink, prev: &Snapshot, next: &Snapshot) {
        let changes = diff::diff(&prev.listener_map(), &next.listener_map());
        if changes.is_empty() {
            return;
        }
        let cfg = self.config();
        let (record_all, notify_changes) = {
            let s = self.settings.read();
            (s.history.record_all_ports, s.notifications.port_changes && s.notifications.system)
        };
        let now = now_ms();
        let fmt = |v: &[(u32, String)]| v.iter().map(|(p, n)| format!("{n} (PID {p})")).collect::<Vec<_>>().join(", ");
        for ch in changes {
            let (pr, port) = ch.key();
            let interesting = cfg.interesting(pr, port);
            let project_id = cfg.registered_project(pr, port);
            if let diff::PortChange::OwnerChanged { from, to, .. } = &ch {
                if project_id.is_some() {
                    let mut o = self.ownership.lock();
                    o.retain(|x| now - x.ts < OWNERSHIP_TTL_MS && !(x.protocol == pr && x.port == port));
                    o.push(OwnershipChange { protocol: pr, port, from: from.clone(), to: to.clone(), ts: now });
                }
            }
            if !(record_all || interesting) {
                continue;
            }
            let (k, sev, msg, owners) = match &ch {
                diff::PortChange::Opened { owners, .. } => {
                    (kind::PORT_OPENED, "info", format!("Port {port}/{} became occupied by {}", pr.as_str(), fmt(owners)), owners.clone())
                }
                diff::PortChange::Closed { owners, .. } => (
                    kind::PORT_CLOSED,
                    "info",
                    format!("Port {port}/{} became available (was {})", pr.as_str(), fmt(owners)),
                    owners.clone(),
                ),
                diff::PortChange::OwnerChanged { from, to, .. } => (
                    kind::OWNER_CHANGED,
                    if project_id.is_some() { "warning" } else { "info" },
                    format!("Port {port}/{} changed owner: {} → {}", pr.as_str(), fmt(from), fmt(to)),
                    to.clone(),
                ),
            };
            let first_owner = owners.first();
            let path = first_owner.and_then(|(pid, _)| next.process(*pid)).and_then(|p| p.path.clone());
            self.record(
                sink,
                NewEvent {
                    kind: k.into(),
                    severity: sev.into(),
                    protocol: Some(pr.as_str().into()),
                    port: Some(port),
                    pid: first_owner.map(|o| o.0),
                    process: first_owner.map(|o| o.1.clone()),
                    project_id,
                    message: msg.clone(),
                    data: Some(serde_json::json!({ "path": path })),
                },
            );
            if notify_changes && interesting {
                sink.notify("Port change", &msg);
            }
        }
    }

    fn evaluate_conflicts(&self, sink: &dyn Sink, snap: &Snapshot, first: bool) {
        let cfg = self.config();
        let excl = self.exclusions();
        let health = self.health.read().clone();
        let ownership = {
            let now = now_ms();
            let mut o = self.ownership.lock();
            o.retain(|x| now - x.ts < OWNERSHIP_TTL_MS);
            o.clone()
        };
        let mut list = conflicts::detect(&conflicts::Input {
            snapshot: snap,
            projects: &cfg.projects,
            plans: &cfg.plans,
            reservations: &cfg.reservations,
            health: &health,
            excluded: &excl,
            ownership_changes: &ownership,
        });

        // Verified free alternatives for actionable conflicts (cached per id).
        {
            let mut alts = self.alternatives.lock();
            for c in list.iter_mut() {
                if !matches!(c.kind, "shared_project_port" | "unexpected_occupant" | "os_excluded_port") {
                    continue;
                }
                let (Some(pr), Some(port)) = (c.protocol, c.port) else { continue };
                let alt = alts.entry(c.id.clone()).or_insert_with(|| {
                    let start = port.saturating_add(1).max(1024);
                    let end = start.saturating_add(200).min(49151);
                    let claimed = |p: u16| cfg.claimed(pr, p);
                    let sockets: Vec<_> = snap.connections.iter().map(|c| c.socket.clone()).collect();
                    let mut busy = sockets;
                    busy.extend(snap.ports.iter().flat_map(|u| {
                        u.bindings.iter().map(move |b| {
                            crate::net::make_entry(
                                u.protocol,
                                b.addr.parse().unwrap_or(std::net::IpAddr::from([127, 0, 0, 1])),
                                u.port,
                                None,
                                crate::net::SocketState::Listen,
                                b.pid,
                            )
                        })
                    }));
                    crate::planner::suggest(pr, start, end, 1, &busy, &excl, &claimed, true).first().copied()
                });
                c.alternative_port = *alt;
            }
        }

        let ids: HashSet<String> = list.iter().map(|c| c.id.clone()).collect();
        let changed = {
            let mut known = self.known_conflicts.lock();
            let new: Vec<&Conflict> = list.iter().filter(|c| !known.contains(&c.id)).collect();
            if !first {
                let (notify, sys) = {
                    let s = self.settings.read();
                    (s.notifications.conflicts, s.notifications.system)
                };
                for c in &new {
                    if c.kind == "server_not_responding" {
                        continue; // recorded by the health thread as server_down
                    }
                    self.record(
                        sink,
                        NewEvent {
                            kind: kind::CONFLICT.into(),
                            severity: match c.severity {
                                conflicts::Severity::Error => "critical",
                                conflicts::Severity::Warning => "warning",
                                conflicts::Severity::Info => "info",
                            }
                            .into(),
                            protocol: c.protocol.map(|p| p.as_str().into()),
                            port: c.port,
                            pid: c.pids.first().copied(),
                            process: None,
                            project_id: c.project_ids.first().copied(),
                            message: c.title.clone(),
                            data: Some(serde_json::json!({ "conflictKind": c.kind, "detail": c.detail })),
                        },
                    );
                    if notify && sys && c.severity >= conflicts::Severity::Warning {
                        sink.notify(&c.title, &c.detail);
                    }
                }
            }
            let changed = *known != ids;
            *known = ids;
            changed
        };
        *self.conflicts.write() = list;
        if changed || first {
            sink.conflicts(&self.conflicts.read());
        }
    }

    // --------------------------------------------------------------- health

    /// Project ports to probe, honoring the active profile.
    fn health_targets(&self) -> Vec<(projects::Project, projects::ProjectPort)> {
        let cfg = self.config();
        let active = self.settings.read().general.active_profile_id;
        let profile = active.and_then(|id| cfg.profiles.iter().find(|p| p.id == id));
        cfg.projects
            .iter()
            .filter(|p| match profile {
                Some(pf) => pf.monitor_health && pf.project_ids.contains(&p.id),
                None => true,
            })
            .flat_map(|p| p.ports.iter().filter(|pp| pp.check_kind != "none").map(move |pp| (p.clone(), pp.clone())))
            .collect()
    }

    pub fn health_pass(&self, sink: &dyn Sink) {
        self.reload_config_if_dirty();
        let targets = self.health_targets();
        let timeout = Duration::from_millis(self.settings.read().monitoring.health_timeout_ms);
        let results: Vec<(i64, health::CheckResult)> = std::thread::scope(|s| {
            let handles: Vec<_> = targets
                .chunks(8)
                .map(|chunk| {
                    s.spawn(move || {
                        chunk
                            .iter()
                            .map(|(_, pp)| (pp.id, health::check(&pp.host, pp.port, &pp.check_kind, &pp.http_path, timeout)))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        let notify = {
            let s = self.settings.read();
            s.notifications.server_status && s.notifications.system
        };
        let now = now_ms();
        let mut state = self.health.write();
        let live: HashSet<i64> = targets.iter().map(|(_, pp)| pp.id).collect();
        state.retain(|id, _| live.contains(id));
        for (id, r) in results {
            let (project, pp) = targets.iter().find(|(_, pp)| pp.id == id).map(|(p, pp)| (p, pp)).unwrap();
            let entry = state.entry(id).or_default();
            let prev_status = entry.last.as_ref().map(|l| l.status);
            let up = matches!(r.status, Status::Up | Status::Degraded);
            if up {
                if entry.up_since.is_none() || prev_status == Some(Status::Down) {
                    entry.up_since = Some(now);
                }
                entry.down_since = None;
                if prev_status == Some(Status::Down) && entry.seen_up {
                    let msg = format!("{} recovered on port {}", project.name, pp.port);
                    drop_record(self, sink, kind::SERVER_UP, "info", project.id, pp, &msg);
                    if notify {
                        sink.notify("Server recovered", &msg);
                    }
                }
                entry.seen_up = true;
            } else {
                if entry.down_since.is_none() {
                    entry.down_since = Some(now);
                }
                entry.up_since = None;
                if matches!(prev_status, Some(Status::Up) | Some(Status::Degraded)) {
                    let msg = format!("{} stopped responding on port {}", project.name, pp.port);
                    drop_record(self, sink, kind::SERVER_DOWN, "warning", project.id, pp, &msg);
                    if notify {
                        sink.notify("Server unavailable", &msg);
                    }
                }
            }
            // Persist a sample on change or every 5 minutes.
            let mut ls = self.last_sample.lock();
            let due = ls.get(&id).is_none_or(|(t, s)| *s != r.status || now - t >= 300_000);
            if due && self.db.is_persistent() {
                let _ = events::health_insert(&self.db, id, r.status.as_str(), r.latency_ms);
                ls.insert(id, (now, r.status));
            }
            entry.last = Some(r);
        }
        let snapshot = state.clone();
        drop(state);
        sink.health(&snapshot);
    }

    // ---------------------------------------------------------------- loops

    pub fn start(self: &Arc<Self>, sink: Arc<dyn Sink>) {
        let me = self.clone();
        let s1 = sink.clone();
        std::thread::Builder::new().name("portly-scan".into()).spawn(move || me.scan_loop(s1.as_ref())).expect("spawn scan thread");
        let me = self.clone();
        std::thread::Builder::new().name("portly-health".into()).spawn(move || me.health_loop(sink.as_ref())).expect("spawn health thread");
    }

    fn scan_loop(&self, sink: &dyn Sink) {
        let mut first = true;
        let mut last_prune = Instant::now() - Duration::from_secs(3600);
        loop {
            let (interval, paused) = {
                let s = self.settings.read();
                let visible = self.visible.load(Ordering::SeqCst);
                (if visible { s.monitoring.interval_ms } else { s.monitoring.background_interval_ms }, s.monitoring.paused)
            };
            if !paused || first {
                self.tick(sink, first);
                first = false;
            }
            if last_prune.elapsed() >= Duration::from_secs(3600) {
                let h = self.settings.read().history.clone();
                let _ = events::prune(&self.db, h.retention_days, h.max_events);
                last_prune = Instant::now();
            }
            let (m, c) = &self.wake;
            let mut woken = m.lock();
            if !*woken {
                c.wait_for(&mut woken, Duration::from_millis(interval));
            }
            *woken = false;
        }
    }

    fn health_loop(&self, sink: &dyn Sink) {
        // Let the first scan land first.
        std::thread::sleep(Duration::from_millis(400));
        loop {
            let (interval, paused) = {
                let s = self.settings.read();
                let mult = if self.visible.load(Ordering::SeqCst) { 1 } else { 3 };
                (s.monitoring.health_interval_s * mult, s.monitoring.paused)
            };
            if !paused {
                self.health_pass(sink);
            }
            let (m, c) = &self.health_wake;
            let mut woken = m.lock();
            if !*woken {
                c.wait_for(&mut woken, Duration::from_secs(interval));
            }
            *woken = false;
        }
    }
}

fn drop_record(m: &Monitor, sink: &dyn Sink, k: &str, sev: &str, project_id: i64, pp: &projects::ProjectPort, msg: &str) {
    m.record(
        sink,
        NewEvent {
            kind: k.into(),
            severity: sev.into(),
            protocol: Some(pp.protocol.clone()),
            port: Some(pp.port),
            pid: None,
            process: None,
            project_id: Some(project_id),
            message: msg.into(),
            data: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[derive(Default)]
    pub struct TestSink {
        pub snapshots: Mutex<u32>,
        pub events: Mutex<Vec<NewEvent>>,
        pub notes: Mutex<Vec<String>>,
        pub conflicts: Mutex<Vec<Vec<String>>>,
    }
    impl Sink for TestSink {
        fn snapshot(&self, _s: &Snapshot) {
            *self.snapshots.lock() += 1;
        }
        fn conflicts(&self, c: &[Conflict]) {
            self.conflicts.lock().push(c.iter().map(|c| c.id.clone()).collect());
        }
        fn health(&self, _h: &HashMap<i64, HealthState>) {}
        fn event(&self, e: &NewEvent) {
            self.events.lock().push(e.clone());
        }
        fn notify(&self, title: &str, _body: &str) {
            self.notes.lock().push(title.into());
        }
    }

    fn project_with_port(db: &Db, port: u16, check: &str) -> projects::Project {
        projects::create(
            db,
            &projects::ProjectInput {
                name: "Svc".into(),
                description: String::new(),
                directory: None,
                group_id: None,
                favorite: false,
                metadata: serde_json::Value::Null,
                start_command: None,
                ports: vec![projects::ProjectPortInput {
                    port: port as i64,
                    protocol: "tcp".into(),
                    role: String::new(),
                    host: "127.0.0.1".into(),
                    check_kind: check.into(),
                    http_path: "/".into(),
                    expected_process: None,
                }],
            },
        )
        .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn records_open_and_close_for_registered_port() {
        let db = Arc::new(Db::open_memory());
        // Reserve a free port number, register it, then open/close it.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        project_with_port(&db, port, "none");
        let m = Monitor::new(db.clone());
        let sink = TestSink::default();
        m.tick(&sink, true);
        let l = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let snap = m.tick(&sink, false);
        assert!(snap.ports.iter().any(|p| p.port == port));
        drop(l);
        m.tick(&sink, false);
        let ev = sink.events.lock();
        let kinds: Vec<&str> = ev.iter().filter(|e| e.port == Some(port)).map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, vec![kind::PORT_OPENED, kind::PORT_CLOSED]);
        assert!(ev.iter().all(|e| e.data.as_ref().and_then(|d| d.get("path")).is_none()), "paths stripped by default");
        assert_eq!(events::list(&db, &Default::default()).unwrap().total, 2, "events persisted");
    }

    #[cfg(windows)]
    #[test]
    fn unregistered_ports_are_not_recorded_by_default() {
        let db = Arc::new(Db::open_memory());
        let m = Monitor::new(db);
        let sink = TestSink::default();
        m.tick(&sink, true);
        let _l = TcpListener::bind("127.0.0.1:0").unwrap();
        m.tick(&sink, false);
        assert!(sink.events.lock().iter().all(|e| e.kind != kind::PORT_OPENED));
        assert!(*sink.snapshots.lock() >= 2, "changed snapshot is pushed");
    }

    #[test]
    fn health_transitions_emit_down_and_recovery() {
        let db = Arc::new(Db::open_memory());
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let p = project_with_port(&db, port, "tcp");
        let m = Monitor::new(db);
        let sink = TestSink::default();
        m.health_pass(&sink);
        let ppid = p.ports[0].id;
        assert_eq!(m.health()[&ppid].last.as_ref().unwrap().status, Status::Up);
        drop(l);
        m.health_pass(&sink);
        let _l2 = TcpListener::bind(("127.0.0.1", port)).unwrap();
        m.health_pass(&sink);
        let kinds: Vec<String> = sink.events.lock().iter().map(|e| e.kind.clone()).collect();
        assert_eq!(kinds, vec![kind::SERVER_DOWN.to_string(), kind::SERVER_UP.to_string()]);
        assert_eq!(sink.notes.lock().len(), 2);
    }

    #[test]
    fn active_profile_limits_health_targets() {
        let db = Arc::new(Db::open_memory());
        let a = project_with_port(&db, 41001, "tcp");
        project_with_port(&db, 41002, "tcp");
        let prof = profiles::save(
            &db,
            None,
            &profiles::ProfileInput {
                name: "Only A".into(),
                kind: "web".into(),
                description: String::new(),
                notes: String::new(),
                startup: serde_json::Value::Null,
                monitor_health: true,
                project_ids: vec![a.id],
            },
        )
        .unwrap();
        let m = Monitor::new(db);
        assert_eq!(m.health_targets().len(), 2);
        let mut s = m.settings.read().clone();
        s.general.active_profile_id = Some(prof.id);
        m.set_settings(s);
        let t = m.health_targets();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].0.id, a.id);
    }
}
