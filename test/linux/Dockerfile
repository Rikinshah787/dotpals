# A pretend Linux desktop to try Blu's hands (desktop/hands.js) on for real: X (Xvfb) with a
# window manager, sound (PulseAudio with a null sink), a session bus, playerctl, xdotool and
# the app launchers. How to run it: test/linux/README.md.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils xdotool xterm openbox dbus-x11 \
      pulseaudio pulseaudio-utils wireplumber playerctl \
      libgtk-3-bin libglib2.0-bin python3-gi \
 && rm -rf /var/lib/apt/lists/*
# One of the menu folders desktop/hands.js reads that gtk-launch doesn't: for the `gio launch` fallback.
RUN mkdir -p /var/lib/snapd/desktop/applications && chown node /var/lib/snapd/desktop/applications
USER node
WORKDIR /repo
CMD ["sh", "test/linux/run.sh"]
