/**
 * AuthRuntimeOverlay — full runtime observability console for auth debugging.
 *
 * Phase 3 expansion: now functions as a complete runtime observability console.
 *
 * Panels:
 *   Build info — version, commit, native flag
 *   FSM state — current state, startup mode, boot phase
 *   Session — user, expiry, refresh failures, confidence
 *   Capability — auth + Clerk runtime status
 *   Time — clock drift, trustworthiness, suspend count
 *   Process recovery — startup kind, recovery assessment
 *   Refresh chain — active chain status, attempt count, suspend count
 *   Offline policy — what's enabled at current confidence level
 *   Timeline — last 10 auth events (compact)
 *
 * Only rendered on native builds (IS_NATIVE). Remove once auth is stable.
 */

import { useState, useEffect } from "react";
import { useAuthDiagnostics, useAuthRuntime, useBootBarrier } from "./useAuthRuntime";
import { AuthRuntime } from "./AuthRuntime";
import { ClerkRuntimeRegistry } from "./ClerkRuntimeRegistry";
import { TimeAuthority } from "./TimeAuthority";
import { buildTimeline } from "./AuthTraceVisualizer";
import { capabilityFor } from "./OfflineCapabilityMatrix";
import type { RefreshChain } from "./RefreshChainCoordinator";
import type { ClerkRuntimeStatus } from "./ClerkRuntimeRegistry";
import { IS_NATIVE } from "@/lib/nativeAuth";

declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;

