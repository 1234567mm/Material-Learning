import { Component, type ReactNode } from "react";
import { Button, Result, Space, Typography, message } from "antd";
import { useRouteError } from "react-router-dom";

const { Paragraph, Text } = Typography;

/**
 * 识别"用户的 WebView 不支持 ES2018+ 正则语法"这一类系统环境兼容错误。
 *
 * Why: TipTap 内部用了 lookbehind `(?<!...)`，老 macOS / 老 Linux webkit2gtk
 *      / 老 Edge WebView2 解析时会抛 `Invalid regular expression: invalid
 *      group specifier name`，全屏崩溃。识别后给用户"是环境问题，不是 app
 *      问题"的友好提示 + 升级指引，避免被打差评。
 */
function isWebViewIncompatibleError(err: Error | null): boolean {
  if (!err) return false;
  const msg = `${err.name} ${err.message}`.toLowerCase();
  return (
    msg.includes("invalid group specifier") ||
    msg.includes("invalid regular expression") ||
    msg.includes("invalid regexp")
  );
}

/** 把错误对象拍平成可复制的纯文本（含 stack） */
function formatErrorForCopy(err: unknown): string {
  if (err instanceof Error) {
    return [
      `Name: ${err.name}`,
      `Message: ${err.message}`,
      `UA: ${navigator.userAgent}`,
      "",
      "Stack:",
      err.stack ?? "(no stack)",
    ].join("\n");
  }
  return `${String(err)}\nUA: ${navigator.userAgent}`;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success("错误信息已复制");
  } catch {
    message.error("复制失败，请手动选中下方文本");
  }
}

/**
 * 错误展示主体。两种触发源共用：
 *   1. <ErrorBoundary>（React class 组件，组件渲染期错误）
 *   2. <RouteErrorFallback>（react-router errorElement，路由内同步错误）
 */
function ErrorDisplay({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry?: () => void;
}) {
  const incompatible = isWebViewIncompatibleError(error);

  if (incompatible) {
    return (
      <Result
        status="warning"
        title="您的系统 WebView 版本过旧"
        subTitle={
          <Space direction="vertical" size={4}>
            <Text>笔记编辑器需要较新版本的浏览器内核才能运行。</Text>
            <Text type="secondary">
              错误原因：当前 WebView 不支持 ES2018+ 正则语法（lookbehind）
            </Text>
          </Space>
        }
        extra={
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Paragraph style={{ marginBottom: 0, textAlign: "left" }}>
              <Text strong>请按下列指引升级系统组件：</Text>
              <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                <li>
                  <Text strong>Windows：</Text>升级 Microsoft Edge WebView2
                  Runtime（控制面板 → 程序 → 检查更新）
                </li>
                <li>
                  <Text strong>macOS：</Text>系统更新到 macOS 13.3 或更高版本
                </li>
                <li>
                  <Text strong>Linux：</Text>升级 webkit2gtk 到 2.40 或更高版本
                  （Ubuntu 23.04+ / Fedora 38+）
                </li>
              </ul>
            </Paragraph>
            <Space>
              <Button
                type="primary"
                onClick={() => copyToClipboard(formatErrorForCopy(error))}
              >
                复制错误信息
              </Button>
              {onRetry && <Button onClick={onRetry}>重试</Button>}
              <Button onClick={() => window.location.reload()}>刷新</Button>
            </Space>
          </Space>
        }
      />
    );
  }

  return (
    <Result
      status="error"
      title="页面出错了"
      subTitle={error?.message || "未知错误"}
      extra={
        <Space>
          <Button
            type="primary"
            onClick={() => copyToClipboard(formatErrorForCopy(error))}
          >
            复制错误信息
          </Button>
          {onRetry && <Button onClick={onRetry}>重试</Button>}
          <Button onClick={() => window.location.reload()}>刷新</Button>
        </Space>
      }
    />
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorDisplay
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: null })}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * 给 react-router 路由的 `errorElement` 用：路由渲染期抛错时
 * router 会渲染本组件（替代 v7 默认的"Hey developer"开发警告页）。
 */
export function RouteErrorFallback() {
  const err = useRouteError();
  const error = err instanceof Error ? err : new Error(String(err));
  return <ErrorDisplay error={error} />;
}
