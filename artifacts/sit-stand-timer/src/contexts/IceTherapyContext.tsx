/**
 * IceTherapyContext — Active protocol context for alternating ice/rest cycles.
 *
 * Protocol:
 *   ICE ON  (20 min)  →  REST (20 min)  →  repeat
 *
 * Durations are hardcoded. No settings, no history, no analytics.
 * Designed for immediate reliable use with Android AlarmManager.
 *
 * Alarm lifecycle (critical — follows ADDING_PROTOCOLS.md rules):
 *   start()  → schedule alarm
 *   pause()  → CANCEL alarm + save remaining ms
 *   resume() → schedule alarm for saved remaining ms
 *   skip()   → CANCEL alarm + schedule next phase alarm
 *   stop()   → CANCEL alarm + reset all state
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isNativePlatform,
  scheduleNativeIceTherapyAlarm,
  cancelNativeIceTherapyAlarm,
} from "@/utils/nativeNotifications";
import {
  makeStorageHelpers,
  showNotificationNow,
  scheduleSWNotification,
  cancelSWNotification,
} from "@/lib/protocol/utils";

// ─── Constants ───────────────────────────────────────────────────────────────

const COOL_DURATION_MS = 20 * 60 * 1000;
const REST_DURATION_MS = 20 * 60 * 1000;
const STORAGE_KEY = "protocol:ice-therapy:state";

// ─── Types ───────────────────────────────────────────────────────────────────

export type IcePhase = "cool" | "rest" | "idle";

interface IcePersistedState {
  version: 1;
  phase: IcePhase;
  isRunning: boolean;
  isPaused: boolean;
  /** Remaining ms saved at pause time — null unless isPaused. */
  pausedRemainingMs: number | null;
  /** Epoch-ms of next auto-transition — null when idle or paused. */
  nextTransitionAt: number | null;
  /** Epoch-ms when current phase started — null when idle or paused. */
  phaseStartedAt: number | null;
  /** Number of completed ice-on phases. */
  cycleCount: number;
}

const DEFAULT: IcePersistedState = {
  version: 1,
  phase: "idle",
  isRunning: false,
  isPaused: false,
  pausedRemainingMs: null,
  nextTransitionAt: null,
  phaseStartedAt: null,
  cycleCount: 0,
};

const store = makeStorageHelpers<IcePersistedState>(STORAGE_KEY, DEFAULT);

// ─── Context shape ───────────────────────────────────────────────────────────

export interface IceTherapyContextValue {
  phase: IcePhase;
  isRunning: boolean;
  isPaused: boolean;
  cycleCount: number;
  /** Absolute time of next phase transition (null when idle or paused). */
  nextTransitionAt: Date | null;
  /** Remaining ms when paused (null unless isPaused). */
  pausedRemainingMs: number | null;
  elapsedSeconds: number;
  start: () => void;
  pause: () => void;
  resume: () => void;
  /** Skip to the next phase immediately. */
  skip: () => void;
  stop: () => void;
}

// ─── Notification helpers ────────────────────────────────────────────────────

function notifyPhaseStart(nextPhase: "cool" | "rest"): void {
  const [title, body] = nextPhase === "cool"
    ? ["🧊 Apply ice pack", "Ice On phase — keep the pack on for 20 minutes."]
    : ["♻️ Remove ice pack", "Rest phase — let your skin warm for 20 minutes."];
  showNotificationNow(title, body, "ice-therapy");
}

function schedulePhaseEndAlert(delayMs: number, nextPhase: "cool" | "rest"): void {
  const [title, body] = nextPhase === "cool"
    ? ["🧊 Apply ice pack", "Ice On phase starting — 20 minutes."]
    : ["♻️ Remove ice pack", "Rest phase starting — 20 minutes."];
  scheduleSWNotification({ delayMs, title, body, tag: "ice-therapy" });
  if (isNativePlatform()) {
    void scheduleNativeIceTherapyAlarm(delayMs, nextPhase);
  }
}

