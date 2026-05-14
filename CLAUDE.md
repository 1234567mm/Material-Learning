# Material-Learning 项目概览

## 基本信息

| 项目 | 值 |
|------|-----|
| 项目名 | knowledge_base |
| 当前版本 | 1.8.5 (package.json) |
| 最新 tag | v1.8.5 (已推送，CI 运行中) |
| 主分支 | main |
| 技术栈 | Tauri 2.x + React + TypeScript + SQLite |
| 包管理器 | pnpm v9 |

## CI/CD 状态

### GitHub Actions

- **触发条件**: push tags `v*` 或 push 到 main
- **Jobs**: lint (30s) + 3 platform builds (~15-18min/平台，优化后预期更短)
- **矩阵平台**: ubuntu-latest, windows-latest, macos-latest

### 最近 CI 运行

| Tag/Branch | 状态 | 时长 | 问题 |
|------------|------|------|------|
| v1.8.5 | 运行中 | - | lint + build |
| main (076b3da) | 运行中 | - | bump version + fix CI path |
| v1.8.4 | 失败 | - | MODULE_NOT_FOUND (CI 路径错误) |
| v1.8.3 | 失败 | 18m55s | MODULE_NOT_FOUND + MSI WiX |
| v1.8.2 | 失败 | 19m1s | YAML multi-line string |

### Bundle targets (优化后)

| 平台 | 构建目标 | 跳过 |
|------|---------|------|
| Ubuntu | deb, appimage | nsis, msi, app, dmg |
| Windows | nsis | msi (WiX signing 缺失) |
| macOS | app, dmg | nsis, msi, deb, appimage |

## 项目结构

```
Material-Learning/
├── src/                    # React 前端
├── src-tauri/              # Rust 后端 (Tauri 2.x)
│   ├── src/               # Rust 源码
│   ├── tauri.conf.json    # Tauri 配置 (version: 1.8.5)
│   └── target/release/    # 构建产物
├── dist/                   # 前端构建产物
├── releases/              # release notes (自动生成)
├── .github/workflows/     # CI/CD 配置
│   └── release.yml       # Release pipeline
├── docs/superpowers/      # 计划文档
├── package.json           # version: 1.8.5
├── pnpm-lock.yaml
└── CLAUDE.md              # 本文件
```

## 版本管理

- **版本 bump**: `pnpm run bump-tauri-version` (同步 package.json → tauri.conf.json)
- **发布流程**: bump 版本 → commit → tag → push --tags
- **CI 路径修复**: release.yml 中 tauri.conf.json 路径已从 `../../../src-tauri/tauri.conf.json` 修正为 `../../src-tauri/tauri.conf.json`

## 构建命令

```bash
# 本地开发
pnpm install
pnpm tauri dev

# 生产构建
pnpm tauri build

# 版本 bump
pnpm run bump-tauri-version

# 触发 CI
git tag v1.8.5 && git push --tags
```

## 已知问题

1. **MSI 签名缺失**: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空，Windows MSI 跳过

## 开发环境

- **OS**: Linux (WSL2 on Windows)
- **Node**: 24.x (via FORCE_JAVASCRIPT_ACTIONS_TO_NODE24)
- **Rust**: stable toolchain
- **pnpm**: v9