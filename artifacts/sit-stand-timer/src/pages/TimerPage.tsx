import { useTimer, type TimerMode } from "@/contexts/TimerContext";
import { useGetTodayStats, useGetSettings, getGetTodayStatsQueryKey } from "@workspace/api-client-react";
import { playGoalCelebrationTone, isSoundEnabled, setSoundEnabled } from "@/utils/audio";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEffect, useRef, useState } from "react";
import { useFitbitDrift } from "@/hooks/useFitbitDrift";
import { NudgeModal } from "@/components/NudgeModal";
import { useBanner } from "@/hooks/useBanner";

export const CELEBRATION_KEY = "sit-stand-goal-celebrated";
export const BADGE_HINT_KEY = "sit-stand-badge-hint";

function getCelebratedDate(): string {
  try { return localStorage.getItem(CELEBRATION_KEY) ?? ""; } catch { return ""; }
}

function saveCelebratedDate(date: string): void {
  try { localStorage.setItem(CELEBRATION_KEY, date); } catch { /* ignore */ }
}

function getBadgeHintDate(): string {
  try { return localStorage.getItem(BADGE_HINT_KEY) ?? ""; } catch { return ""; }
}

function saveBadgeHintDate(date: string): void {
  try { localStorage.setItem(BADGE_HINT_KEY, date); } catch { /* ignore */ }
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function goalLabelClass(footerGoalMet: boolean, goalMetOnLoad: boolean | null): string {
  return `flex items-center gap-1 transition-colors duration-500 ${
    footerGoalMet
      ? `text-emerald-600 dark:text-emerald-400 font-medium${goalMetOnLoad === false ? " goal-label-appear" : ""}`
      : ""
  }`;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);

    const mq = window.matchMedia("(display-mode: standalone)");
    if (mq.matches) setIsInstalled(true);
    const mqHandler = (e: MediaQueryListEvent) => { if (e.matches) setIsInstalled(true); };
    mq.addEventListener("change", mqHandler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      mq.removeEventListener("change", mqHandler);
    };
  }, []);

  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === "accepted") {
      setPromptEvent(null);
      setIsInstalled(true);
    }
  };

  return { canInstall: !!promptEvent && !isInstalled, install };
}

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatLiveElapsed(totalSeconds: number): string {
  const totalSecsInt = Math.floor(totalSeconds);
  const mins = Math.floor(totalSecsInt / 60);
  const secs = totalSecsInt % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m ${String(secs).padStart(2, "0")}s` : `${h}h ${String(secs).padStart(2, "0")}s`;
}

function ModeIcon({ mode }: { mode: TimerMode }) {
  if (mode === "sitting") {
    return (
      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-24 h-24">
        <circle cx="32" cy="12" r="8" fill="currentColor" opacity="0.9" />
        <path d="M20 28C20 22 24 20 32 20C40 20 44 22 44 28V42H38V32H26V42H20V28Z" fill="currentColor" opacity="0.8" />
        <path d="M18 42H46V48H40L36 56H28L24 48H18V42Z" fill="currentColor" opacity="0.6" />
      </svg>
    );
  }
  if (mode === "standing") {
    return (
      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-24 h-24">
        <circle cx="32" cy="10" r="8" fill="currentColor" opacity="0.9" />
        <path d="M26 20H38V44H26V20Z" fill="currentColor" opacity="0.8" />
        <path d="M22 44H30V62H22V44Z" fill="currentColor" opacity="0.6" />
        <path d="M34 44H42V62H34V44Z" fill="currentColor" opacity="0.6" />
      </svg>
    );
  }
  if (mode === "resting") {
    return (
      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-24 h-24">
        <ellipse cx="32" cy="36" rx="20" ry="10" fill="currentColor" opacity="0.4" />
        <path d="M12 30C12 24 20 20 32 20C44 20 52 24 52 30V38C52 44 44 48 32 48C20 48 12 44 12 38V30Z" fill="currentColor" opacity="0.7" />
        <circle cx="26" cy="30" r="3" fill="white" opacity="0.6" />
        <circle cx="38" cy="30" r="3" fill="white" opacity="0.6" />
      </svg>
    );
  }
  if (mode === "walking") {
    return (
      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-24 h-24">
        <circle cx="36" cy="8" r="6" fill="currentColor" opacity="0.9" />
        <path d="M30 16L22 30L14 28L12 34L24 38L32 24L36 30L34 44H40L42 28L36 20L38 16H30Z" fill="currentColor" opacity="0.8" />
        <path d="M34 44H40L44 56H38L34 44Z" fill="currentColor" opacity="0.6" />
        <path d="M40 44L36 56H30L34 44H40Z" fill="currentColor" opacity="0.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-24 h-24">
      <circle cx="32" cy="32" r="20" stroke="currentColor" strokeWidth="3" strokeDasharray="6 4" fill="none" opacity="0.5" />
      <circle cx="32" cy="32" r="6" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function getModeLabel(mode: TimerMode): string {
  switch (mode) {
    case "sitting": return "Sitting";
    case "standing": return "Standing";
    case "resting": return "Resting";
    case "walking": return "Walking";
    default: return "Ready";
  }
}

function getModeColor(mode: TimerMode): string {
  switch (mode) {
    case "sitting": return "text-amber-700 dark:text-amber-400";
    case "standing": return "text-emerald-700 dark:text-emerald-400";
    case "resting": return "text-indigo-700 dark:text-indigo-400";
    case "walking": return "text-teal-700 dark:text-teal-400";
    default: return "text-muted-foreground";
  }
}


const RING_SIZE = 224;
const STROKE_WIDTH = 10;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function TrophyBadge({ delayed, skipPopIn, onReplay, showHint, onHintShown }: { delayed: boolean; skipPopIn: boolean; onReplay: () => void; showHint: boolean; onHintShown: () => void }) {
  const popInDelay = delayed ? 2.1 : 0;
  const wiggleDelay = popInDelay + 0.8;
  const popInPart = skipPopIn ? "" : `badge-pop-in 0.5s ${popInDelay}s cubic-bezier(0.34,1.56,0.64,1) both`;
  const hintPart = showHint ? `badge-hint-wiggle 0.7s ${wiggleDelay}s ease-in-out 1 both` : "";
  const animation = [popInPart, hintPart].filter(Boolean).join(", ") || undefined;

  const handleAnimationEnd = (e: React.AnimationEvent<HTMLButtonElement>) => {
    if (e.animationName === "badge-hint-wiggle") {
      onHintShown();
    }
  };

  return (
    <button
      type="button"
      onClick={onReplay}
      className="absolute left-1/2 flex items-center justify-center w-7 h-7 rounded-full bg-emerald-500 dark:bg-emerald-600 shadow-md ring-2 ring-background hover:bg-emerald-400 dark:hover:bg-emerald-500 active:scale-90 transition-transform cursor-pointer"
      style={{
        top: "-10px",
        animation,
      }}
      onAnimationEnd={handleAnimationEnd}
      title="Tap to replay celebration"
      aria-label="Replay goal celebration"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="w-4 h-4 text-white"
      >
        <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    </button>
  );
}

function GoalProgressRing({ mode, goalPercent, celebrating, goalAchieved, badgeDelayed, skipBadgePopIn, showBadgeHint, onBadgeHintShown, onReplayCelebration }: { mode: TimerMode; goalPercent: number; celebrating: boolean; goalAchieved: boolean; badgeDelayed: boolean; skipBadgePopIn: boolean; showBadgeHint: boolean; onBadgeHintShown: () => void; onReplayCelebration: () => void }) {
  const clampedPercent = Math.max(0, Math.min(goalPercent, 100));
  const dashOffset = CIRCUMFERENCE * (1 - clampedPercent / 100);
  const goalMet = goalPercent >= 100;

  const trackColor = "rgba(128,128,128,0.15)";
  const progressColor = goalMet ? "#10b981" : "#f59e0b";

  function getModeBackground(m: TimerMode): string {
    switch (m) {
      case "sitting": return "bg-amber-50 dark:bg-amber-950/40";
      case "standing": return "bg-emerald-50 dark:bg-emerald-950/40";
      case "resting": return "bg-indigo-50 dark:bg-indigo-950/40";
      case "walking": return "bg-teal-50 dark:bg-teal-950/40";
      default: return "bg-card";
    }
  }

  return (
    <div className="relative w-56 h-56">
      {goalAchieved && !celebrating && <TrophyBadge delayed={badgeDelayed} skipPopIn={skipBadgePopIn} onReplay={onReplayCelebration} showHint={showBadgeHint} onHintShown={onBadgeHintShown} />}
      {celebrating && (
        <>
          <span
            className="absolute inset-0 rounded-full"
            style={{
              animation: "goal-pulse 0.7s ease-out forwards",
              background: "transparent",
              border: "3px solid #10b981",
              borderRadius: "50%",
            }}
          />
          <span
            className="absolute inset-0 rounded-full"
            style={{
              animation: "goal-pulse 0.7s 0.25s ease-out forwards",
              background: "transparent",
              border: "3px solid #10b981",
              borderRadius: "50%",
              opacity: 0,
            }}
          />
          <span
            className="absolute inset-0 rounded-full"
            style={{
              animation: "goal-pulse 0.7s 0.5s ease-out forwards",
              background: "transparent",
              border: "3px solid #10b981",
              borderRadius: "50%",
              opacity: 0,
            }}
          />
        </>
      )}
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="absolute inset-0"
        style={{
          transform: "rotate(-90deg)",
          animation: celebrating ? "goal-ring-pulse 1.2s ease-in-out" : undefined,
        }}
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={trackColor}
          strokeWidth={STROKE_WIDTH}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={progressColor}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 0.7s ease, stroke 0.5s ease" }}
        />
      </svg>
      <div
        className={`absolute inset-2 rounded-full flex flex-col items-center justify-center transition-colors duration-700 ${getModeBackground(mode)}`}
      >
        {celebrating ? (
          <span
            className="text-2xl font-bold text-emerald-600 dark:text-emerald-400"
            style={{ animation: "goal-text-pop 1.4s ease-in-out forwards" }}
          >
            Goal!
          </span>
        ) : (
          <>
            <div className={`transition-colors duration-500 ${getModeColor(mode)}`}>
              <ModeIcon mode={mode} />
            </div>
            <span className={`text-sm font-semibold tracking-widest uppercase mt-1 transition-colors duration-500 ${getModeColor(mode)}`}>
              {getModeLabel(mode)}
            </span>
            <span
              className={`text-xs font-medium mt-1 tabular-nums transition-colors duration-500 ${goalMet ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
            >
              {Math.round(clampedPercent)}%
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default function TimerPage() {
  const {
    mode,
    elapsedSeconds,
    reminderCount,
    inReminderPhase,
    isLoading,
    switchMode,
    gpsStatus,
    requestNotificationPermission,
    notificationPermission,
  } = useTimer();

  const { canInstall, install } = useInstallPrompt();

  const [soundEnabled, setSoundEnabledState] = useState(() => isSoundEnabled());

  const soundBanner = useBanner<string>(1500);

  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    setSoundEnabledState(next);
    soundBanner.show(next ? "Sound on" : "Sound off");
  }

  const { data: todayStats } = useGetTodayStats({
    query: { queryKey: getGetTodayStatsQueryKey(), refetchInterval: 30000 },
  });

  useEffect(() => {
    if (notificationPermission === "default") {
      requestNotificationPermission();
    }
  }, [notificationPermission, requestNotificationPermission]);

  const { data: settingsData } = useGetSettings();
  const sittingAlertMinutes = settingsData?.sittingAlertMinutes ?? 45;
  const standingMinMinutes = settingsData?.standingMinMinutes ?? 10;
  const remindersCount = settingsData?.remindersCount ?? 3;
  const autoDetectWalking = settingsData?.autoDetectWalking ?? false;

  // Live goal percent: add current session's elapsed standing/walking time so
  // the ring moves in real time (every second) instead of only on API refetch
  // (every 30s). Walking counts toward the goal just like standing.
  const completedStandingMinutes = todayStats?.standingMinutes ?? 0;
  const completedWalkingMinutes = todayStats?.walkingMinutes ?? 0;
  const goalMinutes = todayStats?.goalMinutes ?? 120;
  const isActiveMode = mode === "standing" || mode === "walking";
  const liveStandingTotalSeconds = completedStandingMinutes * 60 + (isActiveMode ? elapsedSeconds : 0);
  const completedSittingMinutes = todayStats?.sittingMinutes ?? 0;
  const isActiveSitting = mode === "sitting";
  const liveSittingTotalSeconds = completedSittingMinutes * 60 + (isActiveSitting ? elapsedSeconds : 0);
  // Cap in-progress minutes to time elapsed since local midnight so a session
  // spanning midnight doesn't inflate today's count — same guard used for
  // milestone notifications in TimerContext.
  const secondsSinceLocalMidnight = (): number => {
    const now = new Date();
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  };
  const cappedElapsedMinutes = isActiveMode
    ? Math.min(elapsedSeconds, secondsSinceLocalMidnight()) / 60
    : 0;
  const liveGoalPercent = goalMinutes > 0
    ? Math.min(100, ((completedStandingMinutes + completedWalkingMinutes + cappedElapsedMinutes) / goalMinutes) * 100)
    : todayStats?.goalProgressPercent ?? 0;

  // Celebration: fire once per day when goal crosses from <100 to >=100
  const [celebrating, setCelebrating] = useState(false);
  const [goalAchieved, setGoalAchieved] = useState(() => getCelebratedDate() === todayStr());
  // true = badge was just earned this session (animate in after celebration delay)
  // false = badge loaded from localStorage (animate in immediately on mount)
  const freshAchievementRef = useRef(false);
  // true = goal was already achieved when the page loaded (from localStorage), so
  // skip the badge-pop-in animation to prevent it replaying on every reload.
  // Cleared to false on first replay so subsequent appearances still animate.
  const skipBadgePopInRef = useRef(getCelebratedDate() === todayStr());
  // Track whether the hint wiggle has already been shown today (state) or
  // at least scheduled this session (ref). State initialises from localStorage
  // so a page reload after the hint played still suppresses it.
  const [badgeHintShown, setBadgeHintShown] = useState(() => getBadgeHintDate() === todayStr());
  // Ref acts as an in-session guard: set true when the hint is first scheduled
  // so the wiggle never replays even if the badge unmounts before animationEnd.
  const hintScheduledRef = useRef(getBadgeHintDate() === todayStr());

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

  function handleBadgeHintShown() {
    setBadgeHintShown(true);
  }
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevGoalPercentRef = useRef<number | null>(null);
  // Track whether the goal was already met when stats first loaded so we can
  // skip the appear animation on reload. null = stats not yet available.
  // Set exactly once (via hasSetGoalMetOnLoad guard) when todayStats first resolves.
  const [goalMetOnLoad, setGoalMetOnLoad] = useState<boolean | null>(null);
  const hasSetGoalMetOnLoad = useRef(false);

  useEffect(() => {
    const prev = prevGoalPercentRef.current;
    prevGoalPercentRef.current = liveGoalPercent;

    // Only fire when crossing the 100% threshold (not on initial load when already >=100)
    if (prev === null || prev >= 100 || liveGoalPercent < 100) return;

    const today = todayStr();
    if (getCelebratedDate() === today) return;
    saveCelebratedDate(today);
    freshAchievementRef.current = true;
    setGoalAchieved(true);
    playGoalCelebrationTone();
    setCelebrating(true);
    celebrationTimerRef.current = setTimeout(() => {
      setCelebrating(false);
    }, 2000);
  }, [liveGoalPercent]);

  // Capture once — when todayStats first resolves — whether the goal was
  // already met at load time. This lets us skip the footer appear animation
  // on page reload while still playing it for mid-session crossings.
  useEffect(() => {
    if (todayStats && !hasSetGoalMetOnLoad.current) {
      hasSetGoalMetOnLoad.current = true;
      setGoalMetOnLoad(liveGoalPercent >= 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayStats]);

  useEffect(() => {
    return () => {
      if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    };
  }, []);

  function replayCelebration() {
    if (!goalAchieved || celebrating) return;
    // After first display the badge should pop back in immediately (no delay)
    freshAchievementRef.current = false;
    // Allow the pop-in animation for replays, even if it was skipped on page load
    skipBadgePopInRef.current = false;
    playGoalCelebrationTone();
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    setCelebrating(true);
    celebrationTimerRef.current = setTimeout(() => {
      setCelebrating(false);
    }, 2000);
  }

  // Reset celebration/badge state at midnight so a new day starts clean
  useEffect(() => {
    function msUntilMidnight(): number {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      return midnight.getTime() - now.getTime();
    }

    let dayTimer: ReturnType<typeof setTimeout>;

    function scheduleMidnightReset() {
      dayTimer = setTimeout(() => {
        // Clear state for the new day
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
        // Also reset the prev-goal ref so the crossing logic works fresh
        prevGoalPercentRef.current = null;
        // Reset on-load snapshot so next-day goal crossing animates correctly
        hasSetGoalMetOnLoad.current = false;
        setGoalMetOnLoad(null);
        // Schedule the next midnight reset
        scheduleMidnightReset();
      }, msUntilMidnight());
    }

    scheduleMidnightReset();
    return () => clearTimeout(dayTimer);
  }, []);

  const nextActionSeconds =
    mode === "sitting"
      ? sittingAlertMinutes * 60 - elapsedSeconds
      : mode === "standing"
      ? standingMinMinutes * 60 - elapsedSeconds
      : null;

  const reminderMessage = inReminderPhase
    ? mode === "sitting"
      ? `Reminder ${reminderCount} of ${remindersCount} — time to stand!`
      : `Reminder ${reminderCount} of ${remindersCount} — time to sit!`
    : null;

  // Auto-switch toast
  const autoSwitchBanner = useBanner<string>(4000);
  const showAutoSwitchToast = (toMode: string, reason: string) => {
    const label = toMode === "sitting" ? "Sitting" : toMode === "standing" ? "Standing" : "Walking";
    autoSwitchBanner.show(`Auto-switched to ${label} — ${reason}`);
  };

  // Hook handles switchMode internally; onAutoSwitch is only for UI feedback
  const { nudge, confirmNudge, cancelNudge } = useFitbitDrift({
    onAutoSwitch: showAutoSwitchToast,
  });

  // confirmNudge already calls switchMode("fitbit_suggested") inside the hook
  const handleNudgeConfirm = () => {
    confirmNudge();
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <NudgeModal nudge={nudge} onConfirm={handleNudgeConfirm} onCancel={cancelNudge} />

      {autoSwitchBanner.shown && (
        <div
          role="status"
          aria-live="polite"
          className={[
            "fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border shadow-lg rounded-2xl px-4 py-2.5 text-sm font-medium text-foreground flex items-center gap-2",
            "transition-all duration-300 ease-out",
            autoSwitchBanner.visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
          ].join(" ")}
        >
          <span>🤖</span>
          {autoSwitchBanner.message}
        </div>
      )}

      {soundBanner.shown && (
        <div
          role="status"
          aria-live="polite"
          className={[
            "fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border shadow-lg rounded-2xl px-4 py-2.5 text-sm font-medium text-foreground flex items-center gap-2",
            "transition-all duration-300 ease-out",
            soundBanner.visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
          ].join(" ")}
        >
          <span>{soundBanner.message === "Sound on" ? "🔔" : "🔇"}</span>
          {soundBanner.message}
        </div>
      )}

      {canInstall && (
        <div className="mx-4 mt-4 flex items-center justify-between gap-3 bg-card border border-border rounded-2xl px-4 py-3 shadow-sm">
          <div>
            <p className="text-sm font-medium text-foreground">Install app</p>
            <p className="text-xs text-muted-foreground">Add to your home screen for quick access</p>
          </div>
          <Button size="sm" onClick={install} className="shrink-0">Install</Button>
        </div>
      )}
      <header className="flex items-center justify-between px-6 pt-6 pb-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Sit + Stand</h1>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            Your daily movement tracker
            {gpsStatus === "requesting" && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-50" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-muted-foreground" />
                </span>
                GPS…
              </span>
            )}
            {gpsStatus === "active" && mode !== "walking" && (
              <span className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
                </span>
                GPS
              </span>
            )}
            {gpsStatus === "active" && mode === "walking" && (
              <span className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-400 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
                </span>
                Walking detected
              </span>
            )}
            {gpsStatus === "denied" && autoDetectWalking && (
              <a
                href="/settings"
                className="text-destructive underline-offset-2 hover:underline"
                title="Location permission denied — tap to go to Settings"
              >
                GPS blocked
              </a>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggleSound}
          className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-lg hover:bg-muted"
          aria-label={soundEnabled ? "Mute sounds" : "Unmute sounds"}
          title={soundEnabled ? "Mute sounds" : "Unmute sounds"}
        >
          {soundEnabled ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="22" y1="9" x2="16" y2="15"/>
              <line x1="16" y1="9" x2="22" y2="15"/>
            </svg>
          )}
        </button>
        <button
          onClick={() => window.location.href = "/settings"}
          className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-lg hover:bg-muted"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        <GoalProgressRing
          mode={mode}
          goalPercent={liveGoalPercent}
          celebrating={celebrating}
          goalAchieved={goalAchieved}
          badgeDelayed={freshAchievementRef.current}
          skipBadgePopIn={skipBadgePopInRef.current}
          showBadgeHint={showBadgeHint}
          onBadgeHintShown={handleBadgeHintShown}
          onReplayCelebration={replayCelebration}
        />

        <div className="text-center space-y-1">
          <div className="text-6xl font-mono font-light tracking-tight text-foreground tabular-nums">
            {mode === "idle" ? "—:——" : formatTime(elapsedSeconds)}
          </div>
          {reminderMessage ? (
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400 animate-pulse">
              {reminderMessage}
            </p>
          ) : nextActionSeconds !== null && nextActionSeconds > 0 ? (
            <p className="text-sm text-muted-foreground">
              {mode === "sitting" ? "Stand in " : "Sit in "}
              <span className="font-medium text-foreground">{formatTime(nextActionSeconds)}</span>
            </p>
          ) : null}
        </div>

        <div className="w-full max-w-xs space-y-4">
          {mode === "idle" ? (
            <Button
              size="lg"
              className="w-full h-14 text-base font-semibold rounded-2xl"
              onClick={() => switchMode("sitting")}
              disabled={isLoading}
            >
              Start Sitting
            </Button>
          ) : mode === "resting" ? (
            <div className="space-y-3">
              <Button
                size="lg"
                variant="default"
                className="w-full h-14 text-base font-semibold rounded-2xl"
                onClick={() => switchMode("sitting")}
                disabled={isLoading}
              >
                I'm Sitting
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="w-full h-14 text-base font-semibold rounded-2xl"
                onClick={() => switchMode("standing")}
                disabled={isLoading}
              >
                I'm Standing
              </Button>
            </div>
          ) : mode === "walking" ? (
            <div className="space-y-3">
              <Button
                size="lg"
                className="w-full h-14 text-base font-semibold rounded-2xl"
                onClick={() => switchMode("sitting")}
                disabled={isLoading}
              >
                I'm Sitting
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="w-full h-14 text-base font-semibold rounded-2xl"
                onClick={() => switchMode("standing")}
                disabled={isLoading}
              >
                I'm Standing
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="w-full h-12 text-sm font-medium rounded-2xl"
                onClick={() => switchMode("resting")}
                disabled={isLoading}
              >
                Rest / Sleep
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Button
                size="lg"
                className="w-full h-14 text-base font-semibold rounded-2xl"
                onClick={() => switchMode(mode === "sitting" ? "standing" : "sitting")}
                disabled={isLoading}
              >
                {mode === "sitting" ? "I'm Standing" : "I'm Sitting"}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="w-full h-12 text-sm font-medium rounded-2xl"
                onClick={() => switchMode("resting")}
                disabled={isLoading}
              >
                Rest / Sleep
              </Button>
            </div>
          )}
        </div>
      </main>

      <footer className="px-6 pb-24 space-y-4">
        {todayStats && (
          <div className="space-y-2">
            {(() => {
              const footerGoalMet = liveGoalPercent >= 100;
              return (
                <>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span
                      key={footerGoalMet ? "met" : "not-met"}
                      className={goalLabelClass(footerGoalMet, goalMetOnLoad)}
                    >
                      {footerGoalMet && (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
                        </svg>
                      )}
                      {footerGoalMet ? "Goal reached!" : "Standing goal"}
                    </span>
                    <span className={`font-medium transition-colors duration-500 ${footerGoalMet ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}>
                      {isActiveMode ? formatLiveElapsed(liveStandingTotalSeconds) : formatMinutes(completedStandingMinutes)} / {formatMinutes(todayStats.goalMinutes)}
                    </span>
                  </div>
                  <Progress
                    value={liveGoalPercent}
                    className={`h-2 transition-all duration-500 ${footerGoalMet ? "[&>div]:bg-emerald-500 dark:[&>div]:bg-emerald-400" : ""}`}
                  />
                </>
              );
            })()}
          </div>
        )}

        {todayStats && (
          <div className={`grid gap-3 ${todayStats.walkingMinutes > 0 ? "grid-cols-4" : "grid-cols-3"}`}>
            <StatCard
              label="Sitting"
              value={isActiveSitting ? formatLiveElapsed(liveSittingTotalSeconds) : formatMinutes(completedSittingMinutes)}
              color="text-amber-700 dark:text-amber-400"
            />
            <StatCard
              label="Standing"
              value={isActiveMode ? formatLiveElapsed(liveStandingTotalSeconds) : formatMinutes(completedStandingMinutes)}
              color="text-emerald-700 dark:text-emerald-400"
            />
            {todayStats.walkingMinutes > 0 && (
              <StatCard
                label="Walking"
                value={formatMinutes(todayStats.walkingMinutes)}
                color="text-teal-700 dark:text-teal-400"
              />
            )}
            <StatCard
              label="Streak"
              value={`${todayStats.currentStreak}d`}
              color="text-violet-700 dark:text-violet-400"
            />
          </div>
        )}
      </footer>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3 text-center">
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
