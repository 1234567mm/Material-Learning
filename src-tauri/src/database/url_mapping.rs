use std::collections::HashMap;

use rusqlite::params;

use crate::error::AppError;

use super::Database;

impl Database {
    /// 批量写入 URL 映射对（幂等：(note_id, internal_url) 重复出现时跳过）
    ///
    /// 用于 `open_markdown_file` 把原始 URL → 内部 asset URL 的替换关系登记下来，
    /// 写回 .md 时按 internal_url 反查回 original_url，保证原文件链接形态不变。
    pub fn insert_url_mappings(
        &self,
        note_id: i64,
        pairs: &[(String, String)],
    ) -> Result<(), AppError> {
        if pairs.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO note_url_mapping (note_id, internal_url, original_url)
                 VALUES (?1, ?2, ?3)",
            )?;
            for (internal, original) in pairs {
                stmt.execute(params![note_id, internal, original])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 列出某笔记的所有映射，返回 `internal_url → original_url` 的 HashMap，便于反查替换
    pub fn list_url_mappings(&self, note_id: i64) -> Result<HashMap<String, String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT internal_url, original_url FROM note_url_mapping WHERE note_id = ?1",
        )?;
        let rows = stmt.query_map([note_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row?;
            map.insert(k, v);
        }
        Ok(map)
    }

    /// 清空某笔记的所有 URL 映射（重新打开 .md 时先清空再重建，避免历史脏数据）
    pub fn clear_url_mappings(&self, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM note_url_mapping WHERE note_id = ?1", [note_id])?;
        Ok(())
    }

    /// 读取笔记上次写回原 .md 时的文件 mtime（秒级 unix timestamp）
    ///
    /// None = 从未写回过。冲突检测时用：当前 fs::metadata().modified() 与此值不一致就算冲突。
    pub fn get_writeback_mtime(&self, note_id: i64) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT last_writeback_mtime FROM notes WHERE id = ?1")?;
        let mt: Option<i64> = stmt
            .query_row([note_id], |row| row.get::<_, Option<i64>>(0))
            .unwrap_or(None);
        Ok(mt)
    }

    /// 写回成功后更新 mtime（传写回完成后 fs::metadata().modified() 的秒数）
    pub fn set_writeback_mtime(&self, note_id: i64, mtime: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes SET last_writeback_mtime = ?1 WHERE id = ?2",
            params![mtime, note_id],
        )?;
        Ok(())
    }

    /// 清空 mtime 基线（解除外部 .md 关联时用，避免脏数据残留导致下次再次关联误判冲突）
    pub fn clear_writeback_mtime(&self, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes SET last_writeback_mtime = NULL WHERE id = ?1",
            [note_id],
        )?;
        Ok(())
    }
}
