import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Sparkles,
  BookOpenText,
  ListChecks,
  Languages,
  MessageCircle,
  MessageSquarePlus,
  Plus,
  Link2,
  Share2,
  Download,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportAiModel, type Envelope } from "@/lib/configShare";
import { message } from "antd";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiModel } from "@/types";
import { relativeTime } from "@/lib/utils";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";

/**
 * 移动端 AI 助手列表页（设计稿：06-ai.html）
 *
 * 结构：
 * - 顶栏：标题"AI 助手" + 当前模型/对话数 + 搜索按钮
 * - 模型 chips 横滑（点击切换 default 模型）
 * - 4 个快捷入口（写作 / 解读 / 任务规划 / 翻译） — 点击 = 用预设 Prompt 创建新对话
 * - 对话历史列表（按 updated_at desc）
 * - 右下 FAB（橙色）= 创建空白对话
 *
 * 跳转：
 * - 点击对话 / FAB / 快捷入口 → 暂走 /ai?conv=ID（桌面 AiChatPage 已支持），
 *   等 MobileAiChat 做完再换 /ai-chat/:id
 */

interface QuickEntry {
  key: string;
  icon: React.ReactNode;
  bg: string;
  label: string;
  /** 创建对话后预填到首条 user 消息的 prompt（暂未实现 prefill，先创建空对话） */
  preset?: string;
}

const QUICK_ENTRIES: QuickEntry[] = [
  {
    key: "write",
    icon: <Sparkles size={20} className="text-[#FA8C16]" />,
    bg: "bg-orange-50",
    label: "写作助手",
  },
  {
    key: "read",
    icon: <BookOpenText size={20} className="text-[#1677FF]" />,
    bg: "bg-blue-50",
    label: "解读笔记",
  },
  {
    key: "tasks",
    icon: <ListChecks size={20} className="text-green-600" />,
    bg: "bg-green-50",
    label: "任务规划",
  },
  {
    key: "translate",
    icon: <Languages size={20} className="text-purple-600" />,
    bg: "bg-purple-50",
    label: "翻译润色",
  },
];

export function MobileAi() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [convs, mods] = await Promise.all([
        aiChatApi.listConversations().catch(() => [] as AiConversation[]),
        aiModelApi.list().catch(() => [] as AiModel[]),
      ]);
      setConversations(convs);
      setModels(mods);
    } catch (e) {
      console.error("[MobileAi] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultModel = models.find((m) => m.is_default) ?? models[0];

  async function switchDefaultModel(id: number) {
    try {
      await aiModelApi.setDefault(id);
      await load();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  function openConversation(conv: AiConversation) {
    navigate(`/ai-chat/${conv.id}`);
  }

  async function createNew() {
    try {
      const conv = await aiChatApi.createConversation();
      navigate(`/ai-chat/${conv.id}`);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <div className="bg-white px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">AI 助手</h1>
            <div className="mt-0.5 text-xs text-slate-400">
              {defaultModel ? defaultModel.name : "未配置模型"} ·{" "}
              {conversations.length} 个对话
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (defaultModel) setShareEnv(exportAiModel(defaultModel));
                else message.warning("请先配置一个 AI 模型");
              }}
              aria-label="分享当前模型"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Share2 size={18} className="text-slate-700" />
            </button>
            <button
              onClick={() => setImportOpen(true)}
              aria-label="导入模型"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Download size={18} className="text-slate-700" />
            </button>
            <button
              aria-label="搜索"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Search size={18} className="text-slate-700" />
            </button>
          </div>
        </div>

        {/* 模型 chips */}
        <div className="mt-3 flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 scrollbar-none">
          {models.length === 0 ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-400">
              请到 设置 → AI 模型 添加
            </span>
          ) : (
            models.map((m) => (
              <button
                key={m.id}
                onClick={() => switchDefaultModel(m.id)}
                className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
                  m.is_default
                    ? "border border-orange-200 bg-orange-50 text-orange-700"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {m.name}
                {m.is_default && " ✓"}
              </button>
            ))
          )}
          <button
            onClick={() => setAddModelOpen(true)}
            aria-label="新增模型"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="bg-slate-50 pb-24">
        {/* 4 快捷入口 */}
        <div className="px-4 py-3">
          <div className="grid grid-cols-4 gap-3">
            {QUICK_ENTRIES.map((q) => (
              <button
                key={q.key}
                onClick={createNew}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${q.bg}`}
                >
                  {q.icon}
                </div>
                <span className="text-[11px] text-slate-700">{q.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 对话历史标题 */}
        <div className="flex items-center justify-between px-4 pt-1 pb-1 text-xs font-medium text-slate-400">
          <span>对话历史</span>
          <button
            onClick={() => navigate("/ai")}
            className="text-[#1677FF]"
          >
            管理
          </button>
        </div>

        {/* 对话列表 */}
        {loading && conversations.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            加载中...
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <MessageSquarePlus size={40} className="text-slate-300" />
            <span className="text-sm">还没有对话</span>
            <span className="text-xs text-slate-300">
              点右下橙色按钮开始对话
            </span>
          </div>
        ) : (
          conversations.map((conv) => (
            <ConversationCard
              key={conv.id}
              conv={conv}
              modelName={
                models.find((m) => m.id === conv.model_id)?.name ?? "未知模型"
              }
              onClick={() => openConversation(conv)}
            />
          ))
        )}
      </div>

      {/* FAB（替代全局蓝色 + FAB，MobileLayout 已感知 /ai 隐藏全局 FAB） */}
      <button
        onClick={createNew}
        aria-label="新对话"
        className="fixed right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#FA8C16] text-white shadow-[0_8px_24px_rgba(250,140,22,0.4)] active:scale-95 transition-transform"
        style={{
          bottom: `calc(64px + env(safe-area-inset-bottom, 0px) + 16px)`,
        }}
      >
        <MessageSquarePlus size={24} />
      </button>

      <MobileAiModelModal
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        onSaved={() => {
          void load();
        }}
        okText="保存"
      />

      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />

      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />
    </div>
  );
}

function ConversationCard({
  conv,
  modelName,
  onClick,
}: {
  conv: AiConversation;
  modelName: string;
  onClick: () => void;
}) {
  const hasNotes = conv.attached_note_ids && conv.attached_note_ids.length > 0;

  return (
    <button
      onClick={onClick}
      className="block w-full px-4 mb-2 text-left active:opacity-80"
    >
      <div className="rounded-2xl bg-white p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100">
            <MessageCircle size={16} className="text-[#FA8C16]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-slate-900">
              {conv.title || "未命名对话"}
            </h3>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] text-orange-600">
                {modelName}
              </span>
              {hasNotes && (
                <span className="flex items-center gap-1 text-slate-500">
                  <Link2 size={12} />
                  {conv.attached_note_ids.length} 篇
                </span>
              )}
              <span className="ml-auto">{relativeTime(conv.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}
