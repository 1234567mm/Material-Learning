# Material-Learning 项目概览

## 基本信息

- **当前版本**: 1.8.1 (package.json)
- **最新 tag**: v1.8.3 (但代码版本是 1.8.1，存在 tag 与代码不同步问题)
- **技术栈**: Tauri 2.x + React + SQLite + TypeScript
- **主分支**: main

## CI/CD

- **构建平台**: GitHub Actions (ubuntu-latest, windows-latest, macos-latest)
- **触发条件**: push tags `v*` 或 push 到 main 分支
- **lint job**: ~30s
- **构建 job**: ~15-18min/平台（优化后应该更短）
- **当前问题**:
  - TAURI_SIGNING_PRIVATE_KEY_PASSWORD 为空导致 MSI 构建失败
  - 各平台构建了不需要的 bundle target（已优化为只构建需要的格式）

## 项目结构

```
Material-Learning/
├── src-tauri/          # Rust 后端 (Tauri)
├── src/                # React 前端
├── dist/               # 前端构建产物
├── releases/           # release notes (自动生成)
├── .github/workflows/  # CI/CD 配置
└── package.json       # 版本: 1.8.1
```

## 关键命令

```bash
# 本地构建
pnpm tauri build

# 触发 CI (推送 tag)
git tag v1.8.4 && git push --tags
```

## 版本与 Tag 同步问题

- `package.json` version: 1.8.1
- `src-tauri/tauri.conf.json` version: 1.8.1
- Git tag v1.8.3 已推送但代码版本停留在 1.8.1
- 建议：tag 版本应与代码版本一致，发布前先 bump 版本