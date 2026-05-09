/**
 * 侧边栏树节点图标辅助函数。
 *
 * 设计哲学：和 Obsidian 一致，让用户用 emoji 前缀给文件夹/笔记加图标，
 * 不引入"图标选择器 + 数据库字段"那一套重型 UI。
 *
 * 例：
 *   "🐳 Docker"        → emoji=🐳   rest="Docker"
 *   "Java"             → emoji=null rest="Java"  → 走 hash 配色
 *   "📚 我的读书笔记"   → emoji=📚   rest="我的读书笔记"
 */

/**
 * 解析名称里的 emoji 前缀。emoji 后必须跟空白才视为分隔符，避免
 * "🛠工具"（无空格）被切成图标 + 残文。
 *
 * 用 Unicode 属性 `\p{Extended_Pictographic}` 覆盖大部分 emoji（含组合
 * 字符 + ZWJ 序列只匹配第一段；对于多 codepoint emoji 显示效果通常
 * 仍正确，因为浏览器会把后续 ZWJ 部分一起渲染）。
 */
const EMOJI_PREFIX_RE =
  /^([\p{Extended_Pictographic}\p{Emoji_Presentation}](?:\uFE0F|\u200D[\p{Extended_Pictographic}\p{Emoji_Presentation}])*)\s+/u;

export function parseEmojiPrefix(name: string): {
  emoji: string | null;
  rest: string;
} {
  const m = name.match(EMOJI_PREFIX_RE);
  if (m) {
    return { emoji: m[1], rest: name.slice(m[0].length) };
  }
  return { emoji: null, rest: name };
}
