# Adding a New Protocol Context

This guide explains how to add a new alternating two-state protocol timer
(e.g. Ice Therapy, Compression Therapy, Medication Cycle) as an independent
parallel context **without touching TimerContext or any existing file**.

See `IceTherapyContext.tsx` for a complete worked example.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                        UI Layer                         │
│  TimerPage   BladderPage   IceTherapyPage   MedPage …   │
└────────┬──────────┬──────────────┬───────────────┬──────┘
         │          │              │               │
┌────────▼──────────▼──────────────▼───────────────▼──────┐
│                    Context Layer                         │
│  TimerContext  BladderContext  IceTherapyContext  …       │
│   (untouched)   (untouched)    (new, independent)        │
└────────┬──────────┬──────────────┬───────────────┬──────┘
         │          │              │               │
┌────────▼──────────▼──────────────▼───────────────▼──────┐
│               Shared Protocol Utilities                   │
│   src/lib/protocol/utils.ts  (pure functions, no state)  │
└──────────────────────────────────────────────────────────┘
         │                        │
┌────────▼──────────┐   ┌─────────▼────────────────────────┐
│   Browser APIs    │   │   Capacitor / Native APIs         │
│  Notification     │   │   AlarmManagerPlugin              │
│  ServiceWorker    │   │   (optional, for Android)         │
└───────────────────┘   └──────────────────────────────────┘
```

Each protocol is a **self-contained React context** with its own:
- State management (phase, elapsed, countdown)
- Timer lifecycle (start / stop / resume)
- localStorage persistence (single JSON blob)
- Notification scheduling (SW + optional native alarm)

Protocols run in **parallel** — they do not share state or communicate with
each other unless you explicitly wire them together.

---

## Step-by-step: adding a new protocol

### 1. Define your protocol constants

```typescript
// src/contexts/MyProtocolContext.tsx
const MY_PROTOCOL_ID = "my-protocol";       // must be globally unique
const DEFAULT_PHASE_A_MINUTES = 20;
const DEFAULT_PHASE_B_MINUTES = 20;
```

### 2. Define your phase type

```typescript
export type MyPhase = "phaseA" | "phaseB" | "idle";
```

### 3. Define the persisted state shape

Extend `ProtocolPersistedState` from `src/lib/protocol/types.ts`:

```typescript
import type { ProtocolPersistedState } from "@/lib/protocol/types";

interface MyProtocolState extends ProtocolPersistedState<MyPhase> {
  phaseADurationMinutes: number;
  phaseBDurationMinutes: number;
}
```

### 4. Create the storage helpers

```typescript
import { makeStorageHelpers } from "@/lib/protocol/utils";

const STORAGE_KEY = `protocol:${MY_PROTOCOL_ID}:state`;

const DEFAULT_STATE: MyProtocolState = {
  version: 1,
  enabled: false,
  phase: "idle",
  phaseStartedAt: null,
  nextTransitionAt: null,
  phaseADurationMinutes: DEFAULT_PHASE_A_MINUTES,
  phaseBDurationMinutes: DEFAULT_PHASE_B_MINUTES,
};

const store = makeStorageHelpers<MyProtocolState>(STORAGE_KEY, DEFAULT_STATE);
```

### 5. Define the context value interface

Extend `ProtocolContextShape`:

```typescript
import type { ProtocolContextShape } from "@/lib/protocol/types";

interface MyProtocolContextValue extends ProtocolContextShape<MyPhase> {
  phaseADurationMinutes: number;
  phaseBDurationMinutes: number;
  setPhaseADuration: (minutes: number) => void;
  setPhaseBDuration: (minutes: number) => void;
  skipToNext: () => void;
}
```

### 6. Implement the Provider

Follow `IceTherapyContext.tsx` exactly. Key points:

- Use `useRef` for values read inside `setTimeout` callbacks to avoid
  stale-closure bugs (same pattern as TimerContext and BladderContext).
- Call `cancelSWNotification()` before every `scheduleSWNotification()` to
  prevent duplicate SW alerts.
- Persist on every state change via a `useEffect` → `store.save(...)`.
- Restore from the persisted deadline on mount, not just from duration.
- The JS `setTimeout` + SW notification are two independent delivery paths —
  both must be cancelled together on stop/toggle-off.

### 7. Implement the page

Copy `BladderPage.tsx` as a template. Key UI elements:
- Toggle card (on/off)
- Countdown display
- Phase indicator (color-coded)
- Duration sliders (optional)
- Response / confirmation card (if the protocol requires user acknowledgement)

### 8. Wire into App.tsx

```tsx
// In App.tsx — add the Provider around your route tree:
import { IceTherapyProvider } from "@/contexts/IceTherapyContext";

