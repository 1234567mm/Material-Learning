import { useState, useEffect } from "react";
import { Table, Button, Popconfirm, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { knowledgeApi } from "@/lib/api";
import type { KnowledgeMemory } from "@/types";

export function MemoryManager() {
  const [memories, setMemories] = useState<KnowledgeMemory[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await knowledgeApi.listMemories(100);
      setMemories(data);
    } catch (e) {
      message.error("加载记忆失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleForget = async (id: number) => {
    try {
      await knowledgeApi.forgetMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
      message.success("已删除");
    } catch (e) {
      message.error("删除失败");
    }
  };

  const columns: ColumnsType<KnowledgeMemory> = [
    { title: "内容", dataIndex: "content", key: "content", ellipsis: true, width: 300 },
    { title: "质量", dataIndex: "quality_score", key: "quality_score", render: v => (v * 100).toFixed(0) + "%" },
    { title: "引用", dataIndex: "used_count", key: "used_count" },
    { title: "创建时间", dataIndex: "created_at", key: "created_at" },
    {
      title: "操作",
      key: "action",
      render: (_, record) => (
        <Popconfirm title="删除此记忆？" onConfirm={() => handleForget(record.id)}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h3>全局记忆库</h3>
        <Button onClick={load}>刷新</Button>
      </div>
      <Table
        dataSource={memories}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        size="small"
      />
    </div>
  );
}