import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { useBladder, MIN_INTERVAL, MAX_INTERVAL } from "@/contexts/BladderContext";
import { useTimer } from "@/contexts/TimerContext";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useBanner } from "@/hooks/useBanner";
import { BladderHealthCard } from "@/components/BladderHealthCard";

// ─── Countdown helper ────────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function useCountdown(target: Date | null): string {
  const [label, setLabel] = useState("—");

  useEffect(() => {
    if (!target) { setLabel("—"); return; }
    const tick = () => {
      const remaining = target.getTime() - Date.now();
      setLabel(remaining > 0 ? formatCountdown(remaining) : "Now");
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [target]);

  return label;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ToggleRow({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-4">
      <div>
        <p className="text-base font-semibold text-foreground">Bladder Schedule</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Timed voiding reminders to reduce urge incontinence
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={onToggle}
        className={[
          "relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
          "transition-colors duration-200 ease-in-out focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          enabled ? "bg-blue-600" : "bg-muted",
        ].join(" ")}
      >
        <span
          className={[
            "pointer-events-none inline-block h-6 w-6 rounded-full bg-white shadow-md",
            "ring-0 transition-transform duration-200 ease-in-out",
            enabled ? "translate-x-5" : "translate-x-0",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

function ResponseCard({ onRespond }: { onRespond: (s: "done_on_time" | "delayed" | "leakage") => void }) {
  return (
    <div className="rounded-2xl border-2 border-blue-500 bg-blue-50 dark:bg-blue-950/30 p-5 space-y-4">
      <div className="text-center space-y-1">
        <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">Time to void</p>
        <p className="text-sm text-muted-foreground">Go now. Do not delay.</p>
        <p className="text-xs text-muted-foreground mt-1">How did it go?</p>
      </div>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => onRespond("done_on_time")}
          className="w-full rounded-xl bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white font-semibold py-4 text-lg transition-all"
        >
          ✓ Done
        </button>
        <button
          type="button"
          onClick={() => onRespond("delayed")}
          className="w-full rounded-xl bg-amber-400 hover:bg-amber-500 active:scale-95 text-white font-semibold py-4 text-lg transition-all"
        >
          ⏱ Delayed
        </button>
        <button
          type="button"
          onClick={() => onRespond("leakage")}
          className="w-full rounded-xl bg-red-500 hover:bg-red-600 active:scale-95 text-white font-semibold py-4 text-lg transition-all"
        >
          ⚠ Leakage
        </button>
      </div>
    </div>
  );
}

function SummaryCard({
  totalCycles,
  onTimePercent,
  leakageCount,
  delayedCount,
  avgIntervalMinutes,
}: {
  totalCycles: number;
  onTimePercent: number;
  leakageCount: number;
  delayedCount: number;
  avgIntervalMinutes: number | null;
}) {
  const hasData = totalCycles > 0;

  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
      <p className="text-sm font-semibold text-foreground">Today's summary</p>
      {!hasData ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          No cycles completed yet today.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Cycles" value={String(totalCycles)} />
          <Stat label="On time" value={`${onTimePercent}%`} />
          <Stat label="Delayed" value={String(delayedCount)} />
          <Stat
            label="Leakage"
            value={String(leakageCount)}
            highlight={leakageCount > 0 ? "red" : undefined}
          />
          {avgIntervalMinutes !== null && (
            <Stat label="Avg interval" value={`${avgIntervalMinutes} min`} fullWidth />
          )}
        </div>
      )}
      {leakageCount > 0 && (
        <p className="text-xs text-red-600 dark:text-red-400 font-medium">
          Interval may be too long — consider reducing it.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  fullWidth,
}: {
  label: string;
  value: string;
  highlight?: "red";
  fullWidth?: boolean;
}) {
  return (
    <div
      className={[
        "rounded-xl bg-muted/40 px-3 py-2.5 flex flex-col gap-0.5",
        fullWidth ? "col-span-2" : "",
      ].join(" ")}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={[
          "text-xl font-bold tabular-nums",
          highlight === "red" ? "text-red-600 dark:text-red-400" : "text-foreground",
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BladderPage() {
  const {
    enabled,
    intervalMinutes,
    setIntervalMinutes,
    nextVoidAt,
    pendingLog,
    todaySummary,
    suggestion,
    toggle,
    respond,
    applyIntervalSuggestion,
  } = useBladder();

  const countdown = useCountdown(enabled && !pendingLog ? nextVoidAt : null);

  const { notificationPermission: notifPermission, requestNotificationPermission } = useTimer();

  useEffect(() => {
    if (enabled && notifPermission === "default") {
      void requestNotificationPermission();
    }
  }, [enabled, notifPermission, requestNotificationPermission]);

  const suggestionBanner = useBanner(8000);
  useEffect(() => {
    if (suggestion) suggestionBanner.show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion]);

  const handleRespond = useCallback(
    (status: "done_on_time" | "delayed" | "leakage") => {
      respond(status);
    },
    [respond],
  );

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-2">
        <span className="text-xl">💧</span>
        <h1 className="text-base font-semibold text-foreground">Bladder Schedule</h1>
      </div>

      <div className="px-4 pt-4 space-y-4 max-w-lg mx-auto">
        {/* Suggestion banner */}
        {suggestionBanner.shown && suggestion && (
          <div
            className={[
              "rounded-2xl border px-4 py-3 flex items-start justify-between gap-3",
              "transition-all duration-300 ease-out",
              suggestionBanner.visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
              suggestion === "increase"
                ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300"
                : "border-amber-300 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300",
            ].join(" ")}
          >
            <p className="text-sm font-medium leading-snug">
              {suggestion === "increase"
                ? `3 successful days — consider increasing your interval to ${intervalMinutes + 15} min.`
                : `Leakage detected — consider reducing your interval to ${intervalMinutes - 15} min.`}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={applyIntervalSuggestion}
                className="text-xs font-semibold underline underline-offset-2"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={suggestionBanner.dismiss}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Toggle card */}
        <div className="rounded-2xl border border-border bg-card px-4">
          <ToggleRow enabled={enabled} onToggle={toggle} />
        </div>

        {/* Notification permission warning */}
        {notifPermission === "denied" && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
            <p className="text-sm text-amber-800 dark:text-amber-300">
              Notifications are blocked. Enable them in browser settings to receive reminders.
            </p>
          </div>
        )}

        {/* Interval slider */}
        <div className="rounded-2xl border border-border bg-card px-4 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Voiding interval</p>
              <p className="text-xs text-muted-foreground">How often to schedule a void</p>
            </div>
            <span className="text-sm font-semibold tabular-nums text-foreground min-w-[4rem] text-right">
              {intervalMinutes} min
            </span>
          </div>
          <Slider
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            step={15}
            value={[intervalMinutes]}
            onValueChange={([v]) => setIntervalMinutes(v)}
            disabled={!enabled}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{MIN_INTERVAL} min</span>
            <span>{MAX_INTERVAL} min</span>
          </div>
        </div>

        {/* Countdown / pending response */}
        {enabled && !pendingLog && (
          <div className="rounded-2xl border border-border bg-card px-4 py-5 text-center space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
              Next void in
            </p>
            <p className="text-5xl font-bold tabular-nums text-blue-600 dark:text-blue-400 leading-none">
              {countdown}
            </p>
          </div>
        )}

        {enabled && pendingLog && (
          <ResponseCard onRespond={handleRespond} />
        )}

        {/* Bladder health card */}
        <BladderHealthCard />

        {/* Statistics link */}
        <Link
          href="/bladder/stats"
          className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3.5 hover:bg-muted/40 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600 dark:text-blue-400">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <span className="text-sm font-medium text-foreground">Statistics</span>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </Link>

        {/* Today's summary */}
        <SummaryCard
          totalCycles={todaySummary.totalCycles}
          onTimePercent={todaySummary.onTimePercent}
          leakageCount={todaySummary.leakageCount}
          delayedCount={todaySummary.delayedCount}
          avgIntervalMinutes={todaySummary.avgIntervalMinutes}
        />

        {/* Log list — last 10 entries today */}
        <LogList />
      </div>
    </div>
  );
}

function LogList() {
  const { logs } = useBladder();
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayLogs = [...logs]
    .filter((l) => l.date === todayKey && l.status !== "pending")
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
    .slice(0, 10);

  if (todayLogs.length === 0) return null;

  const statusLabel: Record<string, string> = {
    done_on_time: "✓ Done",
    delayed: "⏱ Delayed",
    leakage: "⚠ Leakage",
  };

  const statusColor: Record<string, string> = {
    done_on_time: "text-emerald-600 dark:text-emerald-400",
    delayed: "text-amber-600 dark:text-amber-400",
    leakage: "text-red-600 dark:text-red-400",
  };

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-4 space-y-3">
      <p className="text-sm font-semibold text-foreground">Today's cycles</p>
      <div className="space-y-2">
        {todayLogs.map((log) => (
          <div key={log.id} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground tabular-nums">
              {new Date(log.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className={`font-medium ${statusColor[log.status] ?? ""}`}>
              {statusLabel[log.status] ?? log.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
