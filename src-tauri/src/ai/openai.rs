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
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI error {}: {}", status, body));
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
