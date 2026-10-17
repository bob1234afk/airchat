#!/bin/bash
# AirChat on macOS.
#
# The app is the whole product: it starts its own server and its own public link
# when it opens, so this file only opens it - exactly like the Windows
# "Start AirChat.bat". There is no separate server or tunnel to start.
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
