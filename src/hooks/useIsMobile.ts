import { useEffect, useState } from "react";

/**
 * 移动端布局开关。
 *
 * 判定优先级：
 * 1. 视口宽度 < 768px → 移动端（覆盖大多数手机；平板横屏走桌面布局）
 * 2. Tauri 移动端运行时（Android / iOS）→ 强制移动端（即使屏幕大也用 mobile UI）
 *
 * 桌面端窗口缩小到 < 768px 也会切到移动布局，方便开发期 BrowserWindow 模拟手机。
 *
 * 使用 matchMedia 而非 resize 事件：matchMedia 只在跨阈值时触发，远比 resize 高效。
 */
const MOBILE_BREAKPOINT = 768;

function detectMobile(): boolean {
  if (typeof window === "undefined") return false;
  // Tauri Mobile：navigator.userAgent 包含 'Android' / 'iPhone' / 'iPad'
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  // 视口宽度兜底
  return window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(detectMobile);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = () => setIsMobile(detectMobile());
    // Safari < 14 不支持 addEventListener('change'，回退 addListener
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  return isMobile;
}
