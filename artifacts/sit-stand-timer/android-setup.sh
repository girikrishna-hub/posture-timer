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
    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
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

# ── 4. Add deep-link intent filter for Clerk OAuth callbacks ─────────────────
# After Google OAuth, Clerk redirects to posture-timer://oauth-callback
# so the WebView can complete sign-in via @capacitor/app's appUrlOpen event.
echo ""
echo "▸ Adding posture-timer:// deep-link scheme to AndroidManifest …"

DEEP_LINK_FILTER='            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="posture-timer" />
            </intent-filter>'

if grep -q 'android:scheme="posture-timer"' "$MANIFEST"; then
  echo "  ✓ Deep-link scheme already present"
else
  # Insert the new intent-filter right after the LAUNCHER intent-filter block
  # that Capacitor generates inside the main <activity>.
  _tmpdf=$(mktemp)
  printf '%s\n' "$DEEP_LINK_FILTER" > "$_tmpdf"
  awk -v insfile="$_tmpdf" '
    /category.LAUNCHER/ && !done {
      print
      # Print the closing </intent-filter> line that follows
      getline; print
      # Then insert the new filter
      while ((getline line < insfile) > 0) print line
      done=1; next
    }
    { print }
  ' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
  rm -f "$_tmpdf"
  echo "  ✓ posture-timer:// scheme added"
fi

# ── 5. Fix Android window background (prevent opaque-white overlay) ──────────
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

# ── 5b. Enable Kotlin in Gradle ──────────────────────────────────────────────
# Capacitor's default Android template is Java-only — `.kt` files placed in
# the source tree are silently ignored by javac. We bundle native alarm code
# as Kotlin (AlarmManagerPlugin.kt, AlarmReceiver.kt, AlarmFullScreenActivity.kt)
# so the project must enable the Kotlin Android plugin.
#
# Each patch is independently guarded so re-runs are idempotent.
echo ""
echo "▸ Enabling Kotlin in Gradle …"

PROJECT_GRADLE="$SCRIPT_DIR/android/build.gradle"
APP_GRADLE="$SCRIPT_DIR/android/app/build.gradle"
KOTLIN_VERSION="1.9.25"

if [ ! -f "$PROJECT_GRADLE" ] || [ ! -f "$APP_GRADLE" ]; then
  echo "  ⚠  Gradle files missing — skipping Kotlin enablement."
