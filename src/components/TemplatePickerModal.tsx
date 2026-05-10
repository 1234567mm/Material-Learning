import { useEffect, useState } from "react";
import { Modal, Card, Spin, Empty, message } from "antd";
import { useNavigate } from "react-router-dom";

import { templateApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { NoteTemplate } from "@/types";

interface Props {
  open: boolean;
  /** 当前所在文件夹；创建时自动归入 */
  folderId?: number | null;
  onClose: () => void;
}

/**
 * 从模板创建笔记的独立 Modal —— 从旧 CreateNoteModal 里拆出来。
 * 列出所有模板卡片，点击即创建笔记并跳转到编辑器。
 */
export function TemplatePickerModal({ open, folderId = null, onClose }: Props) {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    templateApi
      .list()
      .then(setTemplates)
      .catch((e) => message.error(`加载模板失败: ${e}`))
      .finally(() => setLoading(false));
  }, [open]);

  async function handlePick(tpl: NoteTemplate) {
    try {
      // 走 create_note_from_template：后端会渲染 {{date}}/{{weekday}} 等占位符
      const note = await templateApi.createNoteFromTemplate(
        tpl.id,
        tpl.name,
        folderId,
      );
      message.success("已从模板创建");
      onClose();
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="从模板创建笔记"
      footer={null}
      width={620}
      destroyOnHidden
    >
      <Spin spinning={loading}>
        {templates.length === 0 && !loading ? (
          <Empty description="暂无模板" />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 12,
              maxHeight: 400,
              overflowY: "auto",
            }}
          >
            {templates.map((tpl) => (
              <Card
                key={tpl.id}
                hoverable
                size="small"
                onClick={() => handlePick(tpl)}
              >
                <Card.Meta
                  title={tpl.name}
                  description={
                    <span style={{ fontSize: 12 }}>
                      {tpl.description || "无描述"}
                    </span>
                  }
                />
              </Card>
            ))}
          </div>
        )}
      </Spin>
    </Modal>
  );
}
