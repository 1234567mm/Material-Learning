# Phase 4: Knowledge Chat UI + Learn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build /knowledge page (two-column layout) with AI chat per panel, automatic & manual summarization, and a cross-panel global memory (Learn) system.

**Architecture:** Two-column layout (panel list left, chat/search/settings right). New `knowledge_*` Tauri commands wrap knowledge-db CRUD + llama calls. New `global_memories` table stores quality-scored cross-panel summaries. Frontend uses existing `invoke` pattern with new `knowledgeApi`.

**Tech Stack:** Tauri 2.x, React Router v7, knowledge-db, llama.rs, TypeScript

---

## File Map

### New Files

```
src/pages/knowledge/
├── index.tsx          # page container: two-column layout
├── PanelList.tsx       # left sidebar: panel CRUD list
├── ChatPanel.tsx       # right main: tabbed (Chat | 搜索 | 设置)
├── ChatMessage.tsx     # message bubble component
└── MemoryManager.tsx   # Settings tab: view/delete global memories

src-tauri/src/commands/knowledge.rs   # all knowledge_* commands
docs/superpowers/plans/2026-05-11-knowledge-chat-ui-learn-plan.md
```

### Modified Files

```
src/types/index.ts           # add KnowledgePanel, KnowledgeSession, KnowledgeMessage, KnowledgeSummary, KnowledgeSimilarityHit, KnowledgeMemory
src/lib/api/index.ts        # add knowledgeApi
src/Router.tsx             # add /knowledge route
src-tauri/src/commands/mod.rs           # register knowledge module
src-tauri/knowledge-db/src/schema.rs     # add global_memories table
src-tauri/knowledge-db/src/lib.rs        # add GlobalMemory struct + CRUD
```

---

## Task 1: Database Schema — global_memories

**Files:**
- Modify: `src-tauri/knowledge-db/src/schema.rs`

- [ ] **Step 1: Review existing schema**

Read `src-tauri/knowledge-db/src/schema.rs` to understand the existing table definitions and migration pattern.

- [ ] **Step 2: Add global_memories CREATE TABLE**

Append after existing tables:

```sql
CREATE TABLE IF NOT EXISTS global_memories (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    content            TEXT NOT NULL,
    source_panel_id     INTEGER REFERENCES panels(id),
    source_session_id  INTEGER REFERENCES chat_sessions(id),
    quality_score      REAL DEFAULT 0.5,
    used_count         INTEGER DEFAULT 0,
    created_at         TEXT DEFAULT (datetime('now', 'localtime'))
);
```

- [ ] **Step 3: Verify schema compiles**

Run: `cd src-tauri && cargo check -p knowledge-db`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/knowledge-db/src/schema.rs
git commit -m "feat(kb): add global_memories table for cross-panel Learn"
```

---

## Task 2: knowledge-db — GlobalMemory struct + CRUD

**Files:**
- Modify: `src-tauri/knowledge-db/src/lib.rs`

- [ ] **Step 1: Add GlobalMemory struct**

After the existing `Summary` struct (around line 53), add:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct GlobalMemory {
    pub id: i64,
    pub content: String,
    pub source_panel_id: i64,
    pub source_session_id: Option<i64>,
    pub quality_score: f64,
    pub used_count: i64,
    pub created_at: String,
}
```

- [ ] **Step 2: Add create_global_memory method**

After `create_summary` (around line 308), add:

```rust
pub fn create_global_memory(
    &self,
    content: &str,
    source_panel_id: i64,
    source_session_id: Option<i64>,
    quality_score: f64,
) -> KbResult<i64> {
    self.with_conn(|conn| {
        conn.execute(
            "INSERT INTO global_memories (content, source_panel_id, source_session_id, quality_score) VALUES (?1, ?2, ?3, ?4)",
            params![content, source_panel_id, source_session_id, quality_score],
        )?;
        Ok(conn.last_insert_rowid())
    })
}
```

- [ ] **Step 3: Add list_global_memories method**

```rust
pub fn list_global_memories(&self, limit: i64) -> KbResult<Vec<GlobalMemory>> {
    self.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, content, source_panel_id, source_session_id, quality_score, used_count, created_at
             FROM global_memories ORDER BY quality_score DESC, used_count DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(GlobalMemory {
                id: row.get(0)?,
                content: row.get(1)?,
                source_panel_id: row.get(2)?,
                source_session_id: row.get(3)?,
                quality_score: row.get(4)?,
                used_count: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}
```

