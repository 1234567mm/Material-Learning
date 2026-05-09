import { useMemo } from "react";
import { Popover, Typography, Button, theme as antdTheme, message } from "antd";
import { Star } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store";

/**
 * 多开实例标识徽章（Header 拖拽区中央的水平 pill）。
 *
 * 触发动机：软件支持多开（每个实例独立 SQLite + 资产目录），但应用内 UI 此前
 * 完全不区分实例。系统标题栏被 `decorations: false` 关掉，OS 任务栏 / Alt-Tab
 * 之外的位置都看不到 set_title 的效果，所以需要应用内常驻可见的标识。
 *
 * 默认实例（None）显示金色 ★ 主实例，多开实例（Some(N)）按 id 哈希取色 + "实例 N"。
 */

/**
 * 把 instance_id 映射到一个稳定的色相。
 * 用 0.382 黄金比例倍率让相邻数字（实例 2/3/4...）色相差距明显。
 */
function instanceColor(id: number | null): string {
  if (id === null) return "#FAAD14"; // 默认实例 = 金色
  const hue = (id * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 65%, 48%)`;
}

function instanceFullLabel(id: number | null): string {
  return id === null ? "主实例" : `实例 ${id}`;
}

export function InstanceBadge() {
  const info = useAppStore((s) => s.instanceInfo);
  const { token } = antdTheme.useToken();

  const color = useMemo(() => instanceColor(info?.instanceId ?? null), [info?.instanceId]);

  // 启动后 ~50ms 内 info 还没拉到，先什么都不渲染（避免闪烁）
  if (!info) return null;

  const isDefault = info.instanceId === null;
  const fullLabel = instanceFullLabel(info.instanceId);

  async function handleOpenDataDir(e?: React.MouseEvent) {
    e?.stopPropagation();
    if (!info) return;
    try {
      await openPath(info.dataDir);
    } catch (err) {
      message.error(`打开数据目录失败：${err}`);
    }
  }

  const popoverContent = (
    <div style={{ minWidth: 280, maxWidth: 420 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: 6,
            background: color,
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {isDefault ? <Star size={12} fill="#fff" /> : info.instanceId}
        </span>
        <Typography.Text strong>{fullLabel}</Typography.Text>
        {info.isDev && (
          <Typography.Text type="warning" style={{ fontSize: 11 }}>
            [DEV]
          </Typography.Text>
        )}
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
        数据目录
      </Typography.Paragraph>
      <Typography.Paragraph
        copyable={{ text: info.dataDir }}
        style={{
          fontSize: 12,
          fontFamily: "var(--font-family-mono, monospace)",
          background: token.colorFillTertiary,
          padding: "4px 8px",
          borderRadius: 4,
          marginBottom: 8,
          wordBreak: "break-all",
        }}
      >
        {info.dataDir}
      </Typography.Paragraph>
      {isDefault ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 8 }}>
          主实例：自动同步调度器与双击 .md 投递监听仅在此实例运行。
        </Typography.Paragraph>
      ) : (
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 8 }}>
          多开实例：与主实例数据独立，自动同步调度器不会运行。
        </Typography.Paragraph>
      )}
      <Button size="small" block onClick={(e) => handleOpenDataDir(e)}>
        在文件管理器中打开
      </Button>
    </div>
  );

  return (
    <Popover content={popoverContent} title={null} placement="bottom" trigger="click">
      <button
        type="button"
        // 阻止冒泡到外层 DragRegion 的 mousedown，避免点徽章变成"按住拖窗口"
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={`${fullLabel}${info.isDev ? " [DEV]" : ""}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 24,
          padding: "0 10px",
          borderRadius: 12,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          cursor: "pointer",
          fontSize: 12,
          color: token.colorText,
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <span>{fullLabel}</span>
        {info.isDev && (
          <span style={{ color: token.colorWarning, fontWeight: 600 }}>[DEV]</span>
        )}
      </button>
    </Popover>
  );
}