function cancelAllIceAlarms(): void {
  cancelSWNotification();
  if (isNativePlatform()) {
    void cancelNativeIceTherapyAlarm().catch(() => { /* best-effort */ });
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

const IceTherapyContext = createContext<IceTherapyContextValue | null>(null);

export function IceTherapyProvider({ children }: { children: React.ReactNode }) {
  const saved = store.load();

  const [phase,             setPhase]             = useState<IcePhase>(saved.phase);
  const [isRunning,         setIsRunning]          = useState(saved.isRunning);
  const [isPaused,          setIsPaused]           = useState(saved.isPaused);
  const [cycleCount,        setCycleCount]         = useState(saved.cycleCount);
  const [nextTransitionAt,  setNextTransitionAt]   = useState<Date | null>(
    saved.nextTransitionAt ? new Date(saved.nextTransitionAt) : null,
  );
  const [pausedRemainingMs, setPausedRemainingMs]  = useState<number | null>(
    saved.pausedRemainingMs,
  );
  const [elapsedSeconds,    setElapsedSeconds]     = useState(0);

  // Stable refs — safe to read inside setTimeout/setInterval callbacks
  const timerRef            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef            = useRef<IcePhase>(phase);
  const isRunningRef        = useRef(isRunning);
  const cycleCountRef       = useRef(cycleCount);
  const nextTransitionAtRef = useRef<number | null>(saved.nextTransitionAt);
  const phaseStartedAtRef   = useRef<number | null>(saved.phaseStartedAt);
  const pausedRemRef        = useRef<number | null>(saved.pausedRemainingMs);

  useEffect(() => { phaseRef.current     = phase;     }, [phase]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { cycleCountRef.current = cycleCount; }, [cycleCount]);

  // ── Persist on every state change ──────────────────────────────────────
  useEffect(() => {
    store.save({
      version: 1,
      phase,
      isRunning,
      isPaused,
      pausedRemainingMs,
      nextTransitionAt:  nextTransitionAt?.getTime() ?? null,
      phaseStartedAt:    phaseStartedAtRef.current,
      cycleCount,
    });
  }, [phase, isRunning, isPaused, pausedRemainingMs, nextTransitionAt, cycleCount]);

  // ── 1-second elapsed counter ────────────────────────────────────────────
  useEffect(() => {
    if (!isRunning || phase === "idle") { setElapsedSeconds(0); return; }
    const interval = setInterval(() => {
      const startedAt = phaseStartedAtRef.current;
      if (startedAt !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, phase]);

  // ── Core: arm the JS timer for the current phase deadline ──────────────
  const armTimer = useCallback((targetMs: number) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const remaining = Math.max(0, targetMs - Date.now());
    if (remaining === 0) return; // caller handles immediate fire
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!isRunningRef.current) return;
      // Transition to next phase
      const curr = phaseRef.current;
      const next: "cool" | "rest" = curr === "cool" ? "rest" : "cool";
      transitionTo(next);
    }, remaining);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Transition into a phase (from running state) ────────────────────────
  const transitionTo = useCallback((next: "cool" | "rest") => {
    cancelAllIceAlarms();

    const now = Date.now();
    const duration = next === "cool" ? COOL_DURATION_MS : REST_DURATION_MS;
    const targetMs = now + duration;

    phaseStartedAtRef.current   = now;
    nextTransitionAtRef.current = targetMs;

    const nextAfterNext: "cool" | "rest" = next === "cool" ? "rest" : "cool";

    setPhase(next);
    setIsRunning(true);
    setIsPaused(false);
    setPausedRemainingMs(null);
    pausedRemRef.current = null;
    setNextTransitionAt(new Date(targetMs));

    if (next === "rest") {
      // A cool phase just completed — increment cycle count
      setCycleCount((c) => { cycleCountRef.current = c + 1; return c + 1; });
    }

    notifyPhaseStart(next);
    schedulePhaseEndAlert(duration, nextAfterNext);
    armTimer(targetMs);
  }, [armTimer]);

  // ── start ───────────────────────────────────────────────────────────────
  const start = useCallback(() => {
    if (isRunningRef.current || phaseRef.current !== "idle") return;
    const now      = Date.now();
    const targetMs = now + COOL_DURATION_MS;

    phaseStartedAtRef.current   = now;
    nextTransitionAtRef.current = targetMs;

    setPhase("cool");
    setIsRunning(true);
    setIsPaused(false);
    setCycleCount(0);
    cycleCountRef.current = 0;
    setPausedRemainingMs(null);
    pausedRemRef.current = null;
    setNextTransitionAt(new Date(targetMs));

    notifyPhaseStart("cool");
    schedulePhaseEndAlert(COOL_DURATION_MS, "rest");
    armTimer(targetMs);
  }, [armTimer]);

  // ── pause ───────────────────────────────────────────────────────────────
  const pause = useCallback(() => {
    if (!isRunningRef.current || phaseRef.current === "idle") return;

    const remaining = Math.max(0, (nextTransitionAtRef.current ?? Date.now()) - Date.now());

    // Cancel JS timer and all alarms FIRST
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelAllIceAlarms();

    pausedRemRef.current = remaining;
    nextTransitionAtRef.current = null;
    phaseStartedAtRef.current   = null;

    setIsRunning(false);
    setIsPaused(true);
    setPausedRemainingMs(remaining);
    setNextTransitionAt(null);
    setElapsedSeconds(0);
  }, []);

  // ── resume ──────────────────────────────────────────────────────────────
  const resume = useCallback(() => {
    if (!isPaused && isRunningRef.current) return;
    const remaining = pausedRemRef.current ?? (phaseRef.current === "cool" ? COOL_DURATION_MS : REST_DURATION_MS);
    const now      = Date.now();
    const targetMs = now + remaining;
    const curr     = phaseRef.current as "cool" | "rest";
    const nextPhase: "cool" | "rest" = curr === "cool" ? "rest" : "cool";

    phaseStartedAtRef.current   = now;
    nextTransitionAtRef.current = targetMs;
    pausedRemRef.current        = null;

    setIsRunning(true);
    setIsPaused(false);
    setPausedRemainingMs(null);
    setNextTransitionAt(new Date(targetMs));

    schedulePhaseEndAlert(remaining, nextPhase);
    armTimer(targetMs);
  }, [isPaused, armTimer]);

  // ── skip ─────────────────────────────────────────────────────────────────
  const skip = useCallback(() => {
    const curr = phaseRef.current;
    if (curr === "idle") return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelAllIceAlarms();
    const next: "cool" | "rest" = curr === "cool" ? "rest" : "cool";
    transitionTo(next);
  }, [transitionTo]);

  // ── stop ─────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelAllIceAlarms();

    phaseStartedAtRef.current   = null;
    nextTransitionAtRef.current = null;
    pausedRemRef.current        = null;

    setPhase("idle");
    setIsRunning(false);
    setIsPaused(false);
    setPausedRemainingMs(null);
    setNextTransitionAt(null);
    setElapsedSeconds(0);
    setCycleCount(0);
    cycleCountRef.current = 0;
  }, []);

  // ── Mount: restore from persisted state ────────────────────────────────
  useEffect(() => {
    const s = store.load();

    if (s.isPaused && s.phase !== "idle") {
      // Paused — restore UI; no timer needed
      return;
    }

    if (s.isRunning && s.phase !== "idle" && s.nextTransitionAt !== null) {
      const remaining = s.nextTransitionAt - Date.now();
      nextTransitionAtRef.current = s.nextTransitionAt;

      if (remaining > 0) {
        // Resume for remaining time
        phaseStartedAtRef.current = s.phaseStartedAt;
        armTimer(s.nextTransitionAt);
      } else {
        // Missed transition while app was killed — catch up immediately
        const next: "cool" | "rest" = s.phase === "cool" ? "rest" : "cool";
        setTimeout(() => transitionTo(next), 0);
      }
    }

    return () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <IceTherapyContext.Provider
      value={{
        phase,
        isRunning,
        isPaused,
        cycleCount,
        nextTransitionAt,
        pausedRemainingMs,
        elapsedSeconds,
        start,
        pause,
        resume,
        skip,
        stop,
      }}
    >
      {children}
    </IceTherapyContext.Provider>
  );
}

export function useIceTherapy() {
  const ctx = useContext(IceTherapyContext);
  if (!ctx) throw new Error("useIceTherapy must be used within IceTherapyProvider");
  return ctx;
}
