//! 附件相关 Command（薄包装 → AttachmentService）
//!
//! 与 commands/image.rs 对称设计。前端拖放非图片/非文本文件时调用。
//!
//! ## 路径约定（重要）
//! `AttachmentInfo.path` 返回**相对 `state.data_dir` 的 POSIX 路径**
//! （例如 `kb_assets/attachments/1/x.pdf`）。前端拼 `kb-asset://<path>` 写入 content；
//! 需要用 OS 程序打开时调 `resolve_asset_absolute_path` 还原成绝对路径再调 opener。

use tauri::State;

use crate::models::AttachmentInfo;
use crate::services::asset_path;
use crate::services::attachment::AttachmentService;
use crate::state::AppState;

/// 把 Service 返回的 AttachmentInfo.path 由绝对路径改写成相对 POSIX 路径。
fn rewrite_to_relative(state: &AppState, info: AttachmentInfo) -> Result<AttachmentInfo, String> {
    let rel = asset_path::abs_to_rel(std::path::Path::new(&info.path), &state.data_dir)
        .ok_or_else(|| {
            format!(
                "内部错误：保存的附件路径 {} 不在数据目录 {} 下",
                info.path,
                state.data_dir.display()
            )
        })?;
    Ok(AttachmentInfo { path: rel, ..info })
}

/// 保存附件（base64 数据，用于前端拖放）
///
/// 返回附件信息，`path` 为相对 data_dir 的 POSIX 路径。
#[tauri::command]
pub fn save_note_attachment(
    state: State<'_, AppState>,
    note_id: i64,
    file_name: String,
    base64_data: String,
) -> Result<AttachmentInfo, String> {
    let info =
        AttachmentService::save_from_base64(&state.data_dir, note_id, &file_name, &base64_data)
            .map_err(|e| e.to_string())?;
    rewrite_to_relative(&state, info)
}

/// 从本地文件路径零拷贝保存附件（用于工具栏"插入附件"按钮）
#[tauri::command]
pub fn save_note_attachment_from_path(
    state: State<'_, AppState>,
    note_id: i64,
    source_path: String,
) -> Result<AttachmentInfo, String> {
    let info = AttachmentService::save_from_path(&state.data_dir, note_id, &source_path)
        .map_err(|e| e.to_string())?;
    rewrite_to_relative(&state, info)
}

/// 删除笔记的所有附件
#[tauri::command]
pub fn delete_note_attachments(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    AttachmentService::delete_note_attachments(&state.data_dir, note_id).map_err(|e| e.to_string())
}

/// 获取附件存储目录路径（设置页"打开目录"入口用）
#[tauri::command]
pub fn get_attachments_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = AttachmentService::ensure_dir(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
