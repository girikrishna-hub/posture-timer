/**
 * SecureSessionVault — hardened persistent auth metadata storage.
 *
 * Improvements over SecureSessionStore:
 * - Schema versioning with migration-safe structure
 * - Integrity validation (checksum to detect corruption)
 * - Explicit corruption detection (returns null on bad data)
 * - Separate integrity key from data key
 * - Versioned clearing (clear only invalidates — doesn't corrupt)
 *
 * Storage backend:
 * - Native (Capacitor): @capacitor/preferences (Android SharedPreferences)
 * - Web/dev: sessionStorage (in-memory equivalent, not persisted across tabs)
 *
 * PRODUCTION NOTE:
 * For full Android Keystore / iOS Keychain encryption, swap @capacitor/preferences
 * for a keystore-backed plugin such as @aparajita/capacitor-secure-storage.
 * The vault interface is designed to make this swap a one-line change.
 *
 * Raw JWTs are NEVER stored. Only the metadata needed to decide whether a
 * refresh attempt is worthwhile on next startup.
 */

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const SCHEMA_VERSION = 2;
const DATA_KEY = "auth_vault_v2";
const INTEGRITY_KEY = "auth_vault_v2_ck";

export interface VaultedSession {
  schemaVersion: number;
  sessionId: string;
  userId: string;
  expiresAt: number;
  lastRefreshedAt: number;
  provider: "google_native" | "google_web" | "email_password";
  /** performance.now() at persist time — for drift detection */
  monotonicOffsetMs: number;
  /** Wall-clock at persist time — for expiry cross-check */
  persistedAt: number;
}

function simpleChecksum(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

export class SecureSessionVault {
  private readonly _isNative = Capacitor.isNativePlatform();

  async save(meta: Omit<VaultedSession, "schemaVersion" | "persistedAt">): Promise<void> {
    const record: VaultedSession = {
      ...meta,
      schemaVersion: SCHEMA_VERSION,
      persistedAt: Date.now(),
      monotonicOffsetMs: performance.now(),
    };
    const payload = JSON.stringify(record);
    const checksum = simpleChecksum(payload);
    await this._write(DATA_KEY, payload);
    await this._write(INTEGRITY_KEY, String(checksum));
  }

  async load(): Promise<VaultedSession | null> {
    try {
      const [payload, storedChecksum] = await Promise.all([
        this._read(DATA_KEY),
        this._read(INTEGRITY_KEY),
      ]);
      if (!payload) return null;

      // Integrity check
      if (storedChecksum !== null) {
        const expected = simpleChecksum(payload);
        if (String(expected) !== storedChecksum) {
          console.warn("[SecureSessionVault] Integrity check failed — clearing corrupted data");
          await this.clear();
          return null;
        }
      }

      const record = JSON.parse(payload) as Partial<VaultedSession>;

      // Schema migration
      if (record.schemaVersion !== SCHEMA_VERSION) {
        console.warn(
          `[SecureSessionVault] Schema v${record.schemaVersion ?? "?"} → clearing (expected v${SCHEMA_VERSION})`
        );
        await this.clear();
        return null;
      }

      // Basic shape validation
      if (
        typeof record.sessionId !== "string" ||
        typeof record.userId !== "string" ||
        typeof record.expiresAt !== "number"
      ) {
        console.warn("[SecureSessionVault] Malformed session record — clearing");
        await this.clear();
        return null;
      }

      return record as VaultedSession;
    } catch {
      // JSON parse error or storage error — treat as corruption
      await this.clear().catch(() => {});
      return null;
    }
  }

  async clear(): Promise<void> {
    await this._write(DATA_KEY, null);
    await this._write(INTEGRITY_KEY, null);
  }

  /**
   * Returns true if a session is within the refresh window.
   * Clerk refresh tokens typically live 7 days; we allow 24 h past JWT expiry.
   */
  isRefreshable(meta: VaultedSession): boolean {
    const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
    return Date.now() < meta.expiresAt + REFRESH_WINDOW_MS;
  }

  /**
   * Returns true if the JWT appears non-expired (with 30 s clock-skew buffer).
   */
  isLikelyValid(meta: VaultedSession): boolean {
    return Date.now() < meta.expiresAt - 30_000;
  }

  /**
   * Detect wall-clock drift between persist time and now.
   * Large drift may indicate device clock adjustment or process death.
   */
  clockDriftMs(meta: VaultedSession): number {
    const monoElapsed = performance.now() - meta.monotonicOffsetMs;
    const wallElapsed = Date.now() - meta.persistedAt;
    return Math.abs(wallElapsed - monoElapsed);
  }

  // ── storage primitives ────────────────────────────────────────────────────

  private async _write(key: string, value: string | null): Promise<void> {
    if (this._isNative) {
      if (value === null) {
        await Preferences.remove({ key });
      } else {
        await Preferences.set({ key, value });
      }
    } else {
      try {
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
      } catch { /* storage full or unavailable — best effort */ }
    }
  }

  private async _read(key: string): Promise<string | null> {
    if (this._isNative) {
      const { value } = await Preferences.get({ key });
      return value;
    } else {
      try { return sessionStorage.getItem(key); } catch { return null; }
    }
  }
}
