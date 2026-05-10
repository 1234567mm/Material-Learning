# kb-mcp · 把知识库接到 Claude Desktop / Cursor

`kb-mcp` 是一个独立的 MCP（Model Context Protocol）Server sidecar。它把本地知识库以 stdio MCP 协议暴露出来，让 Claude Desktop / Cursor / Cherry Studio 等任何兼容 MCP 的 LLM 客户端都能直接搜索、读取你的笔记。

## 它是什么

- **完全独立的 binary** —— 不是 Tauri 主应用的一部分；编译后是单文件 `kb-mcp.exe`（Windows）/ `kb-mcp`（macOS/Linux）
- **只读 SQLite** —— 直接打开主应用的 `app.db`，不写入，不抢锁；与主应用同时运行无冲突（依赖 WAL 模式）
- **隐私默认安全** —— 自动过滤回收站 / 隐藏 / 加密笔记，不会把这些内容暴露给 LLM

## 当前已暴露的工具（v0.2）

### 读工具（默认可用）

| 工具 | 说明 |
|---|---|
| `ping` | 健康检查，返回 sidecar 版本 |
| `search_notes(query, limit?)` | 全文搜索（FTS5 + LIKE 兜底） |
| `get_note(id)` | 按 id 读全文。加密笔记返回占位符 |
| `list_tags` | 所有标签 + 笔记数（按数降序） |
| `search_by_tag(tag, limit?)` | 按标签名筛选笔记 |
| `get_backlinks(id)` | 反向链接：哪些笔记 [[...]] 到了它 |
| `list_daily_notes(days?, limit?)` | 最近 N 天日记（默认 7 天） |
| `list_tasks(status?, keyword?, limit?)` | 主任务列表（按 priority/due_date 排序） |
| `get_prompt(id?, builtin_code?)` | 取一条 Prompt 模板 |

### 写工具（需 `--writable` 启动开关，默认禁用）

| 工具 | 说明 |
|---|---|
| `create_note(title, content, folder_id?)` | 创建新笔记。自动维护 title_normalized + content_hash + FTS5 索引 |
| `update_note(id, title?, content?, folder_id?)` | 改字段。拒绝改加密笔记。三个字段都是可选，只更新传入的 |
| `add_tag_to_note(note_id, tag)` | 给笔记加标签。tag 不存在自动创建 |

> ⚠️ 写工具默认不会被启用。在客户端配置的 `args` 里加 `"--writable"` 才能让 LLM 修改你的知识库。
> 不加这个开关时，sidecar 用 SQLITE_OPEN_READ_ONLY 打开 db，从内核层面禁止任何写入。

## 编译

```bash
# 项目根目录运行（一键完成 cargo build + 复制到 binaries/）
pnpm build:mcp           # release 模式（推荐）
pnpm build:mcp:debug     # debug 模式（编译快）
```

产物路径：`src-tauri/binaries/kb-mcp-<host-triple>.exe`

例如 Windows x64 上是 `src-tauri/binaries/kb-mcp-x86_64-pc-windows-msvc.exe`。

> ⚠️ 直接 `cargo build -p kb-mcp` 也行，但产物在 `target/release/kb-mcp.exe`，
> Tauri 打包不会自动带上。`pnpm build:mcp` 会同时复制到 `binaries/` 让 Tauri externalBin
> 在下次 `pnpm tauri build` 时把它带进安装包。

## 找到知识库 db 路径

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\com.agilefr.kb\app.db` |
| macOS | `~/Library/Application Support/com.agilefr.kb/app.db` |
| Linux | `~/.local/share/com.agilefr.kb/app.db` |

> 多开实例：默认实例在 `app.db`；第 N 个实例在 `instance-N/app.db`。

## 接入 Claude Desktop

打开 `%APPDATA%\Claude\claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`），加入：

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "C:\\full\\path\\to\\kb-mcp.exe",
      "args": [
        "--db-path",
        "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\com.agilefr.kb\\app.db"
      ]
    }
  }
}
```

> 🔓 **想让 LLM 真能写笔记**：在 `args` 里追加 `"--writable"`：
> ```json
> "args": ["--db-path", "...", "--writable"]
> ```

重启 Claude Desktop。在对话框里看到「🔌 knowledge-base」图标即接入成功，可直接说「帮我搜知识库里关于 XXX 的笔记」。开了 `--writable` 还能说「帮我把这段总结成笔记保存到知识库，加上 ai 标签」。

## 接入 Cursor

`~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "C:/full/path/to/kb-mcp.exe",
      "args": ["--db-path", "C:/Users/YOUR_NAME/AppData/Roaming/com.agilefr.kb/app.db"]
    }
  }
}
```

## 接入 Cherry Studio

设置 → MCP 服务器 → 添加 → 选 stdio → 命令填 `kb-mcp.exe` 全路径，参数填 `--db-path <db 全路径>`。

