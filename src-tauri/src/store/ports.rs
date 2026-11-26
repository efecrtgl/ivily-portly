//! User annotations for ports: labels, notes, categories, favorites,
//! *personal* reservations and custom ranges.
//!
//! Personal reservations exist only inside Portly. They do not stop other
//! software from binding a port. Operating-system exclusions are reported
//! separately (`net::excluded`) and are the only thing labeled "OS reserved".

use crate::db::{now_ms, Db};
use crate::error::{AppError, AppResult};
use crate::validate as v;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortNote {
    pub protocol: String,
    pub port: u16,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub updated_at: i64,
}

pub fn notes(db: &Db) -> AppResult<Vec<PortNote>> {
    let conn = db.conn.lock();
    let mut st = conn.prepare("SELECT protocol, port, label, note, category, favorite, updated_at FROM port_notes ORDER BY port")?;
    let rows = st.query_map([], |r| {
        Ok(PortNote {
            protocol: r.get(0)?,
            port: r.get::<_, i64>(1)? as u16,
            label: r.get(2)?,
            note: r.get(3)?,
            category: r.get(4)?,
            favorite: r.get::<_, i64>(5)? != 0,
            updated_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Upserts a note; an entirely empty, non-favorite note is deleted.
pub fn note_save(db: &Db, n: &PortNote) -> AppResult<Option<PortNote>> {
    let protocol = v::protocol(&n.protocol)?;
    let port = v::port(n.port as i64)?;
    let label = v::short(&n.label, "Label")?;
    let note = v::text(&n.note, "Note")?;
    let category = v::short(&n.category, "Category")?;
    let conn = db.conn.lock();
    if label.is_empty() && note.is_empty() && category.is_empty() && !n.favorite {
        conn.execute("DELETE FROM port_notes WHERE protocol = ?1 AND port = ?2", params![protocol, port])?;
        return Ok(None);
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO port_notes(protocol, port, label, note, category, favorite, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(protocol, port) DO UPDATE SET label=excluded.label, note=excluded.note, category=excluded.category, favorite=excluded.favorite, updated_at=excluded.updated_at",
        params![protocol, port, label, note, category, n.favorite as i64, now],
    )?;
    Ok(Some(PortNote { protocol: protocol.into(), port, label, note, category, favorite: n.favorite, updated_at: now }))
}

// ----------------------------------------------------------- reservations

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reservation {
    #[serde(default)]
    pub id: i64,
    #[serde(default = "tcp")]
    pub protocol: String,
    pub port_start: i64,
    pub port_end: i64,
    pub label: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
}
fn tcp() -> String {
    "tcp".into()
}

pub fn reservations(db: &Db) -> AppResult<Vec<Reservation>> {
    let conn = db.conn.lock();
    let mut st = conn
        .prepare("SELECT id, protocol, port_start, port_end, label, note, project_id, created_at FROM reservations ORDER BY port_start")?;
    let rows = st.query_map([], |r| {
        Ok(Reservation {
            id: r.get(0)?,
            protocol: r.get(1)?,
            port_start: r.get(2)?,
            port_end: r.get(3)?,
            label: r.get(4)?,
            note: r.get(5)?,
            project_id: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn reservation_save(db: &Db, r: &Reservation) -> AppResult<i64> {
    let protocol = v::protocol(&r.protocol)?;
    let (s, e) = v::port_range(r.port_start, r.port_end)?;
    if (e - s) > 1000 {
        return crate::error::invalid("a reservation can span at most 1001 ports");
    }
    let label = v::name(&r.label, "Reservation label")?;
    let note = v::text(&r.note, "Note")?;
    let conn = db.conn.lock();
    let project = match r.project_id {
        Some(p) => conn.query_row("SELECT id FROM projects WHERE id = ?1", [p], |r| r.get::<_, i64>(0)).ok(),
        None => None,
    };
    if r.id > 0 {
        let n = conn.execute(
            "UPDATE reservations SET protocol=?1, port_start=?2, port_end=?3, label=?4, note=?5, project_id=?6 WHERE id=?7",
            params![protocol, s, e, label, note, project, r.id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("reservation".into()));
        }
        Ok(r.id)
    } else {
        conn.execute(
            "INSERT INTO reservations(protocol, port_start, port_end, label, note, project_id, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![protocol, s, e, label, note, project, now_ms()],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn reservation_delete(db: &Db, id: i64) -> AppResult<()> {
    db.conn.lock().execute("DELETE FROM reservations WHERE id = ?1", [id])?;
    Ok(())
}

// ----------------------------------------------------------------- ranges

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortRange {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub port_start: i64,
    pub port_end: i64,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub created_at: i64,
}

pub fn ranges(db: &Db) -> AppResult<Vec<PortRange>> {
    let conn = db.conn.lock();
    let mut st = conn.prepare("SELECT id, name, port_start, port_end, purpose, created_at FROM port_ranges ORDER BY port_start")?;
    let rows = st.query_map([], |r| {
        Ok(PortRange {
            id: r.get(0)?,
            name: r.get(1)?,
            port_start: r.get(2)?,
            port_end: r.get(3)?,
            purpose: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn range_save(db: &Db, r: &PortRange) -> AppResult<i64> {
    let (s, e) = v::port_range(r.port_start, r.port_end)?;
    let name = v::name(&r.name, "Range name")?;
    let purpose = v::short(&r.purpose, "Purpose")?;
    let conn = db.conn.lock();
    if r.id > 0 {
        let n = conn.execute(
            "UPDATE port_ranges SET name=?1, port_start=?2, port_end=?3, purpose=?4 WHERE id=?5",
            params![name, s, e, purpose, r.id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("range".into()));
        }
        Ok(r.id)
    } else {
        conn.execute(
            "INSERT INTO port_ranges(name, port_start, port_end, purpose, created_at) VALUES (?1,?2,?3,?4,?5)",
            params![name, s, e, purpose, now_ms()],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn range_delete(db: &Db, id: i64) -> AppResult<()> {
    db.conn.lock().execute("DELETE FROM port_ranges WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_upsert_and_auto_delete() {
        let db = Db::open_memory();
        let mut n = PortNote {
            protocol: "tcp".into(),
            port: 5432,
            label: "Postgres".into(),
            note: String::new(),
            category: "database".into(),
            favorite: true,
            updated_at: 0,
        };
        assert!(note_save(&db, &n).unwrap().is_some());
        n.label = "PG".into();
        note_save(&db, &n).unwrap();
        assert_eq!(notes(&db).unwrap()[0].label, "PG");
        let empty = PortNote { label: String::new(), category: String::new(), favorite: false, ..n };
        assert!(note_save(&db, &empty).unwrap().is_none());
        assert!(notes(&db).unwrap().is_empty());
    }

    #[test]
    fn reservations_validate() {
        let db = Db::open_memory();
        let r = Reservation {
            id: 0,
            protocol: "tcp".into(),
            port_start: 3000,
            port_end: 3010,
            label: "Frontends".into(),
            note: String::new(),
            project_id: Some(42),
            created_at: 0,
        };
        let id = reservation_save(&db, &r).unwrap();
        let got = &reservations(&db).unwrap()[0];
        assert_eq!(got.project_id, None, "dangling project id dropped");
        assert!(reservation_save(&db, &Reservation { port_start: 10, port_end: 5, ..r.clone() }).is_err());
        assert!(reservation_save(&db, &Reservation { port_end: 9000, ..r.clone() }).is_err());
        assert!(reservation_save(&db, &Reservation { label: " ".into(), ..r.clone() }).is_err());
        reservation_delete(&db, id).unwrap();
        assert!(reservations(&db).unwrap().is_empty());
    }

    #[test]
    fn ranges_crud() {
        let db = Db::open_memory();
        let id = range_save(
            &db,
            &PortRange { id: 0, name: "APIs".into(), port_start: 8000, port_end: 8099, purpose: "backend".into(), created_at: 0 },
        )
        .unwrap();
        range_save(&db, &PortRange { id, name: "API".into(), port_start: 8000, port_end: 8050, purpose: String::new(), created_at: 0 })
            .unwrap();
        assert_eq!(ranges(&db).unwrap()[0].port_end, 8050);
        range_delete(&db, id).unwrap();
        assert!(ranges(&db).unwrap().is_empty());
    }
}
