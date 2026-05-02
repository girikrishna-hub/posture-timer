import { useEffect, useRef, useState } from "react";
import type { NudgeState } from "@/hooks/useFitbitDrift";

interface NudgeModalProps {
  nudge: NudgeState | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const MODE_LABELS: Record<string, string> = {
  sitting: "Sitting",
  standing: "Standing",
  walking: "Walking",
  resting: "Resting",
};

const MODE_COLORS: Record<string, string> = {
  sitting: "bg-amber-500",
  standing: "bg-emerald-500",
  walking: "bg-teal-500",
};

export function NudgeModal({ nudge, onConfirm, onCancel }: NudgeModalProps) {
  const [remaining, setRemaining] = useState(nudge?.countdownSeconds ?? 0);
  const remainingRef = useRef(remaining);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => { onConfirmRef.current = onConfirm; }, [onConfirm]);

  useEffect(() => {
    if (!nudge) {
      setRemaining(0);
      remainingRef.current = 0;
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    setRemaining(nudge.countdownSeconds);
    remainingRef.current = nudge.countdownSeconds;

    timerRef.current = setInterval(() => {
      const next = remainingRef.current - 1;
      remainingRef.current = next;
      setRemaining(next);
      if (next <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        onConfirmRef.current();
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [nudge]);

  if (!nudge) return null;

  const accentClass = MODE_COLORS[nudge.toMode] ?? "bg-emerald-500";
  const targetLabel = MODE_LABELS[nudge.toMode] ?? nudge.toMode;
  const pct = nudge.countdownSeconds > 0
    ? (remaining / nudge.countdownSeconds) * 100
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-6"
      role="dialog"
      aria-modal="true"
      aria-label="Fitbit activity nudge"
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative w-full max-w-sm bg-card rounded-2xl shadow-2xl border border-border overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
        <div className={`h-1 ${accentClass} transition-all duration-1000`} style={{ width: `${pct}%` }} />

        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full ${accentClass} flex items-center justify-center flex-shrink-0 text-white text-lg`}>
              {nudge.toMode === "sitting" ? "🪑" : nudge.toMode === "walking" ? "🚶" : "🧍"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground text-sm leading-tight">
                Switch to {targetLabel}?
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{nudge.reason}</p>
            </div>
            <span className="text-2xl font-mono font-bold tabular-nums text-muted-foreground flex-shrink-0">
              {remaining}s
            </span>
          </div>

          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
            >
              Stay {MODE_LABELS[nudge.fromMode] ?? nudge.fromMode}
            </button>
            <button
              onClick={onConfirm}
              className={`flex-1 py-2.5 rounded-xl text-white text-sm font-semibold ${accentClass} hover:opacity-90 transition-opacity`}
            >
              Switch to {targetLabel}
            </button>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Auto-switching in {remaining}s · Powered by Google Fit
          </p>
        </div>
      </div>
    </div>
  );
}
