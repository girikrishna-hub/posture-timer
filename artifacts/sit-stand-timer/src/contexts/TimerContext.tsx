import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useStartSession,
  useEndSession,
  useGetActiveSession,
  useGetSettings,
  useGetTodayStats,
  getGetTodayStatsQueryKey,
  getGetActiveSessionQueryKey,
} from "@workspace/api-client-react";
import { playStandTone, playSitTone, playConfirmTone, playRestTone } from "@/utils/audio";
import { useWalkingDetection, type GpsStatus } from "@/hooks/useWalkingDetection";
import { useNotificationPermission } from "@/hooks/useNotificationPermission";

export type TimerMode = "idle" | "sitting" | "standing" | "resting" | "walking";

// ─── Offline queue types ───────────────────────────────────────────────────

interface OfflineEndOp {
  id: string;
  type: "endSession";
  sessionId: number;
  endedAt: string;
}

interface OfflineStartOp {
  id: string;
  type: "startSession";
  mode: "sitting" | "standing" | "resting" | "walking";
  startedAt: string;
  endedAt?: string;
  restType?: "nap" | "sleep";
}

type OfflineOp = OfflineEndOp | OfflineStartOp;

const OFFLINE_QUEUE_KEY = "sit-stand-offline-queue";
const IDLE_TIMEOUT_SECONDS = 60 * 60;
const OFFLINE_SESSION_SENTINEL = -1;

function loadQueue(): OfflineOp[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineOp[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(ops: OfflineOp[]): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(ops));
  } catch { /* silent */ }
}

function saveQueueOp(op: OfflineOp): void {
  const queue = loadQueue();
  queue.push(op);
  saveQueue(queue);
}

function markQueueStartEnd(opId: string, endedAt: string): void {
  const queue = loadQueue();
  saveQueue(
    queue.map((op) =>
      op.id === opId && op.type === "startSession" ? { ...op, endedAt } : op
    )
  );
}

function enqueueEndOp(sessionId: number, endedAt: string): void {
  saveQueueOp({ id: crypto.randomUUID(), type: "endSession", sessionId, endedAt });
}

// ─── Notifications ─────────────────────────────────────────────────────────

function sendSWNotification(title: string, body: string): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) =>
      reg.showNotification(title, {
        body,
        icon: "/favicon.svg",
        badge: "/favicon.svg",
        tag: "timer-reminder",
        renotify: true,
        data: { url: "/" },
      } as NotificationOptions)
    )
    .catch(() => {
      // SW notification unavailable — silently ignore
    });
}

function notify(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // Always use the service worker registration path — it works in both
    // foreground and background, and is the only path that works on mobile.
    sendSWNotification(title, body);
  } catch {
    // Notification API unavailable or restricted — silently ignore
  }
}

// ─── Goal milestone notification state ─────────────────────────────────────

const GOAL_NOTIF_KEY = "sit-stand-goal-notif";

interface GoalNotifState {
  date: string;
  half: boolean;
  full: boolean;
}

function getGoalNotifState(): GoalNotifState {
  try {
    const raw = localStorage.getItem(GOAL_NOTIF_KEY);
    if (raw) return JSON.parse(raw) as GoalNotifState;
  } catch { /* ignore */ }
  return { date: "", half: false, full: false };
}

