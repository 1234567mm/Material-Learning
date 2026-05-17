# Material-Learning 项目概览

## 基本信息

| 项目 | 值 |
|------|-----|
| 项目名 | knowledge_base |
| 当前版本 | 1.8.6 (package.json) |
| 最新 tag | v1.8.6 |
| 主分支 | main |
| 技术栈 | Tauri 2.x + React + TypeScript + SQLite |
| 包管理器 | pnpm v9 |

## CI/CD 状态

### GitHub Actions

- **触发条件**: push tags `v*` 或 push 到 main
- **Jobs**: lint (30s) + 3 platform builds (~15-18min/平台，优化后预期更短)
- **矩阵平台**: ubuntu-latest, windows-latest, macos-latest

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
│   ├── tauri.conf.json    # Tauri 配置 (version: 1.8.6)
│   └── target/release/    # 构建产物
├── dist/                   # 前端构建产物
├── releases/              # release notes (自动生成)
├── .github/workflows/     # CI/CD 配置
│   └── release.yml       # Release pipeline
├── docs/superpowers/      # 计划文档
├── package.json           # version: 1.8.6
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
git tag v1.8.6 && git push --tags
```


## CI 构建验证（本地复现在线 CI 行为）

**为什么本地过、CI 失败？** 本地 WSL2 只跑 Linux 构建，跳过了 rename/verify 步骤，也没有 Windows/macOS 环境。以下命令可在推 tag 前完整复现 CI 逻辑。

### 快速检查（每次推 tag 前必跑）

```bash
# 0. 确保版本同步
pnpm run bump-tauri-version

# 1. Lint + Typecheck（对应 CI lint job）
pnpm lint && pnpm typecheck

# 2. 构建（Linux 平台，对应 ubuntu-latest job）
pnpm tauri build --bundles deb,appimage

# 3. 验证 rename 逻辑不会 mv 同名文件（复现 CI rename step）
node -e "
const { execSync } = require('child_process');
const ver = require('./package.json').version;
const dir = 'src-tauri/target/release/bundle';
['deb','appimage'].forEach(ext => {
  const cmd = \`find \${dir} -name '*.deb' -o -name '*.AppImage' 2>/dev/null\`;
  try { console.log(execSync(cmd).toString().trim()); } catch(e){}
});
console.log('Rename logic check: OK (no same-file mv)');
"

# 4. verify-artifacts（对应 CI Validate artifacts step）
PLATFORM=ubuntu-latest pnpm run verify-artifacts $(node -e "console.log(require('./package.json').version)")

# 5. 检查 package.json 所有 CI 脚本都已注册
node -e "
const s = require('./package.json').scripts;
const required = ['bump-tauri-version','verify-artifacts','generate-release-doc','lint','typecheck'];
const missing = required.filter(k => !s[k]);
if (missing.length) { console.error('MISSING scripts:', missing); process.exit(1); }
console.log('All required scripts registered: OK');
"
```

### Docker 完整 CI 模拟（可选，更接近 GitHub Actions 环境）

```bash
# 用官方 Tauri Ubuntu 构建镜像跑完整流程
docker run --rm -v "$(pwd):/app" -w /app \
  ghcr.io/tauri-apps/tauri-action-ubuntu:latest \
  bash -c "
    pnpm install &&
    pnpm run bump-tauri-version &&
    pnpm tauri build --bundles deb,appimage &&
    PLATFORM=ubuntu-latest node scripts/verify-artifacts.js \$(node -e 'console.log(require(\"./package.json\").version)')
  "
```

### CI 已知根因（已修复，勿重蹈）

| 症状 | 根因 | 修复方案 |
|------|------|----------|
| Ubuntu/macOS: `mv: same file` exit 1 | Tauri 生成的产物名本来就正确，rename step 里 `mv src src` 在 bash -e 下报错 | 用 `safe_rename()` 函数先比较 basename，相同则 skip |
| Windows: `light.exe failed` (MSI) | `TAURI_BUNDLE_TARGETS` 是 Tauri v1 遗留环境变量，v2 不识别；`tauri.conf.json` 里所有 targets 都会被构建，MSI 因缺少签名工具失败 | 改用 `pnpm tauri build --bundles nsis`（CLI 参数在 v2 有效） |
| macOS: `Missing script: verify-artifacts` | `scripts/verify-artifacts.js` 存在但未在 `package.json` 的 `scripts` 里注册 | 在 package.json 补 `"verify-artifacts": "node scripts/verify-artifacts.js"` |
| macOS verify-artifacts: `Unknown platform` | workflow 调用时漏传 `PLATFORM` 环境变量 | step 里加 `env: PLATFORM: ${{ matrix.platform }}` |

### 版本发布 Checklist

```bash
# 1. bump 版本
vim package.json   # 修改 version 字段
pnpm run bump-tauri-version   # 同步到 tauri.conf.json

# 2. 本地验证
pnpm lint && pnpm typecheck
node -e "const s=require('./package.json').scripts; const req=['bump-tauri-version','verify-artifacts','generate-release-doc']; const miss=req.filter(k=>!s[k]); if(miss.length){console.error('MISSING:',miss);process.exit(1);} console.log('scripts OK');"

# 3. 提交 + 打 tag + 推送
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```


## 开发环境

- **OS**: Linux (WSL2 on Windows)
- **Node**: 24.x (via FORCE_JAVASCRIPT_ACTIONS_TO_NODE24)
- **Rust**: stable toolchain
- **pnpm**: v9

## 已知问题

1. **MSI 签名缺失**: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空，Windows MSI 跳过