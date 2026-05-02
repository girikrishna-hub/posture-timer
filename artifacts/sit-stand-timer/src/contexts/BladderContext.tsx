import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTimer } from "@/contexts/TimerContext";

// ─── Types ─────────────────────────────────────────────────────────────────

export type BladderStatus = "done_on_time" | "delayed" | "leakage" | "pending";

export interface BladderLog {
  id: string;
  date: string;        // YYYY-MM-DD
  scheduledAt: string; // ISO
  respondedAt?: string;
  status: BladderStatus;
  intervalMinutes: number;
}

// ─── Storage helpers ────────────────────────────────────────────────────────

const KEY_ENABLED      = "bladder_enabled";
const KEY_INTERVAL     = "bladder_interval_minutes";
const KEY_LOGS         = "bladder_logs";
const KEY_PENDING      = "bladder_pending_log";
/**
 * Absolute epoch-ms timestamp of when the NEXT void should fire.
 * Persisted so a page refresh or background-kill can resume the exact
 * remaining time rather than restarting the full interval.
 */
const KEY_NEXT_VOID_AT = "bladder_next_void_at";

export const DEFAULT_INTERVAL = 60;
export const MIN_INTERVAL     = 45;
export const MAX_INTERVAL     = 120;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadEnabled(): boolean {
  try { return localStorage.getItem(KEY_ENABLED) === "true"; } catch { return false; }
}
function saveEnabled(v: boolean) {
  try { localStorage.setItem(KEY_ENABLED, v ? "true" : "false"); } catch { /* ignore */ }
}

function loadInterval(): number {
  try {
    const raw = localStorage.getItem(KEY_INTERVAL);
    if (!raw) return DEFAULT_INTERVAL;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? DEFAULT_INTERVAL : Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
  } catch { return DEFAULT_INTERVAL; }
}
function saveInterval(v: number) {
  try { localStorage.setItem(KEY_INTERVAL, String(v)); } catch { /* ignore */ }
}

function loadLogs(): BladderLog[] {
  try {
    const raw = localStorage.getItem(KEY_LOGS);
    return raw ? (JSON.parse(raw) as BladderLog[]) : [];
  } catch { return []; }
}
function saveLogs(logs: BladderLog[]) {
  try { localStorage.setItem(KEY_LOGS, JSON.stringify(logs)); } catch { /* ignore */ }
}

function loadPending(): BladderLog | null {
  try {
    const raw = localStorage.getItem(KEY_PENDING);
    return raw ? (JSON.parse(raw) as BladderLog) : null;
  } catch { return null; }
}
function savePending(log: BladderLog | null) {
  try {
    if (log) localStorage.setItem(KEY_PENDING, JSON.stringify(log));
    else localStorage.removeItem(KEY_PENDING);
  } catch { /* ignore */ }
}

function loadNextVoidAt(): number | null {
  try {
    const raw = localStorage.getItem(KEY_NEXT_VOID_AT);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch { return null; }
}
function saveNextVoidAt(epochMs: number | null) {
  try {
    if (epochMs === null) localStorage.removeItem(KEY_NEXT_VOID_AT);
    else localStorage.setItem(KEY_NEXT_VOID_AT, String(epochMs));
  } catch { /* ignore */ }
}

// ─── SW helpers ─────────────────────────────────────────────────────────────

function scheduleSWBladder(delayMs: number, logId: string) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage({
      type: "SCHEDULE_BLADDER_NOTIFICATION",
      delayMs,
      logId,
    });
  }).catch(() => { /* ignore */ });
}

function cancelSWBladder() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage({ type: "CANCEL_BLADDER_NOTIFICATION" });
  }).catch(() => { /* ignore */ });
}

function showBladderNotificationNow() {
  if (!("serviceWorker" in navigator)) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  navigator.serviceWorker.ready.then((reg) => {
    const opts = {
      body: "Go now. Do not delay.",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      tag: "bladder-reminder",
      renotify: true,
      requireInteraction: true,
      data: { url: "/bladder" },
      actions: [
        { action: "done", title: "✓ Done" },
        { action: "snooze", title: "⏱ Snooze 5 min" },
      ],
    };
    reg.showNotification("Time to void", opts as NotificationOptions).catch(() => { /* ignore */ });
  }).catch(() => { /* ignore */ });
}

// ─── Analytics helpers ───────────────────────────────────────────────────────

