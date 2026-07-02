use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProviderConfig {
    Ollama { base_url: String, model: String },
    OpenAI { api_key: String, model: String },
    Gemini { api_key: String, model: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMessage {
    pub role: String,   // "user" | "assistant" | "system"
    pub content: String,
}
