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

const KEY_ENABLED  = "bladder_enabled";
const KEY_INTERVAL = "bladder_interval_minutes";
const KEY_LOGS     = "bladder_logs";
const KEY_PENDING  = "bladder_pending_log";

const DEFAULT_INTERVAL = 60;
const MIN_INTERVAL     = 45;
const MAX_INTERVAL     = 120;

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

function showBladderNotification() {
  if (!("serviceWorker" in navigator)) return;
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
  const onTimeCount = day.filter((l) => l.status === "done_on_time").length;
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
  const today = todayStr();

  // Build last-3-days strings (excluding today which may be incomplete)
  const past3: string[] = [];
  for (let offset = 1; offset <= 3; offset++) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    past3.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }

  // Need at least 1 completed cycle each day
  const dayLogs = past3.map((date) =>
    logs.filter((l) => l.date === date && l.status !== "pending"),
  );
  if (dayLogs.some((d) => d.length === 0)) return null;

  // Any leakage → suggest decrease
  if (dayLogs.some((d) => d.some((l) => l.status === "leakage"))) {
    return intervalMinutes > MIN_INTERVAL ? "decrease" : null;
  }

  // 3 days ≥90% on-time, no leakage → suggest increase
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
  const [enabled, setEnabledState]     = useState(loadEnabled);
  const [intervalMinutes, setIntervalState] = useState(loadInterval);
  const [logs, setLogsState]           = useState<BladderLog[]>(loadLogs);
  const [pendingLog, setPendingLog]    = useState<BladderLog | null>(loadPending);
  const [nextVoidAt, setNextVoidAt]    = useState<Date | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const intervalRef  = useRef(intervalMinutes);

  useEffect(() => { intervalRef.current = intervalMinutes; }, [intervalMinutes]);

  // ── derived ──────────────────────────────────────────────────────────────
  const todaySummary = computeDaySummary(logs, todayStr());
  const suggestion   = computeSuggestion(logs, intervalMinutes);

  // ── commit helpers ────────────────────────────────────────────────────────
  const commitLogs = useCallback((updated: BladderLog[]) => {
    saveLogs(updated);
    setLogsState(updated);
  }, []);

  const commitPending = useCallback((log: BladderLog | null) => {
    savePending(log);
    setPendingLog(log);
  }, []);

  // ── fire a void cycle ─────────────────────────────────────────────────────
  const fireCycle = useCallback(() => {
    const now = new Date();
    const log: BladderLog = {
      id: crypto.randomUUID(),
      date: todayStr(),
      scheduledAt: now.toISOString(),
      status: "pending",
      intervalMinutes: intervalRef.current,
    };
    commitPending(log);

    // Show notification (foreground or SW)
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      showBladderNotification();
    }

    // Schedule next cycle
    const nextMs = intervalRef.current * 60 * 1000;
    const nextAt = new Date(Date.now() + nextMs);
    setNextVoidAt(nextAt);
    startedAtRef.current = Date.now();

    timerRef.current = setTimeout(() => {
      // Previous cycle not yet responded → mark as delayed
      setPendingLog((prev) => {
        if (prev) {
          const updated = loadLogs().map((l) =>
            l.id === prev.id ? { ...l, status: "delayed" as BladderStatus } : l,
          );
          // Ensure the previous pending log is persisted as delayed
          if (!updated.find((l) => l.id === prev.id)) {
            updated.push({ ...prev, status: "delayed" });
          }
          saveLogs(updated);
          setLogsState(updated);
          savePending(null);
        }
        return null;
      });
      fireCycle();
    }, nextMs);

    scheduleSWBladder(nextMs, log.id);
  }, [commitPending]);

  // ── start / stop ──────────────────────────────────────────────────────────
  const startSchedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const ms = intervalRef.current * 60 * 1000;
    const nextAt = new Date(Date.now() + ms);
    setNextVoidAt(nextAt);
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(fireCycle, ms);
    scheduleSWBladder(ms, "");
  }, [fireCycle]);

  const stopSchedule = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelSWBladder();
    setNextVoidAt(null);
    startedAtRef.current = null;
  }, []);

  // ── toggle ─────────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      saveEnabled(next);
      if (next) {
        // Small delay so state is committed before startSchedule reads interval
        setTimeout(startSchedule, 0);
      } else {
        stopSchedule();
        commitPending(null);
      }
      return next;
    });
  }, [startSchedule, stopSchedule, commitPending]);

  // ── respond ───────────────────────────────────────────────────────────────
  const respond = useCallback(
    (status: Exclude<BladderStatus, "pending">) => {
      if (!pendingLog) return;
      const resolved: BladderLog = {
        ...pendingLog,
        status,
        respondedAt: new Date().toISOString(),
      };
      const existing = loadLogs();
      const withoutPrev = existing.filter((l) => l.id !== resolved.id);
      commitLogs([...withoutPrev, resolved]);
      commitPending(null);
    },
    [pendingLog, commitLogs, commitPending],
  );

  // ── interval change ───────────────────────────────────────────────────────
  const setIntervalMinutes = useCallback(
    (v: number) => {
      const clamped = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, v));
      saveInterval(clamped);
      setIntervalState(clamped);
      intervalRef.current = clamped;
      if (enabled) {
        stopSchedule();
        setTimeout(startSchedule, 0);
      }
    },
    [enabled, startSchedule, stopSchedule],
  );

  // ── apply suggestion ──────────────────────────────────────────────────────
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
      if (event.data?.type === "BLADDER_ACTION_SNOOZE") {
        // SW will re-fire notification in 5 min; just acknowledge
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  // ── mount: restore schedule if enabled ───────────────────────────────────
  useEffect(() => {
    if (enabled) startSchedule();
    return () => stopSchedule();
    // Run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

export { MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL };
