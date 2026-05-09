//! Manifest 计算 + diff
//!
//! `compute_local_manifest`：扫一遍 notes 表 + sync_remote_state，得到当前本地视角的 manifest
//! `diff_manifests`：比对本地 vs 远端 manifest，得出 push / pull / conflict 集合

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ManifestEntry, SyncManifestV1};

/// 计算单条笔记的 content_hash（SHA-256，hex 小写）
pub fn content_hash(title: &str, content: &str) -> String {
    let mut h = Sha256::new();
    h.update(title.as_bytes());
    h.update(b"\n");
    h.update(content.as_bytes());
    format!("{:x}", h.finalize())
}

/// 笔记 stable id（v1 临时方案：直接用 i64 笔记 id 转字符串；
/// 后续阶段加 notes.stable_uuid 列做严格多端去重）
pub fn stable_id_for(note_id: i64) -> String {
    note_id.to_string()
}

/// 远端文件路径约定：`notes/<stable_id>.md`
pub fn remote_path_for(stable_id: &str) -> String {
    format!("notes/{}.md", stable_id)
}

/// 从本地 notes 表 + folders 树构建 manifest
///
/// 包含：
/// - 所有未删除的笔记（tombstone=false）
/// - **不**包含已 soft delete 的笔记（v1 阶段先简化；后续接 sync_remote_state.tombstone 再补）
/// - 加密笔记仅保留 placeholder 内容上传 — 当前上传流程会传 note.content（即 placeholder），
///   不暴露密文；T-007 加密笔记应被同步排除还是带 placeholder，留给后续阶段决策
pub fn compute_local_manifest(
    db: &Database,
    app_version: &str,
    device: &str,
) -> Result<SyncManifestV1, AppError> {
    let conn = db.conn_lock()?;

    // 一次拿全部活跃笔记（id, title, content, updated_at, folder_id）
    let mut stmt = conn.prepare(
        "SELECT id, title, content, updated_at, folder_id
         FROM notes
         WHERE is_deleted = 0",
    )?;
    let rows: Vec<(i64, String, String, String, Option<i64>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    // 拿 folders 全树（id → (parent_id, name)）— 用来反查文件夹路径
    let mut stmt2 = conn.prepare("SELECT id, parent_id, name FROM folders")?;
    let folder_rows: Vec<(i64, Option<i64>, String)> = stmt2
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt2);
    drop(conn);

    let folders_by_id: HashMap<i64, (Option<i64>, String)> = folder_rows
        .into_iter()
        .map(|(id, p, name)| (id, (p, name)))
        .collect();

    let mut entries = Vec::with_capacity(rows.len());
    for (id, title, content, updated_at, folder_id) in rows {
        let path = folder_path_for(&folders_by_id, folder_id);
        let sid = stable_id_for(id);
        entries.push(ManifestEntry {
            stable_id: sid.clone(),
            title: title.clone(),
            content_hash: content_hash(&title, &content),
            updated_at,
            remote_path: remote_path_for(&sid),
            tombstone: false,
            folder_path: path,
        });
    }

    // 稳定排序（按 stable_id），方便 manifest 文本 diff 友好
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));

    Ok(SyncManifestV1 {
        manifest_version: SyncManifestV1::VERSION,
        app_version: app_version.to_string(),
        device: device.to_string(),
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        entries,
    })
}

/// 反查某 folder_id 的祖先链 → "工作/周报" 风格路径；根层为空串
fn folder_path_for(
    folders_by_id: &HashMap<i64, (Option<i64>, String)>,
    folder_id: Option<i64>,
) -> String {
    let mut chain: Vec<String> = Vec::new();
    let mut cur = folder_id;
    let mut guard = 0;
    while let Some(fid) = cur {
        guard += 1;
        if guard > 32 {
            break; // 防御性：避免脏数据导致死循环
        }
        match folders_by_id.get(&fid) {
            Some((parent, name)) => {
                chain.push(name.clone());
                cur = *parent;
            }
            None => break,
        }
    }
    chain.reverse();
    chain.join("/")
}

/// Manifest diff 结果
#[derive(Debug, Default)]
#[allow(dead_code)] // stats_total_* 字段供 UI 显示，目前命令层未读取
pub struct ManifestDiff {
    /// 本地有 / 远端无（或 hash 较新）→ 需要 push
    pub to_push: Vec<ManifestEntry>,
    /// 远端有 / 本地无（或 hash 较新）→ 需要 pull
    pub to_pull: Vec<ManifestEntry>,
    /// 双方都改了 → 冲突（last-write-wins，按 updated_at 较新者赢）
    pub conflicts: Vec<ConflictPair>,
    /// 远端 tombstone → 本地需删
    pub to_delete_local: Vec<ManifestEntry>,
    /// 本地比远端少（对方有我没有 + 不是 tombstone）→ pull 集已涵盖
    /// 本地有但比远端旧 → pull 集涵盖
    /// 本地有但远端 tombstone 标记删除 → to_delete_local
    pub stats_total_local: usize,
    pub stats_total_remote: usize,
}

