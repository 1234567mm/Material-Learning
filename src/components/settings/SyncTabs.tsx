/**
 * 同步与备份合一面板（T-024 epic 收尾）
 *
 * 把"多端同步 V1"和"整库 ZIP 备份 V0"两个语义完全不同的能力放在 Tabs 里：
 * - 默认 tab = 多端同步（V1）：单笔记粒度，多端实时协作的主用法
 * - 第二 tab = 备份与恢复（V0）：周期整库快照，灾备 / 误删找回
 *
 * 顶部 Alert 用一段话讲清两者区别，避免用户困惑。两者数据存储互不冲突，
 * 同一个 WebDAV 目录可以共用（V0 上传 kb-sync-*.zip / V1 上传 manifest.json + notes/*.md）。
 */
import { Card, Tabs, Typography, theme as antdTheme } from "antd";
import { CloudCog, Archive } from "lucide-react";
import { SyncSection } from "./SyncSection";
import { SyncV1Section } from "./SyncV1Section";

const { Text } = Typography;

export function SyncTabs() {
  const { token } = antdTheme.useToken();

  return (
    <Card
      size="small"
      className="mt-4"
      title={
        <span className="flex items-center gap-2">
          <CloudCog size={16} style={{ color: token.colorPrimary }} />
          数据同步与备份
        </span>
      }
    >
      <div className="mb-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <Text strong style={{ fontSize: 12 }}>备份 vs 同步</Text> — 是两个不同的能力，可以同时使用。
        </Text>
        <ul className="my-1 pl-5" style={{ fontSize: 12, lineHeight: 1.7, color: "var(--ant-color-text-secondary)" }}>
          <li>
            <Text strong style={{ fontSize: 12 }}>多端同步</Text>
            ：实时增量，多台机器轮流改同一份笔记不会互相覆盖（last-write-wins + 冲突文件）。
            适合「办公电脑 ↔ 家用电脑」「电脑 + iCloud Drive 备份」等协作场景。
          </li>
          <li>
            <Text strong style={{ fontSize: 12 }}>备份与恢复</Text>
            ：把整个知识库（数据库 + 附件）打包成一个 ZIP 推到云端，是时间点快照。
            适合「误删找回」「重装系统迁移」「跨大版本回退」等灾备场景。
          </li>
          <li>
            两者数据存储互不冲突——同一个 WebDAV 目录里 V0 写
            <Text code style={{ fontSize: 11 }}>kb-sync-&lt;host&gt;.zip</Text>，V1 写
            <Text code style={{ fontSize: 11 }}>manifest.json + notes/*.md</Text>，互不覆盖。
          </li>
        </ul>
      </div>

      <Tabs
        defaultActiveKey="v1"
        items={[
          {
            key: "v1",
            label: (
              <span className="flex items-center gap-1.5">
                <CloudCog size={14} />
                多端同步
              </span>
            ),
            children: <SyncV1Section />,
          },
          {
            key: "v0",
            label: (
              <span className="flex items-center gap-1.5">
                <Archive size={14} />
                备份与恢复
              </span>
            ),
            children: <SyncSection />,
          },
        ]}
      />
    </Card>
  );
}
