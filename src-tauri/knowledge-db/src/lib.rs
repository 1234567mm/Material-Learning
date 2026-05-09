mod schema;

use std::sync::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use schema::open_database;

#[derive(Error, Debug)]
pub enum KbError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Invalid operation: {0}")]
    Invalid(String),
}

pub type KbResult<T> = Result<T, KbError>;

#[derive(Debug, Serialize, Deserialize)]
pub struct Panel {
    pub id: i64,
    pub name: String,
    pub system_prompt: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: i64,
    pub panel_id: i64,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: i64,
    pub role: String,
    pub content: String,
    pub token_count: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Summary {
    pub id: i64,
    pub panel_id: i64,
    pub session_id: Option<i64>,
    pub content: String,
    pub char_count: i64,
    pub trigger_type: String,
    pub created_at: String,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(conn: Connection) -> Self {
        Self { conn: Mutex::new(conn) }
    }

    fn with_conn<T, F>(&self, f: F) -> KbResult<T>
    where
        F: FnOnce(&Connection) -> KbResult<T>,
    {
        let guard = self.conn.lock().map_err(|e| KbError::Invalid(e.to_string()))?;
        f(&guard)
    }

    // ==================== Panel CRUD ====================

    pub fn create_panel(&self, name: &str, system_prompt: Option<&str>) -> KbResult<i64> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO panels (name, system_prompt) VALUES (?1, ?2)",
                params![name, system_prompt],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn get_panels(&self) -> KbResult<Vec<Panel>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, system_prompt, created_at, updated_at FROM panels ORDER BY created_at DESC"
            )?;
            let panels = stmt.query_map([], |row| {
                Ok(Panel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    system_prompt: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(panels)
        })
    }

