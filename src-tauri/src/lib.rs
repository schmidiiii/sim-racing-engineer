mod ibt;
mod session;
mod ai;

#[tauri::command]
fn open_url(url: String) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/c", "start", "", &url]).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

use session::manager::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = session::manager::iracing_telemetry_dir();
            session::watcher::start_watcher(app.handle().clone(), dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::manager::get_latest_session,
            session::manager::load_session,
            session::manager::get_lap_channel_data,
            session::manager::get_telemetry_folder,
            session::manager::get_session_yaml,
            ai::commands::query_ai,
            ai::commands::auto_analyze,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
