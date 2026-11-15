#!/bin/bash
# Double-click to install dotpals on a Mac. It runs the one-line installer,
# https://dotpals.vercel.app/install.sh, which installs Node.js if you
# need it (Homebrew or nodejs.org), then dotpals (from npm).
#
# This file isn't signed yet, so the first time macOS says it can't check it: open
# System Settings → Privacy & Security and click Open Anyway (on macOS 14 and earlier,
# right-click the file and choose Open). It comes in a .zip so it stays runnable.
set -o pipefail
cd "$HOME" || exit 1
curl -fsSL https://dotpals.vercel.app/install.sh | bash
status=$?
echo
read -r -p 'Press Enter to close this window.' _
exit "$status"
