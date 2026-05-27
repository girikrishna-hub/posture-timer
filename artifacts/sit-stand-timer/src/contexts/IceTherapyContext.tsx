/**
 * IceTherapyContext — Protocol Extension Example
 *
 * This file is ARCHITECTURAL PROOF ONLY. It is not registered in App.tsx,
 * not exposed in the navigation, and has no active route. It demonstrates
 * how to implement a new parallel protocol context following the established
 * extension pattern without modifying TimerContext.
 *
 * Protocol: Alternating Ice-On / Rest cycles
 *   • Phase "cool"  — apply ice pack     (default 20 min)
 *   • Phase "rest"  — remove, let skin warm (default 20 min)
 *   • Repeats automatically
 *
 * To activate this protocol in the future:
 *   1. Add <IceTherapyProvider> to App.tsx (see ADDING_PROTOCOLS.md)
 *   2. Create IceTherapyPage.tsx following BladderPage.tsx as a model
 *   3. Add a route in App.tsx routing to that page
 *   4. Add a nav link in BottomNav or a Settings entry point
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
  makeStorageHelpers,
  showNotificationNow,
  scheduleSWNotification,
  cancelSWNotification,
  targetMsFromNow,
} from "@/lib/protocol/utils";
import type { ProtocolContextShape, ProtocolPersistedState } from "@/lib/protocol/types";

// ─── Protocol definition ─────────────────────────────────────────────────────

const ICE_THERAPY_ID = "ice-therapy";

const DEFAULT_COOL_MINUTES = 20;
const DEFAULT_REST_MINUTES = 20;

// ─── Phase type ──────────────────────────────────────────────────────────────

export type IcePhase = "cool" | "rest" | "idle";

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = `protocol:${ICE_THERAPY_ID}:state`;

interface IceTherapyState extends ProtocolPersistedState<IcePhase> {
  coolDurationMinutes: number;
  restDurationMinutes: number;
}

const DEFAULT_STATE: IceTherapyState = {
  version: 1,
  enabled: false,
  phase: "idle",
  phaseStartedAt: null,
  nextTransitionAt: null,
  coolDurationMinutes: DEFAULT_COOL_MINUTES,
  restDurationMinutes: DEFAULT_REST_MINUTES,
};

const store = makeStorageHelpers<IceTherapyState>(STORAGE_KEY, DEFAULT_STATE);

// ─── Context shape ───────────────────────────────────────────────────────────

interface IceTherapyContextValue extends ProtocolContextShape<IcePhase> {
  coolDurationMinutes: number;
  restDurationMinutes: number;
  setCoolDuration: (minutes: number) => void;
  setRestDuration: (minutes: number) => void;
  /** Skip to the next phase early */
  skipToNext: () => void;
}

// ─── Notifications ───────────────────────────────────────────────────────────

