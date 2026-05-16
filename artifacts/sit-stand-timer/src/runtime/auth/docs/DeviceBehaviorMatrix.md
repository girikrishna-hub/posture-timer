# OEM Device Behavior Matrix — Auth Runtime

**Purpose:** Document Android OEM lifecycle anomalies relevant to auth reliability.  
**Status:** Reference documentation based on known OEM behavior patterns.  
Physical device validation required before each production release.

---

## Overview

Android's auth runtime must survive conditions that no emulator reproduces:

- Aggressive battery optimization killing background processes
- WebView renderer recreation under memory pressure
- Network flapping between WiFi and mobile data
- Clock drift from timezone changes and manual adjustment
- Google Play Services instability on certain OEM builds
- Delayed Clerk JS runtime startup on low-end devices

---

## OEM Behavior Reference

### Samsung OneUI (Galaxy S/A/M series)

**Battery optimization:** Aggressive. Apps not whitelisted in "Device Care → Battery → Background usage limits" are killed within minutes of backgrounding.

**Auth impact:**
- Process death after ~5 min background → `ProcessRecoveryCoordinator.assess()` classifies as `PROCESS_RECOVERY`
- Session vault load required on every foreground resume
- Clerk JS SDK re-initializes on WebView recreation (common under low memory)

**Known quirks:**
- `performance.now()` may reset to 0 after renderer recreation — `TimeAuthority` monotonic baseline becomes invalid. Detected via `BrowserRuntimeMonitor.onDiscontinuity()`.
- Samsung Internet WebView has historically had issues with `@capacitor/preferences` encryption. Use plaintext storage (current default) until confirmed.

**Mitigation:** `BrowserRuntimeMonitor` detects Clerk recreation. `ProcessRecoveryCoordinator` classifies startup correctly. Vault is always loaded on boot — cold or warm.

---

### Xiaomi MIUI / HyperOS (Redmi, Poco, Mi series)

**Battery optimization:** Extremely aggressive. MIUI's "MIUI Optimization" and "Autostart" controls can prevent the app from appearing in foreground within 500ms of intent launch.

**Auth impact:**
- App may be fully killed every time the user leaves it, regardless of settings
- Autostart denial means background push notifications cannot wake the runtime
- Google Play Services updates can cause `GoogleSignIn.signIn()` to return `SIGN_IN_CANCELLED` spuriously

**Known quirks:**
- `Date.now()` clock accuracy is reduced in some MIUI versions when "Performance Mode" is disabled. Expiry checks may have ±30s drift.
- WebView process restart is common. `ClerkRuntimeRegistry` will receive `CLERK_RUNTIME_RECREATED` and must re-resolve.

**Recommended testing:**
1. Disable "MIUI Optimization" — confirm app still boots
2. Enable background kill — confirm session restoration works
3. Verify `TimeAuthority.hasSuspectDrift()` response to date/time changes

---

### Motorola (near-stock Android)

**Battery optimization:** Light. Closest to AOSP behavior of any major OEM.

**Auth impact:** Generally good. Standard Android lifecycle applies.

**Known quirks:**
- Older Moto G series devices (G30, G50) have low RAM (4 GB). WebView renderer is more likely to be killed under memory pressure during extended sessions.
- GPS/network location accuracy is lower — relevant only to walking detection, not auth.

**Recommended testing:**
1. Run 24-hour stability test on Moto G series
2. Trigger low-memory pressure (open many apps) and verify auth recovery

---

### OnePlus / OxygenOS (OPX series)

**Battery optimization:** Medium. "Battery Optimization" and "Background App Management" must be tested individually.

**Auth impact:** Similar to stock Android but with faster RAM management.

**Known quirks:**
- OxygenOS aggressive RAM management can kill app during token refresh if refresh takes >2s
- `AuthSessionManager` retry backoff (5s, 10s, 20s) will survive this: the next foreground resume triggers `onResume()` and reschedules.

**Recommended testing:**
1. Open 20+ apps → verify auth runtime survives RAM reclaim
2. Simulate network reconnect during refresh

---

### Pixel (Stock Android / GrapheneOS)

**Battery optimization:** Standard AOSP. Most predictable lifecycle.

**Auth impact:** Generally excellent. Use as baseline reference device.

**Known quirks:**
- GrapheneOS restricts Google Play Services access — `GoogleAuthAdapter.signIn()` may fail. The runtime falls back to web OAuth correctly.
- Android 14+ restricts background activity launches — this does not affect auth (no background activity launch required).

**Recommended testing:**
1. Verify web OAuth fallback path works end-to-end on Pixel
2. Confirm push subscription survives background kill on Pixel 6+

---

## Lifecycle Timing Reference

| Event | Samsung | Xiaomi | Motorola | OnePlus | Pixel |
|-------|---------|--------|----------|---------|-------|
| Background kill (aggressive battery) | ~5 min | ~2 min | ~15 min | ~8 min | Rarely |
| WebView renderer kill (normal memory) | 15 min | 10 min | 30 min | 20 min | 45 min |
| Clock drift per hour (idle) | <1s | <5s | <1s | <1s | <0.5s |
| Google Play Services startup | Fast | Slow on MIUI | Fast | Fast | Fast |
| App startup latency (cold) | 400–800ms | 600–1200ms | 350–700ms | 380–750ms | 300–550ms |

---

## Auth Runtime Recovery Checklist (per device)

Before declaring production-ready on a new device:

- [ ] Cold start → sign-in completes → `FSM=SIGNED_IN`
- [ ] Sign-in → background 30 min → foreground → `FSM=SIGNED_IN` (vault restore + refresh)
- [ ] Network offline during restore → `FSM=OFFLINE_RECOVERY` → reconnect → `FSM=SIGNED_IN`
- [ ] Manual clock advance 2 hours → `TimeAuthority.hasSuspectDrift()=true` → session still functional
- [ ] Force-kill process during JWT refresh → restart → vault restore succeeds
- [ ] Low memory pressure during session → WebView recreation → `BrowserRuntimeMonitor` fires → recovery completes
- [ ] 24-hour uptime → refresh chains intact → no orphaned timers → memory stable

---

## Validation Tooling

Enable the `AuthRuntimeOverlay` (dev builds only) to observe live FSM state, clock drift, Clerk runtime status, and active refresh chain during device testing.

Run `runAllChaosScenarios(AuthRuntime.instance)` from the browser console to execute all 14 deterministic failure scenarios.

Run `printAuthStateTransitionReport()` and `printRefreshCorrectnessReport(AuthRuntime.instance)` to validate FSM and refresh invariants at any point during a device session.
