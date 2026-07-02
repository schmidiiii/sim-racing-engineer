use tauri::{AppHandle, Emitter, State};
use crate::ai::provider::{AiMessage, ProviderConfig};
use crate::ai::context::build_analysis_prompt;
use crate::session::manager::AppState;

const ANALYSIS_CHANNELS: &[&str] = &[
    "Speed", "Throttle", "Brake", "SteeringWheelAngle", "Gear",
];

async fn dispatch_stream(
    provider: ProviderConfig,
    messages: Vec<AiMessage>,
    app: AppHandle,
    event_id: String,
) -> Result<(), String> {
    let app2 = app.clone();
    let id2 = event_id.clone();

    let emit_token = move |tok: String| {
        let _ = app2.emit(&format!("ai-token-{}", id2), tok);
    };

    match provider {
        ProviderConfig::Ollama { base_url, model } => {
            crate::ai::ollama::stream_ollama(&base_url, &model, messages, emit_token).await?;
        }
        ProviderConfig::OpenAI { api_key, model } => {
            crate::ai::openai::stream_openai(&api_key, &model, messages, emit_token).await?;
        }
        ProviderConfig::Gemini { api_key, model } => {
            crate::ai::gemini::stream_gemini(&api_key, &model, messages, emit_token).await?;
        }
    }

    let _ = app.emit(&format!("ai-done-{}", event_id), ());
    Ok(())
}

#[tauri::command]
pub async fn query_ai(
    app: AppHandle,
    _state: State<'_, AppState>,
    provider: ProviderConfig,
    messages: Vec<AiMessage>,
    event_id: String,
) -> Result<(), String> {
    dispatch_stream(provider, messages, app, event_id).await
}

#[tauri::command]
pub async fn auto_analyze(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: ProviderConfig,
    event_id: String,
) -> Result<(), String> {
    let (session, raw) = {
        let sessions = state.sessions.lock().unwrap();
        let (s, r) = sessions.get(&session_id)
            .ok_or("Session not found")?;
        (s.clone(), r.clone())
    };

    let ibt = crate::ibt::IbtFile::from_bytes(raw)?;

    let stats: Vec<_> = session.laps.iter()
        .map(|lap| ibt.compute_lap_stats(lap, ANALYSIS_CHANNELS))
        .collect();

    let prompt = build_analysis_prompt(&session, &stats);
    let messages = vec![AiMessage { role: "user".into(), content: prompt }];

    dispatch_stream(provider, messages, app, event_id).await
}
