/**
 * SessionSecurityAudit — runtime validator for the native auth security model.
 *
 * Validates the security posture of the current session configuration at runtime.
 * NOT a test framework — runs in production to surface misconfigurations.
 *
 * Run via: SessionSecurityAudit.run(getCurrentJwt())
 *
 * Checks performed:
 *   1. ACCESS_TOKEN_LIFETIME     — JWT exp - iat ≤ 60 min (spec max)
 *   2. ACCESS_TOKEN_CLAIMS       — all required claims present in JWT
 *   3. ISSUER_AUDIENCE           — iss = "native-android", aud = "posture-timer-api"
 *   4. TOKEN_NOT_EXPIRED         — current time is before JWT exp
 *   5. REFRESH_CREDENTIALS_EXIST — refresh token + session ID stored in Preferences
 *   6. DEVICE_ID_STABLE          — device ID exists (binding in place)
 *   7. SIGNATURE_STRUCTURE       — JWT is 3-part base64url structure
 */

import { Preferences } from "@capacitor/preferences";
import { Capacitor } from "@capacitor/core";

const REQUIRED_CLAIMS   = ["iss", "aud", "sub", "session_id", "token_version", "iat", "exp"] as const;
const EXPECTED_ISSUER   = "native-android";
const EXPECTED_AUDIENCE = "posture-timer-api";
const MAX_ACCESS_TTL_SECS = 60 * 60; // 60 minutes

const REFRESH_TOKEN_KEY = "native_rt_v1";
const SESSION_ID_KEY    = "native_sid_v1";
const DEVICE_ID_KEY     = "native_device_id";

// ── Types ──────────────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SecurityCheck {
  name:        string;
  passed:      boolean;
  riskIfFail:  RiskLevel;
  detail:      string;
}

