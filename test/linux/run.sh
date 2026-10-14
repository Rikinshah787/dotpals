#!/bin/sh
# Inside the container (test/linux/Dockerfile): start a pretend desktop, then try Blu's hands on it.
set -e
export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
until xdpyinfo >/dev/null 2>&1; do sleep 0.1; done
eval "$(dbus-launch --sh-syntax)"
openbox >/dev/null 2>&1 &
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr 2>/dev/null
pactl load-module module-null-sink sink_name=dotpals >/dev/null
pactl set-default-sink dotpals
sleep 0.5
DOTPALS_LINUX_HANDS=1 node --test --test-reporter=spec test/linux/hands-linux.mjs
