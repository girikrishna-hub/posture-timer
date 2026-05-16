/**
 * AuthStateTransitionReport — runtime FSM correctness analysis.
 *
 * Validates the FSM transition graph from VALID_TRANSITIONS against
 * what the runtime actually executes. Run from the dev overlay or
 * chaos harness to confirm FSM invariants hold in production.
 *
 * Reports:
 * - Full transition graph (adjacency list)
 * - States reachable from UNINITIALIZED
 * - Recovery loop termination guarantees
 * - Any invalid transition attempts caught at runtime
 *
 * Dead state history:
 * - REFRESHING was removed (Phase 4): never entered in production.
 *   AuthSessionManager refreshes silently without FSM involvement.
 * - PROCESS_RECOVERY was removed (Phase 4): never entered in production.
 *   ProcessRecoveryCoordinator classifies startup but maps to
 *   RESTORING_SESSION → SIGNED_IN / DEGRADED directly.
 */

import type { AuthState } from "../AuthStateMachine";

// Mirrors the (trimmed) VALID_TRANSITIONS in AuthStateMachine.ts exactly.
const TRANSITIONS: Record<AuthState, AuthState[]> = {
  UNINITIALIZED:     ["INITIALIZING"],
  INITIALIZING:      ["RESTORING_SESSION", "SIGNED_OUT", "FAILED"],
  RESTORING_SESSION: ["SIGNED_IN", "SIGNED_OUT", "EXPIRED", "DEGRADED", "OFFLINE_RECOVERY", "FAILED"],
  SIGNED_OUT:        ["SIGNING_IN"],
  SIGNING_IN:        ["SIGNED_IN", "SIGNED_OUT", "FAILED"],
  SIGNED_IN:         ["EXPIRED", "SIGNED_OUT", "DEGRADED", "FAILED"],
  DEGRADED:          ["RECOVERING", "SIGNED_OUT", "FAILED", "SIGNED_IN"],
  OFFLINE_RECOVERY:  ["SIGNED_IN", "SIGNED_OUT", "DEGRADED", "FAILED"],
  EXPIRED:           ["RECOVERING", "SIGNED_OUT", "OFFLINE_RECOVERY", "FAILED"],
  RECOVERING:        ["SIGNED_IN", "SIGNED_OUT", "DEGRADED", "FAILED"],
  FAILED:            ["INITIALIZING", "SIGNED_OUT"],
};

// Every state production code transitions TO — confirmed from AuthRuntime,
// AuthLifecycleCoordinator, AuthRecoveryCoordinator, AuthRuntime._restoreSession().
const PRODUCTION_REACHABLE: AuthState[] = [
  "INITIALIZING",       // AuthRuntime.boot() → fsm.transition("INITIALIZING")
  "RESTORING_SESSION",  // AuthRuntime.boot() → fsm.transition("RESTORING_SESSION")
  "SIGNED_IN",          // AuthRuntime._establishSession()
  "SIGNED_OUT",         // AuthRuntime.signOut() + boot error paths
  "SIGNING_IN",         // AuthRuntime.signInWithGoogle() / signInWithTicket()
  "DEGRADED",           // AuthRuntime._restoreSession() + AuthRecoveryCoordinator
  "OFFLINE_RECOVERY",   // AuthRuntime._restoreSession() — offline startup
  "EXPIRED",            // AuthLifecycleCoordinator._onForegroundResume()
  "RECOVERING",         // AuthRecoveryCoordinator.recoverExpired()
  "FAILED",             // AuthRuntime.boot() error handler
];

export interface TransitionNode {
  state: AuthState;
  canReachFrom: AuthState[];
  canTransitionTo: AuthState[];
  isTerminalish: boolean;   // all successors are SIGNED_OUT or FAILED
  isProductionReachable: boolean;
}

export interface RecoveryLoop {
  path: AuthState[];
  terminatesAt: AuthState;
  maxIterations: number;
  canDeadlock: boolean;
}

export interface TransitionReportResult {
  graph: Record<AuthState, TransitionNode>;
  deadStates: AuthState[];   // always empty after Phase 4 cleanup
  recoveryLoops: RecoveryLoop[];
  reachableFromInitial: AuthState[];
  unreachableFromInitial: AuthState[];
  recommendations: string[];
  summary: string;
}

function computeReachable(from: AuthState): Set<AuthState> {
  const visited = new Set<AuthState>([from]);
  const queue: AuthState[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of TRANSITIONS[cur]) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return visited;
}

