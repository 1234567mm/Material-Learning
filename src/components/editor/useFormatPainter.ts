import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";
import type { Editor } from "@tiptap/react";

export type FormatPainterMode = "idle" | "once" | "persist";

/**
 * 格式刷只搬运"格式相关" marks，不动 link / annotation 这类语义 mark。
 * textStyle 覆盖了字体颜色 (color) 与字号 (fontSize)。
 */
const FORMAT_MARK_NAMES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "highlight",
  "code",
  "superscript",
  "subscript",
  "textStyle",
];

/** 同一个 message key，避免 click + dblclick 序列叠出两条提示 */
const MSG_KEY = "format-painter";

interface PickedMark {
  name: string;
  attrs: Record<string, unknown>;
}

/**
 * 格式刷 Hook（仿 Office 行为）：
 * - 单击按钮：吸取当前光标/选区处的格式 → 下次选中目标文本应用一次后自动退出（once 模式）
 * - 双击按钮：进入持续模式，每次选中文本都会应用，直到 Esc 或再次点击退出（persist 模式）
 * - 应用时只清除/设置白名单内的 marks，避免误清 link
 *
 * UX 反馈：
 * - 激活时 toast 提示用户下一步该做什么（"请选中要应用的文本"）
 * - 编辑器内鼠标光标变成 copy（视觉提示当前在格式刷状态）
 * - 空格式吸取时 warning（用户不知所以的核心场景：在普通文本上点格式刷）
 *
 * Why 双击实现依赖浏览器 click + dblclick 同时触发的天然顺序：
 *   click1 → idle 切到 once，click2 → once 被 cancel 回 idle，dblclick → 重新 pick 进 persist。
 *   终态 persist 正确，中间一帧抖动肉眼不可见，避免 setTimeout 防抖带来的延迟感。
 */
