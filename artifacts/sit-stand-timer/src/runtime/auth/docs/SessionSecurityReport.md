# Session Security Report
**System**: Sit/Stand Posture Timer — Native Android Auth  
**Date**: 2026-05-16  
**Scope**: Native session security model for Android (Capacitor)  

---

## 1. Architecture Summary

The native Android build uses a backend-mediated authentication flow that bypasses
the Clerk browser SDK entirely (which fails to initialize on `https://localhost`,
the Capacitor WebView origin).

```
Native Google Sign-In (Capacitor plugin)
         │
         ▼
POST /api/auth/native/google
  - Verifies Google ID token via tokeninfo API
  - Validates: issuer, audience, email_verified, expiry
  - Resolves/creates Clerk user via BAPI
  - Creates native_sessions DB row
  - Issues 30-min access token (HS256 JWT)
  - Issues opaque refresh token (32-byte random, never stored raw)
         │
         ▼
RuntimeCore (AuthRuntime + AuthSessionManager)
  - Schedules refresh 2 min before access token expiry
  - On refresh: POST /api/auth/native/refresh
               { refreshToken, sessionId }  → rotates token pair
  - On revoke:  POST /api/auth/native/revoke (sign-out)
         │
         ▼
Backend API (requireAuth middleware)
  - Verifies JWT: signature + exp + iss + aud
  - Loads native_sessions row: checks not revoked, not compromised
  - Validates token_version claim matches session record
  - Sets req.userId = JWT.sub for all downstream routes
```

---

## 2. Threat Model

### 2.1 Access Token Theft

**Threat**: Attacker obtains an access token from device memory, logs, or network sniffing.

**Mitigations**:
- Access tokens expire in **30 minutes** (well within the 15–60 min spec window).
- Token is stored in memory only (never written to disk on web; Preferences on native).
- All API communication must be over HTTPS (TLS in production).
- Token payload contains `session_id` which is DB-validated on every request — a revoked session stops working within milliseconds, not minutes.

**Residual risk**: An attacker who obtains a valid access token has a 30-minute
window before it expires. Shorter TTLs (15 min) would reduce this further.

---

### 2.2 Refresh Token Theft

**Threat**: Attacker obtains the opaque refresh token from device storage.

**Mitigations**:
- Refresh token is stored in `@capacitor/preferences` (Android SharedPreferences).
- Raw refresh token is **never** stored server-side — only `SHA-256(token)`.
- Token is 32 bytes (256 bits) of cryptographically random data — brute-force infeasible.
- On sign-out, the local refresh token is cleared **before** the network revoke call.
- `POST /api/auth/native/revoke` requires proof-of-possession (refresh token match) before revoking.

**Residual risk**: Android SharedPreferences is not protected by the Android Keystore
on non-rooted devices. For higher assurance, swap `@capacitor/preferences` for
`@aparajita/capacitor-secure-storage` (Keystore-backed). The vault interface supports
this as a one-line change (`SecureSessionVault` note).

---

### 2.3 Refresh Token Replay Attack

**Threat**: Attacker captures a refresh token, then uses it after the legitimate
client has already rotated it.

**Mitigations** (strictly enforced):
1. Every successful refresh **rotates** the token pair — old refresh token becomes permanently invalid.
2. Backend stores `rotationCounter` — each rotation increments it.
3. If an old refresh token (hash mismatch for a known session_id) is presented:
   - Session is immediately marked `compromised_flag = true`
   - Session is immediately `revoked_at = NOW()`
   - All future access tokens for this session_id are rejected
   - Client receives `401 Replay detected — reauthentication required`
   - `AuthProviderError(SESSION_INVALIDATED)` propagates to AuthSessionManager → forced sign-out

**Replay detection guarantee**: Any replay of an already-rotated token results in full
session termination within one network round-trip.

---

### 2.4 Session Fixation / Prediction

**Threat**: Attacker predicts or fixes the session_id or refresh token.

**Mitigations**:
- `session_id = crypto.randomUUID()` — 122 bits of entropy (Node.js crypto).
- `refreshToken = crypto.randomBytes(32).toString("hex")` — 256 bits of entropy.
- Both generated server-side at session creation; client receives values, never generates them.

---

### 2.5 JWT Forgery

**Threat**: Attacker forges an access token to impersonate a user.

**Mitigations**:
- HS256 with `SESSION_SECRET` (environment variable, minimum 256-bit entropy expected).
- Signature verified with `crypto.timingSafeEqual` — timing-safe comparison.
- Claims validated: `iss = "native-android"`, `aud = "posture-timer-api"`.
- `session_id` in every JWT is validated against the DB on every request — a forged
  session_id for a non-existent session fails at the DB lookup.
- `token_version` mismatch invalidates tokens even if signature is valid.

**Residual risk**: HS256 with a shared secret provides weaker guarantees than RS256/ES256
(asymmetric). If `SESSION_SECRET` is compromised, all tokens can be forged. Rotation
support exists (new secret invalidates all tokens due to signature failure + DB lookup
failure). Consider migrating to RS256 for higher assurance.