## 自检 / 调试

仓库自带一个握手脚本：

```bash
bash src-tauri/mcp/test-handshake.sh
```

它会喂入 `initialize` + `tools/list` + `ping` + `search_notes` 四个 JSON-RPC 帧，把 stdout 打到终端。看到每条都有 `result` 字段即正常。

## 常见问题

### Claude Desktop 一加 server 就闪断

历史上 Claude Desktop on Windows 对 Rust MCP server 有 init 后立即 disconnect 的兼容问题。本项目用的 `rmcp 1.5` 已修复。如果仍有问题：

1. 看 Claude Desktop 的 MCP 日志：`%APPDATA%\Claude\logs\mcp-server-knowledge-base.log`
2. 检查 db 路径是否包含中文或空格（建议先用纯英文路径排除）
3. 手动用 `test-handshake.sh` 验证 binary 本身没问题
4. 兜底方案：在中间套一层 Node.js wrapper（待补 npm 包）

### sidecar 会写数据吗

不会。`kb-mcp` 用 `SQLITE_OPEN_READ_ONLY` 打开数据库，从代码层面禁止任何 INSERT/UPDATE/DELETE。

### 加密笔记的内容会被泄露吗

不会。`get_note` 检测到 `is_encrypted=1` 时直接返回占位符，密文从不出库。同时 `search_notes` 在 SQL 层就过滤了加密笔记。

### 性能怎么样

stdio + 直连 SQLite，单次 search_notes 在 1 万条笔记规模下 < 50ms。FTS5 索引由主应用维护，sidecar 直接复用。

---

## macOS 平台注意事项

代码本身跨平台，但有几个 macOS 特有的配置坑要知道：

### 1. GUI App spawn `npx` 找不到（已自动修复）

**历史症状**：在设置页加 GitHub MCP server，配 `command: "npx"`，点「列出工具」报 `spawn npx 失败: No such file or directory`。

**根因**：macOS / Linux GUI app 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，**不读 `~/.zshrc` 里 nvm/brew 的 PATH**。

**自动修复**：`McpClientManager` 在第一次 spawn 子进程前会自动 fork 一次用户登录 shell（`$SHELL -l -i -c`），拿到真实 PATH 注入子进程 env。结果进程级缓存。日志里会看到 `[mcp-external] enriched PATH from login shell (N entries)`。

**仍找不到？** 可能是：
- shell 本身有问题（`$SHELL` 环境变量为空或指向无效 shell）
- 你装 npm 的方式比较特别（如 asdf 等多版本管理器，PATH 在 .zshrc 中通过 `eval` 动态注入）
- 兜底：仍可手动填绝对路径（终端 `which npx` 拿到的全路径），优先级最高

### 2. .app Bundle 里 sidecar 的位置

打包后 `kb-mcp` binary 自动放进 `知识库.app/Contents/MacOS/` 与主可执行文件同目录。设置页「Sidecar binary」字段会显示这个路径。

### 3. Code Signing & Gatekeeper

`pnpm tauri build` 默认会用 ad-hoc 签名签 sidecar。第一次跑时如果触发 Gatekeeper：
- 系统设置 → 隐私与安全性 → 「仍要打开」
- 或终端 `xattr -dr com.apple.quarantine /Applications/知识库.app` 一次性移除隔离属性

需要 Apple Developer ID 签名的话，配 `signingIdentity` 到 `tauri.conf.json` macOS bundle。

### 4. 路径含空格无须转义

macOS db 路径形如 `/Users/you/Library/Application Support/com.agilefr.kb/app.db`（含空格）。MCP client 配置 JSON 的 `args: ["--db-path", "<上面的路径>"]` 是数组，每个元素一个 arg，不会按空格切分。不用 quote、不用转义。

### 5. Sidecar binary 可执行权限

`pnpm build:mcp` 用 Node `copyFileSync` 复制，**保留 +x 位**（POSIX 系统）。`cargo build` 出来的产物本身就是 +x。如果手动 mv/cp 后丢了权限，`chmod +x kb-mcp` 修复。

---

## Linux 平台

行为基本同 macOS：
- 安装包 `.deb` / `.AppImage` 都会带上 sidecar
- spawn `npx` 同样有 GUI 启动 PATH 问题（systemd / 桌面环境的 PATH 配置不同），同样建议用绝对路径
- 不需要 code signing

---

## 调试：用 MCP Inspector 测 sidecar

官方 Inspector 是个 web GUI，能可视化看到所有 tools/prompts/resources：

```bash
npx @modelcontextprotocol/inspector \
  /path/to/kb-mcp \
  --db-path /path/to/app.db
```

浏览器里能直接调用工具看返回，比手动构造 JSON-RPC 方便很多。
