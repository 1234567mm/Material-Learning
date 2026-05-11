# Phase 4: Knowledge Base Chat UI + Learn — 设计规格

**日期:** 2026-05-11
**状态:** Approved
**分支:** master

---

## 1. 架构概览

```
/knowledge 页面（两栏布局）
├── 左侧栏（240px）：面板列表 + 新建/设置按钮
│   └── 面板切换 → 重置右侧为该面板新会话
└── 右侧主区域（flex）：
    ├── 顶栏 tab：Chat | 搜索 | 设置
    ├── Chat 模式：消息流 + 输入框 + 摘要注入状态
    ├── 搜索模式：FTS5 搜索框 + 向量相似度 tab
    └── 设置模式：panel system prompt 编辑 + 刷新按钮
```

---

## 2. 会话流程

### 2.1 进入面板 → 新会话

- 用户选择面板 → 自动创建新 ChatSession（is_active=1）
- 空消息流显示，输入框可用

### 2.2 对话中

- 每条消息存入 `chat_messages`（role/content/token_count/created_at）
- **静默摘要触发**：消息数达到阈值（N=20）时，后台调用 llama 生成摘要存入 `summaries`，不打断输入，UI 显示「已自动摘要」提示

### 2.3 结束会话

- 用户主动点「结束」→ 调用 `end_chat_session`
- 生成正式摘要，标记 `session.ended_at = now`
- 摘要存入 `summaries` 表

### 2.4 新会话上下文注入

新会话创建时，自动拼接以下内容作为 system message（控制总量 ≤ 模型 context window 50%）：

```
[panel.system_prompt]

=== 历史学习 ===
[summaries 表中该 panel 最近 1-3 条摘要，按 created_at DESC]

=== 相关知识（向量搜索召回）===
[global_memories 中 used_count 高且 quality_score 高的 top-K 条]
```

超出量截断最旧的摘要，不超过 3 条摘要。

---

## 3. 全局记忆库（Learn 机制）

### 3.1 表结构

```sql
CREATE TABLE global_memories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL,
    source_panel_id INTEGER REFERENCES panels(id),
    source_session_id INTEGER REFERENCES chat_sessions(id),
    quality_score   REAL DEFAULT 0.5,   -- 0.0 ~ 1.0
    used_count      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
```

### 3.2 摘要评估流程

`end_chat_session` 时：
1. llama 生成摘要 content
2. llama 额外生成 quality_score（0-1 浮点），通过 prompt 要求模型输出 `Score: 0.XX`
3. 若 score > 0.7，存入 `global_memories`

### 3.3 记忆召回

新会话上下文注入时，从 `global_memories` 按 `quality_score DESC, used_count DESC` 取 top-K（K=5）。

### 3.4 记忆降权

- 每次被引用：`used_count += 1`
- 定期后台任务（如每天）：`used_count < 3` 且 `created_at > 30天前` 的记忆软删除

### 3.5 手动管理

- Settings tab 提供「查看/删除记忆」列表
- 用户可手动删除特定记忆条目

---

## 4. 向量搜索集成

### 4.1 搜索模式 UI

- FTS5 搜索：关键词输入 → 返回 title + snippet
- 向量搜索：输入查询 → 调用 `similar_chunks` → 返回 content + score

### 4.2 手动刷新按钮

Settings tab 中「刷新知识库索引」按钮：
- 遍历 `files` 表，按 mtime 变化检测文件更新
- 增量更新 `file_chunks` + 重新生成 embedding blob
- 完成后 Toast 通知

### 4.3 边界一致性

- `file_chunks.embedding_ref` 为 NULL 时跳过向量计算
- 文件删除时级联删除对应 chunks
- 向量搜索时除以零保护（q_len == 0 或 e_len == 0 返回 score=0）

---

## 5. 后端 Commands（新增）

