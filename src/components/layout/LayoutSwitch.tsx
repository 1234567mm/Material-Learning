import { useIsMobile } from "@/hooks/useIsMobile";
import { AppLayout } from "./AppLayout";
import { MobileLayout } from "./MobileLayout";

/**
 * 根据视口/平台动态选 Layout：
 * - 移动端（< 768px 视口 或 Tauri Mobile 运行时）→ MobileLayout
 * - 桌面端 → AppLayout（保留现有 Sider + Header + ActivityBar 等）
 *
 * 注意：仅在路由根节点（Router.tsx 的 element 处）使用一次。
 * 子页面组件不应该再判断 isMobile 来切 Layout，那会导致 mount/unmount 混乱。
 */
export function LayoutSwitch() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileLayout /> : <AppLayout />;
}
