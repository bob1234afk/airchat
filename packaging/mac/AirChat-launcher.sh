#!/bin/bash
# AirChat.app's executable.
#
# A .app is a folder, and this is the program inside it. Finder runs this when
# the icon is double-clicked, so everything it needs has to work with no terminal
# and no arguments:
#
#   1. find Node.js (the app needs it; there is nothing to bundle around that)
#   2. copy the current server + interface into Application Support, keeping any
#      config.json and messages that are already there
#   3. start AirChat, with the free public link when cloudflared is installed
#   4. if nothing answers after a few seconds, say so in a dialog with the log
#
# Data lives in ~/Library/Application Support/AirChat, never inside the bundle:
# replacing the app from a new DMG must never touch your messages.

set -u

BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$BUNDLE/Contents/Resources/app"

SUPPORT="$HOME/Library/Application Support/AirChat"
APP="$SUPPORT/app"
LOG="$SUPPORT/airchat.log"

mkdir -p "$SUPPORT" "$APP" 2>/dev/null

# --- 1. Node ---------------------------------------------------------------

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  /usr/bin/osascript -e 'display dialog "AirChat needs Node.js 18 or newer, which was not found on this Mac.\n\nInstall it from nodejs.org (the LTS button), then open AirChat again." with title "AirChat" buttons {"Open nodejs.org", "Close"} default button 1' >/dev/null 2>&1
  /usr/bin/open "https://nodejs.org/en/download" >/dev/null 2>&1
  exit 1
fi

# --- 2. Code out of the bundle, data left alone ----------------------------

for item in server ui tools package.json config.example.json README.md; do
  if [ -e "$SOURCE/$item" ]; then
    rm -rf "$APP/$item"
    cp -R "$SOURCE/$item" "$APP/$item"
  fi
done

# --- 3. Start --------------------------------------------------------------

cd "$APP" || exit 1

PORT=4000
if [ -f "$APP/config.json" ]; then
  SAVED="$(/usr/bin/sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$APP/config.json" | head -1)"
  if [ -n "$SAVED" ]; then PORT="$SAVED"; fi
fi

: > "$LOG" 2>/dev/null
{
  echo "AirChat starting $(date)"
  echo "node: $NODE ($("$NODE" --version 2>/dev/null))"
  echo "port: $PORT"
} >> "$LOG" 2>&1

# tunnel.js opens the free Cloudflare link when cloudflared is installed, and
# falls back to Wi-Fi-only with an explanation when it is not. Either way it
# starts the server and opens the browser, which is the only window this app has.
"$NODE" "$APP/tools/tunnel.js" >> "$LOG" 2>&1 &
SERVER_PID=$!

# --- 4. Did it actually come up? ------------------------------------------

(
  sleep 12

  if /usr/bin/curl -fsS -o /dev/null --max-time 4 "http://localhost:$PORT/api/health"; then
    exit 0
  fi

  /usr/bin/osascript -e "display dialog \"AirChat started but did not answer on port $PORT.\n\nDetails are in:\n$LOG\n\nA common cause is another copy of AirChat already running.\" with title \"AirChat\" buttons {\"Open the log\", \"Close\"} default button 1" >/dev/null 2>&1

  /usr/bin/open -e "$LOG" >/dev/null 2>&1 || /usr/bin/open -t "$LOG" >/dev/null 2>&1
) &

wait "$SERVER_PID"
