import { fetchIntradaySteps, type StepMinute } from "./fitbitService";
import { deriveDriftSignal, type DriftSignal } from "./fitbitDrift";
import { logger } from "../lib/logger";

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const CACHE_WINDOW_MINUTES = 15;

interface CacheEntry {
  minutes: StepMinute[];
  fetchedAt: Date;
  signal: DriftSignal;
}

let cache: CacheEntry | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    const all = await fetchIntradaySteps();
    if (all.length === 0) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - CACHE_WINDOW_MINUTES * 60 * 1000);

    const todayPrefix = now.toTimeString().slice(0, 8).replace(/\d{2}$/, "00").slice(0, 5);
    void todayPrefix;

    const recent = all.filter((m) => {
      const [h, min] = m.time.split(":").map(Number);
      const minuteDate = new Date(now);
      minuteDate.setHours(h, min, 0, 0);
      return minuteDate >= cutoff;
    });

    cache = {
      minutes: recent,
      fetchedAt: now,
      signal: deriveDriftSignal(recent),
    };
  } catch (err) {
    logger.error({ err }, "Google Fit poll error");
  }
}

export function startFitbitPoller(): void {
  if (pollTimer) return;
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Google Fit poller started");
}

export function stopFitbitPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getCachedIntradayData(): CacheEntry | null {
  return cache;
}

export function triggerPoll(): void {
  void poll();
}
