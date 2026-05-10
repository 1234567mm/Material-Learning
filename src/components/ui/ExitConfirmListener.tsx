import { useEffect, useState } from "react";
import { Modal, Button, App as AntdApp, List } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { useTabsStore, type NoteTab } from "@/store/tabs";
import { noteApi, syncV1Api } from "@/lib/api";

/**
 * 退出前对所有启用的同步后端做一次 push。
 * Why：保证最后一次本地修改进了远端，下次在别的设备 pull 时不会丢这部分。
 *
 * 设计要点（与思源"必须同步成功才能退"的关键差异）：
 * 1. 只 push 不 pull —— 用户都要走了，不应该把远端新内容拉下来覆盖
 * 2. 任何一个 backend 失败都返回错误信息，由调用方决定是否阻断退出（弹"强制退出"）
 *    而不是默默吞掉，否则离线场景下用户感知不到丢数据风险
 * 3. 每个 backend 单独 try/catch，一个失败不影响其他成功
 */
async function pushAllOnExit(): Promise<{ ok: number; errors: string[] }> {
  let ok = 0;
  const errors: string[] = [];
  try {
    const backends = await syncV1Api.listBackends();
    const enabled = backends.filter((b) => b.enabled);
    for (const b of enabled) {
      try {
        await syncV1Api.push(b.id);
        ok++;
      } catch (e) {
        errors.push(`${b.name}: ${e}`);
      }
    }
  } catch (e) {
    errors.push(`读取后端列表失败: ${e}`);
  }
  return { ok, errors };
}

/**
 * 监听托盘"退出"事件 → 检查未保存草稿 → 三选一确认。
 * 流程：
 *   - 无 dirty tab：直接 exit(0)
 *   - 有 dirty tab：弹 Modal，让用户选择
 *     - 保存并退出：循环 dirty tabs，从 store draft 取内容 → noteApi.update → exit
 *     - 放弃修改并退出：直接 exit
 *     - 取消：关闭 Modal，什么都不做
 *
 * 注：托盘 quit 菜单项不再直接 app.exit(0)，而是 emit "tray:request-exit"，由本组件接管。
 */
export function ExitConfirmListener() {
  const { message } = AntdApp.useApp();
  const [dirtyTabs, setDirtyTabs] = useState<NoteTab[]>([]);
  const [exiting, setExiting] = useState(false);
  /** 同步阶段的状态文本（"正在同步…" / "同步失败：xxx"）；非 null 时锁住 Modal */
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  /** 同步失败兜底弹窗：显示错误 + 强制退出按钮 */
  const [syncFailedErrors, setSyncFailedErrors] = useState<string[] | null>(null);
  const open = dirtyTabs.length > 0;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen("tray:request-exit", async () => {
      const tabs = useTabsStore.getState().getDirtyTabs();
      if (tabs.length === 0) {
        // 没有未保存草稿：仍然要尝试推送（DB 里可能有上次同步后的修改）
        await syncThenExit();
        return;
      }
      setDirtyTabs(tabs);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 跑 push → 成功直接退；失败弹窗让用户选"强制退出 / 取消" */
  async function syncThenExit() {
    setSyncStatus("正在同步到云端…");
    const { ok, errors } = await pushAllOnExit();
    if (errors.length === 0) {
      // ok 为 0（无配置）也视为通过，不阻塞退出
      if (ok > 0) {
        // 留 200ms 让用户看到"同步完成"再退（避免 Modal 闪一下就消失）
        setSyncStatus(`已同步 ${ok} 个后端，正在退出…`);
        await new Promise((r) => setTimeout(r, 200));
      }
      await exit(0);
      return;
    }
    setSyncStatus(null);
    setSyncFailedErrors(errors);
  }

  async function handleSaveAndExit() {
    setExiting(true);
    const { getDraft, clearDraft } = useTabsStore.getState();
    const failed: string[] = [];
    for (const tab of dirtyTabs) {
      const draft = getDraft(tab.id);
      if (!draft || !draft.title.trim()) {
        failed.push(tab.title || "未命名");
        continue;
      }
      try {
        await noteApi.update(tab.id, { title: draft.title.trim(), content: draft.content });
        clearDraft(tab.id);
      } catch (e) {
        failed.push(`${tab.title || "未命名"}（${e}）`);
      }
    }
    if (failed.length > 0) {
      setExiting(false);
      message.error(`${failed.length} 条笔记保存失败，已取消退出：${failed.join("；")}`);
      // 重新查一次 dirty 列表（有些可能保存成功了）
      setDirtyTabs(useTabsStore.getState().getDirtyTabs());
      return;
    }
    // 保存成功 → 清空 dirty 弹窗 → 走同步阶段
    setDirtyTabs([]);
    await syncThenExit();
    setExiting(false);
  }

  async function handleDiscardAndExit() {
    setExiting(true);
    setDirtyTabs([]);
    // 放弃修改也要 push DB 已有数据（用户可能在别的设备已经改过这些笔记的更老版本）
    await syncThenExit();
    setExiting(false);
  }

  function handleCancel() {
    if (exiting) return;
    setDirtyTabs([]);
  }

  return (
    <>
      {/* 主弹窗：脏数据保存确认（保存/放弃/取消） */}
      <Modal
        open={open}
        title={`有 ${dirtyTabs.length} 条笔记尚未保存`}
        onCancel={handleCancel}
        mask={{ closable: !exiting }}
        closable={!exiting}
        footer={[
          <Button key="discard" danger disabled={exiting} onClick={handleDiscardAndExit}>
            放弃修改并退出
          </Button>,
          <Button key="cancel" disabled={exiting} onClick={handleCancel}>
            取消
          </Button>,
          <Button key="save" type="primary" loading={exiting} onClick={handleSaveAndExit}>
            保存全部并退出
          </Button>,
        ]}
      >
        <p style={{ marginTop: 0 }}>退出后未保存的修改将丢失。请选择操作：</p>
        <List
          size="small"
          bordered
          dataSource={dirtyTabs}
          renderItem={(t) => <List.Item>{t.title || "未命名"}</List.Item>}
          style={{ maxHeight: 200, overflow: "auto" }}
        />
      </Modal>

      {/* 同步进行中的轻量提示 Modal（不可关，纯文字） */}
      <Modal
        open={syncStatus !== null}
        title="退出前同步"
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={null}
      >
        <p style={{ marginTop: 0 }}>{syncStatus}</p>
      </Modal>

      {/* 同步失败兜底：让用户决定强制退出还是回去手动处理 */}
      <Modal
        open={syncFailedErrors !== null}
        title="同步失败"
        onCancel={() => setSyncFailedErrors(null)}
        closable
        maskClosable={false}
        footer={[
          <Button key="cancel" onClick={() => setSyncFailedErrors(null)}>
            取消（留下处理）
          </Button>,
          <Button key="force" danger onClick={() => exit(0)}>
            强制退出（放弃同步）
          </Button>,
        ]}
      >
        <p style={{ marginTop: 0 }}>
          以下后端推送失败，本地修改可能未上传到云端。
          强制退出后这部分修改仍保留在本地，下次启动会再尝试同步。
        </p>
        <List
          size="small"
          bordered
          dataSource={syncFailedErrors ?? []}
          renderItem={(err) => <List.Item style={{ color: "#cf1322" }}>{err}</List.Item>}
          style={{ maxHeight: 200, overflow: "auto" }}
        />
      </Modal>
    </>
  );
}
