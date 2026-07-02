use crate::ai::provider::AiMessage;

pub async fn stream_openai(
    _api_key: &str,
    _model: &str,
    _messages: Vec<AiMessage>,
    _on_token: impl FnMut(String),
) -> Result<(), String> {
    Err("OpenAI provider not yet configured".into())
}
