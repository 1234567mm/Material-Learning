/**
 * Heading 折叠功能的 anchor 生成器
 *
 * 业界主流（Obsidian / GitHub README TOC）做法：
 * - 用标题文本生成 slug 作为稳定 anchor，跨重启 / 跨设备一致
 * - 同名标题用 occurrence index 区分（"## 2026 第 1 节" 出现两次 → 第二次自动加 -2）
 *
 * 这个文件只负责"给一份 ProseMirror doc 生成 anchor 列表"，不耦合 Tiptap，
 * 也不耦合任何 React/Zustand —— 方便测试 & 复用到大纲 / 跳转锚点等其他场景。
 */
import type { Node as PMNode } from "@tiptap/pm/model";

/** 一个 heading 在文档中的位置摘要 */
export interface HeadingHit {
  /** 唯一 anchor（slug + occurrence index 后缀） */
  anchor: string;
  /** heading 节点在 doc 里的起始位置（PM pos） */
  pos: number;
  /** heading 节点的 nodeSize（用来算 to） */
  nodeSize: number;
  /** 1..6 */
  level: number;
  /** 标题文本（用作 chevron 的 aria-label / debug） */
  text: string;
}

/**
 * 把标题文本转成 slug。中文友好（中文字符直接保留），与 GitHub TOC 生成器
 * 行为接近——同 slug 第二次出现交给调用方加 occurrence 后缀。
 */
export function toHeadingSlug(text: string): string {
  const slug = (text ?? "")
    .trim()
    .toLowerCase()
    // 移除 markdown 元字符
    .replace(/[#*_~`>[\]()]/g, "")
    // 全/半角空白 → -
    .replace(/[\s\u3000]+/g, "-")
    // 多个 - 合并
    .replace(/-{2,}/g, "-")
    // 收尾 -
    .replace(/^-+|-+$/g, "")
    // 截断防止超长
    .slice(0, 50);
  return slug || "untitled";
}

/**
 * 扫一份 doc，按文档顺序返回所有 H1–maxLevel 的命中。
 * 同 slug 出现多次时自动追加 -2 / -3 ... 后缀，保证 anchor 唯一。
 *
 * 默认只收 H1–H3：再细的层级 chevron UI 太密集；真有需求把 maxLevel 调到 6。
 */
export function collectHeadings(doc: PMNode, maxLevel = 3): HeadingHit[] {
  const out: HeadingHit[] = [];
  const slugCount = new Map<string, number>();

  // 只收 top-level heading：嵌套在 blockquote / details 等容器内的 heading 走折叠会
  // 让作用域语义不一致（"折叠到下一同级 H"难以定义），先排除掉
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "heading") return;
    if (parent !== doc) return;
    const level = (node.attrs.level as number) ?? 0;
    if (level < 1 || level > maxLevel) return;
    const text = node.textContent ?? "";
    const baseSlug = toHeadingSlug(text);
    const seen = slugCount.get(baseSlug) ?? 0;
    const anchor = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;
    slugCount.set(baseSlug, seen + 1);
    out.push({ anchor, pos, nodeSize: node.nodeSize, level, text });
  });

  return out;
}

/**
 * 给定一组 heading 命中和某条已折叠的 anchor，返回它的"管辖范围" PM 位置 [from, to)。
 * 规则：从该 heading 之后第一个 sibling 起，到下一同级或更高级 heading 之前为止；
 * 文档末尾收尾。
 *
 * 返回 null 表示该 anchor 在当前 doc 里没有命中（标题被改字 / 删除了）。
 */
export function rangeOfFolded(
  headings: HeadingHit[],
  anchor: string,
  docSize: number,
): { from: number; to: number; level: number } | null {
  const idx = headings.findIndex((h) => h.anchor === anchor);
  if (idx < 0) return null;
  const head = headings[idx];
  const from = head.pos + head.nodeSize; // 标题之后第一个 block
  let to = docSize;
  for (let i = idx + 1; i < headings.length; i += 1) {
    const next = headings[i];
    if (next.level <= head.level) {
      to = next.pos;
      break;
    }
  }
  return { from, to, level: head.level };
}
