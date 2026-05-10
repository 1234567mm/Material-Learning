use crate::state::AppState;
use knowledge_db::{ChatSession, ChatMessage, Summary};

/// 创建新的聊天会话
#[tauri::command]
pub async fn create_chat_session(
    state: tauri::State<'_, AppState>,
    panel_id: i64,
) -> Result<ChatSession, String> {
    let knowledge_db = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化".to_string())?;
    let db = knowledge_db.as_ref();

    // 检查面板是否存在
    db.get_panel(panel_id).map_err(|e| e.to_string())?;

    // 创建会话
    let _session_id = db.create_chat_session(panel_id, None)
        .map_err(|e| e.to_string())?;

    db.get_active_session(panel_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Failed to retrieve created session".to_string())
}

/// 发送消息并获取 AI 回复
#[tauri::command]
pub async fn send_message(
    state: tauri::State<'_, AppState>,
    session_id: i64,
    content: String,
) -> Result<ChatMessage, String> {
    let knowledge_db = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化".to_string())?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动".to_string())?;

    let db = knowledge_db.as_ref();

    // 获取会话
    let session = db.get_chat_session(session_id).map_err(|e| e.to_string())?;

    if !session.is_active {
        return Err("会话已结束，请创建新会话".to_string());
    }

    // 保存用户消息
    db.add_message(session_id, "user", &content, None)
        .map_err(|e| e.to_string())?;

    // 获取历史消息用于上下文
    let history = db.get_messages(session_id).map_err(|e| e.to_string())?;

    // 获取面板的系统提示
    let panel = db.get_panel(session.panel_id).map_err(|e| e.to_string())?;
    let system_prompt = panel.system_prompt.as_deref().unwrap_or("");

    // 构建消息列表
    let mut messages: Vec<crate::services::llama::ChatMessage> = Vec::new();

    if !system_prompt.is_empty() {
        messages.push(crate::services::llama::ChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
        });
    }

    for msg in history {
        messages.push(crate::services::llama::ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }

    // 调用 llama-server
    let reply = llama.chat(messages).await.map_err(|e| e.to_string())?;

    // 保存助手回复
    let assistant_msg_id = db.add_message(session_id, "assistant", &reply, None)
        .map_err(|e| e.to_string())?;

    db.get_messages(session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == assistant_msg_id)
        .ok_or_else(|| "Failed to retrieve assistant message".to_string())
}

/// 结束聊天会话
#[tauri::command]
pub async fn end_chat_session(
    state: tauri::State<'_, AppState>,
    session_id: i64,
) -> Result<Summary, String> {
    let knowledge_db = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化".to_string())?;
    let llama = state.llama.as_ref();

    let db = knowledge_db.as_ref();

    // 获取会话信息（先获取以便后续使用）
    let session = db.get_chat_session(session_id).map_err(|e| e.to_string())?;

    // 结束会话
    db.end_chat_session(session_id).map_err(|e| e.to_string())?;

    // 获取所有消息生成摘要
    let messages = db.get_messages(session_id).map_err(|e| e.to_string())?;

    let summary_content = if let Some(llama_client) = llama {
        let mut prompt = String::from("请简要总结以下对话的主要内容和结论：\n\n");
        for msg in &messages {
            prompt.push_str(&format!("{}: {}\n", msg.role, msg.content));
        }

        match llama_client.complete(&prompt).await {
            Ok(content) => content,
            Err(e) => format!("摘要生成失败: {}", e),
        }
    } else {
        let mut summary = String::new();
        for msg in &messages {
            summary.push_str(&format!("[{}] {}\n", msg.role, msg.content));
        }
        summary
    };

    let char_count = summary_content.chars().count() as i64;
    let summary_id = db.create_summary(
        session.panel_id,
        Some(session_id),
        &summary_content,
        char_count,
        "manual",
    ).map_err(|e| e.to_string())?;

    db.get_summaries(session.panel_id, 10)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == summary_id)
        .ok_or_else(|| "Failed to retrieve created summary".to_string())
}

/// 获取聊天历史
#[tauri::command]
pub async fn get_chat_messages(
    state: tauri::State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<ChatMessage>, String> {
    let knowledge_db = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化".to_string())?;
    let db = knowledge_db.as_ref();
    db.get_messages(session_id).map_err(|e| e.to_string())
}