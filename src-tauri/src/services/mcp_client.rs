//! 外部 MCP server 客户端管理（M5-2）
//!
//! 用户在「设置 → MCP 服务器」里加的每个 server 都对应一个独立子进程。
//! 频繁调用时不能每次都 spawn（握手 1-2s 太贵），所以做进程级缓存：
//!   - 第一次访问 server X → spawn + 握手 + 存到 HashMap<id, Arc<RunningService>>
//!   - 后续调用 → 直接拿 Arc 复用
//!   - server 改配置 / 禁用 / 删除 → 调 disconnect(id) 清缓存（下次访问会重新 spawn）

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::models::McpServer;

/// 允许作为 MCP server command 的基础 binary 白名单。
/// 避免攻击者把 server.command 改成 /bin/bash 等进行任意命令执行。
const ALLOWED_COMMANDS: &[&str] = &[
    "npx", "node", "npm", "yarn", "pnpm",
    "python3", "python", "uv",
    "deno",
    "bun", "sh",
];

/// 危险的 shell 元字符序列，禁止出现在 args 中（防止 ; / | / && / > 等注入）
const DANGEROUS_ARGS: &[&str] = &[
    ";", "|", "&&", "||", ">", ">>", "<", "<<",
    "`", "$(", "${",
];

/// 验证 MCP server command 是否安全。
/// - command 必须是白名单中的基础 binary
/// - args 中不能包含危险 shell 元字符
fn validate_server_command(command: &str, args: &[String]) -> Result<(), AppError> {
    // 检查 command 是否在白名单中（basename 比对）
    let cmd_basename = std::path::Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);

    if !ALLOWED_COMMANDS.contains(&cmd_basename) {
        return Err(AppError::Custom(format!(
            "MCP server command '{}' 不在允许列表中，仅允许: {}",
            cmd_basename,
            ALLOWED_COMMANDS.join(", ")
        )));
    }

    // 检查 args 中是否有危险 shell 注入模式
    for arg in args {
        let arg_lower = arg.to_lowercase();
        if DANGEROUS_ARGS.iter().any(|pat| arg_lower.contains(&pat.to_lowercase())) {
            return Err(AppError::Custom(format!(
                "MCP server args 包含危险字符 '{}'，拒绝执行",
                arg
            )));
        }
    }

    Ok(())
}

/// 与 in-memory client 同类型：RoleClient + 不响应 server-initiated 请求
type ExternalClient = Arc<rmcp::service::RunningService<rmcp::RoleClient, ()>>;

/// 全局 MCP client 池。AppState 持一份。
#[derive(Default)]
pub struct McpClientManager {
    clients: Mutex<HashMap<i64, ExternalClient>>,
}

