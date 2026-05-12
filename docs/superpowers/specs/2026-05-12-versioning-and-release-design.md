# 设计：版本号单源管理 + 发布适配完整性补全

## Status

DRAFT

## 背景问题

当前 CI 和发布流程存在以下问题：

1. **版本号两处定义**：`package.json` 和 `tauri.conf.json` 各自维护版本号，容易不一致
2. **文件缺少架构标注**：产物文件名如 `KnowledgeBase_1.8.1_amd64.deb`，用户无法从文件名判断是否适用
3. **Bundle targets 不完整**：Windows 缺 MSI，Ubuntu 缺 AppImage
4. **发布文档缺失**：每次发版没有统一存档，回溯困难

---

## 解决方案

### 1. 版本号单源管理

`package.json` 是版本号的唯一真值，CI 构建前自动同步到 `tauri.conf.json`。

**流程**：

```
package.json (version: "1.8.1")
       ↓  CI 构建前: pnpm scripts/bump-tauri-version.js
tauri.conf.json (version: "1.8.1")
       ↓
  tauri build
```

**同步脚本** `scripts/bump-tauri-version.js`：

- 读取 `package.json` 的 `version`
- 用 `jq` 或 sed 写入 `src-tauri/tauri.conf.json` 的 `version` 字段
- 不修改任何其他字段

版本更新只需要改 `package.json` 一处。

---

### 2. Bundle Targets 补全

| 平台 | 现有 Target | 新增 Target | 架构标注 |
|------|------------|------------|---------|
| Windows | nsis (x64) | **msi (x64)** | `KnowledgeBase_{VERSION}_x64-setup.exe` / `KnowledgeBase_{VERSION}_x64.msi` |
| Ubuntu | deb (x64) | **appimage (x64)** | `KnowledgeBase_{VERSION}_amd64.deb` / `KnowledgeBase_{VERSION}_amd64.AppImage` |
| macOS | app + dmg (universal) | 不变 | `KnowledgeBase_{VERSION}_aarch64.dmg` / `KnowledgeBase_{VERSION}_aarch64.app.tar.gz` |

**说明**：
- GitHub Actions `windows-latest` / `ubuntu-latest` runner 为 x64 架构，暂无 arm64 runner 支持
- macOS dmg/app 为 Xcode 内置 universal binary，同时包含 x64 + arm64，文件名标注 `aarch64`（ARM64 的 Debian 规范写法）是合理的折中

**tauri.conf.json 改动**：

```json
"bundle": {
  "targets": ["nsis", "msi", "deb", "appimage", "app", "dmg"]
}
```

---

### 3. 文件名架构标注规范

每个产物文件名强制包含架构标识，用户下载时一眼可分辨：

| 平台 | 架构取值 | 示例 |
|------|---------|------|
| Windows | `x64` | `KnowledgeBase_1.8.1_x64-setup.exe` |
| Windows | `x64` | `KnowledgeBase_1.8.1_x64.msi` |
| Ubuntu | `amd64` | `KnowledgeBase_1.8.1_amd64.deb` |
| Ubuntu | `amd64` | `KnowledgeBase_1.8.1_amd64.AppImage` |
| macOS | `aarch64` | `KnowledgeBase_1.8.1_aarch64.dmg` |
| macOS | `aarch64` | `KnowledgeBase_1.8.1_aarch64.app.tar.gz` |

CI 在构建后 rename 步骤自动加上架构后缀。

---

### 4. CI 构建流程改动 (release.yml)

```
1. Checkout
2. Install pnpm
3. Setup Node (.nvmrc)
4. Setup Rust (stable)
5. Install deps
6. [NEW] 同步版本号: node scripts/bump-tauri-version.js
7. Build Tauri: pnpm tauri build
8. [NEW] rename 产物加架构后缀
9. [NEW] 计算 SHA-256
10. [NEW] 生成 release 文档: node scripts/generate-release-doc.js
11. [NEW] commit release 文档到 releases/ 分支或 PR
12. Upload Release Assets (带架构标注的文件名)
```

**rename 逻辑**（Linux/macOS 示例）：

```bash
# Windows
mv "Knowledge Base_1.8.1_x64-setup.exe" "KnowledgeBase_1.8.1_x64-setup.exe" 2>/dev/null || true

# Ubuntu
mv "knowledge-base_1.8.1_amd64.deb" "KnowledgeBase_1.8.1_amd64.deb" 2>/dev/null || true
```

> Tauri 默认输出文件名带空格且大小写不统一，需要 rename 保证一致性。

---

### 5. Release 文档管理

**存放位置**：`releases/v{version}.md`，每次发版新增一个文件，永久存档。

**文档内容模板**：

```markdown
# v{VERSION} ({DATE})

## 下载链接

| 平台 | 架构 | 安装格式 | 文件名 | SHA-256 |
|------|------|---------|--------|---------|
| Windows | x64 | NSIS | KnowledgeBase_{VERSION}_x64-setup.exe | `{sha256}` |
| Windows | x64 | MSI | KnowledgeBase_{VERSION}_x64.msi | `{sha256}` |
| Ubuntu | amd64 | deb | KnowledgeBase_{VERSION}_amd64.deb | `{sha256}` |
| Ubuntu | amd64 | AppImage | KnowledgeBase_{VERSION}_amd64.AppImage | `{sha256}` |
| macOS | aarch64 (universal) | dmg | KnowledgeBase_{VERSION}_aarch64.dmg | `{sha256}` |

## 构建信息

- 构建时间：{ISO8601}
- 构建平台：GitHub Actions
- Rust：stable {rustc version}
- Node：{node version}

## 变更说明

{COMMIT_LOG}

## 已知问题

{如有影响用户的严重 bug 在此说明}
```

**CI 生成逻辑**：

```javascript
// scripts/generate-release-doc.js
// 1. 读取 package.json version
// 2. 读取上一 tag 至今的 git log 作为变更说明
// 3. 读取各 artifact SHA-256
// 4. 写入 releases/v{version}.md
```

---

### 6. 不包含的范围

- **签名**：updater artifacts = false，签名不在本次范围
- **自动更新**：同上
- **arm64 Windows/Linux runner**：GitHub Actions 暂不提供，跨平台交叉编译代价过高，不在本次范围
- **跨平台 universal macOS 拆分**：macOS universal binary 是 Xcode toolchain 内置能力，打一个 dmg 包含双架构是标准做法，不拆分

---

## 依赖

- `scripts/bump-tauri-version.js`：新增，构建前运行
- `scripts/generate-release-doc.js`：新增，构建后运行
- `releases/` 目录：新增，存放版本文档

---

## 改动文件清单

| 文件 | 改动类型 |
|------|---------|
| `package.json` | 版本号唯一来源 |
| `src-tauri/tauri.conf.json` | 新增 msi/appimage targets |
| `.github/workflows/release.yml` | 新增版本同步、rename、SHA256、文档生成步骤 |
| `scripts/bump-tauri-version.js` | 新增 |
| `scripts/generate-release-doc.js` | 新增 |
| `releases/` | 新增目录 |
