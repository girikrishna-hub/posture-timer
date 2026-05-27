/**
 * Protocol Extension Type Contracts
 *
 * These interfaces define the shape every independent protocol context must
 * follow. They are documentation + compile-time guardrails only — they do not
 * contain any runtime logic.
 *
 * See ADDING_PROTOCOLS.md for step-by-step implementation instructions.
 */

// ─── Static protocol definition ─────────────────────────────────────────────

/**
 * Immutable description of a two-state alternating protocol.
 * Define one of these per protocol (ice therapy, medication cycle, etc.).
 */
export interface ProtocolDef {
  /** Unique machine-readable identifier, e.g. "ice-therapy" */
  id: string;
  /** Human-readable display name, e.g. "Ice Therapy" */
  name: string;
  /** Phase A: the "active" phase (ice on, medication taken, etc.) */
  phaseA: ProtocolPhaseConfig;
  /** Phase B: the "recovery / wait" phase (ice off, wait between doses, etc.) */
  phaseB: ProtocolPhaseConfig;
}

export interface ProtocolPhaseConfig {
  /** Display label shown in the UI, e.g. "Ice On" */
  label: string;
  /** Emoji representing the phase, e.g. "🧊" */
  icon: string;
  /**
   * Tailwind utility class for the phase's accent colour.
   * Use a single colour name, e.g. "blue", then apply as bg-blue-500 etc.
   */
  colorClass: string;
  /** Default timer duration in minutes */
  defaultDurationMinutes: number;
  /** Notification fired when the timer transitions INTO this phase */
  notification: {
    title: string;
    body: string;
  };
}

// ─── Runtime phase type ──────────────────────────────────────────────────────

/**
 * Generic phase discriminator.  Each protocol narrows this to its own union:
 *   type IcePhase = "cool" | "rest" | "idle";
 *   type MedPhase = "active" | "waiting" | "idle";
 */
export type ProtocolPhase = "A" | "B" | "idle";

// ─── Context value contract ──────────────────────────────────────────────────

/**
 * Minimum interface every protocol context must expose.
 *
 * TPhase is the protocol-specific phase union type.
 *
 * Example:
 *   interface IceTherapyContextValue extends ProtocolContextShape<IcePhase> {
 *     coolDurationMinutes: number;
 *     setCoolDuration: (v: number) => void;
 *   }
 */
export interface ProtocolContextShape<TPhase extends string = string> {
  /** Whether the protocol timer is currently running */
  enabled: boolean;
  /** Current phase identifier */
  phase: TPhase;
  /** Absolute time of the next automatic phase transition, null when idle */
  nextTransitionAt: Date | null;
  /** Seconds elapsed since the current phase started */
  elapsedSeconds: number;
  /** Toggle the protocol on/off */
  toggle: () => void;
}

// ─── Persistence contract ────────────────────────────────────────────────────

/**
 * Shape of the single JSON blob stored in localStorage per protocol.
 * Storing a single object (rather than scattered keys) makes migration
 * and versioning straightforward.
 *
 * Suggested localStorage key convention:  "protocol:<id>:state"
 *   e.g.  "protocol:ice-therapy:state"
 */
export interface ProtocolPersistedState<TPhase extends string = string> {
  /** Schema version — increment when the shape changes to enable migration */
  version: 1;
  /** Whether the protocol is enabled */
  enabled: boolean;
  /** Current phase at the time of last write */
  phase: TPhase;
  /** Epoch-ms of the last phase-start (null when idle) */
  phaseStartedAt: number | null;
  /** Epoch-ms when the next phase transition should fire (null when idle) */
  nextTransitionAt: number | null;
}
