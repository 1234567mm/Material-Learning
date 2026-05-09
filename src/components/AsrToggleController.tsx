/**
 * ASR Toggle 控制器：应用内「边写边说」入口（窗口聚焦时才生效）。
 *
 * - 监听 window keydown：Ctrl/Cmd+Shift+Space 触发 toggle
 *   故意不走 tauri-plugin-global-shortcut，避免在用户使用其他应用时被知识库抢走
 * - 按一下切换：idle → recording → transcribing → idle
 * - 录音前抓 activeElement 锁定注入目标，避免转写期间焦点漂走丢失目标
 * - 录音中按 Esc 取消（不转写、不注入、释放麦克风）
 * - VAD：连续静音 1500ms 自动停录，与 MicButton 同款阈值
 * - 注入策略：input/textarea 走 native setter 触发 React onChange；
 *   contenteditable 优先 execCommand("insertText")，失败回落到 Selection API
 * - 无有效焦点目标时 fallback：dispatch window CustomEvent("asr:open_capture")
 *   AppLayout 监听后打开 QuickCaptureAsrModal
 *
 * 与 MicButton 的关系：复用同一套录音/转写/VAD 工具链，但作为单例挂在 AppLayout
 * 顶层、跨页面常驻。MicButton 仍然嵌在各输入框旁边给鼠标用户用。
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { App as AntdApp } from "antd";
import { Mic, Loader2 } from "lucide-react";
import { asrApi } from "@/lib/api";
import { useAudioLevel } from "@/hooks/useAudioLevel";
import { useSilenceAutoStop } from "@/hooks/useSilenceAutoStop";
import { useAsrStore } from "@/store/asr";

type Status = "idle" | "recording" | "transcribing";

export function AsrToggleController() {
  const { message } = AntdApp.useApp();
  const [status, setStatus] = useState<Status>("idle");
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const setGlobalAsrPhase = useAsrStore((s) => s.setGlobalAsrPhase);
  const setGlobalAsrLevel = useAsrStore((s) => s.setGlobalAsrLevel);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // 锁定快捷键按下瞬间的焦点元素，避免转写过程中用户切走焦点导致注入到错地方
  const targetRef = useRef<Element | null>(null);
  // 取消标记：Esc 按下时置 true，handleStop 检测到则跳过转写 + 注入
  const cancelledRef = useRef<boolean>(false);

  const { level } = useAudioLevel(activeStream, status === "recording", 3);
  useSilenceAutoStop(level, status === "recording", () => stopRecording());

  // 用 ref 持有 status，避免 toggle handler 闭包过期（listen 只注册一次）
  const statusRef = useRef<Status>(status);
  statusRef.current = status;

  // 把内部 status / level 同步到全局 store，让所有 MicButton 实例镜像显示「录音中」
  useEffect(() => {
    setGlobalAsrPhase(status);
  }, [status, setGlobalAsrPhase]);
  useEffect(() => {
    if (status === "recording") setGlobalAsrLevel(level);
  }, [level, status, setGlobalAsrLevel]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      message.error("当前 WebView 不支持录音");
      return;
    }
    // 启动前先抓焦点目标。无有效目标 → fallback 打开 QuickCaptureAsrModal
    const focused = document.activeElement;
    if (!isInjectableTarget(focused)) {
      window.dispatchEvent(new CustomEvent("asr:open_capture"));
      return;
    }

    // ASR 配置校验：未启用直接提示
    try {
      const cfg = await asrApi.getConfig();
      if (!cfg.enabled || !cfg.apiKey.trim()) {
        message.warning("语音识别未启用，请先在设置页配置 API Key");
        return;
      }
    } catch {
      message.error("无法读取 ASR 配置");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setActiveStream(stream);
      chunksRef.current = [];
      cancelledRef.current = false;
      targetRef.current = focused;
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = handleStop;
      recorderRef.current = recorder;
      recorder.start();
      setStatus("recording");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        message.error("麦克风权限被拒绝，请在系统设置中允许");
      } else {
        message.error(`无法开始录音: ${msg}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  function stopRecording() {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActiveStream(null);
    setStatus(cancelledRef.current ? "idle" : "transcribing");
  }

  async function handleStop() {
    const blob = new Blob(chunksRef.current, {
      type: recorderRef.current?.mimeType || "audio/webm",
    });
    chunksRef.current = [];

    // Esc 取消路径：丢弃录音不转写
    if (cancelledRef.current) {
      cancelledRef.current = false;
      targetRef.current = null;
      setStatus("idle");
      return;
    }

    if (blob.size === 0) {
      message.warning("没有录到声音");
      setStatus("idle");
      return;
    }
    try {
      const audioBase64 = await blobToBase64(blob);
      const result = await asrApi.transcribe({
        audioBase64,
        mime: blob.type || "audio/webm",
        language: "auto",
      });
      const text = (result.text ?? "").trim();
      if (!text) {
        message.warning("未识别到内容，请说话清晰一些");
      } else {
        const ok = injectText(targetRef.current, text);
        if (!ok) {
          // 目标已失效（DOM 卸载 / 失焦）→ fallback 打开 Modal 让用户看到结果
          window.dispatchEvent(new CustomEvent("asr:open_capture"));
          message.info(`已识别：${text.slice(0, 30)}${text.length > 30 ? "…" : ""}`);
        }
      }
    } catch (e) {
      message.error(`识别失败: ${e}`);
    } finally {
      targetRef.current = null;
      setStatus("idle");
    }
  }

  // toggle 事件：按一下切换状态。transcribing 中忽略避免重入
  const handleToggle = useCallback(() => {
    if (statusRef.current === "idle") {
      void startRecording();
    } else if (statusRef.current === "recording") {
      stopRecording();
    }
    // transcribing：在转写中再按一次没意义，直接吞掉
  }, [startRecording]);

  // 监听窗口内 keydown：Ctrl/Cmd+Shift+Space → toggle。
  // capture 阶段拦截，确保比 antd / TipTap 的内部处理更早跑（编辑器有时会吞按键）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isToggleAccel =
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.code === "Space" || e.key === " ");
      if (!isToggleAccel) return;
      e.preventDefault();
      e.stopPropagation();
      handleToggle();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [handleToggle]);

  // 录音中按 Esc 取消：在 capture 阶段拦截，确保比 antd Modal / Drawer 的 Esc 早跑
  useEffect(() => {
    if (status !== "recording") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelledRef.current = true;
        stopRecording();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [status]);

  // 卸载时强制释放麦克风（路由切换 / 应用关闭路径）
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (status === "idle") return null;

  return <StatusToast status={status} level={level} />;
}

/** 顶部居中的浮层提示，告诉用户当前在录音/识别中 */
function StatusToast({ status, level }: { status: Status; level: number }) {
  const isRecording = status === "recording";
  return (
    <div
      style={{
        position: "fixed",
        top: 60,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2000,
        padding: "8px 16px",
        borderRadius: 999,
        background: isRecording ? "rgba(255, 77, 79, 0.95)" : "rgba(24, 144, 255, 0.95)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        fontWeight: 500,
        boxShadow: isRecording
          ? `0 0 0 ${Math.round(level * 6)}px rgba(255, 77, 79, ${0.15 + level * 0.25}), 0 4px 12px rgba(0,0,0,0.15)`
          : "0 4px 12px rgba(0,0,0,0.15)",
        transition: "box-shadow 80ms ease-out",
        pointerEvents: "none",
        userSelect: "none",
      }}
      aria-live="polite"
    >
      {isRecording ? <Mic size={14} /> : <Loader2 size={14} className="animate-spin" />}
      <span>
        {isRecording ? "正在录音… 再按一次结束 / Esc 取消" : "正在识别…"}
      </span>
    </div>
  );
}

// ─── 注入相关 ────────────────────────────────────────

function isInjectableTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    // 排除 button/checkbox 等非文本输入
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "url", "tel", "email", "password", "number"].includes(t);
  }
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}

/**
 * 把识别出的文字注入到锁定目标。
 * - input/textarea：用原生 value setter 触发 React 受控组件 onChange
 * - contenteditable：优先 execCommand("insertText")（TipTap/ProseMirror 兼容），
 *   失败时回落到 Selection API 手动插节点
 */
function injectText(target: Element | null, text: string): boolean {
  if (!target) return false;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (!target.isConnected) return false;
    target.focus();
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const before = target.value.slice(0, start);
    const after = target.value.slice(end);
    const proto =
      target instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!setter) return false;
    setter.call(target, before + text + after);
    const newPos = start + text.length;
    target.setSelectionRange(newPos, newPos);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    if (!target.isConnected) return false;
    target.focus();
    try {
      const ok = document.execCommand("insertText", false, text);
      if (ok) return true;
    } catch {
      // ignore，落到 Selection API
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      target.appendChild(document.createTextNode(text));
      return true;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return true;
  }

  return false;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader 失败"));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.readAsDataURL(blob);
  });
}
