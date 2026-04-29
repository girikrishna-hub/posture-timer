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
  getGetTodayStatsQueryKey,
  getGetActiveSessionQueryKey,
} from "@workspace/api-client-react";
import { playStandTone, playSitTone, playConfirmTone, playRestTone } from "@/utils/audio";
import { useWalkingDetection, type GpsStatus } from "@/hooks/useWalkingDetection";

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
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SHOW_NOTIFICATION",
      title,
      body,
      icon: "/favicon.svg",
    });
  }
}

function notify(title: string, body: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") {
    new Notification(title, { body, icon: "/favicon.svg" });
  } else {
    sendSWNotification(title, body);
  }
}

// ─── Context types ─────────────────────────────────────────────────────────

interface TimerContextValue {
  mode: TimerMode;
  elapsedSeconds: number;
  reminderCount: number;
  inReminderPhase: boolean;
  activeSessionId: number | null;
  notificationPermission: NotificationPermission;
  requestNotificationPermission: () => Promise<void>;
  switchMode: (newMode: "sitting" | "standing" | "resting" | "walking") => Promise<void>;
  endCurrentSession: () => Promise<void>;
  gpsStatus: GpsStatus;
  isLoading: boolean;
}

export type { GpsStatus };

const TimerContext = createContext<TimerContextValue | null>(null);

// ─── Provider ──────────────────────────────────────────────────────────────

export function TimerProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<TimerMode>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [reminderCount, setReminderCount] = useState(0);
  const [inReminderPhase, setInReminderPhase] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(
      typeof Notification !== "undefined" ? Notification.permission : "default"
    );
  const [initialized, setInitialized] = useState(false);

  // Refs used inside intervals/event handlers to avoid stale closures
  const modeRef = useRef(mode);
  const reminderCountRef = useRef(reminderCount);
  const inReminderPhaseRef = useRef(inReminderPhase);
  const activeSessionIdRef = useRef(activeSessionId);
  const lastActivityRef = useRef(Date.now());
  const finalReminderFiredRef = useRef(false);
  const pendingLocalQueueIdRef = useRef<string | null>(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { reminderCountRef.current = reminderCount; }, [reminderCount]);
  useEffect(() => { inReminderPhaseRef.current = inReminderPhase; }, [inReminderPhase]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const { data: activeSessionData } = useGetActiveSession();
  const { data: settingsData } = useGetSettings();

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
    async (sessionMode: string, startedAt?: string): Promise<{ id: number }> => {
      return startMutationRef.current.mutateAsync({
        data: {
          mode: sessionMode as "sitting" | "standing" | "resting" | "walking",
          ...(startedAt ? { startedAt } : {}),
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
            const session = await doStartSession(op.mode, op.startedAt);
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
    async (newMode: "sitting" | "standing" | "resting" | "walking") => {
      const currentId = activeSessionIdRef.current;
      const currentMode = modeRef.current;

      if (currentMode !== "idle" && currentMode === newMode) return;

      const transitionTime = new Date().toISOString();
      lastActivityRef.current = Date.now();

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
      if (navigator.onLine) {
        try {
          const newSession = await doStartSession(newMode, transitionTime);
          setActiveSessionId(newSession.id);
          pendingLocalQueueIdRef.current = null;
        } catch {
          const opId = crypto.randomUUID();
          saveQueueOp({ id: opId, type: "startSession", mode: newMode, startedAt: transitionTime });
          pendingLocalQueueIdRef.current = opId;
          setActiveSessionId(OFFLINE_SESSION_SENTINEL);
        }
      } else {
        const opId = crypto.randomUUID();
        saveQueueOp({ id: opId, type: "startSession", mode: newMode, startedAt: transitionTime });
        pendingLocalQueueIdRef.current = opId;
        setActiveSessionId(OFFLINE_SESSION_SENTINEL);
      }

      setMode(newMode);
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

  // Main 1-second tick: reminder logic + idle auto-pause
  useEffect(() => {
    if (!initialized) return;
    if (mode === "idle" || mode === "resting") return;

    const interval = setInterval(() => {
      const currentMode = modeRef.current;
      if (currentMode === "idle" || currentMode === "resting") return;

      setElapsedSeconds((prev) => {
        const next = prev + 1;
        const elapsedMinutes = next / 60;
        const s = settingsRef.current;

        const inactiveSecs = (Date.now() - lastActivityRef.current) / 1000;
        if (inactiveSecs >= IDLE_TIMEOUT_SECONDS) {
          void switchModeRef.current("resting");
          notify("Auto-paused", "No activity detected for an hour. Timer paused.");
          return next;
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

        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [initialized, mode]);

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

  // On visibility restore, check if we've been away long enough to auto-pause
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
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
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
    }
  }, []);

  return (
    <TimerContext.Provider
      value={{
        mode,
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
