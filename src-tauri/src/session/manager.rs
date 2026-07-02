use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use crate::ibt::{IbtFile, Session, Lap, LapChannelData};

pub struct AppState {
    pub sessions: Mutex<HashMap<String, (Session, Vec<u8>)>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState { sessions: Mutex::new(HashMap::new()) }
    }
}

pub fn iracing_telemetry_dir() -> PathBuf {
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("iRacing")
        .join("telemetry")
}

fn latest_ibt_in_dir(dir: &PathBuf) -> Option<PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "ibt").unwrap_or(false))
        .collect();
    files.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    files.last().map(|e| e.path())
}

fn load_session_from_path(
    state: &State<AppState>,
    path: String,
) -> Result<Session, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ibt = IbtFile::open(&path)?;
    let session = ibt.parse_session(path.clone())?;
    let id = session.id.clone();
    state.sessions.lock().unwrap().insert(id, (session.clone(), data));
    Ok(session)
}

#[tauri::command]
pub fn get_latest_session(state: State<AppState>) -> Result<Session, String> {
    let dir = iracing_telemetry_dir();
    let path = latest_ibt_in_dir(&dir)
        .ok_or_else(|| format!("No .ibt files found in {:?}", dir))?;
    load_session_from_path(&state, path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_session(state: State<AppState>, path: String) -> Result<Session, String> {
    load_session_from_path(&state, path)
}

#[tauri::command]
pub fn get_lap_channel_data(
    state: State<AppState>,
    session_id: String,
    lap_numbers: Vec<i32>,
    channel: String,
) -> Result<Vec<LapChannelData>, String> {
    let sessions = state.sessions.lock().unwrap();
    let (session, raw) = sessions.get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    // Write raw bytes to a temp file and re-open as IbtFile to parse channel data
    let tmp_path = std::env::temp_dir().join("__iracing_tmp.ibt");
    std::fs::write(&tmp_path, raw).map_err(|e| e.to_string())?;
    let ibt = IbtFile::open(&tmp_path)?;

    let results: Vec<LapChannelData> = session.laps.iter()
        .filter(|l| lap_numbers.contains(&l.lap_number))
        .filter_map(|lap| ibt.get_lap_channel_data(lap, &channel))
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn get_telemetry_folder() -> String {
    iracing_telemetry_dir().to_string_lossy().to_string()
}
