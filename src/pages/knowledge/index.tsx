import { useState } from "react";
import type { KnowledgePanel } from "@/types";
import { PanelList } from "./PanelList";
import { ChatPanel } from "./ChatPanel";

export default function KnowledgePage() {
  const [activePanel, setActivePanel] = useState<KnowledgePanel | null>(null);
  const [, setRefreshKey] = useState(0);

  const handleSelectPanel = async (panel: KnowledgePanel) => {
    setActivePanel(panel);
  };

  const handleRefresh = () => {
    setRefreshKey(k => k + 1);
  };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <PanelList
        activePanelId={activePanel?.id ?? null}
        onSelectPanel={handleSelectPanel}
        onRefresh={handleRefresh}
      />
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {activePanel ? (
          <ChatPanel key={activePanel.id} panel={activePanel} />
        ) : (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#999",
            fontSize: 16,
          }}>
            选择左侧面板开始对话
          </div>
        )}
      </div>
    </div>
  );
}