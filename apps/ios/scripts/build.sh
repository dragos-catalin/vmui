#!/usr/bin/env bash
# Reproducible build of the Vatra iPhone / iPad / watch app on a macOS host (vmui-mac, Xcode 26.x).
#
#   scripts/build.sh test    swift test VatraCore (contract fixtures from ../../docs/api/fixtures; no Simulator)
#   scripts/build.sh build   generate the project (XcodeGen) + compile every target for iphoneos, unsigned
#   scripts/build.sh all     test, then build
#
# The Windows driver is scripts/ios-build.ps1 in the repo root (ships the committed tree to the guest).
# Signing / TestFlight upload come with the App Store Connect record (P8-04, owner step).
set -euo pipefail

MODE="${1:-all}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

XCODEGEN_VERSION="2.46.0"
XCODEGEN_SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"
TOOLS="$HOME/.local/codai-ios-tools"
XCODEGEN="$TOOLS/xcodegen-$XCODEGEN_VERSION/bin/xcodegen"
OUT="$HERE/build"

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "$HOME/Applications/Xcode.app" ]; then
  export DEVELOPER_DIR="$HOME/Applications/Xcode.app/Contents/Developer"
fi

log() { printf '== %s\n' "$*"; }

free_gb=$(df -g / | awk 'NR==2 {print $4}')
if [ "${free_gb:-0}" -lt 8 ]; then echo "guest disk has ${free_gb} GB free (< 8): clean ~/vatra-ios first" >&2; exit 1; fi

ensure_xcodegen() {
  if [ -x "$XCODEGEN" ]; then return; fi
  log "installing XcodeGen $XCODEGEN_VERSION"
  mkdir -p "$TOOLS"
  local zip="$TOOLS/xcodegen-$XCODEGEN_VERSION.zip"
  curl -fsSL -o "$zip" "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip"
  echo "$XCODEGEN_SHA256  $zip" | shasum -a 256 -c -
  rm -rf "$TOOLS/xcodegen-$XCODEGEN_VERSION"
  unzip -q "$zip" -d "$TOOLS/tmp-$XCODEGEN_VERSION"
  mv "$TOOLS/tmp-$XCODEGEN_VERSION/xcodegen" "$TOOLS/xcodegen-$XCODEGEN_VERSION"
  rm -rf "$TOOLS/tmp-$XCODEGEN_VERSION" "$zip"
}

run_test() {
  log "swift test VatraCore ($(xcodebuild -version | tr '\n' ' '))"
  # pipefail (set above) keeps swift test's exit status through tail
  (cd VatraCore && VATRA_FIXTURES="$HERE/../../docs/api/fixtures" swift test 2>&1 | tail -n 80)
}

run_build() {
  ensure_xcodegen
  log "app icon from the brand geometry"
  mkdir -p "$OUT"
  swiftc -O -o "$OUT/appicon" scripts/appicon/main.swift VatraCore/Sources/VatraCore/VatraTokens.swift VatraCore/Sources/VatraCore/SVGPath.swift
  "$OUT/appicon" Vatra/Assets.xcassets/AppIcon.appiconset/icon-1024.png VatraWatch/Assets.xcassets/AppIcon.appiconset/icon-1024.png
  log "xcodegen"
  DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-}" "$XCODEGEN" generate --spec project.yml --quiet
  log "compile Vatra (iphoneos, unsigned) incl. widget / intents / notification extensions and the watch app"
  xcodebuild -project Vatra.xcodeproj -scheme Vatra -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CURRENT_PROJECT_VERSION="${BUILD_NUMBER:-1}" build -quiet
  local app="$OUT/dd/Build/Products/Release-iphoneos/Vatra.app"
  log "products:"
  ls "$app/PlugIns" 2>/dev/null | sed 's/^/   plugin /'
  ls "$app/Watch" 2>/dev/null | sed 's/^/   watch /'
  for p in VatraWidgets.appex VatraNotificationService.appex; do
    [ -d "$app/PlugIns/$p" ] || { echo "missing $p in the app bundle" >&2; exit 1; }
    [ -f "$app/PlugIns/$p/PrivacyInfo.xcprivacy" ] || { echo "missing privacy manifest in $p" >&2; exit 1; }
  done
  [ -d "$app/Watch/VatraWatch.app" ] || { echo "missing the watch app in the bundle" >&2; exit 1; }
  [ -f "$app/PrivacyInfo.xcprivacy" ] || { echo "missing privacy manifest in the app" >&2; exit 1; }
  [ -f "$app/Watch/VatraWatch.app/PrivacyInfo.xcprivacy" ] || { echo "missing privacy manifest in the watch app" >&2; exit 1; }
  plutil -lint "$app/PrivacyInfo.xcprivacy"
  log "OK: $app"
}

case "$MODE" in
  test) run_test ;;
  build) run_build ;;
  all) run_test; run_build ;;
  *) echo "usage: $0 test|build|all" >&2; exit 2 ;;
esac
