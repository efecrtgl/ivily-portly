//! Versioned schema migrations. Each step runs in a transaction and bumps
//! `PRAGMA user_version`. Never edit a released migration — append a new one.

use rusqlite::Connection;

pub const SCHEMA_VERSION: i64 = 1;

const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE groups (
        id    INTEGER PRIMARY KEY,
        name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
        sort  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE projects (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        directory     TEXT,
        group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        favorite      INTEGER NOT NULL DEFAULT 0,
        metadata      TEXT NOT NULL DEFAULT '{}',
        start_command TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );

    CREATE TABLE project_ports (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        port         INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        protocol     TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp','udp')),
        role         TEXT NOT NULL DEFAULT '',
        host         TEXT NOT NULL DEFAULT 'localhost',
        check_kind   TEXT NOT NULL DEFAULT 'tcp' CHECK (check_kind IN ('none','tcp','http')),
        http_path    TEXT NOT NULL DEFAULT '/',
        expected_process TEXT,
        UNIQUE (project_id, port, protocol)
    );
    CREATE INDEX project_ports_port ON project_ports(port, protocol);

    CREATE TABLE profiles (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        kind        TEXT NOT NULL DEFAULT 'custom',
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        startup     TEXT NOT NULL DEFAULT '{}',
        monitor_health INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    CREATE TABLE profile_projects (
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (profile_id, project_id)
    );

    CREATE TABLE port_notes (
        protocol   TEXT NOT NULL CHECK (protocol IN ('tcp','udp')),
        port       INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        label      TEXT NOT NULL DEFAULT '',
        note       TEXT NOT NULL DEFAULT '',
        category   TEXT NOT NULL DEFAULT '',
        favorite   INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (protocol, port)
    );

    CREATE TABLE reservations (
        id         INTEGER PRIMARY KEY,
        protocol   TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp','udp')),
        port_start INTEGER NOT NULL CHECK (port_start BETWEEN 1 AND 65535),
        port_end   INTEGER NOT NULL CHECK (port_end BETWEEN port_start AND 65535),
        label      TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE port_ranges (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        port_start INTEGER NOT NULL CHECK (port_start BETWEEN 1 AND 65535),
        port_end   INTEGER NOT NULL CHECK (port_end BETWEEN port_start AND 65535),
        purpose    TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
    );

    CREATE TABLE plans (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        profile_id  INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    CREATE TABLE plan_entries (
        id       INTEGER PRIMARY KEY,
        plan_id  INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        service  TEXT NOT NULL,
        kind     TEXT NOT NULL DEFAULT 'custom',
        port     INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        protocol TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp','udp')),
        host     TEXT NOT NULL DEFAULT 'localhost',
        note     TEXT NOT NULL DEFAULT '',
        sort     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE events (
        id         INTEGER PRIMARY KEY,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        severity   TEXT NOT NULL DEFAULT 'info',
        protocol   TEXT,
        port       INTEGER,
        pid        INTEGER,
        process    TEXT,
        project_id INTEGER,
        message    TEXT NOT NULL,
        data       TEXT
    );
    CREATE INDEX events_ts ON events(ts);
    CREATE INDEX events_kind ON events(kind, ts);
    CREATE INDEX events_port ON events(port, ts);

    CREATE TABLE health_samples (
        project_port_id INTEGER NOT NULL REFERENCES project_ports(id) ON DELETE CASCADE,
        ts         INTEGER NOT NULL,
        status     TEXT NOT NULL,
        latency_ms INTEGER
    );
    CREATE INDEX health_samples_pp ON health_samples(project_port_id, ts);

    CREATE TABLE inspections (
        pid        INTEGER NOT NULL,
        name       TEXT NOT NULL,
        start_time INTEGER,
        ts         INTEGER NOT NULL,
        PRIMARY KEY (pid, name)
    );
    "#,
];

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    migrate_to(conn, SCHEMA_VERSION)
}

pub fn migrate_to(conn: &mut Connection, target: i64) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if version <= current || version > target {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        migrate(&mut c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert_eq!(MIGRATIONS.len() as i64, SCHEMA_VERSION);
    }

    #[test]
    fn constraints_reject_bad_ports() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&mut c).unwrap();
        assert!(c.execute("INSERT INTO port_notes(protocol, port, updated_at) VALUES('tcp', 70000, 0)", []).is_err());
        assert!(c.execute("INSERT INTO reservations(port_start, port_end, label, created_at) VALUES(10, 5, 'x', 0)", []).is_err());
        assert!(c.execute("INSERT INTO project_ports(project_id, port) VALUES(999, 80)", []).is_err(), "FK enforced");
    }
}
