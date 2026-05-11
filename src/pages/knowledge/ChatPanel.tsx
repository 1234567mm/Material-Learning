import { useState, useEffect, useRef } from "react";
import { Input, Button, Tabs, message } from "antd";
import { Send, Square, Search, Settings } from "lucide-react";
import { knowledgeApi } from "@/lib/api";
import type {
  KnowledgePanel,
  KnowledgeSession,
  KnowledgeMessage,
  KnowledgeSimilarityHit,
} from "@/types";
import { ChatMessage as ChatMessageComp } from "./ChatMessage";
import { MemoryManager } from "./MemoryManager";

interface Props {
  panel: KnowledgePanel;
}

export function ChatPanel({ panel }: Props) {
  const [session, setSession] = useState<KnowledgeSession | null>(null);
  const [messages, setMessages] = useState<KnowledgeMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const [searchQuery, setSearchQuery] = useState("");
  const [ftsResults, setFtsResults] = useState<[number, string, string][]>([]);
  const [vectorResults, setVectorResults] = useState<KnowledgeSimilarityHit[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-create session when panel changes
  useEffect(() => {
    const init = async () => {
      try {
        const s = await knowledgeApi.createSession(panel.id);
        setSession(s);
        setMessages([]);
      } catch (e) {
        message.error("创建会话失败");
      }
    };
    init();
  }, [panel.id]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !session) return;
    const content = input.trim();
    setInput("");
    setLoading(true);
    try {
      const msg = await knowledgeApi.sendMessage(session.id, content);
      setMessages(prev => [...prev, msg]);
    } catch (e) {
      message.error("发送失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  const handleEnd = async () => {
    if (!session) return;
    try {
      await knowledgeApi.endSession(session.id);
      message.success("会话已结束，摘要已生成");
      // Create new session
      const s = await knowledgeApi.createSession(panel.id);
      setSession(s);
      setMessages([]);
    } catch (e) {
      message.error("结束会话失败");
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const [fts, vec] = await Promise.all([
        knowledgeApi.searchFiles(searchQuery, panel.id),
        knowledgeApi.similarChunks(searchQuery, panel.id),
      ]);
      setFtsResults(fts);
      setVectorResults(vec);
    } catch (e) {
      message.error("搜索失败");
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100vh" }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        style={{ padding: "0 16px", borderBottom: "1px solid #f0f0f0" }}
        items={[
          { key: "chat", label: <span><Send size={14} style={{marginRight:4}}/>对话</span> },
          { key: "search", label: <span><Search size={14} style={{marginRight:4}}/>搜索</span> },
          { key: "settings", label: <span><Settings size={14} style={{marginRight:4}}/>设置</span> },
        ]}
      />

      {activeTab === "chat" && (
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {messages.map(msg => (
            <ChatMessageComp key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
          <div style={{
            display: "flex",
            gap: 8,
            padding: "12px 0",
            borderTop: "1px solid #f0f0f0",
          }}>
            <Input.TextArea
              value={input}
              onChange={e => setInput(e.target.value)}
              onPressEnter={e => { if (!e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="输入消息，Shift+Enter 换行"
              autoSize={{ maxRows: 6 }}
              style={{ flex: 1 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Button type="primary" icon={<Send size={14} />} onClick={handleSend} loading={loading} />
              <Button icon={<Square size={14} />} onClick={handleEnd} title="结束会话" />
            </div>
          </div>
        </div>
      )}

      {activeTab === "search" && (
        <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Input.Search
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onSearch={handleSearch}
              placeholder="搜索知识库..."
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <h4>FTS5 搜索结果</h4>
            {ftsResults.map(([id, title, snippet]) => (
              <div key={id} style={{ marginBottom: 8, padding: 8, border: "1px solid #f0f0f0", borderRadius: 6 }}>
                <div style={{ fontWeight: 600 }}>{title}</div>
                <div>{snippet.replace(/<[^>]*>/g, '')}</div>
              </div>
            ))}
            {ftsResults.length === 0 && <span style={{ color: "#999" }}>无结果</span>}
          </div>
          <div>
            <h4>向量相似度结果</h4>
            {vectorResults.map((hit, i) => (
              <div key={i} style={{ marginBottom: 8, padding: 8, border: "1px solid #f0f0f0", borderRadius: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: "#1677ff" }}>
                  相似度: {(hit.score * 100).toFixed(1)}%
                </div>
                <div>{hit.content}</div>
              </div>
            ))}
            {vectorResults.length === 0 && <span style={{ color: "#999" }}>无结果</span>}
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <SettingsTab panel={panel} />
      )}
    </div>
  );
}

// Inner settings tab component
function SettingsTab({ panel }: { panel: KnowledgePanel }) {
  const [prompt, setPrompt] = useState(panel.system_prompt || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await knowledgeApi.updatePanel(panel.id, panel.name, prompt || undefined);
      message.success("已保存");
    } catch (e) {
      message.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, overflow: "auto" }}>
      <div>
        <h3>面板设置: {panel.name}</h3>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>System Prompt</label>
          <Input.TextArea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="输入该面板的系统提示词，用于指导 AI 回复风格和上下文..."
            rows={6}
            style={{ width: "100%" }}
          />
        </div>
        <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
      </div>
      <MemoryManager />
    </div>
  );
}