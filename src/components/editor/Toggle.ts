/**
 * Toggle 折叠块（Notion 风 ▶ 标题 + 可折叠内容）
 *
 * 结构：toggle node 包含两个子节点
 *   - toggleSummary: 标题行（inline content，类似段落）
 *   - toggleContent: 折叠内容（block+，可包多段落/列表/嵌套 callout 等）
 *
 * 折叠状态用 attrs.open 管理；NodeView 控制 ▶ 图标和内容显隐。
 *
 * markdown 兼容：渲染为标准 HTML `<details><summary>...</summary>...</details>`
 * （tiptap-markdown html:true 透传；GFM/Obsidian 都识别原生 details 标签）。
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ToggleNodeView } from "./ToggleNodeView";

export interface ToggleOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggleBlock: {
      setToggle: () => ReturnType;
    };
  }
}

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: "summary" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["summary", mergeAttributes(HTMLAttributes), 0];
  },
});

export const ToggleContent = Node.create({
  name: "toggleContent",
  content: "block+",
  defining: true,

  parseHTML() {
    return [
      {
        tag: "div[data-toggle-content]",
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-toggle-content": "true" }),
      0,
    ];
  },
});

export const Toggle = Node.create<ToggleOptions>({
  name: "toggle",
  group: "block",
  content: "toggleSummary toggleContent",
  defining: true,

  addOptions() {
    return {
      HTMLAttributes: { class: "tiptap-toggle" },
    };
  },

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => (el as HTMLElement).hasAttribute("open"),
        renderHTML: (attrs) => (attrs.open ? { open: "true" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "details" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "details",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-open": node.attrs.open ? "true" : "false",
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleNodeView);
  },

  addCommands() {
    return {
      setToggle:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: "toggle",
            attrs: { open: true },
            content: [
              {
                type: "toggleSummary",
                content: [{ type: "text", text: "折叠标题" }],
              },
              {
                type: "toggleContent",
                content: [{ type: "paragraph" }],
              },
            ],
          }),
    };
  },

  // 三层 defining=true 让默认 Backspace 出不去，空折叠块没法删。
  // 在 summary 起点 / content 第一段起点 + 整体为空时整块删掉。
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;
        if ($from.parentOffset !== 0) return false;

        const parentName = $from.parent.type.name;
        const inSummary = parentName === "toggleSummary";
        const inParagraph = parentName === "paragraph";
        if (!inSummary && !inParagraph) return false;

        let toggleDepth = -1;
        for (let d = $from.depth - 1; d >= 0; d--) {
          if ($from.node(d).type.name === "toggle") {
            toggleDepth = d;
            break;
          }
        }
        if (toggleDepth < 0) return false;
        const toggleNode = $from.node(toggleDepth);

        // paragraph 必须是 toggleContent 的第一个直接子段
        if (inParagraph) {
          const grand = $from.node($from.depth - 1);
          if (grand.type.name !== "toggleContent") return false;
          if (grand.firstChild !== $from.parent) return false;
        }

        const summary = toggleNode.child(0);
        const content = toggleNode.child(1);
        const summaryEmpty = summary.content.size === 0;
        const contentEmpty =
          content.childCount === 1 &&
          content.firstChild?.type.name === "paragraph" &&
          content.firstChild.content.size === 0;
        if (!summaryEmpty || !contentEmpty) return false;

        const togglePos = $from.before(toggleDepth);
        return editor
          .chain()
          .focus()
          .deleteRange({ from: togglePos, to: togglePos + toggleNode.nodeSize })
          .run();
      },
    };
  },
});