export interface BladderDaySummary {
  totalCycles: number;
  onTimeCount: number;
  onTimePercent: number;
  delayedCount: number;
  leakageCount: number;
  avgIntervalMinutes: number | null;
}

export type BladderSuggestion = "increase" | "decrease" | null;

export function computeDaySummary(logs: BladderLog[], date: string): BladderDaySummary {
  const day = logs.filter((l) => l.date === date && l.status !== "pending");
  const totalCycles = day.length;
  const onTimeCount  = day.filter((l) => l.status === "done_on_time").length;
  const delayedCount = day.filter((l) => l.status === "delayed").length;
  const leakageCount = day.filter((l) => l.status === "leakage").length;
  const onTimePercent = totalCycles > 0 ? Math.round((onTimeCount / totalCycles) * 100) : 0;
  const intervals = day.map((l) => l.intervalMinutes).filter((n) => n > 0);
  const avgIntervalMinutes =
    intervals.length > 0
      ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
      : null;
  return { totalCycles, onTimeCount, onTimePercent, delayedCount, leakageCount, avgIntervalMinutes };
}

export function computeSuggestion(
  logs: BladderLog[],
  intervalMinutes: number,
): BladderSuggestion {
  const past3: string[] = [];
  for (let offset = 1; offset <= 3; offset++) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    past3.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }
  const dayLogs = past3.map((date) =>
    logs.filter((l) => l.date === date && l.status !== "pending"),
  );
  if (dayLogs.some((d) => d.length === 0)) return null;
  if (dayLogs.some((d) => d.some((l) => l.status === "leakage"))) {
    return intervalMinutes > MIN_INTERVAL ? "decrease" : null;
  }
  const allOnTime = dayLogs.every((d) => {
    const onTime = d.filter((l) => l.status === "done_on_time").length;
    return d.length > 0 && onTime / d.length >= 0.9;
  });
  if (allOnTime) return intervalMinutes < MAX_INTERVAL ? "increase" : null;
  return null;
}

// ─── Stability score helpers ──────────────────────────────────────────────────

/**
 * Daily aggregate for the Bladder Stability Score system.
 *
 * missed_count = auto-resolved delayed logs (respondedAt absent).
 * delayed_count = manually responded delayed logs (respondedAt present).
 */
export interface BladderDailyAggregate {
  date: string;
  leakageCount: number;
  /** User tapped "Delayed" themselves */
  delayedCount: number;
  /** Auto-resolved: no response within the interval */
  missedCount: number;
  score: number;
  maxSafeInterval: number | null;
}

/**
 * Score = 100 - (leakage×25) - (delayed×10) - (missed×15), clamped 0–100.
 */
export function computeStabilityScore(
  leakageCount: number,
  delayedCount: number,
  missedCount: number,
): number {
  return Math.max(0, Math.min(100, 100 - leakageCount * 25 - delayedCount * 10 - missedCount * 15));
}

/**
 * Returns the longest successful interval (minutes) in the day.
 * A "void event" is done_on_time or delayed.
 * An interval is successful when the event that ENDS it is NOT leakage.
 */
export function computeMaxSafeInterval(logs: BladderLog[], date: string): number | null {
  const voidEvents = logs
    .filter(
      (l) =>
        l.date === date &&
        (l.status === "done_on_time" || l.status === "delayed" || l.status === "leakage"),
    )
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  if (voidEvents.length < 2) return null;

  let maxSafe = 0;
  for (let i = 1; i < voidEvents.length; i++) {
    const prev = voidEvents[i - 1];
    const curr = voidEvents[i];
    if (curr.status === "leakage") continue; // interval failed
    const diffMin =
      (new Date(curr.scheduledAt).getTime() - new Date(prev.scheduledAt).getTime()) / 60000;
    if (diffMin > 0) maxSafe = Math.max(maxSafe, diffMin);
  }

  return maxSafe > 0 ? Math.round(maxSafe) : null;
}

/**
 * Full daily aggregate computed purely from the raw log array.
 */
export function computeDailyAggregate(logs: BladderLog[], date: string): BladderDailyAggregate {
  const day = logs.filter((l) => l.date === date && l.status !== "pending");
  const leakageCount = day.filter((l) => l.status === "leakage").length;
  // missed = auto-resolved delayed (no respondedAt written by the user)
  const missedCount  = day.filter((l) => l.status === "delayed" && !l.respondedAt).length;
  const delayedCount = day.filter((l) => l.status === "delayed" && !!l.respondedAt).length;
  const score = computeStabilityScore(leakageCount, delayedCount, missedCount);
  const maxSafeInterval = computeMaxSafeInterval(logs, date);
  return { date, leakageCount, delayedCount, missedCount, score, maxSafeInterval };
}

