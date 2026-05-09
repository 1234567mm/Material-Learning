import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    annotation: {
      /** 在当前选区设置（或更新）批注 */
      setAnnotation: (comment: string) => ReturnType;
      /** 移除当前选区的批注 */
      unsetAnnotation: () => ReturnType;
    };
  }
}

/**
 * Tiptap inline mark：批注 / 注释（MVP 档实现）。
 *
 * 设计：
 * - 批注内容直接存在 mark 属性 data-comment 里，跟笔记 content JSON 一起持久化
 * - 不依赖独立批注表 → 备份/导出/同步都自然带着批注走（GFM 脚注 / HTML span / Word 批注）
 * - 鼠标悬停由 HTML title 自带 tooltip，零成本
 *
 * 升级路径：以后想做"跨笔记批注聚合"时，写脚本扫所有 note.content 把 data-comment
 * 抽到独立表即可，不丢数据。
 *
 * 快捷键：Ctrl/Cmd + Alt + M
 *   通过 CustomEvent("kb-annotation-shortcut") 广播，由 EditorToolbar 挂的全局
 *   监听器接管并弹出输入 Modal。这样 mark 本身不依赖 React 上下文。
 */
export const Annotation = Mark.create({
  name: "annotation",

  // inclusive=false：光标停在批注末尾时再输入字符不会自动延续批注，
  // 与高亮(highlight)的体感一致，避免误标。
  inclusive: false,

  addAttributes() {
    return {
      comment: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-comment") ?? "",
        renderHTML: (attrs) => {
          if (!attrs.comment) return {};
          return {
            "data-comment": attrs.comment,
            // title 让浏览器原生 tooltip 起作用，零成本悬停查看
            title: attrs.comment,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "kb-annotation" }),
      0,
    ];
  },

  addCommands() {
    return {
      setAnnotation:
        (comment: string) =>
        ({ commands }) => {
          const c = (comment ?? "").trim();
          if (!c) return false;
          return commands.setMark(this.name, { comment: c });
        },
      unsetAnnotation:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-m": () => {
        // 广播给 React 侧，让 EditorToolbar 弹 Modal 输入批注内容。
        // mark 本身不能弹 antd Modal（不在 React 树里），用 CustomEvent 解耦。
        document.dispatchEvent(new CustomEvent("kb-annotation-shortcut"));
        return true;
      },
    };
  },

  /**
   * tiptap-markdown 序列化 hook —— 把批注 mark 输出成 inline HTML：
   *   <span data-comment="...">原文字</span>
   *
   * 为什么不用脚注 [^1]：脚注是双向锚定（文中引用 + 文末定义），
   * 单 mark 序列化没法生成"文末定义"那块；inline HTML 是 GFM 合法语法，
   * obsidian / typora / vscode preview 都能渲染原文字 + 鼠标悬停 title 提示。
   *
   * 反向解析无需另写：parseHTML 已声明 `span[data-comment]`，
   * markdown-it 把 inline HTML 透传给 prosemirror，自动还原回 mark。
   */
  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state: unknown, mark: { attrs: { comment?: string } }) {
            const c = String(mark.attrs.comment ?? "")
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            return `<span data-comment="${c}">`;
          },
          close: "</span>",
          expelEnclosingWhitespace: true,
        },
        parse: {
          // markdown-it 把 <span> 作为 html_inline 透传，prosemirror 走 parseHTML 自动认识
        },
      },
    };
  },
});
