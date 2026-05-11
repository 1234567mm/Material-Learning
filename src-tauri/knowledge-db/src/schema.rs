use rusqlite::{Connection, Result};
use std::path::Path;

pub fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
        -- panels: 知识板块
        CREATE TABLE IF NOT EXISTS panels (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            system_prompt TEXT,
            created_at  TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
        );

        -- chat_sessions: 对话会话
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id    INTEGER NOT NULL REFERENCES panels(id),
            title       TEXT,
            created_at  TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT DEFAULT (datetime('now', 'localtime')),
            ended_at    TEXT,
            is_active   INTEGER DEFAULT 1
        );

        -- chat_messages: 消息历史
        CREATE TABLE IF NOT EXISTS chat_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER NOT NULL REFERENCES chat_sessions(id),
            role        TEXT NOT NULL,  -- 'user' | 'assistant' | 'system'
            content     TEXT NOT NULL,
            token_count INTEGER,
            created_at  TEXT DEFAULT (datetime('now', 'localtime'))
        );

        -- summaries: 自动摘要
        CREATE TABLE IF NOT EXISTS summaries (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id        INTEGER NOT NULL REFERENCES panels(id),
            session_id      INTEGER REFERENCES chat_sessions(id),
            content         TEXT NOT NULL,
            char_count      INTEGER NOT NULL,
            trigger_type    TEXT NOT NULL,  -- 'manual' | 'overflow'
            created_at      TEXT DEFAULT (datetime('now', 'localtime'))
        );

        -- files: 文件索引
        CREATE TABLE IF NOT EXISTS files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id    INTEGER NOT NULL REFERENCES panels(id),
            path        TEXT NOT NULL,
            title       TEXT,
            hash        TEXT,
            created_at  TEXT DEFAULT (datetime('now', 'localtime'))
        );

        -- file_chunks: 文件分块
        CREATE TABLE IF NOT EXISTS file_chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id     INTEGER NOT NULL REFERENCES files(id),
            chunk_index INTEGER NOT NULL,
            content     TEXT NOT NULL,
            embedding_ref BLOB,  -- 向量 blob
            created_at  TEXT DEFAULT (datetime('now', 'localtime'))
        );

        -- FTS5 搜索表
        CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
            title, content, content=files, content_rowid=id
        );

        -- global_memories: 跨面板全局记忆（Learn）
        CREATE TABLE IF NOT EXISTS global_memories (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            content            TEXT NOT NULL,
            source_panel_id     INTEGER REFERENCES panels(id),
            source_session_id   INTEGER REFERENCES chat_sessions(id),
            quality_score       REAL DEFAULT 0.5,
            used_count          INTEGER DEFAULT 0,
            created_at          TEXT DEFAULT (datetime('now', 'localtime'))
        );
    "#)?;
    Ok(())
}

pub fn open_database(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    create_tables(&conn)?;
    Ok(conn)
}