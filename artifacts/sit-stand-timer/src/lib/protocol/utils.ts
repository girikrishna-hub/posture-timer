/**
 * Protocol Extension Utilities
 *
 * Pure, side-effect-free helper functions for use in protocol contexts.
 *
 * IMPORTANT: This file must never import from TimerContext or BladderContext.
 * It is intentionally standalone so future protocols depend only on this file
 * and the browser / Capacitor APIs.
 *
 * TimerContext and BladderContext have their own private copies of some of
 * these helpers.  Those copies are left untouched — new protocols simply use
 * these shared versions instead.
 */

// ─── Date / time helpers ─────────────────────────────────────────────────────

/** Returns "YYYY-MM-DD" for today in local time. */
export function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Parse "HH:MM" into minutes-since-midnight. */
export function parseTimeHHMM(s: string): number {
  const [hStr = "0", mStr = "0"] = s.split(":");
  return parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
}

/**
 * Returns true when epoch-ms `ms` falls inside the [start, end) window.
 * The window may span midnight (e.g. "22:00" → "07:00").
 */
export function isInTimeWindow(ms: number, start: string, end: string): boolean {
  const d = new Date(ms);
  const minOfDay = d.getHours() * 60 + d.getMinutes();
  const startMin = parseTimeHHMM(start);
  const endMin   = parseTimeHHMM(end);
  if (startMin >= endMin) {
    // Spans midnight: inside window when >= start OR < end
    return minOfDay >= startMin || minOfDay < endMin;
  }
  return minOfDay >= startMin && minOfDay < endMin;
}

/**
 * Returns the epoch-ms of the next occurrence of `endTime` ("HH:MM") at or
 * after `afterMs`.  Used to find the next wake time after a quiet-hours window.
 */
export function nextOccurrenceMs(afterMs: number, timeHHMM: string): number {
  const [hStr = "0", mStr = "0"] = timeHHMM.split(":");
  const d = new Date(afterMs);
  d.setHours(parseInt(hStr, 10), parseInt(mStr, 10), 0, 0);
  if (d.getTime() <= afterMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ─── localStorage helpers ────────────────────────────────────────────────────

/**
 * Factory that returns typed localStorage helpers for a single JSON blob.
 *
 * Usage:
 *   const store = makeStorageHelpers<MyState>("protocol:ice-therapy:state", defaultState);
 *   store.load()    // → MyState
 *   store.save(s)   // persists
 *   store.clear()   // removes key
 */
export function makeStorageHelpers<T>(key: string, defaultValue: T) {
  return {
    load(): T {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : defaultValue;
      } catch {
        return defaultValue;
      }
    },
    save(value: T): void {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch { /* quota exceeded or storage disabled — silently ignore */ }
    },
    clear(): void {
      try {
        localStorage.removeItem(key);
      } catch { /* ignore */ }
    },
  };
}

// ─── Notification helpers ────────────────────────────────────────────────────

/**
 * Show a browser notification immediately via the service worker.
 * Silently ignored if permission is not granted or the SW is unavailable.
 *
 * @param tag  Should be unique per protocol so notifications don't collide.
 */
export function showNotificationNow(
  title: string,
  body: string,
  tag = "protocol-timer",
): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) =>
      reg.showNotification(title, {
        body,
        icon: "/favicon.svg",
        badge: "/favicon.svg",
        tag,
        renotify: true,
        data: { url: "/" },
      } as NotificationOptions),
    )
    .catch(() => { /* SW notification unavailable */ });
}

/**
 * Tell the service worker to fire a notification after `delayMs` milliseconds,
 * even if the page is backgrounded or throttled.
 *
 * The SW's existing SCHEDULE_NOTIFICATION handler processes this message.
 * Each protocol should pass a distinct `tag` so cancellations are scoped.
 */
export function scheduleSWNotification(opts: {
  delayMs: number;
  title: string;
  body: string;
  tag?: string;
}): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => {
      reg.active?.postMessage({
        type: "SCHEDULE_NOTIFICATION",
        delayMs: opts.delayMs,
        title: opts.title,
        body: opts.body,
        tag: opts.tag ?? "protocol-timer",
      });
    })
    .catch(() => { /* SW unavailable */ });
}

/**
 * Cancel a pending scheduled notification in the service worker.
 * Call this whenever the protocol is toggled off or the phase changes early.
 */
export function cancelSWNotification(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => {
      reg.active?.postMessage({ type: "CANCEL_SCHEDULED_NOTIFICATION" });
    })
    .catch(() => { /* SW unavailable */ });
}

// ─── Timer math ──────────────────────────────────────────────────────────────

/**
 * Compute remaining milliseconds until `targetMs`.
 * Returns 0 if the target is in the past.
 */
export function remainingMs(targetMs: number): number {
  return Math.max(0, targetMs - Date.now());
}

/**
 * Compute the target epoch-ms given a duration in minutes starting now.
 */
export function targetMsFromNow(durationMinutes: number): number {
  return Date.now() + durationMinutes * 60 * 1000;
}
