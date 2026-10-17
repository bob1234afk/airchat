#!/bin/bash
# AirChat on macOS.
#
# Kept because a shortcut may already point at it. The public link is now
# automatic - every launch of AirChat opens one - so this is the same door as
# "Start AirChat (Mac).command".
#
# The first time, macOS may refuse to open this because the file is not marked
# executable. If so, run once in Terminal:
#
#   chmod +x "Start AirChat (Mac).command"

cd "$(dirname "$0")" || exit 1

if [ -x "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  exec "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$PWD"
fi

if [ -d "/Applications/AirChat.app" ]; then
  exec open -a "/Applications/AirChat.app"
fi

echo
echo "  AirChat is not installed on this Mac yet."
echo
echo "  Either install AirChat.app, or - if you are working on the code - run"
echo "  npm install  in this folder once, then double-click this file again."
echo
echo "  Press Return to close."
read -r _
exit 1
