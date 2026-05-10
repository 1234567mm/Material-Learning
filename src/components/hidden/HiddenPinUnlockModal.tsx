import { useEffect, useRef, useState } from "react";
import { Modal, Input, Alert, message, Typography } from "antd";
import type { InputRef } from "antd";
import { EyeOff } from "lucide-react";
import { hiddenPinApi } from "@/lib/api";
import { useAppStore } from "@/store";

const { Text } = Typography;

interface Props {
  open: boolean;
  /** 校验通过时回调（也会自动 markHiddenUnlocked + 关闭 Modal） */
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * 隐藏笔记 PIN 解锁弹窗。
 * 校验逻辑全在后端：错误次数限制、锁定提示都来自 invoke 抛出的字符串。
 */
export function HiddenPinUnlockModal({ open, onSuccess, onCancel }: Props) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const markHiddenUnlocked = useAppStore((s) => s.markHiddenUnlocked);

  // 打开时自动聚焦 + 清空上次输入 + 拉提示
  useEffect(() => {
    if (open) {
      setPin("");
      setErrorMsg(null);
      setShowHint(false);
      // 等 Modal 渲染完再 focus（antd Modal 有动画）
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      // 异步拉取提示，没有则什么也不显示
      hiddenPinApi
        .getHint()
        .then((h) => setHint(h && h.trim() ? h : null))
        .catch(() => setHint(null));
      return () => clearTimeout(t);
    }
  }, [open]);

  async function handleSubmit() {
    if (!pin.trim()) {
      setErrorMsg("请输入 PIN");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await hiddenPinApi.verify(pin);
      markHiddenUnlocked();
      message.success("已解锁");
      onSuccess();
    } catch (e) {
      setErrorMsg(String(e));
      setPin("");
      // 失败后重新聚焦方便重试
      setTimeout(() => inputRef.current?.focus(), 50);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title={
        <span className="flex items-center gap-2">
          <EyeOff size={18} />
          解锁隐藏笔记
        </span>
      }
      okText="解锁"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleSubmit}
      onCancel={onCancel}
      destroyOnHidden
      mask={{ closable: false }}
      width={420}
    >
      <div className="flex flex-col gap-3">
        <Text type="secondary" style={{ fontSize: 13 }}>
          输入 PIN 即可访问隐藏笔记列表，10 分钟内无需重复验证。
        </Text>
        <Input.Password
          ref={inputRef}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onPressEnter={handleSubmit}
          placeholder="请输入 PIN"
          autoComplete="off"
          maxLength={64}
        />
        {/* 密码提示：默认收起，点"忘记 PIN？"才展开，避免有人在屏幕旁瞥见 */}
        {hint && !showHint && (
          <a
            onClick={(e) => {
              e.preventDefault();
              setShowHint(true);
            }}
            style={{ fontSize: 12, alignSelf: "flex-start" }}
          >
            忘记 PIN？查看提示
          </a>
        )}
        {hint && showHint && (
          <Alert
            type="info"
            showIcon
            message={
              <span style={{ fontSize: 13 }}>
                提示：{hint}
              </span>
            }
          />
        )}
        {errorMsg && <Alert type="error" message={errorMsg} showIcon />}
      </div>
    </Modal>
  );
}