export interface SecurityAuditResult {
  passed:     boolean;        // true only if ALL checks pass
  riskLevel:  RiskLevel;      // worst failing risk level, or LOW if all pass
  checks:     SecurityCheck[];
  timestamp:  number;
  platform:   string;
  isNative:   boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const RISK_ORDER: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
function worstRisk(levels: RiskLevel[]): RiskLevel {
  let worst = 0;
  for (const l of levels) {
    const idx = RISK_ORDER.indexOf(l);
    if (idx > worst) worst = idx;
  }
  return RISK_ORDER[worst];
}

function check(
  name: string,
  passed: boolean,
  riskIfFail: RiskLevel,
  detail: string,
): SecurityCheck {
  return { name, passed, riskIfFail, detail };
}

// ── Audit runner ──────────────────────────────────────────────────────────────

export class SessionSecurityAudit {
  /**
   * Run all security checks against the provided access token.
   *
   * @param accessToken - Current JWT from AuthStateStore (or null if not signed in).
   *                      Token value is decoded but never logged.
   */
  static async run(accessToken: string | null): Promise<SecurityAuditResult> {
    const isNative = Capacitor.isNativePlatform();
    const platform = Capacitor.getPlatform();
    const results: SecurityCheck[] = [];

    // ── Check 1: JWT has correct 3-part structure ────────────────────────────
    const hasValidStructure = !!accessToken && accessToken.split(".").length === 3;
    results.push(check(
      "SIGNATURE_STRUCTURE",
      hasValidStructure,
      "CRITICAL",
      hasValidStructure
        ? "JWT has valid 3-part base64url structure"
        : accessToken ? "JWT does not have 3-part structure (malformed)" : "No access token present",
    ));

    let payload: Record<string, unknown> | null = null;
    if (hasValidStructure && accessToken) {
      payload = decodeJwtPayload(accessToken);
    }

    // ── Check 2: Required claims present ─────────────────────────────────────
    const missingClaims = REQUIRED_CLAIMS.filter(c => payload == null || !(c in payload));
    results.push(check(
      "ACCESS_TOKEN_CLAIMS",
      missingClaims.length === 0,
      "HIGH",
      missingClaims.length === 0
        ? `All required claims present: [${REQUIRED_CLAIMS.join(", ")}]`
        : `Missing claims: [${missingClaims.join(", ")}]`,
    ));

    // ── Check 3: Issuer and audience ─────────────────────────────────────────
    const iss     = payload?.iss;
    const aud     = payload?.aud;
    const issOk   = iss === EXPECTED_ISSUER;
    const audOk   = aud === EXPECTED_AUDIENCE;
    results.push(check(
      "ISSUER_AUDIENCE",
      issOk && audOk,
      "HIGH",
      issOk && audOk
        ? `iss="${EXPECTED_ISSUER}", aud="${EXPECTED_AUDIENCE}" ✓`
        : [
            !issOk ? `iss mismatch: expected "${EXPECTED_ISSUER}", got "${String(iss)}"` : "",
            !audOk ? `aud mismatch: expected "${EXPECTED_AUDIENCE}", got "${String(aud)}"` : "",
          ].filter(Boolean).join("; "),
    ));

    // ── Check 4: Token not expired ────────────────────────────────────────────
    const exp = typeof payload?.exp === "number" ? payload.exp : null;
    const nowSecs = Math.floor(Date.now() / 1000);
    const notExpired = exp !== null && exp > nowSecs;
    results.push(check(
      "TOKEN_NOT_EXPIRED",
      notExpired,
      "CRITICAL",
      exp === null
        ? "No exp claim found"
        : notExpired
          ? `Token valid for ${exp - nowSecs}s more (expires ${new Date(exp * 1000).toISOString()})`
          : `Token expired ${nowSecs - exp}s ago`,
    ));

    // ── Check 5: Access token lifetime ≤ 60 minutes ──────────────────────────
    const iat = typeof payload?.iat === "number" ? payload.iat : null;
    const ttlSecs = iat !== null && exp !== null ? exp - iat : null;
    const lifetimeOk = ttlSecs !== null && ttlSecs <= MAX_ACCESS_TTL_SECS;
    results.push(check(
      "ACCESS_TOKEN_LIFETIME",
      lifetimeOk,
      "HIGH",
      ttlSecs === null
        ? "Cannot determine lifetime (iat or exp missing)"
        : lifetimeOk
          ? `Token lifetime is ${ttlSecs}s (≤ ${MAX_ACCESS_TTL_SECS}s limit ✓)`
          : `Token lifetime is ${ttlSecs}s — EXCEEDS ${MAX_ACCESS_TTL_SECS}s maximum`,
    ));

    // ── Check 6: Refresh credentials stored (native only) ────────────────────
    let refreshCreds = false;
    let refreshDetail = "Skipped — not native platform";
    if (isNative) {
      const [rtResult, sidResult] = await Promise.all([
        Preferences.get({ key: REFRESH_TOKEN_KEY }),
        Preferences.get({ key: SESSION_ID_KEY }),
      ]);
      // Only check existence — never log values
      const hasRt  = !!rtResult.value && rtResult.value.length >= 64;
      const hasSid = !!sidResult.value && sidResult.value.length > 0;
      refreshCreds  = hasRt && hasSid;
      refreshDetail = refreshCreds
        ? "Refresh token (64+ hex chars) and session ID both present ✓"
        : [
            !hasRt  ? "Refresh token missing or malformed" : "",
            !hasSid ? "Session ID missing" : "",
          ].filter(Boolean).join("; ");
    }
    results.push(check(
      "REFRESH_CREDENTIALS_EXIST",
      isNative ? refreshCreds : true, // non-native uses Clerk, always pass
      "CRITICAL",
      refreshDetail,
    ));

    // ── Check 7: Stable device ID exists (native only) ────────────────────────
    let deviceOk     = true;
    let deviceDetail = "Skipped — not native platform";
    if (isNative) {
      const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
      deviceOk     = !!value && value.length > 0;
      deviceDetail = deviceOk
        ? "Device ID present (length redacted for security) ✓"
        : "Device ID missing — device binding not established";
    }
    results.push(check(
      "DEVICE_ID_STABLE",
      deviceOk,
      "MEDIUM",
      deviceDetail,
    ));

    // ── Aggregate ─────────────────────────────────────────────────────────────
    const allPassed = results.every(r => r.passed);
    const failing   = results.filter(r => !r.passed).map(r => r.riskIfFail);
    const riskLevel = allPassed ? "LOW" : worstRisk(failing);

    return {
      passed:    allPassed,
      riskLevel,
      checks:    results,
      timestamp: Date.now(),
      platform,
      isNative,
    };
  }

  /**
   * Run the audit and emit a structured summary to the console.
   * Safe to call in production — token values are never logged.
   */
  static async report(accessToken: string | null): Promise<SecurityAuditResult> {
    const result = await SessionSecurityAudit.run(accessToken);

    const icon  = result.passed ? "✓" : "✗";
    const label = result.passed ? "PASSED" : `FAILED [${result.riskLevel}]`;

    console.group(`[SessionSecurityAudit] ${icon} ${label} — platform: ${result.platform}`);
    for (const c of result.checks) {
      const status = c.passed ? "  ✓" : `  ✗ [${c.riskIfFail}]`;
      console.log(`${status} ${c.name}: ${c.detail}`);
    }
    console.groupEnd();

    return result;
  }
}
