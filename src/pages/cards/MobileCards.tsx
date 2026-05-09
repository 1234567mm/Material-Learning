import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, BarChart3, Sparkles } from "lucide-react";
import { message } from "antd";
import {
  fsrs,
  createEmptyCard,
  generatorParameters,
  Rating,
  type Card as FsrsCard,
  type State,
  type RecordLog,
} from "ts-fsrs";
import { cardApi } from "@/lib/api";
import type { Card } from "@/types";

/**
 * 移动端闪卡复习页（设计稿：09-cards.html）
 *
 * 路由 /cards —— 桌面端有 desktop CardsPage，移动端用本组件（wrapper 模式分发）
 *
 * 行为：
 * - 拉 listDue 队列 → 大卡片显示正反面（默认只显示正面，点击翻面）
 * - 4 档评分按钮（忘了/困难/良好/轻松）→ 用 ts-fsrs 算下次复习时间 → 提交后端 → 下一张
 * - 顶部进度条 + 待复习数量 + 估算时间
 * - 全部复习完显示"今日已复习 X 张"
 *
 * MVP 不做：
 * - 卡片新建（桌面端有；移动端先看现有卡片）
 * - 卡片元信息（deck/笔记反链）显示
 * - 滑动跳过手势
 * - 长按标记
 */

type GradeRating = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;

function toFsrsCard(c: Card): FsrsCard {
  return {
    ...createEmptyCard(),
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as State,
    last_review: c.last_review ? new Date(c.last_review) : undefined,
  };
}

function toSqliteLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatInterval(card: FsrsCard, now: Date): string {
  const ms = card.due.getTime() - now.getTime();
  if (ms < 60_000) return "<1m";
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h`;
  const days = Math.round(ms / 86400_000);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function MobileCards() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<Card[]>([]);
  const [completed, setCompleted] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const scheduler = useMemo(
    () => fsrs(generatorParameters({ enable_short_term: false })),
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await cardApi.listDue(50);
      setQueue(list);
      setCompleted(0);
      setRevealed(false);
    } catch (e) {
      message.error(`加载失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = queue[0];
  const total = queue.length + completed;

  async function rate(rating: GradeRating) {
    if (!current || submitting) return;
    setSubmitting(true);
    const now = new Date();
    const fsrsCard = toFsrsCard(current);
    const log: RecordLog = scheduler.repeat(fsrsCard, now);
    const result = log[rating].card;
    try {
      await cardApi.review({
        cardId: current.id,
        rating,
        state: result.state,
        due: toSqliteLocal(result.due),
        stability: result.stability,
        difficulty: result.difficulty,
        elapsedDays: result.elapsed_days,
        lastElapsedDays: fsrsCard.elapsed_days,
        scheduledDays: result.scheduled_days,
      });
      // 出队 + 翻面状态重置
      setQueue((q) => q.slice(1));
      setCompleted((c) => c + 1);
      setRevealed(false);
    } catch (e) {
      message.error(`提交失败: ${e}`);
    } finally {
      setSubmitting(false);
    }
  }

  // 估算 4 档下次复习时间用于按钮 hint
  const previewIntervals = useMemo(() => {
    if (!current) return null;
    const now = new Date();
    const log = scheduler.repeat(toFsrsCard(current), now);
    return {
      again: formatInterval(log[Rating.Again].card, now),
      hard: formatInterval(log[Rating.Hard].card, now),
      good: formatInterval(log[Rating.Good].card, now),
      easy: formatInterval(log[Rating.Easy].card, now),
    };
  }, [current, scheduler]);

  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gradient-to-br from-purple-50 via-white to-blue-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between px-2 shrink-0">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <div className="flex flex-col items-center leading-tight">
          <span className="text-base font-semibold">闪卡复习</span>
          <span className="text-[10px] text-slate-500">
            FSRS · 待复习 {queue.length} 张
          </span>
        </div>
        <button
          aria-label="统计"
          className="flex h-10 w-10 items-center justify-center"
        >
          <BarChart3 size={20} className="text-slate-700" />
        </button>
      </header>

      {/* 进度条 */}
      <div className="px-4 pb-2 shrink-0">
        <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
          <span>
            {completed} / {total}
          </span>
          {queue.length > 0 && (
            <span className="font-medium text-purple-600">
              ⏱️ 预计 {Math.max(1, Math.round(queue.length * 0.8))} 分钟
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* 主体 */}
      <main className="flex flex-1 flex-col px-5 py-3 min-h-0">
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
            加载中…
          </div>
        ) : !current ? (
          <DoneState completed={completed} onAgain={load} />
        ) : (
          <>
            {/* 卡片 */}
            <button
              onClick={() => setRevealed((r) => !r)}
              className="flex flex-1 flex-col rounded-3xl bg-white p-6 text-left shadow-lg active:scale-[0.99] transition-transform min-h-0"
            >
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                {revealed ? "反面 · 答案" : "正面 · 问题（点击翻面）"}
              </div>
              <div className="mt-3 flex-1 overflow-y-auto">
                <p className="text-base leading-relaxed text-slate-900 whitespace-pre-wrap">
                  {revealed ? current.back : current.front}
                </p>
              </div>
              {/* 卡片元信息 */}
              <div className="mt-3 flex items-center justify-around border-t border-slate-100 pt-3 text-[11px] text-slate-400">
                <Stat label="复习" value={`第 ${current.reps + 1} 次`} />
                <Stat
                  label="稳定性"
                  value={`${current.stability.toFixed(1)} d`}
                  color="text-slate-700"
                />
                <Stat
                  label="难度"
                  value={current.difficulty.toFixed(1)}
                  color="text-slate-700"
                />
              </div>
            </button>

            {/* 4 档评分按钮 */}
            <div className="mt-4 grid grid-cols-4 gap-2">
              <RateButton
                color="red"
                num={1}
                label="忘了"
                interval={previewIntervals?.again}
                disabled={!revealed || submitting}
                onClick={() => rate(Rating.Again)}
              />
              <RateButton
                color="orange"
                num={2}
                label="困难"
                interval={previewIntervals?.hard}
                disabled={!revealed || submitting}
                onClick={() => rate(Rating.Hard)}
              />
              <RateButton
                color="blue"
                num={3}
                label="良好"
                interval={previewIntervals?.good}
                disabled={!revealed || submitting}
                onClick={() => rate(Rating.Good)}
                highlight
              />
              <RateButton
                color="green"
                num={4}
                label="轻松"
                interval={previewIntervals?.easy}
                disabled={!revealed || submitting}
                onClick={() => rate(Rating.Easy)}
              />
            </div>

            <div
              className="mt-2 text-center text-[11px] text-slate-400"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              {revealed ? "选择评分进入下一张" : "点卡片翻看答案"}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  color = "text-slate-700",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="text-center">
      <div className={`font-medium ${color}`}>{value}</div>
      <div>{label}</div>
    </div>
  );
}