else
  # 1. Project-level build.gradle: add kotlin_version ext + kotlin-gradle-plugin classpath
  if grep -q "kotlin_version" "$PROJECT_GRADLE"; then
    echo "  ✓ kotlin_version ext already defined"
  else
    # Inject `kotlin_version = '...'` as the first line inside the `ext {` block.
    awk -v ver="$KOTLIN_VERSION" '
      !done && /^[[:space:]]*ext[[:space:]]*\{/ {
        print
        print "        kotlin_version = '\''" ver "'\''"
        done=1
        next
      }
      { print }
    ' "$PROJECT_GRADLE" > "$PROJECT_GRADLE.tmp" && mv "$PROJECT_GRADLE.tmp" "$PROJECT_GRADLE"
    # If there was no ext block at all (rare), prepend one inside buildscript.
    if ! grep -q "kotlin_version" "$PROJECT_GRADLE"; then
      awk -v ver="$KOTLIN_VERSION" '
        !done && /^buildscript[[:space:]]*\{/ {
          print
          print "    ext {"
          print "        kotlin_version = '\''" ver "'\''"
          print "    }"
          done=1
          next
        }
        { print }
      ' "$PROJECT_GRADLE" > "$PROJECT_GRADLE.tmp" && mv "$PROJECT_GRADLE.tmp" "$PROJECT_GRADLE"
    fi
    echo "  ✓ kotlin_version ext added ($KOTLIN_VERSION)"
  fi

  if grep -q "kotlin-gradle-plugin" "$PROJECT_GRADLE"; then
    echo "  ✓ kotlin-gradle-plugin classpath already present"
  else
    # Insert classpath line inside the buildscript -> dependencies block.
    # Track nesting: enter `dependencies {` only while inside `buildscript {`.
    awk '
      /^buildscript[[:space:]]*\{/ { in_bs=1 }
      in_bs && !done && /dependencies[[:space:]]*\{/ {
        print
        print "        classpath \"org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version\""
        done=1
        next
      }
      { print }
    ' "$PROJECT_GRADLE" > "$PROJECT_GRADLE.tmp" && mv "$PROJECT_GRADLE.tmp" "$PROJECT_GRADLE"
    echo "  ✓ kotlin-gradle-plugin classpath added"
  fi

  # 2. App-level build.gradle: apply kotlin-android plugin + kotlin-stdlib dep
  if grep -q "kotlin-android" "$APP_GRADLE"; then
    echo "  ✓ kotlin-android plugin already applied"
  else
    awk '
      !done && /^apply plugin:[[:space:]]*['\''"]com\.android\.application['\''"]/ {
        print
        print "apply plugin: '\''kotlin-android'\''"
        done=1
        next
      }
      { print }
    ' "$APP_GRADLE" > "$APP_GRADLE.tmp" && mv "$APP_GRADLE.tmp" "$APP_GRADLE"
    echo "  ✓ kotlin-android plugin applied"
  fi

  if grep -q "kotlin-stdlib" "$APP_GRADLE"; then
    echo "  ✓ kotlin-stdlib dependency already present"
  else
    # Insert `implementation` line at the top of the LAST `dependencies {` block.
    # In Capacitor app/build.gradle there's only one top-level dependencies block.
    awk '
      !done && /^dependencies[[:space:]]*\{/ {
        print
        print "    implementation \"org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version\""
        done=1
        next
      }
      { print }
    ' "$APP_GRADLE" > "$APP_GRADLE.tmp" && mv "$APP_GRADLE.tmp" "$APP_GRADLE"
    echo "  ✓ kotlin-stdlib dependency added"
  fi
fi

# ── 6. Patch MainActivity to register plugins ─────────────────────────────────
# Capacitor can generate MainActivity.kt (Kotlin) or MainActivity.java (Java)
# depending on the project template / init flags. We handle both.
echo ""
echo "▸ Registering plugins in MainActivity …"

MAIN_KT=$(find "$SCRIPT_DIR/android" -name "MainActivity.kt" 2>/dev/null | head -1)
MAIN_JAVA=$(find "$SCRIPT_DIR/android" -name "MainActivity.java" 2>/dev/null | head -1)

if [ -n "$MAIN_KT" ]; then
  MAIN="$MAIN_KT"
  LANG="kotlin"
elif [ -n "$MAIN_JAVA" ]; then
  MAIN="$MAIN_JAVA"
  LANG="java"
else
  MAIN=""
fi

if [ -z "$MAIN" ]; then
  echo "  ⚠  Neither MainActivity.kt nor MainActivity.java found under android/."
  echo "     Run 'npx cap add android' first, then re-run this script."
else
  echo "  (found [$LANG]: $MAIN)"

  if [ "$LANG" = "kotlin" ]; then
    # ── 6a-kt. AlarmManagerPlugin (Kotlin) ──────────────────────────────────
    if grep -q "AlarmManagerPlugin" "$MAIN"; then
      echo "  ✓ AlarmManagerPlugin already registered"
    else
      sedi 's/class MainActivity : BridgeActivity() {/class MainActivity : BridgeActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        registerPlugin(AlarmManagerPlugin::class.java)\n        super.onCreate(savedInstanceState)\n    }/' "$MAIN"
      if ! grep -q "import android.os.Bundle" "$MAIN"; then
        sedi '1s/^/import android.os.Bundle\n/' "$MAIN"
      fi
      echo "  ✓ AlarmManagerPlugin registered"
    fi

    # ── 6b-kt. Cleanup stale Codetrix GoogleAuth registration ───────────────
    # @capacitor-firebase/authentication auto-registers via Capacitor plugin
    # discovery — no manual registerPlugin() call is needed. Older versions
    # of this script injected the Codetrix GoogleAuth class which no longer
    # exists on the classpath. Strip it if a previous run left it behind.
    if grep -q "codetrixstudio.capacitor.GoogleAuth" "$MAIN"; then
      awk '!/codetrixstudio\.capacitor\.GoogleAuth/' "$MAIN" \
        > "$MAIN.tmp" && mv "$MAIN.tmp" "$MAIN"
      echo "  ✓ Removed stale Codetrix GoogleAuth registration"
    fi

  else
    # ── 6a-java. Java MainActivity ──────────────────────────────────────────
    # BSD sed (macOS) does not support the GNU `/pattern/a text` syntax,
    # so all multi-line insertions use awk which is portable everywhere.
    #
    # Each piece below is checked independently so that re-runs after a
    # partial previous run still complete missing steps. (Previously the
    # import check was nested inside the onCreate check, so a second run
    # would skip the imports if onCreate already existed.)

    # Helper: append a single `import` line right after the package line
    # if that import is not already present anywhere in the file.
    inject_import() {
      local import_line="$1"
      if grep -qF "$import_line" "$MAIN"; then return; fi
      awk -v line="$import_line" '
        /^package / && !done { print; print line; done=1; next }
        { print }
      ' "$MAIN" > "$MAIN.tmp" && mv "$MAIN.tmp" "$MAIN"
    }

    # 1. Imports (each checked independently)
    inject_import "import android.os.Bundle;"
    inject_import "import com.sitstand.timer.AlarmManagerPlugin;"
    echo "  ✓ Java imports present"

    # 2. onCreate method with plugin registrations.
    #    Detect by the actual registerPlugin call, not just by the symbol
    #    name (which would also match the import line and false-positive).
    if grep -q "registerPlugin(AlarmManagerPlugin.class)" "$MAIN"; then
      echo "  ✓ AlarmManagerPlugin already registered"
    else
      awk '
        /public class MainActivity extends BridgeActivity/ && !done {
          # Strip a trailing `}` so we can reprint it after the new method
          # (handles the compact `class Foo extends BridgeActivity {}` form)
          trailing = ($0 ~ /\}[[:space:]]*$/) ? "}" : ""
          if (trailing != "") sub(/\}[[:space:]]*$/, "", $0)
          print
          # If the opening brace is NOT on this line, print the next line
          if ($0 !~ /\{/) { getline; print }
          print "    @Override"
          print "    protected void onCreate(Bundle savedInstanceState) {"
          print "        registerPlugin(AlarmManagerPlugin.class);"
          print "        super.onCreate(savedInstanceState);"
          print "    }"
          if (trailing != "") print trailing
          done=1; next
        }
        { print }
      ' "$MAIN" > "$MAIN.tmp" && mv "$MAIN.tmp" "$MAIN"
      echo "  ✓ AlarmManagerPlugin registered"
    fi

    # 3. Cleanup stale Codetrix GoogleAuth registration.
    #    @capacitor-firebase/authentication auto-registers via Capacitor
    #    plugin discovery — no manual registerPlugin() is needed. Older
    #    versions of this script injected com.codetrixstudio.capacitor.
    #    GoogleAuth which no longer exists on the classpath. Strip it if
    #    a previous run left it behind.
    if grep -q "codetrixstudio.capacitor.GoogleAuth" "$MAIN"; then
      awk '!/codetrixstudio\.capacitor\.GoogleAuth/' "$MAIN" \
        > "$MAIN.tmp" && mv "$MAIN.tmp" "$MAIN"
      echo "  ✓ Removed stale Codetrix GoogleAuth registration"
    fi
  fi
fi

# ── 7. Copy app icons ────────────────────────────────────────────────────────
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

  # Background color for adaptive icon.
  # Capacitor generates a standalone ic_launcher_background.xml — update that
  # file if it exists to avoid a duplicate-resource build error. Only fall back
  # to colors.xml if the standalone file is absent.
  VALUES="$SCRIPT_DIR/android/app/src/main/res/values"
  BG_XML="$VALUES/ic_launcher_background.xml"
  COLORS="$VALUES/colors.xml"

  if [ -f "$BG_XML" ]; then
    # Replace whatever color is already there with our brand orange
    sedi 's|<color name="ic_launcher_background">[^<]*</color>|<color name="ic_launcher_background">#FF3C00</color>|' "$BG_XML"
    echo "  ✓ ic_launcher_background updated to #FF3C00 in ic_launcher_background.xml"
    # Remove any duplicate entry from colors.xml to prevent a build error
    if [ -f "$COLORS" ] && grep -q "ic_launcher_background" "$COLORS"; then
      sedi '/ic_launcher_background/d' "$COLORS"
      echo "  ✓ Removed duplicate ic_launcher_background from colors.xml"
    fi
  else
    # Standalone file not present — write a new one (safer than patching colors.xml)
    mkdir -p "$VALUES"
    cat > "$BG_XML" << 'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FF3C00</color>
</resources>
XML
    echo "  ✓ ic_launcher_background.xml created (#FF3C00)"
    # Guard: remove from colors.xml if it somehow already exists there
    if [ -f "$COLORS" ] && grep -q "ic_launcher_background" "$COLORS"; then
      sedi '/ic_launcher_background/d' "$COLORS"
      echo "  ✓ Removed duplicate ic_launcher_background from colors.xml"
    fi
  fi
fi

# ── 8. Done ──────────────────────────────────────────────────────────────────
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
echo "  • Battery optimisation exemption"
echo ""
echo "You MUST also grant the exact-alarm permission manually:"
echo "  1. Open the app and go to Settings (gear icon)"
echo "  2. Tap 'Grant permission →' in the amber Alarm permission card"
echo "     (takes you to Settings → Apps → Special access → Alarms & reminders)"
echo "  3. Toggle ON for Sit+Stand Timer"
echo "  Without this the app falls back to inexact alarms (~10 min drift)"
echo ""
echo "If the amber card is not visible, grant it directly:"
echo "  Android Settings → Apps → Sit+Stand Timer → Permissions"
echo "  → Alarms & reminders → Allow"
echo ""