// Wrap alongside other providers:
<IceTherapyProvider>
  {/* existing providers */}
</IceTherapyProvider>
```

```tsx
// Add a route:
<Route path="/ice-therapy" component={IceTherapyPage} />
```

### 9. Add navigation entry point

Options:
- A card in `SettingsPage.tsx` linking to the new route
- A `<Link>` in `BladderPage.tsx` as a peer link
- A new tab in `BottomNav.tsx` (only if used frequently enough to warrant a tab)

---

## Notification wiring

### Web PWA (service worker)

`scheduleSWNotification` and `cancelSWNotification` in `utils.ts` use the
existing `SCHEDULE_NOTIFICATION` / `CANCEL_SCHEDULED_NOTIFICATION` SW message
handlers defined in `sw.ts`. No changes to `sw.ts` are needed.

Pass a unique `tag` per protocol so cancellations don't stomp each other:

```typescript
scheduleSWNotification({
  delayMs: ...,
  title: "...",
  body: "...",
  tag: `${MY_PROTOCOL_ID}-phaseA`,  // unique per protocol+phase
});
```

### Android native (AlarmManager)

For protocols that must survive Doze mode, app-kill, and lock screen, use
the `AlarmManagerPlugin` via `nativeNotifications.ts`:

1. Add new alarm ID constants in `nativeNotifications.ts`:
   ```typescript
   const MY_PROTOCOL_BASE = 6000;   // pick a range not used by other protocols
   ```
2. Add `scheduleNativeMyProtocolAlarm` and `cancelNativeMyProtocolAlarm`
   functions modelled on `scheduleNativeBladderAlarm` /
   `cancelNativeBladderAlarm`.
3. Call them in your context alongside the JS timer:
   ```typescript
   if (isNativePlatform()) {
     void scheduleNativeMyProtocolAlarm(remainingMs, durationMinutes);
   }
   ```
4. Cancel on stop/toggle-off:
   ```typescript
   if (isNativePlatform()) {
     void cancelNativeMyProtocolAlarm().catch(() => {});
   }
   ```

**Always cancel the native alarm in both `stop()` and `pause()`.**
This is the exact bug that was fixed in BladderContext — never omit it.

---

## Persistence registration checklist

- [ ] Single JSON blob under `protocol:<id>:state`
- [ ] `version: 1` field for future migration support
- [ ] `enabled`, `phase`, `phaseStartedAt`, `nextTransitionAt` always written
- [ ] Read on mount via `store.load()` — use `useState(() => store.load())`
      so the initial render uses persisted values without a flash
- [ ] Clear the stored deadline when toggling off (`nextTransitionAt: null`)
- [ ] Restore from the absolute `nextTransitionAt` epoch-ms, not from duration,
      so a 5-minute-old deadline resumes with 15 minutes remaining (not 20)

---

## LocalStorage key conventions

| Prefix                    | Used for                              |
|---------------------------|---------------------------------------|
| `protocol:<id>:state`     | Full persisted state blob             |
| `protocol:<id>:<setting>` | Per-setting override (optional)       |

Existing keys **not** to collide with:
- `sit-stand-timer-state-v1`     (TimerContext)
- `sit-stand-offline-queue`      (TimerContext)
- `sit-stand-goal-notif`         (TimerContext)
- `bladder_*`                    (BladderContext)
- `silentReminders`              (SettingsPage)
- `sit-stand-sound-enabled`      (SettingsPage)
- `autoDetectWalking`            (SettingsPage)
- `bladder_sleep_*`              (BladderContext)

---

## Validation checklist before activating a new protocol

- [ ] Toggle on starts the phase-A timer from now
- [ ] Toggle off cancels JS timer + SW notification + native alarm
- [ ] Phase transitions fire automatically and restart the opposite phase
- [ ] Killing the app and reopening restores the correct phase + remaining time
- [ ] Notification fires when a phase ends (both foreground and background)
- [ ] No interaction with sit-stand timer (modes, sessions, stats are untouched)
- [ ] No interaction with BladderContext
- [ ] `pnpm --filter @workspace/sit-stand-timer run typecheck` passes
- [ ] APK build succeeds (`pnpm run build:android && npx cap sync android`)
