import { theme as antdTheme } from "antd";
import type React from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** 单个菜单项定义 */
export interface ContextMenuItemDef {
  key: string;
  label: React.ReactNode;
  /** 可选 lucide / antd icon 节点 */
  icon?: React.ReactNode;
  /** 危险操作（红色文案 + 红色 hover） */
  danger?: boolean;
  /** 灰显不可点击 */
  disabled?: boolean;
  /** 右侧小字提示，如快捷键 */
  hint?: React.ReactNode;
  /**
   * 可选 per-item 点击 handler。
   * 提供时优先于顶层 `onClick`；适合每条 item 行为差异大的场景（如 NotesPanel）
   */
  onClick?: () => void;
}

/** 分隔线 */
export interface ContextMenuDivider {
  type: "divider";
}

/**
 * 自定义 section —— 在菜单里嵌入任意 React 节点（色板 grid、缩略图...）。
 * - render 内的点击事件**不会**让菜单自动关闭（点击 mousedown 时落在 overlay 内被忽略）
 * - 调用方需要在交互完成后**主动**调 onClose 关闭菜单
 */
export interface ContextMenuCustom {
  type: "custom";
  key: string;
  render: () => React.ReactNode;
}

export type ContextMenuEntry =
  | ContextMenuItemDef
  | ContextMenuDivider
  | ContextMenuCustom;

interface Props {
  /** 是否显示。建议传 `!!ctx.state.payload` */
  open: boolean;
  /** viewport 坐标 */
  x: number;
  y: number;
  /** 菜单条目（item / divider 混排） */
  items: ContextMenuEntry[];
  /** 点击 item 回调（divider 不会触发） */
  onClick?: (key: string, e: React.MouseEvent) => void;
  /** 关闭回调（点空白 / Esc）；一般直传 ctx.close */
  onClose: () => void;
}

/**
 * 右键菜单浮层。
 *
 * **不用 antd Dropdown / Menu**：
 * - Dropdown 把位置交给 rc-trigger 在 children mount 时算一次，children 之后
 *   left/top 改变它不跟随 → 同一菜单连续右键不同位置时菜单卡在第一次坐标
 * - antd Menu 默认 itemHeight 36 + padding 太大，不符合"右键菜单"应有的紧凑感
 *
 * **当前实现**：
 * - `createPortal` 挂到 `document.body` —— 绕开父链上的 backdrop-filter / transform
 *   把 fixed 子元素重定位到父容器的副作用（本项目 SidePanel 浮层就有 backdrop-filter）
 * - 位置 100% 由 React props 驱动（`left/top`），state 一变自然 re-render
 * - 自渲染 item 列表 —— 高度 28px、字号 13、padding 紧凑，hover 用 token.colorFillTertiary
 * - 自挂 mousedown(capture) + Esc 监听处理外部点击关闭
 */
export function ContextMenuOverlay({
  open,
  x,
  y,
  items,
  onClick,
  onClose,
}: Props) {
  const { token } = antdTheme.useToken();

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      // 右键再次唤起新菜单 → 由 onContextMenu 路径处理，不要在这里关
      if (e.button === 2) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-context-menu="overlay"]')) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  // 边界保护：菜单不超出视口右下
  const itemHeight = 28;
  const dividerHeight = 5;
  const verticalPadding = 8;
  const estimatedWidth = 180;
  const estimatedHeight =
    verticalPadding * 2 +
    items.reduce(
      (sum, it) =>
        sum + ("type" in it && it.type === "divider" ? dividerHeight : itemHeight),
      0,
    );
  const safeX = Math.min(x, Math.max(8, window.innerWidth - estimatedWidth - 8));
  const safeY = Math.min(y, Math.max(8, window.innerHeight - estimatedHeight - 8));

  return createPortal(
    <div
      data-context-menu="overlay"
      role="menu"
      style={{
        position: "fixed",
        left: safeX,
        top: safeY,
        zIndex: 1050,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 8,
        boxShadow: token.boxShadowSecondary,
        padding: `${verticalPadding / 2}px 4px`,
        minWidth: estimatedWidth,
        userSelect: "none",
        // 微动画：从 95% 缩放 + 弱透明 弹出，符合 "macOS / VSCode 上下文菜单" 感
        animation: "kb-ctx-menu-pop 90ms cubic-bezier(0.16, 1, 0.3, 1)",
        transformOrigin: "top left",
      }}
    >
      {items.map((entry, idx) => {
        if ("type" in entry && entry.type === "divider") {
          return (
            <div
              key={`d-${idx}`}
              role="separator"
              style={{
                height: 1,
                margin: "4px 6px",
                background: token.colorBorderSecondary,
              }}
            />
          );
        }
        if ("type" in entry && entry.type === "custom") {
          // 自定义 section（例如内嵌色板 grid）。整段不做 hover 高亮、点击关闭由调用方 onClose 控制
          return <div key={entry.key}>{entry.render()}</div>;
        }
        const item = entry as ContextMenuItemDef;
        return (
          <ContextMenuRow
            key={item.key}
            item={item}
            onSelect={(e) => {
              if (item.disabled) return;
              // per-item onClick 优先；调用方一般在内部自己 close
              if (item.onClick) {
                item.onClick();
              } else {
                onClick?.(item.key, e);
              }
            }}
            token={token}
          />
        );
      })}
      {/* keyframes 内联到 style；reference 用 :global 注入避免重复 */}
      <style>{`
        @keyframes kb-ctx-menu-pop {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

interface RowProps {
  item: ContextMenuItemDef;
  onSelect: (e: React.MouseEvent) => void;
  // 收紧类型：只取 ContextMenuRow 用到的 token 字段
  token: {
    colorText: string;
    colorTextDescription: string;
    colorTextDisabled: string;
    colorError: string;
    colorErrorBg: string;
    colorFillTertiary: string;
  };
}

/** 单行，自管 hover 状态 */
function ContextMenuRow({ item, onSelect, token }: RowProps) {
  const [hover, setHover] = useState(false);
  const { label, icon, danger, disabled, hint } = item;
  const baseColor = disabled
    ? token.colorTextDisabled
    : danger
      ? token.colorError
      : token.colorText;
  const hoverBg = danger ? token.colorErrorBg : token.colorFillTertiary;
  return (
    <div
      role="menuitem"
      aria-disabled={disabled || undefined}
      onMouseEnter={() => !disabled && setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(e);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 28,
        padding: "0 10px",
        borderRadius: 4,
        fontSize: 13,
        lineHeight: "20px",
        cursor: disabled ? "not-allowed" : "pointer",
        color: baseColor,
        background: hover && !disabled ? hoverBg : "transparent",
        transition: "background 80ms ease",
      }}
    >
      {icon && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            color: baseColor,
            opacity: disabled ? 0.5 : 0.8,
          }}
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1, whiteSpace: "nowrap" }}>{label}</span>
      {hint && (
        <span
          style={{
            color: token.colorTextDescription,
            fontSize: 11,
            marginLeft: 16,
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}
