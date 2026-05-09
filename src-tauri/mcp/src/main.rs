//! kb-mcp · Knowledge Base MCP Server (stdio binary)
//!
//! 极薄的 stdio MCP server 入口：
//! 1. CLI 解析 db_path / writable
//! 2. 委托给 kb_core::KbServer 跑 stdio
//!
//! 业务（KbDb / KbServer / 12 工具 / SQL）全部在 kb-core crate，
//! 主应用 (knowledge_base) 也通过同一份 kb-core 跑 in-memory MCP server。

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use kb_core::{KbDb, KbServer};
use rmcp::{transport::stdio, ServiceExt};

#[derive(Debug, Parser)]
#[command(
    name = "kb-mcp",
    version,
    about = "Knowledge Base MCP Server - 把本地知识库以 MCP 协议暴露给 LLM 客户端"
)]
struct Cli {
    /// 知识库 SQLite 文件路径（必填）。通常是主应用的 app.db。
    /// 例：Windows 下 C:\Users\<name>\AppData\Roaming\com.agilefr.kb\app.db
    #[arg(long, env = "KB_MCP_DB_PATH")]
    db_path: PathBuf,

    /// 启用写工具（create_note / update_note / add_tag_to_note）。
    /// 默认关闭 = 完全只读，更安全；显式打开后 LLM 可创建/修改你的笔记。
    #[arg(long, default_value_t = false)]
    writable: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    // clap 自己处理 --help / --version（写 stdout 后 exit），先解析再打日志
    let cli = Cli::parse();

    // 关键：日志走 stderr，stdout 是 JSON-RPC 通道，绝对不能污染
    eprintln!(
        "[kb-mcp] starting v{}, db = {}, mode = {}",
        env!("CARGO_PKG_VERSION"),
        cli.db_path.display(),
        if cli.writable {
            "READ-WRITE"
        } else {
            "READ-ONLY"
        }
    );

    if !cli.db_path.exists() {
        anyhow::bail!("db 文件不存在: {}", cli.db_path.display());
    }

    let db = KbDb::open(&cli.db_path, cli.writable)?;
    let server = KbServer::new(db, cli.writable);

    // serve(stdio()) 接管 stdin/stdout，按 JSON-RPC 帧收发
    let service = server
        .serve(stdio())
        .await
        .with_context(|| "rmcp serve(stdio) 启动失败")?;

    eprintln!("[kb-mcp] ready");
    service.waiting().await?;
    eprintln!("[kb-mcp] shutdown");
    Ok(())
}
