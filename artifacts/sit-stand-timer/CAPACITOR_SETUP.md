# Capacitor Android Setup — Full-Screen Alarm Reminders

## What this does

When a posture reminder fires (e.g. after 45 minutes of sitting), the app:

- **Wakes the screen** even if it is off and the phone is locked
- **Shows a full-screen activity** (like an alarm clock or incoming call) above the lock screen
- **Plays the device alarm ringtone** on a loop
- **Vibrates continuously** until dismissed
- Provides **Dismiss** and **Snooze 5 min** buttons
- Reschedules all alarms via `AlarmManager.setExactAndAllowWhileIdle()` so they survive Android Doze mode

---

## First-time setup (run once)

Run all commands from `artifacts/sit-stand-timer/`:

```bash
# 1. Build the web assets for Android
npm run build:android

# 2. Add the Android platform (first time only)
npx cap add android

# 3. Install native alarm files and patch AndroidManifest + MainActivity
bash android-setup.sh

# 4. Sync web assets into the Android project
npx cap sync android

# 5. Open Android Studio
npx cap open android
```

In Android Studio: **Run ▶** to install on a connected device, or  
**Build → Build Bundle(s)/APK(s) → Build APK** to produce a debug APK.

---

## Subsequent builds (after code changes)

```bash
npm run build:android
npx cap sync android
# Rebuild / re-run in Android Studio
```

---

## Permissions the app will request at runtime

| Permission | Why |
|---|---|
| `POST_NOTIFICATIONS` | Show heads-up notifications (Android 13+) |
| `SCHEDULE_EXACT_ALARM` / Alarms & reminders | Fire alarms at exact times, even in Doze |
| Battery optimisation exemption | Prevent Android from killing the alarm scheduler |

The app asks for all three on first launch inside `TimerPage` (Enable Notifications button).

To grant the exact-alarm permission manually:  
**Settings → Apps → Sit+Stand Timer → Alarms & reminders → Allow**

To exempt from battery optimisation:  
**Settings → Apps → Sit+Stand Timer → Battery → Unrestricted**

---

## How the alarm stack works

```
JS timer (TimerContext)
  └─ AlarmManager plugin (Capacitor bridge)
       └─ AlarmManagerPlugin.kt
            └─ AlarmManager.setExactAndAllowWhileIdle()
                 └─ AlarmReceiver.kt  (BroadcastReceiver)
                      ├─ Shows FullScreenIntent notification
                      └─ Starts AlarmFullScreenActivity.kt
                           ├─ FLAG_SHOW_WHEN_LOCKED
                           ├─ FLAG_TURN_SCREEN_ON
                           ├─ Looping alarm ringtone (MediaPlayer)
                           ├─ Continuous vibration (VibrationEffect)
                           ├─ Dismiss → stops alarm
                           └─ Snooze → reschedules 5 min via AlarmManager
```

Alarms survive:
- App closed ✅
- Phone locked ✅
- Screen off ✅
- Android Doze mode ✅ (via `setExactAndAllowWhileIdle`)
- Reboot ✅ (AlarmReceiver listens for `BOOT_COMPLETED`)

---

## Native files reference

| File | Location after `android-setup.sh` |
|---|---|
| `AlarmManagerPlugin.kt` | `android/app/src/main/java/com/sitstand/timer/` |
| `AlarmReceiver.kt` | same |
| `AlarmFullScreenActivity.kt` | same |
| `android-src/AndroidManifest.additions.xml` | Reference only (applied by setup script) |

---

## App ID

`com.sitstand.timer` — set in `capacitor.config.ts`.  
Change this before publishing to the Play Store.
