//! Application settings, stored as one JSON document in the `settings`
//! table. Unknown or missing fields fall back to defaults, and every value is
//! clamped to a safe range on load and on save.

use crate::db::Db;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub general: General,
    pub monitoring: Monitoring,
    pub notifications: Notifications,
    pub history: History,
    pub ecosystem: Ecosystem,
    pub updates: Updates,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct General {
    /// `dark`, `light` or `system`
    pub theme: String,
    pub start_page: String,
    pub active_profile_id: Option<i64>,
    /// Dashboard cards the user has hidden.
    pub hidden_cards: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Monitoring {
    /// Refresh interval while the window is visible.
    pub interval_ms: u64,
    /// Refresh interval while the window is minimized or hidden.
    pub background_interval_ms: u64,
    pub include_udp: bool,
    pub paused: bool,
    /// Server health checks.
    pub health_interval_s: u64,
    pub health_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Notifications {
    /// Windows toast notifications (in-app alerts are always shown).
    pub system: bool,
    pub conflicts: bool,
    pub server_status: bool,
    pub port_changes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct History {
    pub enabled: bool,
    pub retention_days: u32,
    pub max_events: u32,
    /// Record port open/close events for every port, or only for ports that
    /// are registered, favorite, reserved or planned.
    pub record_all_ports: bool,
    /// Store executable paths in event details (off by default for privacy).
    pub store_paths: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Ecosystem {
    /// Answer IEP queries with summaries. When off, only identity is shared.
    pub iep_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Updates {
    pub check_on_start: bool,
    pub last_checked_at: Option<i64>,
    pub latest_version: Option<String>,
}

impl Default for General {
    fn default() -> Self {
        Self { theme: "dark".into(), start_page: "dashboard".into(), active_profile_id: None, hidden_cards: vec![] }
    }
}
impl Default for Monitoring {
    fn default() -> Self {
        Self {
            interval_ms: 2000,
            background_interval_ms: 10_000,
            include_udp: true,
            paused: false,
            health_interval_s: 10,
            health_timeout_ms: 1500,
        }
    }
}
impl Default for Notifications {
    fn default() -> Self {
        Self { system: true, conflicts: true, server_status: true, port_changes: false }
    }
}
impl Default for History {
    fn default() -> Self {
        Self { enabled: true, retention_days: 30, max_events: 20_000, record_all_ports: false, store_paths: false }
    }
}
impl Default for Ecosystem {
    fn default() -> Self {
        Self { iep_enabled: true }
    }
}
impl Default for Updates {
    fn default() -> Self {
        Self { check_on_start: true, last_checked_at: None, latest_version: None }
    }
}

const PAGES: &[&str] = &["dashboard", "ports", "connections", "processes", "projects", "planner", "profiles", "activity", "settings"];

impl Settings {
    /// Clamps every field into its permitted range.
    pub fn sanitized(mut self) -> Self {
        let g = &mut self.general;
        if !["dark", "light", "system"].contains(&g.theme.as_str()) {
            g.theme = "dark".into();
        }
        if !PAGES.contains(&g.start_page.as_str()) {
            g.start_page = "dashboard".into();
        }
        g.hidden_cards.retain(|c| c.len() <= 40);
        g.hidden_cards.truncate(30);
        let m = &mut self.monitoring;
        m.interval_ms = m.interval_ms.clamp(500, 60_000);
        m.background_interval_ms = m.background_interval_ms.clamp(m.interval_ms, 300_000);
        m.health_interval_s = m.health_interval_s.clamp(2, 3600);
        m.health_timeout_ms = m.health_timeout_ms.clamp(200, 10_000);
        let h = &mut self.history;
        h.retention_days = h.retention_days.clamp(1, 365);
        h.max_events = h.max_events.clamp(500, 200_000);
        self
    }

    pub fn load(db: &Db) -> Settings {
        let conn = db.conn.lock();
        let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).ok();
        raw.and_then(|s| serde_json::from_str::<Settings>(&s).ok()).unwrap_or_default().sanitized()
    }

    pub fn save(&self, db: &Db) -> AppResult<Settings> {
        let clean = self.clone().sanitized();
        let json = serde_json::to_string(&clean)?;
        db.conn
            .lock()
            .execute("INSERT INTO settings(key, value) VALUES('app', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [json])?;
        Ok(clean)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let db = Db::open_memory();
        assert_eq!(Settings::load(&db), Settings::default());
        let mut s = Settings::default();
        s.monitoring.interval_ms = 5000;
        s.save(&db).unwrap();
        assert_eq!(Settings::load(&db).monitoring.interval_ms, 5000);
    }

    #[test]
    fn values_are_clamped() {
        let mut s = Settings::default();
        s.monitoring.interval_ms = 1;
        s.monitoring.background_interval_ms = 10;
        s.history.retention_days = 0;
        s.general.theme = "neon".into();
        s.general.start_page = "../../etc".into();
        let c = s.sanitized();
        assert_eq!(c.monitoring.interval_ms, 500);
        assert_eq!(c.monitoring.background_interval_ms, 500);
        assert_eq!(c.history.retention_days, 1);
        assert_eq!(c.general.theme, "dark");
        assert_eq!(c.general.start_page, "dashboard");
    }

    #[test]
    fn partial_and_corrupt_json_fall_back() {
        let db = Db::open_memory();
        db.conn.lock().execute("INSERT INTO settings VALUES('app', '{\"monitoring\":{\"intervalMs\":3000}}')", []).unwrap();
        let s = Settings::load(&db);
        assert_eq!(s.monitoring.interval_ms, 3000);
        assert!(s.monitoring.include_udp, "missing fields use defaults");
        db.conn.lock().execute("UPDATE settings SET value = 'garbage' WHERE key = 'app'", []).unwrap();
        assert_eq!(Settings::load(&db), Settings::default());
    }
}
