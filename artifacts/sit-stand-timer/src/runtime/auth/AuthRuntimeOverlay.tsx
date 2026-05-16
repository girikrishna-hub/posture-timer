/**
 * AuthRuntimeOverlay — replaces NativeDebugPanel for auth diagnostics.
 *
 * Shows full RuntimeCore state: FSM, capabilities, session, journal events.
 * Only rendered on native builds (IS_NATIVE). Remove once auth is working.
 */

import { useState } from "react";
import { useAuthDiagnostics, useAuthRuntime } from "./useAuthRuntime";
import { IS_NATIVE } from "@/lib/nativeAuth";

declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;

function ts(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

const STATE_COLOR: Record<string, string> = {
  SIGNED_IN: "#4caf50",
  SIGNED_OUT: "#ff9800",
  FAILED: "#f44336",
  DEGRADED: "#ff9800",
  EXPIRED: "#f44336",
  OFFLINE_RECOVERY: "#ff9800",
  REFRESHING: "#2196f3",
  SIGNING_IN: "#2196f3",
  INITIALIZING: "#888",
  RESTORING_SESSION: "#888",
  RECOVERING: "#2196f3",
  PROCESS_RECOVERY: "#888",
  UNINITIALIZED: "#555",
};

const EVENT_COLOR: Record<string, string> = {
  AUTH_SIGN_IN_SUCCEEDED: "#4caf50",
  AUTH_SESSION_RESTORED: "#4caf50",
  AUTH_REFRESH_SUCCEEDED: "#4caf50",
  AUTH_BOOT_BARRIER_CLEARED: "#4caf50",
  AUTH_RECOVERY_COMPLETED: "#4caf50",
  AUTH_SIGN_IN_FAILED: "#f44336",
  AUTH_REFRESH_FAILED: "#f44336",
  AUTH_SIGN_OUT_COMPLETED: "#ff9800",
  AUTH_DEGRADED: "#ff9800",
  AUTH_EXPIRED: "#f44336",
  AUTH_ERROR: "#f44336",
  AUTH_STATE_TRANSITION: "#888",
  AUTH_INITIALIZED: "#2196f3",
};

export function AuthRuntimeOverlay() {
  const [open, setOpen] = useState(true);
  const diag = useAuthDiagnostics();
  const runtime = useAuthRuntime();

  const copyLog = () => {
    const lines = [
      `Built: ${__BUILD_TIME__}  Commit: ${__BUILD_COMMIT__}`,
      `FSM: ${diag.currentState}  Mode: ${diag.startupMode}`,
      `Session: user=${diag.sessionUserId ?? "none"}  ` +
        `expires=${diag.sessionExpiresAt ? new Date(diag.sessionExpiresAt).toISOString() : "—"}`,
      `Capability: ${diag.capability}  Restored: ${diag.isRestored}`,
      `RefreshFails: ${diag.refreshFailures}`,
      "",
      "--- AUTH EVENTS ---",
      ...diag.events.map((e) =>
        `${ts(e.timestamp)} [${e.kind}] ${e.message}` +
        (e.data ? ` ${JSON.stringify(e.data)}` : "")
      ).reverse(),
    ].join("\n");
    navigator.clipboard?.writeText(lines).catch(() => {});
  };

  const stateColor = STATE_COLOR[diag.currentState ?? ""] ?? "#ccc";

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999,
      background: "rgba(10,10,10,0.96)", color: "#eee",
      fontFamily: "monospace", fontSize: 11, userSelect: "text",
    }}>
      <div onClick={() => setOpen((o) => !o)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "5px 10px", borderTop: "2px solid #f44336",
        cursor: "pointer", background: "rgba(244,67,54,0.12)",
      }}>
        <span style={{ color: "#f44336", fontWeight: "bold" }}>
          ⚠ AUTH RUNTIME {open ? "▼" : "▲"}
        </span>
        <span style={{ color: stateColor }}>{diag.currentState ?? "—"}</span>
      </div>

      {open && (
        <div style={{ padding: "6px 10px", maxHeight: "60vh", overflowY: "auto" }}>

          {/* Build info */}
          <Row label="Built"   value={__BUILD_TIME__.slice(0, 19).replace("T", " ")} ok />
          <Row label="Commit"  value={__BUILD_COMMIT__} ok />
          <Row label="Native"  value={String(IS_NATIVE)} ok={IS_NATIVE} />

          <Sep />

          {/* FSM */}
          <Row label="FSM"     value={diag.currentState ?? "—"}
            style={{ color: stateColor }} />
          <Row label="Mode"    value={diag.startupMode ?? "—"} />
          <Row label="Restored" value={String(diag.isRestored)}
            ok={diag.isRestored} bad={!diag.isRestored} />

          <Sep />

          {/* Session */}
          <Row label="User"    value={diag.sessionUserId ?? "none"}
            ok={!!diag.sessionUserId} />
          <Row label="Expires" value={diag.sessionExpiresAt
            ? `${Math.round((diag.sessionExpiresAt - Date.now()) / 60000)}min`
            : "—"}
            ok={!!diag.sessionExpiresAt && diag.sessionExpiresAt > Date.now()} />
          <Row label="RefreshFails" value={String(diag.refreshFailures)}
            ok={diag.refreshFailures === 0}
            bad={diag.refreshFailures >= 2} />

          <Sep />

          {/* Capability */}
          <Row label="Capability" value={diag.capability}
            ok={diag.capability === "FULL"}
            warn={diag.capability === "DEGRADED" || diag.capability === "OFFLINE_ONLY"}
            bad={diag.capability === "UNAVAILABLE"} />
          <Row label="NativeGoogle" value={String(runtime.nativeGoogleAvailable)}
            ok={runtime.nativeGoogleAvailable} />

          <Sep />

          {/* Buttons */}
          <div style={{ display: "flex", gap: 6, margin: "6px 0", flexWrap: "wrap" }}>
            <Btn onClick={copyLog}>Copy Log</Btn>
          </div>

          {/* Journal events */}
          <div style={{ borderTop: "1px solid #222", paddingTop: 4 }}>
            {diag.events.map((e) => (
              <div key={e.id} style={{
                color: EVENT_COLOR[e.kind] ?? "#ccc",
                lineHeight: 1.5, wordBreak: "break-all",
              }}>
                <span style={{ color: "#444" }}>{ts(e.timestamp)} </span>
                <span style={{ color: "#666" }}>[{e.kind.replace("AUTH_", "")}] </span>
                {e.message}
                {e.data && (
                  <span style={{ color: "#555" }}>
                    {" "}{JSON.stringify(e.data).slice(0, 80)}
                  </span>
                )}
              </div>
            ))}
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
  return <div style={{ height: 1, background: "#222", margin: "3px 0" }} />;
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: "2px 8px", background: "#333", color: "#eee",
      border: "1px solid #555", borderRadius: 3,
      fontFamily: "monospace", fontSize: 10, cursor: "pointer",
    }}>
      {children}
    </button>
  );
}
