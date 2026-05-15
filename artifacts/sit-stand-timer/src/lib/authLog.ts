/**
 * Shared auth-flow log bus.
 *
 * NativeSignIn writes auth flow events here.
 * NativeDebugPanel subscribes and surfaces them in its live log view.
 * The bus is module-level so it works across React re-renders / unmounts.
 */

export type AuthLogKind = "info" | "ok" | "warn" | "error";

export interface AuthLogEntry {
  time: string;
  msg: string;
  kind: AuthLogKind;
}

type Listener = (entry: AuthLogEntry) => void;

const _listeners: Listener[] = [];

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function authLog(msg: string, kind: AuthLogKind = "info"): void {
  const entry: AuthLogEntry = { time: ts(), msg, kind };
  const fn =
    kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
  fn(`[AUTH ${entry.time}] ${msg}`);
  _listeners.forEach((l) => l(entry));
}

export function subscribeAuthLog(listener: Listener): () => void {
  _listeners.push(listener);
  return () => {
    const i = _listeners.indexOf(listener);
    if (i !== -1) _listeners.splice(i, 1);
  };
}
