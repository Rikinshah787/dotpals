#!/usr/bin/env bash
# dotpals installer for macOS and Linux.
#
#   curl -fsSL https://dotpals.vercel.app/install.sh | bash
#
# If Node.js 20 or newer isn't installed, on a Mac it installs it (with Homebrew, or
# the official installer from nodejs.org); on Linux it says how. Then it runs
# `npx --yes dotpals@latest setup`. It only downloads from nodejs.org and npm.
set -euo pipefail

HELP='https://dotpals.vercel.app/guide/troubleshooting.html#installer'

step() { printf '\n\033[36m→\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31m✗\033[0m %s\n  What to do next: %s\n' "$*" "$HELP" >&2; exit 1; }

# Node's major version, or 0 when there's none.
node_major() {
  local v
  v=$(node --version 2>/dev/null) || { echo 0; return; }
  v=${v#v}
  echo "${v%%.*}"
}

# The newest Node.js LTS on nodejs.org, for example v24.11.1.
latest_lts() {
  local index
  index=$(curl -fsSL https://nodejs.org/dist/index.json) || return 1
  awk -F'"' '/"lts":"/ && /"osx-x64-pkg"/ { print $4; exit }' <<<"$index"
}

install_node_mac() {
  if command -v brew >/dev/null 2>&1; then
    step 'Installing Node.js with Homebrew...'
    if brew list node >/dev/null 2>&1; then brew upgrade node || true; else brew install node || fail "Homebrew couldn't install Node.js."; fi
  else
    step 'Finding the latest Node.js LTS on nodejs.org...'
    local version
    version=$(latest_lts) || fail "Couldn't reach nodejs.org. Check your internet connection and try again."
    [ -n "$version" ] || fail "Couldn't find the latest Node.js on nodejs.org."
    tmp=$(mktemp -d)
    trap "rm -rf '$tmp'" EXIT
    step "Downloading Node.js $version..."
    curl -fL --progress-bar -o "$tmp/node.pkg" "https://nodejs.org/dist/$version/node-$version.pkg" \
      || fail "Couldn't download Node.js from nodejs.org."
    # Apple checks the installer is signed and notarized before we run it.
    pkgutil --check-signature "$tmp/node.pkg" >/dev/null || fail "The Node.js installer isn't signed as expected, so it wasn't run."
    step 'Installing Node.js. Your Mac will ask for your password (the one you log in with).'
    echo '  Nothing shows while you type it; press Enter when done.'
    sudo installer -pkg "$tmp/node.pkg" -target / || fail "Node.js didn't install."
    export PATH="/usr/local/bin:$PATH"
  fi
  hash -r
}

main() {
  printf '\033[1mdotpals installer\033[0m\n'
  step 'Checking for Node.js 20 or newer...'
  local major
  major=$(node_major)
  if [ "$major" -ge 20 ]; then
    ok "Found Node.js $(node --version)."
  else
    if [ "$major" -gt 0 ]; then echo "  Node.js $(node --version) is too old."; else echo '  Node.js is not installed.'; fi
    if [ "$(uname -s)" != Darwin ]; then
      # Linux has too many ways to install Node to guess one; nodejs.org shows the commands for yours.
      fail "dotpals needs Node.js 20 or newer. Install it with the commands for your system at
  https://nodejs.org/en/download (nvm works everywhere), then run this again."
    fi
    install_node_mac
    major=$(node_major)
    [ "$major" -ge 20 ] || fail "Node.js 20 or newer still isn't the one on your PATH (found: $(node --version 2>/dev/null || echo none)).
  If you use a Node version manager, switch it to 20 or newer, then run this again."
    ok "Installed Node.js $(node --version)."
  fi

  step 'Installing dotpals (npx --yes dotpals@latest setup)...'
  # Piped into bash, our input is this script: give setup the terminal so it can ask its questions.
  if (exec </dev/tty) 2>/dev/null; then
    npx --yes dotpals@latest setup </dev/tty || fail "dotpals setup didn't finish."
  else
    npx --yes dotpals@latest setup || fail "dotpals setup didn't finish."
  fi
  printf '\n\033[32mdotpals is installed.\033[0m\n'
}

# Called on the last line, so nothing runs if the download stops halfway.
main "$@"
