//! Activity Center storage: port, process, server and configuration events,
//! server health samples and recently inspected processes.

use crate::db::{now_ms, Db};
use crate::error::AppResult;
use rusqlite::{params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub mod kind {
    pub const PORT_OPENED: &str = "port_opened";
    pub const PORT_CLOSED: &str = "port_closed";
    pub const OWNER_CHANGED: &str = "owner_changed";
    pub const SERVER_DOWN: &str = "server_down";
    pub const SERVER_UP: &str = "server_up";
    pub const CONFLICT: &str = "conflict";
    pub const CONFIG: &str = "config";
    pub const PROCESS_TERMINATED: &str = "process_terminated";
    pub const ALL: &[&str] = &[PORT_OPENED, PORT_CLOSED, OWNER_CHANGED, SERVER_DOWN, SERVER_UP, CONFLICT, CONFIG, PROCESS_TERMINATED];
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub kind: String,
    /// `info`, `warning` or `critical`
    pub severity: String,
    pub protocol: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub process: Option<String>,
    pub project_id: Option<i64>,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub ts: i64,
    #[serde(flatten)]
    pub event: NewEvent,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EventFilter {
    pub kinds: Vec<String>,
    pub severity: Option<String>,
    pub search: Option<String>,
    pub port: Option<u16>,
    pub project_id: Option<i64>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

pub fn insert(db: &Db, e: &NewEvent) -> AppResult<i64> {
    insert_at(db, now_ms(), e)
}

pub fn insert_at(db: &Db, ts: i64, e: &NewEvent) -> AppResult<i64> {
    let conn = db.conn.lock();
    conn.execute(
        "INSERT INTO events(ts, kind, severity, protocol, port, pid, process, project_id, message, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            ts,
            e.kind,
            e.severity,
            e.protocol,
            e.port,
            e.pid,
            e.process,
            e.project_id,
            e.message,
            e.data.as_ref().map(|d| d.to_string())
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn where_clause(f: &EventFilter) -> (String, Vec<Value>) {
    let mut sql = String::from(" WHERE 1=1");
    let mut args: Vec<Value> = Vec::new();
    let kinds: Vec<&String> = f.kinds.iter().filter(|k| kind::ALL.contains(&k.as_str())).collect();
    if !kinds.is_empty() {
        sql.push_str(&format!(" AND kind IN ({})", vec!["?"; kinds.len()].join(",")));
        args.extend(kinds.into_iter().map(|k| Value::Text(k.clone())));
    }
    if let Some(s) = f.severity.as_deref().filter(|s| ["info", "warning", "critical"].contains(s)) {
        sql.push_str(" AND severity = ?");
        args.push(Value::Text(s.into()));
    }
    if let Some(q) = f.search.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        sql.push_str(" AND (message LIKE ? ESCAPE '\\' OR process LIKE ? ESCAPE '\\' OR CAST(port AS TEXT) = ?)");
        args.push(Value::Text(like.clone()));
        args.push(Value::Text(like));
        args.push(Value::Text(q.to_string()));
    }
    if let Some(p) = f.port {
        sql.push_str(" AND port = ?");
        args.push(Value::Integer(p as i64));
    }
    if let Some(p) = f.project_id {
        sql.push_str(" AND project_id = ?");
        args.push(Value::Integer(p));
    }
    if let Some(s) = f.since {
        sql.push_str(" AND ts >= ?");
        args.push(Value::Integer(s));
    }
    if let Some(u) = f.until {
        sql.push_str(" AND ts <= ?");
        args.push(Value::Integer(u));
    }
    (sql, args)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<Event>,
    pub total: i64,
}

pub fn list(db: &Db, f: &EventFilter) -> AppResult<EventPage> {
    let (w, args) = where_clause(f);
    let limit = f.limit.unwrap_or(200).clamp(1, 1000);
    let offset = f.offset.unwrap_or(0);
    let conn = db.conn.lock();
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM events{w}"), params_from_iter(args.iter()), |r| r.get(0))?;
    let mut st = conn.prepare(&format!(
        "SELECT id, ts, kind, severity, protocol, port, pid, process, project_id, message, data FROM events{w} ORDER BY ts DESC, id DESC LIMIT {limit} OFFSET {offset}"
    ))?;
    let rows = st.query_map(params_from_iter(args.iter()), |r| {
        Ok(Event {
            id: r.get(0)?,
            ts: r.get(1)?,
            event: NewEvent {
                kind: r.get(2)?,
                severity: r.get(3)?,
                protocol: r.get(4)?,
                port: r.get::<_, Option<i64>>(5)?.map(|p| p as u16),
                pid: r.get::<_, Option<i64>>(6)?.map(|p| p as u32),
                process: r.get(7)?,
                project_id: r.get(8)?,
                message: r.get(9)?,
                data: r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok()),
            },
        })
    })?;
    Ok(EventPage { events: rows.collect::<Result<_, _>>()?, total })
}

/// Deletes events matching the filter (all events for an empty filter).
pub fn clear(db: &Db, f: &EventFilter) -> AppResult<usize> {
    let (w, args) = where_clause(f);
    Ok(db.conn.lock().execute(&format!("DELETE FROM events{w}"), params_from_iter(args.iter()))?)
}

/// Applies retention: drops events older than `days` and keeps at most
/// `max` newest events. Health samples follow the same age limit.
pub fn prune(db: &Db, days: u32, max: u32) -> AppResult<usize> {
    let cutoff = now_ms() - days as i64 * 86_400_000;
    let conn = db.conn.lock();
    let mut n = conn.execute("DELETE FROM events WHERE ts < ?1", [cutoff])?;
    n +=
        conn.execute("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?1)", [max as i64])?;
    conn.execute("DELETE FROM health_samples WHERE ts < ?1", [cutoff])?;
    Ok(n)
}

/// Per-kind counts since `since` (used by the dashboard and IEP).
pub fn counts_since(db: &Db, since: i64) -> AppResult<BTreeMap<String, i64>> {
    let conn = db.conn.lock();
    let mut st = conn.prepare("SELECT kind, COUNT(*) FROM events WHERE ts >= ?1 GROUP BY kind")?;
    let rows = st.query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Event counts per hour bucket for the last `hours` hours (activity sparkline).
pub fn hourly(db: &Db, hours: u32) -> AppResult<Vec<i64>> {
    let now = now_ms();
    let hours = hours.clamp(1, 168) as i64;
    let start = now - hours * 3_600_000;
    let conn = db.conn.lock();
    let mut st = conn.prepare("SELECT (ts - ?1) / 3600000, COUNT(*) FROM events WHERE ts >= ?1 GROUP BY 1")?;
    let mut out = vec![0i64; hours as usize];
    for row in st.query_map([start], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
        let (b, c) = row?;
        if (0..hours).contains(&b) {
            out[b as usize] = c;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- health

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSample {
    pub ts: i64,
    pub status: String,
    pub latency_ms: Option<i64>,
}

pub fn health_insert(db: &Db, project_port_id: i64, status: &str, latency_ms: Option<u64>) -> AppResult<()> {
    db.conn.lock().execute(
        "INSERT INTO health_samples(project_port_id, ts, status, latency_ms) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM project_ports WHERE id = ?1)",
        params![project_port_id, now_ms(), status, latency_ms.map(|l| l as i64)],
    )?;
    Ok(())
}

pub fn health_history(db: &Db, project_port_id: i64, since: i64) -> AppResult<Vec<HealthSample>> {
    let conn = db.conn.lock();
    let mut st =
        conn.prepare("SELECT ts, status, latency_ms FROM health_samples WHERE project_port_id = ?1 AND ts >= ?2 ORDER BY ts LIMIT 5000")?;
    let rows =
        st.query_map(params![project_port_id, since], |r| Ok(HealthSample { ts: r.get(0)?, status: r.get(1)?, latency_ms: r.get(2)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ----------------------------------------------------------- inspections

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub pid: u32,
    pub name: String,
    pub start_time: Option<i64>,
    pub ts: i64,
}

pub fn inspection_record(db: &Db, pid: u32, name: &str, start_time: Option<i64>) -> AppResult<()> {
    let conn = db.conn.lock();
    conn.execute(
        "INSERT INTO inspections(pid, name, start_time, ts) VALUES (?1,?2,?3,?4) ON CONFLICT(pid, name) DO UPDATE SET ts = excluded.ts, start_time = excluded.start_time",
        params![pid, name, start_time, now_ms()],
    )?;
    conn.execute("DELETE FROM inspections WHERE rowid NOT IN (SELECT rowid FROM inspections ORDER BY ts DESC LIMIT 20)", [])?;
    Ok(())
}

pub fn inspections(db: &Db) -> AppResult<Vec<Inspection>> {
    let conn = db.conn.lock();
    let mut st = conn.prepare("SELECT pid, name, start_time, ts FROM inspections ORDER BY ts DESC LIMIT 20")?;
    let rows =
        st.query_map([], |r| Ok(Inspection { pid: r.get::<_, i64>(0)? as u32, name: r.get(1)?, start_time: r.get(2)?, ts: r.get(3)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, port: u16, msg: &str) -> NewEvent {
        NewEvent {
            kind: kind.into(),
            severity: "info".into(),
            protocol: Some("tcp".into()),
            port: Some(port),
            message: msg.into(),
            process: Some("node.exe".into()),
            ..Default::default()
        }
    }

    #[test]
    fn insert_filter_search_clear() {
        let db = Db::open_memory();
        insert(&db, &ev(kind::PORT_OPENED, 3000, "Port 3000 opened")).unwrap();
        insert(&db, &ev(kind::PORT_CLOSED, 3000, "Port 3000 closed")).unwrap();
        insert(&db, &NewEvent { severity: "warning".into(), ..ev(kind::CONFLICT, 8080, "Conflict on 8080 100%") }).unwrap();
        assert_eq!(list(&db, &EventFilter::default()).unwrap().total, 3);
        let f = EventFilter { kinds: vec![kind::PORT_OPENED.into(), "bogus".into()], ..Default::default() };
        assert_eq!(list(&db, &f).unwrap().total, 1);
        let f = EventFilter { search: Some("100%".into()), ..Default::default() };
        assert_eq!(list(&db, &f).unwrap().total, 1, "LIKE wildcards escaped");
        let f = EventFilter { search: Some("8080".into()), ..Default::default() };
        assert_eq!(list(&db, &f).unwrap().total, 1);
        let f = EventFilter { severity: Some("warning".into()), ..Default::default() };
        assert_eq!(list(&db, &f).unwrap().events[0].event.port, Some(8080));
        assert_eq!(clear(&db, &EventFilter { port: Some(3000), ..Default::default() }).unwrap(), 2);
        assert_eq!(list(&db, &EventFilter::default()).unwrap().total, 1);
    }

    #[test]
    fn retention_by_age_and_count() {
        let db = Db::open_memory();
        insert_at(&db, now_ms() - 40 * 86_400_000, &ev(kind::PORT_OPENED, 1, "old")).unwrap();
        for i in 0..10 {
            insert(&db, &ev(kind::PORT_OPENED, 1000 + i, "new")).unwrap();
        }
        let removed = prune(&db, 30, 5).unwrap();
        assert_eq!(removed, 6);
        assert_eq!(list(&db, &EventFilter::default()).unwrap().total, 5);
        assert_eq!(counts_since(&db, 0).unwrap()[kind::PORT_OPENED], 5);
        assert_eq!(hourly(&db, 24).unwrap().iter().sum::<i64>(), 5);
    }

    #[test]
    fn inspections_are_capped() {
        let db = Db::open_memory();
        for i in 0..25 {
            inspection_record(&db, i, "x.exe", None).unwrap();
        }
        assert_eq!(inspections(&db).unwrap().len(), 20);
    }
}
