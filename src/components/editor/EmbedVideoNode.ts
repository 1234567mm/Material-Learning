/**
 * Tiptap EmbedVideo 节点 —— 嵌入第三方视频（B站 / YouTube / 腾讯视频 / 优酷）
 *
 * 设计要点：
 * - 块级 atom 节点，渲染为 `<iframe>` 包一层 NodeView 工具条
 * - attrs：
 *   - src: 真正塞进 iframe 的 embed URL（如 player.bilibili.com/...）
 *   - originalUrl: 用户输入的原始 URL（B站视频页 / YouTube watch 页等），
 *     iframe 失效时点"在浏览器打开"用，markdown 文件里也保留
 *   - provider: 平台 ID（bilibili / youtube / qq / youku / generic），用于 UI 图标和差异化样式
 * - 序列化为 `<iframe src="..." data-embed-url="..." data-embed-provider="...">`
 *   依赖 tiptap-markdown `html: true` 透传到 markdown 文件，再 parseHTML 解析回来
 * - HTML 导出（pulldown-cmark）默认透传 raw HTML 块，iframe 在导出 HTML 文件里也能播
 *
 * 与已有 VideoNode 的区别：
 *   - VideoNode 处理本地文件，<video src="kb-asset://...">
 *   - EmbedVideo 处理外链，<iframe src="https://player.../...">
 *   两者并存，markdown 序列化分别落到 <video> 和 <iframe> 标签
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { EmbedVideoNodeView } from "./EmbedVideoNodeView";
import type { EmbedProviderId } from "./embedVideoProviders";

export interface EmbedVideoOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embedVideo: {
      setEmbedVideo: (options: {
        src: string;
        originalUrl: string;
        provider: EmbedProviderId;
      }) => ReturnType;
    };
  }
}

export const EmbedVideo = Node.create<EmbedVideoOptions>({
  name: "embedVideo",
  group: "block",
  draggable: true,
  selectable: true,
  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {
        class: "tiptap-embed-video",
        // 不设 sandbox / referrerpolicy：B 站播放器要 referrer 判断来源，
        // YouTube/腾讯视频也都依赖完整能力。安全已由 CSP frame-src 白名单兜底
        // （只有列在白名单的域可被嵌入），iframe 内的脚本本身被同源策略隔离。
        allow: "fullscreen; encrypted-media; picture-in-picture; autoplay",
        loading: "lazy",
      },
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("src"),
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src as string } : {}),
      },
      /** 用户原始 URL（B站视频页等），导出/失效兜底用 */
      originalUrl: {
        default: null,
        parseHTML: (el) =>
          (el as HTMLElement).getAttribute("data-embed-url"),
        renderHTML: (attrs) =>
          attrs.originalUrl
            ? { "data-embed-url": attrs.originalUrl as string }
            : {},
      },
      /** 平台 ID：bilibili / youtube / qq / youku / generic */
      provider: {
        default: "generic",
        parseHTML: (el) =>
          (el as HTMLElement).getAttribute("data-embed-provider") || "generic",
        renderHTML: (attrs) =>
          attrs.provider
            ? { "data-embed-provider": attrs.provider as string }
            : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        // 只识别带 data-embed-url 的 iframe（避免误吞普通 iframe，比如未来可能有的图表嵌入）
        tag: "iframe[data-embed-url]",
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const src = node.getAttribute("src");
          if (!src) return false;
          return {
            src,
            originalUrl: node.getAttribute("data-embed-url"),
            provider: node.getAttribute("data-embed-provider") || "generic",
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "iframe",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        // iframe 是自闭合标签但 ProseMirror 需要内容数组形式，
        // 这里给 frameborder=0 + 默认尺寸（CSS 再覆盖到 16:9 响应式）
        frameborder: "0",
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedVideoNodeView);
  },

  addCommands() {
    return {
      setEmbedVideo:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              src: options.src,
              originalUrl: options.originalUrl,
              provider: options.provider,
            },
          }),
    };
  },
});
