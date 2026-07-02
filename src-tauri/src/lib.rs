mod ibt;
mod session;
mod ai;

use session::manager::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
