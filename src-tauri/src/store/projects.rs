//! Registered local projects, their ports, groups and profiles.
//!
//! `start_command` is **descriptive metadata only**. Portly never executes
//! it; any future start/stop feature must add explicit, per-run user
//! approval and path verification (see SECURITY.md).

use crate::db::{now_ms, Db};
use crate::error::{invalid, AppError, AppResult};
use crate::validate as v;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPortInput {
    pub port: i64,
    #[serde(default = "tcp")]
    pub protocol: String,
    #[serde(default)]
    pub role: String,
    #[serde(default = "localhost")]
    pub host: String,
    #[serde(default = "tcp")]
    pub check_kind: String,
    #[serde(default = "slash")]
    pub http_path: String,
    #[serde(default)]
    pub expected_process: Option<String>,
}
fn tcp() -> String {
    "tcp".into()
}
fn localhost() -> String {
    "localhost".into()
}
fn slash() -> String {
    "/".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub group_id: Option<i64>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub start_command: Option<String>,
    #[serde(default)]
    pub ports: Vec<ProjectPortInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPort {
    pub id: i64,
    pub project_id: i64,
    pub port: u16,
    pub protocol: String,
    pub role: String,
    pub host: String,
    pub check_kind: String,
    pub http_path: String,
    pub expected_process: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub directory: Option<String>,
    pub group_id: Option<i64>,
    pub group_name: Option<String>,
    pub favorite: bool,
    pub metadata: serde_json::Value,
    pub start_command: Option<String>,
    pub ports: Vec<ProjectPort>,
    pub profile_ids: Vec<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub sort: i64,
    pub project_count: i64,
}

struct CleanPort {
    port: u16,
    protocol: &'static str,
    role: String,
    host: String,
    check_kind: &'static str,
    http_path: String,
    expected_process: Option<String>,
}

struct Clean {
    name: String,
    description: String,
    directory: Option<String>,
    group_id: Option<i64>,
    favorite: bool,
    metadata: String,
    start_command: Option<String>,
    ports: Vec<CleanPort>,
}

fn clean(input: &ProjectInput) -> AppResult<Clean> {
    if input.ports.len() > 32 {
        return invalid("a project can have at most 32 ports");
    }
    let mut ports = Vec::with_capacity(input.ports.len());
    for p in &input.ports {
        let cp = CleanPort {
            port: v::port(p.port)?,
            protocol: v::protocol(&p.protocol)?,
            role: v::short(&p.role, "Port role")?,
            host: v::local_host(&p.host)?,
            check_kind: v::check_kind(&p.check_kind)?,
            http_path: v::http_path(&p.http_path)?,
            expected_process: match p.expected_process.as_deref().map(str::trim) {
                Some(s) if !s.is_empty() => Some(v::short(s, "Expected process")?),
                _ => None,
            },
        };
        if cp.protocol == "udp" && cp.check_kind != "none" {
            return invalid(format!("port {}: UDP ports cannot be health-checked; set the check to none", cp.port));
        }
        if ports.iter().any(|x: &CleanPort| x.port == cp.port && x.protocol == cp.protocol) {
            return invalid(format!("port {}/{} is listed twice", cp.port, cp.protocol));
        }
        ports.push(cp);
    }
    let start_command = match input.start_command.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => {
            if s.chars().count() > 500 || s.chars().any(char::is_control) {
                return invalid("start command must be a single line of at most 500 characters");
            }
            Some(s.to_string())
        }
        _ => None,
    };
    Ok(Clean {
        name: v::name(&input.name, "Project name")?,
        description: v::text(&input.description, "Description")?,
        directory: match input.directory.as_deref().map(str::trim) {
            Some(d) if !d.is_empty() => Some(v::existing_dir(d)?),
            _ => None,
        },
        group_id: input.group_id,
        favorite: input.favorite,
        metadata: v::metadata(&input.metadata)?,
        start_command,
        ports,
    })
}

