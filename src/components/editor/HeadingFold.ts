/**
 * HeadingFold —— 按 H1/H2/H3 折叠笔记内容
 *
 * 业界主流（Obsidian / 飞书）的"按标题折叠"：
 * - 标题左侧 hover 出现 chevron，点击折叠到下一同级或更高级标题
 * - 折叠态是"视图偏好"，不写进笔记内容（导出 / 同步零影响）
 * - 折叠 anchor 用 slug + occurrence index，标题改字也能尽量保留
 *
 * 实现要点：
 * - 走 ProseMirror Plugin + Decoration（widget 渲染 chevron，inline class 隐藏管辖范围）
 * - folded 集合由外部（Zustand）维护，extension 通过 options.getFolded() 读取
 * - 文档变化或外部 folded 集合变化 → dispatch setMeta(KEY, "refresh") 触发重算
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { collectHeadings, rangeOfFolded, type HeadingHit } from "./headingAnchor";

export interface HeadingFoldOptions {
  /** 取当前已折叠的 anchor 集合（外部 zustand 提供） */
  getFolded: () => Set<string>;
  /** 用户点击 chevron 时调用：切换该 anchor 的折叠态 */
  onToggle: (anchor: string) => void;
  /** 最大处理到第几级 heading（默认 3，即 H1–H3） */
  maxLevel?: number;
}

const HEADING_FOLD_KEY = new PluginKey<DecorationSet>("kb-heading-fold");

/** 外部 dispatch 这条 meta 即可让 plugin 重算装饰（folded 集合变化时使用） */
export const HEADING_FOLD_REFRESH = "refresh";

function buildDecorations(
  doc: import("@tiptap/pm/model").Node,
  folded: Set<string>,
  maxLevel: number,
  onToggle: (anchor: string) => void,
): { headings: HeadingHit[]; deco: DecorationSet } {
  const headings = collectHeadings(doc, maxLevel);
  const decorations: Decoration[] = [];

  // 1) 给每个 heading 前面挂一个 chevron widget
  for (const h of headings) {
    const isFolded = folded.has(h.anchor);
    const anchor = h.anchor;
    decorations.push(
      Decoration.widget(
        h.pos + 1, // 跳进 heading 节点内部，让 chevron 跟标题文字同 baseline
        () => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `kb-heading-fold-chevron ${isFolded ? "is-folded" : ""}`;
          btn.contentEditable = "false";
          btn.setAttribute("data-anchor", anchor);
          btn.setAttribute("aria-label", isFolded ? "展开" : "折叠");
          btn.title = isFolded ? "展开本节" : "折叠本节";
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
          btn.addEventListener("mousedown", (e) => {
            // 阻止 ProseMirror 把这次点击当成 selection 设置
            e.preventDefault();
            e.stopPropagation();
            onToggle(anchor);
          });
          return btn;
        },
        { side: -1, ignoreSelection: true, key: `chev-${anchor}-${isFolded ? "1" : "0"}` },
      ),
    );
  }

  // 2) 折叠态的"管辖范围"：直接遍历 doc 的 top-level 子节点，落在范围内的加 node 装饰
  // node decoration 直接给 block DOM 加 class，配合 CSS display:none 完整隐藏整段，
  // 包含段落 / 列表 / 表格 / 代码块 / 图片块等
  const docSize = doc.content.size;
  for (const anchor of folded) {
    const range = rangeOfFolded(headings, anchor, docSize);
    if (!range) continue;
    if (range.from >= range.to) continue;
    let cursor = 0;
    doc.forEach((child, offset) => {
      const childPos = offset;
      const childEnd = childPos + child.nodeSize;
      cursor = childEnd;
      if (childPos >= range.from && childEnd <= range.to) {
        decorations.push(
          Decoration.node(childPos, childEnd, {
            class: "kb-heading-folded",
          }),
        );
      }
    });
    void cursor;
  }

  return { headings, deco: DecorationSet.create(doc, decorations) };
}

export const HeadingFold = Extension.create<HeadingFoldOptions>({
  name: "kbHeadingFold",

  addOptions() {
    return {
      getFolded: () => new Set<string>(),
      onToggle: () => {},
      maxLevel: 3,
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;

    return [
      new Plugin<DecorationSet>({
        key: HEADING_FOLD_KEY,
        state: {
          init: (_cfg, { doc }) => {
            const { deco } = buildDecorations(
              doc,
              opts.getFolded(),
              opts.maxLevel ?? 3,
              opts.onToggle,
            );
            return deco;
          },
          apply(tr, oldSet) {
            // 文档变化或外部主动 refresh 时重算
            const refresh = tr.getMeta(HEADING_FOLD_KEY);
            if (refresh === HEADING_FOLD_REFRESH || tr.docChanged) {
              const { deco } = buildDecorations(
                tr.doc,
                opts.getFolded(),
                opts.maxLevel ?? 3,
                opts.onToggle,
              );
              return deco;
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return HEADING_FOLD_KEY.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export { HEADING_FOLD_KEY };
