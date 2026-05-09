import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, X, Palette } from "lucide-react";
import { Modal, Input, message } from "antd";
import { tagApi } from "@/lib/api";
import type { Tag } from "@/types";

/**
 * 移动端标签管理页（设计稿：05-tags.html）
 *
 * 路由 /tags —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * 功能：
 * - 顶部：返回 + 「标签」 + 新增 +
 * - 标签云（按 note_count 降序，字号大小动态）
 * - 标签列表（点 chevron 进入该标签的笔记列表 — 暂跳搜索 ?q=#tag）
 * - 点击调色盘按钮 → 弹出底部颜色选择 + 删除/重命名
 *
 * MVP 不实现：
 * - 标签 → 该标签下笔记列表（需要 search 接口支持 tag_id 参数，先用 search keyword 替代）
 */

const COLOR_PALETTE: { name: string; bg: string; text: string; dot: string }[] = [
  { name: "blue",   bg: "bg-blue-50",   text: "text-blue-700",   dot: "bg-blue-500" },
  { name: "green",  bg: "bg-green-50",  text: "text-green-700",  dot: "bg-green-500" },
  { name: "orange", bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500" },
  { name: "purple", bg: "bg-purple-50", text: "text-purple-700", dot: "bg-purple-500" },
  { name: "pink",   bg: "bg-pink-50",   text: "text-pink-700",   dot: "bg-pink-500" },
  { name: "yellow", bg: "bg-yellow-50", text: "text-yellow-700", dot: "bg-yellow-500" },
  { name: "red",    bg: "bg-red-50",    text: "text-red-700",    dot: "bg-red-500" },
  { name: "cyan",   bg: "bg-cyan-50",   text: "text-cyan-700",   dot: "bg-cyan-500" },
  { name: "slate",  bg: "bg-slate-100", text: "text-slate-600",  dot: "bg-slate-500" },
];

function colorClass(name: string | null): { bg: string; text: string; dot: string } {
  const c = COLOR_PALETTE.find((p) => p.name === name);
  if (c) return c;
  return { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" };
}

/** 按 note_count 决定 chip 字号（标签云效果） */
function fontByCount(n: number, maxCount: number): string {
  if (maxCount === 0) return "text-sm";
  const ratio = n / maxCount;
  if (ratio >= 0.7) return "text-base font-bold";
  if (ratio >= 0.4) return "text-sm font-medium";
  return "text-xs";
}

export function MobileTags() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await tagApi.list();
      setTags(list);
    } catch (e) {
      console.error("[MobileTags] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = [...tags].sort((a, b) => b.note_count - a.note_count);
  const maxCount = sorted[0]?.note_count ?? 0;

  async function createNew() {
    const name = window.prompt("输入新标签名");
    if (!name?.trim()) return;
    try {
      await tagApi.create(name.trim());
      message.success("已创建");
      await load();
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  async function setColor(t: Tag, color: string | null) {
    try {
      await tagApi.setColor(t.id, color);
      message.success("颜色已更新");
      await load();
    } catch (e) {
      message.error(`更新失败: ${e}`);
    }
  }

  function openRename(t: Tag) {
    setRenameValue(t.name);
    setRenameOpen(true);
  }
  async function submitRename() {
    if (!editing || !renameValue.trim()) return;
    try {
      await tagApi.rename(editing.id, renameValue.trim());
      message.success("已重命名");
      setRenameOpen(false);
      setEditing(null);
      await load();
    } catch (e) {
      message.error(`重命名失败: ${e}`);
    }
  }

  async function deleteTag(t: Tag) {
    if (!window.confirm(`确认删除「#${t.name}」？关联的笔记会失去这个标签。`)) {
      return;
    }
    try {
      await tagApi.delete(t.id);
      message.success("已删除");
      setEditing(null);
      await load();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  function gotoTagNotes(t: Tag) {
    // 暂用搜索关键字代替专门的 tag 过滤路由
    navigate(`/search?q=${encodeURIComponent("#" + t.name)}`);
  }

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <h1 className="text-base font-semibold">标签</h1>
        <button
          onClick={createNew}
          aria-label="新增标签"
          className="flex h-10 w-10 items-center justify-center"
        >
          <Plus size={22} className="text-[#1677FF]" />
        </button>
      </header>

      <div className="bg-slate-50 pb-12">
        {/* 标签云 */}
        <div className="px-4 py-3">
          <div className="mb-2 text-xs font-medium text-slate-400">
            标签云 · 按使用频率
          </div>
          <div className="rounded-2xl bg-white p-4">
            {loading ? (
              <div className="text-center text-sm text-slate-400 py-4">
                加载中…
              </div>
            ) : sorted.length === 0 ? (
              <div className="text-center text-sm text-slate-400 py-4">
                还没有标签，点右上 + 新建
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sorted.map((t) => {
                  const c = colorClass(t.color);
                  return (
                    <button
                      key={t.id}
                      onClick={() => gotoTagNotes(t)}
                      className={`rounded-full px-3 py-1.5 ${c.bg} ${c.text} ${fontByCount(t.note_count, maxCount)}`}
                    >
                      #{t.name} {t.note_count}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 标签列表 */}
        {sorted.length > 0 && (
          <div className="px-4 py-2">
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">
              <span>全部 {sorted.length} 个标签</span>
            </div>
            <div className="divide-y divide-slate-100 rounded-2xl bg-white">
              {sorted.map((t) => {
                const c = colorClass(t.color);
                const isEditing = editing?.id === t.id;
                return (
                  <div key={t.id}>
                    <div
                      className={`flex items-center gap-3 px-4 py-3 ${
                        isEditing ? "bg-slate-50" : ""
                      }`}
                    >
                      <div className={`h-3 w-3 rounded-full ${c.dot}`} />
                      <button
                        onClick={() => gotoTagNotes(t)}
                        className="flex-1 text-left text-sm font-medium text-slate-800"
                      >
                        #{t.name}
                      </button>
                      <span className="text-xs text-slate-400">
                        {t.note_count}
                      </span>
                      <button
                        onClick={() => setEditing(isEditing ? null : t)}
                        aria-label="编辑"
                        className="flex h-7 w-7 items-center justify-center"
                      >
                        {isEditing ? (
                          <X size={16} className="text-slate-500" />
                        ) : (
                          <Palette size={16} className="text-slate-400" />
                        )}
                      </button>
                    </div>
                    {isEditing && (
                      <div className="bg-slate-50 px-4 pb-3">
                        <div className="mb-2 text-xs text-slate-500">
                          选择颜色
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {COLOR_PALETTE.map((p) => (
                            <button
                              key={p.name}
                              onClick={() => setColor(t, p.name)}
                              aria-label={p.name}
                              className={`h-8 w-8 rounded-full ${p.dot} ${
                                t.color === p.name
                                  ? "ring-2 ring-offset-2 ring-slate-400"
                                  : ""
                              }`}
                            />
                          ))}
                          <button
                            onClick={() => setColor(t, null)}
                            aria-label="清除颜色"
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-xs text-slate-500"
                          >
                            清
                          </button>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() => deleteTag(t)}
                            className="flex h-9 flex-1 items-center justify-center rounded-lg bg-red-50 text-sm font-medium text-red-600"
                          >
                            删除标签
                          </button>
                          <button
                            onClick={() => openRename(t)}
                            className="flex h-9 flex-1 items-center justify-center rounded-lg bg-[#1677FF] text-sm font-medium text-white"
                          >
                            重命名
                          </button>
                          <button
                            onClick={() => gotoTagNotes(t)}
                            aria-label="查看相关笔记"
                            className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-200 text-slate-600"
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 重命名 Modal */}
      <Modal
        title={`重命名 #${editing?.name ?? ""}`}
        open={renameOpen}
        onOk={submitRename}
        onCancel={() => setRenameOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="新名称"
          onPressEnter={submitRename}
        />
      </Modal>
    </div>
  );
}
