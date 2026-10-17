#!/bin/bash
# AirChat on macOS.
#
# Double-click this file in Finder to start AirChat, exactly like the Windows
# "Start AirChat.bat". The first time, macOS may refuse to open it because the
# file is not marked executable. If that happens, open Terminal, drag this file
# in, and run once:
#
#   chmod +x "Start AirChat (Mac).command"
#
# After that it opens with a double-click like any app.

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  AirChat needs Node.js 18 or newer."
  echo "  Install it from https://nodejs.org (or run:  brew install node)"
  echo "  then start AirChat again."
  echo
  echo "  Press Return to close."
  read -r _
  exit 1
fi

node server/index.js
status=$?

echo
echo "  AirChat stopped (exit $status). Press Return to close."
read -r _
