# dotpals on a real Linux desktop

A pretend Linux desktop in Docker: X (Xvfb) with the openbox window manager, a compositor to
switch on and off (`xcompmgr`), PulseAudio with a null sink, a session bus, Weston (a Wayland
desktop, run inside X) with XWayland, and Electron as in `package.json`.

- `hands-linux.mjs` tries `desktop/hands.js` with the real `xdotool`, `playerctl`,
  `wpctl`/`pactl`, `gtk-launch` and `gio`. It moves, minimizes and brings back a real window,
  types into an xterm, clicks, changes the volume, opens apps from `.desktop` files, plays, pauses
  and skips on a pretend MPRIS player (`mpris.py`), and checks what you'd see on Wayland.
- `app-smoke.mjs` runs the whole app (`electron --no-sandbox desktop/main.js`, with its own
  `DOTPALS_HOME` and port 5199) and drives it over the DevTools protocol (port 9333): the notch,
  the pal and the dashboard load with nothing thrown; the shortcuts register and work; a
  screenshot (`bluShot`); Blu's marks drawn over the screen (`bluDraw`, `bluClear`), see-through
  with clicks going through; circle mode; the notch letting clicks through except on its island;
  the volume through `bluDo`; the music card (`bluMedia`); the voice (Whisper on the processor,
  needs the network once for the model); no black screen without a compositor; and Wayland,
  natively and on XWayland. What it sees on screen it reads from Xvfb's own copy of the screen.

From the repo's root:

```sh
docker build -t dotpals-linux test/linux
docker run --rm --shm-size=1g -v "$PWD:/repo:ro" dotpals-linux        # PowerShell: -v "${PWD}:/repo:ro"
docker run --rm --shm-size=1g -v "$PWD:/repo:ro" dotpals-linux sh test/linux/run.sh test/linux/app-smoke.mjs   # just the app
```

The repo is mounted read-only; `run.sh` starts the desktop and runs the tests, one file after the
other. Anywhere else (`npm test`, CI) they're skipped. The same Linux code, with the system
pretend, is checked on every computer by `test/hands-linux.test.js`. Another Electron:
`--build-arg ELECTRON=44.5.1`.

What it can't show: a real graphics card, a microphone, and the portals a GNOME or KDE session
has (screenshots and shortcuts on Wayland go through them).