export function useFormatPainter(editor: Editor | null) {
  const [mode, setMode] = useState<FormatPainterMode>("idle");
  const pickedRef = useRef<PickedMark[]>([]);

  /**
   * 吸取格式 mark，返回是否拿到了非空 marks。
   *
   * Why 不用 `$from.marks()`：ProseMirror 的 `$from.marks()` 返回的是
   * "在该位置插入新内容时应继承的 marks"，在 mark 边界处会按规则取左/右，
   * 导致典型场景"普通文字**加粗**"中选中"加粗"时拿到空数组（取了左侧的普通）。
   * 正确做法是遍历选区内第一个真实文本节点的 marks（Atlassian / Quill / Slate 都是这套）。
   */
  const pick = useCallback((): { ok: boolean; empty: boolean } => {
    if (!editor) return { ok: false, empty: true };
    const { state } = editor;
    const { from, to, $from } = state.selection;

    let marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[] = [];

    if (from === to) {
      // 空选区：storedMarks 优先（最近一次格式按钮按下后会暂存在这里）
      marks = state.storedMarks ?? $from.marks();
    } else {
      // 非空选区：找选区内第一个有 marks 的文本节点
      state.doc.nodesBetween(from, to, (node) => {
        if (marks.length > 0) return false;
        if (node.isText && node.marks.length > 0) {
          marks = node.marks;
          return false;
        }
        return true;
      });
      // 选区内全是普通文字时，fallback 到 $from.marks()（兜底，通常也是空）
      if (marks.length === 0) marks = $from.marks();
    }

    const picked = marks
      .filter((m) => FORMAT_MARK_NAMES.includes(m.type.name))
      .map((m) => ({ name: m.type.name, attrs: { ...m.attrs } }));

    pickedRef.current = picked;
    return { ok: true, empty: picked.length === 0 };
  }, [editor]);

  /**
   * 把 pickedRef.current 应用到当前选区。
   *
   * Why 不用 chain().unsetMark().setMark()：TipTap 的 unsetMark 在某些版本下可能扩展到
   * 整个 mark 范围（不止选区内），会误清选区外的格式。直接 dispatch ProseMirror 事务
   * 用 removeMark/addMark 限定 [from, to] 范围最稳。
   */
  const apply = useCallback((): boolean => {
    if (!editor) return false;
    const { state, view } = editor;
    const { from, to } = state.selection;
    if (from === to) return false;

    let tr = state.tr;

    // 1. 移除选区内的所有"格式 mark"（白名单内才动，link/annotation 不动）
    for (const name of FORMAT_MARK_NAMES) {
      const markType = state.schema.marks[name];
      if (markType) tr = tr.removeMark(from, to, markType);
    }

    // 2. 把吸取的 marks 叠加到选区
    for (const m of pickedRef.current) {
      const markType = state.schema.marks[m.name];
      if (!markType) continue;
      const mark = markType.create(m.attrs);
      tr = tr.addMark(from, to, mark);
    }

    if (tr.docChanged || tr.steps.length > 0) {
      view.dispatch(tr);
    }
    view.focus();
    return true;
  }, [editor]);

  const cancel = useCallback(() => {
    setMode("idle");
    pickedRef.current = [];
  }, []);

  const pickOnce = useCallback(() => {
    if (mode !== "idle") {
      cancel();
      message.destroy(MSG_KEY);
      return;
    }
    const r = pick();
    if (!r.ok) return;
    if (r.empty) {
      message.warning({
        content: "当前位置没有可吸取的格式（先把光标放到加粗 / 有颜色 / 改过字号的文字里）",
        key: MSG_KEY,
        duration: 3,
      });
      return;
    }
    setMode("once");
    message.info({
      content: "已吸取格式 — 现在选中要应用的文本（双击格式刷可连续应用）",
      key: MSG_KEY,
      duration: 3,
    });
  }, [mode, pick, cancel]);

  const pickPersist = useCallback(() => {
    const r = pick();
    if (!r.ok) return;
    if (r.empty) {
      message.warning({
        content: "当前位置没有可吸取的格式（先把光标放到加粗 / 有颜色 / 改过字号的文字里）",
        key: MSG_KEY,
        duration: 3,
      });
      return;
    }
    setMode("persist");
    message.info({
      content: "持续格式刷已开启 — 连续选中文本即可应用，按 Esc 或再次单击退出",
      key: MSG_KEY,
      duration: 4,
    });
  }, [pick]);

  // 等用户"完成"一次选区操作后再应用 — 这是关键的 bug 修复点：
  // 之前用 editor.on('selectionUpdate') 会在用户拖动选择中途反复触发，
  // 导致拖到第一个字符时就 apply + cancel 退出 once 模式，后续字符没刷上。
  // 改为监听编辑器 DOM 的 mouseup（鼠标拖选完成）+ keyup（Shift+方向键完成）
  useEffect(() => {
    if (!editor || editor.isDestroyed || mode === "idle") return;
    const dom = editor.view.dom as HTMLElement;

    const tryApply = () => {
      const { from, to } = editor.state.selection;
      if (from === to) return;
      apply();
      if (mode === "once") cancel();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // 仅在选区扩展类按键释放时应用，避免普通键入触发
      const isSelExtend =
        e.shiftKey ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a");
      if (isSelExtend) tryApply();
    };

    dom.addEventListener("mouseup", tryApply);
    dom.addEventListener("keyup", onKeyUp);
    return () => {
      dom.removeEventListener("mouseup", tryApply);
      dom.removeEventListener("keyup", onKeyUp);
    };
  }, [editor, mode, apply, cancel]);

  // Esc 退出
  useEffect(() => {
    if (mode === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancel();
        message.destroy(MSG_KEY);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, cancel]);

  // 编辑器内鼠标光标提示当前在格式刷状态
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement;
    dom.style.cursor = mode === "idle" ? "" : "copy";
    return () => {
      dom.style.cursor = "";
    };
  }, [editor, mode]);

  return { mode, pickOnce, pickPersist, cancel };
}