function notifyPhase(phase: IcePhase, coolMin: number, restMin: number): void {
  if (phase === "cool") {
    showNotificationNow(
      "🧊 Apply ice pack",
      `Ice therapy started — keep it on for ${coolMin} minutes.`,
      ICE_THERAPY_ID,
    );
  } else if (phase === "rest") {
    showNotificationNow(
      "♻️ Remove ice pack",
      `Rest phase — let your skin warm for ${restMin} minutes.`,
      ICE_THERAPY_ID,
    );
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

const IceTherapyContext = createContext<IceTherapyContextValue | null>(null);

export function IceTherapyProvider({ children }: { children: React.ReactNode }) {
  const saved = store.load();

  const [enabled,              setEnabledState]    = useState(saved.enabled);
  const [phase,                setPhaseState]       = useState<IcePhase>(saved.phase);
  const [coolDurationMinutes,  setCoolState]        = useState(saved.coolDurationMinutes);
  const [restDurationMinutes,  setRestState]        = useState(saved.restDurationMinutes);
  const [nextTransitionAt,     setNextTransitionAt] = useState<Date | null>(
    saved.nextTransitionAt ? new Date(saved.nextTransitionAt) : null,
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Stable refs — accessed inside setTimeout callbacks without stale-closure issues
  const timerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef         = useRef<IcePhase>(phase);
  const enabledRef       = useRef(enabled);
  const coolRef          = useRef(coolDurationMinutes);
  const restRef          = useRef(restDurationMinutes);
  const phaseStartedAtRef = useRef<number | null>(saved.phaseStartedAt);

  useEffect(() => { phaseRef.current   = phase;              }, [phase]);
  useEffect(() => { enabledRef.current = enabled;            }, [enabled]);
  useEffect(() => { coolRef.current    = coolDurationMinutes;}, [coolDurationMinutes]);
  useEffect(() => { restRef.current    = restDurationMinutes;}, [restDurationMinutes]);

  // ── Persist state on every meaningful change ────────────────────────────
  useEffect(() => {
    store.save({
      version: 1,
      enabled,
      phase,
      phaseStartedAt: phaseStartedAtRef.current,
      nextTransitionAt: nextTransitionAt?.getTime() ?? null,
      coolDurationMinutes,
      restDurationMinutes,
    });
  }, [enabled, phase, nextTransitionAt, coolDurationMinutes, restDurationMinutes]);

  // ── 1-second elapsed counter ────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || phase === "idle") { setElapsedSeconds(0); return; }

    const interval = setInterval(() => {
      const startedAt = phaseStartedAtRef.current;
      if (startedAt !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [enabled, phase]);

  // ── Phase transition ────────────────────────────────────────────────────
  const transitionToPhase = useCallback((nextPhase: "cool" | "rest") => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelSWNotification();

    const durationMin = nextPhase === "cool" ? coolRef.current : restRef.current;
    const targetMs = targetMsFromNow(durationMin);
    const now = Date.now();

    phaseStartedAtRef.current = now;
    setPhaseState(nextPhase);
    setElapsedSeconds(0);
    setNextTransitionAt(new Date(targetMs));

    notifyPhase(nextPhase, coolRef.current, restRef.current);

    // Schedule background alert for when this phase ends
    const oppositePhase = nextPhase === "cool" ? "rest" : "cool";
    const oppositeLabel = nextPhase === "cool" ? "Remove ice pack" : "Apply ice pack";
    const oppositeBody  = nextPhase === "cool"
      ? `Rest phase starting — let skin warm for ${restRef.current} minutes.`
      : `Ice phase starting — keep it on for ${coolRef.current} minutes.`;
    scheduleSWNotification({
      delayMs: durationMin * 60 * 1000,
      title: oppositeLabel,
      body: oppositeBody,
      tag: `${ICE_THERAPY_ID}-${oppositePhase}`,
    });

    // Arm the JS timer
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (enabledRef.current) {
        transitionToPhase(phaseRef.current === "cool" ? "rest" : "cool");
      }
    }, durationMin * 60 * 1000);
  }, []);

  // ── Stop all timers ─────────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelSWNotification();
    phaseStartedAtRef.current = null;
    setPhaseState("idle");
    setNextTransitionAt(null);
    setElapsedSeconds(0);
  }, []);

  // ── Toggle on / off ─────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      enabledRef.current = next;
      if (next) {
        // Restore from saved deadline if it's still in the future
        const saved = store.load();
        if (saved.nextTransitionAt && saved.nextTransitionAt > Date.now() && saved.phase !== "idle") {
          const rem = saved.nextTransitionAt - Date.now();
          phaseStartedAtRef.current = saved.phaseStartedAt;
          setPhaseState(saved.phase);
          setNextTransitionAt(new Date(saved.nextTransitionAt));
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (enabledRef.current) {
              transitionToPhase(phaseRef.current === "cool" ? "rest" : "cool");
            }
          }, rem);
        } else {
          // Start fresh with cool phase
          setTimeout(() => transitionToPhase("cool"), 0);
        }
      } else {
        stop();
      }
      return next;
    });
  }, [stop, transitionToPhase]);

  // ── Skip to next phase early ────────────────────────────────────────────
  const skipToNext = useCallback(() => {
    if (!enabledRef.current || phaseRef.current === "idle") return;
    transitionToPhase(phaseRef.current === "cool" ? "rest" : "cool");
  }, [transitionToPhase]);

  // ── Mount: resume from persisted deadline ───────────────────────────────
  useEffect(() => {
    if (!enabled || phase === "idle") return;
    const saved = store.load();
    if (saved.nextTransitionAt && saved.nextTransitionAt > Date.now()) {
      const rem = saved.nextTransitionAt - Date.now();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (enabledRef.current) {
          transitionToPhase(phaseRef.current === "cool" ? "rest" : "cool");
        }
      }, rem);
    } else if (phase === "cool" || phase === "rest") {
      // Past-due: transition immediately
      transitionToPhase(phase === "cool" ? "rest" : "cool");
    }
    return () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
    // Intentionally runs once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Duration setters ────────────────────────────────────────────────────
  const setCoolDuration = useCallback((minutes: number) => {
    const clamped = Math.min(60, Math.max(5, minutes));
    coolRef.current = clamped;
    setCoolState(clamped);
  }, []);

  const setRestDuration = useCallback((minutes: number) => {
    const clamped = Math.min(60, Math.max(5, minutes));
    restRef.current = clamped;
    setRestState(clamped);
  }, []);

  return (
    <IceTherapyContext.Provider
      value={{
        enabled,
        phase,
        nextTransitionAt,
        elapsedSeconds,
        coolDurationMinutes,
        restDurationMinutes,
        toggle,
        skipToNext,
        setCoolDuration,
        setRestDuration,
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