#[derive(Debug)]
#[allow(dead_code)] // local 字段供 UI 显示冲突详情
pub struct ConflictPair {
    pub local: ManifestEntry,
    pub remote: ManifestEntry,
}

/// 比对本地 vs 远端 manifest
///
/// 算法：以 stable_id 为键 outer-join 两边
/// - 仅本地有 → push
/// - 仅远端有 → pull（如果远端 tombstone：本地无 → 直接忽略；本地有但应该不会到这分支）
/// - 双方都有：
///     - hash 相同 → 跳过
///     - hash 不同：双方 updated_at 比，新的赢
///         - 远端较新 → pull
///         - 本地较新 → push
///         - 时间也相同（极小概率）→ 算冲突，让上层决定
///
/// **本算法不直接判定"本地是否有变更"**：那是 sync_remote_state 的活，由上层 push/pull 决定
/// 是否真正调 backend.put / put_note。这个 diff 只回答"两份 manifest 不一致的项是哪些"。
pub fn diff_manifests(local: &SyncManifestV1, remote: &SyncManifestV1) -> ManifestDiff {
    let local_map: HashMap<&str, &ManifestEntry> = local
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e))
        .collect();
    let remote_map: HashMap<&str, &ManifestEntry> = remote
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e))
        .collect();

    let mut diff = ManifestDiff {
        stats_total_local: local.entries.len(),
        stats_total_remote: remote.entries.len(),
        ..Default::default()
    };

    // 仅本地有 → push
    for (sid, le) in &local_map {
        if !remote_map.contains_key(sid) {
            diff.to_push.push((*le).clone());
        }
    }
    // 仅远端有 → pull / delete_local
    for (sid, re) in &remote_map {
        if !local_map.contains_key(sid) {
            if re.tombstone {
                // 本地本就没有，跳过
                continue;
            }
            diff.to_pull.push((*re).clone());
        }
    }
    // 双方都有
    for (sid, le) in &local_map {
        if let Some(re) = remote_map.get(sid) {
            if re.tombstone {
                // 远端要求删本地
                diff.to_delete_local.push((*re).clone());
                continue;
            }
            if le.content_hash == re.content_hash {
                continue;
            }
            // hash 不同 → 比时间
            match le.updated_at.cmp(&re.updated_at) {
                std::cmp::Ordering::Greater => diff.to_push.push((*le).clone()),
                std::cmp::Ordering::Less => diff.to_pull.push((*re).clone()),
                std::cmp::Ordering::Equal => diff.conflicts.push(ConflictPair {
                    local: (*le).clone(),
                    remote: (*re).clone(),
                }),
            }
        }
    }

    diff
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str, hash: &str, ts: &str, tombstone: bool) -> ManifestEntry {
        ManifestEntry {
            stable_id: id.into(),
            title: title.into(),
            content_hash: hash.into(),
            updated_at: ts.into(),
            remote_path: format!("notes/{}.md", id),
            tombstone,
            folder_path: String::new(),
        }
    }

    fn manifest(entries: Vec<ManifestEntry>) -> SyncManifestV1 {
        SyncManifestV1 {
            manifest_version: 1,
            app_version: "test".into(),
            device: "host".into(),
            generated_at: "2026-04-25 12:00:00".into(),
            entries,
        }
    }

    #[test]
    fn diff_only_local() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1);
        assert_eq!(d.to_pull.len(), 0);
    }

    #[test]
    fn diff_only_remote() {
        let local = manifest(vec![]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1);
        assert_eq!(d.to_push.len(), 0);
    }

    #[test]
    fn diff_remote_newer() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h2", "2026-02-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1);
        assert_eq!(d.to_push.len(), 0);
    }

    #[test]
    fn diff_local_newer() {
        let local = manifest(vec![entry("1", "a", "h2", "2026-02-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1);
    }

    #[test]
    fn diff_conflict_same_ts() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h2", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.conflicts.len(), 1);
    }

    #[test]
    fn diff_remote_tombstone() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_delete_local.len(), 1);
    }

    #[test]
    fn diff_same_hash_no_op() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-02", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 0);
        assert_eq!(d.to_pull.len(), 0);
        assert_eq!(d.conflicts.len(), 0);
    }

    #[test]
    fn content_hash_changes_with_title() {
        let h1 = content_hash("a", "body");
        let h2 = content_hash("b", "body");
        assert_ne!(h1, h2);
    }
}
