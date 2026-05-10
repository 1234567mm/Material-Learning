/**
 * Mermaid 渲染组件 —— 把 mermaid 源码渲染成 SVG。
 *
 * - mermaid 包体积大（~600KB gzip），首次需要时才动态 import，并把 promise
 *   缓存到模块作用域，避免重复加载
 * - 主题跟随 themeCategory：暗色主题用 mermaid 内置 "dark"，其他用 "default"
 * - render 异常时显示错误而非崩溃 NodeView，源码仍可读
 * - securityLevel: "strict" 阻断标签里的 <script>，符合 Tauri WebView 安全模式
 */
import { useEffect, useState } from "react";
import { Tooltip } from "antd";
import { Maximize2 } from "lucide-react";
import { useAppStore } from "@/store";
import { MermaidFullscreenModal } from "./MermaidFullscreenModal";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default as MermaidApi);
  }
  return mermaidPromise;
}

/**
 * 规范化 mermaid 源码——只清理"肉眼不可见"的捣乱字符，不碰用户可能故意写的
 * 中文标点（中文括号/引号/冒号常用于 label，不能动）。
 *
 * 触发场景：从微信/网页/Word 复制 mermaid 代码，或不同电脑的输入法状态差异，
 * 会带入 BOM / 零宽空格 / NBSP / 全角空格，导致 mermaid v11 报 Syntax error in text。
 */
function sanitizeMermaidSource(code: string): string {
  return code
    // BOM（U+FEFF）：通常出现在开头，但任何位置都清掉
    .replace(/\uFEFF/g, "")
    // 零宽字符：U+200B(ZWSP) / U+200C(ZWNJ) / U+200D(ZWJ) / U+2060(WJ)
    .replace(/[\u200B-\u200D\u2060]/g, "")
    // 不间断空格 NBSP（U+00A0）→ 普通空格
    .replace(/\u00A0/g, " ")
    // 全角空格 / 表意空格（U+3000）→ 普通空格
    .replace(/\u3000/g, " ")
    // 行尾 CR（CRLF → LF），mermaid 解析器对 \r 偶发敏感
    .replace(/\r\n?/g, "\n");
}

let renderCounter = 0;

export function MermaidPreview({
  code,
  onClick,
}: {
  code: string;
  onClick?: () => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const themeCategory = useAppStore((s) => s.themeCategory);

  useEffect(() => {
    let cancelled = false;
    if (!code.trim()) {
      setSvg(null);
      setError(null);
      return;
    }
    (async () => {
      const cleaned = sanitizeMermaidSource(code);
      try {
        const mermaid = await loadMermaid();
        // 每次渲染前重设主题：用户切主题后下次渲染就能跟上
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: themeCategory === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });
        renderCounter += 1;
        const id = `mermaid-${Date.now()}-${renderCounter}`;
        const result = await mermaid.render(id, cleaned);
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          // 解析失败时把可疑字符的 codepoint 一起打到控制台，方便定位"看着对但报错"的输入
          const suspicious = [...cleaned]
            .map((ch, i) => {
              const cp = ch.codePointAt(0) ?? 0;
              return cp > 0x7f ? `${i}:U+${cp.toString(16).toUpperCase()}(${ch})` : null;
            })
            .filter(Boolean);
          if (suspicious.length > 0) {
            console.warn("[Mermaid] 非 ASCII 字符位置：", suspicious);
          }
          setError(e instanceof Error ? e.message : String(e));
          setSvg(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, themeCategory]);

  if (error) {
    return (
      <div
        className="mermaid-preview mermaid-preview-error"
        onClick={onClick}
        style={{
          padding: "12px 16px",
          border: "1px solid #ff7875",
          borderRadius: 6,
          background: "rgba(255,77,79,0.05)",
          cursor: onClick ? "pointer" : "default",
        }}
      >
        <div style={{ fontWeight: 600, color: "#cf1322", marginBottom: 4 }}>
          Mermaid 渲染失败（点击编辑源码）
        </div>
        <pre
          style={{
            fontSize: 12,
            opacity: 0.75,
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {error}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className="mermaid-preview mermaid-preview-loading"
        onClick={onClick}
        style={{
          padding: "20px",
          textAlign: "center",
          opacity: 0.6,
          fontSize: 12,
          cursor: onClick ? "pointer" : "default",
        }}
      >
        加载中…
      </div>
    );
  }

  return (
    <div
      className="mermaid-preview"
      style={{
        position: "relative",
        padding: "12px 16px",
        textAlign: "center",
        overflow: "auto",
      }}
    >
      {/* 渲染产物来自 mermaid 库（securityLevel: strict 已过滤 <script>），
          这里直接吐 SVG；mermaid 内部用了 dompurify */}
      <div
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: svg }}
        style={{ cursor: onClick ? "pointer" : "default" }}
      />
      {/* 右上角"全屏"按钮：hover 显形，点开 panzoom Modal 看复杂图。
          关键：必须 stopPropagation onMouseDown —— ProseMirror 用 mousedown
          移光标到代码块内部，会把 cursorInBlock=true，把整个预览（含 Modal）卸载，
          看起来"点全屏 = 进编辑"。click 也阻塞做双保险，且 contenteditable=false
          告诉 PM 这是非编辑区。 */}
      <Tooltip title="全屏查看（滚轮缩放 / 拖拽平移）">
        <button
          type="button"
          aria-label="全屏查看"
          className="mermaid-preview__fullscreen-btn"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setFullscreenOpen(true);
          }}
        >
          <Maximize2 size={14} />
        </button>
      </Tooltip>
      <MermaidFullscreenModal
        open={fullscreenOpen}
        onClose={() => setFullscreenOpen(false)}
        svgHtml={svg}
      />
    </div>
  );
}
