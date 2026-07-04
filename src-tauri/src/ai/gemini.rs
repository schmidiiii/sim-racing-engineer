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

// Extract retryDelay seconds from a 429 response body, fallback to default.
fn parse_retry_secs(body: &str, default: u64) -> u64 {
    // Look for "retryDelay": "Xs" pattern
    if let Some(pos) = body.find("\"retryDelay\"") {
        if let Some(start) = body[pos..].find('"').and_then(|i| body[pos + i + 1..].find('"').map(|j| pos + i + 1 + j + 1)) {
            if let Some(end) = body[start..].find('"') {
                let val = &body[start..start + end];
                if let Some(secs) = val.trim_end_matches('s').parse::<f64>().ok() {
                    return (secs.ceil() as u64).max(1).min(60);
                }
            }
        }
    }
    default
}

pub async fn stream_gemini(
    api_key: &str,
    model: &str,
    messages: Vec<AiMessage>,
    mut on_token: impl FnMut(String),
) -> Result<(), String> {
    let client = Client::new();

    // Split system prompt (→ systemInstruction) from conversation turns
    let system_text: Option<String> = messages.iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone());

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }]
        }))
        .collect();

    let mut body = serde_json::json!({ "contents": contents });
    if let Some(sys) = system_text {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": sys }]
        });
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
        model, api_key
    );

    // Retry up to 3 times on transient errors (429 rate-limit, 503 overload)
    const MAX_RETRIES: u32 = 3;
    let mut attempt = 0u32;

    loop {
        let response = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();

        if status.is_success() {
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
            return Ok(());
        }

        let err_body = response.text().await.unwrap_or_default();

        // Retry on 429 (rate limit) and 503 (overload) up to MAX_RETRIES
        let retryable = status.as_u16() == 429 || status.as_u16() == 503;
        attempt += 1;
        if retryable && attempt <= MAX_RETRIES {
            let wait_secs = if status.as_u16() == 429 {
                parse_retry_secs(&err_body, 10 * attempt as u64)
            } else {
                5 * attempt as u64  // 503: 5s, 10s, 15s
            };
            tokio::time::sleep(std::time::Duration::from_secs(wait_secs)).await;
            continue;
        }

        return Err(format!("Gemini error {}: {}", status, err_body));
    }
}
