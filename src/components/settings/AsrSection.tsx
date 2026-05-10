/**
 * 语音识别（ASR）设置区。
 *
 * 当前仅接入阿里云百炼 DashScope；通过 AsrProviderKind 抽象，未来增加新厂商
 * 只需扩 Provider 下拉与后端 enum 即可，UI 不变。
 *
 * - API Key 明文存到 app_config 表（与 ai_models.api_key 风格一致）
 * - 默认模型 qwen3-asr-flash：同步多模态 API，支持 base64 直传，无需轮询
 * - 「测试连接」仅校验鉴权，不消耗识别用量
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Typography,
  message,
  theme as antdTheme,
} from "antd";
import { Mic, ExternalLink, Share2, Download } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { asrApi } from "@/lib/api";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportAsrConfig, type Envelope } from "@/lib/configShare";
import type { AsrConfig } from "@/types";

const { Text, Paragraph } = Typography;

const PROVIDER_OPTIONS = [
  { value: "dashscope", label: "阿里云百炼 DashScope" },
];

const MODEL_OPTIONS = [
  {
    value: "qwen3-asr-flash",
    label: "qwen3-asr-flash（推荐 · 同步多模态 API · 支持 base64 直传）",
  },
];

const REGION_OPTIONS = [
  { value: "beijing", label: "中国（北京）" },
  { value: "singapore", label: "国际（新加坡）" },
];

const APPLY_KEY_URL = "https://bailian.console.aliyun.com/";

const DEFAULT_CONFIG: AsrConfig = {
  provider: "dashscope",
  apiKey: "",
  model: "qwen3-asr-flash",
  region: "beijing",
  enabled: false,
};

export function AsrSection() {
  const { token } = antdTheme.useToken();
  const [cfg, setCfg] = useState<AsrConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  async function reloadConfig() {
    setLoading(true);
    try {
      const remote = await asrApi.getConfig();
      setCfg(remote);
    } catch (e) {
      message.error(`读取语音识别配置失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  function handleShare() {
    if (!cfg.apiKey.trim()) {
      message.warning("当前还没填 API Key，没什么可分享的");
      return;
    }
    setShareEnv(exportAsrConfig(cfg));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await asrApi.getConfig();
        if (!cancelled) setCfg(remote);
      } catch (e) {
        message.error(`读取语音识别配置失败：${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof AsrConfig>(key: K, value: AsrConfig[K]) {
    setCfg((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (cfg.enabled && !cfg.apiKey.trim()) {
      message.warning("启用语音识别前必须填写 API Key");
      return;
    }
    setSaving(true);
    try {
      await asrApi.saveConfig(cfg);
      message.success("已保存");
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!cfg.apiKey.trim()) {
      message.warning("请先填写 API Key");
      return;
    }
    setTesting(true);
    try {
      const result = await asrApi.testConnection(cfg);
      if (result.ok) {
        message.success(`连接正常（${result.latencyMs} ms）`);
      } else {
        message.error(`连接失败：${result.message ?? "未知原因"}`);
      }
    } catch (e) {
      message.error(`测试失败：${e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card
      id="settings-asr"
      size="small"
      className="mb-4"
      title={
        <span className="flex items-center gap-2">
          <Mic size={16} style={{ color: token.colorPrimary }} />
          语音识别
        </span>
      }
      extra={
        <Space size={4}>
          <Button
            size="small"
            icon={<Share2 size={14} />}
            onClick={handleShare}
            title="分享到其他设备（含加密）"
          >
            分享
          </Button>
          <Button
            size="small"
            icon={<Download size={14} />}
            onClick={() => setImportOpen(true)}
            title="从 JSON / 二维码导入"
          >
            导入
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        className="mb-3"
        message="通过云端 API 把语音转成文字"
        description={
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <Paragraph style={{ marginBottom: 4, fontSize: 12 }}>
              <Text strong style={{ fontSize: 12 }}>使用步骤：</Text>
              ① 去
              <Typography.Link
                onClick={() => openUrl(APPLY_KEY_URL)}
                style={{ fontSize: 12, margin: "0 2px" }}
              >
                阿里云百炼控制台
              </Typography.Link>
              申请 API Key → ② 粘到下方并保存 → ③ 启用开关后即可在录音组件中使用。
            </Paragraph>
            <Paragraph style={{ marginBottom: 0, fontSize: 12 }} type="secondary">
              仅本地保存 Key，应用本身不打包语音模型，识别由阿里云在云端完成（按用量计费，注册即送免费额度）。
            </Paragraph>
          </div>
        }
      />

      <Form layout="vertical" disabled={loading} size="small">
        <Form.Item label="启用">
          <Switch
            checked={cfg.enabled}
            onChange={(v) => update("enabled", v)}
          />
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            未启用时录音组件按钮会置灰
          </Text>
        </Form.Item>

        <Form.Item label="服务商">
          <Select
            value={cfg.provider}
            options={PROVIDER_OPTIONS}
            onChange={(v) => update("provider", v)}
            style={{ maxWidth: 320 }}
          />
        </Form.Item>

        <Form.Item
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              API Key
              <Typography.Link
                onClick={() => openUrl(APPLY_KEY_URL)}
                style={{
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                去申请 <ExternalLink size={12} />
              </Typography.Link>
            </span>
          }
        >
          <Input.Password
            value={cfg.apiKey}
            onChange={(e) => update("apiKey", e.target.value)}
            placeholder="sk-xxxxxxxxxxxxxxxx"
            autoComplete="off"
            style={{ maxWidth: 480 }}
          />
        </Form.Item>

        <Form.Item label="模型">
          <Select
            value={cfg.model}
            options={MODEL_OPTIONS}
            onChange={(v) => update("model", v)}
            style={{ maxWidth: 480 }}
          />
        </Form.Item>

        <Form.Item label="区域">
          <Select
            value={cfg.region}
            options={REGION_OPTIONS}
            onChange={(v) => update("region", v)}
            style={{ maxWidth: 320 }}
          />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Space>
            <Button type="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
            <Button onClick={handleTest} loading={testing}>
              测试连接
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />
      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void reloadConfig()}
      />
    </Card>
  );
}
