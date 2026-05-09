/**
 * 麦克风音量电平 Hook。
 *
 * 通过 Web Audio API 的 AnalyserNode 读取实时频谱，按 60fps 的节奏
 * 把归一化后的 level（0-1）和分频段数组（驱动柱状波形）写到 state。
 *
 * - stream 为 null 或 active=false 时不工作（自动清理 AudioContext）
 * - 卸载时自动断开节点 + 关闭 AudioContext，避免麦克风释放后还在跑 RAF
 *
 * @param stream 当前 MediaStream（来自 getUserMedia 的 audio 流）
 * @param active 是否启用监听（recording 时 true，停止后 false 立即停采样）
 * @param bandCount 想要把频谱分成几段（柱状条数；MicButton 不用此项）
 * @returns `{ level, bands }`：level=整体平均；bands=按低→高排列的归一化频段强度
 */
import { useEffect, useState } from "react";

export interface AudioLevelState {
  level: number;
  bands: number[];
}

export function useAudioLevel(
  stream: MediaStream | null,
  active: boolean,
  bandCount = 5,
): AudioLevelState {
  const [state, setState] = useState<AudioLevelState>({
    level: 0,
    bands: new Array(bandCount).fill(0),
  });

  useEffect(() => {
    if (!active || !stream) {
      setState({ level: 0, bands: new Array(bandCount).fill(0) });
      return;
    }

    let audioCtx: AudioContext | null = null;
    let raf = 0;
    let smoothedLevel = 0;
    const smoothedBands = new Array(bandCount).fill(0);
    try {
      const Ctor: typeof AudioContext =
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ?? window.AudioContext;
      audioCtx = new Ctor();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const binPerBand = Math.max(1, Math.floor(data.length / bandCount));

      const tick = () => {
        analyser.getByteFrequencyData(data);

        // 整体平均
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        smoothedLevel = smoothedLevel * 0.5 + avg * 0.5;

        // 分频段平均：低频在前，高频在后
        const bands: number[] = [];
        for (let b = 0; b < bandCount; b++) {
          let s = 0;
          const start = b * binPerBand;
          const end = Math.min(start + binPerBand, data.length);
          for (let j = start; j < end; j++) s += data[j];
          const v = s / (end - start) / 255;
          smoothedBands[b] = smoothedBands[b] * 0.4 + v * 0.6;
          bands.push(smoothedBands[b]);
        }

        setState({ level: smoothedLevel, bands: [...bands] });
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // AudioContext 创建失败（极少见）静默退化
      setState({ level: 0, bands: new Array(bandCount).fill(0) });
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      audioCtx?.close().catch(() => {
        /* ignore */
      });
    };
  }, [stream, active, bandCount]);

  return state;
}