function saveGoalNotifState(state: GoalNotifState): void {
  try {
    localStorage.setItem(GOAL_NOTIF_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function secondsSinceLocalMidnight(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return (now.getTime() - midnight.getTime()) / 1000;
}

// ─── Context types ─────────────────────────────────────────────────────────

export type StateSource = "manual" | "fitbit_auto" | "fitbit_suggested";

const LOCK_WINDOW_MS: Partial<Record<TimerMode, number>> = {
  sitting: 15 * 60 * 1000,
  standing: 10 * 60 * 1000,
  resting: 15 * 60 * 1000,
};

interface TimerContextValue {
  mode: TimerMode;
  restType: "nap" | "sleep" | null;
  elapsedSeconds: number;
  reminderCount: number;
  inReminderPhase: boolean;
  activeSessionId: number | null;
  notificationPermission: NotificationPermission;
  requestNotificationPermission: () => Promise<void>;
  switchMode: (newMode: "sitting" | "standing" | "resting" | "walking", source?: StateSource, restType?: "nap" | "sleep") => Promise<void>;
  endCurrentSession: () => Promise<void>;
  gpsStatus: GpsStatus;
  isLoading: boolean;
  stateSource: StateSource;
  isInLockWindow: () => boolean;
  /** True once the active session has been loaded from the server API. */
  initialized: boolean;
}

export type { GpsStatus };

const TimerContext = createContext<TimerContextValue | null>(null);

// ─── Provider ──────────────────────────────────────────────────────────────

export function TimerProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<TimerMode>("idle");
  const [restType, setRestType] = useState<"nap" | "sleep" | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [reminderCount, setReminderCount] = useState(0);
  const [inReminderPhase, setInReminderPhase] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const notificationPermission = useNotificationPermission();
  const [initialized, setInitialized] = useState(false);
  const [stateSource, setStateSource] = useState<StateSource>("manual");

  // Refs used inside intervals/event handlers to avoid stale closures
  const modeRef = useRef(mode);
  const lastManualActionAt = useRef<number | null>(null);
  const reminderCountRef = useRef(reminderCount);
  const inReminderPhaseRef = useRef(inReminderPhase);
  const activeSessionIdRef = useRef(activeSessionId);
  const lastActivityRef = useRef(Date.now());
  const finalReminderFiredRef = useRef(false);
  const pendingLocalQueueIdRef = useRef<string | null>(null);

  // Goal milestone notification refs (half / full goal)
  const goalNotifStateRef = useRef<GoalNotifState>(getGoalNotifState());
  const prevDailyGoalRef = useRef<number | null>(null);

  const elapsedSecondsRef = useRef(elapsedSeconds);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { elapsedSecondsRef.current = elapsedSeconds; }, [elapsedSeconds]);
  useEffect(() => { reminderCountRef.current = reminderCount; }, [reminderCount]);
  useEffect(() => { inReminderPhaseRef.current = inReminderPhase; }, [inReminderPhase]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const { data: activeSessionData } = useGetActiveSession();
  const { data: settingsData } = useGetSettings();
  const { data: todayStatsData } = useGetTodayStats();

  const settings = settingsData ?? {
    id: 1,
    dailyStandingGoalMinutes: 120,
    sittingAlertMinutes: 45,
    standingMinMinutes: 10,
    standingMaxMinutes: 15,
    reminderIntervalMinutes: 1,
    remindersCount: 3,
    autoDetectWalking: false,
  };
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const startSessionMutation = useStartSession();
  const endSessionMutation = useEndSession();

  // Keep mutation refs stable so effects don't need them as deps
  const startMutationRef = useRef(startSessionMutation);
  const endMutationRef = useRef(endSessionMutation);
  useEffect(() => { startMutationRef.current = startSessionMutation; }, [startSessionMutation]);
  useEffect(() => { endMutationRef.current = endSessionMutation; }, [endSessionMutation]);

  // Stable helpers via refs — never trigger re-renders or effect re-runs
  const doEndSession = useCallback(async (id: number, endedAt?: string) => {
    await endMutationRef.current.mutateAsync({ id, data: endedAt ? { endedAt } : {} });
  }, []);

  const doStartSession = useCallback(
    async (sessionMode: string, startedAt?: string, sessionRestType?: "nap" | "sleep"): Promise<{ id: number }> => {
      return startMutationRef.current.mutateAsync({
        data: {
          mode: sessionMode as "sitting" | "standing" | "resting" | "walking",
          ...(startedAt ? { startedAt } : {}),
          ...(sessionRestType != null ? { restType: sessionRestType } : {}),
        },
      });
    },
    []
  );

  // Restore active session from server on first load
  useEffect(() => {
    if (!initialized && activeSessionData !== undefined) {
      const active = activeSessionData.session;
      if (active && !active.endedAt) {
        const elapsed = Math.floor(
          (Date.now() - new Date(active.startedAt).getTime()) / 1000
        );
        setMode(active.mode as TimerMode);
        setRestType((active.restType as "nap" | "sleep" | null) ?? null);
        setElapsedSeconds(elapsed);
        setActiveSessionId(active.id);
      }
      setInitialized(true);
    }
  }, [activeSessionData, initialized]);

  // Drain offline queue on reconnect
  useEffect(() => {
    async function drain() {
      const queue = loadQueue();
      if (queue.length === 0) return;
      const remaining: OfflineOp[] = [];
      for (const op of queue) {
        try {
          if (op.type === "endSession") {
            await doEndSession(op.sessionId, op.endedAt);
          } else {
            const session = await doStartSession(op.mode, op.startedAt, op.restType);
            if (op.endedAt) {
              await doEndSession(session.id, op.endedAt);
            }
          }
        } catch {
          remaining.push(op);
        }
      }
      saveQueue(remaining);
      pendingLocalQueueIdRef.current = null;
      queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTodayStatsQueryKey() });
    }

    function handleOnline() { void drain(); }

    window.addEventListener("online", handleOnline);
    if (navigator.onLine) void drain();
    return () => window.removeEventListener("online", handleOnline);
  }, [doEndSession, doStartSession, queryClient]);

  const switchMode = useCallback(
    async (newMode: "sitting" | "standing" | "resting" | "walking", source: StateSource = "manual", newRestType?: "nap" | "sleep") => {
      const currentId = activeSessionIdRef.current;
      const currentMode = modeRef.current;

      if (currentMode !== "idle" && currentMode === newMode) return;

      const transitionTime = new Date().toISOString();
      lastActivityRef.current = Date.now();
      if (source === "manual") lastManualActionAt.current = Date.now();
      setStateSource(source);

      if (newMode === "resting") {
        playRestTone();
      } else {
        playConfirmTone();
      }

      // End current session
      const localQueueId = pendingLocalQueueIdRef.current;
      if (localQueueId !== null) {
        markQueueStartEnd(localQueueId, transitionTime);
        pendingLocalQueueIdRef.current = null;
      } else if (currentId !== null && currentId > 0) {
        if (navigator.onLine) {
          try {
            await doEndSession(currentId, transitionTime);
          } catch {
            enqueueEndOp(currentId, transitionTime);
          }
        } else {
          enqueueEndOp(currentId, transitionTime);
        }
      }

      // Start new session
      const sessionRestType = newMode === "resting" ? newRestType : undefined;
      if (navigator.onLine) {
        try {
          const newSession = await doStartSession(newMode, transitionTime, sessionRestType);
          setActiveSessionId(newSession.id);
          pendingLocalQueueIdRef.current = null;
        } catch {
          const opId = crypto.randomUUID();
          saveQueueOp({ id: opId, type: "startSession", mode: newMode, startedAt: transitionTime, ...(sessionRestType ? { restType: sessionRestType } : {}) });
          pendingLocalQueueIdRef.current = opId;
          setActiveSessionId(OFFLINE_SESSION_SENTINEL);
        }
      } else {
        const opId = crypto.randomUUID();
        saveQueueOp({ id: opId, type: "startSession", mode: newMode, startedAt: transitionTime, ...(sessionRestType ? { restType: sessionRestType } : {}) });
        pendingLocalQueueIdRef.current = opId;
        setActiveSessionId(OFFLINE_SESSION_SENTINEL);
      }

      setMode(newMode);
      setRestType(newMode === "resting" ? (newRestType ?? null) : null);
      setElapsedSeconds(0);
      setReminderCount(0);
      setInReminderPhase(false);
      finalReminderFiredRef.current = false;

      void queryClient.invalidateQueries({ queryKey: getGetTodayStatsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
    },
    [doEndSession, doStartSession, queryClient]
  );

  const switchModeRef = useRef(switchMode);
  useEffect(() => { switchModeRef.current = switchMode; }, [switchMode]);

  const isInLockWindow = useCallback((): boolean => {
    const lastManual = lastManualActionAt.current;
    if (lastManual === null) return false;
    const currentMode = modeRef.current;
    if (currentMode === "walking") return false;
    const lockMs = LOCK_WINDOW_MS[currentMode];
    if (!lockMs) return false;
    return Date.now() - lastManual < lockMs;
  }, []);

  const autoDetectWalking = settingsData?.autoDetectWalking ??
    (() => { try { return localStorage.getItem("autoDetectWalking") === "true"; } catch { return false; } })();

  const endCurrentSession = useCallback(async () => {
    const currentId = activeSessionIdRef.current;
    const currentMode = modeRef.current;
    if (currentMode === "idle") return;

    const endedAt = new Date().toISOString();
    const localQueueId = pendingLocalQueueIdRef.current;
    if (localQueueId !== null) {
      markQueueStartEnd(localQueueId, endedAt);
      pendingLocalQueueIdRef.current = null;
    } else if (currentId !== null && currentId > 0) {
      if (navigator.onLine) {
        try {
          await doEndSession(currentId, endedAt);
        } catch {
          enqueueEndOp(currentId, endedAt);
        }
      } else {
        enqueueEndOp(currentId, endedAt);
      }
    }

    setMode("idle");
    setActiveSessionId(null);
    setElapsedSeconds(0);
    setReminderCount(0);
    setInReminderPhase(false);
    finalReminderFiredRef.current = false;

    void queryClient.invalidateQueries({ queryKey: getGetTodayStatsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
  }, [doEndSession, queryClient]);

  const gpsStatus = useWalkingDetection({
    enabled: autoDetectWalking,
    currentMode: mode,
    switchMode,
    endCurrentSession,
  });

  // Main 1-second tick — pure increment only (no side-effects inside updater)
  useEffect(() => {
    if (!initialized) return;
    if (mode === "idle" || mode === "resting") return;

    const interval = setInterval(() => {
      const currentMode = modeRef.current;
      if (currentMode === "idle" || currentMode === "resting") return;
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [initialized, mode]);

  // Reminder/notification side-effects — runs after each tick, safely outside any updater
  useEffect(() => {
    try {
      if (!initialized) return;
      const currentMode = modeRef.current;
      if (currentMode === "idle" || currentMode === "resting") return;

      const elapsedMinutes = elapsedSeconds / 60;
      const s = settingsRef.current;

      // Idle auto-pause check
      const inactiveSecs = (Date.now() - lastActivityRef.current) / 1000;
      if (inactiveSecs >= IDLE_TIMEOUT_SECONDS) {
        void switchModeRef.current("resting");
        notify("Auto-paused", "No activity detected for an hour. Timer paused.");
        return;
      }

      if (currentMode === "sitting") {
        const alertMin = s.sittingAlertMinutes;
        const reminderInterval = s.reminderIntervalMinutes;
        const maxReminders = s.remindersCount;

        if (elapsedMinutes >= alertMin && !inReminderPhaseRef.current) {
          setInReminderPhase(true);
          setReminderCount(1);
          playStandTone();
          notify("Time to stand!", `You've been sitting for ${alertMin} minutes.`);
        } else if (inReminderPhaseRef.current) {
          const soFar = reminderCountRef.current;
          const nextAt = alertMin + soFar * reminderInterval;
          if (elapsedMinutes >= nextAt && soFar < maxReminders) {
            setReminderCount((r) => r + 1);
            playStandTone();
            notify(
              `Stand up — reminder ${soFar + 1}/${maxReminders}`,
              `You've been sitting for ${Math.round(elapsedMinutes)} minutes.`
            );
          }
        }
      } else if (currentMode === "standing") {
        const minMin = s.standingMinMinutes;
        const maxMin = s.standingMaxMinutes;
        const reminderInterval = s.reminderIntervalMinutes;
        const maxReminders = s.remindersCount;

        if (elapsedMinutes >= minMin && !inReminderPhaseRef.current) {
          setInReminderPhase(true);
          setReminderCount(1);
          playSitTone();
          notify("Time to sit!", `You've been standing for ${minMin} minutes.`);
        } else if (inReminderPhaseRef.current) {
          const soFar = reminderCountRef.current;

          if (elapsedMinutes >= maxMin && !finalReminderFiredRef.current) {
            finalReminderFiredRef.current = true;
            setReminderCount((r) => r + 1);
            playSitTone();
            notify(
              "Final reminder — please sit down",
              `Maximum standing time of ${maxMin} minutes reached.`
            );
          } else if (elapsedMinutes < maxMin) {
            const nextAt = minMin + soFar * reminderInterval;
            if (elapsedMinutes >= nextAt && soFar < maxReminders) {
              setReminderCount((r) => r + 1);
              playSitTone();
              notify(
                `Sit down — reminder ${soFar + 1}/${maxReminders}`,
                `You've been standing for ${Math.round(elapsedMinutes)} minutes.`
              );
            }
          }
        }
      }
    } catch {
      // Never let reminder logic crash the app
    }
  // elapsedSeconds drives this; all other values are read via stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedSeconds, initialized]);

  // Track user activity for idle detection
  useEffect(() => {
    function resetActivity() { lastActivityRef.current = Date.now(); }
    document.addEventListener("mousemove", resetActivity, { passive: true });
    document.addEventListener("keydown", resetActivity, { passive: true });
    document.addEventListener("touchstart", resetActivity, { passive: true });
    document.addEventListener("click", resetActivity, { passive: true });
    return () => {
      document.removeEventListener("mousemove", resetActivity);
      document.removeEventListener("keydown", resetActivity);
      document.removeEventListener("touchstart", resetActivity);
      document.removeEventListener("click", resetActivity);
    };
  }, []);

  // ─── Background alert scheduling ────────────────────────────────────────
  // When the page goes to background, hand the next scheduled alert to the
  // service worker so it fires even if JS is throttled/suspended.

  function sendSWMessage(msg: Record<string, unknown>): void {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready
      .then((reg) => { reg.active?.postMessage(msg); })
      .catch(() => { /* silent */ });
  }

  function scheduleBackgroundAlert(): void {
    const currentMode = modeRef.current;
    if (currentMode === "idle" || currentMode === "resting") return;
    if (Notification.permission !== "granted") return;

    const elapsed = elapsedSecondsRef.current;
    const inReminder = inReminderPhaseRef.current;
    const count = reminderCountRef.current;
    const s = settingsRef.current;

    let delayMs: number | null = null;
    let title = "";
    let body = "";

    if (currentMode === "sitting") {
      const alertSecs = s.sittingAlertMinutes * 60;
      const intervalSecs = s.reminderIntervalMinutes * 60;
      const max = s.remindersCount;

      if (!inReminder && elapsed < alertSecs) {
        delayMs = (alertSecs - elapsed) * 1000;
        title = "Time to stand!";
        body = `You've been sitting for ${s.sittingAlertMinutes} minutes.`;
      } else if (inReminder && count < max) {
        const nextAtSecs = alertSecs + count * intervalSecs;
        if (elapsed < nextAtSecs) {
          delayMs = (nextAtSecs - elapsed) * 1000;
          title = `Stand up — reminder ${count + 1}/${max}`;
          body = `You've been sitting for over ${s.sittingAlertMinutes} minutes.`;
        }
      }
    } else if (currentMode === "standing") {
      const minSecs = s.standingMinMinutes * 60;
      const maxSecs = s.standingMaxMinutes * 60;
      const intervalSecs = s.reminderIntervalMinutes * 60;
      const max = s.remindersCount;

      if (!inReminder && elapsed < minSecs) {
        delayMs = (minSecs - elapsed) * 1000;
        title = "Time to sit!";
        body = `You've been standing for ${s.standingMinMinutes} minutes.`;
      } else if (inReminder && !finalReminderFiredRef.current) {
        const nextAtSecs = minSecs + count * intervalSecs;
        const targetSecs = elapsed < nextAtSecs ? nextAtSecs : maxSecs;
        if (elapsed < targetSecs) {
          delayMs = (targetSecs - elapsed) * 1000;
          title = targetSecs >= maxSecs
            ? "Final reminder — please sit down"
            : `Sit down — reminder ${count + 1}/${max}`;
          body = `You've been standing for ${Math.round(elapsed / 60)} minutes.`;
        }
      }
    }

    if (delayMs && delayMs > 0) {
      sendSWMessage({ type: "SCHEDULE_NOTIFICATION", delayMs, title, body });
    }
  }

  function cancelBackgroundAlert(): void {
    sendSWMessage({ type: "CANCEL_SCHEDULED_NOTIFICATION" });
  }

  // On visibility change: schedule SW alert on hide, cancel + check auto-pause on show
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        scheduleBackgroundAlert();
        return;
      }
      // Became visible — cancel any pending SW alert (page JS takes over again)
      cancelBackgroundAlert();
      const currentMode = modeRef.current;
      if (currentMode === "idle" || currentMode === "resting") return;
      const inactiveSecs = (Date.now() - lastActivityRef.current) / 1000;
      if (inactiveSecs >= IDLE_TIMEOUT_SECONDS) {
        void switchModeRef.current("resting");
        notify("Auto-paused", "You were away for over an hour.");
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Goal milestone notifications ────────────────────────────────────────
  useEffect(() => {
    const goalMinutes = settingsRef.current.dailyStandingGoalMinutes;
    if (!goalMinutes || goalMinutes <= 0) return;

    const today = todayDateString();

    // If the daily goal has changed since the last run, reset the notif state
    // directly (do not re-read from localStorage to avoid cross-component
    // timing races with SettingsPage's invalidateQueries call).
    if (prevDailyGoalRef.current !== null && prevDailyGoalRef.current !== goalMinutes) {
      const fresh: GoalNotifState = { date: today, half: false, full: false };
      goalNotifStateRef.current = fresh;
      saveGoalNotifState(fresh);
    }
    prevDailyGoalRef.current = goalMinutes;

    const completedStandingMinutes = todayStatsData?.standingMinutes ?? 0;
    const completedWalkingMinutes = todayStatsData?.walkingMinutes ?? 0;
    // Cap in-progress contribution to minutes elapsed since local midnight so a
    // session spanning midnight doesn't inflate today's count with yesterday's time.
    const cappedElapsed = Math.min(elapsedSeconds, secondsSinceLocalMidnight()) / 60;
    const inProgressStandingMinutes = modeRef.current === "standing" ? cappedElapsed : 0;
    const inProgressWalkingMinutes = modeRef.current === "walking" ? cappedElapsed : 0;
    const totalActiveMinutes =
      completedStandingMinutes +
      completedWalkingMinutes +
      inProgressStandingMinutes +
      inProgressWalkingMinutes;

    const state = goalNotifStateRef.current;

    // Reset state if it's a new day
    if (state.date !== today) {
      const fresh: GoalNotifState = { date: today, half: false, full: false };
      goalNotifStateRef.current = fresh;
      saveGoalNotifState(fresh);
    }

    const current = goalNotifStateRef.current;

    if (!current.full && totalActiveMinutes >= goalMinutes) {
      const next = { ...current, full: true };
      goalNotifStateRef.current = next;
      saveGoalNotifState(next);
      notify(
        "Daily standing goal reached!",
        `You've been active for ${Math.round(totalActiveMinutes)} min — goal of ${goalMinutes} min achieved.`
      );
    } else if (!current.half && totalActiveMinutes >= goalMinutes * 0.5) {
      const next = { ...current, half: true };
      goalNotifStateRef.current = next;
      saveGoalNotifState(next);
      notify(
        "Halfway to your standing goal!",
        `${Math.round(totalActiveMinutes)} of ${goalMinutes} min done — keep it up!`
      );
    }
  }, [todayStatsData, elapsedSeconds, mode, settingsData]);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission();
      // No setState needed — useNotificationPermission hook reacts to the
      // permissionchange event and updates notificationPermission automatically.
    }
  }, []);

  return (
    <TimerContext.Provider
      value={{
        mode,
        restType,
        elapsedSeconds,
        reminderCount,
        inReminderPhase,
        activeSessionId,
        notificationPermission,
        requestNotificationPermission,
        switchMode,
        endCurrentSession,
        gpsStatus,
        isLoading: startSessionMutation.isPending || endSessionMutation.isPending,
        stateSource,
        isInLockWindow,
        initialized,
      }}
    >
      {children}
    </TimerContext.Provider>
  );
}

export function useTimer() {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error("useTimer must be used within TimerProvider");
  return ctx;
}
