import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Button, Tooltip, theme as antdTheme } from "antd";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Columns3,
  Rows3,
  Combine,
  Split,
  Trash2,
} from "lucide-react";

interface Props {
  editor: Editor | null;
}

/**
 * 表格浮动菜单：光标进入 table 单元格时，在表格上方弹出一条按钮。
 * 解决"工具栏 → 表格下拉 → 删除当前列"路径过深的入口可见性问题。
 *
 * 实现要点：
 * - 监听 editor 的 selectionUpdate / transaction，动态计算位置
 * - mousedown preventDefault 防止点击按钮丢失编辑器选区
 * - createPortal 到 body，避开父级 overflow:hidden / transform 截断
 * - 滚动 / resize 时重算位置（监听 capture 阶段抓所有滚动容器）
 */
export function TableBubbleMenu({ editor }: Props) {
  const { token } = antdTheme.useToken();
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const update = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setVisible(false);
      return;
    }
    if (!editor.isActive("table")) {
      setVisible(false);
      return;
    }
    // 从选区起点 DOM 向上找最近的 table 元素
    const { from } = editor.state.selection;
    let node: Node | null = editor.view.domAtPos(from).node;
    let tableEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.tagName === "TABLE") {
        tableEl = node;
        break;
      }
      node = node.parentNode;
    }
    if (!tableEl) {
      setVisible(false);
      return;
    }
    const rect = tableEl.getBoundingClientRect();
    setPos({
      top: window.scrollY + rect.top - 38,
      left: window.scrollX + rect.left,
    });
    setVisible(true);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor, update]);

  useEffect(() => {
    if (!visible) return;
    const handler = () => update();
    // capture 阶段抓内层滚动容器（笔记内容区往往有自己的 overflow:auto）
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [visible, update]);

  if (!visible || !editor) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    // 防止点击按钮时 ProseMirror 失焦丢选区
    e.preventDefault();
  };

  const Btn = ({
    icon,
    title,
    onClick,
    danger,
    disabled,
  }: {
    icon: React.ReactNode;
    title: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }) => (
    <Tooltip title={title} mouseEnterDelay={0.4}>
      <Button
        type="text"
        size="small"
        icon={icon}
        danger={danger}
        disabled={disabled}
        onClick={onClick}
        style={{ minWidth: 28, height: 28, padding: 0 }}
      />
    </Tooltip>
  );

  const VDivider = () => (
    <div
      style={{
        width: 1,
        background: token.colorBorderSecondary,
        margin: "4px 2px",
      }}
    />
  );

  const can = editor.can();

  return createPortal(
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        zIndex: 100,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 6,
        boxShadow: token.boxShadowSecondary,
        padding: "2px 4px",
        display: "flex",
        alignItems: "center",
        gap: 0,
      }}
    >
      <Btn
        icon={<ChevronLeft size={14} />}
        title="在左侧加列"
        disabled={!can.addColumnBefore()}
        onClick={() => editor.chain().focus().addColumnBefore().run()}
      />
      <Btn
        icon={<ChevronRight size={14} />}
        title="在右侧加列"
        disabled={!can.addColumnAfter()}
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      />
      <Btn
        icon={<Columns3 size={14} />}
        title="删除当前列"
        danger
        disabled={!can.deleteColumn()}
        onClick={() => editor.chain().focus().deleteColumn().run()}
      />
      <VDivider />
      <Btn
        icon={<ChevronUp size={14} />}
        title="在上方加行"
        disabled={!can.addRowBefore()}
        onClick={() => editor.chain().focus().addRowBefore().run()}
      />
      <Btn
        icon={<ChevronDown size={14} />}
        title="在下方加行"
        disabled={!can.addRowAfter()}
        onClick={() => editor.chain().focus().addRowAfter().run()}
      />
      <Btn
        icon={<Rows3 size={14} />}
        title="删除当前行"
        danger
        disabled={!can.deleteRow()}
        onClick={() => editor.chain().focus().deleteRow().run()}
      />
      <VDivider />
      <Btn
        icon={<Combine size={14} />}
        title="合并单元格"
        disabled={!can.mergeCells()}
        onClick={() => editor.chain().focus().mergeCells().run()}
      />
      <Btn
        icon={<Split size={14} />}
        title="拆分单元格"
        disabled={!can.splitCell()}
        onClick={() => editor.chain().focus().splitCell().run()}
      />
      <VDivider />
      <Btn
        icon={<Trash2 size={14} />}
        title="删除整张表"
        danger
        disabled={!can.deleteTable()}
        onClick={() => editor.chain().focus().deleteTable().run()}
      />
    </div>,
    document.body,
  );
}
