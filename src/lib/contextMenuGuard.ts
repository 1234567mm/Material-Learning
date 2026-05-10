/**
 * 全局右键菜单守卫：在 window 上拦截 contextmenu 事件，阻止 WebView 默认菜单
 * （「返回 / 刷新 / 另存为 / 打印」之类）出现在桌面应用里。
 *
 * **白名单**：`input` / `textarea` / `[contenteditable='true']` 内的右键不阻止 ——
 * 让用户在表单 / 富文本编辑器里仍能用浏览器原生剪切 / 复制 / 粘贴 / 全选菜单。
 *
 * **使用时机**：必须等所有需要右键菜单的位置都接入完自定义菜单后，才能挂载本守卫；
 * 否则那些没接入的位置用户右键会什么都不出，体验更糟。
 *
 * **典型调用**（在 `src/main.tsx` 启动时调一次，通过对应批次开关启用）：
 * ```ts
 * if (!import.meta.env.DEV) {
 *   installContextMenuGuard();
 * }
 * ```
 *
 * dev 模式不挂载是为了保留 DevTools 的「检查元素」选项方便调试。
 *
 * @returns 卸载函数。一般无需调用（应用整个生命周期都需要守卫）
 */
export function installContextMenuGuard(): () => void {
  const handler = (e: MouseEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    // 表单 / 富文本输入区保留默认菜单
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
  };
  window.addEventListener("contextmenu", handler);
  return () => window.removeEventListener("contextmenu", handler);
}
