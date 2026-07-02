use crate::ai::provider::AiMessage;

pub async fn stream_gemini(
    _api_key: &str,
    _model: &str,
    _messages: Vec<AiMessage>,
    _on_token: impl FnMut(String),
) -> Result<(), String> {
    Err("Gemini provider not yet configured".into())
}
