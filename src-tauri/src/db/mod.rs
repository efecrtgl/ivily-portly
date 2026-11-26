//! SQLite persistence: opening, integrity checks, migrations, backup and
//! recovery.
//!
//! Safety rules:
//! - Before migrating an existing database to a newer schema, a copy is
//!   written to `backups/` (`VACUUM INTO`), so an upgrade can never lose data.
//! - A database that fails `quick_check` is moved aside (never deleted) and a
//!   fresh one is created; the UI is told about the recovery.
//! - A database created by a *newer* Portly is never modified; the app runs
//!   on an in-memory database and reports a degraded state instead.

mod schema;

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub use schema::SCHEMA_VERSION;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbStatus {
    pub path: String,
    pub schema_version: i64,
    pub expected_schema_version: i64,
    /// `ok`, `recovered`, `newer-schema`, `memory-fallback`
    pub state: String,
    pub message: Option<String>,
    pub pre_migration_backup: Option<String>,
    pub size_bytes: u64,
}

pub struct Db {
    pub conn: Mutex<Connection>,
    pub status: Mutex<DbStatus>,
    pub dir: PathBuf,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(())
}

fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
}

fn quick_check(conn: &Connection) -> bool {
    conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)).map(|s| s == "ok").unwrap_or(false)
}

/// Writes a consistent copy of the live database to `dest`.
pub fn vacuum_into(conn: &Connection, dest: &Path) -> AppResult<()> {
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy()])?;
    Ok(())
}

fn stamp() -> String {
    now_ms().to_string()
}

impl Db {
    /// Opens (or creates) `dir/portly.db` applying the safety rules above.
    pub fn open(dir: &Path) -> AppResult<Db> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("portly.db");
        let mut status = DbStatus {
            path: path.to_string_lossy().into_owned(),
            expected_schema_version: SCHEMA_VERSION,
            state: "ok".into(),
            ..Default::default()
        };

        let existed = path.exists();
        let mut conn = match Connection::open(&path) {
            Ok(c) => c,
            Err(e) => return Self::fallback(dir, status, format!("could not open database: {e}")),
        };

        if existed && !quick_check(&conn) {
            drop(conn);
            let aside = dir.join(format!("portly.corrupt-{}.db", stamp()));
            std::fs::rename(&path, &aside)?;
            for ext in ["-wal", "-shm"] {
                let side = PathBuf::from(format!("{}{ext}", path.display()));
                if side.exists() {
                    let _ = std::fs::rename(&side, format!("{}{ext}", aside.display()));
                }
            }
            status.state = "recovered".into();
            status.message =
                Some(format!("The database failed an integrity check and was moved to {}. A new database was created.", aside.display()));
            conn = Connection::open(&path)?;
        }
        configure(&conn)?;

        let version = user_version(&conn)?;
        if version > SCHEMA_VERSION {
            drop(conn);
            let mut st = status;
            st.schema_version = version;
            st.state = "newer-schema".into();
            st.message = Some(format!(
                "This database was created by a newer Ivily Portly (schema {version}). It was left untouched; changes in this session are not saved. Please update Portly."
            ));
            return Self::memory(dir, st);
        }
        if existed && version > 0 && version < SCHEMA_VERSION {
            let backups = dir.join("backups");
            std::fs::create_dir_all(&backups)?;
            let dest = backups.join(format!("portly-pre-v{SCHEMA_VERSION}-{}.db", stamp()));
            vacuum_into(&conn, &dest)?;
            status.pre_migration_backup = Some(dest.to_string_lossy().into_owned());
        }
        schema::migrate(&mut conn)?;
        status.schema_version = user_version(&conn)?;
        status.size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(Db { conn: Mutex::new(conn), status: Mutex::new(status), dir: dir.to_path_buf() })
    }

    fn fallback(dir: &Path, mut st: DbStatus, msg: String) -> AppResult<Db> {
        st.state = "memory-fallback".into();
        st.message = Some(format!("{msg}. Running without persistence for this session."));
        Self::memory(dir, st)
    }

    fn memory(dir: &Path, mut st: DbStatus) -> AppResult<Db> {
        let mut conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        schema::migrate(&mut conn)?;
        if st.schema_version == 0 {
            st.schema_version = SCHEMA_VERSION;
        }
        Ok(Db { conn: Mutex::new(conn), status: Mutex::new(st), dir: dir.to_path_buf() })
    }

    /// In-memory database for tests.
    pub fn open_memory() -> Db {
        let mut conn = Connection::open_in_memory().expect("memory db");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        schema::migrate(&mut conn).expect("migrate");
        Db {
            conn: Mutex::new(conn),
            status: Mutex::new(DbStatus {
                state: "ok".into(),
                schema_version: SCHEMA_VERSION,
                expected_schema_version: SCHEMA_VERSION,
                ..Default::default()
            }),
            dir: std::env::temp_dir(),
        }
    }

    pub fn is_persistent(&self) -> bool {
        matches!(self.status.lock().state.as_str(), "ok" | "recovered")
    }

    pub fn status(&self) -> DbStatus {
        let mut s = self.status.lock().clone();
        if let Ok(m) = std::fs::metadata(&s.path) {
            s.size_bytes = m.len();
        }
        s
    }

    /// Writes a backup to `dest` (a user-chosen path or the backups folder).
    pub fn backup_to(&self, dest: &Path) -> AppResult<()> {
        let conn = self.conn.lock();
        vacuum_into(&conn, dest)
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.dir.join("backups")
    }

    /// Validates that `src` is a Portly database this version can read and
    /// replaces the live database with it. The current database is backed up
    /// first. Migrations run on the restored copy.
    pub fn restore_from(&self, src: &Path) -> AppResult<String> {
        let probe = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| AppError::Invalid(format!("not a readable SQLite file: {e}")))?;
        if !quick_check(&probe) {
            return Err(AppError::Invalid("the selected backup failed an integrity check".into()));
        }
        let v = user_version(&probe)?;
        if v == 0 || v > SCHEMA_VERSION {
            return Err(AppError::Invalid(format!(
                "the selected file is not a compatible Ivily Portly database (schema {v}, supported 1–{SCHEMA_VERSION})"
            )));
        }
        let has_marker: bool =
            probe.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'", [], |_| Ok(true)).unwrap_or(false);
        if !has_marker {
            return Err(AppError::Invalid("the selected file is not an Ivily Portly database".into()));
        }
        drop(probe);

        let backups = self.backups_dir();
        std::fs::create_dir_all(&backups)?;
        let safety = backups.join(format!("portly-before-restore-{}.db", stamp()));
        let mut conn = self.conn.lock();
        vacuum_into(&conn, &safety)?;
        // Copy restored data into the live connection via the backup API
        // equivalent: attach + replace table contents would be fragile, so we
        // swap files and reopen.
        let live = PathBuf::from(&self.status.lock().path);
        let tmp = Connection::open_in_memory()?;
        *conn = tmp; // closes the live file
        std::fs::copy(src, &live)?;
        for ext in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{ext}", live.display()));
            let _ = std::fs::remove_file(side);
        }
        let mut reopened = Connection::open(&live)?;
        configure(&reopened)?;
        schema::migrate(&mut reopened)?;
        *conn = reopened;
        let mut st = self.status.lock();
        st.schema_version = SCHEMA_VERSION;
        st.state = "ok".into();
        st.message = None;
        Ok(safety.to_string_lossy().into_owned())
    }

    /// Lists automatic and manual backups in the backups folder.
    pub fn list_backups(&self) -> Vec<BackupFile> {
        let mut out: Vec<BackupFile> = std::fs::read_dir(self.backups_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                (p.extension()? == "db").then(|| {
                    let m = e.metadata().ok();
                    BackupFile {
                        name: p.file_name().unwrap().to_string_lossy().into_owned(),
                        path: p.to_string_lossy().into_owned(),
                        size_bytes: m.as_ref().map(|m| m.len()).unwrap_or(0),
                        modified: m
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0),
                    }
                })
            })
            .collect();
        out.sort_by_key(|b| std::cmp::Reverse(b.modified));
        out
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified: i64,
}

