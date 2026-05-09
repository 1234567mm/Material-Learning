use reqwest::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MeilisearchError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API error: {0}")]
    Api(String),
    #[error("Server not available")]
    NotAvailable,
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
        // Create index if not exists (POST is idempotent for index creation)
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
                // 409 means index already exists, which is fine
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