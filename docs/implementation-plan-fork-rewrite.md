# 实施计划：基于 knowledge-base fork 的知识库系统实现

**分支**: master → feature/knowledge-base-mvp
**状态**: 待实施
**基于设计文档**: `docs/design-knowledge-base-20260509.md`（APPROVED）

---

## 架构决策记录（已确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| llama-server 集成方式 | HTTP API Client | 简单直接，类似调用云端 API |
| meilisearch | MVP 同时集成 | Rust 单二进制，可选增强层 |
| 数据库 | 独立 `knowledge.db` | 与 knowledge-base 原生数据隔离 |
| 摘要触发 | 手动结束 + 数据溢出强制触发 | 用户控制权 + 防溢出 |
| 向量存储 | SQLite blob/JSON | embedding 自管理，不依赖 meilisearch |

---

## Fork 策略

### 1.1 Fork knowledge-base

```bash
# 克隆 knowledge-base 作为起点
cd ~/workspace
cp -r knowledge-base/knowledge-base ~/workspace/material-learning-src
cd ~/workspace/material-learning-src

# 清理 knowledge-base 特定文件
rm -rf .git
rm -rf kb_assets/ pdfs/ sources/ # 外部数据目录重置

# 保留的核心资产
# - 完整 Tauri 2.x + React 脚手架
# - AppState + 插件生态
# - SQLite WAL 模式
# - kb-core（迁移到 material-learning）
```

### 1.2 重命名

| 原名 | 新名 |
|------|------|
| `knowledge_base` | `material_learning` |
| `app.db` (knowledge-base) | 保留（原生笔记系统） |
| 新建 `knowledge.db` | 知识库主数据库 |
| `com.agilefr.kb` | `com.material-learning.kb` |

---

## 项目结构

```
material-learning-src/
├── Cargo.toml              # workspace root: kb-core + mcp
├── knowledge-db/           # 新增：knowledge.db 相关
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # 模块入口
│       ├── schema.rs       # knowledge.db 表定义
│       ├── panels.rs      # 面板 CRUD
│       ├── chat.rs        # Chat 会话 CRUD
│       ├── summary.rs     # 摘要生成
│       └── search.rs      # FTS5 + 向量搜索
├── kb-core/               # 来自 knowledge-base
├── mcp/                   # 来自 knowledge-base
└── src/                   # 主应用
    ├── lib.rs
    ├── main.rs
    ├── state.rs           # 扩展：添加 LlamaClient, MeilisearchClient
    └── services/
        ├── llama.rs       # 新增：llama-server HTTP client
        └── meilisearch.rs # 新增：meilisearch sidecar 管理
```

---

## 数据库 Schema（knowledge.db）

```sql
-- panels: 知识板块
CREATE TABLE panels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    system_prompt TEXT,
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- chat_sessions: 对话会话
CREATE TABLE chat_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id    INTEGER NOT NULL REFERENCES panels(id),
    title       TEXT,
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT DEFAULT (datetime('now', 'localtime')),
    ended_at    TEXT,
    is_active   INTEGER DEFAULT 1
);

-- chat_messages: 消息历史
CREATE TABLE chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES chat_sessions(id),
    role        TEXT NOT NULL,  -- 'user' | 'assistant' | 'system'
    content     TEXT NOT NULL,
    token_count INTEGER,
    created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- summaries: 自动摘要
CREATE TABLE summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id        INTEGER NOT NULL REFERENCES panels(id),
    session_id      INTEGER REFERENCES chat_sessions(id),
    content         TEXT NOT NULL,
    char_count      INTEGER NOT NULL,
    trigger_type    TEXT NOT NULL,  -- 'manual' | 'overflow'
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

-- file_chunks: 文件分块
CREATE TABLE file_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id     INTEGER NOT NULL REFERENCES files(id),
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    embedding_ref BLOB,  -- 向量 blob
    created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- files: 文件索引
CREATE TABLE files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id    INTEGER NOT NULL REFERENCES panels(id),
    path        TEXT NOT NULL,
    title       TEXT,
    hash        TEXT,
    created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- FTS5 搜索表
CREATE VIRTUAL TABLE files_fts USING fts5(
    title, content, content=files, content_rowid=id
);
```

---

## 实施步骤

### Phase 1: Fork + 基础搭建（Day 1-2）

**Step 1.1**: Fork knowledge-base 项目
```
- 复制项目到 material-learning-src
- 更新 Cargo.toml、tauri.conf.json 重命名
- 更新 identifier、productName
```

**Step 1.2**: 创建 knowledge-db workspace member
```
- 新建 knowledge-db/Cargo.toml
- 添加到 workspace members
- 实现 schema.rs（上述 SQL）
- 实现基础 panels CRUD
```

**Step 1.3**: 扩展 AppState
```rust
// src/state.rs 新增
pub struct LlamaClient {
    pub http_client: reqwest::Client,
    pub base_url: String,
}

pub struct MeilisearchClient {
    pub http_client: reqwest::Client,
    pub base_url: String,
    pub index_name: String,
}

pub struct AppState {
    // ... knowledge-base 原有字段
    pub knowledge_db: knowledge_db::Database,
    pub llama: Option<LlamaClient>,
    pub meilisearch: Option<MeilisearchClient>,
}
```

