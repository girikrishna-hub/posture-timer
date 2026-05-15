/**
 * NativeDebugPanel — TEMPORARY DIAGNOSTIC OVERLAY
 *
 * Only rendered on Capacitor native builds (IS_NATIVE = true).
 * v4: exposes the three Clerk init-chain checkpoints that reveal exactly
 *     where IsomorphicClerk.getEntryChunks() stalls:
 *
 *   1. window.Clerk exists    — clerk.browser.js script loaded & executed
 *   2. window.Clerk.loaded    — clerk.load() (FAPI init) succeeded
 *   3. window.__internal_ClerkUICtor — ui.browser.js script loaded & executed
 *
 *   If (1) is true but (2) and (3) stay false after ~15 s, the UI bundle
 *   failed to load — the server-side followRedirects fix should resolve it.
 *
 * Also intercepts window.fetch (for Clerk FAPI / jsDelivr calls) and
 * captures window.onerror / unhandledrejection.
 *
 * REMOVE THIS COMPONENT (and its usage in App.tsx) once auth is working.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@clerk/react";
import { IS_NATIVE } from "@/lib/nativeAuth";
import {
  NATIVE_CLERK_PUBLISHABLE_KEY,
  NATIVE_CLERK_PROXY_URL,
} from "@/lib/nativeConfig";
import { Capacitor } from "@capacitor/core";

type TokenStatus = "idle" | "testing" | "ok" | "null" | "error";

interface LogEntry {
  time: string;
  msg: string;
  kind: "info" | "ok" | "warn" | "error";
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

// ── global fetch interceptor ──────────────────────────────────────────────────
// Installed once at module level so it captures requests before React mounts.
type NetLog = (msg: string, kind: LogEntry["kind"]) => void;
let _netLog: NetLog = () => {};

const INTERESTING = ["__clerk", "clerk.dev", "clerk.io", "clerk.com", "jsdelivr"];

function isInteresting(url: string): boolean {
  const u = url.toLowerCase();
  return INTERESTING.some((s) => u.includes(s));
}

const _origFetch = window.fetch.bind(window);
window.fetch = async function interceptedFetch(input, init) {
  const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
  if (isInteresting(url)) {
    _netLog(`→ fetch ${url.slice(0, 80)}`, "info");
  }
  try {
    const res = await _origFetch(input, init);
    if (isInteresting(url)) {
      const kind = res.ok ? "ok" : "warn";
      _netLog(`← ${res.status} ${url.slice(0, 70)}`, kind);
    }
    return res;
  } catch (err) {
    if (isInteresting(url)) {
      const msg = err instanceof Error ? err.message : String(err);
      _netLog(`✗ fetch ERR ${url.slice(0, 60)}: ${msg}`, "error");
    }
    throw err;
  }
} as typeof window.fetch;

// ── helpers to read Clerk global init-chain state ────────────────────────────
function getClerkGlobals() {
  const w = window as unknown as Record<string, unknown>;
  const clerkExists = !!w["Clerk"];
  const clerkLoaded = !!(w["Clerk"] as { loaded?: boolean } | undefined)?.loaded;
  const uiCtorExists = !!w["__internal_ClerkUICtor"];
  return { clerkExists, clerkLoaded, uiCtorExists };
}

// ── component ─────────────────────────────────────────────────────────────────

export function NativeDebugPanel() {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  const [open, setOpen] = useState(true);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>("idle");
  const [tokenPreview, setTokenPreview] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const addLogRef = useRef<NetLog>(() => {});

  // Clerk init-chain checkpoint state (polled every 500 ms)
  const [clerkExists, setClerkExists] = useState(false);
  const [clerkLoaded, setClerkLoaded] = useState(false);
  const [uiCtorExists, setUiCtorExists] = useState(false);
  const prevGlobals = useRef({ clerkExists: false, clerkLoaded: false, uiCtorExists: false });

  const addLog = useCallback((msg: string, kind: LogEntry["kind"] = "info") => {
    const entry: LogEntry = { time: ts(), msg, kind };
    const consoleFn = kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
    consoleFn(`[NativeDebug ${entry.time}] ${msg}`);
    setLog((prev) => [entry, ...prev].slice(0, 60));
  }, []);

  // wire the global interceptor to our state
  useEffect(() => {
    addLogRef.current = addLog;
    _netLog = (msg, kind) => addLogRef.current(msg, kind);
    return () => { _netLog = () => {}; };
  }, [addLog]);

  // capture global JS errors and unhandled rejections
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      addLog(`window.onerror: ${e.message} @ ${e.filename?.slice(-40)}:${e.lineno}`, "error");
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
      addLog(`unhandledRejection: ${msg}`, "error");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [addLog]);

  // poll Clerk global init-chain checkpoints every 500 ms
  useEffect(() => {
    const poll = () => {
      const next = getClerkGlobals();
      const prev = prevGlobals.current;

      if (next.clerkExists !== prev.clerkExists) {
        setClerkExists(next.clerkExists);
        addLog(
          next.clerkExists
            ? "✓ window.Clerk set — clerk.browser.js loaded & executed"
            : "✗ window.Clerk cleared",
          next.clerkExists ? "ok" : "warn",
        );
      }
      if (next.clerkLoaded !== prev.clerkLoaded) {
        setClerkLoaded(next.clerkLoaded);
        addLog(
          next.clerkLoaded
            ? "✓ window.Clerk.loaded=true — clerk.load() / FAPI init succeeded"
            : "✗ window.Clerk.loaded=false",
          next.clerkLoaded ? "ok" : "warn",
        );
      }
      if (next.uiCtorExists !== prev.uiCtorExists) {
        setUiCtorExists(next.uiCtorExists);
        addLog(
          next.uiCtorExists
            ? "✓ __internal_ClerkUICtor set — ui.browser.js loaded & executed"
            : "✗ __internal_ClerkUICtor cleared",
          next.uiCtorExists ? "ok" : "warn",
        );
      }

      prevGlobals.current = next;
    };

    // immediate check + periodic poll
    poll();
    const id = setInterval(poll, 500);
    return () => clearInterval(id);
  }, [addLog]);

  // log Clerk React hook state changes
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
        addLog("getToken() → null (not signed in)", "warn");
      }
    } catch (err) {
      setTokenStatus("error");
      setTokenPreview("");
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`getToken() threw: ${msg}`, "error");
    }
  }, [getToken, addLog]);

  useEffect(() => {
    if (isLoaded) {
      addLog("Clerk finished loading — auto-testing token", "info");
      testToken();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "(not set)";
  const platform = Capacitor.getPlatform();

  const statusColor: Record<TokenStatus, string> = {
    idle: "#888", testing: "#f0c040", ok: "#4caf50", null: "#ff9800", error: "#f44336",
  };
  const logColor: Record<LogEntry["kind"], string> = {
    info: "#ccc", ok: "#4caf50", warn: "#ff9800", error: "#f44336",
  };

  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999,
      background: "rgba(10,10,10,0.95)", color: "#eee", fontFamily: "monospace",
      fontSize: 11, userSelect: "text" }}>

      <div onClick={() => setOpen((o) => !o)} style={{ display: "flex",
        alignItems: "center", justifyContent: "space-between", padding: "5px 10px",
        borderTop: "2px solid #f44336", cursor: "pointer",
        background: "rgba(244,67,54,0.15)" }}>
        <span style={{ color: "#f44336", fontWeight: "bold" }}>
          ⚠ NATIVE DEBUG {open ? "▼" : "▲"}
        </span>
        <span style={{ color: statusColor[tokenStatus] }}>token:{tokenStatus}</span>
      </div>

      {open && (
        <div style={{ padding: "6px 10px", maxHeight: "55vh", overflowY: "auto" }}>

          {/* Static build info */}
          <div style={{ marginBottom: 5, lineHeight: 1.6 }}>
            <Row label="Platform"   value={platform}    ok={IS_NATIVE} />
            <Row label="IS_NATIVE"  value={String(IS_NATIVE)} ok={IS_NATIVE} />
            <Row label="API base"   value={apiBase}     ok={apiBase !== "(not set)"} />
            <Row label="Clerk key"  value={NATIVE_CLERK_PUBLISHABLE_KEY.slice(0, 20) + "…"} ok />
            <Row label="Proxy URL"  value={NATIVE_CLERK_PROXY_URL} ok />
            <Row label="Bundle URL" value={IS_NATIVE ? "jsdelivr/clerk-js@6.10.1" : "(default)"} ok={IS_NATIVE} />
          </div>

          {/* Clerk init-chain checkpoints */}
          <div style={{ marginBottom: 5, lineHeight: 1.6,
            borderTop: "1px solid #333", paddingTop: 4 }}>
            <div style={{ color: "#666", fontSize: 10, marginBottom: 2 }}>
              CLERK INIT CHAIN (step 1→2→3 must all be ✓ before React isLoaded)
            </div>
            <Row label="1 clerk.js"  value={clerkExists  ? "✓ window.Clerk set"       : "✗ not yet"}
              ok={clerkExists}  bad={!clerkExists} />
            <Row label="2 FAPI init" value={clerkLoaded  ? "✓ Clerk.loaded=true"       : "✗ not yet"}
              ok={clerkLoaded}  bad={clerkExists && !clerkLoaded} />
            <Row label="3 ui.js"     value={uiCtorExists ? "✓ __internal_ClerkUICtor"  : "✗ not yet"}
              ok={uiCtorExists} bad={clerkExists && !uiCtorExists} />
          </div>

          {/* React hook state */}
          <div style={{ marginBottom: 5, lineHeight: 1.6 }}>
            <Row label="isLoaded"   value={String(isLoaded)}   ok={isLoaded} />
            <Row label="isSignedIn" value={String(isSignedIn)} ok={!!isSignedIn} />
            <Row label="userId"     value={userId ?? "none"}   ok={!!userId} />
          </div>

          <div style={{ marginBottom: 6, lineHeight: 1.6 }}>
            <Row label="Token" value={tokenStatus + (tokenPreview ? ` — ${tokenPreview}` : "")}
              ok={tokenStatus === "ok"} warn={tokenStatus === "null" || tokenStatus === "testing"}
              bad={tokenStatus === "error"} />
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <Btn onClick={testToken} disabled={tokenStatus === "testing"}>
              {tokenStatus === "testing" ? "Testing…" : "Test Token"}
            </Btn>
            <Btn onClick={() => setLog([])}>Clear Log</Btn>
          </div>

          {log.length > 0 && (
            <div>
              {log.map((entry, i) => (
                <div key={i} style={{ color: logColor[entry.kind], lineHeight: 1.45,
                  wordBreak: "break-all" }}>
                  <span style={{ color: "#555" }}>{entry.time} </span>
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

function Row({ label, value, ok, warn, bad }: {
  label: string; value: string; ok?: boolean; warn?: boolean; bad?: boolean;
}) {
  const color = bad ? "#f44336" : warn ? "#ff9800" : ok ? "#4caf50" : "#ccc";
  return (
    <div>
      <span style={{ color: "#555", width: 80, display: "inline-block" }}>{label}:</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

function Btn({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "2px 8px", background: disabled ? "#333" : "#444",
      color: disabled ? "#666" : "#eee", border: "1px solid #666",
      borderRadius: 3, fontFamily: "monospace", fontSize: 10,
      cursor: disabled ? "not-allowed" : "pointer",
    }}>
      {children}
    </button>
  );
}