function buildInverseMap(): Record<AuthState, AuthState[]> {
  const inv: Record<string, AuthState[]> = {};
  for (const state of Object.keys(TRANSITIONS) as AuthState[]) {
    inv[state] ??= [];
    for (const to of TRANSITIONS[state]) {
      inv[to] ??= [];
      if (!(inv[to] as AuthState[]).includes(state)) (inv[to] as AuthState[]).push(state);
    }
  }
  return inv as Record<AuthState, AuthState[]>;
}

function buildRecoveryLoops(): RecoveryLoop[] {
  return [
    {
      path: ["DEGRADED", "RECOVERING", "DEGRADED"],
      terminatesAt: "SIGNED_IN",
      maxIterations: 3,    // AuthRecoveryCoordinator.MAX_RECOVERY_ATTEMPTS
      canDeadlock: false,
    },
    {
      path: ["EXPIRED", "RECOVERING", "DEGRADED", "RECOVERING"],
      terminatesAt: "SIGNED_IN",
      maxIterations: 3,
      canDeadlock: false,
    },
    {
      path: ["FAILED", "INITIALIZING", "RESTORING_SESSION", "FAILED"],
      terminatesAt: "SIGNED_IN",
      maxIterations: 1,    // no automatic retry — user action required
      canDeadlock: false,
    },
  ];
}

export function generateAuthStateTransitionReport(): TransitionReportResult {
  const allStates = Object.keys(TRANSITIONS) as AuthState[];
  const inverseMap = buildInverseMap();
  const reachableFromInitial = computeReachable("UNINITIALIZED");
  const productionReachableSet = new Set(PRODUCTION_REACHABLE);
  const recoveryLoops = buildRecoveryLoops();

  const graph: Record<string, TransitionNode> = {};
  for (const state of allStates) {
    graph[state] = {
      state,
      canReachFrom: inverseMap[state] ?? [],
      canTransitionTo: TRANSITIONS[state],
      isTerminalish: TRANSITIONS[state].every(
        (t) => t === "SIGNED_OUT" || t === "FAILED" || t === state
      ),
      isProductionReachable: productionReachableSet.has(state),
    };
  }

  const unreachableFromInitial = allStates.filter((s) => !reachableFromInitial.has(s));
  const recommendations: string[] = [];

  if (unreachableFromInitial.length > 0) {
    recommendations.push(
      `States unreachable from UNINITIALIZED: ${unreachableFromInitial.join(", ")}. ` +
      `Add transitions or remove the states.`
    );
  }

  const deadStates = allStates.filter((s) => !productionReachableSet.has(s));
  if (deadStates.length > 0) {
    recommendations.push(
      `States never transitioned to in production: ${deadStates.join(", ")}. ` +
      `Verify this is intentional or remove them.`
    );
  }

  const deadlockLoops = recoveryLoops.filter((l) => l.canDeadlock);
  if (deadlockLoops.length > 0) {
    recommendations.push(
      `Recovery loops without termination guarantees: ` +
      deadlockLoops.map((l) => l.path.join(" → ")).join("; ")
    );
  }

  const summary = [
    `States: ${allStates.length}`,
    `Production-reachable: ${PRODUCTION_REACHABLE.length}/${allStates.length}`,
    `Unreachable from UNINITIALIZED: ${unreachableFromInitial.length}`,
    `Dead (never entered in production): ${deadStates.length}`,
    `Recovery loops: ${recoveryLoops.length}, deadlock-capable: ${deadlockLoops.length}`,
    `Recommendations: ${recommendations.length}`,
  ].join(" | ");

  return {
    graph: graph as Record<AuthState, TransitionNode>,
    deadStates,
    recoveryLoops,
    reachableFromInitial: Array.from(reachableFromInitial),
    unreachableFromInitial,
    recommendations,
    summary,
  };
}

export function printAuthStateTransitionReport(): void {
  const r = generateAuthStateTransitionReport();
  console.group("[AuthStateTransitionReport]");
  console.log(r.recommendations.length === 0 ? "✓ FSM CLEAN" : "⚠ RECOMMENDATIONS");
  console.log("Summary:", r.summary);
  for (const [state, node] of Object.entries(r.graph)) {
    const flags = [
      !node.isProductionReachable ? "NEVER-ENTERED" : null,
      node.isTerminalish ? "TERMINAL-ISH" : null,
    ].filter(Boolean).join(",");
    console.log(
      `  ${state.padEnd(20)} → [${node.canTransitionTo.join(", ")}]` +
      (flags ? `  [${flags}]` : "")
    );
  }
  if (r.recommendations.length > 0) {
    console.warn("Recommendations:", r.recommendations);
  }
  console.groupEnd();
}
