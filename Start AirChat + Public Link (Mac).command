#!/bin/bash
# AirChat on macOS, with a free public link for your friends.
#
# Same as the Windows "Start AirChat + Public Link.bat": opens a free Cloudflare
# Quick Tunnel (no account), saves the address, then starts AirChat and prints
# the link to send each friend.
#
# First time only, macOS may refuse to open this because it is not marked
# executable. If so, in Terminal run once:
#
#   chmod +x "Start AirChat + Public Link (Mac).command"
#
# You also need cloudflared. Install it free with:  brew install cloudflared

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

node tools/tunnel.js
status=$?

echo
echo "  AirChat stopped (exit $status). Press Return to close."
read -r _
