/**
 * BrowserRuntimeMonitor — detects WebView and Clerk runtime discontinuities.
 *
 * On Android, the WebView process can be partially or fully recreated without
 * the app being fully killed (renderer crash, low-memory reclaim of JS context).
 * When this happens:
 * - window.Clerk may become undefined or reload from scratch
 * - The ClerkRuntimeRegistry status transitions to UNAVAILABLE → RECREATED
 * - Any in-flight auth operations may have silently failed
 *
 * This monitor:
 * 1. Watches ClerkRuntimeRegistry status transitions for recreation events
 * 2. Listens for document visibility changes to detect WebView resume
 * 3. Checks Clerk session continuity on resume
 * 4. Notifies RuntimeCore when a discontinuity is detected so it can
 *    trigger recovery without silently using stale state
 *
 * It emits structured discontinuity events, not raw DOM events.
 */

import { ClerkRuntimeRegistry } from "./ClerkRuntimeRegistry";
import type { ClerkRuntimeStatus } from "./ClerkRuntimeRegistry";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";

export type DiscontinuityKind =
  | "CLERK_RECREATED"       // Clerk JS context was lost and re-initialized
  | "CLERK_TIMEOUT"         // Clerk never became available (CSP/network block)
  | "VISIBILITY_RESUME"     // Page became visible after being hidden
  | "RENDERER_SUSPECTED";   // Heuristic: Clerk unavailable on visibility resume

export interface RuntimeDiscontinuity {
  kind: DiscontinuityKind;
  detectedAt: number;
  clerkStatus: ClerkRuntimeStatus;
  message: string;
}

export type DiscontinuityHandler = (d: RuntimeDiscontinuity) => void;

export class BrowserRuntimeMonitor {
  private _handlers: Set<DiscontinuityHandler> = new Set();
  private _cleanups: Array<() => void> = [];
  private _wasHidden = false;
  private _lastClerkStatus: ClerkRuntimeStatus = "PENDING";

  constructor(private readonly _journal: AuthDiagnosticsJournal) {}

  /** Begin monitoring. Call once during runtime lifecycle attach. */
  attach(): void {
    // 1. Subscribe to ClerkRuntimeRegistry status changes
    const unsubClerk = ClerkRuntimeRegistry.instance.subscribe((status) => {
      this._onClerkStatusChange(status);
    });
    this._cleanups.push(unsubClerk);

    // 2. Listen for document visibility changes (WebView foreground/background)
    const onVisibility = () => this._onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibility);
    this._cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

    // 3. Listen for page show (BFCache restore)
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        this._emit({
          kind: "VISIBILITY_RESUME",
          detectedAt: Date.now(),
          clerkStatus: ClerkRuntimeRegistry.instance.status,
          message: "Page restored from BFCache — checking Clerk continuity",
        });
      }
    };
    window.addEventListener("pageshow", onPageShow as EventListener);
    this._cleanups.push(() =>
      window.removeEventListener("pageshow", onPageShow as EventListener)
    );
  }

  detach(): void {
    for (const fn of this._cleanups) { try { fn(); } catch { /* ignore */ } }
    this._cleanups = [];
  }

  onDiscontinuity(fn: DiscontinuityHandler): () => void {
    this._handlers.add(fn);
    return () => this._handlers.delete(fn);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _onClerkStatusChange(status: ClerkRuntimeStatus): void {
    const prev = this._lastClerkStatus;
    this._lastClerkStatus = status;

    if (status === "CLERK_RUNTIME_RECREATED") {
      this._journal.record("AUTH_DEGRADED",
        `Clerk runtime recreated (prev=${prev}) — signaling discontinuity`);
      this._emit({
        kind: "CLERK_RECREATED",
        detectedAt: Date.now(),
        clerkStatus: status,
        message: `Clerk JS was re-initialized (prev status: ${prev})`,
      });
    }

    if (status === "CLERK_RUNTIME_TIMEOUT") {
      this._journal.record("AUTH_DEGRADED",
        "Clerk runtime timed out — possible CSP block or network failure");
      this._emit({
        kind: "CLERK_TIMEOUT",
        detectedAt: Date.now(),
        clerkStatus: status,
        message: "Clerk SDK failed to load within timeout window",
      });
    }
  }

  private _onVisibilityChange(): void {
    const hidden = document.visibilityState === "hidden";

    if (hidden) {
      this._wasHidden = true;
      return;
    }

    if (!this._wasHidden) return;
    this._wasHidden = false;

    const clerkStatus = ClerkRuntimeRegistry.instance.status;

    // If Clerk was available before but isn't now → suspected renderer crash
    if (
      this._lastClerkStatus === "CLERK_RUNTIME_AVAILABLE" &&
      clerkStatus === "CLERK_RUNTIME_UNAVAILABLE"
    ) {
      this._journal.record("AUTH_DEGRADED",
        "Clerk unavailable after visibility resume — suspected renderer restart");
      this._emit({
        kind: "RENDERER_SUSPECTED",
        detectedAt: Date.now(),
        clerkStatus,
        message: "Clerk became unavailable between background and foreground — possible renderer crash",
      });
      return;
    }

    // Normal visibility resume — log without alarm
    this._journal.record("AUTH_RECOVERY_STARTED",
      `Visibility resume (clerkStatus=${clerkStatus})`);
    this._emit({
      kind: "VISIBILITY_RESUME",
      detectedAt: Date.now(),
      clerkStatus,
      message: `Page became visible (clerk=${clerkStatus})`,
    });
  }

  private _emit(d: RuntimeDiscontinuity): void {
    for (const h of this._handlers) {
      try { h(d); } catch { /* never propagate */ }
    }
  }
}
