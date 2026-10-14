# A pretend Linux desktop to try Blu's hands (desktop/hands.js) and the whole desktop app on for
# real: X (Xvfb) with a window manager, a compositor to switch on and off (xcompmgr), sound
# (PulseAudio with a null sink), a session bus, playerctl, xdotool, the app launchers, what
# Electron needs, and Weston (a Wayland desktop, run inside X) with XWayland. How to run it:
# test/linux/README.md.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils x11-apps xdotool xterm openbox xcompmgr dbus-x11 \
      pulseaudio pulseaudio-utils wireplumber playerctl \
      libgtk-3-bin libglib2.0-bin python3-gi \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxrandr2 libcups2 libatspi2.0-0 libx11-xcb1 libxshmfence1 libnotify4 \
      fonts-dejavu-core xdg-utils ca-certificates weston xwayland \
 && rm -rf /var/lib/apt/lists/*
# One of the menu folders desktop/hands.js reads that gtk-launch doesn't: for the `gio launch` fallback.
RUN mkdir -p /var/lib/snapd/desktop/applications && chown node /var/lib/snapd/desktop/applications
# Electron, as in package.json's devDependencies (the repo is mounted read-only, so it lives here).
# Its download step is run by hand: npm can skip it (desktop/launch.js does the same).
ARG ELECTRON=^44.5.1
RUN mkdir /opt/electron && cd /opt/electron && npm install --no-save --no-audit --no-fund --prefix . "electron@$ELECTRON" \
 && node node_modules/electron/install.js
ENV DOTPALS_ELECTRON=/opt/electron/node_modules/electron/dist/electron
USER node
WORKDIR /repo
CMD ["sh", "test/linux/run.sh"]
