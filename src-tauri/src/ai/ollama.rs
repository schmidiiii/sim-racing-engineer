use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use crate::ai::provider::AiMessage;

#[derive(Deserialize)]
struct OllamaChunk {
    message: OllamaMsg,
    done: bool,
}

#[derive(Deserialize)]
struct OllamaMsg {
    content: String,
}

pub async fn stream_ollama(
    base_url: &str,
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
        .post(format!("{}/api/chat", base_url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(match status {
            404 => format!("Ollama model \"{}\" not found — run: ollama pull {}", model, model),
            _ => format!("Ollama error {} — make sure ollama serve is running", status),
        });
    }

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        if let Ok(text) = std::str::from_utf8(&bytes) {
            for line in text.lines() {
                if line.is_empty() { continue; }
                if let Ok(parsed) = serde_json::from_str::<OllamaChunk>(line) {
                    if !parsed.message.content.is_empty() {
                        on_token(parsed.message.content);
                    }
                    if parsed.done { return Ok(()); }
                }
            }
        }
    }
    Ok(())
}
