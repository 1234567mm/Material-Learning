/**
 * Callout / 提示框节点（Notion 风：💡 / ⚠️ / ❌ / ℹ️ 四种类型）
 *
 * 块级节点，含 emoji 图标 + 多行内容（block content+）。
 *
 * Markdown 兼容：渲染为 `<div data-callout="info">...</div>` HTML，依赖
 * tiptap-markdown `html: true` 透传；外部 md 工具看到一个 div 块（无样式但
 * 内容保留），导回应用时 parseHTML 重新识别为 callout 节点。
 *
 * 类型切换通过 NodeView 顶部的下拉，不需要重新插入节点。
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CalloutNodeView } from "./CalloutNodeView";

export type CalloutType = "info" | "tip" | "warning" | "danger";

export const CALLOUT_PRESETS: Record<
  CalloutType,
  { emoji: string; label: string }
> = {
  info: { emoji: "ℹ️", label: "信息" },
  tip: { emoji: "💡", label: "提示" },
  warning: { emoji: "⚠️", label: "警告" },
  danger: { emoji: "❌", label: "危险" },
};

export interface CalloutOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (type?: CalloutType) => ReturnType;
      toggleCallout: (type?: CalloutType) => ReturnType;
    };
  }
}

export const Callout = Node.create<CalloutOptions>({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return {
      HTMLAttributes: { class: "tiptap-callout" },
    };
  },

  addAttributes() {
    return {
      type: {
        default: "info" as CalloutType,
        parseHTML: (el) => {
          const t = (el as HTMLElement).getAttribute("data-callout") || "info";
          if (["info", "tip", "warning", "danger"].includes(t)) return t;
          return "info";
        },
        renderHTML: (attrs) => ({
          "data-callout": attrs.type as string,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-callout]",
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-callout": String(node.attrs.type ?? "info"),
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },

  addCommands() {
    return {
      setCallout:
        (type?: CalloutType) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type: type ?? "info" }),
      toggleCallout:
        (type?: CalloutType) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { type: type ?? "info" }),
    };
  },
});
