# Knowledge Base

本地知识库桌面应用。基于 Tauri 2.x + React 19 + SQLite 构建，支持 Markdown 编辑、全文搜索、双向链接、知识图谱、AI 问答、间隔重复记忆卡等功能。

## 功能特性

### 笔记与写作
- **Markdown 编辑器**：基于 TipTap，支持代码高亮、数学公式、表格、任务列表
- **双向链接**：`[[笔记名称]]` 语法，自动生成 backlinks
- **知识图谱**：AntV G6 可视化笔记关系网络
- **全局搜索**：FTS5 全文搜索，支持标题、内容、标签筛选
- **PDF 标注**：内置 PDF 阅读器，支持边读边做笔记
- **双链笔记**与**隔空投递**：通过命令行 `.md` 文件投递自动入库

### AI 能力
- **本地向量搜索**：Meilisearch 驱动，理解语义检索
- **知识库问答**：基于知识库内容的 AI 对话
- **LLM 集成**：支持接入私有部署的 LLM（llama-server）实现完全本地化的 AI 对话

### 知识卡与间隔重复
- **FSRS 算法**：基于遗忘曲线的间隔重复算法，科学的记忆规划
- **知识卡管理**：支持创建、编辑、复习知识卡
- **每日复习**：基于知识卡到期时间智能安排每日复习量

### 文件与附件
- **附件管理**：图片、文件统一存储，支持拖放上传
- **源文件管理**：PDF、Word 等源文件关联笔记
- **导入导出**：支持从 Markdown 文件批量导入，支持导出为 Word 文档

### 同步与备份
- **WebDAV 同步**：支持自建 WebDAV 服务器，跨设备同步数据
- **版本历史**：支持笔记历史版本回溯
- **数据迁移**：支持修改数据存储路径

### 开发者支持
- **MCP Server**：内置 in-memory MCP Server，暴露 12 个工具供 AI 调用
- **Tauri 插件生态**：支持自动启动、全局快捷键、系统通知、剪贴板等原生能力

## 技术架构

```
┌──────────────────────────────────────────────┐
│                  React 19 UI                 │
│   TipTap / AntV G6 / Ant Design / Zustand     │
├──────────────────────────────────────────────┤
│              Tauri 2.x (Rust)                │
│  Commands / Plugin System / State Management  │
├──────────────────────────────────────────────┤
│              SQLite (WAL Mode)               │
│     Notes / Tags / Cards / Links / Tasks     │
├────────────┬──────────────┬─────────────────┤
│ Meilisearch │  llama-server │  kb-core MCP   │
│  (搜索)     │   (本地 LLM)  │ (知识库工具)    │
└────────────┴──────────────┴─────────────────┘
```

### 技术栈
- **框架**：Tauri 2.x（Rust 后端 + WebView 前端）
- **前端**：React 19, TypeScript, Vite 7, Zustand, React Router 7
- **编辑器**：TipTap 3.x（ProseMirror）
- **数据库**：SQLite（rusqlite + FTS5 全文搜索）
- **搜索**：Meilisearch（本地部署）
- **AI**：支持 llama.cpp 兼容的 llama-server
- **知识卡**：ts-fsrs（间隔重复算法）
- **图表**：AntV G6（知识图谱）
- **样式**：Tailwind CSS 4

## 下载安装

> 查看所有平台的安装包和校验信息：[releases/](releases/)

| 平台 | 架构 | 安装格式 | 推荐场景 |
|------|------|---------|---------|
| Windows | x64 | NSIS (.exe) | 普通用户安装 |
| Windows | x64 | MSI (.msi) | 企业分发 / 组策略部署 |
| Ubuntu | amd64 | deb (.deb) | Debian/Ubuntu 系统 |
| Ubuntu | amd64 | AppImage (.AppImage) | 免安装，跨发行版通用 |
| macOS | aarch64 (universal) | dmg (.dmg) | Apple Silicon / Intel Mac |

**注意**：macOS 为 universal binary，同时支持 Apple Silicon 和 Intel 芯片。

## 开发

### 环境要求
- Node.js 20+
- pnpm 9+
- Rust 1.95+（通过 `rustup` 安装）
- Linux 额外依赖：`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`

### 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发服务器（热重载）
pnpm dev

# 类型检查
pnpm typecheck

# 生产构建
pnpm tauri build
```

### 常用命令

```bash
pnpm dev          # 启动开发模式
pnpm build        # 构建前端（TypeScript 编译 + Vite build）
pnpm tauri build  # 构建 Tauri 应用（含前端）
pnpm tauri dev    # 仅启动 Tauri 后端开发模式
pnpm bump-tauri-version  # 同步 package.json 版本到 tauri.conf.json
```

### 项目结构

```
src/                      # React 前端源码
  commands/               # Tauri 命令（Rust）
  database/              # SQLite 操作层
  services/              # 核心服务（搜索、LLM、MCP、导入导出）
  state.rs               # 应用状态定义
src-tauri/
  src/                   # Rust 后端源码
  tauri.conf.json        # Tauri 配置
scripts/
  bump-tauri-version.js  # 版本号同步脚本
  generate-release-doc.js # Release 文档生成脚本
releases/                # 版本发布文档（v{x.y.z}.md）
docs/                   # 设计文档和实施计划
```

## 版本管理

版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。`package.json` 是版本号的唯一真值，构建时自动同步到 Tauri 配置。

```bash
# 发布新版本
# 1. 更新 package.json 中的 version
# 2. 创建 git tag
git tag v1.9.0
git push origin v1.9.0

# CI 自动完成：
# - 版本同步到 tauri.conf.json
# - 构建所有平台安装包
# - 生成 SHA-256 校验和
# - 生成 releases/v1.9.0.md 发布文档
# - 上传到 GitHub Release
```

## License

AGPL-3.0-or-later