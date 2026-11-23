# Remote client

Use the dotpals dashboard from your phone, tablet or foldable: live, installable as an app, with notifications you choose. **Off until you turn it on.** Desktop-only actions and remote administration stay on the computer.

Settings → Remote on the computer. Nothing here runs, listens or sends anything until then.

## Set it up

1. **Turn it on.** Settings → Remote → *Remote client*. The default port is 5176. If it is occupied, change **Port** there and use the new port in all addresses below.
2. **Give it HTTPS.** Pairing, installing the app, and receiving notifications require HTTPS. Pick one:
   - **An HTTPS proxy that supports Server-Sent Events.** Keep *Reachable from* on "This computer only". For example, use `tailscale serve --bg --https=443 http://127.0.0.1:5176` and paste the HTTPS origin into *Address your devices open*. The trusted proxy must preserve the original Host, reject plaintext external access, overwrite forwarding headers, and stream SSE without buffering. Cloudflare Quick Tunnels do not support SSE; do not use them for the live dashboard.
   - **https on your own network, no tunnel.** Run `dotpals remote cert` (or Settings → Remote → *https on my network*). It makes a small private certificate authority and a certificate for this computer's LAN addresses **and its `.local` name**, points the remote client at it and prints the steps for your phone. Do the phone step once: copy `~/.dotpals/remote-cert/ca.pem` to it and install it as a CA certificate (Android: Settings → Security → Encryption & credentials → Install a certificate; iPhone/iPad: open the file, install the profile, then turn it on under Settings → General → About → Certificate Trust Settings). Compare the fingerprint it shows. After that, `https://<this computer's address>:5176/pair` works, and the QR code opens it.
     - **It looks after itself.** When the computer's address changes (a new router lease, Wi-Fi to Ethernet), dotpals issues a new certificate within a minute and swaps it in without dropping anything. The CA stays the same, so phones need nothing. A moment with no network keeps the current certificate. If a renewal fails, Settings → Remote says so and the old certificate keeps serving.
     - **Address or name?** The certificate covers both. The QR code uses the address to avoid depending on multicast DNS; your phone still needs network access to the computer. The computer's `.local` name survives an address change where mDNS resolution works. Support varies by browser, OS and network isolation; test it before relying on it. A DHCP reservation is another option.
     - The CA carries X.509 name constraints for private addresses and `.local`/localhost names. Keep its key private regardless: trust-store enforcement varies, and a leaked key can impersonate local services within those constraints. Transfer only `ca.pem`, never `ca-key.pem`.
     - Needs `openssl`; Git for Windows includes one. Windows' firewall may need to allow the app in on your network (private networks are usually already open).
   - **Your own certificate.** Set `remote.tlsCert` and `remote.tlsKey` (file paths) in `~/.dotpals/config.json`, choose "Anything on my network", and enter the matching HTTPS origin (including the port) in *Address your devices open*. If switching from a proxy to automatic LAN HTTPS, clear the old public address first.
3. **Pair.** *Pair a device* shows a QR code and a code like `7K2M-9QXD-4TBH`. Scan it with the phone's camera, or open `<your address>/pair` and type it. The code works once and expires in 5 minutes.
4. **Install.** The app offers *Install* in its own Settings → Remote (Chrome, Edge, Samsung Internet), or use the browser's menu. On iPhone/iPad: Share → Add to Home Screen.
5. **Notifications.** On the device: Settings → Remote → *Notify this device*, then pick what you want to hear about.

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

## Notifications

Chosen per device, on the device: a request finishes (only ones that took a while), an agent is waiting for you (still waiting after 20 s), an agent asks permission (needs *control*), an agent seems stuck, two agents on one file, an agent gave up on failing tests, a context window nearly full (off by default). *Only when I'm away* skips them while the app is open on that device.

They're [Web Push](https://www.rfc-editor.org/rfc/rfc8030): the computer encrypts each one for that device ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)) and signs it ([VAPID, RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)). Only Google (including the `*.google.com/fcm/` hosts Chrome on Android uses), Mozilla, Apple and Microsoft push-provider hosts are accepted; custom providers are not supported. A refused address is reported with the service name and never deletes a working subscription. Providers see ciphertext and network/timing metadata, not notification plaintext. Text is shortened and pattern-redacted before encryption; this is best effort, not a guarantee that arbitrary sensitive prose is removed. Lock-screen previews can expose it. Ordinary notifications are limited to one per tag per 10 s and 20 per minute per device; explicit tests bypass notification preferences, but device-requested tests have their own five-per-minute limit.

### Whose face is on a notification

The large icon next to a notification (Android; the small status-bar badge stays dotpals) is the pal of the agent that caused it, the same pal that agent has in the tray, wearing the expression of the matching pal state. These are the pal's own agent states, so the faces cannot drift from the app:

| Notification | Pal state | Face |
|---|---|---|
| A request finished | done | happy |
| An agent is waiting for you, or asks permission | waiting | wide-eyed |
| An agent seems stuck | thinking | pondering |
| Two agents, one file; tests given up on | error | x-eyed, sad |
| A context window is nearly full | working | hard at work |

A custom pal has no picture, so it, an unknown agent in a test, and the Send a test button use Blu. The 45 pictures (9 pals x 5 states) live in `bridge/remote/avatars/` and are drawn by the real pal: run `node scripts/make-avatars.mjs` (needs Edge or Chrome) after changing a pal or the states, and commit the result. A notification can only name one of these pictures; anything else shows the app icon. Whether the phone actually draws the large icon is up to Android and the notification's settings: it is not shown on every launcher or in every notification style.

### Updating the app on your phone

The installed app checks for a newer worker itself and does not automatically reload your current page:

- It asks your computer for a newer version when it opens, when you come back to it (at most every 10 minutes), and when you press **Settings → Remote → Check for updates**.
- A complete app shell downloads and **waits**. A small pill appears, **"An update is ready · Update · Later"**. Update activates it and reloads the requesting page once. Later hides the pill for that visit; Settings still offers Update. Another open tab may activate the worker, but this page is not automatically reloaded.
- Each worker uses its own immutable cached shell, including transitive module imports. A failed shell download leaves the existing worker in place. API/event data always uses the network. Developers must bump the worker build when shell files change without a release-version change.
- A failed check or activation is reported and can be retried. If registration failed, the Check button retries it too.

Migration exception: a worker predating the Update UI may be replaced automatically once, because its page cannot request activation. This does not force a page reload. Browsers can also activate a waiting worker naturally after all controlled pages close.

### When "Send a test" says it was sent and nothing shows

"Accepted by the push service" means only that the provider accepted the message. The worker separately records receipt and reports the result of `showNotification()`. A successful call is **not proof of a visible OS popup**.

| Settings says | What it means | What to do |
|---|---|---|
| "…browser accepted the notification display request" | The worker received it and `showNotification()` resolved. OS visibility, sound and attention are not confirmed. | Check the notification tray, browser/OS settings and Do Not Disturb. |
| "…received it but held it back because the app was open" | A real notification is held while the app is in front (it shows live). A test is never held. | Nothing: this is by design. |
| "…received it but couldn't show it (…)" | The phone has the message and the browser refused to show it. | Android Settings → Apps → the browser (or dotpals) → Notifications: allow it, and check the *dotpals* channel isn't off. |
| "…no receipt has reached the computer" | Delivery or the return connection may be delayed or unavailable; an old worker may not send receipts. | Inspect the phone-local record and worker build; check both phone internet and access back to this computer. |
| "No push is recorded on this phone" | Inconclusive: storage may be unavailable/cleared, a different worker may have handled it, or it may not have arrived. | Check the active worker/build and connectivity. Battery restrictions are one possible factor, not a diagnosis. |
| An older worker/version | The worker differs, or its version could not be read. | Use Check for updates, then Update if offered. Reload after fixing registration/connectivity failures. |

A test requests *high* urgency, a distinct tag/Topic, `renotify` and `requireInteraction`. These are hints, not guarantees of immediate delivery or presentation. Ordinary completion notifications use normal urgency. Browser, push-provider, OS, network and power policy can all affect timing.

Recent pushes lists up to ten per-device server records held in memory (five shown in Settings); restart clears them. Late receipts attach to their original send. The receipt's `at` is **when the computer heard back**, not phone arrival time. Phone-local arrival timestamps use a separate clock; subtracting the two clocks does not establish delivery latency. Preserve a test's history rather than repeatedly sending new tests.

**Physical-device test:** the fork author tested the remote client on a Samsung Galaxy Z Fold8 Ultra with dotpals 0.15.0 and reported that it worked, including notifications. Earlier intermittent delivery was observed during development; its cause was not established. This is one device and setup, not a guarantee for other Android browsers, launchers, networks or iOS. If the service rotates a subscription while the app is closed, reopening the app will attempt to repair it if notifications are still enabled. Quiet mode suppresses sends on the computer; a notification already in flight can still appear.

## Real time, cheaply

- The live stream is open **only while the app is in front of you.** Hidden for 15 seconds, it closes: no connection, no radio, no work on the computer. Coming back it asks for just what it missed (`?since=`), not the whole history.
- Changes to the same thing are sent once (a tool call that updates ten times in a moment is one message), in one write, gzip-compressed.
- Scripts and styles are cached by build. Update checks fetch the worker explicitly; uncached static requests can revalidate with ETags.
- A device that can't keep up is dropped and resumes, not buffered without limit. An idle live-stream hub has no timer; enabled TLS certificate maintenance still checks for address changes.
- An initial snapshot and activity fetch include the last 3 days by default (`remote.historyDays`, 1 to 7). This is a snapshot size setting, not a privacy boundary for live or recently buffered events.

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
- Browser pairing requires HTTPS, including on loopback. The device cookie is `HttpOnly; Secure; SameSite=Strict`, 256 random bits; only its SHA-256 is stored, in `~/.dotpals/remote.json` (0600). Plaintext never accepts browser device cookies.
- Protected API and live-stream requests require a device credential, host and origin checks, and a custom header on changes. The pairing page, HTTPS pairing claim, and public static assets are separate. Pages carry a hash-based Content Security Policy.
- Sign a device out from the computer or the device; it's cut off at once, mid-stream.
- Don't expose port 5176 to the internet without https. A tunnel is fine; port-forwarding plain http is not.
- Paired devices can read sensitive session data. Revocation cannot erase data already viewed or copied by a device. See [SECURITY.md](../SECURITY.md) for trust boundaries, private-CA cautions and push-provider metadata.

## Files

`bridge/remote-server.js` (listener, pairing, routing) · `remote.js` (devices, permissions) · `remote-hub.js` (live stream) · `remote-push.js` (what notifies) · `webpush.js` (encryption, VAPID) · `remote-assets.js` (static files) · `bridge/remote/` (the app: `boot.js`, `stream.js`, `client.js`, `swipe.js`, `settings.js`, `sw.js`, `pair.*`, `remote.css`, manifest, icons) · `bridge/vendor/qrcode.js` (MIT).
