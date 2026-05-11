use crate::state::AppState;
use knowledge_db::{ChatSession, ChatMessage as KbChatMessage, Summary, GlobalMemory};
use std::sync::Arc;

#[tauri::command]
pub async fn knowledge_list_panels(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<knowledge_db::Panel>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.get_panels().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_create_panel(
    state: tauri::State<'_, AppState>,
    name: String,
    system_prompt: Option<String>,
) -> Result<i64, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.create_panel(&name, system_prompt.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_update_panel(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    system_prompt: Option<String>,
) -> Result<(), String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.update_panel(id, &name, system_prompt.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_delete_panel(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.delete_panel(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_create_session(
    state: tauri::State<'_, AppState>,
    panel_id: i64,
) -> Result<ChatSession, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let id = kb.create_chat_session(panel_id, None).map_err(|e| e.to_string())?;
    kb.get_chat_session(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_list_sessions(
    state: tauri::State<'_, AppState>,
    panel_id: i64,
) -> Result<Vec<ChatSession>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.get_chat_sessions(panel_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_send_message(
    state: tauri::State<'_, AppState>,
    session_id: i64,
    content: String,
) -> Result<KbChatMessage, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动")?;

    // Get or create per-session lock to prevent concurrent message interleaving
    let lock = {
        let mut locks = state.knowledge_session_locks.lock().unwrap();
        locks.entry(session_id).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    };
    let _guard = lock.lock().await;

    let session = kb.get_chat_session(session_id).map_err(|e| e.to_string())?;
    if !session.is_active {
        return Err("会话已结束，请创建新会话".to_string());
    }

    // Save user message
    kb.add_message(session_id, "user", &content, None).map_err(|e| e.to_string())?;

    // Build context: system_prompt + recent summaries + global memories
    let panel = kb.get_panel(session.panel_id).map_err(|e| e.to_string())?;
    let summaries = kb.get_recent_summaries_for_context(session.panel_id, 3).map_err(|e| e.to_string())?;
    let global_memories = kb.list_global_memories(5).map_err(|e| e.to_string())?;

    let mut system_content = panel.system_prompt.unwrap_or_default();
    if !summaries.is_empty() {
        system_content.push_str("\n\n=== 历史摘要 ===\n");
        for s in &summaries {
            system_content.push_str(&format!("- {}\n", s.content));
        }
    }
    if !global_memories.is_empty() {
        system_content.push_str("\n=== 相关学习 ===\n");
        for m in &global_memories {
            system_content.push_str(&format!("- {}\n", m.content));
        }
    }

    let history = kb.get_messages(session_id).map_err(|e| e.to_string())?;

    // Truncate history to fit context window (~8k tokens ≈ 32k chars, keep system + recent)
    const MAX_CHARS: usize = 28_000;
    let mut messages: Vec<crate::services::llama::ChatMessage> = Vec::new();
    if !system_content.is_empty() {
        messages.push(crate::services::llama::ChatMessage {
            role: "system".to_string(),
            content: system_content.clone(),
        });
    }

    let mut total_chars = system_content.len();
    let history_len = history.len();
    let skip = if history_len > 20 { history_len - 20 } else { 0 };
    for msg in history.into_iter().skip(skip) {
        let msg_len = msg.content.len();
        if total_chars + msg_len > MAX_CHARS {
            break;
        }
        total_chars += msg_len;
        messages.push(crate::services::llama::ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }

    let reply = llama.chat(messages).await.map_err(|e| e.to_string())?;
    let msg_id = kb.add_message(session_id, "assistant", &reply, None).map_err(|e| e.to_string())?;

    kb.get_messages(session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == msg_id)
        .ok_or_else(|| "Failed to retrieve assistant message".to_string())
}

#[tauri::command]
pub async fn knowledge_end_session(
    state: tauri::State<'_, AppState>,
    session_id: i64,
) -> Result<Summary, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动")?;

    let session = kb.get_chat_session(session_id).map_err(|e| e.to_string())?;
    let messages = kb.get_messages(session_id).map_err(|e| e.to_string())?;

    // Generate summary before marking session as ended
    let mut prompt = "请简要总结以下对话的主要内容和结论，用中文回复。输出格式：摘要内容\nScore: 0.XX（0到1之间的质量分数）：\n\n".to_string();
    for msg in &messages {
        prompt.push_str(&format!("{}: {}\n", msg.role, msg.content));
    }

    let response = llama.complete(&prompt).await.map_err(|e| e.to_string())?;

    // Parse quality score from response
    let (summary_content, quality_score) = if let Some(score_pos) = response.find("Score: ") {
        let after_score = &response[score_pos + 7..];
        let score_end = after_score.find('\n').unwrap_or(after_score.len());
        let score_str = after_score[..score_end].trim();
        let score: f64 = score_str.parse().unwrap_or(0.5);
        let content = response[..score_pos].trim().to_string();
        (content, score)
    } else {
        (response.trim().to_string(), 0.5)
    };

    let char_count = summary_content.chars().count() as i64;
    let summary_id = kb.create_summary(
        session.panel_id,
        Some(session_id),
        &summary_content,
        char_count,
        "manual",
    ).map_err(|e| e.to_string())?;

    // Store high-quality summary in global memories
    if quality_score > 0.7 {
        kb.create_global_memory(
            &summary_content,
            session.panel_id,
            Some(session_id),
            quality_score,
        ).map_err(|e| e.to_string())?;
    }

    // Mark session as ended only after summary and global memory are safely stored
    kb.end_chat_session(session_id).map_err(|e| e.to_string())?;

    kb.get_summaries(session.panel_id, 10)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == summary_id)
        .ok_or_else(|| "Failed to retrieve summary".to_string())
}

#[tauri::command]
pub async fn knowledge_get_messages(
    state: tauri::State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<KbChatMessage>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.get_messages(session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_search_files(
    state: tauri::State<'_, AppState>,
    query: String,
    panel_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<(i64, String, String)>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let limit = limit.unwrap_or(20) as i64;
    kb.search_files(&query, panel_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_similar_chunks(
    state: tauri::State<'_, AppState>,
    query: String,
    panel_id: i64,
    limit: Option<usize>,
) -> Result<Vec<knowledge_db::SimilarityHit>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动")?;
    let limit = limit.unwrap_or(5);
    let embedding = llama.embed(&query).await.map_err(|e| e.to_string())?;
    kb.search_similar(&embedding, panel_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_list_memories(
    state: tauri::State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<GlobalMemory>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.list_global_memories(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_forget_memory(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.delete_global_memory(id).map_err(|e| e.to_string())
}