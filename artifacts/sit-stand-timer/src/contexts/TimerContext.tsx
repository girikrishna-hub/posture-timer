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

function sendNotification(title: string, body: string): void {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.svg" });
  }
}

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

  const switchMode = useCallback(
    async (newMode: "sitting" | "standing" | "resting") => {
      const currentId = activeSessionIdRef.current;
      const currentMode = modeRef.current;

      if (currentMode !== "idle" && currentMode === newMode) return;

      if (newMode === "resting") {
        playRestTone();
      } else {
        playConfirmTone();
      }

      if (currentId !== null) {
        try {
          await endSessionMutation.mutateAsync({ id: currentId });
        } catch {
          // Queue for retry later
        }
      }

      try {
        const newSession = await startSessionMutation.mutateAsync({
          data: { mode: newMode },
        });
        setActiveSessionId(newSession.id);
      } catch {
        setActiveSessionId(null);
      }

      setMode(newMode);
      setElapsedSeconds(0);
      setReminderCount(0);
      setInReminderPhase(false);

      await queryClient.invalidateQueries({ queryKey: getGetTodayStatsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
    },
    [endSessionMutation, startSessionMutation, queryClient]
  );

  useEffect(() => {
    if (!initialized) return;
    if (mode === "idle") return;

    const interval = setInterval(() => {
      const currentMode = modeRef.current;
      if (currentMode === "idle" || currentMode === "resting") return;

      setElapsedSeconds((prev) => {
        const next = prev + 1;
        const elapsedMinutes = next / 60;

        if (currentMode === "sitting") {
          const alertMin = settings.sittingAlertMinutes;
          const reminderInterval = settings.reminderIntervalMinutes;
          const maxReminders = settings.remindersCount;

          if (elapsedMinutes >= alertMin && !inReminderPhaseRef.current) {
            setInReminderPhase(true);
            setReminderCount(1);
            playStandTone();
            sendNotification("Time to stand!", "You've been sitting for " + alertMin + " minutes. Stand up!");
          } else if (inReminderPhaseRef.current) {
            const remindersSoFar = reminderCountRef.current;
            const nextReminderAt = alertMin + remindersSoFar * reminderInterval;
            if (elapsedMinutes >= nextReminderAt && remindersSoFar < maxReminders) {
              setReminderCount((r) => r + 1);
              playStandTone();
              sendNotification(
                "Stand up reminder " + (remindersSoFar + 1) + "/" + maxReminders,
                "You've been sitting for " + Math.round(elapsedMinutes) + " minutes. Time to stand!"
              );
            }
          }
        } else if (currentMode === "standing") {
          const minMin = settings.standingMinMinutes;
          const maxMin = settings.standingMaxMinutes;
          const reminderInterval = settings.reminderIntervalMinutes;
          const maxReminders = settings.remindersCount;

          if (elapsedMinutes >= minMin && !inReminderPhaseRef.current) {
            setInReminderPhase(true);
            setReminderCount(1);
            playSitTone();
            sendNotification("Time to sit!", "You've been standing for " + minMin + " minutes. Sit down!");
          } else if (inReminderPhaseRef.current) {
            const remindersSoFar = reminderCountRef.current;
            const nextReminderAt = minMin + remindersSoFar * reminderInterval;
            if (elapsedMinutes >= nextReminderAt && remindersSoFar < maxReminders) {
              setReminderCount((r) => r + 1);
              playSitTone();
              const isLast = remindersSoFar + 1 >= maxReminders;
              sendNotification(
                isLast ? "Final reminder — please sit" : "Sit down reminder " + (remindersSoFar + 1) + "/" + maxReminders,
                "You've been standing for " + Math.round(elapsedMinutes) + " minutes." +
                (elapsedMinutes >= maxMin ? " Maximum standing time reached." : "")
              );
            }
          }
        }

        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [initialized, mode, settings]);

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
