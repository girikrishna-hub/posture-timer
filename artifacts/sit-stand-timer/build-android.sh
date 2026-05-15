#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-android.sh
# Builds the web app for Android without triggering pnpm's workspace-level
# install check (which fails on pnpm 11 due to lockfile/approval mismatch).
#
# Run this from the artifacts/sit-stand-timer/ directory.
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VITE="$SCRIPT_DIR/node_modules/.bin/vite"
if [ ! -f "$VITE" ]; then
  VITE="$(cd "$SCRIPT_DIR/../.." && pwd)/node_modules/.bin/vite"
fi
if [ ! -f "$VITE" ]; then
  echo "❌  vite not found. Run from repo root: pnpm approve-builds && pnpm install"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Sit+Stand Timer — Android web build          ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

BASE_PATH=/ VITE_API_BASE_URL=https://posture-timer.replit.app \
  "$VITE" build --config vite.config.ts

echo ""
echo "✅  Build complete. Next:"
echo "   npx cap sync android"
echo "   npx cap open android   ← then press ▶ Run in Android Studio"
echo ""