/// Applies the full schema to a raw connection (test helper).
#[cfg(test)]
pub fn schema_for_tests(conn: &mut Connection) {
    schema::migrate(conn).expect("migrate");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        {
            let db = Db::open(dir.path()).unwrap();
            assert_eq!(db.status().state, "ok");
            db.conn.lock().execute("INSERT INTO projects(name, created_at, updated_at) VALUES('a', 0, 0)", []).unwrap();
        }
        let db = Db::open(dir.path()).unwrap();
        let n: i64 = db.conn.lock().query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(db.status().schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn corrupt_database_is_moved_aside_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("portly.db"), b"this is definitely not sqlite, just garbage bytes......").unwrap();
        let db = Db::open(dir.path()).unwrap();
        assert_eq!(db.status().state, "recovered");
        let aside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("portly.corrupt-"))
            .collect();
        assert_eq!(aside.len(), 1);
    }

    #[test]
    fn newer_schema_is_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        {
            let c = Connection::open(dir.path().join("portly.db")).unwrap();
            c.execute_batch("CREATE TABLE future(x); PRAGMA user_version = 999;").unwrap();
        }
        let db = Db::open(dir.path()).unwrap();
        assert_eq!(db.status().state, "newer-schema");
        assert!(!db.is_persistent());
        let c = Connection::open(dir.path().join("portly.db")).unwrap();
        assert_eq!(user_version(&c).unwrap(), 999);
    }

    #[test]
    fn older_schema_is_backed_up_before_migration() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut c = Connection::open(dir.path().join("portly.db")).unwrap();
            schema::migrate_to(&mut c, 1).unwrap();
            c.execute("INSERT INTO projects(name, created_at, updated_at) VALUES('keep', 0, 0)", []).unwrap();
        }
        let db = Db::open(dir.path()).unwrap();
        let st = db.status();
        if SCHEMA_VERSION > 1 {
            let b = st.pre_migration_backup.expect("backup written");
            assert!(Path::new(&b).exists());
        }
        let name: String = db.conn.lock().query_row("SELECT name FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "keep");
    }

    #[test]
    fn backup_and_restore_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path()).unwrap();
        db.conn.lock().execute("INSERT INTO projects(name, created_at, updated_at) VALUES('one', 0, 0)", []).unwrap();
        let bk = dir.path().join("manual.db");
        db.backup_to(&bk).unwrap();
        db.conn.lock().execute("DELETE FROM projects", []).unwrap();
        let safety = db.restore_from(&bk).unwrap();
        assert!(Path::new(&safety).exists());
        let n: i64 = db.conn.lock().query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(!db.list_backups().is_empty());
    }

    #[test]
    fn restore_rejects_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path()).unwrap();
        let other = dir.path().join("other.db");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE x(y); PRAGMA user_version=1;").unwrap();
        assert_eq!(db.restore_from(&other).unwrap_err().code(), "invalid");
        let junk = dir.path().join("junk.db");
        std::fs::write(&junk, b"nope").unwrap();
        assert!(db.restore_from(&junk).is_err());
    }
}
