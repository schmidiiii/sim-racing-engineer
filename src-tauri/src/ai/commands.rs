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
    language: String,
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

    let lang_name = match language.as_str() {
        "de" => "German (Deutsch)",
        "fr" => "French (Français)",
        "es" => "Spanish (Español)",
        "it" => "Italian (Italiano)",
        "pt" => "Portuguese (Português)",
        "nl" => "Dutch (Nederlands)",
        "pl" => "Polish (Polski)",
        "ru" => "Russian (Русский)",
        "ja" => "Japanese (日本語)",
        "zh" => "Chinese (中文)",
        _ => "English",
    };

    let system_msg = AiMessage {
        role: "system".into(),
        content: format!(
            "You are the driver's personal race engineer for iRacing sim-racing. \
             Your tone is professional, direct, data-driven, and constructively critical — \
             no filler praise, no hedging. You hunt for tenths left on track. \
             Use motorsport vocabulary: trail-braking, apex, throttle application, rotation, \
             understeer, oversteer, track limits, minimum speed, brake bias. \
             When referencing corners, use the OFFICIAL turn numbers from your knowledge of the circuit, \
             combined with the corner name: e.g. T3 (Raidillon), T1 (La Source), T10 (Bruxelles). \
             Only use the corner name if you are uncertain about the official turn number. \
             You MUST respond ONLY in {lang_name}. \
             Never switch language regardless of what language the data is written in.",
        ),
    };

    let prompt = build_analysis_prompt(&session, &stats, &language);
    let messages = vec![
        system_msg,
        AiMessage { role: "user".into(), content: prompt },
    ];

    dispatch_stream(provider, messages, app, event_id).await
}
