import { useState, useEffect } from "react";
import {
  Alert,
  Checkbox,
  Input,
  Modal,
  Spin,
  message,
  theme as antdTheme,
} from "antd";
import { Lock, Unlock, ShieldAlert, KeyRound } from "lucide-react";
import { vaultApi } from "@/lib/api";
import type { VaultStatus } from "@/types";

interface VaultModalProps {
  open: boolean;
  /** 打开时预期的动作：setup（首次设置）或 unlock（已设置时解锁） */
  mode: "setup" | "unlock";
  onClose: () => void;
  /** 成功 setup 或 unlock 后回调（vault 已解锁） */
  onSuccess?: () => void;
}

/**
 * T-007 Vault 主密码 Modal
 *
 * 两种模式共用一个组件：
 * - `mode="setup"` 首次设置：输两次新密码 + 3 个"我知道忘记等于丢数据"复选框 + 提交
 * - `mode="unlock"` 解锁：输一次密码 + 校验 + 成功回调
 *
 * 不处理"更换密码"流程（v1 不做，T-007b 再加）。
 */
export function VaultModal({ open, mode, onClose, onSuccess }: VaultModalProps) {
  const { token } = antdTheme.useToken();
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [acks, setAcks] = useState({ a: false, b: false, c: false });
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setPassword2("");
      setAcks({ a: false, b: false, c: false });
      setErrorText(null);
      setBusy(false);
    }
  }, [open]);

  async function handleSubmit() {
    setErrorText(null);

    if (mode === "setup") {
      if (password.length < 6) {
        setErrorText("主密码至少 6 个字符");
        return;
      }
      if (password !== password2) {
        setErrorText("两次输入的密码不一致");
        return;
      }
      if (!acks.a || !acks.b || !acks.c) {
        setErrorText("请勾选全部 3 项风险确认");
        return;
      }
      setBusy(true);
      try {
        await vaultApi.setup(password);
        message.success("主密码已设置，vault 已解锁");
        onSuccess?.();
        onClose();
      } catch (e) {
        setErrorText(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    // unlock
    if (!password) {
      setErrorText("请输入主密码");
      return;
    }
    setBusy(true);
    try {
      await vaultApi.unlock(password);
      message.success("已解锁");
      onSuccess?.();
      onClose();
    } catch (e) {
      setErrorText(String(e));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "setup" ? (
      <div className="flex items-center gap-2">
        <KeyRound size={16} style={{ color: token.colorWarning }} />
        <span>设置主密码（首次）</span>
      </div>
    ) : (
      <div className="flex items-center gap-2">
        <Unlock size={16} style={{ color: token.colorPrimary }} />
        <span>解锁笔记保险库</span>
      </div>
    );

  return (
    <Modal
      title={title}
      open={open}
      onCancel={busy ? undefined : onClose}
      onOk={handleSubmit}
      confirmLoading={busy}
      okText={mode === "setup" ? "设置并解锁" : "解锁"}
      cancelText="取消"
      destroyOnHidden
      mask={{ closable: !busy }}
      centered
      width={520}
    >
      {mode === "setup" && (
        <div className="flex flex-col gap-3">
          <Alert
            type="warning"
            showIcon
            icon={<ShieldAlert size={16} />}
            message="主密码一旦忘记，所有加密笔记数据永久不可恢复"
            description="本地应用不会上传密码，也没有任何恢复手段。请务必记住或写在安全的地方。"
          />

          <div>
            <div
              style={{
                fontSize: 13,
                color: token.colorTextSecondary,
                marginBottom: 4,
              }}
            >
              新主密码（至少 6 个字符）
            </div>
            <Input.Password
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码"
              autoComplete="new-password"
            />
          </div>
          <div>
            <div
              style={{
                fontSize: 13,
                color: token.colorTextSecondary,
                marginBottom: 4,
              }}
            >
              确认密码
            </div>
            <Input.Password
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="再次输入"
              autoComplete="new-password"
              onPressEnter={handleSubmit}
            />
          </div>

          <div className="flex flex-col gap-2 mt-2" style={{ fontSize: 13 }}>
            <Checkbox
              checked={acks.a}
              onChange={(e) => setAcks((p) => ({ ...p, a: e.target.checked }))}
            >
              我已确认会记住此密码（写在密码管理器或可靠的地方）
            </Checkbox>
            <Checkbox
              checked={acks.b}
              onChange={(e) => setAcks((p) => ({ ...p, b: e.target.checked }))}
            >
              我明白忘记密码 ={" "}
              <strong style={{ color: token.colorError }}>所有加密笔记永久不可读</strong>
              （没有"找回密码"功能）
            </Checkbox>
            <Checkbox
              checked={acks.c}
              onChange={(e) => setAcks((p) => ({ ...p, c: e.target.checked }))}
            >
              我会定期导出 Markdown 备份（设置页 → 导出）
            </Checkbox>
          </div>

          {errorText && (
            <Alert type="error" showIcon message={errorText} />
          )}
        </div>
      )}

      {mode === "unlock" && (
        <div className="flex flex-col gap-3">
          <Alert
            type="info"
            showIcon
            icon={<Lock size={16} />}
            message="本会话未解锁。输入主密码以查看 / 编辑加密笔记。"
          />
          <Input.Password
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="主密码"
            autoFocus
            autoComplete="current-password"
            onPressEnter={handleSubmit}
            disabled={busy}
          />
          {busy && (
            <div
              style={{ fontSize: 12, color: token.colorTextTertiary }}
              className="flex items-center gap-2"
            >
              <Spin size="small" />
              正在校验密码…
            </div>
          )}
          {errorText && (
            <Alert type="error" showIcon message={errorText} />
          )}
        </div>
      )}
    </Modal>
  );
}

/** 便捷 hook：读取当前 vault 状态（首次打开 / 页面切换时查询） */
export function useVaultStatus(): {
  status: VaultStatus | null;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<VaultStatus | null>(null);

  async function refresh() {
    try {
      const s = await vaultApi.status();
      setStatus(s);
    } catch (e) {
      console.error("vault status failed:", e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return { status, refresh };
}
