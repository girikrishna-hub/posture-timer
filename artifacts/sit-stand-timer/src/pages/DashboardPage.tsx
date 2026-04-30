import { useState, useMemo, useRef, useCallback } from "react";
import { useTimer } from "@/contexts/TimerContext";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  Legend,
} from "recharts";
import {
  useGetMetricsSummary,
  useGetDailyMetrics,
  useGetTodayStats,
  useListSessions,
  type SummaryMetrics,
  type DailyMetricsResponse,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import html2canvas from "html2canvas";

// ─── Color constants ────────────────────────────────────────────────────────
const MODE_COLORS = {
  sitting: "#3B82F6",
  standing: "#22C55E",
  walking: "#14B8A6",
  nap: "#F59E0B",
  sleep: "#6366F1",
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────
function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function shortWeekday(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
}

function fullDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function monthName(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

// ─── Tab bar ────────────────────────────────────────────────────────────────
const TABS = ["Overview", "Daily", "Monthly", "Sessions"] as const;
type Tab = (typeof TABS)[number];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="flex border-b border-border bg-background sticky top-0 z-10">
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${
            active === t
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// ─── Summary card ───────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl px-4 py-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-2xl font-bold ${color ?? "text-foreground"}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ─── Weekly bar chart ───────────────────────────────────────────────────────
function WeeklyChart({
  days,
  goalMinutes,
}: {
  days: { date: string; sittingMinutes: number; standingMinutes: number; walkingMinutes: number }[];
  goalMinutes: number;
}) {
  const data = days.map((d) => ({
    name: shortWeekday(d.date),
    Sitting: d.sittingMinutes,
    Standing: d.standingMinutes,
    Walking: d.walkingMinutes,
  }));

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">This week</h3>
        <span className="text-xs text-muted-foreground">Goal: {formatMinutes(goalMinutes)}/day</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} barGap={2} barSize={12} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={(v: number) => `${v}m`} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
          <Tooltip
            formatter={(v: number, name: string) => [formatMinutes(v), name]}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine y={goalMinutes} stroke="#EF4444" strokeDasharray="4 4" strokeWidth={1.5} />
          <Bar dataKey="Sitting" fill={MODE_COLORS.sitting} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Standing" fill={MODE_COLORS.standing} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Walking" fill={MODE_COLORS.walking} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Share card (offscreen, captured by html2canvas) ────────────────────────
function ShareCard({
  cardRef,
  summary,
  weeklyData,
  weekStart,
  weekEnd,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  summary: SummaryMetrics;
  weeklyData: DailyMetricsResponse;
  weekStart: string;
  weekEnd: string;
}) {
  const score = summary.healthScore ?? 0;
  const scoreColor =
    score >= 70 ? "#16a34a" : score >= 40 ? "#d97706" : "#ef4444";

  const maxMinutes = Math.max(
    ...weeklyData.days.map((d) => d.sittingMinutes + d.standingMinutes),
    weeklyData.goalMinutes,
    1,
  );

  return (
    <div
      ref={cardRef}
      style={{
        position: "fixed",
        left: "-9999px",
        top: 0,
        width: 360,
        background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
        borderRadius: 24,
        padding: 24,
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#f8fafc",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.5 }}>Weekly Summary</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            {weekStart} → {weekEnd}
          </div>
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#3b82f6" }}>sit/stand</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 16, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>Current Streak</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#3b82f6" }}>
            {summary.currentStreak ?? 0}d
          </div>
          <div style={{ fontSize: 10, color: "#64748b" }}>Longest: {summary.longestStreak ?? 0}d</div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 16, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>Health Score</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: scoreColor }}>
            {score}/100
          </div>
          <div style={{ fontSize: 10, color: "#64748b" }}>{summary.healthLabel ?? ""}</div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 16, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>Avg Standing</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#22c55e" }}>
            {formatMinutes(summary.weeklyAverageStandingMinutes ?? 0)}
          </div>
          <div style={{ fontSize: 10, color: "#64748b" }}>per day</div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 16, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>Best Day</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#22c55e" }}>
            {summary.bestDayMinutes ? formatMinutes(summary.bestDayMinutes) : "—"}
          </div>
          <div style={{ fontSize: 10, color: "#64748b" }}>
            {summary.bestDayDate ? shortWeekday(summary.bestDayDate) : ""}
          </div>
        </div>
      </div>

      <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 16, padding: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0" }}>This week</span>
          <span style={{ fontSize: 10, color: "#64748b" }}>Goal: {formatMinutes(weeklyData.goalMinutes)}/day</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 90 }}>
          {weeklyData.days.map((d) => {
            const total = d.sittingMinutes + d.standingMinutes;
            const sitH = (d.sittingMinutes / maxMinutes) * 80;
            const standH = (d.standingMinutes / maxMinutes) * 80;
            const goalH = (weeklyData.goalMinutes / maxMinutes) * 80;
            return (
              <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ position: "relative", width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ position: "absolute", bottom: goalH, left: 0, right: 0, height: 1, background: "#ef4444", opacity: 0.6 }} />
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
                    <div style={{ width: "70%", height: standH, background: "#22c55e", borderRadius: "3px 3px 0 0", minHeight: total > 0 ? 2 : 0 }} />
                    <div style={{ width: "70%", height: sitH, background: "#3b82f6", minHeight: total > 0 ? 2 : 0 }} />
                  </div>
                </div>
                <span style={{ fontSize: 9, color: "#64748b" }}>{shortWeekday(d.date)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 8, justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: "#22c55e" }} />
            <span style={{ fontSize: 9, color: "#94a3b8" }}>Standing</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: "#3b82f6" }} />
            <span style={{ fontSize: 9, color: "#94a3b8" }}>Sitting</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, textAlign: "center", fontSize: 10, color: "#475569" }}>
        Generated with Sit/Stand Timer
      </div>
    </div>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────────
function OverviewTab() {
  const { mode, elapsedSeconds } = useTimer();
  const { data: summary, isLoading: sumLoading } = useGetMetricsSummary();
  const { data: todayStats } = useGetTodayStats();
  const [previewing, setPreviewing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [previewImgUrl, setPreviewImgUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const weekStart = toDateStr(addDays(today(), -6));
  const weekEnd = toDateStr(today());
  const { data: weeklyData, isLoading: weekLoading } = useGetDailyMetrics(
    { from: weekStart, to: weekEnd },
  );

  const handleOpenPreview = useCallback(async () => {
    if (!cardRef.current) return;
    setPreviewing(true);
    try {
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Failed to create blob"));
        }, "image/png");
      });
      const url = URL.createObjectURL(blob);
      setPreviewBlob(blob);
      setPreviewImgUrl(url);
      setPreviewOpen(true);
    } catch {
      toast({
        title: "Could not generate preview",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  }, [toast]);

  const handleClosePreview = useCallback(() => {
    setPreviewOpen(false);
    if (previewImgUrl) {
      URL.revokeObjectURL(previewImgUrl);
      setPreviewImgUrl(null);
    }
    setPreviewBlob(null);
  }, [previewImgUrl]);

  const handleShare = useCallback(async () => {
    if (!previewBlob) return;
    setSharing(true);
    try {
      const file = new File([previewBlob], "weekly-summary.png", { type: "image/png" });
      const canFileShare =
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] });

      if (canFileShare) {
        await navigator.share({
          title: "My Weekly Sit/Stand Summary",
          files: [file],
        });
      } else {
        const url = URL.createObjectURL(previewBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "weekly-summary.png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      handleClosePreview();
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        toast({
          title: "Could not share image",
          description: "Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setSharing(false);
    }
  }, [previewBlob, handleClosePreview, toast]);

  if (sumLoading || weekLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
        <Skeleton className="h-52 rounded-2xl" />
      </div>
    );
  }

  const score = summary?.healthScore ?? 0;
  const scoreColor =
    score >= 70 ? "text-green-600" : score >= 40 ? "text-amber-600" : "text-red-500";

  return (
    <div className="p-4 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Overview</h2>
        {summary && weeklyData && (
          <Button size="sm" onClick={handleOpenPreview} disabled={previewing}>
            {previewing ? "Generating…" : "Share week"}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Current Streak"
          value={`${summary?.currentStreak ?? 0}d`}
          sub={`Longest: ${summary?.longestStreak ?? 0}d`}
          color="text-primary"
        />
        <StatCard
          label="Weekly Avg Standing"
          value={formatMinutes(summary?.weeklyAverageStandingMinutes ?? 0)}
        />
        <StatCard
          label="Health Score"
          value={`${score}/100`}
          sub={summary?.healthLabel}
          color={scoreColor}
        />
        <StatCard
          label="Best Day This Week"
          value={summary?.bestDayMinutes ? formatMinutes(summary.bestDayMinutes) : "—"}
          sub={summary?.bestDayDate ? shortWeekday(summary.bestDayDate) : undefined}
          color="text-green-600"
        />
        <StatCard
          label="Worst Day This Week"
          value={summary?.worstDayMinutes ? formatMinutes(summary.worstDayMinutes) : "—"}
          sub={summary?.worstDayDate ? shortWeekday(summary.worstDayDate) : undefined}
          color="text-red-500"
        />
      </div>

      {todayStats && (() => {
        const goalMinutes = todayStats.goalMinutes ?? 120;
        const isActiveMode = mode === "standing" || mode === "walking";
        const secondsSinceLocalMidnight = (() => {
          const now = new Date();
          return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        })();
        const cappedElapsedMinutes = isActiveMode
          ? Math.min(elapsedSeconds, secondsSinceLocalMidnight) / 60
          : 0;
        const goalPercent = goalMinutes > 0
          ? Math.min(100, ((todayStats.standingMinutes + todayStats.walkingMinutes + cappedElapsedMinutes) / goalMinutes) * 100)
          : todayStats.goalProgressPercent ?? 0;
        const goalMet = goalPercent >= 100;
        return (
          <div className="bg-card border border-border rounded-2xl px-4 py-3 space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span className={`flex items-center gap-1 transition-colors duration-500 ${goalMet ? "text-emerald-600 dark:text-emerald-400 font-medium" : ""}`}>
                {goalMet && (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                    <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
                  </svg>
                )}
                {goalMet ? "Goal reached!" : "Standing goal"}
              </span>
              <span className={`font-medium transition-colors duration-500 ${goalMet ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}>
                {formatMinutes(Math.floor(todayStats.standingMinutes + todayStats.walkingMinutes + cappedElapsedMinutes))} / {formatMinutes(goalMinutes)}
              </span>
            </div>
            <Progress
              value={goalPercent}
              className={`h-2 transition-all duration-500 ${goalMet ? "[&>div]:bg-emerald-500 dark:[&>div]:bg-emerald-400" : ""}`}
            />
          </div>
        );
      })()}

      {weeklyData && (
        <WeeklyChart
          days={weeklyData.days}
          goalMinutes={weeklyData.goalMinutes}
        />
      )}

      {summary && (
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Rest Summary (last 30 days)</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Avg Nap</p>
              <p className="text-lg font-semibold text-amber-600">
                {summary.avgNapDurationMinutes > 0
                  ? formatMinutes(summary.avgNapDurationMinutes)
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Avg Sleep</p>
              <p className="text-lg font-semibold text-indigo-600">
                {summary.avgSleepDurationMinutes > 0
                  ? formatMinutes(summary.avgSleepDurationMinutes)
                  : "—"}
              </p>
            </div>
          </div>
          {summary.sleepConsistency && summary.sleepConsistency.sampleCount >= 2 && (
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">Sleep consistency</p>
              <p className="text-sm text-foreground">
                You sleep at ~{summary.sleepConsistency.avgSleepStartFormatted} on average,
                ±{summary.sleepConsistency.stddevMinutes} min
              </p>
            </div>
          )}
        </div>
      )}

      {summary && weeklyData && (
        <ShareCard
          cardRef={cardRef}
          summary={summary}
          weeklyData={weeklyData}
          weekStart={weekStart}
          weekEnd={weekEnd}
        />
      )}

      <Dialog open={previewOpen} onOpenChange={(open) => { if (!open) handleClosePreview(); }}>
        <DialogContent className="max-w-sm w-full p-4">
          <DialogHeader>
            <DialogTitle className="text-base">Summary card preview</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-2">
            {previewImgUrl && (
              <img
                src={previewImgUrl}
                alt="Weekly summary card preview"
                className="rounded-2xl w-full object-contain"
                style={{ maxHeight: "65vh" }}
              />
            )}
          </div>
          <DialogFooter className="flex flex-row gap-2 sm:flex-row">
            <Button variant="outline" className="flex-1" onClick={handleClosePreview} disabled={sharing}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleShare} disabled={sharing}>
              {sharing ? "Sharing…" : typeof navigator.share === "function" ? "Share" : "Download"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Daily timeline ──────────────────────────────────────────────────────────
function DailyTimeline({
  sessions,
}: {
  sessions: {
    id: number;
    mode: string;
    startedAt: string;
    endedAt: string | null;
    restType?: string | null;
  }[];
}) {
  const completed = sessions.filter((s) => s.endedAt !== null);
  if (completed.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        No sessions recorded for this day
      </div>
    );
  }

  const dayStart = new Date(completed[0]!.startedAt);
  dayStart.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;

  const getColor = (s: { mode: string; restType?: string | null }) => {
    if (s.mode === "sitting") return MODE_COLORS.sitting;
    if (s.mode === "standing") return MODE_COLORS.standing;
    if (s.mode === "walking") return MODE_COLORS.walking;
    if (s.restType === "nap") return MODE_COLORS.nap;
    return MODE_COLORS.sleep;
  };

  const getLabel = (s: { mode: string; restType?: string | null }) => {
    if (s.mode === "sitting") return "Sitting";
    if (s.mode === "standing") return "Standing";
    if (s.mode === "walking") return "Walking";
    if (s.restType === "nap") return "Nap";
    return "Sleep";
  };

  return (
    <div>
      <div className="relative h-12 bg-muted rounded-xl overflow-hidden mx-4 mt-2">
        {completed.map((s) => {
          const start = new Date(s.startedAt).getTime() - dayStart.getTime();
          const end = s.endedAt
            ? new Date(s.endedAt).getTime() - dayStart.getTime()
            : Date.now() - dayStart.getTime();
          const left = (Math.max(0, start) / dayMs) * 100;
          const width = (Math.min(dayMs, end - Math.max(0, start)) / dayMs) * 100;
          return (
            <div
              key={s.id}
              className="absolute top-0 bottom-0 opacity-90"
              style={{
                left: `${left}%`,
                width: `${Math.max(0.5, width)}%`,
                backgroundColor: getColor(s),
              }}
              title={`${getLabel(s)}: ${formatTime(s.startedAt)} – ${s.endedAt ? formatTime(s.endedAt) : "now"}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between px-4 mt-1">
        <span className="text-[10px] text-muted-foreground">12:00 AM</span>
        <span className="text-[10px] text-muted-foreground">12:00 PM</span>
        <span className="text-[10px] text-muted-foreground">11:59 PM</span>
      </div>
      <div className="mt-3 px-4 space-y-2 max-h-60 overflow-y-auto">
        {completed.map((s) => {
          const mins = s.endedAt
            ? Math.round(
                (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000,
              )
            : 0;
          return (
            <div key={s.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: getColor(s) }}
              />
              <span className="text-sm text-foreground flex-1 capitalize">{getLabel(s)}</span>
              <span className="text-xs text-muted-foreground">
                {formatTime(s.startedAt)} – {s.endedAt ? formatTime(s.endedAt) : "now"}
              </span>
              <span className="text-xs font-medium text-foreground w-12 text-right">
                {formatMinutes(mins)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Monthly heatmap ─────────────────────────────────────────────────────────
function goalColor(pct: number | undefined): string {
  if (pct === undefined || pct === 0) return "bg-muted text-muted-foreground";
  if (pct >= 100) return "bg-green-600 text-white";
  if (pct >= 75) return "bg-green-400 text-white";
  if (pct >= 50) return "bg-yellow-400 text-white";
  if (pct >= 25) return "bg-orange-400 text-white";
  return "bg-red-400 text-white";
}

function MonthlyTab({ onDayClick }: { onDayClick: (date: Date) => void }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);

  const { data: monthlyData, isLoading } = useGetDailyMetrics({
    from: toDateStr(monthStart),
    to: toDateStr(monthEnd),
  });

  const goalByDate = useMemo(() => {
    const m = new Map<string, number>();
    if (monthlyData) {
      for (const d of monthlyData.days) {
        m.set(d.date, d.goalProgressPercent);
      }
    }
    return m;
  }, [monthlyData]);

  const startDow = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const cells: (Date | null)[] = [
    ...Array(startDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(monthStart.getFullYear(), monthStart.getMonth(), i + 1)),
  ];

  const todayStr = toDateStr(today());

  return (
    <div className="p-4 pb-24 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>←</Button>
        <span className="text-sm font-medium text-foreground">{monthName(month)}</span>
        <Button variant="outline" size="sm" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>→</Button>
      </div>

      <div className="bg-card border border-border rounded-2xl p-4">
        <div className="grid grid-cols-7 gap-1 mb-2">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="text-center text-[10px] font-medium text-muted-foreground">
              {d}
            </div>
          ))}
        </div>
        {isLoading ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, i) => {
              if (!cell) return <div key={`empty-${i}`} />;
              const dateStr = toDateStr(cell);
              const pct = goalByDate.get(dateStr);
              const isToday = dateStr === todayStr;
              const isFuture = cell > today();
              return (
                <button
                  key={dateStr}
                  onClick={() => !isFuture && onDayClick(cell)}
                  disabled={isFuture}
                  className={`aspect-square rounded-md text-xs font-medium flex items-center justify-center transition-opacity
                    ${isFuture ? "opacity-30 cursor-default" : "cursor-pointer hover:opacity-80"}
                    ${isToday ? "ring-2 ring-primary" : ""}
                    ${goalColor(isFuture ? undefined : pct)}`}
                  title={pct !== undefined ? `${dateStr}: ${pct}% of goal` : dateStr}
                >
                  {cell.getDate()}
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-muted" /> No data
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-red-400" /> &lt;25%
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-orange-400" /> 25%
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-yellow-400" /> 50%
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-green-400" /> 75%
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-green-600" /> 100%
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sessions tab ─────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;

function SessionsTab() {
  const [page, setPage] = useState(0);
  const [sortDesc, setSortDesc] = useState(true);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading } = useListSessions({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const sessions = useMemo(() => {
    if (!data?.sessions) return [];
    const sorted = [...data.sessions];
    sorted.sort((a, b) => {
      const diff = new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      return sortDesc ? -diff : diff;
    });
    return sorted;
  }, [data, sortDesc]);

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  async function handleExport() {
    setExporting(true);
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const resp = await fetch(`${base}/api/sessions/export`);
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sit-stand-sessions.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  const modeColor = (mode: string, restType?: string | null) => {
    if (mode === "sitting") return "text-blue-600";
    if (mode === "standing") return "text-green-600";
    if (mode === "walking") return "text-teal-600";
    if (restType === "nap") return "text-amber-600";
    return "text-indigo-600";
  };

  const modeLabel = (mode: string, restType?: string | null) => {
    if (mode === "sitting") return "Sitting";
    if (mode === "standing") return "Standing";
    if (mode === "walking") return "Walking";
    if (restType === "nap") return "Nap";
    return mode === "resting" ? "Sleep" : mode;
  };

  return (
    <div className="p-4 pb-24 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{total} sessions total</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSortDesc((d) => !d)}
          >
            {sortDesc ? "Newest first" : "Oldest first"}
          </Button>
          <Button size="sm" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No sessions yet</div>
        ) : (
          <div className="divide-y divide-border">
            {sessions.map((s) => {
              const mins = s.durationSeconds
                ? Math.round(s.durationSeconds / 60)
                : s.endedAt
                ? Math.round(
                    (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000,
                  )
                : null;
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <div
                    className="w-2 h-8 rounded-full shrink-0"
                    style={{
                      backgroundColor:
                        s.mode === "sitting"
                          ? MODE_COLORS.sitting
                          : s.mode === "standing"
                          ? MODE_COLORS.standing
                          : s.mode === "walking"
                          ? MODE_COLORS.walking
                          : s.restType === "nap"
                          ? MODE_COLORS.nap
                          : MODE_COLORS.sleep,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className={`text-sm font-medium capitalize ${modeColor(s.mode, s.restType)}`}>
                        {s.mode}
                      </p>
                      {s.mode === "resting" && s.restType && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
                          {s.restType}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(s.startedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      · {formatTime(s.startedAt)}
                      {s.endedAt ? ` – ${formatTime(s.endedAt)}` : " (active)"}
                    </p>
                  </div>
                  {mins !== null && (
                    <span className="text-sm font-medium text-foreground shrink-0">
                      {formatMinutes(mins)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard page ─────────────────────────────────────────────────────
export default function DashboardPage() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [dailyDate, setDailyDate] = useState(today());

  function handleMonthDayClick(date: Date) {
    setDailyDate(date);
    setTab("Daily");
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="px-6 pt-6 pb-3">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-xs text-muted-foreground">Your activity analytics</p>
      </header>

      <TabBar active={tab} onChange={setTab} />

      <div className="flex-1 overflow-y-auto">
        {tab === "Overview" && <OverviewTab />}
        {tab === "Daily" && <DailyTabWithDate date={dailyDate} setDate={setDailyDate} />}
        {tab === "Monthly" && <MonthlyTab onDayClick={handleMonthDayClick} />}
        {tab === "Sessions" && <SessionsTab />}
      </div>
    </div>
  );
}

// ─── Daily stat grid (sitting / standing / active / nap / sleep) ─────────────
type DayDataShape = {
  sittingMinutes: number;
  standingMinutes: number;
  walkingMinutes: number;
  activeMinutes: number;
  napMinutes: number;
  sleepMinutes: number;
  healthScore: number;
};

function DailyStatGrid({ dayData }: { dayData: DayDataShape }) {
  const scoreLabel =
    dayData.healthScore >= 90
      ? "Excellent"
      : dayData.healthScore >= 70
      ? "Great"
      : dayData.healthScore >= 50
      ? "Good"
      : dayData.healthScore >= 30
      ? "Fair"
      : "Needs work";
  const scoreColor =
    dayData.healthScore >= 70
      ? "text-green-600"
      : dayData.healthScore >= 40
      ? "text-amber-600"
      : "text-red-500";

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-center">
          <p className="text-xs text-blue-600">Sitting</p>
          <p className="text-base font-semibold text-blue-700">{formatMinutes(dayData.sittingMinutes)}</p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2 text-center">
          <p className="text-xs text-green-600">Standing</p>
          <p className="text-base font-semibold text-green-700">{formatMinutes(dayData.standingMinutes)}</p>
        </div>
        <div className="bg-purple-50 border border-purple-200 rounded-xl px-3 py-2 text-center">
          <p className="text-xs text-purple-600">Active</p>
          <p className="text-base font-semibold text-purple-700">{formatMinutes(dayData.activeMinutes)}</p>
        </div>
        <div className="bg-teal-50 border border-teal-200 rounded-xl px-3 py-2 text-center">
          <p className="text-xs text-teal-600">Walking</p>
          <p className="text-base font-semibold text-teal-700">{formatMinutes(dayData.walkingMinutes)}</p>
        </div>
        {dayData.napMinutes > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-center">
            <p className="text-xs text-amber-600">Nap</p>
            <p className="text-base font-semibold text-amber-700">{formatMinutes(dayData.napMinutes)}</p>
          </div>
        )}
        {dayData.sleepMinutes > 0 && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 text-center">
            <p className="text-xs text-indigo-600">Sleep</p>
            <p className="text-base font-semibold text-indigo-700">{formatMinutes(dayData.sleepMinutes)}</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between bg-card border border-border rounded-xl px-4 py-2">
        <span className="text-xs text-muted-foreground">Day health score</span>
        <span className={`text-sm font-semibold ${scoreColor}`}>
          {dayData.healthScore}/100 · {scoreLabel}
        </span>
      </div>
    </div>
  );
}

// Wrapper so DailyTab accepts external date state
function DailyTabWithDate({
  date,
  setDate,
}: {
  date: Date;
  setDate: (d: Date) => void;
}) {
  const dateStr = toDateStr(date);
  const { data: daySessions, isLoading } = useListSessions({
    from: dateStr,
    to: dateStr,
    limit: 100,
  });
  const { data: dayMetrics } = useGetDailyMetrics({ from: dateStr, to: dateStr });
  const dayData = dayMetrics?.days[0];
  const t = today();

  return (
    <div className="p-4 pb-24 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => setDate(addDays(date, -1))}>←</Button>
        <span className="text-sm font-medium text-foreground">{fullDate(date)}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDate(addDays(date, 1))}
          disabled={date >= t}
        >→</Button>
      </div>

      {dayData && <DailyStatGrid dayData={dayData} />}

      <div className="bg-card border border-border rounded-2xl py-4">
        <h3 className="px-4 text-sm font-semibold text-foreground mb-2">Timeline</h3>
        {isLoading ? (
          <Skeleton className="mx-4 h-12 rounded-xl" />
        ) : (
          <DailyTimeline sessions={daySessions?.sessions ?? []} />
        )}
      </div>
    </div>
  );
}
