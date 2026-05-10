/**
 * 编辑器查找替换 —— 轻量自实现 Tiptap 扩展（Tiptap 3 兼容）
 *
 * 设计：
 * - ProseMirror Plugin 维护 query/options/results/current；DecorationSet 高亮所有命中
 *   + 当前命中加一层"active"
 * - 通过 commands API 暴露 setSearchTerm / gotoNext / gotoPrev / replaceCurrent /
 *   replaceAll / clearSearch；UI 浮条直接 editor.commands.xxx 触发
 * - 文档变更时重算结果（replace 后下一个匹配位置自然 shift）
 * - 不支持正则，故意保持简单——99% 写作场景普通文本足够
 *
 * CSS 类名（在 global.css 已或将定义）：
 *   .kb-search-match：所有命中（背景色低亮）
 *   .kb-search-active：当前命中（更醒目）
 */
import { Extension, type CommandProps } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

interface SearchPluginState {
  query: string;
  options: SearchOptions;
  /** 所有命中的 [from, to)；按文档顺序 */
  results: Array<{ from: number; to: number }>;
  /** 当前命中的索引；-1 表示未选中（搜索为空 / 无命中） */
  current: number;
  decorations: DecorationSet;
}

interface SearchMeta {
  type: "set" | "next" | "prev" | "clear" | "setCurrent";
  query?: string;
  options?: Partial<SearchOptions>;
  index?: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    searchAndReplace: {
      /** 设置搜索词（空串清空高亮）；同时可选地更新选项 */
      setSearchTerm: (
        query: string,
        options?: Partial<SearchOptions>,
      ) => ReturnType;
      /** 跳到下一个命中（空查询时无效） */
      searchNext: () => ReturnType;
      /** 跳到上一个命中 */
      searchPrev: () => ReturnType;
      /** 替换当前选中的命中；当前无选中则等价于 next */
      replaceCurrent: (replacement: string) => ReturnType;
      /** 全部替换；返回值不重要，但内部会把所有命中替换 */
      replaceAll: (replacement: string) => ReturnType;
      /** 清空查询 + 关闭高亮 */
      clearSearch: () => ReturnType;
    };
  }
}

const pluginKey = new PluginKey<SearchPluginState>("searchAndReplace");

/** 转义正则元字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在整篇文档里找所有命中 */
function findMatches(
  doc: ProseMirrorNode,
  query: string,
  options: SearchOptions,
): Array<{ from: number; to: number }> {
  if (!query) return [];

  let pattern = escapeRegExp(query);
  if (options.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return [];
  }

  const matches: Array<{ from: number; to: number }> = [];
  // 走每个 textblock，独立匹配（避免跨段落假命中）
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, "\u0000", "\u0000");
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      const from = pos + 1 + m.index;
      const to = from + m[0].length;
      matches.push({ from, to });
      // 防御零宽匹配死循环
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  });

  return matches;
}

