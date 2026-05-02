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
  const { mode, elapsedSeconds, initialized } = useTimer();
  const modeRef         = useRef<TimerMode>(mode);
  const elapsedRef      = useRef(elapsedSeconds);
  const settingsRef     = useRef(settings);
  const initializedRef  = useRef(initialized);

  // Keep refs up to date every render so effects always read fresh values.
  useEffect(() => { modeRef.current        = mode;        }, [mode]);
  useEffect(() => { elapsedRef.current     = elapsedSeconds; }, [elapsedSeconds]);
  useEffect(() => { settingsRef.current    = settings;    }, [settings]);
  useEffect(() => { initializedRef.current = initialized; }, [initialized]);

  // ── Cancel-guard ────────────────────────────────────────────────────────────
  // On initial mount TimerContext starts with mode="idle" (useState default)
  // before the real session is loaded from the server. We must NOT cancel the
  // server-side push timer on that first non-active mode run, because a timer
  // scheduled before the app was backgrounded would be destroyed prematurely.
  // mountedRef flips to true after the first scheduling decision is made, so
  // all subsequent mode changes behave normally.
  const mountedRef = useRef(false);

  // ── Shared scheduling helper ─────────────────────────────────────────────
  // Defined as a ref-stored function so both the mode-change effect and the
  // initialized-change effect can call it without repeating logic or creating
  // effect dependency issues.
  const doSchedule = useRef(() => { /* placeholder */ });

  // Update the helper every render (outside any dependency array) so it always
  // reads the latest ref values — no stale closure risk.
  doSchedule.current = () => {
    const s = settingsRef.current;
    const m = modeRef.current;

    if (m === "sitting" || m === "standing") {
      void schedulePush({
        mode: m,
        elapsedSeconds: elapsedRef.current,
        sittingAlertMinutes:     s?.sittingAlertMinutes     ?? 45,
        standingMinMinutes:      s?.standingMinMinutes       ?? 10,
        standingMaxMinutes:      s?.standingMaxMinutes       ?? 15,
        reminderIntervalMinutes: s?.reminderIntervalMinutes  ?? 1,
        remindersCount:          s?.remindersCount           ?? 3,
      }).catch(() => { /* best-effort */ });
    } else {
      // Skip the cancel until we have confirmed the session state from the
      // server (mountedRef) to avoid destroying a valid server-side timer.
      if (mountedRef.current) {
        void cancelPushSchedule().catch(() => { /* best-effort */ });
      }
    }

    mountedRef.current = true;
  };

  // ── Effect 1: fire on every mode change ────────────────────────────────────
  // Guard: skip if not yet initialized so the initial idle-mode run doesn't
  // kill the server timer. The initialized effect below handles the first real
  // schedule once session data arrives.
  useEffect(() => {
    if (!initializedRef.current) return;
    doSchedule.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Effect 2: fire once when session hydration completes ───────────────────
  // Handles two scenarios:
  //   A. Normal page load — real mode + elapsed are now available; set the
  //      server timer to reflect remaining time in the current session.
  //   B. Server restart — all in-memory timers were lost; this restores the
  //      schedule for whichever session is currently active.
  useEffect(() => {
    if (!initialized) return;
    doSchedule.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);
}