export type StabilityLabel = "Stable" | "Controlled" | "Unstable" | "Poor";

export function stabilityLabel(score: number): StabilityLabel {
  if (score >= 90) return "Stable";
  if (score >= 75) return "Controlled";
  if (score >= 50) return "Unstable";
  return "Poor";
}

export function stabilityColor(score: number): string {
  if (score >= 90) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 75) return "text-blue-600 dark:text-blue-400";
  if (score >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export type GuidanceAction = "reduce" | "increase" | "maintain";

export interface BladderGuidance {
  action: GuidanceAction;
  message: string;
}

/**
 * Decision engine per the spec:
 * - leakage today → reduce
 * - score ≥ 90 for 3 consecutive days (today + past 2) → increase
 * - otherwise → maintain
 */
export function computeGuidance(
  logs: BladderLog[],
  intervalMinutes: number,
): BladderGuidance {
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const todayAgg = computeDailyAggregate(logs, todayKey);

  if (todayAgg.leakageCount > 0) {
    const next = Math.max(MIN_INTERVAL, intervalMinutes - 15);
    return {
      action: "reduce",
      message:
        intervalMinutes > MIN_INTERVAL
          ? `Interval may be too long. Consider reducing to ${next} min.`
          : "Leakage detected. You are already at the minimum interval.",
    };
  }

  // Check 3 consecutive days with score ≥ 90
  const streak = [0, 1, 2].map((offset) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return computeDailyAggregate(logs, key);
  });

  const hasThreeHighDays =
    streak.every((a) => a.leakageCount + a.delayedCount + a.missedCount > 0 || a.score >= 90) &&
    streak.every((a) => a.score >= 90);

  if (hasThreeHighDays && intervalMinutes < MAX_INTERVAL) {
    const next = Math.min(MAX_INTERVAL, intervalMinutes + 15);
    return {
      action: "increase",
      message: `3 stable days in a row! Consider increasing to ${next} min.`,
    };
  }

  return { action: "maintain", message: "Maintain current interval." };
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface BladderContextValue {
  enabled: boolean;
  intervalMinutes: number;
  setIntervalMinutes: (v: number) => void;
  nextVoidAt: Date | null;
  pendingLog: BladderLog | null;
  logs: BladderLog[];
  todaySummary: BladderDaySummary;
  todayAggregate: BladderDailyAggregate;
  suggestion: BladderSuggestion;
  guidance: BladderGuidance;
  toggle: () => void;
  respond: (status: Exclude<BladderStatus, "pending">) => void;
  applyIntervalSuggestion: () => void;
}

const BladderContext = createContext<BladderContextValue | null>(null);

export function BladderProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState]       = useState(loadEnabled);
  const [intervalMinutes, setIntervalState] = useState(loadInterval);
  const [logs, setLogsState]             = useState<BladderLog[]>(loadLogs);
  const [pendingLog, setPendingLog]      = useState<BladderLog | null>(loadPending);
  const [nextVoidAt, setNextVoidAt]      = useState<Date | null>(() => {
    const stored = loadNextVoidAt();
    return stored ? new Date(stored) : null;
  });

  const { mode: timerMode, restType: timerRestType } = useTimer();

  const timerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef    = useRef(intervalMinutes);
  const enabledRef     = useRef(enabled);
  const wasSleepingRef = useRef(false);

  useEffect(() => { intervalRef.current = intervalMinutes; }, [intervalMinutes]);
  useEffect(() => { enabledRef.current  = enabled; }, [enabled]);

  // ── derived ───────────────────────────────────────────────────────────────
  const todaySummary   = computeDaySummary(logs, todayStr());
  const todayAggregate = computeDailyAggregate(logs, todayStr());
  const suggestion     = computeSuggestion(logs, intervalMinutes);
  const guidance       = computeGuidance(logs, intervalMinutes);

  // ── storage commit helpers ─────────────────────────────────────────────────
  const commitLogs = useCallback((updated: BladderLog[]) => {
    saveLogs(updated);
    setLogsState(updated);
  }, []);

  const commitPending = useCallback((log: BladderLog | null) => {
    savePending(log);
    setPendingLog(log);
  }, []);

  // ── fireCycle — create a pending log entry and show the notification ───────
  // Uses a ref so scheduleTimer can call it without a stale closure.
  const fireCycleRef = useRef<(() => void) | null>(null);

  // ── scheduleTimer — arm (or immediately fire) the void-cycle timer ─────────
  //
  // Takes an absolute epoch-ms timestamp so a page refresh or foreground-resume
  // can use the stored deadline instead of restarting the full interval.
  //
  // If the deadline is already past AND no pendingLog is pending, the cycle
  // fires immediately (catches up after a background kill).
  // If a pendingLog already exists the deadline is still in the future (it was
  // set by the previous fireCycle call), so the timer just arms normally.
  const scheduleTimer = useCallback((nextVoidAtMs: number) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const remaining = nextVoidAtMs - Date.now();

    if (remaining <= 0) {
      // Past due — fire now, but only if there is no unanswered pending log
      // (a pending log means fireCycle already ran; we just need to wait for
      // the user to respond and then the next scheduled timer will be active).
      const currentPending = loadPending();
      if (!currentPending) {
        fireCycleRef.current?.();
      }
      return;
    }

    setNextVoidAt(new Date(nextVoidAtMs));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Auto-resolve any unanswered pending log as "delayed" before firing
      const prev = loadPending();
      if (prev) {
        const existing = loadLogs();
        const updated = existing.map((l) =>
          l.id === prev.id ? { ...l, status: "delayed" as BladderStatus } : l,
        );
        if (!updated.find((l) => l.id === prev.id)) {
          updated.push({ ...prev, status: "delayed" });
        }
        saveLogs(updated);
        setLogsState(updated);
        savePending(null);
        setPendingLog(null);
      }
      fireCycleRef.current?.();
    }, remaining);

    // Keep SW in sync — always schedule relative to now so the notification
    // fires at the correct absolute time even if the SW was cleared.
    scheduleSWBladder(remaining, "");
  }, []);

  // Stable fireCycle that uses refs so scheduleTimer's closure stays fresh.
  useEffect(() => {
    fireCycleRef.current = () => {
      const now = new Date();
      const log: BladderLog = {
        id: crypto.randomUUID(),
        date: todayStr(),
        scheduledAt: now.toISOString(),
        status: "pending",
        intervalMinutes: intervalRef.current,
      };
      savePending(log);
      setPendingLog(log);

      showBladderNotificationNow();

      // Compute and persist the NEXT void deadline immediately so a crash or
      // refresh between now and the user's response preserves the schedule.
      const nextMs   = intervalRef.current * 60 * 1000;
      const nextAtMs = Date.now() + nextMs;
      saveNextVoidAt(nextAtMs);
      setNextVoidAt(new Date(nextAtMs));

      scheduleTimer(nextAtMs);
    };
  }, [scheduleTimer]);

  // ── startSchedule — begin a fresh cycle from now ───────────────────────────
  const startSchedule = useCallback(() => {
    const ms        = intervalRef.current * 60 * 1000;
    const nextAtMs  = Date.now() + ms;
    saveNextVoidAt(nextAtMs);
    scheduleTimer(nextAtMs);
  }, [scheduleTimer]);

  // ── stopSchedule — cancel everything ──────────────────────────────────────
  const stopSchedule = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelSWBladder();
    saveNextVoidAt(null);
    setNextVoidAt(null);
  }, []);

  // ── pauseSchedule — suspend timer without losing the stored deadline ───────
  //
  // Used when the user enters sleep mode. The next-void deadline is kept in
  // localStorage so that when sleep ends we can resume from the exact moment
  // that was left rather than restarting the full interval.
  const pauseSchedule = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelSWBladder();
    setNextVoidAt(null); // clear visual countdown; stored deadline is preserved
  }, []);

  // ── toggle ─────────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      saveEnabled(next);
      if (next) {
        // If we have a stored deadline, resume from it; otherwise start fresh.
        const stored = loadNextVoidAt();
        if (stored) {
          setTimeout(() => scheduleTimer(stored), 0);
        } else {
          setTimeout(startSchedule, 0);
        }
      } else {
        stopSchedule();
        commitPending(null);
      }
      return next;
    });
  }, [scheduleTimer, startSchedule, stopSchedule, commitPending]);

  // ── respond ───────────────────────────────────────────────────────────────
  const respond = useCallback(
    (status: Exclude<BladderStatus, "pending">) => {
      setPendingLog((current) => {
        if (!current) return null;
        const resolved: BladderLog = {
          ...current,
          status,
          respondedAt: new Date().toISOString(),
        };
        const existing = loadLogs();
        const withoutPrev = existing.filter((l) => l.id !== resolved.id);
        commitLogs([...withoutPrev, resolved]);
        savePending(null);
        return null;
      });
    },
    [commitLogs],
  );

  // ── setIntervalMinutes ─────────────────────────────────────────────────────
  const setIntervalMinutes = useCallback(
    (v: number) => {
      const clamped = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, v));
      saveInterval(clamped);
      setIntervalState(clamped);
      intervalRef.current = clamped;
      if (enabledRef.current) {
        // Restart with new interval from now (interval change resets the clock)
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        const nextAtMs = Date.now() + clamped * 60 * 1000;
        saveNextVoidAt(nextAtMs);
        scheduleTimer(nextAtMs);
      }
    },
    [scheduleTimer],
  );

  // ── applyIntervalSuggestion ────────────────────────────────────────────────
  const applyIntervalSuggestion = useCallback(() => {
    if (!suggestion) return;
    const delta = suggestion === "increase" ? 15 : -15;
    setIntervalMinutes(intervalMinutes + delta);
  }, [suggestion, intervalMinutes, setIntervalMinutes]);

  // ── SW message listener (notification action callbacks) ───────────────────
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "BLADDER_ACTION_DONE") {
        setPendingLog((prev) => {
          if (!prev) return null;
          const resolved: BladderLog = {
            ...prev,
            status: "done_on_time",
            respondedAt: new Date().toISOString(),
          };
          const existing = loadLogs();
          const updated = [...existing.filter((l) => l.id !== resolved.id), resolved];
          saveLogs(updated);
          setLogsState(updated);
          savePending(null);
          return null;
        });
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  // ── Mount: resume from persisted deadline ─────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const stored = loadNextVoidAt();
    if (stored) {
      scheduleTimer(stored);
    } else {
      startSchedule();
    }
    return () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
    // Intentionally only runs on mount — subsequent changes handled by toggle/setInterval
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sleep-mode integration ─────────────────────────────────────────────────
  //
  // When the user enters sleep mode (resting + restType === "sleep") the bladder
  // schedule is PAUSED — the JS timer and SW notification are cancelled but the
  // stored deadline in localStorage is preserved.  When sleep ends the schedule
  // resumes from that exact deadline (or starts fresh if none exists).
  //
  // Rest / nap mode leaves the schedule running unchanged.
  useEffect(() => {
    const isSleeping = timerMode === "resting" && timerRestType === "sleep";

    if (isSleeping) {
      if (!wasSleepingRef.current && enabledRef.current) {
        wasSleepingRef.current = true;
        pauseSchedule();
      }
    } else {
      if (wasSleepingRef.current) {
        wasSleepingRef.current = false;
        if (enabledRef.current) {
          const stored = loadNextVoidAt();
          if (stored) {
            scheduleTimer(stored);
          } else {
            startSchedule();
          }
        }
      }
    }
  }, [timerMode, timerRestType, pauseSchedule, scheduleTimer, startSchedule]);

  // ── Visibility change: re-arm timer after browser throttling ──────────────
  //
  // Mobile browsers throttle/kill setTimeout when the app is backgrounded.
  // When the user returns, we recalculate the remaining time from the stored
  // deadline so the timer fires at the correct absolute time.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (!enabledRef.current) return;
      const stored = loadNextVoidAt();
      if (stored) scheduleTimer(stored);
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [scheduleTimer]);

  return (
    <BladderContext.Provider
      value={{
        enabled,
        intervalMinutes,
        setIntervalMinutes,
        nextVoidAt,
        pendingLog,
        logs,
        todaySummary,
        todayAggregate,
        suggestion,
        guidance,
        toggle,
        respond,
        applyIntervalSuggestion,
      }}
    >
      {children}
    </BladderContext.Provider>
  );
}

export function useBladder() {
  const ctx = useContext(BladderContext);
  if (!ctx) throw new Error("useBladder must be used within BladderProvider");
  return ctx;
}
