/**
 * AuthCapabilityRegistry — tracks what the auth runtime can actually do right now.
 *
 * Surfaces explicit capability levels so the UI can make informed decisions
 * about what to offer the user instead of silently failing.
 */

import { Capacitor } from "@capacitor/core";

export type AuthCapabilityLevel = "FULL" | "DEGRADED" | "OFFLINE_ONLY" | "UNAVAILABLE";

export interface CapabilitySnapshot {
  level: AuthCapabilityLevel;
  nativeSignInAvailable: boolean;
  googlePlayServicesAvailable: boolean;
  networkAvailable: boolean;
  backendReachable: boolean;
  refreshCapable: boolean;
  offlineSessionViable: boolean;
  securePersistenceAvailable: boolean;
}

export class AuthCapabilityRegistry {
  private _snapshot: CapabilitySnapshot = {
    level: "UNAVAILABLE",
    nativeSignInAvailable: false,
    googlePlayServicesAvailable: false,
    networkAvailable: true,
    backendReachable: true,
    refreshCapable: false,
    offlineSessionViable: false,
    securePersistenceAvailable: false,
  };

  private _listeners: Set<(s: CapabilitySnapshot) => void> = new Set();

  get snapshot(): CapabilitySnapshot { return { ...this._snapshot }; }
  get level(): AuthCapabilityLevel { return this._snapshot.level; }

  update(partial: Partial<CapabilitySnapshot>): void {
    this._snapshot = { ...this._snapshot, ...partial };
    this._snapshot.level = this._computeLevel();
    for (const l of this._listeners) {
      try { l(this.snapshot); } catch { /* never propagate */ }
    }
  }

  subscribe(fn: (s: CapabilitySnapshot) => void): () => void {
    this._listeners.add(fn);
    fn(this.snapshot);
    return () => this._listeners.delete(fn);
  }

  /** Called once during runtime boot to probe available capabilities */
  async probe(nativeGoogleAvailable: boolean): Promise<void> {
    const isNative = Capacitor.isNativePlatform();
    const online = navigator.onLine;

    let backendReachable = false;
    if (online) {
      try {
        const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 3000);
        const r = await fetch(`${apiBase}/api/healthz`, { signal: controller.signal });
        clearTimeout(id);
        backendReachable = r.ok;
      } catch {
        backendReachable = false;
      }
    }

    this.update({
      nativeSignInAvailable: isNative && nativeGoogleAvailable,
      googlePlayServicesAvailable: isNative && nativeGoogleAvailable,
      networkAvailable: online,
      backendReachable,
      securePersistenceAvailable: isNative,
      refreshCapable: online && backendReachable,
      offlineSessionViable: true,
    });
  }

  setNetwork(online: boolean): void {
    this.update({ networkAvailable: online });
  }

  setBackendReachable(reachable: boolean): void {
    this.update({ backendReachable: reachable });
  }

  setRefreshCapable(capable: boolean): void {
    this.update({ refreshCapable: capable });
  }

  setOfflineSessionViable(viable: boolean): void {
    this.update({ offlineSessionViable: viable });
  }

  private _computeLevel(): AuthCapabilityLevel {
    const s = this._snapshot;
    if (!s.networkAvailable && !s.offlineSessionViable) return "UNAVAILABLE";
    if (!s.networkAvailable) return "OFFLINE_ONLY";
    if (!s.backendReachable || !s.refreshCapable) return "DEGRADED";
    if (s.nativeSignInAvailable || s.backendReachable) return "FULL";
    return "DEGRADED";
  }
}