| Command | 签名 | 返回 |
|---------|------|------|
| `knowledge_list_panels` | `() → Vec<Panel>` | 所有面板 |
| `knowledge_create_panel` | `(name: String, system_prompt: Option<String>) → i64` | 新 panel_id |
| `knowledge_update_panel` | `(id: i64, name: String, system_prompt: Option<String>) → ()` | — |
| `knowledge_delete_panel` | `(id: i64) → ()` | — |
| `knowledge_list_sessions` | `(panel_id: i64) → Vec<ChatSession>` | 面板下所有会话 |
| `knowledge_send_message` | `(session_id: i64, content: String) → ChatMessage` | 助手回复 |
| `knowledge_end_session` | `(session_id: i64) → Summary` | 生成的摘要 |
| `knowledge_get_messages` | `(session_id: i64) → Vec<ChatMessage>` | 会话消息 |
| `knowledge_search_files` | `(query: String, panel_id: Option<i64>, limit: Option<usize>) → Vec<(i64, String, String)>` | FTS5 结果 |
| `knowledge_similar_chunks` | `(query: String, panel_id: i64, limit: Option<usize>) → Vec<SimilarityHit>` | 向量结果 |
| `knowledge_refresh_index` | `() → i64` | 刷新涉及的文件数 |
| `knowledge_list_memories` | `() → Vec<GlobalMemory>` | 全局记忆列表 |
| `knowledge_forget_memory` | `(id: i64) → ()` | 删除记忆 |

---

## 6. 前端 API（新增）

```typescript
export const knowledgeApi = {
  listPanels: () => invoke<KnowledgePanel[]>("knowledge_list_panels"),
  createPanel: (name: string, systemPrompt?: string) =>
    invoke<number>("knowledge_create_panel", { name, systemPrompt }),
  updatePanel: (id: number, name: string, systemPrompt?: string) =>
    invoke<void>("knowledge_update_panel", { id, name, systemPrompt }),
  deletePanel: (id: number) => invoke<void>("knowledge_delete_panel", { id }),
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
  refreshIndex: () => invoke<number>("knowledge_refresh_index"),
  listMemories: () => invoke<KnowledgeMemory[]>("knowledge_list_memories"),
  forgetMemory: (id: number) => invoke<void>("knowledge_forget_memory", { id }),
};
```

---

## 7. 新增 TypeScript 类型

```typescript
interface KnowledgePanel {
  id: number; name: string; system_prompt: string | null;
  created_at: string; updated_at: string;
}
interface KnowledgeSession {
  id: number; panel_id: number; title: string | null;
  created_at: string; updated_at: string; ended_at: string | null; is_active: boolean;
}
interface KnowledgeMessage {
  id: number; session_id: number; role: "user" | "assistant" | "system";
  content: string; token_count: number | null; created_at: string;
}
interface KnowledgeSummary {
  id: number; panel_id: number; session_id: number | null;
  content: string; char_count: number; trigger_type: "manual" | "overflow";
  created_at: string;
}
interface KnowledgeSimilarityHit {
  chunk_id: number; file_id: number; content: string; score: number;
}
interface KnowledgeMemory {
  id: number; content: string; source_panel_id: number;
  source_session_id: number | null; quality_score: number;
  used_count: number; created_at: string;
}
```

---

## 8. 路由

`src/Router.tsx` 新增：

```typescript
{ path: "knowledge", element: <KnowledgePage /> }
```

---

## 9. 新建组件

```
src/pages/knowledge/
├── index.tsx          # 页面容器（两栏布局）
├── PanelList.tsx       # 左侧面板列表
├── ChatPanel.tsx      # 右侧主区域（tab: Chat | 搜索 | 设置）
├── ChatMessage.tsx    # 消息气泡
└── MemoryManager.tsx   # 设置 tab 中的记忆管理
```

---

## 10. 验证方式

1. `cargo test --lib` — 全部通过
2. 启动 Tauri，进入 /knowledge
3. 创建面板 → 发送消息 → 验证 llama-server 回复
4. 结束会话 → 验证 summaries 表有记录 → 验证 global_memories 有高质量摘要
5. 新建会话 → 验证上下文注入（system_prompt + 摘要）
6. 搜索 tab → 验证 FTS5 和向量搜索返回结果
7. 刷新按钮 → 验证触发后台索引重建

---

## 11. 依赖项

| 依赖 | 用途 |
|------|------|
| `knowledge-db` (existing) | 数据库 CRUD |
| `llama.rs` (existing) | chat/complete/embed |
| `meilisearch.rs` (existing) | 向量搜索 |
| 新增 `global_memories` 表 | 跨面板记忆 |
