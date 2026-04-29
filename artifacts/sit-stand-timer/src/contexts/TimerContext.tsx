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

export type TimerMode = "idle" | "sitting" | "standing" | "resting";

interface OfflineEndOp {
  id: string;
  type: "endSession";
  sessionId: number;
  endedAt: string;
}

interface OfflineStartOp {
  id: string;
  type: "startSession";
  mode: "sitting" | "standing" | "resting";
  startedAt: string;
}

type OfflineOp = OfflineEndOp | OfflineStartOp;

const OFFLINE_QUEUE_KEY = "sit-stand-offline-queue";
const IDLE_TIMEOUT_SECONDS = 60 * 60;

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
  } catch {
    // Storage might be full; silent
  }
}

type EnqueueArg = Omit<OfflineEndOp, "id"> | Omit<OfflineStartOp, "id">;

function enqueueOp(op: EnqueueArg): void {
  const queue = loadQueue();
  queue.push({ ...op, id: crypto.randomUUID() } as OfflineOp);
  saveQueue(queue);
}

async function drainQueue(
  endFn: (id: number, endedAt: string) => Promise<unknown>,
  startFn: (mode: string, startedAt: string) => Promise<{ id: number }>
): Promise<void> {
  const queue = loadQueue();
  if (queue.length === 0) return;
  const remaining: OfflineOp[] = [];
  for (const op of queue) {
    try {
      if (op.type === "endSession") {
        await endFn(op.sessionId, op.endedAt);
      } else if (op.type === "startSession") {
        await startFn(op.mode, op.startedAt);
      }
    } catch {
      remaining.push(op);
    }
  }
  saveQueue(remaining);
}

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

interface TimerContextValue {
  mode: TimerMode;
  elapsedSeconds: number;
  reminderCount: number;
  inReminderPhase: boolean;
  activeSessionId: number | null;
  notificationPermission: NotificationPermission;
  requestNotificationPermission: () => Promise<void>;
  switchMode: (newMode: "sitting" | "standing" | "resting") => Promise<void>;
  isLoading: boolean;
}

