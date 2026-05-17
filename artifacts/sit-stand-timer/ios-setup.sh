#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ios-setup.sh
# Run this ONCE after placing GoogleService-Info.plist in ios/App/App/.
# Patches Info.plist with the Google Sign-In URL scheme (REVERSED_CLIENT_ID).
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFO_PLIST="$SCRIPT_DIR/ios/App/App/Info.plist"
GOOGLE_PLIST="$SCRIPT_DIR/ios/App/App/GoogleService-Info.plist"
PLISTBUDDY="/usr/libexec/PlistBuddy"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Sit+Stand Timer — iOS Google Sign-In setup   ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Verify ios/ exists ─────────────────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/ios" ]; then
  echo "❌  ios/ folder not found."
  echo "    Run 'npx cap add ios' first, then re-run this script."
  exit 1
fi

# ── 2. Verify GoogleService-Info.plist exists ─────────────────────────────────
if [ ! -f "$GOOGLE_PLIST" ]; then
  echo "❌  GoogleService-Info.plist not found at:"
  echo "    $GOOGLE_PLIST"
  echo ""
  echo "    Download it from Firebase Console:"
  echo "    Project settings → Your apps → iOS app (com.sitstand.timer)"
  echo "    → Download GoogleService-Info.plist → copy to ios/App/App/"
  echo ""
  echo "    If you haven't registered the iOS app in Firebase yet:"
  echo "    1. Go to https://console.firebase.google.com/project/posture-timer-1777533387497"
  echo "    2. Project settings → Add app → iOS"
  echo "    3. Bundle ID: com.sitstand.timer"
  echo "    4. Download GoogleService-Info.plist"
  exit 1
fi

# ── 3. Extract REVERSED_CLIENT_ID ─────────────────────────────────────────────
echo "▸ Reading REVERSED_CLIENT_ID from GoogleService-Info.plist …"
REVERSED_CLIENT_ID=$("$PLISTBUDDY" -c "Print :REVERSED_CLIENT_ID" "$GOOGLE_PLIST" 2>/dev/null || true)

if [ -z "$REVERSED_CLIENT_ID" ]; then
  echo "❌  REVERSED_CLIENT_ID not found in GoogleService-Info.plist."
  echo "    Make sure the file was downloaded from the correct Firebase project."
  exit 1
fi

echo "  ✓ REVERSED_CLIENT_ID: $REVERSED_CLIENT_ID"

# ── 4. Patch Info.plist — replace placeholder with real value ─────────────────
echo ""
echo "▸ Patching ios/App/App/Info.plist …"

if grep -q "REVERSED_CLIENT_ID_PLACEHOLDER" "$INFO_PLIST"; then
  # Replace the placeholder string with the real reversed client ID
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s|REVERSED_CLIENT_ID_PLACEHOLDER|$REVERSED_CLIENT_ID|g" "$INFO_PLIST"
  else
    sed -i "s|REVERSED_CLIENT_ID_PLACEHOLDER|$REVERSED_CLIENT_ID|g" "$INFO_PLIST"
  fi
  echo "  ✓ REVERSED_CLIENT_ID URL scheme added: $REVERSED_CLIENT_ID"
elif grep -q "$REVERSED_CLIENT_ID" "$INFO_PLIST"; then
  echo "  ✓ REVERSED_CLIENT_ID URL scheme already present — skipping"
else
  # Placeholder was already replaced with something else — add the entry via PlistBuddy
  ENTRY_COUNT=$("$PLISTBUDDY" -c "Print :CFBundleURLTypes" "$INFO_PLIST" 2>/dev/null | grep -c "Dict" || echo "0")
  "$PLISTBUDDY" \
    -c "Add :CFBundleURLTypes:$ENTRY_COUNT dict" \
    -c "Add :CFBundleURLTypes:$ENTRY_COUNT:CFBundleURLName string com.sitstand.timer.google" \
    -c "Add :CFBundleURLTypes:$ENTRY_COUNT:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:$ENTRY_COUNT:CFBundleURLSchemes:0 string $REVERSED_CLIENT_ID" \
    "$INFO_PLIST"
  echo "  ✓ REVERSED_CLIENT_ID URL scheme added via PlistBuddy: $REVERSED_CLIENT_ID"
fi

# ── 5. Verify posture-timer:// scheme is present ──────────────────────────────
if grep -q "posture-timer" "$INFO_PLIST"; then
  echo "  ✓ posture-timer:// deep-link scheme already present"
else
  echo "  ⚠  posture-timer:// scheme missing from Info.plist — add it manually."
fi

# ── 6. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  iOS Google Sign-In setup complete!              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Build web assets:"
echo "     BASE_PATH=/ VITE_API_BASE_URL=https://posture-timer.replit.app \\"
echo "     npx vite build --config vite.config.ts"
echo ""
echo "  2. Sync to iOS:"
echo "     npx cap sync ios"
echo ""
echo "  3. Open in Xcode:"
echo "     npx cap open ios"
echo ""
echo "  4. In Xcode:"
echo "     • Select your Apple developer team (Signing & Capabilities)"
echo "     • Connect your iPhone → Run ▶"
echo ""
