import { useState, useEffect, useCallback } from "react";
import { Modal, Input, Button, Tooltip, message } from "antd";
import { MessageSquarePlus } from "lucide-react";
import type { Editor } from "@tiptap/react";

interface Props {
  editor: Editor;
}

/**
 * 批注按钮 + 输入 Modal，配合 Annotation mark 使用。
 *
 * 三个入口共用一套 Modal：
 *   1. 点工具栏按钮
 *   2. Ctrl/Cmd + Alt + M（mark 内 addKeyboardShortcuts 广播 CustomEvent）
 *   3. 编辑器右键菜单的"添加/编辑批注"项（也 dispatch 同一事件）
 */
export function AnnotationButton({ editor }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [hasMark, setHasMark] = useState(false);

  /** 打开输入 Modal：自动取当前选区的批注作为默认值 */
  const openDialog = useCallback(() => {
    const sel = editor.state.selection;
    // 既没选中文字、又不在已有批注内 → 没有作用对象
    if (sel.empty && !editor.isActive("annotation")) {
      message.info("请先选中要添加批注的文字");
      return;
    }
    const current = (editor.getAttributes("annotation").comment as string) ?? "";
    setValue(current);
    setHasMark(editor.isActive("annotation"));
    setOpen(true);
  }, [editor]);

  // 全局事件接收：快捷键和右键菜单都发同一个 CustomEvent
  useEffect(() => {
    const onShortcut = () => openDialog();
    document.addEventListener(
      "kb-annotation-shortcut",
      onShortcut as EventListener,
    );
    return () =>
      document.removeEventListener(
        "kb-annotation-shortcut",
        onShortcut as EventListener,
      );
  }, [openDialog]);

  function handleOk() {
    const c = value.trim();
    if (!c) {
      message.warning("批注内容不能为空");
      return;
    }
    editor.chain().focus().setAnnotation(c).run();
    setOpen(false);
  }

  function handleRemove() {
    editor.chain().focus().unsetAnnotation().run();
    setOpen(false);
  }

  const isActive = editor.isActive("annotation");

  return (
    <>
      <Tooltip title="批注 (Ctrl+Shift+M)" mouseEnterDelay={0.5}>
        <Button
          type="text"
          size="small"
          icon={<MessageSquarePlus size={15} />}
          onClick={openDialog}
          style={{
            minWidth: 28,
            height: 28,
            padding: 0,
            background: isActive ? "rgba(255, 234, 0, 0.35)" : undefined,
            color: isActive ? "#876800" : undefined,
          }}
        />
      </Tooltip>
      <Modal
        title={hasMark ? "编辑批注" : "添加批注"}
        open={open}
        onCancel={() => setOpen(false)}
        destroyOnHidden
        width={420}
        footer={[
          hasMark ? (
            <Button key="remove" danger onClick={handleRemove}>
              删除批注
            </Button>
          ) : null,
          <Button key="cancel" onClick={() => setOpen(false)}>
            取消
          </Button>,
          <Button key="ok" type="primary" onClick={handleOk}>
            保存
          </Button>,
        ]}
      >
        <Input.TextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="输入批注内容（如：这里参考了 X 文献 / 这段需要复查 / ...）"
          rows={4}
          autoFocus
          onKeyDown={(e) => {
            // Ctrl/Cmd + Enter 提交，普通 Enter 还是换行
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              handleOk();
            }
          }}
        />
      </Modal>
    </>
  );
}