impl McpClientManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取（或首次 spawn）指定 server 的 client。
    ///
    /// 错误场景：
    /// - server.enabled = false → InvalidInput
    /// - command 不存在 / spawn 失败 → IO error 包裹
    /// - 子进程握手失败（不是合规 MCP server）→ Custom error
    pub async fn get_or_spawn(&self, server: &McpServer) -> Result<ExternalClient, AppError> {
        if !server.enabled {
            return Err(AppError::Custom(format!(
                "MCP server {} 已禁用",
                server.name
            )));
        }

        // 安全验证：command 白名单 + args 危险字符检查
        validate_server_command(&server.command, &server.args)?;

        let mut guard = self.clients.lock().await;
        if let Some(c) = guard.get(&server.id) {
            return Ok(c.clone());
        }

        // 第一次访问：spawn 子进程
        let mut cmd = tokio::process::Command::new(&server.command);
        cmd.args(&server.args);

        // macOS / Linux GUI app 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
        // 不读 ~/.zshrc / ~/.bashrc，导致 spawn `npx` / `node` / brew 装的 binary 找不到。
        // 在用户自定义 env 之前先注入"用户登录 shell 解析后的真实 PATH"，
        // 用户在 server.env 里再覆盖也行。
        if let Some(path) = enriched_path() {
            cmd.env("PATH", path);
        }
        for (k, v) in &server.env {
            cmd.env(k, v);
        }

        // Windows 必须设 CREATE_NO_WINDOW，否则打包后每次 spawn 都弹 CMD 黑窗
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let transport = TokioChildProcess::new(cmd)
            .map_err(|e| AppError::Custom(format!("spawn {} 失败: {}", server.command, e)))?;

        let client = ()
            .serve(transport)
            .await
            .map_err(|e| AppError::Custom(format!("MCP 握手失败: {e}")))?;

        let arc = Arc::new(client);
        guard.insert(server.id, arc.clone());
        log::info!(
            "[mcp-external] spawned id={} name={} command={}",
            server.id,
            server.name,
            server.command
        );
        Ok(arc)
    }

    /// 关闭指定 server 的 client + 清缓存。改配置 / 禁用 / 删除时调用。
    pub async fn disconnect(&self, id: i64) {
        let mut guard = self.clients.lock().await;
        if guard.remove(&id).is_some() {
            log::info!("[mcp-external] disconnected id={}", id);
        }
    }

    /// 应用退出 / 实例切换时全部断开
    #[allow(dead_code)]
    pub async fn disconnect_all(&self) {
        let mut guard = self.clients.lock().await;
        let count = guard.len();
        guard.clear();
        log::info!("[mcp-external] disconnected all ({} clients)", count);
    }
}

// ─── macOS / Linux GUI app PATH 修复 ─────────────────────────────
//
// 已知坑：macOS GUI app 启动时不读 ~/.zshrc，PATH 只有系统默认 4 个路径。
// 用户从设置页加 "command: npx" 类型的 MCP server 时，spawn 直接 ENOENT。
// 借鉴 VS Code 的 fixZshHome 思路：先 fork 一次用户的 login + interactive shell，
// 让 shell 把 ~/.zshrc / .bashrc / nvm / brew 的 PATH 都解析好，echo 出来缓存。
// 用 marker 包裹 echo 内容，避免 shell banner（oh-my-zsh / fortune 等）污染。

/// 取用户登录 shell 解析后的 PATH。失败时返回 None（spawn 会继续用 GUI 默认 PATH）。
/// 进程级缓存：只在第一次 spawn 时跑一次 shell。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn enriched_path() -> Option<&'static str> {
    use std::process::Stdio;
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").ok()?;
            const MARKER_START: &str = "<<MCP_PATH_START>>";
            const MARKER_END: &str = "<<MCP_PATH_END>>";
            // -l: login shell（读 .zprofile / .bash_profile）
            // -i: interactive shell（读 .zshrc / .bashrc，覆盖 nvm 这种只在 interactive 才设的工具）
            // -c: 执行命令后退出
            // marker 包裹避免 shell banner 污染 stdout
            let probe = format!("printf '{MARKER_START}%s{MARKER_END}' \"$PATH\"");
            let output = std::process::Command::new(&shell)
                .args(["-l", "-i", "-c", &probe])
                .stdin(Stdio::null()) // 防止 shell 等用户输入卡死
                .output()
                .ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let start = stdout.find(MARKER_START)? + MARKER_START.len();
            let end = stdout.find(MARKER_END)?;
            if start >= end {
                return None;
            }
            let path = stdout[start..end].trim();
            if path.is_empty() {
                None
            } else {
                log::info!(
                    "[mcp-external] enriched PATH from login shell ({} entries)",
                    path.split(':').count()
                );
                Some(path.to_string())
            }
        })
        .as_deref()
}

/// Windows GUI app 的 PATH 跟系统 PATH 一致（HKLM/HKCU 注册表），不需要修复
#[cfg(target_os = "windows")]
fn enriched_path() -> Option<&'static str> {
    None
}
