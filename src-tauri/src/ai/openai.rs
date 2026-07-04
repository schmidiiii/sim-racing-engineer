use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use crate::ai::provider::AiMessage;

#[derive(Deserialize)]
struct Choice {
    delta: Delta,
}

#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatChunk {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct OpenAiError {
    error: OpenAiErrorDetail,
}

#[derive(Deserialize)]
struct OpenAiErrorDetail {
    message: String,
    code: Option<String>,
}

fn friendly_openai_error(status: u16, body: &str) -> String {
    if let Ok(e) = serde_json::from_str::<OpenAiError>(body) {
        let code = e.error.code.as_deref().unwrap_or("");
        return match code {
            "insufficient_quota" =>
                "OpenAI quota exceeded — add credits at platform.openai.com/settings/billing".to_string(),
            "invalid_api_key" =>
                "Invalid OpenAI API key — check your key at platform.openai.com/api-keys".to_string(),
            "rate_limit_exceeded" =>
                "OpenAI rate limit — wait a moment and try again".to_string(),
            _ => format!("OpenAI error {}: {}", status, e.error.message),
        };
    }
    format!("OpenAI error {} — check your API key and billing", status)
}

pub async fn stream_openai(
    api_key: &str,
    model: &str,
    messages: Vec<AiMessage>,
    mut on_token: impl FnMut(String),
) -> Result<(), String> {
    let client = Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(friendly_openai_error(status, &body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines from buffer
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    return Ok(());
                }
                if let Ok(chunk) = serde_json::from_str::<ChatChunk>(data) {
                    for choice in chunk.choices {
                        if let Some(content) = choice.delta.content {
                            if !content.is_empty() {
                                on_token(content);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
