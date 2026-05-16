# Long-Run Stability Report — Auth Runtime Endurance Analysis

**Requirement:** Auth runtime must remain stable across 24-hour sessions with repeated  
suspend/resume, intermittent offline, and multiple refresh cycles.

---

## Endurance Scenarios

### Scenario 1: 24-Hour Continuous Session

**Profile:**
- Device awake and connected throughout
- Token refresh every 55 minutes (Clerk session duration)
- 26 refresh cycles in 24 hours
- App in foreground for business hours, background at night

**Expected behavior:**
- Each refresh creates one `RefreshChain`, marked SUCCEEDED → moved to history
- 26 chains in history after 24h
- `AuthStateStore.session.jwt` always current
- `AuthStateStore.session.expiresAt` advancing correctly
- FSM stays in SIGNED_IN throughout
- Zero DEGRADED or EXPIRED states

**Risk factors:**
- History unbounded growth: 26 × ~500 bytes = ~13 KB. Acceptable for 24h.
- Timer drift: `setTimeout` on Android can drift 50–200ms over 24h. No auth impact — jitter on refresh timing, not on expiry.

### Scenario 2: Repeated Suspend/Resume (8h overnight)

**Profile:**
- Device suspended at 11pm, resumed at 7am
- JWT expired during sleep (55 min expiry)
- Network available on resume

**Expected behavior:**
1. `onSuspend()` records suspension time
2. Process may be killed (Samsung, Xiaomi)
3. On foreground: `AuthRuntime.boot()` runs as fresh process
4. `ProcessRecoveryCoordinator.assess()` → `PROCESS_RECOVERY`
5. `vault.load()` retrieves last session metadata
6. `SessionRestorationValidator.validate()` → `REFRESH_REQUIRED` (expired)
7. `clerk.waitForReady()` → ready
8. `clerk.refreshToken()` → new JWT
9. `_establishSession()` → `FSM=SIGNED_IN`
10. `scheduleRefresh()` → new 55-min timer

**Total recovery time:** ~1200–1800ms (vault + Clerk init + refresh network call)

### Scenario 3: Intermittent Offline (30-minute outage)

**Profile:**
- Network drops during JWT refresh
- Offline for 30 minutes
- Network restores

**Expected behavior:**
1. `_doRefresh()` detects `!navigator.onLine` → `chain.recordFailure("OFFLINE")`
2. `_scheduleRetry()` → retry 1 in 5s, retry 2 in 10s, retry 3 in 20s
3. All retries fail (still offline) → `chain.failChain("max-retries-3")`
4. `AuthRecoveryCoordinator` does not auto-retry (recovery lock active)
5. App remains in `SIGNED_IN` with stale JWT until reconnect
6. `AuthLifecycleCoordinator._onNetworkReconnect()` → `recoverExpired()` or reschedule
7. On reconnect: `scheduleRefresh()` restarts cycle with fresh chain

**Risk:** Stale JWT returned to API calls during 30-minute outage causes 401 errors.  
**Mitigation:** API client should retry with `refreshToken()` on 401. Current implementation relies on Clerk's built-in retry logic.

### Scenario 4: 100 Suspend/Resume Cycles

**Profile:**
- User charges device overnight, phone on and off 100 times over a week
- Each wake triggers `AuthLifecycleCoordinator._onForegroundResume()`

**Expected behavior:**
- `LifecycleRecoveryLock` prevents recovery storms
- `RefreshChainCoordinator.expireStaleChains()` clears orphans on each resume
- `onSuspend()/onResume()` correctly tracks lifecycle interruptions
- No timer accumulation (each `scheduleRefresh()` cancels prior timer)

**Stability check:** History array after 100 resumes × 2 refreshes/day × 7 days = ~14 additional chains. Memory: ~7 KB. No issue.

### Scenario 5: Delayed Transport Recovery (Clerk 30s unavailable)

**Profile:**
- Network restored but Clerk FAPI temporarily unreachable
- `clerk.waitForReady(5000)` times out
- Boot completes in `DEGRADED` phase
- 30s later, Clerk FAPI becomes reachable

**Expected behavior:**
1. Boot → `FSM=DEGRADED` (Clerk not ready within 5s)
2. `capabilities.clerkTransportAvailable = false`
3. Session stored with empty JWT → API calls fail with 401
4. `ClerkRuntimeRegistry` continues polling at 50ms
5. When Clerk loads: `signal("CLERK_RUNTIME_AVAILABLE")`
6. `AuthCapabilityRegistry` updates `clerkTransportAvailable=true`
7. App does NOT automatically refresh — waiting for lifecycle event to trigger recovery
8. User interaction (foreground resume, manual retry) triggers `recoverExpired()`

**Gap:** There is no automatic recovery trigger when `clerkTransportAvailable` becomes true after degraded boot. The app waits for the next lifecycle event.  
**Recommendation:** `AuthCapabilityRegistry` subscriber in `AuthLifecycleCoordinator` — when `clerkTransportAvailable` changes false→true, trigger `recoverExpired()`.

---

## Leak Detection Analysis

### Memory

| Source | Growth Rate | Mitigation Status |
|--------|-------------|-------------------|
| RefreshChainCoordinator.history | ~500 bytes/55min | ✅ Capped at MAX_HISTORY=20 (~10 KB max) |
| AuthDiagnosticsJournal._events | Fixed 100 × ~150 bytes = 15 KB | ✅ Capped |
| AuthOperationQueue | O(1) steady state | ✅ |
| ClerkRuntimeRegistry listeners | O(subscriber count) | ✅ Unsubscribe on detach |
| BrowserRuntimeMonitor listeners | O(handler count) | ✅ Cleaned up on detach |

**Status:** Already implemented — `_terminateChain()` enforces `MAX_HISTORY = 20`. Max memory: ~10 KB. No action required.

### Timer Leak

`AuthSessionManager` holds one `setTimeout` handle. `cancelRefresh()` always clears it before creating a new one. `destroy()` clears it unconditionally. No timer leak possible.

`ClerkRuntimeRegistry` holds one `setInterval` handle. Already self-cancels when Clerk becomes available OR when `timeoutMs` (10s default) elapses via `_onTimeout()`. No leak possible — watcher always terminates within 10 seconds.

### Stale Locks

`LifecycleRecoveryLock` uses a `setTimeout` to auto-release. If the process dies while the lock is held, it is silently dropped on restart (lock is in-memory). Correct behavior.

---

## Stability Certification Criteria

Before certifying long-run stability, verify:

- [ ] 24-hour session: no DEGRADED or EXPIRED states observed, memory stable
- [ ] 8-hour suspend: session restored < 2000ms after foreground, FSM=SIGNED_IN
- [ ] 30-minute offline outage: recovery completes < 5s after network restore
- [ ] 100 resume cycles: history array < 200 entries, no orphaned timers
- [x] `RefreshChainCoordinator.history` capped at MAX_HISTORY=20 (already implemented)
- [x] `ClerkRuntimeRegistry` watcher max-timeout implemented (10s, already implemented)
- [ ] Automatic recovery on clerkTransportAvailable change implemented (recommendation)
