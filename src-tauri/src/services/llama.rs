use reqwest::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum LlamaError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API error: {0}")]
    Api(String),
    #[error("Server not available")]
    NotAvailable,
}

pub type LlamaResult<T> = Result<T, LlamaError>;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<Choice>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Choice {
    pub message: ChoiceMessage,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChoiceMessage {
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbedRequest {
    pub model: String,
    pub input: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbedResponse {
    pub data: Vec<EmbedData>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbedData {
    pub embedding: Vec<f32>,
}

pub struct LlamaClient {
    pub http_client: Client,
    pub base_url: String,
    pub model: String,
}

impl LlamaClient {
    pub fn new(base_url: String, model: String) -> Self {
        Self {
            http_client: Client::new(),
            base_url,
            model,
        }
    }

    pub async fn chat(&self, messages: Vec<ChatMessage>) -> LlamaResult<String> {
        let url = format!("{}/chat/completions", self.base_url);
        let request = ChatRequest {
            model: self.model.clone(),
            messages,
            stream: false,
        };

        let response = self.http_client
            .post(&url)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(LlamaError::Api(response.text().await?));
        }

        let chat_response: ChatResponse = response.json().await?;
        chat_response.choices.first()
            .map(|c| c.message.content.clone())
            .ok_or_else(|| LlamaError::Api("No choices in response".to_string()))
    }

    pub async fn complete(&self, prompt: &str) -> LlamaResult<String> {
        let url = format!("{}/completion", self.base_url);
        let request = serde_json::json!({
            "prompt": prompt,
            "stream": false
        });

        let response = self.http_client
            .post(&url)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(LlamaError::Api(response.text().await?));
        }

        #[derive(Deserialize)]
        struct CompletionResponse {
            content: String,
        }

        let resp: CompletionResponse = response.json().await?;
        Ok(resp.content)
    }

    pub async fn embed(&self, text: &str) -> LlamaResult<Vec<f32>> {
        let url = format!("{}/embedding", self.base_url);
        let request = EmbedRequest {
            model: self.model.clone(),
            input: text.to_string(),
        };

        let response = self.http_client
            .post(&url)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(LlamaError::Api(response.text().await?));
        }

        let embed_response: EmbedResponse = response.json().await?;
        embed_response.data.first()
            .map(|d| d.embedding.clone())
            .ok_or_else(|| LlamaError::Api("No embedding in response".to_string()))
    }

    pub async fn health(&self) -> LlamaResult<bool> {
        let url = format!("{}/health", self.base_url);
        match self.http_client.get(&url).send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }
}