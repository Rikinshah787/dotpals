# Remote client

Use the dotpals dashboard from your phone, tablet or foldable: live, installable as an app. **Off until you turn it on.** Desktop-only actions and remote administration stay on the computer.

Settings → Remote on the computer. Nothing here runs, listens or sends anything until then.

## Set it up

1. **Turn it on.** Settings → Remote → *Remote client*. It listens on port 5176 (change it there).
2. **Give it https.** Use an HTTPS address for the remote client. Pick one:
   - **A tunnel (easiest).** Keep *Reachable from* on "This computer only" and point a tunnel at `http://127.0.0.1:5176`:
     `cloudflared tunnel --url http://127.0.0.1:5176` (or Tailscale: `tailscale serve --bg --https=443 http://127.0.0.1:5176`). Paste the https address it prints into *Address your devices open*.
   - **https on your own network, no tunnel.** Run `dotpals remote cert` (or Settings → Remote → *https on my network*). It makes a small private certificate authority and a certificate for this computer's LAN addresses **and its `.local` name**, points the remote client at it and prints the steps for your phone. Do the phone step once: copy `~/.dotpals/remote-cert/ca.pem` to it and install it as a CA certificate (Android: Settings → Security → Encryption & credentials → Install a certificate; iPhone/iPad: open the file, install the profile, then turn it on under Settings → General → About → Certificate Trust Settings). Compare the fingerprint it shows. After that, `https://<this computer's address>:5176/pair` works, and the QR code opens it.
     - **It looks after itself.** When the computer's address changes (a new router lease, Wi-Fi to Ethernet), dotpals issues a new certificate within a minute and swaps it in without dropping anything. The CA stays the same, so phones need nothing. A moment with no network keeps the current certificate. If a renewal fails, Settings → Remote says so and the old certificate keeps serving.
     - **Address or name?** The certificate covers both. The QR code uses the address to avoid depending on multicast DNS; your phone still needs network access to the computer. The computer's `.local` name survives an address change where mDNS resolution works. Support varies by browser, OS and network isolation; test it before relying on it. A DHCP reservation is another option.
     - The CA carries X.509 name constraints for private addresses and `.local`/localhost names. Keep its key private regardless: trust-store enforcement varies, and a leaked key can impersonate local services within those constraints. Transfer only `ca.pem`, never `ca-key.pem`.
     - Needs `openssl`; Git for Windows includes one. Windows' firewall may need to allow the app in on your network (private networks are usually already open).
   - **Your own certificate.** Set `remote.tlsCert` and `remote.tlsKey` (file paths) in `~/.dotpals/config.json`, choose "Anything on my network", and use `https://<this computer>:5176`.
3. **Pair.** *Pair a device* shows a QR code and a code like `7K2M-9QXD-4TBH`. Scan it with the phone's camera, or open `<your address>/pair` and type it. The code works once and expires in 5 minutes.
4. **Install.** The app offers *Install* in its own Settings → Remote (Chrome, Edge, Samsung Internet), or use the browser's menu. On iPhone/iPad: Share → Add to Home Screen.

## What a paired device can do

Out of the box a device can **look** (the remote dashboard and its allowed data) and change how things **look and sound** (pal, sounds, notification settings, story view). It can not run anything on your computer.

Turn on **Let this device control** (on the computer, per device) and it can hand off sessions, rewind a request, start Blu's coding tasks and change ordinary settings, not remote administration. This grants powerful access to your computer, so it is separate and off by default. A look-only lost phone can still expose private session data: revoke it promptly.

Approval endpoints and the Apps tab stay on the desktop. A remote stream alone never intercepts Claude's terminal prompt. Blu's remote panel supports answers and coding plans; desktop actions (volume, clicking, typing) and connector execution are not implemented there.

Never from a device, whatever its switch: agents' hooks, events and hook recap consumption, quitting the app, pairing others, or remote administration.

## Windows, macOS and Linux

The remote client is the same on all three (CI builds and tests it on each, on Node 20 and 22). What differs is the computer around it:

| | Windows | macOS | Linux |
|---|---|---|---|
| `openssl` for `dotpals remote cert` | Git for Windows' is found and used; a broken one on PATH (Anaconda, XAMPP) is skipped, because each candidate has to make a real certificate first | The system's LibreSSL works (key identifiers are written out, since LibreSSL doesn't add them), or Homebrew's | `/usr/bin/openssl`, from your package manager if it's missing |
| Your computer's `.local` name | Resolves on a phone once Windows is on a *private* network | Bonjour: always there | Needs **avahi** (`avahi-daemon`) running for phones to find `name.local`; the address in the QR code works without it |
| Firewall | Allow the app in on private networks (a prompt appears the first time) | Allow incoming connections when asked | `ufw allow <port>/tcp` (the port is in Settings → Remote) if you use ufw |
| Files only you can read (`remote.json`, the CA key, `config.json`) | The folder's own permissions, which are per user | mode `0600` | mode `0600` |
| Where it lives | `%USERPROFILE%\.dotpals` | `~/.dotpals` | `~/.dotpals` |

Installing the CA on the phone is the same everywhere: send `~/.dotpals/remote-cert/ca.pem` to it (AirDrop, a USB cable, a download from your own computer) and trust it. On Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate. On iPhone: open the file, install the profile, then Settings → General → About → Certificate Trust Settings. It can only vouch for private addresses and `.local` names.

## Agent pals, the agent picker, and Talk

- **Pals.** A tray at the top of every page shows one animated pal per live agent (the same pals as the notch), with the step it's on. Whoever needs you comes first and has a yellow outline; tap a pal to open its session. A quiet one dozes off after three minutes and leaves the tray after ten. They follow the live stream, so nothing is polled and nothing runs while the app is in the background.
- **Agent picker.** In Sessions, the Agent drop-down is buttons with a pal each and a count of who's working. It drives the dashboard's own filter, so search and the list work as before.
- **Talk and Story.** The **Talk** button drops a notch-style island from the top: the plain-language story of the agent you pick ("Changed 2 files, and the tests passed"), and Blu to ask. Blu answers itself, or, for coding work, writes a plan you read and **Start**: nothing is sent to an agent before that. Talk needs the device's **control** switch and an AI set up for Blu (Settings → Blu's brain); without either it says which is missing and sends nothing. It is Blu, not "Chat with your agents" (that one needs OpenCode).
- **Folds.** Book: the pals and picker sit on the first screen and Talk drops onto the second, off the hinge. Table: Talk fits the upper half and the pals sit above the hinge.