function ts(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

const STATE_COLOR: Record<string, string> = {
  SIGNED_IN: "#4caf50", SIGNED_OUT: "#ff9800", FAILED: "#f44336",
  DEGRADED: "#ff9800", EXPIRED: "#f44336", OFFLINE_RECOVERY: "#ff9800",
  REFRESHING: "#2196f3", SIGNING_IN: "#2196f3", INITIALIZING: "#888",
  RESTORING_SESSION: "#888", RECOVERING: "#2196f3", PROCESS_RECOVERY: "#888",
  UNINITIALIZED: "#555",
};

const EVENT_COLOR: Record<string, string> = {
  AUTH_SIGN_IN_SUCCEEDED: "#4caf50", AUTH_SESSION_RESTORED: "#4caf50",
  AUTH_REFRESH_SUCCEEDED: "#4caf50", AUTH_BOOT_BARRIER_CLEARED: "#4caf50",
  AUTH_RECOVERY_COMPLETED: "#4caf50", AUTH_SIGN_IN_FAILED: "#f44336",
  AUTH_REFRESH_FAILED: "#f44336", AUTH_SIGN_OUT_COMPLETED: "#ff9800",
  AUTH_DEGRADED: "#ff9800", AUTH_EXPIRED: "#f44336", AUTH_ERROR: "#f44336",
  AUTH_STATE_TRANSITION: "#888", AUTH_INITIALIZED: "#2196f3",
};

const CLERK_STATUS_COLOR: Record<ClerkRuntimeStatus, string> = {
  PENDING: "#888",
  CLERK_RUNTIME_AVAILABLE: "#4caf50",
  CLERK_RUNTIME_DELAYED: "#ff9800",
  CLERK_RUNTIME_TIMEOUT: "#f44336",
  CLERK_RUNTIME_UNAVAILABLE: "#f44336",
  CLERK_RUNTIME_RECREATED: "#ff9800",
};

export function AuthRuntimeOverlay() {
  // Production lockdown: tree-shaken out by Vite in production builds.
  // IS_NATIVE alone is insufficient — also require DEV build.
  if (!import.meta.env.DEV) return null;

  const [open, setOpen] = useState(true);
  const [panel, setPanel] = useState<"main" | "timeline" | "offline">("main");
  const diag = useAuthDiagnostics();
  const runtime = useAuthRuntime();
  const { phase: bootPhase } = useBootBarrier();

  const [clerkStatus, setClerkStatus] = useState<ClerkRuntimeStatus>(
    () => ClerkRuntimeRegistry.instance.status
  );
  const [timeSnap, setTimeSnap] = useState(
    () => TimeAuthority.instance.snapshot
  );
  const [activeChain, setActiveChain] = useState<RefreshChain | null>(
    () => AuthRuntime.instance.refreshChains.activeChain
  );
  const [recoveryKind] = useState(
    () => AuthRuntime.instance.recoveryKind ?? AuthRuntime.instance.processRecovery.detectStartupKind()
  );

  useEffect(() => {
    const unsub = ClerkRuntimeRegistry.instance.subscribe(setClerkStatus);
    const tick = setInterval(() => {
      setTimeSnap(TimeAuthority.instance.snapshot);
      setActiveChain(AuthRuntime.instance.refreshChains.activeChain);
    }, 5_000);
    return () => { unsub(); clearInterval(tick); };
  }, []);

  const caps = capabilityFor(runtime.confidence);
  const timeline = buildTimeline(diag);
  const stateColor = STATE_COLOR[diag.currentState ?? ""] ?? "#ccc";

  const copyLog = () => {
    const timeS = timeSnap;
    const lines = [
      `Built: ${__BUILD_TIME__}  Commit: ${__BUILD_COMMIT__}`,
      `FSM: ${diag.currentState}  Mode: ${diag.startupMode}  Boot: ${bootPhase}`,
      `Session: user=${diag.sessionUserId ?? "none"}  ` +
        `expires=${diag.sessionExpiresAt ? new Date(diag.sessionExpiresAt).toISOString() : "—"}`,
      `Confidence: ${runtime.confidence}  Capability: ${diag.capability}  Restored: ${diag.isRestored}`,
      `RefreshFails: ${diag.refreshFailures}`,
      `Clerk: ${clerkStatus}`,
      `Clock: drift=${Math.round(timeS.clockDriftMs)}ms trustworthy=${timeS.isTrustworthy} suspends=${timeS.suspendCount}`,
      `Recovery: kind=${recoveryKind}`,
      `ActiveChain: ${activeChain ? `${activeChain.chainId} attempts=${activeChain.attemptCount} suspends=${activeChain.suspendCount}` : "none"}`,
      `Boot: duration=${timeline.bootDurationMs != null ? `${timeline.bootDurationMs}ms` : "—"}`,
      "",
      "--- AUTH EVENTS ---",
      ...diag.events.map((e) =>
        `${ts(e.timestamp)} [${e.kind}] ${e.message}` +
        (e.data ? ` ${JSON.stringify(e.data)}` : "")
      ).reverse(),
    ].join("\n");
    navigator.clipboard?.writeText(lines).catch(() => {});
  };

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999,
      background: "rgba(10,10,10,0.97)", color: "#eee",
      fontFamily: "monospace", fontSize: 11, userSelect: "text",
    }}>
      {/* Header bar */}
      <div onClick={() => setOpen((o) => !o)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "4px 10px", borderTop: "2px solid #f44336",
        cursor: "pointer", background: "rgba(244,67,54,0.12)",
      }}>
        <span style={{ color: "#f44336", fontWeight: "bold" }}>
          ⚠ AUTH RUNTIME {open ? "▼" : "▲"}
        </span>
        <span style={{ color: stateColor }}>{diag.currentState ?? "—"}</span>
        <span style={{ color: CLERK_STATUS_COLOR[clerkStatus] ?? "#888", fontSize: 10 }}>
          clerk:{clerkStatus.replace("CLERK_RUNTIME_", "").toLowerCase()}
        </span>
      </div>

      {open && (
        <div style={{ maxHeight: "65vh", overflowY: "auto" }}>
          {/* Panel switcher */}
          <div style={{ display: "flex", gap: 4, padding: "3px 8px", borderBottom: "1px solid #222" }}>
            {(["main", "timeline", "offline"] as const).map((p) => (
              <Btn key={p} onClick={() => setPanel(p)} style={panel === p ? { background: "#444" } : {}}>
                {p}
              </Btn>
            ))}
            <Btn onClick={copyLog}>copy log</Btn>
          </div>

          <div style={{ padding: "4px 10px" }}>
            {panel === "main" && (
              <>
                {/* Build */}
                <Row label="Built"   value={__BUILD_TIME__.slice(0, 19).replace("T", " ")} ok />
                <Row label="Commit"  value={__BUILD_COMMIT__.slice(0, 8)} ok />
                <Row label="Native"  value={String(IS_NATIVE)} ok={IS_NATIVE} />
                <Sep />

                {/* FSM */}
                <Row label="FSM"     value={diag.currentState ?? "—"} style={{ color: stateColor }} />
                <Row label="Mode"    value={diag.startupMode ?? "—"} />
                <Row label="Boot"    value={bootPhase}
                  ok={bootPhase === "AUTHENTICATED"}
                  warn={bootPhase === "DEGRADED" || bootPhase === "OFFLINE_RECOVERY"}
                  bad={bootPhase === "FAILED"} />
                <Row label="Restored" value={String(diag.isRestored)}
                  ok={diag.isRestored} bad={!diag.isRestored} />
                <Sep />

                {/* Session */}
                <Row label="User"    value={diag.sessionUserId ?? "none"} ok={!!diag.sessionUserId} />
                <Row label="Expires" value={diag.sessionExpiresAt
                  ? `${Math.round((diag.sessionExpiresAt - Date.now()) / 60000)}min`
                  : "—"}
                  ok={!!diag.sessionExpiresAt && diag.sessionExpiresAt > Date.now()}
                  bad={!diag.sessionExpiresAt || diag.sessionExpiresAt <= Date.now()} />
                <Row label="Conf"    value={runtime.confidence}
                  ok={runtime.confidence === "VERIFIED" || runtime.confidence === "RECOVERED"}
                  warn={runtime.confidence === "DEGRADED" || runtime.confidence === "OFFLINE_ONLY"}
                  bad={runtime.confidence === "INVALID"} />
                <Row label="RefFails" value={String(diag.refreshFailures)}
                  ok={diag.refreshFailures === 0} bad={diag.refreshFailures >= 2} />
                <Sep />

                {/* Capabilities */}
                <Row label="AuthCap" value={diag.capability}
                  ok={diag.capability === "FULL"}
                  warn={diag.capability === "DEGRADED" || diag.capability === "OFFLINE_ONLY"}
                  bad={diag.capability === "UNAVAILABLE"} />
                <Row label="Clerk"   value={clerkStatus.replace("CLERK_RUNTIME_", "")}
                  ok={clerkStatus === "CLERK_RUNTIME_AVAILABLE"}
                  warn={clerkStatus === "CLERK_RUNTIME_DELAYED" || clerkStatus === "CLERK_RUNTIME_RECREATED"}
                  bad={clerkStatus === "CLERK_RUNTIME_TIMEOUT" || clerkStatus === "CLERK_RUNTIME_UNAVAILABLE"} />
                <Row label="Google"  value={String(runtime.nativeGoogleAvailable)} ok={runtime.nativeGoogleAvailable} />
                <Sep />

                {/* Clock */}
                <Row label="Drift"   value={`${Math.round(timeSnap.clockDriftMs)}ms`}
                  ok={Math.abs(timeSnap.clockDriftMs) < 30_000}
                  warn={Math.abs(timeSnap.clockDriftMs) >= 30_000}
                  bad={!timeSnap.isTrustworthy} />
                <Row label="Suspends" value={String(timeSnap.suspendCount)} ok />
                <Row label="SuspendMs" value={`${Math.round(timeSnap.suspendDurationMs / 1000)}s`} ok />
                <Sep />

                {/* Process recovery */}
                <Row label="StartKind" value={recoveryKind} ok />
                <Sep />

                {/* Active refresh chain */}
                <Row label="Chain"  value={activeChain ? activeChain.chainId.slice(-8) : "none"}
                  ok={!activeChain || activeChain.outcome === "SUCCEEDED"}
                  warn={activeChain?.outcome === "PENDING" && (activeChain?.retryCount ?? 0) > 0} />
                {activeChain && (
                  <>
                    <Row label="ChAttempts" value={String(activeChain.attemptCount)} />
                    <Row label="ChSuspends" value={String(activeChain.suspendCount)} />
                    <Row label="ChOutcome"  value={activeChain.outcome}
                      ok={activeChain.outcome === "SUCCEEDED"}
                      bad={activeChain.outcome === "FAILED" || activeChain.outcome === "EXPIRED"} />
                  </>
                )}
                <Sep />

                {/* Boot duration */}
                {timeline.bootDurationMs !== null && (
                  <Row label="BootMs"  value={`${timeline.bootDurationMs}ms`}
                    ok={timeline.bootDurationMs < 3000} warn={timeline.bootDurationMs >= 3000} />
                )}
                <Row label="Refreshes" value={String(timeline.totalRefreshCount)} ok />
                <Row label="Failures"  value={String(timeline.totalFailureCount)}
                  ok={timeline.totalFailureCount === 0} bad={timeline.totalFailureCount > 0} />
              </>
            )}

            {panel === "timeline" && (
              <div>
                {timeline.entries.slice(0, 20).map((e) => (
                  <div key={e.id} style={{
                    color: e.outcome === "ERROR" ? "#f44336"
                      : e.outcome === "WARN" ? "#ff9800"
                      : e.outcome === "OK" ? "#4caf50" : "#888",
                    lineHeight: 1.5, wordBreak: "break-all",
                  }}>
                    <span style={{ color: "#444" }}>{ts(e.timestamp)} </span>
                    <span style={{ color: "#666" }}>[{e.kind}] </span>
                    <span style={{ color: "#aaa" }}>{e.label} </span>
                    {e.durationMs !== undefined && (
                      <span style={{ color: "#2196f3" }}>({e.durationMs}ms) </span>
                    )}
                    {e.detail}
                  </div>
                ))}
              </div>
            )}

            {panel === "offline" && (
              <div>
                <div style={{ color: "#888", marginBottom: 4 }}>
                  Offline capability matrix @ {runtime.confidence}
                </div>
                {Object.entries(caps).map(([k, v]) => (
                  <Row key={k} label={k} value={v ? "✓" : "✗"} ok={v} bad={!v} />
                ))}
              </div>
            )}

            {/* Journal events (always visible at bottom in main panel) */}
            {panel === "main" && (
              <div style={{ borderTop: "1px solid #222", paddingTop: 4, marginTop: 2 }}>
                {diag.events.slice(0, 15).map((e) => (
                  <div key={e.id} style={{
                    color: EVENT_COLOR[e.kind] ?? "#ccc",
                    lineHeight: 1.5, wordBreak: "break-all",
                  }}>
                    <span style={{ color: "#444" }}>{ts(e.timestamp)} </span>
                    <span style={{ color: "#666" }}>[{e.kind.replace("AUTH_", "")}] </span>
                    {e.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, ok, warn, bad, style: extraStyle }: {
  label: string; value: string; ok?: boolean; warn?: boolean;
  bad?: boolean; style?: React.CSSProperties;
}) {
  const color = bad ? "#f44336" : warn ? "#ff9800" : ok ? "#4caf50" : "#ccc";
  return (
    <div style={{ lineHeight: 1.6 }}>
      <span style={{ color: "#555", width: 88, display: "inline-block" }}>{label}:</span>
      <span style={{ color, ...extraStyle }}>{value}</span>
    </div>
  );
}

function Sep() {
  return <div style={{ height: 1, background: "#222", margin: "2px 0" }} />;
}

function Btn({ onClick, children, style }: {
  onClick: () => void; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} style={{
      padding: "1px 6px", background: "#333", color: "#eee",
      border: "1px solid #555", borderRadius: 3,
      fontFamily: "monospace", fontSize: 10, cursor: "pointer",
      ...style,
    }}>
      {children}
    </button>
  );
}
