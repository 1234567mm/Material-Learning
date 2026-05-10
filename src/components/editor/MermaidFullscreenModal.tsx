/**
 * Mermaid 全屏查看器 —— 复杂图看不清的解决方案
 *
 * 行为：
 *   · 全屏 Modal 占满 90% 视窗
 *   · 滚轮缩放（围绕鼠标位置缩放，符合直觉）
 *   · 拖拽平移
 *   · 工具栏：+ / − / 100% / 适应窗口
 *   · ESC 关闭（antd Modal 自带）
 *
 * 实现选择：自写 transform pan-zoom 而非依赖 panzoom 库
 *   · 增量约 80 行，完全可控
 *   · 不增加首屏体积
 *   · 可针对 Mermaid SVG 居中、初始 fit 做精细化
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Button, Tooltip, Space, theme as antdTheme } from "antd";
import { ZoomIn, ZoomOut, Maximize, Square } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 已经渲染好的 SVG html 字符串（直接复用 MermaidPreview 的产物） */
  svgHtml: string;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const SCALE_STEP = 1.2;

export function MermaidFullscreenModal({ open, onClose, svgHtml }: Props) {
  const { token } = antdTheme.useToken();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stageElRef = useRef<HTMLDivElement | null>(null);

  // 用 ref 存当前 transform，因为 wheel/drag 高频触发，避免 setState 闭包陷阱
  // 和"嵌套 setState updater"的反模式。React 渲染态再用 useState 镜像出来。
  const scaleRef = useRef(1);
  const txRef = useRef(0);
  const tyRef = useRef(0);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  const apply = useCallback((s: number, x: number, y: number) => {
    scaleRef.current = s;
    txRef.current = x;
    tyRef.current = y;
    setScale(s);
    setTx(x);
    setTy(y);
  }, []);

  // 适应窗口：把 SVG 居中并按容器缩放比例显示完整
  const fit = useCallback(() => {
    const stage = stageElRef.current;
    const content = contentRef.current;
    if (!stage || !content) return;
    const svg = content.querySelector("svg") as SVGElement | null;
    if (!svg) return;
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const bbox = svg.getBoundingClientRect();
    const naturalW = bbox.width / scaleRef.current;
    const naturalH = bbox.height / scaleRef.current;
    if (naturalW === 0 || naturalH === 0) return;
    const fitScale = Math.min(stageW / naturalW, stageH / naturalH, 1) * 0.95;
    apply(fitScale, 0, 0);
  }, [apply]);

  // 打开时初始化为 fit；svgHtml 变更也重 fit
  useEffect(() => {
    if (!open) return;
    apply(1, 0, 0);
    const t = setTimeout(() => fit(), 80);
    return () => clearTimeout(t);
  }, [open, svgHtml, apply, fit]);

  // 拖拽状态（ref 即可，不进 React 渲染）
  const draggingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    lastRef.current = { x: e.clientX, y: e.clientY };
  };
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !lastRef.current) return;
      const dx = e.clientX - lastRef.current.x;
      const dy = e.clientY - lastRef.current.y;
      lastRef.current = { x: e.clientX, y: e.clientY };
      apply(scaleRef.current, txRef.current + dx, tyRef.current + dy);
    };
    const onUp = () => {
      draggingRef.current = false;
      lastRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [open, apply]);

  /**
   * stage 用 callback ref 而非 useRef + useEffect 监听 open。
   * Modal 用 destroyOnHidden 时 DOM 是开/关重建的，普通 useRef 在 useEffect
   * 里拿可能为 null（dom 还没挂），且无法在 dom 出现时再次跑。callback ref
   * 确保 wheel listener 精确在 stage 元素出现时附上、消失时撤掉。
   */
  const setStageEl = useCallback(
    (el: HTMLDivElement | null) => {
      // 撤掉旧的
      if (stageElRef.current) {
        // listener 用闭包；用同名 fn 标记保证能 remove
        const old = (stageElRef.current as HTMLDivElement & { __wheelHandler?: (e: WheelEvent) => void });
        if (old.__wheelHandler) {
          old.removeEventListener("wheel", old.__wheelHandler);
          old.__wheelHandler = undefined;
        }
      }
      stageElRef.current = el;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        // 鼠标相对舞台中心（与 transform-origin: center center 对应）
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const factor = e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
        const next = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, scaleRef.current * factor),
        );
        const realFactor = next / scaleRef.current;
        // 让鼠标点的图坐标在缩放后保持不动
        const newTx = mx - (mx - txRef.current) * realFactor;
        const newTy = my - (my - tyRef.current) * realFactor;
        apply(next, newTx, newTy);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      (el as HTMLDivElement & { __wheelHandler?: (e: WheelEvent) => void }).__wheelHandler = onWheel;
    },
    [apply],
  );

  const zoomBy = (factor: number) => {
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, scaleRef.current * factor),
    );
    apply(next, txRef.current, tyRef.current);
  };
  const reset100 = () => apply(1, 0, 0);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="92vw"
      style={{ top: 24, paddingBottom: 0 }}
      styles={{ body: { padding: 0, height: "calc(100vh - 96px)" } }}
      title={
        <div className="flex items-center justify-between" style={{ paddingRight: 32 }}>
          <span>Mermaid 全屏查看</span>
          <Space>
            <Tooltip title="缩小">
              <Button size="small" icon={<ZoomOut size={14} />} onClick={() => zoomBy(1 / SCALE_STEP)} />
            </Tooltip>
            <Tooltip title="放大">
              <Button size="small" icon={<ZoomIn size={14} />} onClick={() => zoomBy(SCALE_STEP)} />
            </Tooltip>
            <Tooltip title="100%">
              <Button size="small" icon={<Square size={14} />} onClick={reset100} />
            </Tooltip>
            <Tooltip title="适应窗口">
              <Button size="small" icon={<Maximize size={14} />} onClick={fit} />
            </Tooltip>
            <span style={{ fontSize: 12, color: token.colorTextTertiary, marginLeft: 4 }}>
              {Math.round(scale * 100)}%
            </span>
          </Space>
        </div>
      }
      destroyOnHidden
    >
      <div
        ref={setStageEl}
        onMouseDown={handleMouseDown}
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: token.colorBgLayout,
          cursor: "grab",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          ref={contentRef}
          // SVG 直接 dangerouslySetInnerHTML：复用 MermaidPreview 已渲染产物，零重复成本
          dangerouslySetInnerHTML={{ __html: svgHtml }}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: draggingRef.current ? "none" : "transform 80ms ease-out",
            userSelect: "none",
            // 让内部 SVG 不被裁剪
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 12,
            fontSize: 11,
            color: token.colorTextTertiary,
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          滚轮缩放 · 拖拽平移 · ESC 关闭
        </div>
      </div>
    </Modal>
  );
}
