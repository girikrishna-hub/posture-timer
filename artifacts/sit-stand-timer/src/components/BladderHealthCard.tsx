import {
  useBladder,
  stabilityLabel,
  stabilityColor,
  type BladderGuidance,
} from "@/contexts/BladderContext";

// ─── Score ring ───────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const r = 28;
  const circumference = 2 * Math.PI * r;
  const filled = (score / 100) * circumference;
  const strokeColor =
    score >= 90
      ? "#10b981"
      : score >= 75
      ? "#3b82f6"
      : score >= 50
      ? "#f59e0b"
      : "#ef4444";

  return (
    <svg width="72" height="72" viewBox="0 0 72 72" className="shrink-0">
      <circle cx="36" cy="36" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke={strokeColor}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        strokeDashoffset={circumference / 4}
        style={{ transition: "stroke-dasharray 0.5s ease" }}
      />
      <text
        x="36"
        y="40"
        textAnchor="middle"
        fontSize="15"
        fontWeight="700"
        fill={strokeColor}
        fontFamily="inherit"
      >
        {score}
      </text>
    </svg>
  );
}

// ─── Guidance pill ────────────────────────────────────────────────────────────

function GuidancePill({ guidance }: { guidance: BladderGuidance }) {
  const styles: Record<BladderGuidance["action"], string> = {
    reduce:
      "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 text-red-800 dark:text-red-300",
    increase:
      "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300",
    maintain:
      "border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300",
  };

  const icons: Record<BladderGuidance["action"], string> = {
    reduce: "↓",
    increase: "↑",
    maintain: "→",
  };

  return (
    <div className={`rounded-xl border px-3 py-2.5 flex items-start gap-2 ${styles[guidance.action]}`}>
      <span className="text-base leading-none mt-0.5 shrink-0">{icons[guidance.action]}</span>
      <p className="text-xs font-medium leading-snug">{guidance.message}</p>
    </div>
  );
}

// ─── Main card ────────────────────────────────────────────────────────────────

export function BladderHealthCard() {
  const { todayAggregate, guidance, intervalMinutes } = useBladder();
  const { score, leakageCount, delayedCount, missedCount, maxSafeInterval } = todayAggregate;

  const label = stabilityLabel(score);
  const scoreColor = stabilityColor(score);
  const hasAnyActivity = leakageCount + delayedCount + missedCount > 0 || score < 100;

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Bladder Health</p>
          <p className="text-xs text-muted-foreground">Today's stability score</p>
        </div>
        <span className="text-xl">🩺</span>
      </div>

      {/* Score + stats row */}
      <div className="flex items-center gap-4">
        <ScoreRing score={score} />

        <div className="flex-1 min-w-0 space-y-2">
          {/* Label */}
          <div>
            <p className={`text-lg font-bold leading-none ${scoreColor}`}>{label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Stability score: {score}/100</p>
          </div>

          {/* Metric pills */}
          <div className="flex flex-wrap gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium ${leakageCount > 0 ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300" : "bg-muted/60 text-muted-foreground"}`}>
              ⚠ Leakage: {leakageCount}
            </span>
            <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium ${delayedCount > 0 ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300" : "bg-muted/60 text-muted-foreground"}`}>
              ⏱ Delays: {delayedCount}
            </span>
            {missedCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">
                ✗ Missed: {missedCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Max safe interval */}
      <div className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2.5">
        <div>
          <p className="text-xs text-muted-foreground">Max safe interval today</p>
          <p className="text-sm font-semibold text-foreground tabular-nums">
            {maxSafeInterval !== null ? `${maxSafeInterval} min` : "—"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Current interval</p>
          <p className="text-sm font-semibold text-foreground tabular-nums">{intervalMinutes} min</p>
        </div>
      </div>

      {/* Guidance */}
      {hasAnyActivity && <GuidancePill guidance={guidance} />}
    </div>
  );
}
