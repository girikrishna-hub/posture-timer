import { useCallback, useEffect, useRef, useState } from "react";
import { playGoalCelebrationTone } from "@/utils/audio";

// ─── Cross-tab coordination ───────────────────────────────────────────────────

/** BroadcastChannel name used to synchronise the midnight reset across tabs. */
export const MIDNIGHT_CHANNEL_NAME = "sit-stand-midnight-reset";

// ─── localStorage keys ───────────────────────────────────────────────────────

export const CELEBRATION_KEY = "sit-stand-goal-celebrated";
export const BADGE_HINT_KEY = "sit-stand-badge-hint";

export function getCelebratedDate(): string {
  try { return localStorage.getItem(CELEBRATION_KEY) ?? ""; } catch { return ""; }
}

export function saveCelebratedDate(date: string): void {
  try { localStorage.setItem(CELEBRATION_KEY, date); } catch { /* ignore */ }
}

export function getBadgeHintDate(): string {
  try { return localStorage.getItem(BADGE_HINT_KEY) ?? ""; } catch { return ""; }
}

export function saveBadgeHintDate(date: string): void {
  try { localStorage.setItem(BADGE_HINT_KEY, date); } catch { /* ignore */ }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function msUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

// ─── Pure predicates (also useful for unit tests) ────────────────────────────

/**
 * Returns true only when the goal threshold is crossed for the first time this
 * session (prev < 100 → current >= 100).
 *
 * - prev === null → first render; stats just loaded. Never celebrate here;
 *   the goalMetOnLoad effect handles the initial state instead.
 * - prev >= 100   → already over the line; no new crossing.
 * - current < 100 → hasn't reached the goal yet.
 */
export function shouldTriggerGoalCelebration(
  prev: number | null,
  current: number,
): boolean {
  if (prev === null) return false;
  if (prev >= 100) return false;
  if (current < 100) return false;
  return true;
}

/**
 * Returns the value that goalMetOnLoad should be set to when todayStats first
 * resolves (i.e. whether the goal was already met at page load).
 */
export function computeGoalMetOnLoad(liveGoalPercent: number): boolean {
  return liveGoalPercent >= 100;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseGoalCelebrationOptions {
  liveGoalPercent: number;
  /**
   * Set to true once todayStats has loaded. Used to initialise goalMetOnLoad
   * exactly once (needed by TimerPage for the footer appear animation).
   * Defaults to false — callers that don't need goalMetOnLoad can omit this.
   */
  todayStatsLoaded?: boolean;
  /**
   * Called once when the goal is first crossed during this session (after
   * the deduplication guard passes). Use for page-specific side-effects such
   * as showing a banner.
   */
  onCelebrate?: () => void;
}

export interface UseGoalCelebrationResult {
  celebrating: boolean;
  goalAchieved: boolean;
  freshAchievementRef: React.MutableRefObject<boolean>;
  skipBadgePopInRef: React.MutableRefObject<boolean>;
  badgeHintShown: boolean;
  showBadgeHint: boolean;
  handleBadgeHintShown: () => void;
  replayCelebration: () => void;
  /**
   * Whether the goal was already met when stats first loaded.
   * null = stats not yet available.
   * Only meaningful when todayStatsLoaded is passed.
   */
  goalMetOnLoad: boolean | null;
}

export function useGoalCelebration({
  liveGoalPercent,
  todayStatsLoaded = false,
  onCelebrate,
}: UseGoalCelebrationOptions): UseGoalCelebrationResult {
  const [celebrating, setCelebrating] = useState(false);
  const [goalAchieved, setGoalAchieved] = useState(() => getCelebratedDate() === todayStr());
  // true = badge was just earned this session (animate in after celebration delay)
  const freshAchievementRef = useRef(false);
  // true = goal was already achieved when the page loaded (skip badge-pop-in on reload)
  // cleared to false on first replay so subsequent appearances still animate.
  const skipBadgePopInRef = useRef(getCelebratedDate() === todayStr());
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevGoalPercentRef = useRef<number | null>(null);

  // Badge hint wiggle — shown once after the badge first appears
  const [badgeHintShown, setBadgeHintShown] = useState(() => getBadgeHintDate() === todayStr());
  // Ref acts as an in-session guard: set true when the hint is first scheduled
  // so the wiggle never replays even if the badge unmounts before animationEnd.
  const hintScheduledRef = useRef(getBadgeHintDate() === todayStr());

  // goalMetOnLoad: set once when stats first resolve (used by TimerPage for footer animation)
  const [goalMetOnLoad, setGoalMetOnLoad] = useState<boolean | null>(null);
  const hasSetGoalMetOnLoad = useRef(false);

  // Stable ref wrappers to avoid stale closures in effects
  const onCelebrateRef = useRef(onCelebrate);
  useEffect(() => { onCelebrateRef.current = onCelebrate; });
  // todayStatsLoaded as a ref so the celebration effect can read the latest
  // value without needing it as a dep (liveGoalPercent already drives the effect)
  const todayStatsLoadedRef = useRef(todayStatsLoaded);
  useEffect(() => { todayStatsLoadedRef.current = todayStatsLoaded; });

  // showBadgeHint stays true for the entire first mount of TrophyBadge so the
  // CSS animation can play; it flips false after animationEnd (state) or on the
  // next badge mount within the same session (ref).
  const showBadgeHint = goalAchieved && !badgeHintShown && !hintScheduledRef.current;

  // Persist the hint date immediately when scheduled — before the animation
  // completes — so a reload mid-animation won't replay the wiggle.
  useEffect(() => {
    if (showBadgeHint) {
      saveBadgeHintDate(todayStr());
      hintScheduledRef.current = true;
      // State intentionally NOT updated here so TrophyBadge keeps showHint=true
      // for its current mount and the CSS animation can run to completion.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBadgeHint]);

  // Capture once — when todayStats first resolves — whether the goal was
  // already met at load time.
  useEffect(() => {
    if (todayStatsLoaded && !hasSetGoalMetOnLoad.current) {
      hasSetGoalMetOnLoad.current = true;
      setGoalMetOnLoad(computeGoalMetOnLoad(liveGoalPercent));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayStatsLoaded]);

  // Celebration: fire once per day when goal crosses from <100 to >=100.
  // Skip updating prevGoalPercentRef until stats are confirmed loaded so that
  // liveGoalPercent defaulting to 0 before stats arrive can never cause a
  // spurious 0→≥100 crossing when stats first resolve.
  useEffect(() => {
    if (!todayStatsLoadedRef.current) return;

    const prev = prevGoalPercentRef.current;
    prevGoalPercentRef.current = liveGoalPercent;

    if (!shouldTriggerGoalCelebration(prev, liveGoalPercent)) return;

    const today = todayStr();
    if (getCelebratedDate() === today) return;
    saveCelebratedDate(today);
    freshAchievementRef.current = true;
    setGoalAchieved(true);
    playGoalCelebrationTone();
    onCelebrateRef.current?.();
    setCelebrating(true);
    celebrationTimerRef.current = setTimeout(() => {
      setCelebrating(false);
    }, 2000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveGoalPercent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    };
  }, []);

  // Reset all celebration/badge state at midnight so a new day starts clean.
  // A BroadcastChannel is used to notify background tabs immediately when any
  // tab's timeout fires, so throttled timers in hidden tabs never miss the reset.
  useEffect(() => {
    let dayTimer: ReturnType<typeof setTimeout>;

    // Open a cross-tab channel if the browser supports it (graceful fallback).
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(MIDNIGHT_CHANNEL_NAME);
    } catch {
      // BroadcastChannel not supported — timeout-only fallback is sufficient.
    }

    function doReset() {
      setCelebrating(false);
      setGoalAchieved(false);
      freshAchievementRef.current = false;
      skipBadgePopInRef.current = false;
      setBadgeHintShown(false);
      hintScheduledRef.current = false;
      if (celebrationTimerRef.current) {
        clearTimeout(celebrationTimerRef.current);
        celebrationTimerRef.current = null;
      }
      prevGoalPercentRef.current = null;
      hasSetGoalMetOnLoad.current = false;
      setGoalMetOnLoad(null);
    }

    function scheduleMidnightReset() {
      dayTimer = setTimeout(() => {
        // Signal all other open tabs before resetting locally.
        try { channel?.postMessage("midnight-reset"); } catch { /* ignore */ }
        doReset();
        scheduleMidnightReset();
      }, msUntilMidnight());
    }

    // Listen for the reset signal broadcast by whichever tab fires first.
    // Guard on the payload so unrelated messages on the same channel are ignored.
    if (channel) {
      channel.onmessage = (ev) => {
        if (ev.data === "midnight-reset") doReset();
      };
    }

    scheduleMidnightReset();
    return () => {
      clearTimeout(dayTimer);
      channel?.close();
    };
  }, []);

  const handleBadgeHintShown = useCallback(() => {
    setBadgeHintShown(true);
  }, []);

  const replayCelebration = useCallback(() => {
    if (!goalAchieved || celebrating) return;
    freshAchievementRef.current = false;
    skipBadgePopInRef.current = false;
    playGoalCelebrationTone();
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    setCelebrating(true);
    celebrationTimerRef.current = setTimeout(() => {
      setCelebrating(false);
    }, 2000);
  }, [goalAchieved, celebrating]);

  return {
    celebrating,
    goalAchieved,
    freshAchievementRef,
    skipBadgePopInRef,
    badgeHintShown,
    showBadgeHint,
    handleBadgeHintShown,
    replayCelebration,
    goalMetOnLoad,
  };
}
