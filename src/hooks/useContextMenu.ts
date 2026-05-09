import { useCallback, useState } from "react";

/**
 * 通用右键菜单状态 hook。
 *
 * 解决两个痛点：
 * - antd Tree 直接套 `<Dropdown trigger={["contextMenu"]}>` 会破坏拖拽
 *   （已在 Sidebar / NotesPanel 踩过坑）
 * - 多处右键菜单要手写一份 `{x, y, payload, ts}` state，重复
 *
 * 配套使用：`<ContextMenuOverlay>` 消费 state 渲染浮层。
 *
 * @template T payload 类型 —— 右键时要带的上下文（如 `{ id, title }`）
 */
export interface ContextMenuState<T> {
  /** null = 菜单关闭；非 null = 用此 payload 构造菜单项 */
  payload: T | null;
  /** 右键位置（viewport 坐标） */
  x: number;
  y: number;
  /** 时间戳 —— 同位置反复唤起时用作 React key 强制 Dropdown 重渲染 */
  ts: number;
}

export interface UseContextMenuReturn<T> {
  state: ContextMenuState<T>;
  /** 打开菜单：从 MouseEvent 拿坐标 + 绑 payload */
  open: (e: { clientX: number; clientY: number }, payload: T) => void;
  /** 关闭菜单（点击菜单项后 / Dropdown onOpenChange(false) 时调用） */
  close: () => void;
}

export function useContextMenu<T>(): UseContextMenuReturn<T> {
  const [state, setState] = useState<ContextMenuState<T>>({
    payload: null,
    x: 0,
    y: 0,
    ts: 0,
  });

  const open = useCallback(
    (e: { clientX: number; clientY: number }, payload: T) => {
      setState({ payload, x: e.clientX, y: e.clientY, ts: Date.now() });
    },
    [],
  );

  const close = useCallback(() => {
    // 已经关着就不触发额外的 setState，避免不必要的重渲染
    setState((s) => (s.payload === null ? s : { ...s, payload: null }));
  }, []);

  return { state, open, close };
}
