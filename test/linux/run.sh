#!/bin/sh
# Inside the container (test/linux/Dockerfile): start a pretend desktop, then try Blu's hands and
# the whole app on it. Arguments: which tests (default: both).
set -e
export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
mkdir -p /tmp/fb
# -fbdir: Xvfb keeps the screen as you'd see it (compositor and all) in a file, for app-smoke.mjs.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -fbdir /tmp/fb >/dev/null 2>&1 &
until xdpyinfo >/dev/null 2>&1; do sleep 0.1; done
eval "$(dbus-launch --sh-syntax)"
openbox >/dev/null 2>&1 &
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr 2>/dev/null
pactl load-module module-null-sink sink_name=dotpals >/dev/null
pactl set-default-sink dotpals
sleep 0.5
[ $# -gt 0 ] || set -- test/linux/hands-linux.mjs test/linux/app-smoke.mjs
# What the app said, when a check fails (app-smoke.mjs writes it there).
DOTPALS_LINUX_HANDS=1 DOTPALS_LINUX_APP=1 node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=spec "$@" \
  || { [ -f /tmp/dotpals-app.log ] && grep -v system_bus_socket /tmp/dotpals-app.log | tail -40; exit 1; }
