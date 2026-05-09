import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Spin, Empty, theme as antdTheme, Segmented, Tooltip } from "antd";
import {
  Maximize2,
  Minimize2,
  RotateCcw,
  ExternalLink,
  Crosshair,
} from "lucide-react";
import { Graph } from "@antv/g6";
import { linkApi } from "@/lib/api";
import type { GraphData } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();

  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [layout, setLayout] = useState<string>("d3-force");

  // ─── 节点右键菜单 ────────────────────────────
  const ctx = useContextMenu<{ nodeId: string; title: string }>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    return [
      {
        key: "open",
        label: "打开笔记",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          ctx.close();
          navigate(`/notes/${p.nodeId}`);
        },
      },
      {
        key: "focus",
        label: "居中此节点",
        icon: <Crosshair size={13} />,
        onClick: () => {
          ctx.close();
          // G6 v5：把指定节点移到视图中心
          try {
            graphRef.current?.focusElement(p.nodeId);
          } catch {
            // focusElement 可能在某些版本叫 focus；失败时退到 fitCenter
            graphRef.current?.fitCenter();
          }
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload, navigate]);

  useEffect(() => {
    loadGraphData();
  }, []);

  // 给 G6 画布容器原生挂 contextmenu capture-phase listener，吞 WebView 默认菜单。
  // G6 v5 的 canvas 内部会拦截 contextmenu 不冒泡到 React 外层 div，所以
  // 顶层 <div onContextMenu> 收不到画布空白处的右键事件。capture phase 的
  // 原生 listener 比 G6 内部 bubble-phase 监听器先触发，主动 preventDefault
  // 让 WebView 默认菜单不弹；节点的 graph.on("node:contextmenu") 仍然能跑
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("contextmenu", handler, true);
    return () => el.removeEventListener("contextmenu", handler, true);
  }, []);

  async function loadGraphData() {
    setLoading(true);
    try {
      const data = await linkApi.getGraphData();
      setGraphData(data);
    } catch (e) {
      console.error("加载图谱数据失败:", e);
    } finally {
      setLoading(false);
    }
  }

  // 渲染图谱
  useEffect(() => {
    if (!containerRef.current || !graphData || graphData.nodes.length === 0) {
      return;
    }

    // 销毁旧实例
    if (graphRef.current) {
      graphRef.current.destroy();
      graphRef.current = null;
    }

    const nodes = graphData.nodes.map((n) => ({
      id: String(n.id),
      data: {
        label: n.title,
        isDaily: n.is_daily,
        isPinned: n.is_pinned,
        tagCount: n.tag_count,
        linkCount: n.link_count,
      },
    }));

    const edges = graphData.edges.map((e, i) => ({
      id: `edge-${i}`,
      source: String(e.source),
      target: String(e.target),
    }));

    const graph = new Graph({
      container: containerRef.current,
      // 用对象写法：内容溢出才缩放（when: "overflow"），装得下就保持原尺寸；
      // 两者兼顾——首屏能看到全部节点，字也不会被无谓缩小
      autoFit: {
        type: "view",
        options: { when: "overflow", direction: "both" },
        animation: { duration: 300, easing: "ease-out" },
      },
      data: { nodes, edges },
      node: {
        style: {
          size: (d: any) => {
            const linkCount = d.data?.linkCount || 0;
            return Math.max(20, Math.min(52, 20 + linkCount * 6));
          },
          fill: (d: any) => {
            if (d.data?.isDaily) return token.colorWarning;
            if (d.data?.isPinned) return token.colorError;
            if ((d.data?.linkCount || 0) > 3) return token.colorPrimary;
            return token.colorPrimaryBg;
          },
          stroke: (d: any) => {
            if (d.data?.isDaily) return token.colorWarningBorder;
            if (d.data?.isPinned) return token.colorErrorBorder;
            return token.colorPrimaryBorder;
          },
          lineWidth: 2,
          labelText: (d: any) => {
            const label = d.data?.label || "";
            return label.length > 10 ? label.slice(0, 10) + "..." : label;
          },
          labelFontSize: 13,
          labelFontWeight: 500,
          labelFill: token.colorText,
          labelPlacement: "bottom",
          labelOffsetY: 6,
        },
      },
      edge: {
        style: {
          stroke: token.colorPrimary,
          strokeOpacity: 0.45,
          lineWidth: 1.5,
          endArrow: true,
          endArrowSize: 8,
          endArrowFill: token.colorPrimary,
        },
      },
      layout:
        layout === "d3-force"
          ? {
              // G6 v5 的 d3-force 走子对象 API（link / manyBody / collide / center）
              // 小图（<20 节点）用紧凑参数：节点不会散到画布外，autoFit 也就
              // 不需要缩放，字得以保持原尺寸
              type: "d3-force",
              link: { distance: 110, strength: 0.5 },
              manyBody: { strength: -180 },
              collide: { radius: 48, strength: 0.9 },
              center: { strength: 0.08 },
            }
          : layout === "radial"
            ? { type: "radial", unitRadius: 110, preventOverlap: true, nodeSize: 50 }
            : { type: layout },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
        {
          type: "click-select",
          multiple: false,
        },
      ],
    });

    graph.render();

    // 双击节点跳转到笔记
    graph.on("node:dblclick", (evt: any) => {
      const nodeId = evt.target?.id;
      if (nodeId) {
        navigate(`/notes/${nodeId}`);
      }
    });

    // 节点右键弹自定义菜单
    graph.on("node:contextmenu", (evt: any) => {
      // 阻止 WebView 默认右键菜单（不同 G6 版本字段名可能不同，逐个试）
      const native: MouseEvent | undefined =
        evt?.nativeEvent ?? evt?.originalEvent ?? evt?.event;
      native?.preventDefault?.();
      const nodeId = String(evt?.target?.id ?? "");
      if (!nodeId) return;
      const node = graphData.nodes.find((n) => String(n.id) === nodeId);
      const title = node?.title ?? "";
      const x = native?.clientX ?? evt?.client?.x ?? 0;
      const y = native?.clientY ?? evt?.client?.y ?? 0;
      ctx.open({ clientX: x, clientY: y }, { nodeId, title });
    });

    graphRef.current = graph;

    return () => {
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [graphData, layout, token]);

  function handleFitView() {
    graphRef.current?.fitView();
  }

  function handleFitCenter() {
    graphRef.current?.fitCenter();
  }

  function handleRefresh() {
    loadGraphData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spin size="large" tip="加载知识图谱..." />
      </div>
    );
  }

  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Empty description="暂无图谱数据，请先创建笔记并添加链接" />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      // 顶层兜底：节点右键由 G6 监听并自管 preventDefault；其他位置（画布空白 /
      // 工具栏 / 图例）右键不弹 WebView 默认菜单。本页无 input
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="font-semibold text-base"
            style={{ color: token.colorText }}
          >
            知识图谱
          </span>
          <span
            className="text-xs"
            style={{ color: token.colorTextSecondary }}
          >
            {graphData.nodes.length} 个节点 / {graphData.edges.length} 条连线
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Segmented
            size="small"
            value={layout}
            options={[
              { label: "力导向", value: "d3-force" },
              { label: "环形", value: "circular" },
              { label: "径向", value: "radial" },
              { label: "网格", value: "grid" },
            ]}
            onChange={(v) => setLayout(v as string)}
          />

          <div className="flex items-center gap-1 ml-2">
            <Tooltip title="适应画布">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleFitView}
              >
                <Maximize2 size={14} />
              </button>
            </Tooltip>
            <Tooltip title="居中">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleFitCenter}
              >
                <Minimize2 size={14} />
              </button>
            </Tooltip>
            <Tooltip title="刷新数据">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleRefresh}
              >
                <RotateCcw size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div
        className="flex items-center gap-4 px-4 py-1.5 text-xs shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorTextSecondary,
        }}
      >
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorPrimaryBg }}
          />
          普通笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorPrimary }}
          />
          热门笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorWarning }}
          />
          每日笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorError }}
          />
          置顶笔记
        </span>
        <span style={{ marginLeft: "auto" }}>双击节点打开笔记</span>
      </div>

      {/* 图谱画布 */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ minHeight: 0, background: token.colorBgLayout }}
      />

      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={menuItems}
        onClose={ctx.close}
      />
    </div>
  );
}
