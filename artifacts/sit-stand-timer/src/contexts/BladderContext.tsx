import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

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

// ─── Context ─────────────────────────────────────────────────────────────────

interface BladderContextValue {
  enabled: boolean;
  intervalMinutes: number;
  setIntervalMinutes: (v: number) => void;
  nextVoidAt: Date | null;
  pendingLog: BladderLog | null;
  logs: BladderLog[];
  todaySummary: BladderDaySummary;
  suggestion: BladderSuggestion;
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

  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef(intervalMinutes);
  const enabledRef  = useRef(enabled);

  useEffect(() => { intervalRef.current = intervalMinutes; }, [intervalMinutes]);
  useEffect(() => { enabledRef.current  = enabled; }, [enabled]);

  // ── derived ───────────────────────────────────────────────────────────────
  const todaySummary = computeDaySummary(logs, todayStr());
  const suggestion   = computeSuggestion(logs, intervalMinutes);

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
        suggestion,
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
