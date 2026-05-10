/**
 * 基于 Web Audio API 的合成蜂鸣音。
 *
 * 选用合成而非音频文件：免维护资源、CSP/asset-protocol 不掺和、跨平台一致。
 * 单次蜂鸣给"强烈级"提醒（应用内 Modal 弹出时叮一声）；循环蜂鸣给"紧急级"
 * 全屏接管窗口（响到用户处理为止）。
 */

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
  try {
    sharedCtx = new AudioContext();
    return sharedCtx;
  } catch {
    return null;
  }
}

/**
 * 播放一段双音"叮叮"（约 0.5s）。安全：用户未交互过的窗口会被浏览器静音，
 * 此时 oscillator.start 不会抛错，只是静默——可接受
 */
export function beepOnce(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;
  playTone(ctx, 880, now, 0.18);
  playTone(ctx, 1175, now + 0.22, 0.18);
}

function playTone(ctx: AudioContext, freq: number, startAt: number, duration: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // ADSR：避免 click pop 噪声
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.35, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

/**
 * 循环蜂鸣（紧急级用）。返回 stop 函数，必须在窗口关闭前调用以释放资源。
 *
 * intervalMs 默认 1500ms，对应 ~40 次/分钟，足够吵但不至于让用户立即想砸键盘
 */
export function startBeepLoop(intervalMs = 1500): () => void {
  let cancelled = false;
  let timer: number | undefined;

  const tick = () => {
    if (cancelled) return;
    beepOnce();
  };
  tick();
  timer = window.setInterval(tick, intervalMs);

  return () => {
    cancelled = true;
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