const COLOR_CLASSES: Record<
  string,
  { bg: string; text: string; ring: string }
> = {
  red:    { bg: "bg-red-50 border border-red-200",       text: "text-red-600",    ring: "ring-red-200" },
  orange: { bg: "bg-orange-50 border border-orange-200", text: "text-orange-600", ring: "ring-orange-200" },
  blue:   { bg: "bg-blue-50 border-2 border-blue-300",   text: "text-blue-600",   ring: "ring-blue-200" },
  green:  { bg: "bg-green-50 border border-green-200",   text: "text-green-600",  ring: "ring-green-200" },
};

function RateButton({
  color,
  num,
  label,
  interval,
  disabled,
  onClick,
  highlight,
}: {
  color: "red" | "orange" | "blue" | "green";
  num: number;
  label: string;
  interval?: string;
  disabled: boolean;
  onClick: () => void;
  highlight?: boolean;
}) {
  const c = COLOR_CLASSES[color];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-16 flex-col items-center justify-center rounded-2xl ${c.bg} ${
        highlight ? `ring-2 ${c.ring}` : ""
      } active:scale-95 transition-transform disabled:opacity-40`}
    >
      <span className={`text-base font-bold ${c.text}`}>{num}</span>
      <span className={`text-[10px] ${c.text}`}>{label}</span>
      {interval && (
        <span className={`text-[9px] mt-0.5 ${c.text} opacity-60`}>
          {interval}
        </span>
      )}
    </button>
  );
}

function DoneState({
  completed,
  onAgain,
}: {
  completed: number;
  onAgain: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Sparkles size={48} className="text-purple-400" />
      <div className="text-xl font-bold text-slate-800">
        {completed > 0 ? `今日已复习 ${completed} 张 🎉` : "今天没有待复习的闪卡"}
      </div>
      <div className="text-xs text-slate-500">
        {completed > 0 ? "明天见，FSRS 会自动安排下一轮" : "去笔记里把段落转成卡片吧"}
      </div>
      <button
        onClick={onAgain}
        className="mt-4 rounded-xl bg-purple-100 px-4 py-2 text-sm font-medium text-purple-700 active:bg-purple-200"
      >
        重新加载
      </button>
    </div>
  );
}
