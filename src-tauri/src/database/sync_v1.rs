//! T-024 同步 V1：sync_backends + sync_remote_state DAO
//!
//! 不和老 `database/sync.rs`（V0 ZIP 模式的 vacuum_into 等辅助）混在一起，
//! 单独成模块。老代码保留兼容 V0 流程。

use rusqlite::params;

use crate::error::AppError;
use crate::models::{SyncBackend, SyncBackendInput, SyncBackendKind, SyncRemoteState};

use super::Database;

fn parse_kind(s: &str) -> SyncBackendKind {
    match s {
        "local" => SyncBackendKind::Local,
        "webdav" => SyncBackendKind::Webdav,
        "s3" => SyncBackendKind::S3,
        // git 已下线（曾在原型阶段保留）；老数据兜底为 Local，让用户在 UI 上重选
        _ => SyncBackendKind::Local,
    }
}

fn kind_to_str(k: SyncBackendKind) -> &'static str {
    match k {
        SyncBackendKind::Local => "local",
        SyncBackendKind::Webdav => "webdav",
        SyncBackendKind::S3 => "s3",
    }
}

impl Database {
    // ─── sync_backends ─────────────────────────

    pub fn list_sync_backends(&self) -> Result<Vec<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, config_json, enabled, auto_sync, sync_interval_min,
                    last_push_ts, last_pull_ts, created_at, updated_at
             FROM sync_backends
             ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let kind_str: String = row.get(1)?;
                Ok(SyncBackend {
                    id: row.get(0)?,
                    kind: parse_kind(&kind_str),
                    name: row.get(2)?,
                    config_json: row.get(3)?,
                    enabled: row.get::<_, i32>(4)? != 0,
                    auto_sync: row.get::<_, i32>(5)? != 0,
                    sync_interval_min: row.get(6)?,
                    last_push_ts: row.get(7)?,
                    last_pull_ts: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_sync_backend(&self, id: i64) -> Result<Option<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                "SELECT id, kind, name, config_json, enabled, auto_sync, sync_interval_min,
                        last_push_ts, last_pull_ts, created_at, updated_at
                 FROM sync_backends WHERE id = ?1",
                [id],
                |row| {
                    let kind_str: String = row.get(1)?;
                    Ok(SyncBackend {
                        id: row.get(0)?,
                        kind: parse_kind(&kind_str),
                        name: row.get(2)?,
                        config_json: row.get(3)?,
                        enabled: row.get::<_, i32>(4)? != 0,
                        auto_sync: row.get::<_, i32>(5)? != 0,
                        sync_interval_min: row.get(6)?,
                        last_push_ts: row.get(7)?,
                        last_pull_ts: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    pub fn create_sync_backend(&self, input: &SyncBackendInput) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_backends
             (kind, name, config_json, enabled, auto_sync, sync_interval_min)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                kind_to_str(input.kind),
                input.name,
                input.config_json,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_sync_backend(&self, id: i64, input: &SyncBackendInput) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE sync_backends SET
                kind = ?1, name = ?2, config_json = ?3,
                enabled = ?4, auto_sync = ?5, sync_interval_min = ?6,
                updated_at = datetime('now', 'localtime')
             WHERE id = ?7",
            params![
                kind_to_str(input.kind),
                input.name,
                input.config_json,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("sync_backend {} 不存在", id)));
        }
        Ok(())
    }

    pub fn delete_sync_backend(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM sync_backends WHERE id = ?1", [id])?;
        Ok(affected > 0)
    }

    pub fn touch_sync_backend_push(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends
             SET last_push_ts = datetime('now', 'localtime'),
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn touch_sync_backend_pull(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends
             SET last_pull_ts = datetime('now', 'localtime'),
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    // ─── sync_remote_state ─────────────────────

    /// 拿某 backend 下所有笔记的同步状态，hash map 返回（按 note_id 索引）
    pub fn list_remote_state(
        &self,
        backend_id: i64,
    ) -> Result<std::collections::HashMap<i64, SyncRemoteState>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT backend_id, note_id, remote_path, last_synced_hash, last_synced_ts, tombstone
             FROM sync_remote_state WHERE backend_id = ?1",
        )?;
        let rows = stmt
            .query_map([backend_id], |row| {
                Ok(SyncRemoteState {
                    backend_id: row.get(0)?,
                    note_id: row.get(1)?,
                    remote_path: row.get(2)?,
                    last_synced_hash: row.get(3)?,
                    last_synced_ts: row.get(4)?,
                    tombstone: row.get::<_, i32>(5)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(|s| (s.note_id, s)).collect())
    }

    /// upsert 一条同步状态（推送/拉取成功后调）
    pub fn upsert_remote_state(
        &self,
        backend_id: i64,
        note_id: i64,
        remote_path: &str,
        content_hash: &str,
        updated_ts: &str,
        tombstone: bool,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_remote_state
                (backend_id, note_id, remote_path, last_synced_hash, last_synced_ts, tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(backend_id, note_id) DO UPDATE SET
                remote_path      = excluded.remote_path,
                last_synced_hash = excluded.last_synced_hash,
                last_synced_ts   = excluded.last_synced_ts,
                tombstone        = excluded.tombstone",
            params![
                backend_id,
                note_id,
                remote_path,
                content_hash,
                updated_ts,
                tombstone as i32,
            ],
        )?;
        Ok(())
    }

    /// 物理删除已确认 tombstone 推送完成的状态行
    ///
    /// 预留给 T-024 后续阶段：tombstone 同步成功后清理 sync_remote_state
    #[allow(dead_code)]
    pub fn purge_remote_state(&self, backend_id: i64, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "DELETE FROM sync_remote_state WHERE backend_id = ?1 AND note_id = ?2",
            [backend_id, note_id],
        )?;
        Ok(())
    }
}
