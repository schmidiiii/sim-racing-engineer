use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use crate::ai::provider::AiMessage;

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Candidate {
    content: Content,
}

#[derive(Deserialize)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Deserialize)]
struct Part {
    text: Option<String>,
}

pub async fn stream_gemini(
    api_key: &str,
    model: &str,
    messages: Vec<AiMessage>,
    mut on_token: impl FnMut(String),
) -> Result<(), String> {
    let client = Client::new();

    // Convert messages to Gemini format (user/model roles, no system)
    let contents: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }]
        }))
        .collect();

    let body = serde_json::json!({
        "contents": contents,
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
        model, api_key
    );

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Gemini error {}: {}", status, body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(resp) = serde_json::from_str::<GeminiResponse>(data) {
                    for candidate in resp.candidates {
                        for part in candidate.content.parts {
                            if let Some(text) = part.text {
                                if !text.is_empty() {
                                    on_token(text);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
