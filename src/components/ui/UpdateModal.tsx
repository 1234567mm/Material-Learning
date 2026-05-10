import { useState, useRef } from "react";
import { Modal, Button, Progress, Typography, Space } from "antd";
import { CheckCircleOutlined, SyncOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";

const { Text, Paragraph } = Typography;

/**
 * 自动更新失败时的"手动下载"备选地址。
 * 顺序与 tauri.conf.json 的 updater.endpoints 一致：R2 → Gitee → GitHub。
 * R2 是裸文件存储没有 release 页，所以只暴露 Gitee / GitHub 两个 release 页。
 */
const FALLBACK_DOWNLOAD_PAGES = [
  {
    label: "Gitee Releases（国内推荐）",
    url: "https://gitee.com/bkywksj/knowledge-base-release/releases",
  },
  {
    label: "GitHub Releases（海外）",
    url: "https://github.com/bkywksj/knowledge-base-release/releases",
  },
];

type UpdateStatus = "found" | "downloading" | "downloaded";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  update: Update | null;
}

export function UpdateModal({ open, onClose, update }: UpdateModalProps) {
  const [status, setStatus] = useState<UpdateStatus>("found");
  const [progress, setProgress] = useState(0);
  const [downloadedSize, setDownloadedSize] = useState(0);
  const [totalSize, setTotalSize] = useState(0);
  const totalSizeRef = useRef(0);

  async function handleInstall() {
    if (!update) return;

    setStatus("downloading");
    setProgress(0);

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalSizeRef.current = event.data.contentLength;
          setTotalSize(event.data.contentLength);
        } else if (event.event === "Progress") {
          setDownloadedSize((prev) => {
            const newSize = prev + event.data.chunkLength;
            if (totalSizeRef.current > 0) {
              setProgress(Math.round((newSize / totalSizeRef.current) * 100));
            }
            return newSize;
          });
        } else if (event.event === "Finished") {
          setStatus("downloaded");
          setProgress(100);
        }
      });

      setStatus("downloaded");
    } catch (e) {
      // 自动更新走的是 update.json 里写死的 URL，updater 不会自动切端点。
      // 下载失败 90% 是用户本地网络问题（防火墙/断网/CDN 卡），列出 Gitee /
      // GitHub release 页让用户挑一个能访问的手动下载，比"光显示错误"友好得多。
      Modal.error({
        title: "更新下载失败",
        icon: <ExclamationCircleOutlined />,
        width: 480,
        content: (
          <div>
            <Paragraph style={{ marginBottom: 12 }}>
              <Text>自动下载失败，建议从下方任一镜像页手动下载安装：</Text>
            </Paragraph>
            <Space direction="vertical" style={{ width: "100%" }}>
              {FALLBACK_DOWNLOAD_PAGES.map((page) => (
                <Button
                  key={page.url}
                  block
                  onClick={() => void openUrl(page.url)}
                  style={{ textAlign: "left" }}
                >
                  {page.label}
                </Button>
              ))}
            </Space>
            <Paragraph
              type="secondary"
              style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
            >
              错误详情：{String(e)}
            </Paragraph>
          </div>
        ),
        okText: "知道了",
      });
      setStatus("found");
    }
  }

  async function handleRelaunch() {
    await relaunch();
  }

  function handleClose() {
    if (status === "downloading") return;
    setStatus("found");
    setProgress(0);
    setDownloadedSize(0);
    setTotalSize(0);
    onClose();
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <Modal
      title="软件更新"
      open={open}
      onCancel={handleClose}
      closable={status !== "downloading"}
      mask={{ closable: status !== "downloading" }}
      footer={
        status === "found" ? (
          <Space>
            <Button onClick={handleClose}>稍后</Button>
            <Button type="primary" onClick={handleInstall}>
              安装更新
            </Button>
          </Space>
        ) : status === "downloaded" ? (
          <Button type="primary" onClick={handleRelaunch}>
            重启应用
          </Button>
        ) : null
      }
    >
      {update && (
        <div>
          <Paragraph>
            <Text strong>新版本：</Text>
            <Text>{update.version}</Text>
          </Paragraph>

          {update.body && (
            <Paragraph>
              <Text strong>更新日志：</Text>
              <div
                className="mt-2 p-3 rounded-md"
                style={{ background: "rgba(0,0,0,0.04)", maxHeight: 200, overflow: "auto" }}
              >
                <Text style={{ whiteSpace: "pre-wrap" }}>{update.body}</Text>
              </div>
            </Paragraph>
          )}

          {status === "downloading" && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <SyncOutlined spin />
                <Text>正在下载更新...</Text>
              </div>
              <Progress percent={progress} />
              {totalSize > 0 && (
                <Text type="secondary" className="text-xs">
                  {formatSize(downloadedSize)} / {formatSize(totalSize)}
                </Text>
              )}
            </div>
          )}

          {status === "downloaded" && (
            <div className="mt-4 flex items-center gap-2">
              <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 18 }} />
              <Text>下载完成，重启应用以完成更新</Text>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
