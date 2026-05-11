use std::env;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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
    #[error("Spawn error: {0}")]
    Spawn(String),
    #[error("Timeout waiting for server")]
    Timeout,
}

pub type LlamaResult<T> = Result<T, LlamaError>;

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    #[cfg(desktop)]
    pub server: Option<Arc<LlamaServer>>,
    #[cfg(not(desktop))]
    pub server: Option<Arc<LlamaServer>>,
}

impl LlamaClient {
    pub fn new(base_url: String, model: String, server: Option<Arc<LlamaServer>>) -> Self {
        Self {
            http_client: Client::new(),
            base_url,
            model,
            server,
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

/// Managed llama-server process wrapper.
/// When dropped, kills the child process.
pub struct LlamaServer {
    child: Mutex<Option<Child>>,
    client: Arc<LlamaClient>,
}

impl LlamaServer {
    /// Returns the HTTP client for making API calls.
    pub fn client(&self) -> Arc<LlamaClient> {
        self.client.clone()
    }

    /// Stop the llama-server process.
    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
    }
}

fn finalize_server(
    child_opt: &mut Option<Child>,
    base_url: &str,
    model: &str,
) -> LlamaServer {
    let child = child_opt.take().expect("child already taken");
    let inner_client = Arc::new(LlamaClient::new(base_url.to_string(), model.to_string(), None));
    let server = Arc::new(LlamaServer {
        child: Mutex::new(Some(child)),
        client: inner_client.clone(),
    });
    let outer_client = Arc::new(LlamaClient::new(
        base_url.to_string(),
        model.to_string(),
        Some(server.clone()),
    ));
    LlamaServer {
        child: Mutex::new(None),
        client: outer_client,
    }
}

/// Spawn llama-server as a subprocess and wait for it to be ready.
/// Returns a LlamaServer on success; failure is non-fatal (returns Err).
/// model_path: path to the GGUF model file
/// base_url: where llama-server listens (e.g., "http://127.0.0.1:8080")
/// model: model name to use in API calls (e.g., "model")
/// port: port for llama-server to listen on (default 8080)
pub async fn spawn_llama_server(
    model_path: &str,
    base_url: &str,
    model: &str,
    port: u16,
) -> LlamaResult<Option<LlamaServer>> {
    let llama_server_path = find_llama_server().ok_or_else(|| {
        LlamaError::Spawn("llama-server binary not found in PATH".to_string())
    })?;

    log::info!("[llama] spawning llama-server from {}", llama_server_path.display());

    let child = Command::new(&llama_server_path)
        .args([
            "-m", model_path,
            "--port", &port.to_string(),
            "--host", "127.0.0.1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| LlamaError::Spawn(format!("failed to spawn llama-server: {}", e)))?;

    // Wait for server to be ready via health check
    let health_url = format!("{}/health", base_url);
    let http_client = Client::new();
    let start = std::time::Instant::now();
    let max_wait = Duration::from_secs(60);
    let mut child_opt = Some(child);

    log::info!("[llama] waiting for llama-server to be ready at {}", health_url);

    while start.elapsed() < max_wait {
        match http_client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                log::info!("[llama] llama-server is ready after {:?}", start.elapsed());
                return Ok(Some(finalize_server(&mut child_opt, base_url, model)));
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    // Timeout — kill the process
    if let Some(mut c) = child_opt {
        let _ = c.kill().await;
    }
    Err(LlamaError::Timeout)
}

/// Find llama-server binary in PATH.
fn find_llama_server() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        paths.to_str().and_then(|paths_str| {
            for dir in paths_str.split(':') {
                let candidate = PathBuf::from(dir).join("llama-server");
                if is_executable(&candidate) {
                    return Some(candidate);
                }
                #[cfg(target_os = "windows")]
                {
                    let exe_candidate = candidate.with_extension("exe");
                    if is_executable(&exe_candidate) {
                        return Some(exe_candidate);
                    }
                }
            }
            None
        })
    })
}

#[cfg(unix)]
fn is_executable(path: &PathBuf) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .map(|m| m.mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &PathBuf) -> bool {
    std::fs::metadata(path)
        .map(|m| m.access_ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llama_error_display() {
        assert_eq!(LlamaError::NotAvailable.to_string(), "Server not available");
        assert_eq!(LlamaError::Timeout.to_string(), "Timeout waiting for server");
        assert!(LlamaError::Spawn("oops".into()).to_string().contains("oops"));
        assert!(LlamaError::Api("bad".into()).to_string().contains("bad"));
    }

    #[test]
    fn llama_client_new_sets_fields() {
        let client = LlamaClient::new("http://127.0.0.1:8080".to_string(), "my-model".to_string(), None);
        assert_eq!(client.base_url, "http://127.0.0.1:8080");
        assert_eq!(client.model, "my-model");
    }

    #[test]
    fn chat_message_serialization() {
        let msg = ChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
        };
        let j = serde_json::to_string(&msg).unwrap();
        assert!(j.contains("hello"));
        assert!(j.contains("user"));
    }

    #[test]
    fn chat_request_serialization() {
        let req = ChatRequest {
            model: "test-model".to_string(),
            messages: vec![
                ChatMessage { role: "user".to_string(), content: "hi".to_string() },
            ],
            stream: false,
        };
        let j = serde_json::to_string(&req).unwrap();
        assert!(j.contains("test-model"));
        assert!(j.contains("hi"));
        assert!(j.contains("\"stream\":false"));
    }

    #[test]
    fn embed_request_serialization() {
        let req = EmbedRequest {
            model: "test-model".to_string(),
            input: "hello world".to_string(),
        };
        let j = serde_json::to_string(&req).unwrap();
        assert!(j.contains("test-model"));
        assert!(j.contains("hello world"));
    }

    #[test]
    fn llama_server_stop_is_idempotent() {
        // LlamaServer::stop() can be called multiple times safely
        let client = Arc::new(LlamaClient::new("http://127.0.0.1:8080".to_string(), "m".to_string(), None));
        let server = Arc::new(LlamaServer {
            child: Mutex::new(None),
            client,
        });
        // Calling stop on a server with no child should not panic
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(server.stop());
        rt.block_on(server.stop()); // second call should also be fine
    }
}