#!/bin/bash
# Build a real AirChat.dmg - on a Mac.
#
# A DMG is Apple's disk-image format and only Apple's own tool writes it, which
# is why the .dmg is not in the repository: it cannot be produced on Windows.
# This script is the missing half. Double-click it on any Mac with Node.js, or
# run it from Terminal, and it builds the bundle and then the disk image.
#
# First time only, if macOS refuses to run this file because it is not marked
# executable:
#
#   chmod +x "make-dmg.command"

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is needed to assemble the app bundle. Install it from"
  echo "  https://nodejs.org (or: brew install node) and run this again."
  echo
  read -r _
  exit 1
fi

VERSION="$(node -p "require('../../package.json').version")"
APP="../../.build/mac/AirChat.app"
OUT="../../artifacts/AirChat-${VERSION}.dmg"

echo
echo "  Assembling AirChat.app..."
node build-mac.js --no-zip

if [ ! -d "$APP" ]; then
  echo "  The app bundle was not created - stopping."
  read -r _
  exit 1
fi

mkdir -p ../../artifacts
rm -f "$OUT"

echo "  Building the disk image..."
hdiutil create \
  -volname "AirChat" \
  -srcfolder "$APP" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$OUT"

echo
echo "  Done: $OUT"
echo
echo "  It is unsigned, so a Mac that downloads it will refuse to open it until"
echo "  the user right-clicks the app and chooses Open once. Signing it for"
echo "  distribution needs an Apple Developer ID certificate:"
echo
echo "    codesign --deep --sign \"Developer ID Application: ...\" \"$APP\""
echo
read -r _
