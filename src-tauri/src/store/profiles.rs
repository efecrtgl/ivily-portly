//! Development profiles: named sets of projects with notes and startup
//! metadata. Profiles are organizational only — activating a profile changes
//! what the dashboard and health monitor focus on; it never runs anything.

use crate::db::{now_ms, Db};
use crate::error::{invalid, AppError, AppResult};
use crate::validate as v;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const KINDS: &[&str] = &["web", "backend", "fullstack", "game", "testing", "personal", "custom"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub name: String,
    #[serde(default = "custom")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub notes: String,
    /// Free-form startup metadata, e.g. `{ "order": "db, api, web" }`.
    #[serde(default)]
    pub startup: serde_json::Value,
    #[serde(default = "yes")]
    pub monitor_health: bool,
    #[serde(default)]
    pub project_ids: Vec<i64>,
}
fn custom() -> String {
    "custom".into()
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub description: String,
    pub notes: String,
    pub startup: serde_json::Value,
    pub monitor_health: bool,
    pub project_ids: Vec<i64>,
    pub plan_ids: Vec<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn load(conn: &rusqlite::Connection, id: i64) -> AppResult<Profile> {
    let mut p = conn
        .query_row(
            "SELECT id, name, kind, description, notes, startup, monitor_health, created_at, updated_at FROM profiles WHERE id = ?1",
            [id],
            |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    description: r.get(3)?,
                    notes: r.get(4)?,
                    startup: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_else(|_| serde_json::json!({})),
                    monitor_health: r.get::<_, i64>(6)? != 0,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                    project_ids: vec![],
                    plan_ids: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))?;
    p.project_ids = conn
        .prepare_cached("SELECT project_id FROM profile_projects WHERE profile_id = ?1 ORDER BY project_id")?
        .query_map([id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    p.plan_ids = conn
        .prepare_cached("SELECT id FROM plans WHERE profile_id = ?1 ORDER BY id")?
        .query_map([id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(p)
}

pub fn list(db: &Db) -> AppResult<Vec<Profile>> {
    let conn = db.conn.lock();
    let ids: Vec<i64> =
        conn.prepare("SELECT id FROM profiles ORDER BY name COLLATE NOCASE")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    ids.into_iter().map(|id| load(&conn, id)).collect()
}

pub fn get(db: &Db, id: i64) -> AppResult<Profile> {
    load(&db.conn.lock(), id)
}

pub fn save(db: &Db, id: Option<i64>, input: &ProfileInput) -> AppResult<Profile> {
    let name = v::name(&input.name, "Profile name")?;
    if !KINDS.contains(&input.kind.as_str()) {
        return invalid("unknown profile type");
    }
    let description = v::text(&input.description, "Description")?;
    let notes = v::text(&input.notes, "Notes")?;
    let startup = v::metadata(&input.startup)?;
    if input.project_ids.len() > 500 {
        return invalid("too many projects");
    }
    let mut conn = db.conn.lock();
    let tx = conn.transaction()?;
    let now = now_ms();
    let res = match id {
        Some(id) => tx
            .execute(
                "UPDATE profiles SET name=?1, kind=?2, description=?3, notes=?4, startup=?5, monitor_health=?6, updated_at=?7 WHERE id=?8",
                params![name, input.kind, description, notes, startup, input.monitor_health as i64, now, id],
            )
            .map(|n| (n, id)),
        None => tx
            .execute(
                "INSERT INTO profiles(name, kind, description, notes, startup, monitor_health, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
                params![name, input.kind, description, notes, startup, input.monitor_health as i64, now],
            )
            .map(|n| (n, tx.last_insert_rowid())),
    };
    let (n, pid) = res.map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            AppError::Conflict(format!("a profile named \"{name}\" already exists"))
        }
        other => other.into(),
    })?;
    if n == 0 {
        return Err(AppError::NotFound("profile".into()));
    }
    tx.execute("DELETE FROM profile_projects WHERE profile_id = ?1", [pid])?;
    for proj in &input.project_ids {
        tx.execute(
            "INSERT OR IGNORE INTO profile_projects(profile_id, project_id) SELECT ?1, id FROM projects WHERE id = ?2",
            params![pid, proj],
        )?;
    }
    tx.commit()?;
    load(&conn, pid)
}

pub fn delete(db: &Db, id: i64) -> AppResult<()> {
    db.conn.lock().execute("DELETE FROM profiles WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::projects;

    #[test]
    fn profile_lifecycle() {
        let db = Db::open_memory();
        let proj = projects::create(
            &db,
            &projects::ProjectInput {
                name: "P".into(),
                description: String::new(),
                directory: None,
                group_id: None,
                favorite: false,
                metadata: serde_json::Value::Null,
                start_command: None,
                ports: vec![],
            },
        )
        .unwrap();
        let input = ProfileInput {
            name: "Web".into(),
            kind: "web".into(),
            description: String::new(),
            notes: "n".into(),
            startup: serde_json::json!({"order": "db, web"}),
            monitor_health: true,
            project_ids: vec![proj.id, 9999],
        };
        let p = save(&db, None, &input).unwrap();
        assert_eq!(p.project_ids, vec![proj.id], "unknown project ids are ignored");
        assert_eq!(save(&db, None, &input).unwrap_err().code(), "conflict");
        let mut bad = input.clone();
        bad.kind = "evil".into();
        assert!(save(&db, Some(p.id), &bad).is_err());
        projects::delete(&db, proj.id).unwrap();
        assert!(get(&db, p.id).unwrap().project_ids.is_empty());
        delete(&db, p.id).unwrap();
        assert!(list(&db).unwrap().is_empty());
    }
}
