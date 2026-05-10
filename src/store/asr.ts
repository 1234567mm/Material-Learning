/**
 * 全局 ASR 状态 store（不持久化）。
 *
 * 用途：让 AsrToggleController（被全局快捷键 Ctrl+Shift+Space 触发的单例控制器）
 * 与所有 MicButton 实例共享"当前是否在录音 / 识别中"的状态，使得：
 *   - 用户在编辑器里按快捷键启动录音时，编辑器工具条上的 MicButton 也能同步变红
 *   - 任何一个 MicButton 在镜像状态下被点击时，把停止信号路由回 controller
 *
 * 与主 useAppStore 分开是因为：
 *   1. 这个状态变化频率高（recording 期间 60fps 更新 level）
 *   2. 不需要持久化（每次启动都是 idle）
 *   3. 主 store 的 subscribe 里有 persistKey 计算，不该被高频信号污染
 *
 * 注意：MicButton 自己点击启动的录音不会写入这个 store —— 麦克风一次只能被一个流占用，
 * 两条路径互斥。store 仅追踪「全局快捷键路径」的录音状态，MicButton 的"自身 recording"
 * 与"镜像 recording"通过组件内 status === "recording" 区分。
 */
import { create } from "zustand";

export type GlobalAsrPhase = "idle" | "recording" | "transcribing";

interface AsrStore {
  /** 全局 ASR 控制器当前阶段 */
  globalAsrPhase: GlobalAsrPhase;
  /** 全局录音的实时音量电平（0-1）；非录音时恒为 0 */
  globalAsrLevel: number;
  setGlobalAsrPhase: (phase: GlobalAsrPhase) => void;
  setGlobalAsrLevel: (level: number) => void;
}

export const useAsrStore = create<AsrStore>((set) => ({
  globalAsrPhase: "idle",
  globalAsrLevel: 0,
  setGlobalAsrPhase: (phase) =>
    set(phase === "recording" ? { globalAsrPhase: phase } : { globalAsrPhase: phase, globalAsrLevel: 0 }),
  setGlobalAsrLevel: (level) => set({ globalAsrLevel: level }),
}));
