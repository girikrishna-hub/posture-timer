import { useEffect, useRef, useCallback, useState } from "react";
import {
  getFitbitIntraday,
  getGetFitbitStatusQueryKey,
  recordFitbitEvent,
  useGetFitbitStatus,
} from "@workspace/api-client-react";
import { useTimer } from "@/contexts/TimerContext";

const POLL_INTERVAL_MS = 2 * 60 * 1000;

const WALKING_THRESHOLD = 30;
const STANDING_LOWER = 2;
const SITTING_ZERO_MINUTES = 8;
const WALKING_TRIGGER_MINUTES = 2;
const AVG_WINDOW_MINUTES = 3;

export interface NudgeState {
  toMode: "sitting" | "standing" | "walking";
  countdownSeconds: number;
  reason: string;
  fromMode: "sitting" | "standing" | "resting" | "walking";
}

interface StepMinute {
  time: string;
  steps: number;
}

function deriveSignal(minutes: StepMinute[]): { signal: string; zeroRun: number; avgLast3: number; walkingRun: number } {
  if (minutes.length === 0) return { signal: "unknown", zeroRun: 0, avgLast3: 0, walkingRun: 0 };

  let zeroRun = 0;
  for (let i = minutes.length - 1; i >= 0; i--) {
    if (minutes[i].steps === 0) zeroRun++; else break;
  }

  let walkingRun = 0;
  for (let i = minutes.length - 1; i >= 0; i--) {
    if (minutes[i].steps >= WALKING_THRESHOLD) walkingRun++; else break;
  }

  const last3 = minutes.slice(-AVG_WINDOW_MINUTES);
  const avgLast3 = last3.reduce((s, m) => s + m.steps, 0) / Math.max(last3.length, 1);

  let signal = "sitting";
  if (avgLast3 >= WALKING_THRESHOLD) signal = "walking";
  else if (avgLast3 >= STANDING_LOWER) signal = "standing";

  return { signal, zeroRun, avgLast3, walkingRun };
}

interface UseFitbitDriftOptions {
  onAutoSwitch?: (toMode: string, reason: string, fromMode: string) => void;
}

export function useFitbitDrift({ onAutoSwitch }: UseFitbitDriftOptions = {}) {
  const enabled = (() => {
    try { return localStorage.getItem("fitbitAssisted") === "true"; } catch { return false; }
  })();
  const { mode, switchMode, isInLockWindow } = useTimer();
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const onAutoSwitchRef = useRef(onAutoSwitch);
  useEffect(() => { onAutoSwitchRef.current = onAutoSwitch; }, [onAutoSwitch]);

  const { data: fitbitStatus } = useGetFitbitStatus({
    query: { queryKey: getGetFitbitStatusQueryKey(), refetchInterval: 60_000 },
  });
  const connected = fitbitStatus?.connected === true;

  const [nudge, setNudge] = useState<NudgeState | null>(null);
  const nudgeRef = useRef<NudgeState | null>(null);

  const clearNudge = useCallback(() => {
    setNudge(null);
    nudgeRef.current = null;
  }, []);

  const confirmNudge = useCallback(async () => {
    const n = nudgeRef.current;
    if (!n) return;
    clearNudge();
    await recordFitbitEvent({
      eventType: "user_accepted",
      fromMode: n.fromMode,
      toMode: n.toMode,
      reason: n.reason,
    });
    await switchMode(n.toMode, "fitbit_suggested");
  }, [clearNudge, switchMode]);

  const cancelNudge = useCallback(async () => {
    const n = nudgeRef.current;
    if (!n) return;
    clearNudge();
    await recordFitbitEvent({
      eventType: "user_cancelled",
      fromMode: n.fromMode,
      toMode: n.toMode,
      reason: n.reason,
    });
  }, [clearNudge]);

  useEffect(() => {
    if (!enabled || !connected) return;

    let active = true;

    async function evaluate() {
      if (!active) return;
      if (isInLockWindow()) return;

      let data;
      try {
        data = await getFitbitIntraday();
      } catch {
        return;
      }
      if (!active) return;

      const minutes = data.minutes as StepMinute[];
      const { zeroRun, avgLast3, walkingRun } = deriveSignal(minutes);
      const currentMode = modeRef.current;

      if (nudgeRef.current) return;

      if (
        currentMode !== "walking" &&
        walkingRun >= WALKING_TRIGGER_MINUTES &&
        avgLast3 >= WALKING_THRESHOLD
      ) {
        const reason = "Walking detected";
        await recordFitbitEvent({
          eventType: "auto_correction",
          fromMode: currentMode as "sitting" | "standing" | "resting" | "walking",
          toMode: "walking",
          reason,
        });
        await switchMode("walking", "fitbit_auto");
        onAutoSwitchRef.current?.("walking", reason, currentMode);
        return;
      }

      if (currentMode === "standing" && zeroRun >= SITTING_ZERO_MINUTES) {
        const n: NudgeState = {
          toMode: "sitting",
          fromMode: "standing",
          countdownSeconds: 15,
          reason: "No movement detected for 8 minutes",
        };
        nudgeRef.current = n;
        setNudge(n);
        await recordFitbitEvent({
          eventType: "nudge",
          fromMode: "standing",
          toMode: "sitting",
          reason: n.reason,
        });
        return;
      }

      if (currentMode === "sitting" && avgLast3 >= 5 && walkingRun >= AVG_WINDOW_MINUTES) {
        const n: NudgeState = {
          toMode: "standing",
          fromMode: "sitting",
          countdownSeconds: 10,
          reason: "Activity detected for 3 consecutive minutes",
        };
        nudgeRef.current = n;
        setNudge(n);
        await recordFitbitEvent({
          eventType: "nudge",
          fromMode: "sitting",
          toMode: "standing",
          reason: n.reason,
        });
      }
    }

    void evaluate();
    const timer = setInterval(() => void evaluate(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, connected, switchMode, isInLockWindow]);

  return { nudge, confirmNudge, cancelNudge, clearNudge, connected };
}
