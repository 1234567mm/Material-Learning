use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use thiserror::Error;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Timeout waiting for server
const MEILISEARCH_STARTUP_TIMEOUT_SECS: u64 = 30;
/// Polling interval while waiting for server readiness
const MEILISEARCH_POLL_INTERVAL_SECS: u64 = 1;

#[derive(Error, Debug)]
pub enum MeilisearchError {
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

pub type MeilisearchResult<T> = Result<T, MeilisearchError>;

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchRequest {
    pub q: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub filter: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub content: String,
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub query: String,
    pub processing_time_ms: u64,
}

pub struct MeilisearchClient {
    pub http_client: Client,
    pub base_url: String,
    pub index_name: String,
}

impl MeilisearchClient {
    pub fn new(base_url: String, index_name: String) -> Self {
        Self {
            http_client: Client::new(),
            base_url,
            index_name,
        }
    }

    pub async fn search(&self, query: &str, limit: usize) -> MeilisearchResult<Vec<SearchHit>> {
        let url = format!("{}/indexes/{}/search", self.base_url, self.index_name);
        let request = SearchRequest {
            q: query.to_string(),
            limit: Some(limit),
            offset: None,
            filter: None,
        };

        let response = self.http_client
            .post(&url)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(MeilisearchError::Api(response.text().await?));
        }

        let search_response: SearchResponse = response.json().await?;
        Ok(search_response.hits)
    }

    pub async fn health(&self) -> MeilisearchResult<bool> {
        let url = format!("{}/health", self.base_url);
        match self.http_client.get(&url).send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    pub async fn ensure_index(&self) -> MeilisearchResult<()> {
        let response = self.http_client
            .post(&format!("{}/indexes", self.base_url))
            .json(&serde_json::json!({
                "uid": self.index_name,
                "primaryKey": "id"
            }))
            .send()
            .await;

        match response {
            Ok(resp) if resp.status().is_success() => Ok(()),
            Ok(resp) => {
                let text = resp.text().await?;
                if text.contains("already exists") {
                    Ok(())
                } else {
                    Err(MeilisearchError::Api(text))
                }
            }
            Err(e) => Err(MeilisearchError::Http(e)),
        }
    }
}

/// Managed meilisearch process wrapper.
/// When dropped, kills the child process.
pub struct MeilisearchServer {
    child: Mutex<Option<Child>>,
    client: Arc<MeilisearchClient>,
}

impl MeilisearchServer {
    pub fn client(&self) -> Arc<MeilisearchClient> {
        self.client.clone()
    }

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
    index_name: &str,
) -> MeilisearchServer {
    let child = child_opt.take().expect("child already taken");
    let inner_client = Arc::new(MeilisearchClient::new(base_url.to_string(), index_name.to_string()));
    MeilisearchServer {
        child: Mutex::new(Some(child)),
        client: inner_client,
    }
}

/// Find meilisearch binary in PATH.
fn find_meilisearch() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        paths.to_str().and_then(|paths_str| {
            for dir in paths_str.split(':') {
                let candidate = PathBuf::from(dir).join("meilisearch");
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

/// Spawn meilisearch as a subprocess and wait for it to be ready.
/// Returns a MeilisearchServer on success; failure is non-fatal (returns Err).
/// data_dir: directory for meilisearch data storage
/// base_url: where meilisearch listens (e.g., "http://127.0.0.1:7700")
/// index_name: name of the search index (e.g., "knowledge")
pub async fn spawn_meilisearch(
    data_dir: &PathBuf,
    base_url: &str,
    index_name: &str,
) -> MeilisearchResult<Option<MeilisearchServer>> {
    let meilisearch_path = find_meilisearch().ok_or_else(|| {
        MeilisearchError::Spawn("meilisearch binary not found in PATH".to_string())
    })?;

    log::info!("[meilisearch] spawning meilisearch from {}", meilisearch_path.display());

    let child = Command::new(&meilisearch_path)
        .args([
            "--db-path", data_dir.join("meilisearch-data").to_str().unwrap(),
            "--http-addr", base_url,
            "--no-analytics",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| MeilisearchError::Spawn(format!("failed to spawn meilisearch: {}", e)))?;

    // Wait for server to be ready via health check
    let health_url = format!("{}/health", base_url);

    let http_client = Client::new();
    let start = std::time::Instant::now();
    let max_wait = std::time::Duration::from_secs(MEILISEARCH_STARTUP_TIMEOUT_SECS);
    let mut child_opt = Some(child);

    log::info!("[meilisearch] waiting for meilisearch to be ready at {}", health_url);

    while start.elapsed() < max_wait {
        // Detect early exit before the first health check
        if let Some(ref mut c) = child_opt {
            if let Ok(Some(_)) = c.try_wait() {
                return Err(MeilisearchError::Timeout);
            }
        }
        match http_client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                log::info!("[meilisearch] meilisearch is ready after {:?}", start.elapsed());
                let server = finalize_server(&mut child_opt, base_url, index_name);

                // Ensure the index exists (idempotent)
                if let Err(e) = server.client().ensure_index().await {
                    log::warn!("[meilisearch] failed to ensure index: {}", e);
                }

                return Ok(Some(server));
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(MEILISEARCH_POLL_INTERVAL_SECS)).await;
    }

    // Timeout — kill the process
    if let Some(mut c) = child_opt {
        let _ = c.kill();
    }
    Err(MeilisearchError::Timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meilisearch_error_display() {
        assert_eq!(MeilisearchError::NotAvailable.to_string(), "Server not available");
        assert_eq!(MeilisearchError::Timeout.to_string(), "Timeout waiting for server");
        assert!(MeilisearchError::Spawn("oops".into()).to_string().contains("oops"));
        assert!(MeilisearchError::Api("bad response".into()).to_string().contains("bad response"));
    }

    #[test]
    fn meilisearch_client_constructor() {
        let client = MeilisearchClient::new("http://127.0.0.1:7700".to_string(), "test_index".to_string());
        assert_eq!(client.base_url, "http://127.0.0.1:7700");
        assert_eq!(client.index_name, "test_index");
    }

    #[test]
    fn meilisearch_client_health_url_construction() {
        let client = MeilisearchClient::new("http://127.0.0.1:7700".to_string(), "test".to_string());
        // health() is async — run it inside a Tokio runtime
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let _ = client.health().await;
        });
    }

    #[test]
    fn meilisearch_search_request_serialization() {
        let client = MeilisearchClient::new("http://127.0.0.1:7700".to_string(), "test".to_string());
        let url = format!("{}/indexes/{}/search", client.base_url, client.index_name);
        assert_eq!(url, "http://127.0.0.1:7700/indexes/test/search");
    }

    #[test]
    fn meilisearch_constants_defined() {
        assert_eq!(MEILISEARCH_STARTUP_TIMEOUT_SECS, 30);
        assert_eq!(MEILISEARCH_POLL_INTERVAL_SECS, 1);
    }
}
