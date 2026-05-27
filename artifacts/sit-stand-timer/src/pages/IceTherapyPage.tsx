import { useEffect, useState } from "react";
import { useIceTherapy, type IcePhase } from "@/contexts/IceTherapyContext";

// ─── Countdown ───────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function useCountdown(target: Date | null, pausedMs: number | null): string {
  const [label, setLabel] = useState("—");

  useEffect(() => {
    if (pausedMs !== null) { setLabel(formatMs(pausedMs)); return; }
    if (!target) { setLabel("—"); return; }
    const tick = () => setLabel(formatMs(target.getTime() - Date.now()));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [target, pausedMs]);

  return label;
}

// ─── Theme helpers ───────────────────────────────────────────────────────────

function phaseTheme(phase: IcePhase) {
  if (phase === "cool") {
    return {
      border:   "border-cyan-300 dark:border-cyan-700",
      bg:       "bg-cyan-50 dark:bg-cyan-950/30",
      label:    "text-cyan-700 dark:text-cyan-400",
      timer:    "text-cyan-600 dark:text-cyan-300",
      dot:      "bg-cyan-500",
    };
  }
  if (phase === "rest") {
    return {
      border:   "border-amber-300 dark:border-amber-700",
      bg:       "bg-amber-50 dark:bg-amber-950/30",
      label:    "text-amber-700 dark:text-amber-400",
      timer:    "text-amber-600 dark:text-amber-300",
      dot:      "bg-amber-500",
    };
  }
  return {
    border:   "border-border",
    bg:       "bg-card",
    label:    "text-muted-foreground",
    timer:    "text-muted-foreground",
    dot:      "bg-muted",
  };
}

function phaseLabel(phase: IcePhase): string {
  if (phase === "cool") return "🧊 ICE ON";
  if (phase === "rest") return "♻️ REST";
  return "Not started";
}

// ─── Button ──────────────────────────────────────────────────────────────────

function Btn({
  onClick,
  variant = "default",
  children,
  disabled,
}: {
  onClick: () => void;
  variant?: "default" | "danger" | "ghost";
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const base = "rounded-xl font-semibold py-3.5 text-sm transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none";
  const styles = {
    default: "bg-foreground text-background hover:opacity-90",
    danger:  "bg-red-500 text-white hover:bg-red-600",
    ghost:   "border border-border bg-muted/40 text-foreground hover:bg-muted",
  };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${styles[variant]}`}>
      {children}
    </button>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function IceTherapyPage() {
  const {
    phase,
    isRunning,
    isPaused,
    cycleCount,
    nextTransitionAt,
    pausedRemainingMs,
    start,
    pause,
    resume,
    skip,
    stop,
  } = useIceTherapy();

  const countdown = useCountdown(isRunning ? nextTransitionAt : null, isPaused ? pausedRemainingMs : null);
  const theme = phaseTheme(phase);
  const isActive = phase !== "idle";

  const nextPhaseLabel = phase === "cool" ? "REST" : phase === "rest" ? "ICE ON" : "";

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-2">
        <span className="text-xl">🧊</span>
        <h1 className="text-base font-semibold text-foreground">Ice Therapy</h1>
        {isRunning && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Active
          </span>
        )}
        {isPaused && (
          <span className="ml-auto text-xs text-amber-600 dark:text-amber-400 font-medium">Paused</span>
        )}
      </div>

      <div className="px-4 pt-5 space-y-4 max-w-lg mx-auto">

        {/* Phase card */}
        <div className={`rounded-2xl border-2 ${theme.border} ${theme.bg} px-5 py-6 text-center space-y-3`}>
          <p className={`text-lg font-bold tracking-wide ${theme.label}`}>
            {phaseLabel(phase)}
          </p>

          <p className={`text-6xl font-bold tabular-nums leading-none ${theme.timer}`}>
            {isActive ? countdown : "20:00"}
          </p>

          {isActive && nextTransitionAt && isRunning && (
            <p className="text-xs text-muted-foreground">
              → {nextPhaseLabel} at{" "}
              {nextTransitionAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}

          {isPaused && (
            <p className="text-xs text-muted-foreground">Paused — {countdown} remaining</p>
          )}

          {!isActive && (
            <p className="text-xs text-muted-foreground">
              20 min Ice On · 20 min Rest · repeating
            </p>
          )}
        </div>

        {/* Cycle counter */}
        {isActive && (
          <div className="rounded-2xl border border-border bg-card px-5 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Cycles completed</p>
              <p className="text-xs text-muted-foreground">Ice applications finished</p>
            </div>
            <p className="text-3xl font-bold tabular-nums text-foreground">{cycleCount}</p>
          </div>
        )}

        {/* Controls */}
        <div className="space-y-3">
          {/* Idle: only Start */}
          {!isActive && (
            <Btn onClick={start} variant="default">
              Start Ice Therapy
            </Btn>
          )}

          {/* Running: Pause + Skip */}
          {isRunning && (
            <div className="grid grid-cols-2 gap-3">
              <Btn onClick={pause} variant="ghost">⏸ Pause</Btn>
              <Btn onClick={skip} variant="ghost">⏭ Skip to {nextPhaseLabel}</Btn>
            </div>
          )}

          {/* Paused: Resume + Skip */}
          {isPaused && (
            <div className="grid grid-cols-2 gap-3">
              <Btn onClick={resume} variant="default">▶ Resume</Btn>
              <Btn onClick={skip} variant="ghost">⏭ Skip to {nextPhaseLabel}</Btn>
            </div>
          )}

          {/* Active (running or paused): Stop */}
          {isActive && (
            <Btn onClick={stop} variant="danger">■ Stop Session</Btn>
          )}
        </div>

        {/* Info card */}
        {!isActive && (
          <div className="rounded-2xl border border-border bg-card px-5 py-4 space-y-2">
            <p className="text-sm font-medium text-foreground">How it works</p>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-500 shrink-0" />
                <span>ICE ON — apply ice pack for 20 minutes</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                <span>REST — remove pack, let skin warm for 20 minutes</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-muted shrink-0" />
                <span>Repeats automatically with lock-screen alerts</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
