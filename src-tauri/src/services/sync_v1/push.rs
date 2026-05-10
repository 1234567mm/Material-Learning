//! V1 推送：本地 → 远端
//!
//! 流程：
//! 1. 计算本地 manifest
//! 2. 读取远端 manifest（首次同步可能为 None）
//! 3. diff
//! 4. 对 to_push 中每条：put_note + 更新 sync_remote_state
//! 5. 写入新的远端 manifest（合并：本地全量 + 远端独有的；冲突保留较新的）
//!
//! v1 阶段简化：不支持本地软删除推送（tombstone），等 T-024 后续阶段补。

use tauri::{Emitter, Runtime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{SyncManifestV1, SyncPushResult};

use super::backend::SyncBackendImpl;
use super::manifest;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    backend_id: i64,
    phase: String, // "compute" | "diff" | "upload" | "manifest" | "done"
    current: usize,
    total: usize,
    message: String,
}

pub fn push<R: Runtime, E: Emitter<R>>(
    db: &Database,
    backend_id: i64,
    backend: &dyn SyncBackendImpl,
    app_version: &str,
    device: &str,
    emitter: &E,
) -> Result<SyncPushResult, AppError> {
    let mut result = SyncPushResult::default();
    let event_name = "sync_v1:progress";

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "compute".into(),
            current: 0,
            total: 0,
            message: "计算本地 manifest…".into(),
        },
    );
    let local = manifest::compute_local_manifest(db, app_version, device)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "diff".into(),
            current: 0,
            total: 0,
            message: "对比远端 manifest…".into(),
        },
    );
    let remote_opt = backend.read_manifest()?;
    let remote = remote_opt.unwrap_or_else(|| SyncManifestV1 {
        manifest_version: SyncManifestV1::VERSION,
        app_version: app_version.into(),
        device: device.into(),
        generated_at: String::new(),
        entries: vec![],
    });

    let diff = manifest::diff_manifests(&local, &remote);

    // 拿当前同步状态（hash → 用于跳过已同步的）
    let state_map = db.list_remote_state(backend_id)?;

    // 把笔记内容批量读出
    let conn = db.conn_lock()?;
    let mut stmt =
        conn.prepare("SELECT id, title, content, updated_at FROM notes WHERE is_deleted = 0")?;
    let local_notes: std::collections::HashMap<String, (i64, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, t, c, u)| (id.to_string(), (id, t, c, u)))
        .collect();
    drop(stmt);
    drop(conn);

    let total_to_push = diff.to_push.len();
    for (idx, entry) in diff.to_push.iter().enumerate() {
        let _ = emitter.emit(
            event_name,
            ProgressEvent {
                backend_id,
                phase: "upload".into(),
                current: idx + 1,
                total: total_to_push,
                message: format!("上传 {}", entry.title),
            },
        );

        // 跳过：sync_remote_state 已记录同 hash（说明本机其它进程刚推过；幂等）
        let parsed_id: i64 = entry.stable_id.parse().unwrap_or(-1);
        if parsed_id > 0 {
            if let Some(state) = state_map.get(&parsed_id) {
                if state.last_synced_hash == entry.content_hash && !state.tombstone {
                    result.skipped += 1;
                    continue;
                }
            }
        }

        // 取 content
        let (note_id, title, content, updated_at) = match local_notes.get(&entry.stable_id) {
            Some(v) => v.clone(),
            None => {
                result.errors.push(format!(
                    "笔记 {} 在 manifest 里但 DB 里找不到",
                    entry.stable_id
                ));
                continue;
            }
        };

        // 渲染 .md：第一行 # title，空行，body（如 body 已含 # 标题，可能重复，v1 简化不去重）
        let md = format_note_md(&title, &content);

        match backend.put_note(&entry.remote_path, &md) {
            Ok(_) => {
                if let Err(e) = db.upsert_remote_state(
                    backend_id,
                    note_id,
                    &entry.remote_path,
                    &entry.content_hash,
                    &updated_at,
                    false,
                ) {
                    result.errors.push(format!(
                        "upsert sync_remote_state 失败 (note {}): {}",
                        note_id, e
                    ));
                }
                result.uploaded += 1;
            }
            Err(e) => {
                result
                    .errors
                    .push(format!("上传失败 {}: {}", entry.title, e));
            }
        }
    }

    // 写新的远端 manifest = local 全量（v1 简化：本地为权威；后续阶段需合并远端独有项以支持多端）
    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "manifest".into(),
            current: 0,
            total: 0,
            message: "更新远端 manifest…".into(),
        },
    );
    if let Err(e) = backend.write_manifest(&local) {
        result.errors.push(format!("写远端 manifest 失败: {}", e));
    }

    db.touch_sync_backend_push(backend_id)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "done".into(),
            current: 0,
            total: 0,
            message: format!(
                "推送完成: 上传 {} / 跳过 {} / 错误 {}",
                result.uploaded,
                result.skipped,
                result.errors.len()
            ),
        },
    );

    let _ = (diff, &result); // 防止 lint：diff 当前仅用于循环
    Ok(result)
}

/// 把笔记渲染成 markdown 文本（只是给 .md 文件用）
fn format_note_md(title: &str, content: &str) -> String {
    // 如果 content 已有 # 标题，避免重复
    let trimmed = content.trim_start();
    if trimmed.starts_with("# ") {
        return content.to_string();
    }
    format!("# {}\n\n{}", title, content)
}

/// 让未引用的常量不报警告（暂留给 pull 用）
#[allow(dead_code)]
const _MARKER: () = ();