---

### 2.6 Mass Account Invalidation

**Threat**: Account compromise requires immediately invalidating all sessions.

**Mitigations** — two independent channels:
1. **token_version**: Increment `native_sessions.token_version` for a session → all
   existing access tokens for that session are rejected at middleware (version mismatch).
2. **revoked_at**: Set `native_sessions.revoked_at = NOW()` → session is immediately
   inert; all future access token validations fail at DB check.

Both propagate within one API request of the change (no cached state).

---

### 2.7 Device Loss / Unauthorized Device

**Threat**: User loses their device; attacker has access to local storage.

**Mitigations**:
- `deviceId`, `platform`, `appVersion` stored in `native_sessions` for attribution.
- User can revoke specific sessions by session_id via backend tooling.
- No hard block on device change currently — anomaly detection only.

**Residual risk**: Without device attestation (SafetyNet/Play Integrity), a compromised
device with root access can extract SharedPreferences. Android Keystore-backed storage
is the recommended next step.

---

### 2.8 Denial of Service via Revoke Endpoint

**Threat**: Attacker enumerates session_ids and calls `/revoke` to sign users out.

**Mitigations**:
- Revoke requires proof-of-possession: `SHA-256(refreshToken)` must match stored hash.
- Without the actual refresh token (256-bit random), the endpoint rejects with 401.
- Session_id alone is insufficient to trigger revocation.

---

## 3. Revocation Guarantees

| Trigger | Mechanism | Propagation Latency |
|---|---|---|
| User sign-out | POST /api/auth/native/revoke → revokedAt set | Immediate (next request) |
| Refresh replay detected | compromisedFlag + revokedAt set automatically | Immediate |
| token_version increment | Middleware rejects version mismatch | Immediate (next request) |
| Session row deleted | DB lookup returns null → 401 | Immediate |
| 90-day session expiry | expiresAt < now → refresh rejected | At next refresh attempt |
| Admin revocation | Set revokedAt via direct DB update | Immediate |

---

## 4. Token Lifetime Analysis

| Token type | Lifetime | Stored | Rotated | Revocable |
|---|---|---|---|---|
| Access token | 30 minutes | Memory only | No (stateless) | Via session revocation |
| Refresh token | 90 days (sliding) | Preferences (hashed in DB) | Every refresh | Immediately |
| Native session | 90 days | PostgreSQL | N/A | revokedAt or compromisedFlag |

---

## 5. Compromise Recovery Semantics

When a compromised session is detected:

1. Backend sets `compromised_flag = true`, `revoked_at = NOW()`.
2. All subsequent API requests with any access token for this `session_id` receive `401 Session compromised`.
3. Any refresh attempt receives `401 Session compromised — reauthentication required`.
4. Frontend `NativeSessionTransport.refreshCurrentToken()` throws `AuthProviderError(SESSION_INVALIDATED)`.
5. `classifyClerkError(err)` detects `AuthProviderError` instance → returns it directly.
6. `AuthSessionManager` sees `isNonRetriable = true` → calls `onRevocation("SESSION_INVALIDATED")`.
7. `AuthRuntime` transitions to `SIGNED_OUT` state.
8. User is shown the sign-in screen; full reauthentication required.

There is no silent continuation after compromise detection.

---

## 6. Cryptographic Inventory

| Primitive | Usage | Strength |
|---|---|---|
| HS256 (HMAC-SHA256) | Access token signing | 256-bit key (SESSION_SECRET) |
| SHA-256 | Refresh token hashing | 256-bit output — preimage resistant |
| crypto.randomBytes(32) | Refresh token generation | 256-bit entropy |
| crypto.randomUUID() | Session ID generation | 122-bit entropy |
| crypto.timingSafeEqual | Signature + hash comparison | Timing-attack resistant |

---

## 7. Residual Risks

| Risk | Severity | Mitigation Path |
|---|---|---|
| SharedPreferences not Keystore-backed | MEDIUM | Swap to `@aparajita/capacitor-secure-storage` |
| HS256 (symmetric) vs RS256 (asymmetric) | LOW-MEDIUM | Migrate to RS256 with key rotation |
| No Play Integrity / SafetyNet attestation | MEDIUM | Add device attestation check at exchange |
| 30-min access token window | LOW | Reduce to 15 min for higher assurance |
| No rate limiting on refresh endpoint | LOW | Add express-rate-limit to /auth/native/* |
| SESSION_SECRET rotation requires re-auth | LOW-MEDIUM | Add key versioning to access token header |

---

## 8. Out of Scope

- Clerk web session security (handled by Clerk SDK)
- TLS/HTTPS configuration (handled by Replit deployment infrastructure)
- Android app binary integrity (handled by Play Store signing)
- Google OAuth client ID security (handled by Google Cloud Console)
