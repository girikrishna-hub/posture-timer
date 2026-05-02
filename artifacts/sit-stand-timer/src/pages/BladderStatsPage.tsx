import { useState, useMemo } from "react";
import { Link } from "wouter";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  useBladder,
  computeDaySummary,
  computeDailyAggregate,
  stabilityLabel,
  stabilityColor,
  type BladderLog,
  type BladderDaySummary,
} from "@/contexts/BladderContext";

// ─── Date helpers ─────────────────────────────────────────────────────────────

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function weekLabel(d: Date): string {
  // ISO week start = Monday
  const day = d.getDay() === 0 ? 7 : d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day - 1));
  const sunday = addDays(monday, 6);
  const fmt = (x: Date) =>
    x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(monday)}–${fmt(sunday)}`;
}

function mondayOf(d: Date): Date {
  const day = d.getDay() === 0 ? 7 : d.getDay();
  const m = new Date(d);
  m.setDate(d.getDate() - (day - 1));
  m.setHours(0, 0, 0, 0);
  return m;
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

interface PeriodStats {
  label: string;
  totalCycles: number;
  onTimeCount: number;
  onTimePercent: number;
  delayedCount: number;
  leakageCount: number;
  hasData: boolean;
}

function aggregateDays(logs: BladderLog[], dates: string[], label: string): PeriodStats {
  let totalCycles = 0;
  let onTimeCount = 0;
  let delayedCount = 0;
  let leakageCount = 0;

  for (const date of dates) {
    const s = computeDaySummary(logs, date);
    totalCycles += s.totalCycles;
    onTimeCount += s.onTimeCount;
    delayedCount += s.delayedCount;
    leakageCount += s.leakageCount;
  }

  const onTimePercent = totalCycles > 0 ? Math.round((onTimeCount / totalCycles) * 100) : 0;

  return {
    label,
    totalCycles,
    onTimeCount,
    onTimePercent,
    delayedCount,
    leakageCount,
    hasData: totalCycles > 0,
  };
}

// ─── Shared stat card ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2.5 flex flex-col gap-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color ?? "text-foreground"}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-xl px-3 py-2 shadow-lg text-xs space-y-1">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-bold">{p.value}{p.name === "On-time %" ? "%" : ""}</span>
        </p>
      ))}
    </div>
  );
}

// ─── Daily tab ────────────────────────────────────────────────────────────────

function DailyTab({ logs }: { logs: BladderLog[] }) {
  const today = new Date();
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(today, -(6 - i));
      const key = dateStr(d);
      const s = computeDaySummary(logs, key);
      const agg = computeDailyAggregate(logs, key);
      return {
        key,
        shortLabel: d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }),
        dayLabel: i === 6 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" }),
        score: agg.score,
        missedCount: agg.missedCount,
        maxSafeInterval: agg.maxSafeInterval,
        ...s,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  const totals = useMemo(() => {
    const tc = days.reduce((a, d) => a + d.totalCycles, 0);
    const ot = days.reduce((a, d) => a + d.onTimeCount, 0);
    const dl = days.reduce((a, d) => a + d.delayedCount, 0);
    const lk = days.reduce((a, d) => a + d.leakageCount, 0);
    return { tc, ot, dl, lk, pct: tc > 0 ? Math.round((ot / tc) * 100) : 0 };
  }, [days]);

  const chartData = days.map((d) => ({
    name: d.dayLabel,
    "On-time %": d.totalCycles > 0 ? d.onTimePercent : null,
    Delayed: d.delayedCount || null,
    Leakage: d.leakageCount || null,
  }));

  return (
    <div className="space-y-4">
      {/* 7-day summary cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Cycles (7 days)" value={String(totals.tc)} />
        <StatCard
          label="On-time rate"
          value={`${totals.pct}%`}
          color={totals.pct >= 80 ? "text-emerald-600 dark:text-emerald-400" : totals.pct >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}
        />
        <StatCard label="Delayed" value={String(totals.dl)} />
        <StatCard
          label="Leakage"
          value={String(totals.lk)}
          color={totals.lk > 0 ? "text-red-600 dark:text-red-400" : undefined}
        />
      </div>

      {/* On-time % bar chart */}
      <div className="rounded-2xl border border-border bg-card px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-foreground mb-3">On-time % by day</p>
        {totals.tc === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No data for the last 7 days.</p>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} barSize={24} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="On-time %" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry["On-time %"] === null
                        ? "hsl(var(--muted))"
                        : (entry["On-time %"] ?? 0) >= 80
                        ? "#10b981"
                        : (entry["On-time %"] ?? 0) >= 60
                        ? "#f59e0b"
                        : "#ef4444"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Day-by-day table */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-foreground">Day breakdown</p>
        </div>
        <div className="divide-y divide-border">
          {[...days].reverse().map((d) => (
            <div key={d.key} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{d.dayLabel}</p>
                <p className="text-xs text-muted-foreground">{d.key}</p>
              </div>
              {d.totalCycles === 0 ? (
                <span className="text-xs text-muted-foreground">No data</span>
              ) : (
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-2 text-xs tabular-nums">
                    <span className="text-muted-foreground">{d.totalCycles} cycle{d.totalCycles !== 1 ? "s" : ""}</span>
                    {d.leakageCount > 0 && (
                      <span className="text-red-600 dark:text-red-400">⚠ {d.leakageCount} leak</span>
                    )}
                    {d.missedCount > 0 && (
                      <span className="text-orange-600 dark:text-orange-400">✗ {d.missedCount} missed</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-bold tabular-nums ${stabilityColor(d.score)}`}>
                      {d.score}
                    </span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-muted/60 ${stabilityColor(d.score)}`}>
                      {stabilityLabel(d.score)}
                    </span>
                    {d.maxSafeInterval !== null && (
                      <span className="text-[10px] text-muted-foreground">max {d.maxSafeInterval}m</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Weekly tab ───────────────────────────────────────────────────────────────

function WeeklyTab({ logs }: { logs: BladderLog[] }) {
  const today = new Date();

  const weeks = useMemo(() => {
    return Array.from({ length: 4 }, (_, i) => {
      const monday = mondayOf(addDays(today, -(3 - i) * 7));
      const dates = Array.from({ length: 7 }, (_, j) => dateStr(addDays(monday, j)));
      const label = i === 3 ? "This week" : weekLabel(monday);
      return aggregateDays(logs, dates, label);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  const chartData = weeks.map((w) => ({
    name: w.label.split("–")[0], // just "Jan 6" for chart brevity
    "On-time %": w.hasData ? w.onTimePercent : null,
    Cycles: w.totalCycles || null,
  }));

  const best = weeks.reduce<PeriodStats | null>((b, w) => {
    if (!w.hasData) return b;
    if (!b || w.onTimePercent > b.onTimePercent) return w;
    return b;
  }, null);

  return (
    <div className="space-y-4">
      {/* On-time % chart */}
      <div className="rounded-2xl border border-border bg-card px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-foreground mb-3">On-time % by week</p>
        {weeks.every((w) => !w.hasData) ? (
          <p className="text-xs text-muted-foreground text-center py-6">No data for the last 4 weeks.</p>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} barSize={32} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="On-time %" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry["On-time %"] === null
                        ? "hsl(var(--muted))"
                        : (entry["On-time %"] ?? 0) >= 80
                        ? "#10b981"
                        : (entry["On-time %"] ?? 0) >= 60
                        ? "#f59e0b"
                        : "#ef4444"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Week cards */}
      <div className="space-y-3">
        {[...weeks].reverse().map((w, i) => (
          <div key={i} className="rounded-2xl border border-border bg-card px-4 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">{w.label}</p>
              {w.hasData && (
                <span className={`text-sm font-bold tabular-nums ${w.onTimePercent >= 80 ? "text-emerald-600 dark:text-emerald-400" : w.onTimePercent >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>
                  {w.onTimePercent}% on-time
                </span>
              )}
            </div>
            {!w.hasData ? (
              <p className="text-xs text-muted-foreground">No completed cycles this week.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center">
                  <p className="text-lg font-bold text-foreground tabular-nums">{w.totalCycles}</p>
                  <p className="text-xs text-muted-foreground">Cycles</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">{w.delayedCount}</p>
                  <p className="text-xs text-muted-foreground">Delayed</p>
                </div>
                <div className="text-center">
                  <p className={`text-lg font-bold tabular-nums ${w.leakageCount > 0 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{w.leakageCount}</p>
                  <p className="text-xs text-muted-foreground">Leakage</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {best && (
        <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3">
          <p className="text-sm text-emerald-800 dark:text-emerald-300">
            <span className="font-semibold">Best week:</span> {best.label} — {best.onTimePercent}% on-time across {best.totalCycles} cycles
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Monthly tab ──────────────────────────────────────────────────────────────

function MonthlyTab({ logs }: { logs: BladderLog[] }) {
  const today = new Date();

  const months = useMemo(() => {
    return Array.from({ length: 3 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth() - (2 - i), 1);
      const key = monthKey(d);
      const label = i === 2 ? "This month" : monthLabel(d);

      // collect all dates in this month
      const year = d.getFullYear();
      const month = d.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const dates = Array.from({ length: daysInMonth }, (_, j) =>
        dateStr(new Date(year, month, j + 1)),
      );

      return { key, ...aggregateDays(logs, dates, label) };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  const chartData = months.map((m) => ({
    name: m.label.split(" ")[0], // "Jan", "This", etc — keep short
    "On-time %": m.hasData ? m.onTimePercent : null,
    Cycles: m.totalCycles || null,
  }));

  // Per-day heatmap for current month
  const currentMonthKey = monthKey(today);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const daysInCurrentMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const calendarDays = useMemo(() => {
    return Array.from({ length: daysInCurrentMonth }, (_, j) => {
      const d = new Date(currentYear, currentMonth, j + 1);
      const key = dateStr(d);
      const s = computeDaySummary(logs, key);
      return { day: j + 1, date: key, ...s, isToday: key === dateStr(today) };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, currentYear, currentMonth, daysInCurrentMonth, currentMonthKey]);

  const firstDayOfWeek = new Date(currentYear, currentMonth, 1).getDay(); // 0=Sun
  const leadingBlanks = firstDayOfWeek;

  function cellColor(s: BladderDaySummary & { isToday?: boolean }): string {
    if (s.totalCycles === 0) return "bg-muted/30";
    if (s.leakageCount > 0) return "bg-red-400 dark:bg-red-600";
    if (s.onTimePercent >= 80) return "bg-emerald-400 dark:bg-emerald-600";
    if (s.onTimePercent >= 60) return "bg-amber-400 dark:bg-amber-500";
    return "bg-orange-400 dark:bg-orange-600";
  }

  return (
    <div className="space-y-4">
      {/* Monthly summary cards */}
      <div className="space-y-3">
        {[...months].reverse().map((m, i) => (
          <div key={i} className="rounded-2xl border border-border bg-card px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-foreground">{m.label}</p>
              {m.hasData && (
                <span className={`text-sm font-bold tabular-nums ${m.onTimePercent >= 80 ? "text-emerald-600 dark:text-emerald-400" : m.onTimePercent >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>
                  {m.onTimePercent}% on-time
                </span>
              )}
            </div>
            {!m.hasData ? (
              <p className="text-xs text-muted-foreground">No data this month.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center">
                  <p className="text-lg font-bold text-foreground tabular-nums">{m.totalCycles}</p>
                  <p className="text-xs text-muted-foreground">Cycles</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">{m.delayedCount}</p>
                  <p className="text-xs text-muted-foreground">Delayed</p>
                </div>
                <div className="text-center">
                  <p className={`text-lg font-bold tabular-nums ${m.leakageCount > 0 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{m.leakageCount}</p>
                  <p className="text-xs text-muted-foreground">Leakage</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 3-month comparison chart */}
      <div className="rounded-2xl border border-border bg-card px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-foreground mb-3">On-time % comparison</p>
        {months.every((m) => !m.hasData) ? (
          <p className="text-xs text-muted-foreground text-center py-6">No data yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={chartData} barSize={48} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="On-time %" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry["On-time %"] === null
                        ? "hsl(var(--muted))"
                        : (entry["On-time %"] ?? 0) >= 80
                        ? "#10b981"
                        : (entry["On-time %"] ?? 0) >= 60
                        ? "#f59e0b"
                        : "#ef4444"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Current-month heatmap calendar */}
      <div className="rounded-2xl border border-border bg-card px-4 py-4">
        <p className="text-sm font-semibold text-foreground mb-3">
          {today.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </p>

        {/* Day-of-week labels */}
        <div className="grid grid-cols-7 mb-1">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="text-center text-[10px] text-muted-foreground font-medium py-1">{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`blank-${i}`} />
          ))}
          {calendarDays.map((day) => (
            <div
              key={day.day}
              title={
                day.totalCycles > 0
                  ? `${day.date}: ${day.totalCycles} cycles, ${day.onTimePercent}% on-time${day.leakageCount > 0 ? `, ${day.leakageCount} leakage` : ""}`
                  : day.date
              }
              className={[
                "aspect-square rounded-md flex items-center justify-center text-[11px] font-medium transition-colors",
                cellColor(day),
                day.totalCycles > 0 ? "text-white" : "text-muted-foreground",
                day.isToday ? "ring-2 ring-blue-500 ring-offset-1" : "",
              ].join(" ")}
            >
              {day.day}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 mt-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-muted/30 inline-block" /> No data</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-400 dark:bg-emerald-600 inline-block" /> ≥80%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-400 dark:bg-amber-500 inline-block" /> 60–79%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-orange-400 dark:bg-orange-600 inline-block" /> &lt;60%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-400 dark:bg-red-600 inline-block" /> Leakage</span>
        </div>
      </div>
    </div>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

type Tab = "daily" | "weekly" | "monthly";

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "daily", label: "Daily" },
    { id: "weekly", label: "Weekly" },
    { id: "monthly", label: "Monthly" },
  ];
  return (
    <div className="flex rounded-xl bg-muted/50 p-1 gap-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={[
            "flex-1 rounded-lg py-1.5 text-sm font-medium transition-all",
            active === t.id
              ? "bg-card shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground",
          ].join(" ")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BladderStatsPage() {
  const { logs } = useBladder();
  const [tab, setTab] = useState<Tab>("daily");

  const completedLogs = useMemo(
    () => logs.filter((l) => l.status !== "pending"),
    [logs],
  );

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <Link
          href="/bladder"
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted -ml-1.5"
          aria-label="Back to Bladder Schedule"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <div className="flex items-center gap-2">
          <span className="text-xl">💧</span>
          <h1 className="text-base font-semibold text-foreground">Bladder Statistics</h1>
        </div>
      </div>

      <div className="px-4 pt-4 space-y-4 max-w-lg mx-auto">
        <TabBar active={tab} onChange={setTab} />

        {completedLogs.length === 0 && (
          <div className="rounded-2xl border border-border bg-card px-4 py-8 text-center space-y-2">
            <p className="text-3xl">💧</p>
            <p className="text-sm font-medium text-foreground">No data yet</p>
            <p className="text-xs text-muted-foreground">
              Enable Bladder Schedule and complete some cycles to see statistics here.
            </p>
            <Link
              href="/bladder"
              className="inline-block mt-2 text-sm font-medium text-blue-600 dark:text-blue-400 underline underline-offset-2"
            >
              Go to Bladder Schedule
            </Link>
          </div>
        )}

        {completedLogs.length > 0 && (
          <>
            {tab === "daily" && <DailyTab logs={completedLogs} />}
            {tab === "weekly" && <WeeklyTab logs={completedLogs} />}
            {tab === "monthly" && <MonthlyTab logs={completedLogs} />}
          </>
        )}
      </div>
    </div>
  );
}
