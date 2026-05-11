import Markdown from "react-markdown";
import type { KnowledgeMessage } from "@/types";

interface Props {
  message: KnowledgeMessage;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  return (
    <div style={{
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: "70%",
        padding: "8px 12px",
        borderRadius: 12,
        background: isUser ? "#1677ff" : isAssistant ? "#f5f5f5" : "#fff7e6",
        color: isUser ? "#fff" : "#000",
        whiteSpace: "pre-wrap",
      }}>
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}