### Phase 2: llama-server 集成（Day 3-4）

**Step 2.1**: 实现 LlamaClient service
```rust
// src/services/llama.rs
pub struct LlamaClient {
    pub http_client: reqwest::Client,
    pub base_url: String,
}

impl LlamaClient {
    // /chat/completions API
    pub async fn chat(&self, model: &str, messages: &[ChatMessage]) -> Result<String>;

    // /completion API (非流式)
    pub async fn complete(&self, prompt: &str) -> Result<String>;

    // /embedding API
    pub async fn embed(&self, text: &str) -> Result<Vec<f32>>;
}
```

**Step 2.2**: llama-server 进程管理
```rust
// 在 lib.rs setup 中
pub fn spawn_llama_server(model_path: &Path) -> Result<LlamaClient> {
    // 启动 llama-server 作为子进程
    // 等待 /health 返回后再返回 client
    // 失败不阻断启动（Option 包装）
}
```

**Step 2.3**: Chat 命令
```rust
// Tauri commands
#[tauri::command]
async fn create_chat_session(panel_id: i64) -> Result<ChatSession>;

#[tauri::command]
async fn send_message(session_id: i64, content: String) -> Result<ChatMessage>;

#[tauri::command]
async fn end_chat_session(session_id: i64) -> Result<Summary>;
```

### Phase 3: meilisearch 集成（Day 4-5）

**Step 3.1**: meilisearch 进程管理
```rust
pub fn spawn_meilisearch(data_dir: &Path) -> Result<MeilisearchClient> {
    // 下载/检查 meilisearch 二进制
    // 启动子进程，监听 localhost:7700
    // 等待 health check 通过
}
```

**Step 3.2**: 向量存储和检索
```rust
// knowledge-db/src/search.rs
pub async fn search_similar(&self, query: &str, panel_id: i64, limit: usize) -> Result<Vec<SearchHit>> {
    // 1. 用 llama-server 生成 query embedding
    // 2. 从 file_chunks 取向量，计算余弦相似度
    // 3. 返回 top-k 结果
}
```

### Phase 4: Chat UI + 摘要（Day 6-8）

**Step 4.1**: Chat 前端组件
```
frontend/src/pages/
├── PanelList.tsx       # 面板列表
├── ChatPanel.tsx       # 聊天界面
├── ChatMessage.tsx     # 消息气泡
└── SessionHistory.tsx  # 历史会话
```

**Step 4.2**: 摘要生成逻辑
```rust
pub async fn generate_summary(session_id: i64, trigger: SummaryTrigger) -> Result<Summary> {
    // 1. 收集 chat_messages
    // 2. 判断触发类型
    // 3. 构建摘要 prompt（注入 panel system_prompt）
    // 4. 调用 llama-server
    // 5. 存入 summaries 表
}
```

**Step 4.3**: 上下文注入
```rust
pub fn build_context(panel_id: i64, current_session_id: i64) -> Result<String> {
    // 1. 查 panels.system_prompt
    // 2. 查 summaries（最近 3 条）
    // 3. 查 file_chunks（相关文件摘要）
    // 4. 组装为 prompt
}
```

### Phase 5: MVP 验证（Day 9-10）

**Step 5.1**: 核心链路验证
```
✅ 导入 Markdown 文件 → 存入 knowledge.db + 文件系统
✅ Chat 对话 → 注入相关文件摘要
✅ 结束会话 → 生成摘要存入 summaries
✅ 再次对话 → 自动引用板块历史摘要
```

**Step 5.2**: 性能验证
```
- llama-server 3B Q4_K 响应时间 < 5s（warm query）
- meilisearch 搜索延迟 < 100ms
- 16GB RAM 内存占用监控
```

---

## 依赖项

| 依赖 | 用途 | 来源 |
|------|------|------|
| `reqwest` | HTTP client for llama-server/meilisearch | 已有 |
| `rusqlite` | SQLite 操作 | 已有 |
| `tokio` | 异步 runtime | 已有 |
| `serde` | 序列化 | 已有 |
| `llama-server` | 本地 LLM 推理 | 用户下载 |
| `meilisearch` | 向量搜索 | Rust 二进制 |

---

## 关键风险和缓解

| 风险 | 缓解 |
|------|------|
| llama-server 启动失败 | Option 包装，优雅降级到云端 API |
| 16GB RAM 内存压力 | 监控内存，llama-server 上下文窗口动态调整 |
| meilisearch 启动失败 | FTS5 兜底，不阻断主流程 |
| 向量计算慢 | 限制 chunk 数量，预计算 embedding |

---

## 验收标准

1. **核心链路跑通**: 导入 → Chat → 摘要 → 再次对话引用摘要
2. **本地模型可用**: llama-server 3B Q4_K 响应 < 5s
3. **板块隔离有效**: 不同面板 chat 上下文独立
4. **导出/导入**: ZIP 包可完整恢复
5. **面板 prompt 有效**: 同模型不同面板输出格式不同
