# Blu's hands on a real Linux desktop

`hands-linux.mjs` tries `desktop/hands.js` on a pretend Linux desktop in Docker: X (Xvfb) with
the openbox window manager, PulseAudio with a null sink, a session bus, and the real `xdotool`,
`playerctl`, `wpctl`/`pactl`, `gtk-launch` and `gio`. It moves, minimizes and brings back a real
window, types into an xterm, clicks, changes the volume, opens apps from `.desktop` files, plays,
pauses and skips on a pretend MPRIS player (`mpris.py`), and checks what you'd see on Wayland.

From the repo's root:

```sh
docker build -t dotpals-hands-linux test/linux
docker run --rm -v "$PWD:/repo:ro" dotpals-hands-linux        # PowerShell: -v "${PWD}:/repo:ro"
```

The repo is mounted read-only; `run.sh` starts the desktop and runs the tests. Anywhere else
(`npm test`, CI) they're skipped. The same Linux code, with the system pretend, is checked on
every computer by `test/hands-linux.test.js`.
