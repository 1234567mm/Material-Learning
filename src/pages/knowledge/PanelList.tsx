import { useState, useEffect } from "react";
import { List, Button, Input, Popconfirm, message } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { knowledgeApi } from "@/lib/api";
import type { KnowledgePanel } from "@/types";

interface Props {
  activePanelId: number | null;
  onSelectPanel: (panel: KnowledgePanel) => void;
  onRefresh: () => void;
}

export function PanelList({ activePanelId, onSelectPanel, onRefresh }: Props) {
  const [panels, setPanels] = useState<KnowledgePanel[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadPanels = async () => {
    try {
      const data = await knowledgeApi.listPanels();
      setPanels(data);
    } catch (e) {
      message.error("加载面板失败");
    }
  };

  useEffect(() => { loadPanels(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await knowledgeApi.createPanel(newName.trim());
      setNewName("");
      setCreating(false);
      await loadPanels();
      onRefresh();
    } catch (e) {
      message.error("创建面板失败");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await knowledgeApi.deletePanel(id);
      await loadPanels();
      onRefresh();
    } catch (e) {
      message.error("删除面板失败");
    }
  };

  return (
    <div style={{ width: 240, borderRight: "1px solid #f0f0f0", padding: 16, height: "100vh", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontWeight: 600 }}>知识面板</span>
        <Button type="text" icon={<Plus size={16} />} onClick={() => setCreating(true)} />
      </div>

      {creating && (
        <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
          <Input
            size="small"
            placeholder="面板名称"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onPressEnter={handleCreate}
            autoFocus
          />
          <Button size="small" type="primary" onClick={handleCreate}>确定</Button>
          <Button size="small" onClick={() => { setCreating(false); setNewName(""); }}>取消</Button>
        </div>
      )}

      <List
        size="small"
        dataSource={panels}
        renderItem={panel => (
          <List.Item
            key={panel.id}
            onClick={() => onSelectPanel(panel)}
            style={{
              cursor: "pointer",
              padding: "8px 4px",
              background: panel.id === activePanelId ? "#e6f7ff" : "transparent",
              borderRadius: 6,
            }}
            extra={
              <Popconfirm title="删除此面板？" onConfirm={() => handleDelete(panel.id)}>
                <Button type="text" size="small" icon={<Trash2 size={14} />} />
              </Popconfirm>
            }
          >
            <List.Item.Meta title={panel.name} />
          </List.Item>
        )}
      />
    </div>
  );
}