fn load_ports(conn: &Connection, project_id: i64) -> AppResult<Vec<ProjectPort>> {
    let mut st = conn.prepare_cached(
        "SELECT id, project_id, port, protocol, role, host, check_kind, http_path, expected_process
         FROM project_ports WHERE project_id = ?1 ORDER BY port, protocol",
    )?;
    let rows = st.query_map([project_id], row_port)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn row_port(r: &rusqlite::Row) -> rusqlite::Result<ProjectPort> {
    Ok(ProjectPort {
        id: r.get(0)?,
        project_id: r.get(1)?,
        port: r.get::<_, i64>(2)? as u16,
        protocol: r.get(3)?,
        role: r.get(4)?,
        host: r.get(5)?,
        check_kind: r.get(6)?,
        http_path: r.get(7)?,
        expected_process: r.get(8)?,
    })
}

/// Every configured port across all projects.
pub fn all_ports(db: &Db) -> AppResult<Vec<ProjectPort>> {
    let conn = db.conn.lock();
    let mut st = conn.prepare(
        "SELECT id, project_id, port, protocol, role, host, check_kind, http_path, expected_process FROM project_ports ORDER BY port",
    )?;
    let rows = st.query_map([], row_port)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn load(conn: &Connection, id: i64) -> AppResult<Project> {
    let mut p = conn
        .query_row(
            "SELECT p.id, p.name, p.description, p.directory, p.group_id, g.name, p.favorite, p.metadata, p.start_command, p.created_at, p.updated_at
             FROM projects p LEFT JOIN groups g ON g.id = p.group_id WHERE p.id = ?1",
            [id],
            |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    directory: r.get(3)?,
                    group_id: r.get(4)?,
                    group_name: r.get(5)?,
                    favorite: r.get::<_, i64>(6)? != 0,
                    metadata: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_else(|_| serde_json::json!({})),
                    start_command: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                    ports: vec![],
                    profile_ids: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("project {id}")))?;
    p.ports = load_ports(conn, id)?;
    let mut st = conn.prepare_cached("SELECT profile_id FROM profile_projects WHERE project_id = ?1")?;
    p.profile_ids = st.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(p)
}

pub fn list(db: &Db) -> AppResult<Vec<Project>> {
    let conn = db.conn.lock();
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM projects ORDER BY favorite DESC, name COLLATE NOCASE")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.into_iter().map(|id| load(&conn, id)).collect()
}

pub fn get(db: &Db, id: i64) -> AppResult<Project> {
    load(&db.conn.lock(), id)
}

fn check_group(conn: &Connection, gid: Option<i64>) -> AppResult<()> {
    if let Some(g) = gid {
        let ok: bool = conn.query_row("SELECT 1 FROM groups WHERE id = ?1", [g], |_| Ok(true)).optional()?.unwrap_or(false);
        if !ok {
            return invalid("selected group does not exist");
        }
    }
    Ok(())
}

/// Replaces a project's port list, preserving rows (and their health
/// history) whose port/protocol is unchanged.
fn sync_ports(conn: &Connection, project_id: i64, ports: &[CleanPort]) -> AppResult<()> {
    let existing = load_ports(conn, project_id)?;
    for e in &existing {
        if !ports.iter().any(|p| p.port == e.port && p.protocol == e.protocol) {
            conn.execute("DELETE FROM project_ports WHERE id = ?1", [e.id])?;
        }
    }
    for p in ports {
        conn.execute(
            "INSERT INTO project_ports(project_id, port, protocol, role, host, check_kind, http_path, expected_process)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(project_id, port, protocol) DO UPDATE SET
               role = excluded.role, host = excluded.host, check_kind = excluded.check_kind,
               http_path = excluded.http_path, expected_process = excluded.expected_process",
            params![project_id, p.port, p.protocol, p.role, p.host, p.check_kind, p.http_path, p.expected_process],
        )?;
    }
    Ok(())
}

pub fn create(db: &Db, input: &ProjectInput) -> AppResult<Project> {
    let c = clean(input)?;
    let mut conn = db.conn.lock();
    check_group(&conn, c.group_id)?;
    let tx = conn.transaction()?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO projects(name, description, directory, group_id, favorite, metadata, start_command, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![c.name, c.description, c.directory, c.group_id, c.favorite as i64, c.metadata, c.start_command, now],
    )?;
    let id = tx.last_insert_rowid();
    sync_ports(&tx, id, &c.ports)?;
    tx.commit()?;
    load(&conn, id)
}

pub fn update(db: &Db, id: i64, input: &ProjectInput) -> AppResult<Project> {
    let c = clean(input)?;
    let mut conn = db.conn.lock();
    check_group(&conn, c.group_id)?;
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE projects SET name=?1, description=?2, directory=?3, group_id=?4, favorite=?5, metadata=?6, start_command=?7, updated_at=?8 WHERE id=?9",
        params![c.name, c.description, c.directory, c.group_id, c.favorite as i64, c.metadata, c.start_command, now_ms(), id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("project {id}")));
    }
    sync_ports(&tx, id, &c.ports)?;
    tx.commit()?;
    load(&conn, id)
}

pub fn set_favorite(db: &Db, id: i64, favorite: bool) -> AppResult<()> {
    let n = db
        .conn
        .lock()
        .execute("UPDATE projects SET favorite = ?1, updated_at = ?2 WHERE id = ?3", params![favorite as i64, now_ms(), id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("project {id}")));
    }
    Ok(())
}

