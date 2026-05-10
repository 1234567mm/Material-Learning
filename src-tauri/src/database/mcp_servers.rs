//! 外部 MCP server 注册表 DAO（M5-2）
//!
//! 表结构见 schema.rs::migrate_v32_to_v33。
//! args / env 在 SQLite 里都存为 JSON 字符串，DAO 内透明序列化/反序列化。

use std::collections::HashMap;

use rusqlite::{params, Row};

use super::Database;
use crate::error::AppError;
use crate::models::{McpServer, McpServerInput};

const SELECT_COLUMNS: &str =
    "id, name, transport, command, args, env, enabled, created_at, updated_at";

fn row_to_server(row: &Row<'_>) -> rusqlite::Result<McpServer> {
    let args_json: String = row.get(4)?;
    let env_json: String = row.get(5)?;
    Ok(McpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        transport: row.get(2)?,
        command: row.get(3)?,
        // 解析失败给默认值（用户手动改坏了 JSON 不应让查询整体失败）
        args: serde_json::from_str(&args_json).unwrap_or_default(),
        env: serde_json::from_str(&env_json).unwrap_or_default(),
        enabled: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

impl Database {
    pub fn list_mcp_servers(&self) -> Result<Vec<McpServer>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {} FROM mcp_servers ORDER BY name", SELECT_COLUMNS);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_server)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_mcp_server(&self, id: i64) -> Result<Option<McpServer>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {} FROM mcp_servers WHERE id = ?1", SELECT_COLUMNS);
        let mut stmt = conn.prepare(&sql)?;
        let r = stmt.query_row(params![id], row_to_server).ok();
        Ok(r)
    }

    pub fn create_mcp_server(&self, input: &McpServerInput) -> Result<McpServer, AppError> {
        let args_json = serde_json::to_string(&input.args)
            .map_err(|e| AppError::Custom(format!("args 序列化失败: {e}")))?;
        let env_json = serde_json::to_string(&input.env)
            .map_err(|e| AppError::Custom(format!("env 序列化失败: {e}")))?;
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO mcp_servers (name, transport, command, args, env, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.name,
                input.transport,
                input.command,
                args_json,
                env_json,
                input.enabled as i32,
            ],
        )?;
        let id = conn.last_insert_rowid();
        let sql = format!("SELECT {} FROM mcp_servers WHERE id = ?1", SELECT_COLUMNS);
        let mut stmt = conn.prepare(&sql)?;
        let r = stmt.query_row(params![id], row_to_server)?;
        Ok(r)
    }

    pub fn update_mcp_server(
        &self,
        id: i64,
        input: &McpServerInput,
    ) -> Result<McpServer, AppError> {
        let args_json = serde_json::to_string(&input.args)
            .map_err(|e| AppError::Custom(format!("args 序列化失败: {e}")))?;
        let env_json = serde_json::to_string(&input.env)
            .map_err(|e| AppError::Custom(format!("env 序列化失败: {e}")))?;
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE mcp_servers
             SET name = ?1, transport = ?2, command = ?3, args = ?4, env = ?5,
                 enabled = ?6, updated_at = datetime('now', 'localtime')
             WHERE id = ?7",
            params![
                input.name,
                input.transport,
                input.command,
                args_json,
                env_json,
                input.enabled as i32,
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("mcp_server {} 不存在", id)));
        }
        let sql = format!("SELECT {} FROM mcp_servers WHERE id = ?1", SELECT_COLUMNS);
        let mut stmt = conn.prepare(&sql)?;
        let r = stmt.query_row(params![id], row_to_server)?;
        Ok(r)
    }

    pub fn delete_mcp_server(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    pub fn set_mcp_server_enabled(&self, id: i64, enabled: bool) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE mcp_servers SET enabled = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2",
            params![enabled as i32, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("mcp_server {} 不存在", id)));
        }
        Ok(())
    }
}

// 让 HashMap 在 Cargo.toml 不引入额外 dep（std 自带），
// 但放这一行避免 `unused_imports` 警告（Db 操作里没直接用 HashMap）
#[allow(dead_code)]
fn _hashmap_anchor() -> HashMap<String, String> {
    HashMap::new()
}
