//! Shared application state and the Tauri event sink.

use crate::conflicts::{Conflict, HealthState};
use crate::db::Db;
use crate::monitor::model::Snapshot;
use crate::monitor::{Monitor, Sink};
use crate::store::events::NewEvent;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct AppState {
    pub db: Arc<Db>,
    pub monitor: Arc<Monitor>,
    pub data_dir: PathBuf,
    /// Executable path → PNG data URL (or None when no icon).
    pub icons: Mutex<HashMap<String, Option<String>>>,
}

pub fn data_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("IvilyPortly")
}

impl AppState {
    pub fn init() -> AppState {
        let dir = data_dir();
        let db = match Db::open(&dir) {
            Ok(db) => db,
            Err(e) => {
                // Last resort: in-memory so the UI can still explain what happened.
                let db = Db::open_memory();
                {
                    let mut st = db.status.lock();
                    st.state = "memory-fallback".into();
                    st.message = Some(format!("The database could not be opened ({e}). Running without persistence."));
                    st.path = dir.join("portly.db").to_string_lossy().into_owned();
                }
                db
            }
        };
        let db = Arc::new(db);
        let monitor = Monitor::new(db.clone());
        AppState { db, monitor, data_dir: dir, icons: Mutex::new(HashMap::new()) }
    }

    pub fn icon_for(&self, path: &str) -> Option<String> {
        if let Some(v) = self.icons.lock().get(path) {
            return v.clone();
        }
        let v = crate::process::icon::icon_data_url(path);
        let mut cache = self.icons.lock();
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(path.to_string(), v.clone());
        v
    }
}

pub struct TauriSink {
    pub app: AppHandle,
}

impl Sink for TauriSink {
    fn snapshot(&self, s: &Snapshot) {
        let _ = self.app.emit("portly://snapshot", s);
    }
    fn conflicts(&self, c: &[Conflict]) {
        let _ = self.app.emit("portly://conflicts", c);
    }
    fn health(&self, h: &HashMap<i64, HealthState>) {
        let _ = self.app.emit("portly://health", h);
    }
    fn event(&self, e: &NewEvent) {
        let _ = self.app.emit("portly://event", e);
    }
    fn notify(&self, title: &str, body: &str) {
        use tauri_plugin_notification::NotificationExt;
        let _ = self.app.notification().builder().title(title).body(body).show();
    }
}
