import { useTimer, type TimerMode } from "@/contexts/TimerContext";
import { useGetTodayStats, useGetSettings, getGetTodayStatsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEffect, useState } from "react";
import { useWalkingDetection } from "@/hooks/useWalkingDetection";

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

function getModeRingColor(mode: TimerMode): string {
  switch (mode) {
    case "sitting": return "ring-amber-200 dark:ring-amber-900 bg-amber-50 dark:bg-amber-950/40";
    case "standing": return "ring-emerald-200 dark:ring-emerald-900 bg-emerald-50 dark:bg-emerald-950/40";
    case "resting": return "ring-indigo-200 dark:ring-indigo-900 bg-indigo-50 dark:bg-indigo-950/40";
    case "walking": return "ring-teal-200 dark:ring-teal-900 bg-teal-50 dark:bg-teal-950/40";
    default: return "ring-border bg-card";
  }
}

export default function TimerPage() {
  const {
    mode,
    elapsedSeconds,
    reminderCount,
    inReminderPhase,
    isLoading,
    switchMode,
    endCurrentSession,
    requestNotificationPermission,
    notificationPermission,
  } = useTimer();

  const { canInstall, install } = useInstallPrompt();

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
  const autoDetectWalking = settingsData?.autoDetectWalking ??
    (() => { try { return localStorage.getItem("autoDetectWalking") === "true"; } catch { return false; } })();

  const gpsStatus = useWalkingDetection({
    enabled: autoDetectWalking,
    currentMode: mode,
    switchMode,
    endCurrentSession,
  });

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

  return (
    <div className="min-h-screen flex flex-col bg-background">
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
        <button
          onClick={() => window.location.href = "/settings"}
          className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-lg hover:bg-muted"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        <div className={`relative flex flex-col items-center justify-center w-56 h-56 rounded-full ring-8 transition-all duration-700 ${getModeRingColor(mode)}`}>
          <div className={`transition-colors duration-500 ${getModeColor(mode)}`}>
            <ModeIcon mode={mode} />
          </div>
          <span className={`text-sm font-semibold tracking-widest uppercase mt-1 transition-colors duration-500 ${getModeColor(mode)}`}>
            {getModeLabel(mode)}
          </span>
        </div>

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
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Standing goal</span>
              <span className="font-medium text-foreground">
                {formatMinutes(todayStats.standingMinutes)} / {formatMinutes(todayStats.goalMinutes)}
              </span>
            </div>
            <Progress value={todayStats.goalProgressPercent} className="h-2" />
          </div>
        )}

        {todayStats && (
          <div className={`grid gap-3 ${todayStats.walkingMinutes > 0 ? "grid-cols-4" : "grid-cols-3"}`}>
            <StatCard
              label="Sitting"
              value={formatMinutes(todayStats.sittingMinutes)}
              color="text-amber-700 dark:text-amber-400"
            />
            <StatCard
              label="Standing"
              value={formatMinutes(todayStats.standingMinutes)}
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
