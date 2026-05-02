import { useEffect, useRef } from "react";
import { schedulePush, cancelPushSchedule } from "@workspace/api-client-react";
import { useTimer, type TimerMode } from "@/contexts/TimerContext";

interface Settings {
  sittingAlertMinutes: number;
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
}

export function usePushSchedule(settings: Settings | null | undefined) {
  const { mode, elapsedSeconds } = useTimer();
  const modeRef = useRef<TimerMode>(mode);
  const elapsedRef = useRef(elapsedSeconds);
  const settingsRef = useRef(settings);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { elapsedRef.current = elapsedSeconds; }, [elapsedSeconds]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    const s = settingsRef.current;

    if (mode === "sitting" || mode === "standing") {
      void schedulePush({
        mode,
        elapsedSeconds: elapsedRef.current,
        sittingAlertMinutes: s?.sittingAlertMinutes ?? 45,
        standingMinMinutes: s?.standingMinMinutes ?? 10,
        standingMaxMinutes: s?.standingMaxMinutes ?? 15,
        reminderIntervalMinutes: s?.reminderIntervalMinutes ?? 1,
        remindersCount: s?.remindersCount ?? 3,
      }).catch(() => { /* best-effort */ });
    } else {
      void cancelPushSchedule().catch(() => { /* best-effort */ });
    }
  // Re-schedule on every mode change; elapsedSeconds is read via ref to avoid
  // re-firing every second — only the mode transition triggers rescheduling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
}
