import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  CloudUpload,
  CloudDownload,
  Plus,
  Plug,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Pencil,
  Share2,
  Download,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportWebDavBackend, type Envelope } from "@/lib/configShare";
import { Modal, Form, Input, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { syncV1Api } from "@/lib/api";
import { useAppStore } from "@/store";
import type {
  SyncBackend,
  SyncV1ProgressEvent,
  WebDavConfig,
} from "@/types";
import { relativeTime } from "@/lib/utils";

/**
 * 移动端云端同步管理（设计：基于 11-sync.html，简化为只支持 WebDAV）
 *
 * 路由 /sync —— 移动端独立路由（不在 LayoutSwitch 子路由下）
 *
 * 功能：
 * - 列出所有 V1 同步后端 + 上次推送/拉取时间 + 启用状态
 * - 每个后端单独的 推送 / 拉取 / 测试 / 编辑 / 删除 操作
 * - 新增 / 编辑 backend：仅支持 WebDAV（移动端 S3 已被 cfg gate 掉）
 *
 * 桌面端零影响：MobileSync 只通过 /sync 路由触达，且桌面端入口在 settings/SyncSettings 里走另一套。
 */

interface WebDavForm {
  name: string;
  url: string;
  username: string;
  password: string;
}

export function MobileSync() {
  const navigate = useNavigate();
  const [backends, setBackends] = useState<SyncBackend[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [progress, setProgress] = useState<SyncV1ProgressEvent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm<WebDavForm>();
  // 配置分享 / 导入
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // 监听后端推/拉进度事件，渲染到对应 backend 卡片下
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      const fn = await listen<SyncV1ProgressEvent>("sync_v1:progress", (e) => {
        setProgress(e.payload);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await syncV1Api.listBackends();
      setBackends(list);
    } catch (e) {
      console.error("[MobileSync] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      name: "WebDAV",
      url: "https://",
      username: "",
      password: "",
    });
    setEditorOpen(true);
  }

  function openEdit(b: SyncBackend) {
    let cfg: WebDavConfig = { url: "", username: "" };
    try {
      cfg = JSON.parse(b.configJson) as WebDavConfig;
    } catch {
      // 静默失败：表单显示空值
    }
    setEditingId(b.id);
    form.setFieldsValue({
      name: b.name,
      url: cfg.url ?? "",
      username: cfg.username ?? "",
      password: "",
    });
    setEditorOpen(true);
  }

  async function submitForm() {
    try {
      const values = await form.validateFields();
      const cfg: WebDavConfig = {
        url: values.url.trim(),
        username: values.username,
        ...(values.password ? { password: values.password } : {}),
      };
      const input = {
        kind: "webdav" as const,
        name: values.name.trim(),
        configJson: JSON.stringify(cfg),
      };
      if (editingId !== null) {
        await syncV1Api.updateBackend(editingId, input);
        message.success("已更新");
      } else {
        await syncV1Api.createBackend(input);
        message.success("已添加");
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function testConn(id: number) {
    setBusyId(id);
    try {
      await syncV1Api.testConnection(id);
      message.success("连接正常");
    } catch (e) {
      message.error(`连接失败: ${e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function push(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.push(id);
      message.success(
        `推送完成：上传 ${r.uploaded} · 删除 ${r.deletedRemote} · 跳过 ${r.skipped}` +
          (r.errors.length > 0 ? ` · ${r.errors.length} 错误` : ""),
      );
      await load();
    } catch (e) {
      message.error(`推送失败: ${e}`);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  async function pull(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.pull(id);
      message.success(
        `拉取完成：下载 ${r.downloaded} · 删除本地 ${r.deletedLocal}` +
          (r.conflicts > 0 ? ` · ${r.conflicts} 冲突` : ""),
      );
      useAppStore.getState().bumpNotesRefresh();
      await load();
    } catch (e) {
      message.error(`拉取失败: ${e}`);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  function remove(b: SyncBackend) {
    Modal.confirm({
      title: `删除「${b.name}」？`,
      content: "本地的同步配置将被清除（远端数据不动）。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await syncV1Api.deleteBackend(b.id);
          message.success("已删除");
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2 shrink-0">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <h1 className="text-base font-semibold">云端同步</h1>
        <div className="flex">
          <button
            onClick={() => setImportOpen(true)}
            aria-label="导入配置"
            className="flex h-10 w-10 items-center justify-center text-slate-600"
          >
            <Download size={20} />
          </button>
          <button
            onClick={openAdd}
            aria-label="新增"
            className="flex h-10 w-10 items-center justify-center text-[#1677FF]"
          >
            <Plus size={22} />
          </button>
        </div>
      </header>

      {/* 信息横幅 */}
      <div className="flex items-start gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2.5 shrink-0">
        <CloudUpload size={16} className="mt-0.5 shrink-0 text-blue-600" />
        <p className="text-xs leading-relaxed text-blue-800">
          移动端只支持手动同步，建议每次记录后手动 ↑推送，需要时再 ↓拉取。
          仅支持 WebDAV（移动端不支持 S3）。
        </p>
      </div>

      {/* 列表 */}
      <main className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-sm text-slate-400 py-8">加载中…</div>
        ) : backends.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <CloudUpload size={40} className="text-slate-300" />
            <span className="text-sm">还没有配置同步</span>
            <span className="text-xs text-slate-300">点右上 + 添加 WebDAV</span>
          </div>
        ) : (
          <div className="space-y-3">
            {backends.map((b) => (
              <BackendCard
                key={b.id}
                backend={b}
                busy={busyId === b.id}
                progress={
                  busyId === b.id && progress?.backendId === b.id
                    ? progress
                    : null
                }
                onPush={() => push(b.id)}
                onPull={() => pull(b.id)}
                onTest={() => testConn(b.id)}
                onEdit={() => openEdit(b)}
                onDelete={() => remove(b)}
                onShare={() => setShareEnv(exportWebDavBackend(b))}
              />
            ))}
          </div>
        )}
      </main>

      {/* 添加 / 编辑 Modal */}
      <Modal
        title={editingId === null ? "添加 WebDAV 同步" : "编辑同步"}
        open={editorOpen}
        onOk={submitForm}
        onCancel={() => setEditorOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="如：坚果云 / Nextcloud" />
          </Form.Item>
          <Form.Item
            name="url"
            label="WebDAV 地址"
            rules={[{ required: true, message: "请输入完整 URL" }]}
          >
            <Input placeholder="https://dav.jianguoyun.com/dav/knowledge_base" />
          </Form.Item>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input placeholder="账号 / 邮箱" />
          </Form.Item>
          <Form.Item
            name="password"
            label="应用密码"
            tooltip="坚果云需在「账户信息 → 安全选项」生成第三方应用密码"
            rules={
              editingId === null ? [{ required: true, message: "请输入密码" }] : []
            }
          >
            <Input.Password placeholder={editingId === null ? "" : "留空 = 不修改密码"} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 配置分享 */}
      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />

      {/* 配置导入 */}
      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  compute: "计算清单",
  diff: "对比远端",
  upload: "上传",
  download: "下载",
  manifest: "更新清单",
  apply: "应用本地",
  done: "完成",
};

function BackendCard({
  backend,
  busy,
  progress,
  onPush,
  onPull,
  onTest,
  onEdit,
  onDelete,
  onShare,
}: {
  backend: SyncBackend;
  busy: boolean;
  progress: SyncV1ProgressEvent | null;
  onPush: () => void;
  onPull: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const lastPush = backend.lastPushTs
    ? relativeTime(backend.lastPushTs)
    : "从未";
  const lastPull = backend.lastPullTs
    ? relativeTime(backend.lastPullTs)
    : "从未";
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50">
          <CloudUpload size={20} className="text-[#1677FF]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">
              {backend.name}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 uppercase">
              {backend.kind}
            </span>
            {backend.enabled ? (
              <CheckCircle2 size={12} className="text-green-500" />
            ) : (
              <AlertCircle size={12} className="text-slate-400" />
            )}
          </div>
          <div className="mt-1 grid grid-cols-2 text-[11px] text-slate-500">
            <span>↑ 推送 · {lastPush}</span>
            <span>↓ 拉取 · {lastPull}</span>
          </div>
        </div>
      </div>

      {/* 进度条（仅在 busy 时显示） */}
      {busy && (
        <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-blue-700">
            <span className="font-medium">
              {progress
                ? PHASE_LABELS[progress.phase] ?? progress.phase
                : "准备中…"}
            </span>
            {progress && progress.total > 0 && (
              <span>
                {progress.current} / {progress.total}
              </span>
            )}
          </div>
          {progress?.message && (
            <div className="mt-0.5 truncate text-[10px] text-blue-600/80">
              {progress.message}
            </div>
          )}
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-blue-100">
            <div
              className="h-full bg-[#1677FF] transition-all"
              style={{
                width:
                  progress && progress.total > 0
                    ? `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%`
                    : "8%",
              }}
            />
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={onPush}
          disabled={busy}
          className="flex h-10 items-center justify-center gap-1 rounded-lg bg-[#1677FF] text-sm font-medium text-white active:scale-95 transition-transform disabled:opacity-50"
        >
          <CloudUpload size={14} /> 推送
        </button>
        <button
          onClick={onPull}
          disabled={busy}
          className="flex h-10 items-center justify-center gap-1 rounded-lg bg-slate-100 text-sm font-medium text-slate-700 active:bg-slate-200 disabled:opacity-50"
        >
          <CloudDownload size={14} /> 拉取
        </button>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        <button
          onClick={onTest}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <Plug size={12} /> 测试
        </button>
        <button
          onClick={onShare}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <Share2 size={12} /> 分享
        </button>
        <button
          onClick={onEdit}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <Pencil size={12} /> 编辑
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-red-200 bg-white text-xs text-red-600 active:bg-red-50 disabled:opacity-50"
        >
          <Trash2 size={12} /> 删除
        </button>
      </div>
    </div>
  );
}