## Swiping between tabs

Swipe left for the next tab and right for the previous one, in the order of the navigation (Overview, Report card, Sessions, Map, Agents, Settings). A replay counts as Sessions. It stops at either end rather than wrapping round.

It stays out of the way of what you do by hand, so it ignores:

- a drag that starts in a table, chart or code block that scrolls sideways, in a field or a slider, or in anything marked `data-noswipe`
- a swipe that starts within 24 px of the screen's edge (Android and iOS use that for "back"), and a mostly vertical drag (that's scrolling)
- anything slow, short or with more than one finger

The page slides in from the side you swiped (not if you've asked your device to reduce motion). `main` is set to `touch-action: pan-y pinch-zoom`, so Chrome doesn't also treat the swipe as "back".

### Updating the app on your phone

The installed app checks for a newer worker itself and does not automatically reload your current page:

- It asks your computer for a newer version when it opens, when you come back to it (at most every 10 minutes), and when you press **Settings → Remote → Check for updates**.
- A complete app shell downloads and **waits**. A small pill appears, **"An update is ready · Update · Later"**. Update activates it and reloads the requesting page once. Later hides the pill for that visit; Settings still offers Update. Another open tab may activate the worker, but this page is not automatically reloaded.
- Each worker uses its own immutable cached shell, including transitive module imports. A failed shell download leaves the existing worker in place. API/event data always uses the network. Developers must bump the worker build when shell files change without a release-version change.
- A failed check or activation is reported and can be retried. If registration failed, the Check button retries it too.

Migration exception: a worker predating the Update UI may be replaced automatically once, because its page cannot request activation. This does not force a page reload. Browsers can also activate a waiting worker naturally after all controlled pages close.

## Real time, cheaply

- The live stream is open **only while the app is in front of you.** Hidden for 15 seconds, it closes: no connection, no radio, no work on the computer. Coming back it asks for just what it missed (`?since=`), not the whole history.
- Changes to the same thing are sent once (a tool call that updates ten times in a moment is one message), in one write, gzip-compressed.
- Scripts and styles are cached by build. Update checks fetch the worker explicitly; uncached static requests can revalidate with ETags.
- A device that can't keep up is dropped and resumes, not buffered without limit. An idle live-stream hub has no timer; enabled TLS certificate maintenance still checks for address changes.
- A new device loads the last 3 days (`remote.historyDays`, 1 to 7).

## Foldables

The layout follows the [Device Posture API](https://developer.mozilla.org/en-US/docs/Web/API/Device_Posture_API) and the [Viewport Segments API](https://developer.mozilla.org/en-US/docs/Web/API/Viewport_Segments_API), read before the first paint:

| Situation | Layout |
| --- | --- |
| Flat, phone | Bottom navigation, 44 px+ touch targets, safe areas |
| Flat, tablet or unfolded | List and detail side by side from 640 px |
| Two screens side by side, or half-open in landscape (*book*) | A rail, then one pane on each screen; nothing crosses the hinge |
| Half-open, hinge across the middle (*tabletop*) | Content on the upper half, navigation on the lower |
| Installed on a desktop | Window Controls Overlay: the title bar is yours |

Where the browser gives real segment geometry, the hinge's width and each screen's size come from it; with only a `folded` posture, each half is half the screen and a safe gap stays clear. To try it on any browser: `localStorage.setItem('dotpals.posture', 'folded')` (and `dotpals.span` = `horizontal` or `vertical`), then reload.

The remote client was tested on a physical Samsung Galaxy Z Fold8 Ultra. Edge tests also force the layout modes to exercise the CSS; those tests are not evidence for every device's native posture or segment detection.

## Security

- The remote listener is a **second** server. The bridge's own `127.0.0.1:5175` is not rebound or exposed. Only permitted API routes are forwarded internally; hooks, hook recap, quit, OAuth callback and remote administration stay local.
- A pairing code is 60 random bits, hashed in memory, single use, five minutes, and rides in the URL `#fragment` (not sent in the page request; the claim sends it in a POST body). The page removes it from the address bar. Pairing attempts are rate-limited.
- Pairing only completes over https (or from this computer). The device cookie is `HttpOnly; Secure; SameSite=Strict`, 256 random bits; only its SHA-256 is stored, in `~/.dotpals/remote.json` (0600).
- Every request is checked: host name, origin, a custom header on changes, the device, then what that device may do. Pages carry a Content Security Policy that allows only this origin's scripts.
- Sign a device out from the computer or the device; it's cut off at once, mid-stream.
- Don't expose port 5176 to the internet without https. A tunnel is fine; port-forwarding plain http is not.
- Paired devices can read sensitive session data. Revocation cannot erase data already viewed or copied by a device. See [SECURITY.md](../SECURITY.md) for trust boundaries and private-CA cautions.