- [ ] **Step 4: Add increment_used_count and delete_global_memory**

```rust
pub fn increment_global_memory_used_count(&self, id: i64) -> KbResult<()> {
    self.with_conn(|conn| {
        conn.execute(
            "UPDATE global_memories SET used_count = used_count + 1 WHERE id = ?1",
            [id],
        )?;
        Ok(())
    })
}

pub fn delete_global_memory(&self, id: i64) -> KbResult<()> {
    self.with_conn(|conn| {
        conn.execute("DELETE FROM global_memories WHERE id = ?1", [id])?;
        Ok(())
    })
}
```

- [ ] **Step 5: Add get_recent_summaries_for_context method**

```rust
pub fn get_recent_summaries_for_context(&self, panel_id: i64, limit: i64) -> KbResult<Vec<Summary>> {
    self.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, panel_id, session_id, content, char_count, trigger_type, created_at
             FROM summaries WHERE panel_id = ?1 ORDER BY created_at DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![panel_id, limit], |row| {
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
        Ok(rows)
    })
}
```

- [ ] **Step 6: Run tests**

Run: `cargo test -p knowledge-db`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src-tauri/knowledge-db/src/lib.rs
git commit -m "feat(kb): add GlobalMemory struct and CRUD operations"
```

---

## Task 3: TypeScript Types

**Files:**
- Modify: `src/types/index.ts` (add new types to the export block)

- [ ] **Step 1: Read types/index.ts to find where to add**

Find the export block and the existing `AiConversation` / `AiMessage` types nearby.

- [ ] **Step 2: Add new interfaces**

After existing type definitions, add:

```typescript
export interface KnowledgePanel {
  id: number;
  name: string;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSession {
  id: number;
  panel_id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  is_active: boolean;
}

export interface KnowledgeMessage {
  id: number;
  session_id: number;
  role: "user" | "assistant" | "system";
  content: string;
  token_count: number | null;
  created_at: string;
}

export interface KnowledgeSummary {
  id: number;
  panel_id: number;
  session_id: number | null;
  content: string;
  char_count: number;
  trigger_type: "manual" | "overflow";
  created_at: string;
}

export interface KnowledgeSimilarityHit {
  chunk_id: number;
  file_id: number;
  content: string;
  score: number;
}

export interface KnowledgeMemory {
  id: number;
  content: string;
  source_panel_id: number;
  source_session_id: number | null;
  quality_score: number;
  used_count: number;
  created_at: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add Knowledge* types for Phase 4 UI"
```

---

## Task 4: Backend Tauri Commands

**Files:**
- Create: `src-tauri/src/commands/knowledge.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Create knowledge.rs with all commands**

```rust
use crate::state::AppState;
use knowledge_db::{ChatSession, ChatMessage, Summary, GlobalMemory};

#[tauri::command]
pub async fn knowledge_list_panels(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<knowledge_db::Panel>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.get_panels().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_create_panel(
    state: tauri::State<'_, AppState>,
    name: String,
    system_prompt: Option<String>,
) -> Result<i64, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.create_panel(&name, system_prompt.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_update_panel(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    system_prompt: Option<String>,
) -> Result<(), String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.update_panel(id, &name, system_prompt.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_delete_panel(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.delete_panel(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_list_sessions(
    state: tauri::State<'_, AppState>,
    panel_id: i64,
) -> Result<Vec<ChatSession>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.get_chat_sessions(panel_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_send_message(
    state: tauri::State<'_, AppState>,
    session_id: i64,
    content: String,
) -> Result<ChatMessage, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动")?;

    let session = kb.get_chat_session(session_id).map_err(|e| e.to_string())?;
    if !session.is_active {
        return Err("会话已结束，请创建新会话".to_string());
    }

    // Save user message
    kb.add_message(session_id, "user", &content, None).map_err(|e| e.to_string())?;

    // Build context: system_prompt + recent summaries + global memories
    let panel = kb.get_panel(session.panel_id).map_err(|e| e.to_string())?;
    let summaries = kb.get_recent_summaries_for_context(session.panel_id, 3).map_err(|e| e.to_string())?;
    let global_memories = kb.list_global_memories(5).map_err(|e| e.to_string())?;

    let mut system_content = panel.system_prompt.unwrap_or_default();
    if !summaries.is_empty() {
        system_content.push_str("\n\n=== 历史摘要 ===\n");
        for s in &summaries {
            system_content.push_str(&format!("- {}\n", s.content));
        }
    }
    if !global_memories.is_empty() {
        system_content.push_str("\n=== 相关学习 ===\n");
        for m in &global_memories {
            system_content.push_str(&format!("- {}\n", m.content));
        }
    }

    let history = kb.get_messages(session_id).map_err(|e| e.to_string())?;
    let mut messages: Vec<crate::services::llama::ChatMessage> = Vec::new();
    if !system_content.is_empty() {
        messages.push(crate::services::llama::ChatMessage {
            role: "system".to_string(),
            content: system_content,
        });
    }
    for msg in history {
        messages.push(crate::services::llama::ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }

    let reply = llama.chat(messages).await.map_err(|e| e.to_string())?;
    let msg_id = kb.add_message(session_id, "assistant", &reply, None).map_err(|e| e.to_string())?;

    kb.get_messages(session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == msg_id)
        .ok_or_else(|| "Failed to retrieve assistant message".to_string())
}

#[tauri::command]
pub async fn knowledge_end_session(
    state: tauri::State<'_, AppState>,
    session_id: i64,
) -> Result<Summary, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动")?;

    let session = kb.get_chat_session(session_id).map_err(|e| e.to_string())?;
    kb.end_chat_session(session_id).map_err(|e| e.to_string())?;
    let messages = kb.get_messages(session_id).map_err(|e| e.to_string())?;

    // Generate summary
    let mut prompt = "请简要总结以下对话的主要内容和结论，用中文回复。输出格式：摘要内容\nScore: 0.XX（0到1之间的质量分数）：\n\n".to_string();
    for msg in &messages {
        prompt.push_str(&format!("{}: {}\n", msg.role, msg.content));
    }

    let response = llama.complete(&prompt).await.map_err(|e| e.to_string())?;

    // Parse quality score from response
    let (summary_content, quality_score) = if let Some(score_pos) = response.find("Score: ") {
        let after_score = &response[score_pos + 7..];
        let score_end = after_score.find('\n').unwrap_or(after_score.len());
        let score_str = after_score[..score_end].trim();
        let score: f64 = score_str.parse().unwrap_or(0.5);
        let content = response[..score_pos].trim().to_string();
        (content, score)
    } else {
        (response.trim().to_string(), 0.5)
    };

    let char_count = summary_content.chars().count() as i64;
    let summary_id = kb.create_summary(
        session.panel_id,
        Some(session_id),
        &summary_content,
        char_count,
        "manual",
    ).map_err(|e| e.to_string())?;

    // Store high-quality summary in global memories
    if quality_score > 0.7 {
        kb.create_global_memory(
            &summary_content,
            session.panel_id,
            Some(session_id),
            quality_score,
        ).map_err(|e| e.to_string())?;
    }

    kb.get_summaries(session.panel_id, 10)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == summary_id)
        .ok_or_else(|| "Failed to retrieve summary".to_string())
}

#[tauri::command]
pub async fn knowledge_get_messages(
    state: tauri::State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<ChatMessage>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.get_messages(session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_search_files(
    state: tauri::State<'_, AppState>,
    query: String,
    panel_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<(i64, String, String)>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let limit = limit.unwrap_or(20) as i64;
    kb.search_files(&query, panel_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_similar_chunks(
    state: tauri::State<'_, AppState>,
    query: String,
    panel_id: i64,
    limit: Option<usize>,
) -> Result<Vec<knowledge_db::SimilarityHit>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    let llama = state.llama.as_ref().ok_or_else(|| "llama-server 未启动")?;
    let limit = limit.unwrap_or(5);
    let embedding = llama.embed(&query).await.map_err(|e| e.to_string())?;
    kb.search_similar(&embedding, panel_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_list_memories(
    state: tauri::State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<GlobalMemory>, String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.list_global_memories(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn knowledge_forget_memory(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let kb = state.knowledge_db.as_ref().ok_or_else(|| "知识库未初始化")?;
    kb.delete_global_memory(id).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register in mod.rs**

Add to `src-tauri/src/commands/mod.rs`:

```rust
pub mod knowledge;
```

- [ ] **Step 3: Export from lib.rs commands**

Read `src-tauri/src/lib.rs` commands section and add the `knowledge::` entries to the module registration.

- [ ] **Step 4: Verify compilation**

Run: `cargo check -p material_learning_lib`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/knowledge.rs src-tauri/src/commands/mod.rs
git commit -m "feat(commands): add knowledge_* Tauri commands for Phase 4"
```

---

## Task 5: Frontend API — knowledgeApi

**Files:**
- Modify: `src/lib/api/index.ts`

- [ ] **Step 1: Import new types**

Find the `import type { ... }` block in api/index.ts, add:
```typescript
  KnowledgePanel,
  KnowledgeSession,
  KnowledgeMessage,
  KnowledgeSummary,
  KnowledgeSimilarityHit,
  KnowledgeMemory,
```

- [ ] **Step 2: Add knowledgeApi**

Append at the end of the file (before the last closing `}`):

```typescript
export const knowledgeApi = {
  listPanels: () => invoke<KnowledgePanel[]>("knowledge_list_panels"),
  createPanel: (name: string, systemPrompt?: string) =>
    invoke<number>("knowledge_create_panel", { name, systemPrompt }),
  updatePanel: (id: number, name: string, systemPrompt?: string) =>
    invoke<void>("knowledge_update_panel", { id, name, systemPrompt }),
  deletePanel: (id: number) =>
    invoke<void>("knowledge_delete_panel", { id }),
  listSessions: (panelId: number) =>
    invoke<KnowledgeSession[]>("knowledge_list_sessions", { panelId }),
  sendMessage: (sessionId: number, content: string) =>
    invoke<KnowledgeMessage>("knowledge_send_message", { sessionId, content }),
  endSession: (sessionId: number) =>
    invoke<KnowledgeSummary>("knowledge_end_session", { sessionId }),
  getMessages: (sessionId: number) =>
    invoke<KnowledgeMessage[]>("knowledge_get_messages", { sessionId }),
  searchFiles: (query: string, panelId?: number, limit?: number) =>
    invoke<[number, string, string][]>("knowledge_search_files", { query, panelId, limit }),
  similarChunks: (query: string, panelId: number, limit?: number) =>
    invoke<KnowledgeSimilarityHit[]>("knowledge_similar_chunks", { query, panelId, limit }),
  listMemories: (limit?: number) =>
    invoke<KnowledgeMemory[]>("knowledge_list_memories", { limit }),
  forgetMemory: (id: number) =>
    invoke<void>("knowledge_forget_memory", { id }),
};
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd /home/wchao/workspace/Material-Learning && npx tsc --noEmit 2>&1 | head -30`
Expected: No new errors related to knowledgeApi

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/index.ts
git commit -m "feat(api): add knowledgeApi for Phase 4 UI"
```

---

## Task 6: Router — /knowledge Route

**Files:**
- Modify: `src/Router.tsx`

- [ ] **Step 1: Add import**

After existing imports, add:
```typescript
import KnowledgePage from "@/pages/knowledge";
```

- [ ] **Step 2: Add route to children array**

Inside the `children: [...]` array (after `about` route), add:
```typescript
{ path: "knowledge", element: <KnowledgePage /> },
```

- [ ] **Step 3: Commit**

```bash
git add src/Router.tsx
git commit -m "feat(router): add /knowledge route for Phase 4 UI"
```

---

## Task 7: PanelList — Left Sidebar Component

**Files:**
- Create: `src/pages/knowledge/PanelList.tsx`

- [ ] **Step 1: Write PanelList component**

```tsx
import { useState, useEffect } from "react";
import { List, Button, Input, Popconfirm, message } from "antd";
import { Plus, Settings, Trash2 } from "lucide-react";
import { knowledgeApi } from "@/lib/api";
import type { KnowledgePanel } from "@/types";

interface Props {
  activePanelId: number | null;
  onSelectPanel: (panel: KnowledgePanel) => void;
  onRefresh: () => void;
}

export function PanelList({ activePanelId, onSelectPanel, onRefresh }: Props) {
  const [panels, setPanels] = useState<KnowledgePanel[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadPanels = async () => {
    try {
      const data = await knowledgeApi.listPanels();
      setPanels(data);
    } catch (e) {
      message.error("加载面板失败");
    }
  };

  useEffect(() => { loadPanels(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await knowledgeApi.createPanel(newName.trim());
      setNewName("");
      setCreating(false);
      await loadPanels();
      onRefresh();
    } catch (e) {
      message.error("创建面板失败");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await knowledgeApi.deletePanel(id);
      await loadPanels();
      onRefresh();
    } catch (e) {
      message.error("删除面板失败");
    }
  };

  return (
    <div style={{ width: 240, borderRight: "1px solid #f0f0f0", padding: 16, height: "100vh", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontWeight: 600 }}>知识面板</span>
        <Button type="text" icon={<Plus size={16} />} onClick={() => setCreating(true)} />
      </div>

      {creating && (
        <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
          <Input
            size="small"
            placeholder="面板名称"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onPressEnter={handleCreate}
            autoFocus
          />
          <Button size="small" type="primary" onClick={handleCreate}>确定</Button>
          <Button size="small" onClick={() => { setCreating(false); setNewName(""); }}>取消</Button>
        </div>
      )}

      <List
        size="small"
        dataSource={panels}
        renderItem={panel => (
          <List.Item
            key={panel.id}
            onClick={() => onSelectPanel(panel)}
            style={{
              cursor: "pointer",
              padding: "8px 4px",
              background: panel.id === activePanelId ? "#e6f7ff" : "transparent",
              borderRadius: 6,
            }}
            extra={
              <Popconfirm title="删除此面板？" onConfirm={() => handleDelete(panel.id)}>
                <Button type="text" size="small" icon={<Trash2 size={14} />} />
              </Popconfirm>
            }
          >
            <List.Item.Meta title={panel.name} />
          </List.Item>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/knowledge/PanelList.tsx
git commit -m "feat(ui): add PanelList sidebar component"
```

---

## Task 8: ChatMessage — Message Bubble

**Files:**
- Create: `src/pages/knowledge/ChatMessage.tsx`

- [ ] **Step 1: Write ChatMessage component**

```tsx
import Markdown from "react-markdown";
import type { KnowledgeMessage } from "@/types";

interface Props {
  message: KnowledgeMessage;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  return (
    <div style={{
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: "70%",
        padding: "8px 12px",
        borderRadius: 12,
        background: isUser ? "#1677ff" : isAssistant ? "#f5f5f5" : "#fff7e6",
        color: isUser ? "#fff" : "#000",
        whiteSpace: "pre-wrap",
      }}>
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/knowledge/ChatMessage.tsx
git commit -m "feat(ui): add ChatMessage bubble component"
```

---

## Task 9: ChatPanel — Main Right Area

**Files:**
- Create: `src/pages/knowledge/ChatPanel.tsx`

- [ ] **Step 1: Write ChatPanel component**

```tsx
import { useState, useEffect, useRef } from "react";
import { Input, Button, Tabs, message } from "antd";
import { Send, Square, Search, Settings } from "lucide-react";
import { knowledgeApi } from "@/lib/api";
import type {
  KnowledgePanel,
  KnowledgeSession,
  KnowledgeMessage,
  KnowledgeSimilarityHit,
} from "@/types";
import { ChatMessage as ChatMessageComp } from "./ChatMessage";

interface Props {
  panel: KnowledgePanel;
}

export function ChatPanel({ panel }: Props) {
  const [session, setSession] = useState<KnowledgeSession | null>(null);
  const [messages, setMessages] = useState<KnowledgeMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const [searchQuery, setSearchQuery] = useState("");
  const [ftsResults, setFtsResults] = useState<[number, string, string][]>([]);
  const [vectorResults, setVectorResults] = useState<KnowledgeSimilarityHit[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-create session when panel changes
  useEffect(() => {
    const init = async () => {
      try {
        const s = await knowledgeApi.createSession(panel.id);
        setSession(s);
        setMessages([]);
      } catch (e) {
        message.error("创建会话失败");
      }
    };
    init();
  }, [panel.id]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !session) return;
    const content = input.trim();
    setInput("");
    setLoading(true);
    try {
      const msg = await knowledgeApi.sendMessage(session.id, content);
      setMessages(prev => [...prev, msg]);
    } catch (e) {
      message.error("发送失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const handleEnd = async () => {
    if (!session) return;
    try {
      await knowledgeApi.endSession(session.id);
      message.success("会话已结束，摘要已生成");
      // Create new session
      const s = await knowledgeApi.createSession(panel.id);
      setSession(s);
      setMessages([]);
    } catch (e) {
      message.error("结束会话失败");
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const [fts, vec] = await Promise.all([
        knowledgeApi.searchFiles(searchQuery, panel.id),
        knowledgeApi.similarChunks(searchQuery, panel.id),
      ]);
      setFtsResults(fts);
      setVectorResults(vec);
    } catch (e) {
      message.error("搜索失败");
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100vh" }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        style={{ padding: "0 16px", borderBottom: "1px solid #f0f0f0" }}
        items={[
          { key: "chat", label: <span><Send size={14} style={{marginRight:4}}/>对话</span> },
          { key: "search", label: <span><Search size={14} style={{marginRight:4}}/>搜索</span> },
          { key: "settings", label: <span><Settings size={14} style={{marginRight:4}}/>设置</span> },
        ]}
      />

      {activeTab === "chat" && (
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {messages.map(msg => (
            <ChatMessageComp key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
          <div style={{
            display: "flex",
            gap: 8,
            padding: "12px 0",
            borderTop: "1px solid #f0f0f0",
          }}>
            <Input.TextArea
              value={input}
              onChange={e => setInput(e.target.value)}
              onPressEnter={e => { if (!e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="输入消息，Shift+Enter 换行"
              autoSize={{ maxRows: 6 }}
              style={{ flex: 1 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Button type="primary" icon={<Send size={14} />} onClick={handleSend} loading={loading} />
              <Button icon={<Square size={14} />} onClick={handleEnd} title="结束会话" />
            </div>
          </div>
        </div>
      )}

      {activeTab === "search" && (
        <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Input.Search
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onSearch={handleSearch}
              placeholder="搜索知识库..."
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <h4>FTS5 搜索结果</h4>
            {ftsResults.map(([id, title, snippet]) => (
              <div key={id} style={{ marginBottom: 8, padding: 8, border: "1px solid #f0f0f0", borderRadius: 6 }}>
                <div style={{ fontWeight: 600 }}>{title}</div>
                <div dangerouslySetInnerHTML={{ __html: snippet }} />
              </div>
            ))}
            {ftsResults.length === 0 && <span style={{ color: "#999" }}>无结果</span>}
          </div>
          <div>
            <h4>向量相似度结果</h4>
            {vectorResults.map((hit, i) => (
              <div key={i} style={{ marginBottom: 8, padding: 8, border: "1px solid #f0f0f0", borderRadius: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: "#1677ff" }}>
                  相似度: {(hit.score * 100).toFixed(1)}%
                </div>
                <div>{hit.content}</div>
              </div>
            ))}
            {vectorResults.length === 0 && <span style={{ color: "#999" }}>无结果</span>}
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <SettingsTab panel={panel} />
      )}
    </div>
  );
}

// Inner settings tab component
function SettingsTab({ panel }: { panel: KnowledgePanel }) {
  const [prompt, setPrompt] = useState(panel.system_prompt || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await knowledgeApi.updatePanel(panel.id, panel.name, prompt || undefined);
      message.success("已保存");
    } catch (e) {
      message.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <h3>面板设置: {panel.name}</h3>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>System Prompt</label>
        <Input.TextArea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="输入该面板的系统提示词，用于指导 AI 回复风格和上下文..."
          rows={6}
          style={{ width: "100%" }}
        />
      </div>
      <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/knowledge/ChatPanel.tsx
git commit -m "feat(ui): add ChatPanel with Chat/Search/Settings tabs"
```

---

## Task 10: KnowledgePage — Two-Column Container

**Files:**
- Create: `src/pages/knowledge/index.tsx`

- [ ] **Step 1: Write index.tsx**

```tsx
import { useState } from "react";
import { knowledgeApi } from "@/lib/api";
import type { KnowledgePanel } from "@/types";
import { PanelList } from "./PanelList";
import { ChatPanel } from "./ChatPanel";

export default function KnowledgePage() {
  const [activePanel, setActivePanel] = useState<KnowledgePanel | null>(null);
  const [, setRefreshKey] = useState(0);

  const handleSelectPanel = (panel: KnowledgePanel) => {
    setActivePanel(panel);
  };

  const handleRefresh = () => {
    setRefreshKey(k => k + 1);
  };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <PanelList
        activePanelId={activePanel?.id ?? null}
        onSelectPanel={handleSelectPanel}
        onRefresh={handleRefresh}
      />
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {activePanel ? (
          <ChatPanel key={activePanel.id} panel={activePanel} />
        ) : (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#999",
            fontSize: 16,
          }}>
            选择左侧面板开始对话
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/knowledge/index.tsx
git commit -m "feat(ui): add KnowledgePage two-column container"
```

---

## Task 11: MemoryManager — Global Memories Settings

**Files:**
- Create: `src/pages/knowledge/MemoryManager.tsx`

- [ ] **Step 1: Write MemoryManager component**

```tsx
import { useState, useEffect } from "react";
import { Table, Button, Popconfirm, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { knowledgeApi } from "@/lib/api";
import type { KnowledgeMemory } from "@/types";

export function MemoryManager() {
  const [memories, setMemories] = useState<KnowledgeMemory[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await knowledgeApi.listMemories(100);
      setMemories(data);
    } catch (e) {
      message.error("加载记忆失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleForget = async (id: number) => {
    try {
      await knowledgeApi.forgetMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
      message.success("已删除");
    } catch (e) {
      message.error("删除失败");
    }
  };

  const columns: ColumnsType<KnowledgeMemory> = [
    { title: "内容", dataIndex: "content", key: "content", ellipsis: true, width: 300 },
    { title: "质量", dataIndex: "quality_score", key: "quality_score", render: v => (v * 100).toFixed(0) + "%" },
    { title: "引用", dataIndex: "used_count", key: "used_count" },
    { title: "创建时间", dataIndex: "created_at", key: "created_at" },
    {
      title: "操作",
      key: "action",
      render: (_, record) => (
        <Popconfirm title="删除此记忆？" onConfirm={() => handleForget(record.id)}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h3>全局记忆库</h3>
        <Button onClick={load}>刷新</Button>
      </div>
      <Table
        dataSource={memories}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        size="small"
      />
    </div>
  );
}
```

- [ ] **Step 2: Integrate into ChatPanel Settings tab**

Read `src/pages/knowledge/ChatPanel.tsx`, find the `SettingsTab` component, and add a tab for memories:

```tsx
// Add to SettingsTab imports
import { MemoryManager } from "./MemoryManager";

// In SettingsTab return, after the prompt editor, add:
// (put MemoryManager in a collapsible section or second tab within Settings)
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/knowledge/MemoryManager.tsx src/pages/knowledge/ChatPanel.tsx
git commit -m "feat(ui): add MemoryManager for global memories management"
```

---

## Task 12: End-to-End Verification

- [ ] **Step 1: Run all tests**

Run: `cargo test --lib`
Expected: All pass

- [ ] **Step 2: Start Tauri dev**

Run: `cd src-tauri && cargo tauri dev`
Verify: App launches, navigate to /knowledge, panel list shows, clicking panel creates session, sending message returns llama response

- [ ] **Step 3: Verify summary flow**

1. Send a few messages
2. Click end session button
3. Verify summaries table has entry
4. Verify global_memories has high-quality entry if score > 0.7

- [ ] **Step 4: Verify search**

1. Switch to Search tab
2. Type query, verify FTS5 and vector results return

- [ ] **Step 5: Final test run**

Run: `cargo test --lib`
Expected: All pass

---

## Spec Coverage Check

| Spec Section | Covered By Task |
|--------------|-----------------|
| Two-column layout | Task 7, 10 |
| Panel CRUD | Task 1, 2, 4, 7 |
| Session auto-create | Task 9 (ChatPanel useEffect) |
| Messages + llama call | Task 4 (knowledge_send_message), Task 9 |
| Auto silent summary (N=20) | Not yet implemented — add to knowledge_send_message counter |
| Manual end session + summary | Task 4 (knowledge_end_session) |
| Context injection (summaries + memories) | Task 4 (knowledge_send_message) |
| global_memories table + CRUD | Task 1, 2 |
| Quality score > 0.7 → memory | Task 4 (knowledge_end_session) |
| Manual refresh button | Settings tab (placeholder for future) |
| Settings: system prompt editor | Task 9 (SettingsTab) |
| MemoryManager UI | Task 11 |
| Search tab (FTS5 + vector) | Task 9 (ChatPanel search tab) |

**Gap found:** Auto silent summary trigger (N=20 messages) not yet in `knowledge_send_message`. This can be added as a follow-up task or included in Task 4 implementation.