const TimerContext = createContext<TimerContextValue | null>(null);

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

  const modeRef = useRef(mode);
  const elapsedRef = useRef(elapsedSeconds);
  const reminderCountRef = useRef(reminderCount);
  const inReminderPhaseRef = useRef(inReminderPhase);
  const activeSessionIdRef = useRef(activeSessionId);
  const lastActivityRef = useRef(Date.now());
  const finalReminderFiredRef = useRef(false);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { elapsedRef.current = elapsedSeconds; }, [elapsedSeconds]);
  useEffect(() => { reminderCountRef.current = reminderCount; }, [reminderCount]);
  useEffect(() => { inReminderPhaseRef.current = inReminderPhase; }, [inReminderPhase]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const { data: activeSessionData } = useGetActiveSession({
    query: { queryKey: getGetActiveSessionQueryKey() },
  });

  const { data: settingsData } = useGetSettings();

  const settings = settingsData ?? {
    id: 1,
    dailyStandingGoalMinutes: 120,
    sittingAlertMinutes: 45,
    standingMinMinutes: 10,
    standingMaxMinutes: 15,
    reminderIntervalMinutes: 1,
    remindersCount: 3,
  };

  const startSessionMutation = useStartSession();
  const endSessionMutation = useEndSession();

  const doEndSession = useCallback(
    async (id: number, endedAt?: string) => {
      await endSessionMutation.mutateAsync({
        id,
        data: endedAt ? { endedAt } : {},
      });
    },
    [endSessionMutation]
  );

  const doStartSession = useCallback(
    async (sessionMode: string, startedAt?: string) => {
      return startSessionMutation.mutateAsync({
        data: {
          mode: sessionMode as "sitting" | "standing" | "resting",
          ...(startedAt ? { startedAt } : {}),
        },
      });
    },
    [startSessionMutation]
  );

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

  useEffect(() => {
    function handleOnline() {
      drainQueue(
        (id, endedAt) => doEndSession(id, endedAt),
        (m, startedAt) => doStartSession(m, startedAt)
      );
    }
    window.addEventListener("online", handleOnline);
    if (navigator.onLine) handleOnline();
    return () => window.removeEventListener("online", handleOnline);
  }, [doEndSession, doStartSession]);

  const switchMode = useCallback(
    async (newMode: "sitting" | "standing" | "resting") => {
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

      if (currentId !== null) {
        if (navigator.onLine) {
          try {
            await doEndSession(currentId, transitionTime);
          } catch {
            enqueueOp({ type: "endSession", sessionId: currentId, endedAt: transitionTime });
          }
        } else {
          enqueueOp({ type: "endSession", sessionId: currentId, endedAt: transitionTime });
        }
      }

      let newId: number | null = null;
      if (navigator.onLine) {
        try {
          const newSession = await doStartSession(newMode, transitionTime);
          newId = newSession.id;
        } catch {
          enqueueOp({ type: "startSession", mode: newMode, startedAt: transitionTime });
        }
      } else {
        enqueueOp({ type: "startSession", mode: newMode, startedAt: transitionTime });
      }

      setActiveSessionId(newId);
      setMode(newMode);
      setElapsedSeconds(0);
      setReminderCount(0);
      setInReminderPhase(false);
      finalReminderFiredRef.current = false;

      await queryClient.invalidateQueries({ queryKey: getGetTodayStatsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
    },
    [doEndSession, doStartSession, queryClient]
  );

  const switchModeRef = useRef(switchMode);
  useEffect(() => { switchModeRef.current = switchMode; }, [switchMode]);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

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
          switchModeRef.current("resting");
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
            notify(
              "Time to stand!",
              `You've been sitting for ${alertMin} minutes. Stand up!`
            );
          } else if (inReminderPhaseRef.current) {
            const remindersSoFar = reminderCountRef.current;
            const nextReminderAt = alertMin + remindersSoFar * reminderInterval;
            if (elapsedMinutes >= nextReminderAt && remindersSoFar < maxReminders) {
              setReminderCount((r) => r + 1);
              playStandTone();
              notify(
                `Stand up — reminder ${remindersSoFar + 1}/${maxReminders}`,
                `You've been sitting for ${Math.round(elapsedMinutes)} minutes. Time to stand!`
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
            notify(
              "Time to sit!",
              `You've been standing for ${minMin} minutes. Sit down!`
            );
          } else if (inReminderPhaseRef.current) {
            const remindersSoFar = reminderCountRef.current;

            if (elapsedMinutes >= maxMin && !finalReminderFiredRef.current) {
              finalReminderFiredRef.current = true;
              setReminderCount((r) => r + 1);
              playSitTone();
              notify(
                "Final reminder — please sit down",
                `You've been standing for ${Math.round(elapsedMinutes)} minutes. Maximum standing time reached.`
              );
            } else if (elapsedMinutes < maxMin) {
              const nextReminderAt = minMin + remindersSoFar * reminderInterval;
              if (elapsedMinutes >= nextReminderAt && remindersSoFar < maxReminders) {
                setReminderCount((r) => r + 1);
                playSitTone();
                notify(
                  `Sit down — reminder ${remindersSoFar + 1}/${maxReminders}`,
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

  useEffect(() => {
    function resetActivity() {
      lastActivityRef.current = Date.now();
    }
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

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        const currentMode = modeRef.current;
        if (currentMode === "idle" || currentMode === "resting") return;

        const sessionStartEl = activeSessionData?.session;
        if (!sessionStartEl?.startedAt) return;
        const elapsed = Math.floor(
          (Date.now() - new Date(sessionStartEl.startedAt).getTime()) / 1000
        );
        if (elapsed >= IDLE_TIMEOUT_SECONDS) {
          switchModeRef.current("resting");
          notify("Auto-paused", "You were away for over an hour. Timer paused.");
        }
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [activeSessionData]);

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
