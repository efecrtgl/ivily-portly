// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // IEP: answer `--iep describe|request` without opening a window or taking
    // the single-instance lock, then exit (see docs/IEP.md).
    if let Some(code) = portly_lib::iep::maybe_run_from_args(&portly_lib::state::data_dir()) {
        std::process::exit(code);
    }
    portly_lib::run()
}