pub fn delete(db: &Db, id: i64) -> AppResult<()> {
    let n = db.conn.lock().execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("project {id}")));
    }
    Ok(())
}

// ---------------------------------------------------------------- groups

pub fn groups(db: &Db) -> AppResult<Vec<Group>> {
    let conn = db.conn.lock();
    let mut st = conn.prepare(
        "SELECT g.id, g.name, g.sort, (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id)
         FROM groups g ORDER BY g.sort, g.name COLLATE NOCASE",
    )?;
    let rows = st.query_map([], |r| Ok(Group { id: r.get(0)?, name: r.get(1)?, sort: r.get(2)?, project_count: r.get(3)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn group_save(db: &Db, id: Option<i64>, name: &str) -> AppResult<i64> {
    let name = v::name(name, "Group name")?;
    let conn = db.conn.lock();
    let res = match id {
        Some(id) => conn.execute("UPDATE groups SET name = ?1 WHERE id = ?2", params![name, id]).map(|_| id),
        None => conn.execute("INSERT INTO groups(name) VALUES (?1)", [&name]).map(|_| conn.last_insert_rowid()),
    };
    res.map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            AppError::Conflict(format!("a group named \"{name}\" already exists"))
        }
        other => other.into(),
    })
}

pub fn group_delete(db: &Db, id: i64) -> AppResult<()> {
    db.conn.lock().execute("DELETE FROM groups WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(p: i64) -> ProjectPortInput {
        ProjectPortInput {
            port: p,
            protocol: "tcp".into(),
            role: "web".into(),
            host: "localhost".into(),
            check_kind: "tcp".into(),
            http_path: "/".into(),
            expected_process: None,
        }
    }
    fn input(name: &str, ports: Vec<ProjectPortInput>) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            description: String::new(),
            directory: None,
            group_id: None,
            favorite: false,
            metadata: serde_json::json!({}),
            start_command: Some("npm run dev".into()),
            ports,
        }
    }

    #[test]
    fn create_update_delete() {
        let db = Db::open_memory();
        let p = create(&db, &input("Shop", vec![port(3000), port(5173)])).unwrap();
        assert_eq!(p.ports.len(), 2);
        assert_eq!(p.start_command.as_deref(), Some("npm run dev"));
        let kept_id = p.ports.iter().find(|x| x.port == 3000).unwrap().id;
        let p2 = update(&db, p.id, &input("Shop 2", vec![port(3000), port(8080)])).unwrap();
        assert_eq!(p2.name, "Shop 2");
        assert_eq!(p2.ports.iter().map(|x| x.port).collect::<Vec<_>>(), vec![3000, 8080]);
        assert_eq!(p2.ports[0].id, kept_id, "unchanged port row is preserved");
        delete(&db, p.id).unwrap();
        assert!(get(&db, p.id).is_err());
        assert!(all_ports(&db).unwrap().is_empty(), "ports cascade");
    }

    #[test]
    fn validation() {
        let db = Db::open_memory();
        assert!(create(&db, &input("", vec![])).is_err());
        assert!(create(&db, &input("Dup", vec![port(3000), port(3000)])).is_err());
        let mut bad = port(3000);
        bad.host = "10.0.0.1".into();
        assert!(create(&db, &input("Remote", vec![bad])).is_err());
        let mut udp = port(5353);
        udp.protocol = "udp".into();
        assert!(create(&db, &input("Udp", vec![udp.clone()])).is_err());
        udp.check_kind = "none".into();
        assert!(create(&db, &input("Udp", vec![udp])).is_ok());
        let mut i = input("BadDir", vec![]);
        i.directory = Some("Z:\\definitely\\missing\\dir".into());
        assert!(create(&db, &i).is_err());
        let mut i = input("BadCmd", vec![]);
        i.start_command = Some("a\nb".into());
        assert!(create(&db, &i).is_err());
    }

    #[test]
    fn groups_and_favorites() {
        let db = Db::open_memory();
        let g = group_save(&db, None, "Work").unwrap();
        assert_eq!(group_save(&db, None, "work").unwrap_err().code(), "conflict");
        let mut i = input("A", vec![]);
        i.group_id = Some(g);
        let p = create(&db, &i).unwrap();
        assert_eq!(p.group_name.as_deref(), Some("Work"));
        set_favorite(&db, p.id, true).unwrap();
        assert!(get(&db, p.id).unwrap().favorite);
        assert_eq!(groups(&db).unwrap()[0].project_count, 1);
        group_delete(&db, g).unwrap();
        assert_eq!(get(&db, p.id).unwrap().group_id, None);
        i.group_id = Some(999);
        assert!(create(&db, &i).is_err());
    }
}
