/**
 * AuthTraceVisualizer — builds structured timelines from AuthDiagnosticsJournal events.
 *
 * Transforms the flat event log into a set of reconstructed operation timelines:
 * - Boot restoration flow
 * - Sign-in flows
 * - Refresh chains (with retry lineage)
 * - Lifecycle recoveries
 * - Process recovery events
 * - Degraded recovery attempts
 *
 * Used by AuthRuntimeOverlay for human-readable auth failure debugging.
 * The visualizer is stateless — call buildTimeline() with any snapshot.
 */

import type { DiagnosticsSnapshot, AuthEvent } from "./AuthDiagnosticsJournal";

export type TimelineEntryKind =
  | "BOOT"
  | "SIGN_IN"
  | "SIGN_OUT"
  | "REFRESH"
  | "LIFECYCLE"
  | "RECOVERY"
  | "DEGRADATION"
  | "TRANSITION"
  | "ERROR";

export interface TimelineEntry {
  id: number;
  kind: TimelineEntryKind;
  timestamp: number;
  relativeMs: number;      // ms since first event in the timeline
  label: string;
  detail: string;
  outcome: "OK" | "WARN" | "ERROR" | "INFO";
  durationMs?: number;     // set when this entry closes a span
}

export interface TraceTimeline {
  entries: TimelineEntry[];
  bootDurationMs: number | null;
  lastSignInAt: number | null;
  lastRefreshAt: number | null;
  lastFailureAt: number | null;
  totalRefreshCount: number;
  totalFailureCount: number;
  lifecycleEventCount: number;
}

function outcome(kind: string): TimelineEntry["outcome"] {
  if (kind.includes("FAILED") || kind.includes("ERROR") || kind.includes("EXPIRED")) return "ERROR";
  if (kind.includes("DEGRADED") || kind.includes("TIMEOUT")) return "WARN";
  if (kind.includes("SUCCEEDED") || kind.includes("RESTORED") || kind.includes("CLEARED")) return "OK";
  return "INFO";
}

function entryKind(eventKind: string): TimelineEntryKind {
  if (eventKind.includes("BOOT") || eventKind === "AUTH_INITIALIZED") return "BOOT";
  if (eventKind.includes("SIGN_IN")) return "SIGN_IN";
  if (eventKind.includes("SIGN_OUT")) return "SIGN_OUT";
  if (eventKind.includes("REFRESH")) return "REFRESH";
  if (eventKind.includes("RECOVERY")) return "RECOVERY";
  if (eventKind.includes("DEGRADED")) return "DEGRADATION";
  if (eventKind.includes("TRANSITION")) return "TRANSITION";
  if (eventKind.includes("ERROR") || eventKind.includes("EXPIRED")) return "ERROR";
  if (eventKind.includes("RECOVERY_STARTED") || eventKind.includes("SESSION_RESTORED")) return "LIFECYCLE";
  return "INFO" as TimelineEntryKind;
}

function shortLabel(event: AuthEvent): string {
  return event.kind.replace("AUTH_", "").replace(/_/g, " ").toLowerCase();
}

/** Build a timeline from a diagnostics snapshot (newest-first events). */
export function buildTimeline(snap: DiagnosticsSnapshot): TraceTimeline {
  // Events are stored newest-first; reverse for chronological order
  const events = [...snap.events].reverse();

  if (events.length === 0) {
    return {
      entries: [],
      bootDurationMs: null,
      lastSignInAt: null,
      lastRefreshAt: null,
      lastFailureAt: null,
      totalRefreshCount: 0,
      totalFailureCount: 0,
      lifecycleEventCount: 0,
    };
  }

  const baseTs = events[0].timestamp;

  const entries: TimelineEntry[] = events.map((e) => ({
    id: e.id,
    kind: entryKind(e.kind),
    timestamp: e.timestamp,
    relativeMs: e.timestamp - baseTs,
    label: shortLabel(e),
    detail: e.message,
    outcome: outcome(e.kind),
  }));

  // Compute span durations for boot
  let bootStart: number | null = null;
  let bootEnd: number | null = null;
  let lastSignInAt: number | null = null;
  let lastRefreshAt: number | null = null;
  let lastFailureAt: number | null = null;
  let totalRefreshCount = 0;
  let totalFailureCount = 0;
  let lifecycleEventCount = 0;

  for (const e of events) {
    if (e.kind === "AUTH_INITIALIZED") bootStart = e.timestamp;
    if (e.kind === "AUTH_BOOT_BARRIER_CLEARED") bootEnd = e.timestamp;
    if (e.kind === "AUTH_SIGN_IN_SUCCEEDED") lastSignInAt = e.timestamp;
    if (e.kind === "AUTH_REFRESH_SUCCEEDED") { lastRefreshAt = e.timestamp; totalRefreshCount++; }
    if (e.kind === "AUTH_REFRESH_STARTED") totalRefreshCount++;
    if (e.kind.includes("FAILED") || e.kind.includes("ERROR")) {
      lastFailureAt = e.timestamp;
      totalFailureCount++;
    }
    if (e.kind === "AUTH_RECOVERY_STARTED") lifecycleEventCount++;
  }

  // Annotate boot span duration
  if (bootStart !== null && bootEnd !== null) {
    for (const entry of entries) {
      if (entry.timestamp === bootEnd && entry.kind === "BOOT") {
        entry.durationMs = bootEnd - bootStart;
        break;
      }
    }
  }

  return {
    entries: entries.reverse(), // return newest-first for overlay display
    bootDurationMs: bootStart !== null && bootEnd !== null ? bootEnd - bootStart : null,
    lastSignInAt,
    lastRefreshAt,
    lastFailureAt,
    totalRefreshCount: Math.floor(totalRefreshCount / 2), // started + succeeded pairs
    totalFailureCount,
    lifecycleEventCount,
  };
}

/** Render a single timeline entry as a compact one-line string for the copy log. */
export function renderEntry(e: TimelineEntry): string {
  const ts = new Date(e.timestamp).toISOString().slice(11, 23);
  const dur = e.durationMs !== undefined ? ` [${e.durationMs}ms]` : "";
  return `${ts} [${e.kind}] ${e.label}${dur}: ${e.detail}`;
}
