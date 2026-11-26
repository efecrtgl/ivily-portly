//! Ivily Portly backend. See `docs/ARCHITECTURE.md` for the module map.

pub mod commands;
pub mod conflicts;
pub mod db;
pub mod error;
pub mod exchange;
pub mod health;
pub mod iep;
pub mod insight;
pub mod monitor;
pub mod net;
pub mod planner;
pub mod process;
pub mod settings;
pub mod state;
pub mod store;
pub mod validate;

use std::sync::Arc;
use tauri::Manager;

pub const APP_NAME: &str = "Ivily Portly";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::AppState::init())
        .setup(|app| {
            let st = app.state::<state::AppState>();
            let sink = Arc::new(state::TauriSink { app: app.handle().clone() });
            st.monitor.start(sink);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::db_backup,
            commands::db_backups,
            commands::db_restore,
            commands::open_data_dir,
            commands::monitor_snapshot,
            commands::monitor_conflicts,
            commands::monitor_health,
            commands::monitor_refresh,
            commands::monitor_set_visible,
            commands::exclusions_get,
            commands::process_inspect,
            commands::process_icons,
            commands::process_open_location,
            commands::project_open_dir,
            commands::process_terminate,
            commands::port_check,
            commands::port_check_many,
            commands::port_suggest,
            commands::port_detail,
            commands::port_notes,
            commands::port_note_save,
            commands::reservations_list,
            commands::reservation_save,
            commands::reservation_delete,
            commands::ranges_list,
            commands::range_save,
            commands::range_delete,
            commands::projects_list,
            commands::project_save,
            commands::project_delete,
            commands::project_favorite,
            commands::groups_list,
            commands::group_save,
            commands::group_delete,
            commands::health_history,
            commands::profiles_list,
            commands::profile_save,
            commands::profile_delete,
            commands::profile_activate,
            commands::plans_list,
            commands::plan_save,
            commands::plan_delete,
            commands::plan_validate,
            commands::plan_export,
            commands::events_list,
            commands::events_clear,
            commands::activity_stats,
            commands::settings_get,
            commands::settings_update,
            commands::settings_reset,
            commands::update_record,
            commands::config_export,
            commands::config_import,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Ivily Portly");
}