    pub fn get_panel(&self, id: i64) -> KbResult<Panel> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, system_prompt, created_at, updated_at FROM panels WHERE id = ?1"
            )?;
            stmt.query_row([id], |row| {
                Ok(Panel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    system_prompt: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            }).map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => KbError::NotFound(format!("Panel {}", id)),
                _ => KbError::Database(e),
            })
        })
    }

    pub fn update_panel(&self, id: i64, name: &str, system_prompt: Option<&str>) -> KbResult<()> {
        self.with_conn(|conn| {
            let rows = conn.execute(
                "UPDATE panels SET name = ?1, system_prompt = ?2, updated_at = datetime('now', 'localtime') WHERE id = ?3",
                params![name, system_prompt, id],
            )?;
            if rows == 0 {
                return Err(KbError::NotFound(format!("Panel {}", id)));
            }
            Ok(())
        })
    }

    pub fn delete_panel(&self, id: i64) -> KbResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM panels WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    // ==================== Chat Session CRUD ====================

    pub fn create_chat_session(&self, panel_id: i64, title: Option<&str>) -> KbResult<i64> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO chat_sessions (panel_id, title) VALUES (?1, ?2)",
                params![panel_id, title],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn get_chat_sessions(&self, panel_id: i64) -> KbResult<Vec<ChatSession>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, panel_id, title, created_at, updated_at, ended_at, is_active
                 FROM chat_sessions WHERE panel_id = ?1 ORDER BY created_at DESC"
            )?;
            let sessions = stmt.query_map([panel_id], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    panel_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    is_active: row.get::<_, i64>(6)? != 0,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(sessions)
        })
    }

    pub fn end_chat_session(&self, id: i64) -> KbResult<()> {
        self.with_conn(|conn| {
            let rows = conn.execute(
                "UPDATE chat_sessions SET ended_at = datetime('now', 'localtime'), is_active = 0,
                 updated_at = datetime('now', 'localtime') WHERE id = ?1",
                [id],
            )?;
            if rows == 0 {
                return Err(KbError::NotFound(format!("Chat session {}", id)));
            }
            Ok(())
        })
    }

    pub fn get_active_session(&self, panel_id: i64) -> KbResult<Option<ChatSession>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, panel_id, title, created_at, updated_at, ended_at, is_active
                 FROM chat_sessions WHERE panel_id = ?1 AND is_active = 1 LIMIT 1"
            )?;
            let result = stmt.query_row([panel_id], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    panel_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    is_active: row.get::<_, i64>(6)? != 0,
                })
            });
            match result {
                Ok(session) => Ok(Some(session)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(KbError::Database(e)),
            }
        })
    }

    pub fn get_chat_session(&self, id: i64) -> KbResult<ChatSession> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, panel_id, title, created_at, updated_at, ended_at, is_active
                 FROM chat_sessions WHERE id = ?1"
            )?;
            stmt.query_row([id], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    panel_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    is_active: row.get::<_, i64>(6)? != 0,
                })
            }).map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => KbError::NotFound(format!("Chat session {}", id)),
                _ => KbError::Database(e),
            })
        })
    }

    // ==================== Chat Message CRUD ====================

    pub fn add_message(&self, session_id: i64, role: &str, content: &str, token_count: Option<i64>) -> KbResult<i64> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO chat_messages (session_id, role, content, token_count) VALUES (?1, ?2, ?3, ?4)",
                params![session_id, role, content, token_count],
            )?;
            conn.execute(
                "UPDATE chat_sessions SET updated_at = datetime('now', 'localtime') WHERE id = ?1",
                [session_id],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn get_messages(&self, session_id: i64) -> KbResult<Vec<ChatMessage>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, role, content, token_count, created_at
                 FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC"
            )?;
            let messages = stmt.query_map([session_id], |row| {
                Ok(ChatMessage {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    token_count: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(messages)
        })
    }

    // ==================== Summary CRUD ====================

    pub fn create_summary(&self, panel_id: i64, session_id: Option<i64>, content: &str, char_count: i64, trigger_type: &str) -> KbResult<i64> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO summaries (panel_id, session_id, content, char_count, trigger_type) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![panel_id, session_id, content, char_count, trigger_type],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn get_summaries(&self, panel_id: i64, limit: i64) -> KbResult<Vec<Summary>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, panel_id, session_id, content, char_count, trigger_type, created_at
                 FROM summaries WHERE panel_id = ?1 ORDER BY created_at DESC LIMIT ?2"
            )?;
            let summaries = stmt.query_map(params![panel_id, limit], |row| {
                Ok(Summary {
                    id: row.get(0)?,
                    panel_id: row.get(1)?,
                    session_id: row.get(2)?,
                    content: row.get(3)?,
                    char_count: row.get(4)?,
                    trigger_type: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(summaries)
        })
    }

    // ==================== File & Chunk CRUD ====================

    pub fn add_file(&self, panel_id: i64, path: &str, title: Option<&str>, hash: Option<&str>) -> KbResult<i64> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO files (panel_id, path, title, hash) VALUES (?1, ?2, ?3, ?4)",
                params![panel_id, path, title, hash],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn get_files(&self, panel_id: i64) -> KbResult<Vec<(i64, String, Option<String>, String)>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, path, title, created_at FROM files WHERE panel_id = ?1 ORDER BY created_at DESC"
            )?;
            let files = stmt.query_map([panel_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(files)
        })
    }

    pub fn add_chunk(&self, file_id: i64, chunk_index: i64, content: &str, embedding: Option<&[f32]>) -> KbResult<i64> {
        self.with_conn(|conn| {
            let embedding_blob: Option<Vec<u8>> = embedding.map(|e| {
                let bytes: Vec<u8> = e.iter().flat_map(|f| f.to_le_bytes()).collect();
                bytes
            });
            conn.execute(
                "INSERT INTO file_chunks (file_id, chunk_index, content, embedding_ref) VALUES (?1, ?2, ?3, ?4)",
                params![file_id, chunk_index, content, embedding_blob],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn get_chunks(&self, file_id: i64) -> KbResult<Vec<(i64, i64, String)>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, chunk_index, content FROM file_chunks WHERE file_id = ?1 ORDER BY chunk_index"
            )?;
            let chunks = stmt.query_map([file_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(chunks)
        })
    }

    // ==================== Search (FTS5) ====================

    pub fn search_files(&self, query: &str, panel_id: Option<i64>, limit: i64) -> KbResult<Vec<(i64, String, String)>> {
        self.with_conn(|conn| {
            let sql = if panel_id.is_some() {
                "SELECT f.id, f.title, snippet(files_fts, 0, '<mark>', '</mark>', '...', 32)
                 FROM files_fts f
                 JOIN files ON f.id = files.id
                 WHERE files_fts MATCH ?1 AND files.panel_id = ?2
                 ORDER BY rank LIMIT ?3"
            } else {
                "SELECT f.id, f.title, snippet(files_fts, 0, '<mark>', '</mark>', '...', 32)
                 FROM files_fts f
                 WHERE files_fts MATCH ?1
                 ORDER BY rank LIMIT ?2"
            };

            let mut stmt = conn.prepare(sql)?;
            let results = if let Some(pid) = panel_id {
                stmt.query_map(params![query, pid, limit], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?.collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![query, limit], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?.collect::<Result<Vec<_>, _>>()?
            };
            Ok(results)
        })
    }

    pub fn index_file(&self, file_id: i64, title: &str, content: &str) -> KbResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO files_fts (id, title, content) VALUES (?1, ?2, ?3)",
                params![file_id, title, content],
            )?;
            Ok(())
        })
    }
}