/**
 * 让 tiptap-markdown 的 markdown-it 实例放行 file:// 协议链接
 *
 * Why：markdown-it 默认 validateLink 把 file: 列入黑名单（markdown-it#108），
 * 导致笔记里的 [📎 附件](file://...) 第二次打开时被解析器拒绝，整段降级成
 * 纯 markdown 文本。
 *
 * 实现：onBeforeCreate 时 Markdown 扩展的 onBeforeCreate 已经跑过（因为本扩展
 * 在 extensions 数组里位于 Markdown 之后），parser.md 已就绪 → 直接 monkey-patch
 * validateLink。这样初始 setContent 时 md 已经能放行 file://。
 *
 * 还在 storage 注入 setup 钩子作为兜底（每次后续 parse 前重设，防被覆盖）。
 */
import { Extension } from "@tiptap/core";

const BAD_PROTO = /^(javascript|vbscript|data):/i;
const allowAllExceptDangerous = (url: string): boolean =>
  !BAD_PROTO.test(String(url).trim());

export const AllowFileLink = Extension.create({
  name: "allowFileLink",

  onBeforeCreate() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (this.editor.storage as any).markdown?.parser?.md as
      | { validateLink?: (url: string) => boolean }
      | undefined;
    if (md) {
      md.validateLink = allowAllExceptDangerous;
    }
  },

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: { validateLink?: (url: string) => boolean }) {
            md.validateLink = allowAllExceptDangerous;
          },
        },
      },
    };
  },
});
