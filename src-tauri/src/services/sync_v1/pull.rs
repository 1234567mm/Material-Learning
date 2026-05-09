//! V1 拉取：远端 → 本地
//!
//! 流程：
//! 1. 读远端 manifest（首次 → 当无操作返回）
//! 2. 计算本地 manifest
//! 3. diff
//! 4. 对 to_pull：从 backend.get_note 拉 .md 文本 → 解析 title + body → upsert 到本地
//! 5. 对 to_delete_local：软删本地笔记（v1 不实际删，仅 set is_deleted=1）
//! 6. 冲突 (conflicts)：v1 用 last-write-wins —— 落败方写到本地 `.conflicts/<sid>_<ts>.md` 文件
//!
//! 本机时间相同（极小概率）→ 两边都标 conflict，UI 提示用户人工合并。

use std::path::Path;

use tauri::{Emitter, Runtime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{NoteInput, SyncPullResult};

use super::backend::SyncBackendImpl;
use super::manifest;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    backend_id: i64,
    phase: String, // "compute" | "diff" | "download" | "apply" | "done"
    current: usize,
    total: usize,
    message: String,
}

pub fn pull<R: Runtime, E: Emitter<R>>(
    db: &Database,
    backend_id: i64,
    backend: &dyn SyncBackendImpl,
    app_version: &str,
    device: &str,
    conflicts_dir: &Path,
    emitter: &E,
) -> Result<SyncPullResult, AppError> {
    let mut result = SyncPullResult::default();
    let event_name = "sync_v1:progress";

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "compute".into(),
            current: 0,
            total: 0,
            message: "拉取远端 manifest…".into(),
        },
    );
    let remote = match backend.read_manifest()? {
        Some(m) => m,
        None => {
            // 远端没东西，无操作
            return Ok(result);
        }
    };

    let local = manifest::compute_local_manifest(db, app_version, device)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "diff".into(),
            current: 0,
            total: 0,
            message: "对比本地…".into(),
        },
    );
    let diff = manifest::diff_manifests(&local, &remote);

    // ── 处理 to_pull（远端独有 / 远端较新）
    let total_pull = diff.to_pull.len();
    for (idx, entry) in diff.to_pull.iter().enumerate() {
        let _ = emitter.emit(
            event_name,
            ProgressEvent {
                backend_id,
                phase: "download".into(),
                current: idx + 1,
                total: total_pull,
                message: format!("下载 {}", entry.title),
            },
        );
        let body = match backend.get_note(&entry.remote_path)? {
            Some(s) => s,
            None => {
                result.errors.push(format!(
                    "远端 manifest 有 {} 但 .md 文件丢失",
                    entry.remote_path
                ));
                continue;
            }
        };
        let (title, content) = parse_note_md(&body, &entry.title);

        // 本地有这条吗？
        let parsed_id: i64 = entry.stable_id.parse().unwrap_or(-1);
        if parsed_id > 0 {
            // upsert：先尝试 update，失败再 insert（v1 简化）
            let exists = db.get_note(parsed_id).ok().flatten().is_some();
            let folder_id = ensure_folder_path(db, &entry.folder_path)?;
            let input = NoteInput {
                title,
                content: content.clone(),
                folder_id,
            };
            let res = if exists {
                db.update_note(parsed_id, &input)
            } else {
                db.create_note(&input)
            };
            match res {
                Ok(_) => {
                    result.downloaded += 1;
                    if let Err(e) = db.upsert_remote_state(
                        backend_id,
                        parsed_id.max(1),
                        &entry.remote_path,
                        &entry.content_hash,
                        &entry.updated_at,
                        false,
                    ) {
                        result
                            .errors
                            .push(format!("upsert sync_remote_state 失败: {}", e));
                    }
                }
                Err(e) => {
                    result
                        .errors
                        .push(format!("写入本地笔记失败 {}: {}", entry.title, e));
                }
            }
        } else {
            // stable_id 解析失败 → 一律新建
            let folder_id = ensure_folder_path(db, &entry.folder_path)?;
            let input = NoteInput {
                title,
                content,
                folder_id,
            };
            if let Err(e) = db.create_note(&input) {
                result.errors.push(format!("新建本地笔记失败: {}", e));
            } else {
                result.downloaded += 1;
            }
        }
    }

    // ── 处理 to_delete_local（远端 tombstone）
    for entry in &diff.to_delete_local {
        let parsed_id: i64 = entry.stable_id.parse().unwrap_or(-1);
        if parsed_id > 0 {
            match db.soft_delete_note(parsed_id) {
                Ok(true) => {
                    result.deleted_local += 1;
                    let _ = db.upsert_remote_state(
                        backend_id,
                        parsed_id,
                        &entry.remote_path,
                        &entry.content_hash,
                        &entry.updated_at,
                        true,
                    );
                }
                Ok(false) => {} // 本地已没有
                Err(e) => result
                    .errors
                    .push(format!("软删本地失败 {}: {}", entry.title, e)),
            }
        }
    }

    // ── 处理 conflicts（updated_at 相同但 hash 不同）
    if !diff.conflicts.is_empty() {
        std::fs::create_dir_all(conflicts_dir).ok();
    }
    for pair in &diff.conflicts {
        result.conflicts += 1;
        // 把远端版本落地到 .conflicts/，让用户手动选
        match backend.get_note(&pair.remote.remote_path) {
            Ok(Some(remote_body)) => {
                let safe_id = pair.remote.stable_id.replace('/', "_");
                let path = conflicts_dir.join(format!(
                    "{}_{}.md",
                    safe_id,
                    pair.remote.updated_at.replace([':', ' '], "-")
                ));
                if let Err(e) = std::fs::write(&path, remote_body) {
                    result.errors.push(format!("写冲突文件失败: {}", e));
                }
            }
            Ok(None) => {}
            Err(e) => result.errors.push(format!("拉远端冲突文件失败: {}", e)),
        }
    }

    db.touch_sync_backend_pull(backend_id)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "done".into(),
            current: 0,
            total: 0,
            message: format!(
                "拉取完成: 下载 {} / 删本地 {} / 冲突 {} / 错误 {}",
                result.downloaded,
                result.deleted_local,
                result.conflicts,
                result.errors.len()
            ),
        },
    );

    Ok(result)
}

