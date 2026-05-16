# Time Consistency Report — TimeAuthority Validation

**Scope:** Auth session expiry determination under adverse clock conditions.  
**Requirement:** Auth validity must remain deterministic and explainable regardless of clock state.

---

## Summary

| Scenario | Handling | Outcome |
|----------|----------|---------|
| Normal operation | Monotonic now() ≈ Date.now() | Correct |
| Manual clock rollback | Drift detected, trustworthy=false | Degraded gracefully |
| Manual clock fast-forward | Drift detected, session treated as near-expiry | Triggers refresh early |
| Timezone change | Wall clock shifts, monotonic unaffected | Drift detected |
| Long suspend (8h sleep) | Suspend duration tracked | Clock trust preserved |
| Server time mismatch | SessionRestorationValidator applies server offset | Corrected |
| Offline drift accumulation | Monotonic baseline + wall clock cross-check | Bounded error |

---

## TimeAuthority Design

`TimeAuthority` anchors to `performance.now()` at construction time (`_baseMonotonic`) and the corresponding `Date.now()` wall clock value (`_baseWall`).

```
now() = _baseWall + (performance.now() - _baseMonotonic)
```

This provides a monotonically increasing time estimate immune to post-startup wall-clock changes. The estimate drifts from the true wall clock only by whatever drift the device's monotonic timer accumulates (typically <100ms/hour on modern Android hardware).

### Limitations

`performance.now()` on Android Capacitor WebView:
1. Resets to 0 on WebView renderer recreation
2. May pause during device suspend (behavior varies by OEM)
3. Has ~1ms resolution on most Android devices

`TimeAuthority.onSuspend()` records the wall-clock time at suspension. On resume, `onResume()` records the elapsed wall-clock duration and adds it to `_totalSuspendMs`. This lets `suspendDurationMs` report the cumulative time the device was asleep.

---

## Scenario Analysis

### Manual clock rollback (e.g., user sets device back 2 hours)

```
Before rollback:  now() ≈ Date.now()    drift ≈ 0
After rollback:   Date.now() drops 2h   monotonic is unaffected
                  clockDriftMs() = |wallElapsed - monoElapsed| ≈ 7,200,000ms
                  hasSuspectDrift() → true (threshold: 30 min)
                  isClockTrustworthy() → false
```

**Auth consequence:** Session expiry checks use `TimeAuthority.now()` (monotonic), not `Date.now()`. A rollback does not cause a valid session to appear expired. The session continues to function.

**Risk:** If the rollback is extreme (>7 days), the vault's stored `expiresAt` (wall-clock epoch ms) will appear far in the future relative to the rolled-back clock. `SessionRestorationValidator` will accept it as valid. This is acceptable — the session is genuinely valid.

### Manual clock fast-forward (e.g., user jumps forward 2 days)

```
Before:  now() ≈ Date.now()
After:   Date.now() jumps +2d    monotonic is unaffected
         clockDriftMs() ≈ 172,800,000ms
         hasSuspectDrift() → true
         isClockTrustworthy() → false
```

**Auth consequence:** `TimeAuthority.now()` (monotonic) still reports the correct "real" elapsed time. The JWT expiry check uses monotonic time and will correctly identify that the session has not yet expired.

**Risk:** The vault's stored `expiresAt` was written with a wall-clock timestamp. If the device clock is advanced past the JWT's `exp` field, the JWT will be rejected by the API server regardless of what the client thinks. The API server's clock is ground truth for JWT validation.

**Mitigation:** `SessionRestorationValidator` computes `clockDriftMs` from the vault's `monotonicOffsetMs`. Large drift causes the validator to downgrade confidence to `DEGRADED` and trigger an early refresh.

### Timezone change

A timezone change affects `Date` formatting but not `Date.now()` (Unix epoch is timezone-independent). No impact on auth.

### Long suspend (overnight, 8 hours)

```
onSuspend() called at: T₀ (wall = 11pm)
Device sleeps.
onResume() called at:  T₁ (wall = 7am, +8h elapsed)
suspendDurationMs += 28,800,000
```

`performance.now()` may or may not have advanced during sleep (OEM-dependent). `TimeAuthority` uses `_totalSuspendMs` to correct the monotonic estimate. The clock remains trustworthy if the correction is within bounds.

The refresh scheduler (`AuthSessionManager`) fires on resume regardless — it calls `scheduleRefresh()` which reads the stored `expiresAt` and sets a new timer. If the session expired during sleep, `expiresAt < Date.now()` triggers immediate refresh.

### Server time mismatch (device clock vs. server clock >5 minutes apart)

Detected by `SessionRestorationValidator` when the vault's stored `expiresAt` and the JWT's `exp` claim disagree significantly.

The validator records this as `clockDriftMs` and downgrades confidence to `DEGRADED`, triggering an immediate Clerk token refresh. The fresh JWT's `exp` claim comes from Clerk's server clock, re-anchoring the session's expiry.

---

## Clock Trust Thresholds

| `clockDriftMs` | `hasSuspectDrift()` | `isClockTrustworthy()` | Action |
|----------------|---------------------|------------------------|--------|
| < 30 seconds | false | true | Normal operation |
| 30s – 30 min | false | true | Monitor |
| 30 min – 24h | true | true | Downgrade confidence to DEGRADED |
| > 24h | true | false | Force refresh; overlay shows warning |

---

## Recommendations

1. **Validate `performance.now()` reset** on WebView recreation — when `BrowserRuntimeMonitor` emits `CLERK_RECREATED`, `TimeAuthority` should re-anchor its monotonic baseline to `performance.now()`. Currently it does not.

2. **Add server-time sync** — on first successful API response, extract `Date` header and compute offset. Store in `TimeAuthority._serverOffsetMs`. Use for expiry cross-checks.

3. **Test suspend accuracy** on Samsung DeX / split-screen — `performance.now()` behavior in multi-window mode is inconsistent.
