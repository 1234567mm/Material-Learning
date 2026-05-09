#!/usr/bin/env bash
# 端到端写工具测试：先在 readonly 模式下确认拒绝，再 --writable 真创建
set -e
BIN="$(dirname "$0")/../target/debug/kb-mcp.exe"
DB="C:/Users/yecha/AppData/Roaming/com.agilefr.kb/app.db"

echo "=== 1) readonly 模式下尝试 create_note，应被拒绝 ==="
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0.1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"由MCP创建","content":"<p>测试</p>"}}}'
  sleep 1
} | "$BIN" --db-path "$DB" 2>/dev/null | grep -E '"id":2'

echo ""
echo "=== 2) --writable 模式真创建 ==="
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0.1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"kb-mcp测试笔记","content":"<p>这条笔记由 kb-mcp 通过 MCP 协议创建。</p>"}}}'
  sleep 1
} | "$BIN" --db-path "$DB" --writable 2>/dev/null | grep -E '"id":3'

echo ""
echo "=== 3) 验证 db 里真有这条笔记 ==="
PYTHONIOENCODING=utf-8 python -c "
import sqlite3
conn = sqlite3.connect('$DB')
cur = conn.cursor()
cur.execute(\"SELECT id, title, content_hash, length(content) FROM notes WHERE title = 'kb-mcp测试笔记' ORDER BY id DESC LIMIT 1\")
row = cur.fetchone()
if row:
    print(f'  id={row[0]}, title={row[1]}, hash={row[2][:12]}..., content_len={row[3]}')
else:
    print('  ❌ 没找到')
"

echo ""
echo "=== 4) update_note 改标题 ==="
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0.1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  # 用上面查到的 id；先动态查一次
  NOTE_ID=$(PYTHONIOENCODING=utf-8 python -c "
import sqlite3
conn = sqlite3.connect('$DB')
print(conn.execute(\"SELECT id FROM notes WHERE title='kb-mcp测试笔记' ORDER BY id DESC LIMIT 1\").fetchone()[0])
")
  echo "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"update_note\",\"arguments\":{\"id\":${NOTE_ID},\"title\":\"kb-mcp测试笔记-改名版\"}}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"add_tag_to_note\",\"arguments\":{\"note_id\":${NOTE_ID},\"tag\":\"by-mcp\"}}}"
  sleep 1
} | "$BIN" --db-path "$DB" --writable 2>/dev/null | grep -E '"id":[45]'

echo ""
echo "=== 5) 验证标题已改 + 标签已加 ==="
PYTHONIOENCODING=utf-8 python -c "
import sqlite3
conn = sqlite3.connect('$DB')
cur = conn.cursor()
row = cur.execute(\"SELECT id, title, title_normalized FROM notes WHERE title LIKE '%kb-mcp%' ORDER BY id DESC LIMIT 1\").fetchone()
if row:
    print(f'  笔记: id={row[0]} title={row[1]} normalized={row[2]}')
tags = cur.execute(\"SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=?\", (row[0],)).fetchall()
print(f'  标签: {[t[0] for t in tags]}')
"
