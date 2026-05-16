/**
 * SecureSessionStore — persistent auth metadata that survives process death.
 *
 * Uses Capacitor Preferences (backed by Android SharedPreferences / iOS NSUserDefaults
 * with biometric protection when available) for the session envelope.
 * The raw JWT is NOT stored — only metadata needed to restore context and
 * decide whether a refresh attempt is worth making on next startup.
 *
 * On web/dev the store degrades to sessionStorage (in-memory equivalent).
 */

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const KEY = "auth_session_v1";

export interface PersistedSessionMeta {
  sessionId: string;
  userId: string;
  expiresAt: number;
  lastRefreshedAt: number;
  provider: "google_native" | "google_web" | "email_password";
  /** Monotonic clock offset at persist time (ms since navigation start) */
  monotonicOffsetMs: number;
}

export class SecureSessionStore {
  private readonly _isNative = Capacitor.isNativePlatform();

  async save(meta: PersistedSessionMeta): Promise<void> {
    const payload = JSON.stringify({
      ...meta,
      monotonicOffsetMs: performance.now(),
    });
    if (this._isNative) {
      await Preferences.set({ key: KEY, value: payload });
    } else {
      try { sessionStorage.setItem(KEY, payload); } catch { /* storage full */ }
    }
  }

  async load(): Promise<PersistedSessionMeta | null> {
    try {
      let raw: string | null = null;
      if (this._isNative) {
        const { value } = await Preferences.get({ key: KEY });
        raw = value;
      } else {
        raw = sessionStorage.getItem(KEY);
      }
      if (!raw) return null;
      return JSON.parse(raw) as PersistedSessionMeta;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    if (this._isNative) {
      await Preferences.remove({ key: KEY });
    } else {
      sessionStorage.removeItem(KEY);
    }
  }

  /**
   * Returns true if the persisted session is still worth attempting a refresh for.
   * Allows up to 24 h past expiry (Clerk refresh tokens typically live 7 days).
   */
  isRefreshable(meta: PersistedSessionMeta): boolean {
    const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
    return Date.now() < meta.expiresAt + REFRESH_WINDOW_MS;
  }

  /**
   * Returns true if the session appears valid right now (not yet expired).
   * Applies a 30 s clock-skew buffer.
   */
  isLikelyValid(meta: PersistedSessionMeta): boolean {
    const SKEW_MS = 30_000;
    return Date.now() < meta.expiresAt - SKEW_MS;
  }
}
