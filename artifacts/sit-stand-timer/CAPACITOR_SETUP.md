# Capacitor Android Setup

## First-time setup

Run these commands from the `artifacts/sit-stand-timer/` directory:

```bash
# 1. Build the web assets for Android (BASE_PATH=/ is required)
npm run build:android

# 2. Add the Android platform (first time only)
npx cap add android

# 3. Sync web assets into the Android project
npx cap sync android

# 4. Open in Android Studio to build and install
npx cap open android
```

In Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK** to produce a debug APK,
or use **Run** to install directly on a connected device.

## Subsequent builds

After code changes:

```bash
npm run build:android
npx cap sync android
```

Then rebuild in Android Studio.

## Enable full-screen lock-screen notifications

For the notification to splash over the lock screen (like an alarm clock), add this
permission to `android/app/src/main/AndroidManifest.xml` inside the `<manifest>` tag:

```xml
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

> **Note:** On Android 14+, `USE_FULL_SCREEN_INTENT` is restricted. The system only
> grants it automatically to apps in the "Alarms & reminders" category. You can request
> it via `Settings → Apps → Special app access → Alarms & reminders`.
> For a medical/health utility like this, it is routinely granted.

## Notification behaviour

- **Sitting mode:** notifications scheduled at `sittingAlertMinutes` + each reminder interval
- **Standing mode:** notifications scheduled at `standingMinMinutes` through `standingMaxMinutes`
- All pending notifications are **cancelled and rescheduled** on every mode switch
- Notifications fire even if the app is completely closed

## App ID

`com.sitstand.timer` — change in `capacitor.config.ts` before publishing to Play Store.
