#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# android-setup.sh
# Run this ONCE after `npx cap add android` to install the native alarm files.
# ─────────────────────────────────────────────────────────────────────────────

set -e

# Cross-platform sed -i: BSD sed (macOS) requires an explicit backup extension
# (even an empty one), while GNU sed (Linux) does not accept one.
sedi() {
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_JAVA="$SCRIPT_DIR/android/app/src/main/java/com/sitstand/timer"
SRC="$SCRIPT_DIR/android-src"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Sit+Stand Timer — Android alarm setup        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Verify android/ exists ────────────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/android" ]; then
  echo "❌  android/ folder not found."
  echo "    Run 'npx cap add android' first, then re-run this script."
  exit 1
fi

# ── 2. Copy Kotlin source files ──────────────────────────────────────────────
echo "▸ Copying native Kotlin files to $ANDROID_JAVA …"
cp "$SRC/AlarmManagerPlugin.kt"    "$ANDROID_JAVA/"
cp "$SRC/AlarmReceiver.kt"         "$ANDROID_JAVA/"
cp "$SRC/AlarmFullScreenActivity.kt" "$ANDROID_JAVA/"
echo "  ✓ AlarmManagerPlugin.kt"
echo "  ✓ AlarmReceiver.kt"
echo "  ✓ AlarmFullScreenActivity.kt"

# ── 3. Patch AndroidManifest.xml ─────────────────────────────────────────────
MANIFEST="$SCRIPT_DIR/android/app/src/main/AndroidManifest.xml"
echo ""
echo "▸ Patching $MANIFEST …"

# Helper: insert text after first occurrence of a pattern
insert_after() {
  local pattern="$1"
  local text="$2"
  local file="$3"
  # Only insert if the marker text isn't already there
  if grep -qF "$(printf '%s' "$text" | head -1)" "$file"; then
    echo "  (already present — skipping)"
    return
  fi
  # Write insertion text to a temp file so awk can read it line-by-line.
  # Passing multi-line strings via -v breaks BSD awk (macOS); getline works everywhere.
  local tmpins
  tmpins=$(mktemp)
  printf '%s\n' "$text" > "$tmpins"
  awk -v pat="$pattern" -v insfile="$tmpins" '
    !done && $0 ~ pat {
      print
      while ((getline line < insfile) > 0) print line
      done=1
      next
    }
    { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  rm -f "$tmpins"
}

PERMISSIONS='    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />
    <uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />'

COMPONENTS='        <activity
            android:name=".AlarmFullScreenActivity"
            android:showWhenLocked="true"
            android:turnScreenOn="true"
            android:exported="false"
            android:excludeFromRecents="true"
            android:launchMode="singleTop"
            android:screenOrientation="portrait"
            android:theme="@style/Theme.AppCompat.NoActionBar" />
        <receiver
            android:name=".AlarmReceiver"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
            </intent-filter>
        </receiver>'

# Insert permissions after <manifest ...>
insert_after '<manifest' "$PERMISSIONS" "$MANIFEST"

# Insert components before </application>
if ! grep -q "AlarmFullScreenActivity" "$MANIFEST"; then
  # Write insertion text to a temp file — embedding multi-line variables
  # directly in a sed command breaks on macOS BSD sed and is fragile everywhere.
  _tmpcmp=$(mktemp)
  printf '%s\n    </application>\n' "$COMPONENTS" > "$_tmpcmp"
  awk -v insfile="$_tmpcmp" '
    /^[[:space:]]*<\/application>/ && !done {
      while ((getline line < insfile) > 0) print line
      done=1; next
    }
    { print }
  ' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
  rm -f "$_tmpcmp"
  echo "  ✓ Activity + Receiver entries added"
else
  echo "  ✓ Activity + Receiver already present"
fi
echo "  ✓ Permissions added"

# ── 4. Fix Android window background (prevent opaque-white overlay) ──────────
# The default Capacitor styles.xml leaves windowBackground white, which sits
# on top of the WebView as an opaque native layer until explicitly cleared.
# We set it to the app background colour so no white flash ever occurs, even
# on devices where SplashScreen.hide() fires slightly late.
echo ""
echo "▸ Patching styles.xml window background …"

STYLES="$SCRIPT_DIR/android/app/src/main/res/values/styles.xml"
COLORS="$SCRIPT_DIR/android/app/src/main/res/values/colors.xml"

if [ ! -f "$STYLES" ]; then
  echo "  ⚠  $STYLES not found — skipping theme patch."
else
  if grep -q "sitstand_background" "$STYLES"; then
    echo "  ✓ windowBackground already patched"
  else
    # Add app background color to colors.xml (create if missing)
    if [ ! -f "$COLORS" ]; then
      echo '<?xml version="1.0" encoding="utf-8"?><resources></resources>' > "$COLORS"
    fi
    if ! grep -q "sitstand_background" "$COLORS"; then
      sedi 's|</resources>|    <color name="sitstand_background">#f9f5f0</color>\n</resources>|' "$COLORS"
      echo "  ✓ Added sitstand_background color (#f9f5f0)"
    fi

    # Inject windowBackground into AppTheme.NoActionBar
    if grep -q 'AppTheme.NoActionBar' "$STYLES"; then
      sedi 's|\(name="AppTheme.NoActionBar"[^>]*>\)|\1\n        <item name="android:windowBackground">@color/sitstand_background</item>|' "$STYLES"
      echo "  ✓ windowBackground set to #f9f5f0 in AppTheme.NoActionBar"
    else
      echo "  ⚠  AppTheme.NoActionBar not found — add manually:"
      echo '     <item name="android:windowBackground">@color/sitstand_background</item>'
    fi
  fi
fi

# ── 5. Patch MainActivity to register the plugin ─────────────────────────────
echo ""
echo "▸ Registering AlarmManagerPlugin in MainActivity …"

MAIN="$ANDROID_JAVA/MainActivity.kt"
if [ ! -f "$MAIN" ]; then
  echo "  ⚠  $MAIN not found — you may need to register the plugin manually."
  echo "     See CAPACITOR_SETUP.md for instructions."
else
  if grep -q "AlarmManagerPlugin" "$MAIN"; then
    echo "  ✓ Plugin already registered"
  else
    # Replace the class body opening line with registration added
    sedi 's/class MainActivity : BridgeActivity() {/class MainActivity : BridgeActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        registerPlugin(AlarmManagerPlugin::class.java)\n        super.onCreate(savedInstanceState)\n    }/' "$MAIN"

    # Add import if missing
    if ! grep -q "import android.os.Bundle" "$MAIN"; then
      sedi '1s/^/import android.os.Bundle\n/' "$MAIN"
    fi

    echo "  ✓ Plugin registered"
  fi
fi

# ── 6. Copy app icons ────────────────────────────────────────────────────────
# Pre-generated from public/favicon.svg (same icon as the PWA).
# Overwrites Capacitor's default robot launcher icons with the real branding.
echo ""
echo "▸ Installing app icons …"

ICONS_SRC="$SCRIPT_DIR/android-icons"
RES="$SCRIPT_DIR/android/app/src/main/res"

if [ ! -d "$ICONS_SRC" ]; then
  echo "  ⚠  android-icons/ not found — skipping icon copy."
else
  for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    DEST="$RES/mipmap-$density"
    mkdir -p "$DEST"
    cp "$ICONS_SRC/mipmap-$density/ic_launcher.png"            "$DEST/"
    cp "$ICONS_SRC/mipmap-$density/ic_launcher_round.png"      "$DEST/"
    cp "$ICONS_SRC/mipmap-$density/ic_launcher_foreground.png" "$DEST/"
    echo "  ✓ mipmap-$density"
  done

  # Adaptive icon XML (Android 8.0+)
  ANYDPI="$RES/mipmap-anydpi-v26"
  mkdir -p "$ANYDPI"
  cp "$ICONS_SRC/mipmap-anydpi-v26/ic_launcher.xml"       "$ANYDPI/"
  cp "$ICONS_SRC/mipmap-anydpi-v26/ic_launcher_round.xml" "$ANYDPI/"
  echo "  ✓ mipmap-anydpi-v26 (adaptive XML)"

  # Background color for adaptive icon
  COLORS="$SCRIPT_DIR/android/app/src/main/res/values/colors.xml"
  if [ ! -f "$COLORS" ]; then
    echo '<?xml version="1.0" encoding="utf-8"?><resources></resources>' > "$COLORS"
  fi
  if ! grep -q "ic_launcher_background" "$COLORS"; then
    sedi 's|</resources>|    <color name="ic_launcher_background">#FF3C00</color>\n</resources>|' "$COLORS"
    echo "  ✓ ic_launcher_background color added (#FF3C00)"
  else
    echo "  ✓ ic_launcher_background already present"
  fi
fi

# ── 7. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  Native alarm files installed successfully!      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  npm run build:android"
echo "  npx cap sync android"
echo "  npx cap open android   ← build & run in Android Studio"
echo ""
echo "On first launch, the app will ask for:"
echo "  • Notification permission (POST_NOTIFICATIONS)"
echo "  • Exact alarm permission (SCHEDULE_EXACT_ALARM / Alarms & reminders)"
echo "  • Battery optimisation exemption"
echo ""
