/**
 * Tiptap Video 节点（带稳定 ID + 自定义 NodeView，支持时间戳跳转）
 *
 * 设计要点：
 * - 块级 atom 节点，渲染原生 `<video controls preload="metadata">`
 * - 加 attrs.id：8 位短 ID，给 VideoTimestamp 节点引用稳定锚点用
 *   （src 路径不能当 ID：同一视频多次插入会撞，路径变更会失联）
 * - 加 attrs.label：用户可改的视频显示名（默认空 → NodeView 显示「视频 N」自动编号）
 * - NodeView：顶部条带「视频名 / 改名 / 📍 加时间戳」按钮 + 原生 video 元素
 * - 序列化为 `<video src="..." controls data-video-id data-video-label>`，
 *   依赖 tiptap-markdown `html: true` 透传；老 video 节点解析时 id 缺失
 *   → onCreate 钩子里 backfill（见 TiptapEditor.tsx）
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { VideoNodeView } from "./VideoNodeView";

export interface VideoOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: {
      setVideo: (options: { src: string; poster?: string }) => ReturnType;
    };
  }
}

/** 8 位短 ID（base36），冲突概率 ~1/2.8e12，对单笔记内的视频数量足够 */
export function generateVideoId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const Video = Node.create<VideoOptions>({
  name: "video",
  group: "block",
  draggable: true,
  selectable: true,
  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {
        class: "tiptap-video",
        controls: "true",
        preload: "metadata",
      },
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => {
          const direct = (el as HTMLElement).getAttribute("src");
          if (direct) return direct;
          const source = (el as HTMLElement).querySelector("source");
          return source?.getAttribute("src") ?? null;
        },
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src as string } : {}),
      },
      poster: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("poster"),
        renderHTML: (attrs) =>
          attrs.poster ? { poster: attrs.poster as string } : {},
      },
      controls: {
        default: true,
        parseHTML: (el) => (el as HTMLElement).hasAttribute("controls"),
        renderHTML: (attrs) =>
          attrs.controls === false ? {} : { controls: "true" },
      },
      /** 稳定 ID，给时间戳锚点用。新插入时由调用方生成；老节点 onCreate 时 backfill */
      id: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-video-id"),
        renderHTML: (attrs) =>
          attrs.id ? { "data-video-id": attrs.id as string } : {},
      },
      /** 用户自定义的视频显示名（如「教程」「剪辑1」） */
      label: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-video-label"),
        renderHTML: (attrs) =>
          attrs.label
            ? { "data-video-label": attrs.label as string }
            : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "video",
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const src =
            node.getAttribute("src") ??
            node.querySelector("source")?.getAttribute("src") ??
            null;
          if (!src) return false;
          return { src };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "video",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoNodeView);
  },

  addCommands() {
    return {
      setVideo:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              src: options.src,
              poster: options.poster ?? null,
              id: generateVideoId(),
              label: null,
            },
          }),
    };
  },
});
