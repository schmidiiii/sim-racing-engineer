use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use crate::ibt::{IbtFile, Session, LapChannelData};

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

fn load_from_path(state: &State<AppState>, path: String) -> Result<Session, String> {
    // Read file once, parse from bytes — no double-read
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ibt = IbtFile::from_bytes(data.clone())?;
    let session = ibt.parse_session(path)?;
    let id = session.id.clone();
    state.sessions.lock().unwrap().insert(id, (session.clone(), data));
    Ok(session)
}

#[tauri::command]
pub fn get_latest_session(state: State<AppState>) -> Result<Session, String> {
    let dir = iracing_telemetry_dir();
    let path = latest_ibt_in_dir(&dir)
        .ok_or_else(|| format!("No .ibt files found in {:?}", dir))?;
    load_from_path(&state, path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_session(state: State<AppState>, path: String) -> Result<Session, String> {
    load_from_path(&state, path)
}

#[tauri::command]
pub fn get_lap_channel_data(
    state: State<AppState>,
    session_id: String,
    lap_numbers: Vec<i32>,
    channel: String,
) -> Result<Vec<LapChannelData>, String> {
    // Clone data under the lock, then drop the lock before doing any I/O or parsing
    let (session, raw) = {
        let sessions = state.sessions.lock().unwrap();
        let (s, r) = sessions.get(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        (s.clone(), r.clone())
    }; // lock released here

    let ibt = IbtFile::from_bytes(raw)?;

    let results: Vec<LapChannelData> = session.laps.iter()
        .filter(|l| lap_numbers.contains(&l.lap_number))
        .filter_map(|lap| ibt.get_lap_channel_data(lap, &channel))
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn get_session_yaml(state: State<AppState>, session_id: String) -> Result<String, String> {
    let raw = {
        let sessions = state.sessions.lock().unwrap();
        let (_, r) = sessions.get(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        r.clone()
    };
    let ibt = IbtFile::from_bytes(raw)?;
    Ok(ibt.session_info_yaml())
}

#[tauri::command]
pub fn get_telemetry_folder() -> String {
    iracing_telemetry_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn compute_ideal_lap(
    state: State<AppState>,
    session_id: String,
    lap_numbers: Vec<i32>,
) -> Result<f64, String> {
    const N: usize = 50;

    let (session, raw) = {
        let sessions = state.sessions.lock().unwrap();
        let (s, r) = sessions.get(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        (s.clone(), r.clone())
    };

    let ibt = IbtFile::from_bytes(raw)?;
    let mut min_sector_times = vec![f64::INFINITY; N];
    let mut found = false;

    for lap in session.laps.iter().filter(|l| lap_numbers.contains(&l.lap_number) && l.is_valid && l.lap_time > 10.0) {
        let Some(data) = ibt.get_lap_channel_data(lap, "Speed") else { continue };

        let mut t_start = vec![f64::INFINITY; N];
        let mut t_end   = vec![f64::NEG_INFINITY; N];

        for (&dist, &t) in data.lap_dist_pct.iter().zip(data.timestamps.iter()) {
            let s = ((dist * N as f64).floor() as usize).min(N - 1);
            if t < t_start[s] { t_start[s] = t; }
            if t > t_end[s]   { t_end[s]   = t; }
        }

        if t_start.iter().any(|v| !v.is_finite()) { continue; }

        found = true;
        for s in 0..N {
            let dt = t_end[s] - t_start[s];
            if dt < min_sector_times[s] { min_sector_times[s] = dt; }
        }
    }

    if !found { return Err("No valid laps".to_string()); }
    Ok(min_sector_times.iter().sum())
}
