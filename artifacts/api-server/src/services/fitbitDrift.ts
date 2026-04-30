import { type StepMinute } from "./fitbitService";

export type DriftSignal = "sitting" | "standing" | "walking" | "unknown";

export interface DriftAssessment {
  signal: DriftSignal;
  zeroStepDuration: number;
  avgStepsLast3Min: number;
  walkingConsecutiveMinutes: number;
}

const WALKING_THRESHOLD = 30;
const STANDING_LOWER = 2;
const SITTING_ZERO_MINUTES = 8;
const WALKING_TRIGGER_MINUTES = 2;
const AVG_WINDOW_MINUTES = 3;

export function deriveDriftSignal(minutes: StepMinute[]): DriftSignal {
  if (minutes.length === 0) return "unknown";

  const last3 = minutes.slice(-AVG_WINDOW_MINUTES);
  const avg =
    last3.reduce((sum, m) => sum + m.steps, 0) / Math.max(last3.length, 1);

  if (avg >= WALKING_THRESHOLD) return "walking";
  if (avg >= STANDING_LOWER) return "standing";
  return "sitting";
}

export function assessDrift(minutes: StepMinute[]): DriftAssessment {
  const signal = deriveDriftSignal(minutes);

  let zeroStepDuration = 0;
  for (let i = minutes.length - 1; i >= 0; i--) {
    if (minutes[i].steps === 0) {
      zeroStepDuration++;
    } else {
      break;
    }
  }

  const last3 = minutes.slice(-AVG_WINDOW_MINUTES);
  const avgStepsLast3Min =
    last3.reduce((sum, m) => sum + m.steps, 0) / Math.max(last3.length, 1);

  let walkingConsecutiveMinutes = 0;
  for (let i = minutes.length - 1; i >= 0; i--) {
    if (minutes[i].steps >= WALKING_THRESHOLD) {
      walkingConsecutiveMinutes++;
    } else {
      break;
    }
  }

  return {
    signal,
    zeroStepDuration,
    avgStepsLast3Min,
    walkingConsecutiveMinutes,
  };
}

export interface DriftAction {
  type: "nudge" | "auto_switch" | "none";
  toMode?: "sitting" | "standing" | "walking";
  countdownSeconds?: number;
  reason?: string;
}

export function evaluateDrift(
  currentMode: string,
  assessment: DriftAssessment,
): DriftAction {
  if (currentMode === "standing") {
    if (assessment.zeroStepDuration >= SITTING_ZERO_MINUTES) {
      return {
        type: "nudge",
        toMode: "sitting",
        countdownSeconds: 15,
        reason: "No movement detected for 8 minutes",
      };
    }
  }

  if (currentMode === "sitting") {
    if (
      assessment.avgStepsLast3Min >= 5 &&
      assessment.walkingConsecutiveMinutes >= AVG_WINDOW_MINUTES
    ) {
      return {
        type: "nudge",
        toMode: "standing",
        countdownSeconds: 10,
        reason: "Activity detected for 3 consecutive minutes",
      };
    }
  }

  if (
    currentMode !== "walking" &&
    assessment.walkingConsecutiveMinutes >= WALKING_TRIGGER_MINUTES &&
    assessment.avgStepsLast3Min >= WALKING_THRESHOLD
  ) {
    return {
      type: "auto_switch",
      toMode: "walking",
      reason: "Walking detected",
    };
  }

  return { type: "none" };
}