/** 从命中列表生成装饰 */
function buildDecorations(
  doc: ProseMirrorNode,
  results: Array<{ from: number; to: number }>,
  current: number,
): DecorationSet {
  if (results.length === 0) return DecorationSet.empty;
  const decos = results.map((r, i) =>
    Decoration.inline(r.from, r.to, {
      class: i === current ? "kb-search-match kb-search-active" : "kb-search-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

/** 给定光标位置，在 results 里找第一个 from >= cursor 的命中索引（环绕） */
function nextIndexAfterCursor(
  results: Array<{ from: number; to: number }>,
  cursor: number,
): number {
  if (results.length === 0) return -1;
  for (let i = 0; i < results.length; i++) {
    if (results[i].from >= cursor) return i;
  }
  return 0;
}

export const SearchAndReplace = Extension.create({
  name: "searchAndReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchPluginState>({
        key: pluginKey,
        state: {
          init(): SearchPluginState {
            return {
              query: "",
              options: { caseSensitive: false, wholeWord: false },
              results: [],
              current: -1,
              decorations: DecorationSet.empty,
            };
          },
          apply(tr, prev): SearchPluginState {
            const meta = tr.getMeta(pluginKey) as SearchMeta | undefined;

            // ─── 显式 meta：set / next / prev / clear / setCurrent ───
            if (meta) {
              if (meta.type === "clear") {
                return {
                  query: "",
                  options: prev.options,
                  results: [],
                  current: -1,
                  decorations: DecorationSet.empty,
                };
              }
              if (meta.type === "set") {
                const query = meta.query ?? "";
                const options = { ...prev.options, ...(meta.options ?? {}) };
                const results = findMatches(tr.doc, query, options);
                // 设新 query 时：以当前光标为基准选中第一个就近命中
                const cursor = tr.selection.from;
                const current = nextIndexAfterCursor(results, cursor);
                return {
                  query,
                  options,
                  results,
                  current,
                  decorations: buildDecorations(tr.doc, results, current),
                };
              }
              if (meta.type === "next" || meta.type === "prev") {
                if (prev.results.length === 0) return prev;
                const len = prev.results.length;
                const next =
                  meta.type === "next"
                    ? (prev.current + 1) % len
                    : (prev.current - 1 + len) % len;
                return {
                  ...prev,
                  current: next,
                  decorations: buildDecorations(tr.doc, prev.results, next),
                };
              }
              if (meta.type === "setCurrent" && typeof meta.index === "number") {
                return {
                  ...prev,
                  current: meta.index,
                  decorations: buildDecorations(tr.doc, prev.results, meta.index),
                };
              }
            }

            // ─── 文档变更：重算 results（位置都跟着 mapping 走，但 query 命中数量可能变） ───
            if (tr.docChanged && prev.query) {
              const results = findMatches(tr.doc, prev.query, prev.options);
              // 当前 current 还有效就保留；否则就近选下一个
              let current = prev.current;
              if (current >= results.length) current = results.length - 1;
              if (current < 0 && results.length > 0) current = 0;
              return {
                ...prev,
                results,
                current,
                decorations: buildDecorations(tr.doc, results, current),
              };
            }

            return prev;
          },
        },
        props: {
          decorations(state: EditorState) {
            return pluginKey.getState(state)?.decorations ?? null;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSearchTerm:
        (query: string, options?: Partial<SearchOptions>) =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            const meta: SearchMeta = { type: "set", query, options };
            dispatch(tr.setMeta(pluginKey, meta));
          }
          return true;
        },

      searchNext:
        () =>
        ({ state, tr, dispatch, view }: CommandProps) => {
          const ps = pluginKey.getState(state);
          if (!ps || ps.results.length === 0) return false;
          if (dispatch) {
            const meta: SearchMeta = { type: "next" };
            dispatch(tr.setMeta(pluginKey, meta));
            // 滚动到当前匹配
            scrollCurrentIntoView(view, ps.results, (ps.current + 1) % ps.results.length);
          }
          return true;
        },

      searchPrev:
        () =>
        ({ state, tr, dispatch, view }: CommandProps) => {
          const ps = pluginKey.getState(state);
          if (!ps || ps.results.length === 0) return false;
          if (dispatch) {
            const meta: SearchMeta = { type: "prev" };
            dispatch(tr.setMeta(pluginKey, meta));
            const len = ps.results.length;
            scrollCurrentIntoView(view, ps.results, (ps.current - 1 + len) % len);
          }
          return true;
        },

      replaceCurrent:
        (replacement: string) =>
        ({ state, dispatch }: CommandProps) => {
          const ps = pluginKey.getState(state);
          if (!ps || ps.results.length === 0 || ps.current < 0) return false;
          if (dispatch) {
            const target = ps.results[ps.current];
            // replaceWith 接 TextNode；空替换走 delete
            const newTr = state.tr;
            if (replacement.length > 0) {
              newTr.insertText(replacement, target.from, target.to);
            } else {
              newTr.delete(target.from, target.to);
            }
            // docChanged 会触发 plugin 重算并保留 current（若仍在范围内）
            dispatch(newTr);
          }
          return true;
        },

      replaceAll:
        (replacement: string) =>
        ({ state, dispatch }: CommandProps) => {
          const ps = pluginKey.getState(state);
          if (!ps || ps.results.length === 0) return false;
          if (dispatch) {
            // 从后往前替，避免 from/to 偏移
            const newTr = state.tr;
            const sorted = [...ps.results].sort((a, b) => b.from - a.from);
            for (const r of sorted) {
              if (replacement.length > 0) {
                newTr.insertText(replacement, r.from, r.to);
              } else {
                newTr.delete(r.from, r.to);
              }
            }
            dispatch(newTr);
          }
          return true;
        },

      clearSearch:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            const meta: SearchMeta = { type: "clear" };
            dispatch(tr.setMeta(pluginKey, meta));
          }
          return true;
        },
    };
  },
});

/** 把当前命中滚到可视区域 */
function scrollCurrentIntoView(
  view: import("@tiptap/pm/view").EditorView,
  results: Array<{ from: number; to: number }>,
  index: number,
): void {
  const target = results[index];
  if (!target) return;
  // requestAnimationFrame 等装饰应用后 DOM 上能找到 .kb-search-active
  requestAnimationFrame(() => {
    const el = view.dom.querySelector(".kb-search-active");
    if (el) {
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

/** 让外部读插件状态（UI 浮条展示 "n/m"） */
export function getSearchState(state: EditorState): {
  query: string;
  total: number;
  current: number;
  options: SearchOptions;
} | null {
  const ps = pluginKey.getState(state);
  if (!ps) return null;
  return {
    query: ps.query,
    total: ps.results.length,
    current: ps.current,
    options: ps.options,
  };
}
