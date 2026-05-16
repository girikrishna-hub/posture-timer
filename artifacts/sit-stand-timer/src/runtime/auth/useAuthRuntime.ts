/**
 * useAuthRuntime — React observation hooks for AuthRuntime state.
 *
 * React OBSERVES; it does not own. All mutations go through AuthRuntime methods.
 * These hooks re-render only when the relevant slice of state changes.
 */

import { useState, useEffect, useCallback } from "react";
import { AuthRuntime } from "./AuthRuntime";
import type { AuthStoreState } from "./AuthStateStore";
import type { AuthStateSnapshot } from "./AuthStateMachine";
import type { DiagnosticsSnapshot } from "./AuthDiagnosticsJournal";
import type { CapabilitySnapshot } from "./AuthCapabilityRegistry";
import type { AuthConfidenceLevel } from "./AuthConfidenceLevel";
import type { BootBarrierSnapshot } from "./RuntimeBootBarrier";

export interface AuthRuntimeState {
  /** True once session restoration has completed (success or failure) */
  isRestored: boolean;
  /** True if a valid session exists */
  isAuthenticated: boolean;
  /** The current user ID, or null */
  userId: string | null;
  /** Current JWT for API calls, or null */
  jwt: string | null;
  /** FSM state name */
  fsmState: AuthStateSnapshot["state"];
  /** How trustworthy the current session is */
  confidence: AuthConfidenceLevel;
  /** Human-readable degradation reason, if any */
  degradationReason: string | null;
  /** Capability level */
  capability: AuthStoreState["capability"];
  /** Whether native Google Sign-In is available */
  nativeGoogleAvailable: boolean;
}

/** Full auth state for the current session */
export function useAuthRuntime(): AuthRuntimeState {
  const runtime = AuthRuntime.instance;
  const [store, setStore] = useState<AuthStoreState>(() => runtime.store.state);
  const [fsmSnap, setFsmSnap] = useState<AuthStateSnapshot>(() => runtime.fsm.snapshot);
  const [caps, setCaps] = useState<CapabilitySnapshot>(() => runtime.capabilities.snapshot);

  useEffect(() => {
    const u1 = runtime.store.subscribe(setStore);
    const u2 = runtime.fsm.subscribe(setFsmSnap);
    const u3 = runtime.capabilities.subscribe(setCaps);
    return () => { u1(); u2(); u3(); };
  }, [runtime]);

  return {
    isRestored: store.isRestored,
    isAuthenticated: store.session !== null,
    userId: store.session?.userId ?? null,
    jwt: store.session?.jwt ?? null,
    fsmState: fsmSnap.state,
    confidence: store.confidence,
    degradationReason: store.degradationReason,
    capability: store.capability,
    nativeGoogleAvailable: caps.nativeSignInAvailable,
  };
}

/** Auth actions — sign in, sign out */
export function useAuthActions() {
  const runtime = AuthRuntime.instance;
  const signInWithGoogle = useCallback(() => runtime.signInWithGoogle(), [runtime]);
  const signInWithTicket = useCallback((ticket: string) =>
    runtime.signInWithTicket(ticket), [runtime]);
  const signOut = useCallback(() => runtime.signOut(), [runtime]);
  return { signInWithGoogle, signInWithTicket, signOut };
}

/** Boot barrier state */
export function useBootBarrier(): { isCleared: boolean; timedOut: boolean; phase: BootBarrierSnapshot["phase"] } {
  const runtime = AuthRuntime.instance;
  const [snap, setSnap] = useState(() => runtime.bootBarrier.snapshot);
  useEffect(() => runtime.bootBarrier.subscribe(setSnap), [runtime]);
  return { isCleared: snap.phase !== "WAITING", timedOut: snap.timedOut, phase: snap.phase };
}

/** Diagnostics journal — for the debug overlay */
export function useAuthDiagnostics(): DiagnosticsSnapshot {
  const runtime = AuthRuntime.instance;
  const [snap, setSnap] = useState<DiagnosticsSnapshot>(
    () => runtime.journal.snapshot,
  );
  useEffect(() => runtime.journal.subscribe(setSnap), [runtime]);
  return snap;
}
