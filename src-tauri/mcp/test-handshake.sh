#!/usr/bin/env bash
# 手动跑一次 MCP initialize + tools/list + tools/call 握手，验证 sidecar OK
# 用法：./test-handshake.sh
set -e

BIN="$(dirname "$0")/../target/debug/kb-mcp.exe"
DB="C:/Users/yecha/AppData/Roaming/com.agilefr.kb/app.db"

# 一次性把所有请求喂到 stdin（每行一个 JSON-RPC 帧），收集 stdout
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"handshake-test","version":"0.1"}}}'
  # initialize 完成后客户端必须发 notifications/initialized
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"codex","limit":3}}}'
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_tags","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_daily_notes","arguments":{"days":30,"limit":3}}}'
  echo '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_tasks","arguments":{"limit":3}}}'
  echo '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_backlinks","arguments":{"id":6}}}'
  # 给 server 一点时间响应再退出
  sleep 1
} | "$BIN" --db-path "$DB"
