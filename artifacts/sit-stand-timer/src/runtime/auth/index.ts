export { AuthRuntime } from "./AuthRuntime";
export {
  useAuthRuntime,
  useAuthActions,
  useBootBarrier,
  useAuthDiagnostics,
} from "./useAuthRuntime";
export { ClerkRuntimeBridge } from "./ClerkRuntimeBridge";
export { NativeGoogleSignInButton } from "./NativeGoogleSignInButton";
export { AuthRuntimeOverlay } from "./AuthRuntimeOverlay";

// Types
export type { AuthRuntimeState } from "./useAuthRuntime";
export type { RuntimeSession } from "./AuthStateStore";
export type { AuthState, StartupMode } from "./AuthStateMachine";
export type { AuthConfidenceLevel } from "./AuthConfidenceLevel";
export type { BootPhase, BootTerminalPhase } from "./RuntimeBootBarrier";
export type { TraceContext } from "./TraceCorrelationManager";
export type { VaultedSession } from "./SecureSessionVault";
export type { ValidationResult, ValidationOutcome } from "./SessionRestorationValidator";
export type { ClerkRuntimeStatus } from "./ClerkRuntimeRegistry";
export type { StartupKind, RecoveryAssessment } from "./ProcessRecoveryCoordinator";
export type { RefreshChain, RefreshChainOutcome } from "./RefreshChainCoordinator";
export type { OfflineCapabilities } from "./OfflineCapabilityMatrix";
export type { RuntimeDiscontinuity, DiscontinuityKind } from "./BrowserRuntimeMonitor";
export type { TimeSnapshot } from "./TimeAuthority";
export type { TraceTimeline, TimelineEntry } from "./AuthTraceVisualizer";

// Utilities
export { capabilityFor, capabilitySummary } from "./OfflineCapabilityMatrix";
export { buildTimeline, renderEntry } from "./AuthTraceVisualizer";
export { isFullyOperational, isPartiallyOperational, requiresReauth } from "./AuthConfidenceLevel";

// Phase 5 — pre-deployment hardening
export { AuthProviderError, classifyClerkError, classifyGoogleError } from "./AuthProviderError";
export type { AuthProviderErrorCode } from "./AuthProviderError";
export {
  generateRuntimeCertificationReport,
  printRuntimeCertificationReport,
} from "./testing/RuntimeCertificationReport";
export type {
  CertificationReport,
  CertificationLevel,
  CertificationFinding,
  FindingSeverity,
  DimensionResult,
} from "./testing/RuntimeCertificationReport";
