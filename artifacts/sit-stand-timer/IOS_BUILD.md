# iOS Build — Sit+Stand Timer

## First-time setup (run once on your Mac)

### 1. Register iOS app in Firebase

Go to [Firebase Console → posture-timer project](https://console.firebase.google.com/project/posture-timer-1777533387497/settings/general) →  
**Project settings → Add app → iOS**

| Field | Value |
|---|---|
| Bundle ID | `com.sitstand.timer` |
| App nickname | Sit+Stand Timer iOS |
| App Store ID | (leave blank for now) |

Download the generated **`GoogleService-Info.plist`** and copy it to:

```
artifacts/sit-stand-timer/ios/App/App/GoogleService-Info.plist
```

> This file is gitignored — never commit it.

### 2. Run the iOS setup script

```bash
# From artifacts/sit-stand-timer/
bash ios-setup.sh
```

This reads `REVERSED_CLIENT_ID` from `GoogleService-Info.plist` and patches `Info.plist` with the correct Google Sign-In URL scheme. Run it once — it is idempotent.

### 3. Build web assets

```bash
# From artifacts/sit-stand-timer/
BASE_PATH=/ VITE_API_BASE_URL=https://posture-timer.replit.app \
  npx vite build --config vite.config.ts
```

### 4. Sync and open Xcode

```bash
npx cap sync ios
npx cap open ios
```

### 5. In Xcode

1. Select the **App** target → **Signing & Capabilities**
2. Set your **Team** (Apple Developer account)
3. Connect your iPhone → press **Run ▶**

---

## Subsequent builds (after code changes)

```bash
BASE_PATH=/ VITE_API_BASE_URL=https://posture-timer.replit.app \
  npx vite build --config vite.config.ts
npx cap sync ios
# Rebuild in Xcode (⌘R)
```

---

## Key differences from Android

| | Android | iOS |
|---|---|---|
| Firebase config file | `google-services.json` | `GoogleService-Info.plist` |
| App identity | SHA-1 fingerprint | Bundle ID only |
| URL scheme source | `AndroidManifest.xml` intent filter | `CFBundleURLTypes` in `Info.plist` |
| Package manager | Gradle | Swift Package Manager (auto) |
| Setup script | `android-setup.sh` | `ios-setup.sh` |

---

## URL schemes registered in Info.plist

| Scheme | Purpose |
|---|---|
| `posture-timer://` | Clerk OAuth callback deep link |
| `com.googleusercontent.apps.…` | Google Sign-In redirect (REVERSED_CLIENT_ID) |

---

## Permissions requested

| Permission | Why |
|---|---|
| `NSLocationWhenInUseUsageDescription` | Auto-detect walking speed for walk mode |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | Background walking detection |

Notification permission is requested at runtime (no Info.plist entry needed for iOS 10+).

---

## App ID

`com.sitstand.timer` — set in `capacitor.config.ts`.

---

## Firebase project

Project ID: `posture-timer-1777533387497`  
Project number: `408487352425`  
Console: https://console.firebase.google.com/project/posture-timer-1777533387497
