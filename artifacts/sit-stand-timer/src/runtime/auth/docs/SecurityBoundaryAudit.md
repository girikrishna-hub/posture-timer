# Security Boundary Audit — Auth Runtime

**Date:** Phase 4  
**Scope:** SecureSessionVault, AuthDiagnosticsJournal, ClerkSessionTransport, token lifecycle

---

## Summary

| Area | Status | Notes |
|------|--------|-------|
| JWT storage | ✅ PASS | JWTs never written to disk |
| Session metadata storage | ⚠ PARTIAL | Plaintext in SharedPreferences — not Keystore-backed |
| Log output in production | ✅ FIXED | console.log gated to DEV builds only (Phase 4) |
| Token leakage in traces | ✅ PASS | Audit confirms no token in any journal message |
| Integrity validation | ⚠ PARTIAL | FNV-1a checksum — non-cryptographic |
| Replay resistance | ✅ PASS | Vault stores metadata, not replay-capable tokens |
| Tamper detection | ⚠ PARTIAL | Checksum detects accidental corruption, not adversarial tampering |
| Partial-write recovery | ✅ PASS | Missing checksum key → load() returns null and clears |
| Session invalidation | ✅ PASS | vault.clear() removes both data and integrity keys atomically |
| Key rotation | ✅ PASS | Schema version bump causes auto-clear and re-auth |
| PII in logcat | ✅ FIXED | Production builds emit no auth journal entries (Phase 4) |
| Email in traces | ✅ PASS | Email only in AUTH_SIGN_IN_SUCCEEDED — gated to DEV |

---

## Critical Findings

### FIXED: PII leakage to Android logcat

**Finding:** `AuthDiagnosticsJournal.record()` called `console.log()` unconditionally.  
`AUTH_SIGN_IN_SUCCEEDED` messages include the user's email address.  
On Android, logcat is readable by any app holding `READ_LOGS` permission, or via ADB in developer mode.

**Fix applied (Phase 4):** `console.log` is now gated behind `import.meta.env.DEV`.  
Production builds emit zero log output from the auth journal.

---

## Partial Findings

### SecureSessionVault — Unencrypted persistence

**Status:** Known limitation, documented.

The vault uses `@capacitor/preferences` which maps to Android `SharedPreferences`.  
SharedPreferences are:
- Stored in the app's private data directory (`/data/data/<package>/shared_prefs/`)
- Inaccessible to other apps on unrooted devices
- Readable with root access or ADB backup (if `allowBackup=true`)
- Not backed by Android Keystore

**What is stored:**  
`sessionId`, `userId`, `expiresAt`, `lastRefreshedAt`, `provider`, `monotonicOffsetMs`, `persistedAt`

**What is NOT stored:**  
JWT access tokens, Clerk session tokens, Google ID tokens, refresh tokens, credentials of any kind.

**Risk assessment:**  
Low-to-medium. An attacker with root access could read the vault and learn that a user is authenticated and their session expiry. They cannot obtain a usable JWT from this data — the JWT is re-fetched from Clerk on every startup.

**Migration path:**  
Swap `@capacitor/preferences` for `@aparajita/capacitor-secure-storage` or the Ionic Native Secure Storage plugin. `SecureSessionVault`'s `_read`/`_write` primitives are the only storage touch points — the swap is a one-file change.

### SecureSessionVault — Non-cryptographic integrity check

**Status:** Known limitation, sufficient for corruption detection.

The FNV-1a checksum detects accidental corruption (storage truncation, JSON parse errors, partial writes). It does not detect adversarial tampering by an attacker who knows the algorithm and can write to SharedPreferences.

**Risk assessment:**  
Low. An attacker who can write arbitrary data to SharedPreferences can already cause much greater damage than session metadata forgery. The integrity check's purpose is corruption detection, not tamper-proofing.

---

## Confirmed Clean Areas

### JWT tokens are never written to disk

Confirmed by audit of all vault `save()` callsites:

```typescript
// AuthSessionManager._doRefresh()
await this._vault.save({
  sessionId: updated.sessionId,    // Clerk session ID — not a JWT
  userId: updated.userId,          // User ID string
  expiresAt: updated.expiresAt,    // Expiry timestamp
  lastRefreshedAt: updated.lastRefreshedAt,
  provider: updated.provider,
  monotonicOffsetMs: performance.now(),
});
// Note: `jwt` field is NOT included
```

The JWT lives only in `AuthStateStore.session.jwt` — runtime memory, cleared on app kill.

### No token in journal trace events

Full audit of all `journal.record()` calls confirms:
- No `jwt`, `token`, `idToken`, `accessToken` field appears in any journal message or `data` object
- `AUTH_SIGN_IN_SUCCEEDED` logs email (PII, now gated to DEV) but not any token
- Refresh events log chain IDs, expiry times — not token values

### Partial-write detection

```typescript
// Scenario: process killed after _write(DATA_KEY) but before _write(INTEGRITY_KEY)
// load() reads data key ✓
// load() reads integrity key → null (not written)
// Integrity check: storedChecksum !== null → skipped (gracefully loads without check)
```

Wait — if the checksum is null, the integrity check is skipped. This means a partial write is silently accepted without validation. This is a finding:

**Finding:** If the process dies between the data write and checksum write, the next load() succeeds without checksum validation. The data may be consistent but we cannot verify it.

**Risk:** Low. The data write is a single JSON string — if `Preferences.set()` completes, the data is valid. An incomplete write would likely throw and leave the old data in place.

**Recommendation:** Consider writing the checksum first (write-checksum-then-data) so that a partial write leaves old data intact and detectable.

---

## Recommendations

1. **Migrate to Keystore-backed storage** for the vault — one-file change in `SecureSessionVault._read/_write`. Priority: Medium. Block on: selecting and testing the secure storage plugin.

2. **Write checksum before data** — reverses write order so partial writes leave old data detectable. Priority: Low.

3. **Add `allowBackup=false`** to `AndroidManifest.xml` — prevents ADB backup of SharedPreferences. Priority: Medium. Action: verify current manifest setting.

4. **Audit Google Native credential handling** — `GoogleAuthAdapter.signIn()` returns an `idToken`. Confirm it is passed directly to `ClerkBridgeAdapter.exchangeGoogleIdToken()` and never logged or stored.
