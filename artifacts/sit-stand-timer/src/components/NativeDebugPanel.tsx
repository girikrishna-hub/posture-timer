/**
 * NativeDebugPanel — TEMPORARY DIAGNOSTIC OVERLAY
 *
 * Only rendered on Capacitor native builds (IS_NATIVE = true).
 * Shows Clerk auth state, token retrieval, and API base URL so we can
 * identify exactly where the Android startup auth flow breaks down.
 *
 * REMOVE THIS COMPONENT (and its usage in App.tsx) once the root
 * cause is identified and fixed.
 */
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/react";
import { IS_NATIVE } from "@/lib/nativeAuth";
import { Capacitor } from "@capacitor/core";

type TokenStatus = "idle" | "testing" | "ok" | "null" | "error";

interface LogEntry {
  time: string;
  msg: string;
  kind: "info" | "ok" | "warn" | "error";
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function NativeDebugPanel() {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  const [open, setOpen] = useState(true);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>("idle");
  const [tokenPreview, setTokenPreview] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);

  const addLog = useCallback((msg: string, kind: LogEntry["kind"] = "info") => {
    const entry: LogEntry = { time: ts(), msg, kind };
    // Always echo to native console for logcat capture
    const consoleFn = kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
    consoleFn(`[NativeDebug ${entry.time}] ${msg}`);
    setLog((prev) => [entry, ...prev].slice(0, 40));
  }, []);

  // Log every change in Clerk state
  useEffect(() => {
    addLog(`Clerk isLoaded=${isLoaded} isSignedIn=${isSignedIn} userId=${userId ?? "none"}`, "info");
  }, [isLoaded, isSignedIn, userId, addLog]);

  const testToken = useCallback(async () => {
    setTokenStatus("testing");
    addLog("Calling getToken()…", "info");
    try {
      const t = await getToken();
      if (t) {
        const preview = `${t.slice(0, 24)}…`;
        setTokenStatus("ok");
        setTokenPreview(preview);
        addLog(`getToken() → OK (${preview})`, "ok");
      } else {
        setTokenStatus("null");
        setTokenPreview("");
        addLog("getToken() → null (not signed in or token expired)", "warn");
      }
    } catch (err) {
      setTokenStatus("error");
      setTokenPreview("");
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`getToken() threw: ${msg}`, "error");
      console.error("[NativeDebug] getToken error:", err);
    }
  }, [getToken, addLog]);

  // Auto-test as soon as Clerk finishes loading
  useEffect(() => {
    if (isLoaded) {
      addLog("Clerk finished loading — auto-testing token", "info");
      testToken();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "(not set — will use relative URLs)";
  const platform = Capacitor.getPlatform();

  const statusColor: Record<TokenStatus, string> = {
    idle:    "#888",
    testing: "#f0c040",
    ok:      "#4caf50",
    null:    "#ff9800",
    error:   "#f44336",
  };

  const logColor: Record<LogEntry["kind"], string> = {
    info:  "#ccc",
    ok:    "#4caf50",
    warn:  "#ff9800",
    error: "#f44336",
  };

  return (
    <div
      style={{
        position:   "fixed",
        bottom:     0,
        left:       0,
        right:      0,
        zIndex:     99999,
        background: "rgba(10,10,10,0.93)",
        color:      "#eee",
        fontFamily: "monospace",
        fontSize:   12,
        userSelect: "text",
      }}
    >
      {/* Header / toggle bar */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          padding:        "6px 10px",
          borderTop:      "2px solid #f44336",
          cursor:         "pointer",
          background:     "rgba(244,67,54,0.15)",
        }}
      >
        <span style={{ color: "#f44336", fontWeight: "bold" }}>
          ⚠ NATIVE DEBUG {open ? "▼" : "▲"}
        </span>
        <span style={{ color: statusColor[tokenStatus] }}>
          token:{tokenStatus}
        </span>
      </div>

      {open && (
        <div style={{ padding: "8px 10px", maxHeight: "45vh", overflowY: "auto" }}>

          {/* Static config */}
          <div style={{ marginBottom: 6, lineHeight: 1.7 }}>
            <Row label="Platform"   value={platform}                     ok={IS_NATIVE} />
            <Row label="IS_NATIVE"  value={String(IS_NATIVE)}            ok={IS_NATIVE} />
            <Row label="API base"   value={apiBase}                      ok={apiBase !== "(not set — will use relative URLs)"} />
            <Row label="Clerk key"  value={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ? import.meta.env.VITE_CLERK_PUBLISHABLE_KEY.slice(0, 20) + "…" : "(none)"} />
            <Row label="Proxy URL"  value={(import.meta.env.VITE_CLERK_PROXY_URL as string | undefined) ?? "(none — direct)"} ok={!!(import.meta.env.VITE_CLERK_PROXY_URL as string | undefined)} />
          </div>

          {/* Auth state */}
          <div style={{ marginBottom: 6, lineHeight: 1.7 }}>
            <Row label="isLoaded"   value={String(isLoaded)}   ok={isLoaded} />
            <Row label="isSignedIn" value={String(isSignedIn)} ok={!!isSignedIn} />
            <Row label="userId"     value={userId ?? "none"}   ok={!!userId} />
          </div>

          {/* Token */}
          <div style={{ marginBottom: 8, lineHeight: 1.7 }}>
            <Row
              label="Token status"
              value={tokenStatus + (tokenPreview ? ` — ${tokenPreview}` : "")}
              ok={tokenStatus === "ok"}
              warn={tokenStatus === "null" || tokenStatus === "testing"}
              bad={tokenStatus === "error"}
            />
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <Btn onClick={testToken} disabled={tokenStatus === "testing"}>
              {tokenStatus === "testing" ? "Testing…" : "Test Token"}
            </Btn>
            <Btn onClick={() => setLog([])}>Clear Log</Btn>
          </div>

          {/* Log */}
          {log.length > 0 && (
            <div>
              {log.map((entry, i) => (
                <div key={i} style={{ color: logColor[entry.kind], lineHeight: 1.5 }}>
                  <span style={{ color: "#666" }}>{entry.time} </span>
                  {entry.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── tiny helpers ─────────────────────────────────────────────────────────────

function Row({
  label,
  value,
  ok,
  warn,
  bad,
}: {
  label: string;
  value: string;
  ok?: boolean;
  warn?: boolean;
  bad?: boolean;
}) {
  const color = bad ? "#f44336" : warn ? "#ff9800" : ok ? "#4caf50" : "#ccc";
  return (
    <div>
      <span style={{ color: "#666", width: 90, display: "inline-block" }}>{label}:</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

function Btn({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding:         "3px 10px",
        background:      disabled ? "#333" : "#444",
        color:           disabled ? "#666" : "#eee",
        border:          "1px solid #666",
        borderRadius:    4,
        fontFamily:      "monospace",
        fontSize:        11,
        cursor:          disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
