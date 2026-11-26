//! Port allocation plans (port maps): named lists of services and the
//! ports they should use, optionally tied to a project or profile.

use crate::db::{now_ms, Db};
use crate::error::{invalid, AppError, AppResult};
use crate::validate as v;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const ENTRY_KINDS: &[&str] = &["website", "api", "dev", "database", "proxy", "testing", "cache", "queue", "custom"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    #[serde(default)]
    pub id: i64,
    pub service: String,
    #[serde(default = "custom")]
    pub kind: String,
    pub port: i64,
    #[serde(default = "tcp")]
    pub protocol: String,
    #[serde(default = "localhost")]
    pub host: String,
    #[serde(default)]
    pub note: String,
}
fn custom() -> String {
    "custom".into()
}
fn tcp() -> String {
    "tcp".into()
}
fn localhost() -> String {
    "localhost".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub profile_id: Option<i64>,
    #[serde(default)]
    pub entries: Vec<PlanEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub project_id: Option<i64>,
    pub profile_id: Option<i64>,
    pub entries: Vec<PlanEntry>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn load(conn: &rusqlite::Connection, id: i64) -> AppResult<Plan> {
    let mut plan = conn
        .query_row("SELECT id, name, description, project_id, profile_id, created_at, updated_at FROM plans WHERE id = ?1", [id], |r| {
            Ok(Plan {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                project_id: r.get(3)?,
                profile_id: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                entries: vec![],
            })
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("plan {id}")))?;
    plan.entries = conn
        .prepare_cached("SELECT id, service, kind, port, protocol, host, note FROM plan_entries WHERE plan_id = ?1 ORDER BY sort, id")?
        .query_map([id], |r| {
            Ok(PlanEntry {
                id: r.get(0)?,
                service: r.get(1)?,
                kind: r.get(2)?,
                port: r.get(3)?,
                protocol: r.get(4)?,
                host: r.get(5)?,
                note: r.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(plan)
}

pub fn list(db: &Db) -> AppResult<Vec<Plan>> {
    let conn = db.conn.lock();
    let ids: Vec<i64> =
        conn.prepare("SELECT id FROM plans ORDER BY name COLLATE NOCASE")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    ids.into_iter().map(|id| load(&conn, id)).collect()
}

pub fn get(db: &Db, id: i64) -> AppResult<Plan> {
    load(&db.conn.lock(), id)
}

pub fn clean_entries(entries: &[PlanEntry]) -> AppResult<Vec<PlanEntry>> {
    if entries.len() > 200 {
        return invalid("a plan can have at most 200 entries");
    }
    entries
        .iter()
        .map(|e| {
            if !ENTRY_KINDS.contains(&e.kind.as_str()) {
                return invalid(format!("unknown service type \"{}\"", e.kind));
            }
            Ok(PlanEntry {
                id: 0,
                service: v::name(&e.service, "Service name")?,
                kind: e.kind.clone(),
                port: v::port(e.port)? as i64,
                protocol: v::protocol(&e.protocol)?.into(),
                host: v::local_host(&e.host)?,
                note: v::short(&e.note, "Note")?,
            })
        })
        .collect()
}

pub fn save(db: &Db, id: Option<i64>, input: &PlanInput) -> AppResult<Plan> {
    let name = v::name(&input.name, "Plan name")?;
    let description = v::text(&input.description, "Description")?;
    let entries = clean_entries(&input.entries)?;
    let mut conn = db.conn.lock();
    let exists = |table: &str, id: Option<i64>| -> AppResult<Option<i64>> {
        Ok(match id {
            Some(i) => conn.query_row(&format!("SELECT id FROM {table} WHERE id = ?1"), [i], |r| r.get(0)).optional()?,
            None => None,
        })
    };
    let project_id = exists("projects", input.project_id)?;
    let profile_id = exists("profiles", input.profile_id)?;
    let tx = conn.transaction()?;
    let now = now_ms();
    let res = match id {
        Some(id) => tx
            .execute(
                "UPDATE plans SET name=?1, description=?2, project_id=?3, profile_id=?4, updated_at=?5 WHERE id=?6",
                params![name, description, project_id, profile_id, now, id],
            )
            .map(|n| (n, id)),
        None => tx
            .execute(
                "INSERT INTO plans(name, description, project_id, profile_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                params![name, description, project_id, profile_id, now],
            )
            .map(|n| (n, tx.last_insert_rowid())),
    };
    let (n, plan_id) = res.map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            AppError::Conflict(format!("a plan named \"{name}\" already exists"))
        }
        other => other.into(),
    })?;
    if n == 0 {
        return Err(AppError::NotFound("plan".into()));
    }
    tx.execute("DELETE FROM plan_entries WHERE plan_id = ?1", [plan_id])?;
    for (i, e) in entries.iter().enumerate() {
        tx.execute(
            "INSERT INTO plan_entries(plan_id, service, kind, port, protocol, host, note, sort) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![plan_id, e.service, e.kind, e.port, e.protocol, e.host, e.note, i as i64],
        )?;
    }
    tx.commit()?;
    load(&conn, plan_id)
}

pub fn delete(db: &Db, id: i64) -> AppResult<()> {
    db.conn.lock().execute("DELETE FROM plans WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(service: &str, port: i64) -> PlanEntry {
        PlanEntry {
            id: 0,
            service: service.into(),
            kind: "api".into(),
            port,
            protocol: "tcp".into(),
            host: "localhost".into(),
            note: String::new(),
        }
    }

    #[test]
    fn save_reload_and_reorder() {
        let db = Db::open_memory();
        let p = save(
            &db,
            None,
            &PlanInput {
                name: "Shop".into(),
                description: String::new(),
                project_id: Some(77),
                profile_id: None,
                entries: vec![entry("API", 8000), entry("Web", 3000)],
            },
        )
        .unwrap();
        assert_eq!(p.project_id, None, "unknown project dropped");
        assert_eq!(p.entries.iter().map(|e| e.port).collect::<Vec<_>>(), vec![8000, 3000], "order preserved");
        let p2 = save(
            &db,
            Some(p.id),
            &PlanInput {
                name: "Shop".into(),
                description: "d".into(),
                project_id: None,
                profile_id: None,
                entries: vec![entry("Web", 3000)],
            },
        )
        .unwrap();
        assert_eq!(p2.entries.len(), 1);
        delete(&db, p.id).unwrap();
        assert!(list(&db).unwrap().is_empty());
    }

    #[test]
    fn entries_are_validated() {
        assert!(clean_entries(&[entry("", 80)]).is_err());
        assert!(clean_entries(&[entry("x", 0)]).is_err());
        assert!(clean_entries(&[PlanEntry { kind: "weird".into(), ..entry("x", 80) }]).is_err());
        assert!(clean_entries(&[PlanEntry { host: "8.8.8.8".into(), ..entry("x", 80) }]).is_err());
    }
}
