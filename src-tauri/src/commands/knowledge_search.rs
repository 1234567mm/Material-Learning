use crate::state::AppState;
use knowledge_db::SimilarityHit;

/// 搜索知识库文件（基于 FTS5）
#[tauri::command]
pub async fn search_knowledge(
    state: tauri::State<'_, AppState>,
    query: String,
    panel_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<(i64, String, String)>, String> {
    let knowledge_db = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化".to_string())?;
    let limit = limit.unwrap_or(20) as i64;
    let results = knowledge_db.search_files(&query, panel_id, limit)
        .map_err(|e| e.to_string())?;
    Ok(results)
}

/// 搜索相似内容块（基于向量相似度）
#[tauri::command]
pub async fn similar_chunks(
    state: tauri::State<'_, AppState>,
    query: String,
    panel_id: i64,
    limit: Option<usize>,
) -> Result<Vec<SimilarityHit>, String> {
    let knowledge_db = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化".to_string())?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动".to_string())?;
    let limit = limit.unwrap_or(5);

    // Generate query embedding via llama-server
    let query_embedding = llama.embed(&query).await.map_err(|_| "嵌入查询失败，请确认 llama-server 正常运行")?;

    let results = knowledge_db.search_similar(&query_embedding, panel_id, limit)
        .map_err(|e| e.to_string())?;
    Ok(results)
}