/// 解析 .md 文件：第一个 `# ` 行作为 title，其余作为 content
///
/// 如解析不到 # 标题，回退到 manifest entry 里的 title + 全文作为 content
fn parse_note_md(body: &str, fallback_title: &str) -> (String, String) {
    let mut lines = body.lines();
    let first = lines.next().unwrap_or("").trim();
    if let Some(rest) = first.strip_prefix("# ") {
        let title = rest.trim().to_string();
        // 跳过紧跟的空行（两个换行的写法）
        let body_rest: String = lines
            .skip_while(|l| l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return (title, body_rest);
    }
    (fallback_title.to_string(), body.to_string())
}

/// 把 "工作/周报" 风格的路径递归展平成 folder_id
///
/// 复用 `FolderService::ensure_path`（T-006 阶段已实现）
fn ensure_folder_path(db: &Database, path: &str) -> Result<Option<i64>, AppError> {
    if path.is_empty() {
        return Ok(None);
    }
    crate::services::folder::FolderService::ensure_path(db, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_md_with_h1() {
        let body = "# 我的标题\n\n正文内容\n第二段";
        let (t, c) = parse_note_md(body, "fallback");
        assert_eq!(t, "我的标题");
        assert_eq!(c, "正文内容\n第二段");
    }

    #[test]
    fn parse_md_no_h1_uses_fallback() {
        let body = "没有 H1 的正文";
        let (t, c) = parse_note_md(body, "manifest 标题");
        assert_eq!(t, "manifest 标题");
        assert_eq!(c, "没有 H1 的正文");
    }
}
