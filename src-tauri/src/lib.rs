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

#[tauri::command]
async fn list_ollama_models(base_url: String) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|_| format!("Cannot reach Ollama at {} — make sure ollama serve is running", base_url))?;
    if !res.status().is_success() {
        return Err(format!("Ollama returned status {}", res.status().as_u16()));
    }
    #[derive(serde::Deserialize)]
    struct OllamaModel { name: String }
    #[derive(serde::Deserialize)]
    struct OllamaTagsResp { models: Vec<OllamaModel> }
    let data: OllamaTagsResp = res.json().await.map_err(|e| e.to_string())?;
    Ok(data.models.into_iter().map(|m| m.name).collect())
}

#[tauri::command]
async fn preload_ollama_model(base_url: String, model: String) -> Result<(), String> {
    let url = format!("{}/api/generate", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "model": model, "keep_alive": "10m" });
    let res = client.post(&url).json(&body).send().await
        .map_err(|_| format!("Cannot reach Ollama at {}", base_url))?;
    if !res.status().is_success() {
        return Err(format!("Ollama error {}", res.status().as_u16()));
    }
    Ok(())
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
            session::manager::compute_ideal_lap,
            ai::commands::query_ai,
            ai::commands::auto_analyze,
            open_url,
            list_ollama_models,
            preload_ollama_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
