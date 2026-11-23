# Remote client

Use the dotpals dashboard from your phone, tablet or foldable: live in your browser. **Off until you turn it on.** Desktop-only actions and remote administration stay on the computer.

Settings → Remote on the computer. Nothing here runs, listens or sends anything until then.

## Set it up

1. **Turn it on.** Settings → Remote → *Remote client*. The default port is 5176. If it is occupied, change **Port** there and use the new port in all addresses below.
2. **Give it https.** Use an HTTPS address for the remote client. Pick one:
   - **An HTTPS proxy that supports Server-Sent Events.** Keep *Reachable from* on "This computer only". For example, use `tailscale serve --bg --https=443 http://127.0.0.1:5176` and paste the HTTPS origin into *Address your devices open*. The trusted proxy must preserve the original Host, reject plaintext external access, overwrite forwarding headers, and stream SSE without buffering. Cloudflare Quick Tunnels do not support SSE; do not use them for the live dashboard.
   - **https on your own network, no tunnel.** Run `dotpals remote cert` (or Settings → Remote → *https on my network*). It makes a small private certificate authority and a certificate for this computer's LAN addresses **and its `.local` name**, points the remote client at it and prints the steps for your phone. Do the phone step once: copy `~/.dotpals/remote-cert/ca.pem` to it and install it as a CA certificate (Android: Settings → Security → Encryption & credentials → Install a certificate; iPhone/iPad: open the file, install the profile, then turn it on under Settings → General → About → Certificate Trust Settings). Compare the fingerprint it shows. After that, `https://<this computer's address>:5176/pair` works, and the QR code opens it.
     - **It looks after itself.** When the computer's address changes (a new router lease, Wi-Fi to Ethernet), dotpals issues a new certificate within a minute and swaps it in without dropping anything. The CA stays the same, so phones need nothing. A moment with no network keeps the current certificate. If a renewal fails, Settings → Remote says so and the old certificate keeps serving.
     - **Address or name?** The certificate covers both. The QR code uses the address to avoid depending on multicast DNS; your phone still needs network access to the computer. The computer's `.local` name survives an address change where mDNS resolution works. Support varies by browser, OS and network isolation; test it before relying on it. A DHCP reservation is another option.
     - The CA carries X.509 name constraints for private addresses and `.local`/localhost names. Keep its key private regardless: trust-store enforcement varies, and a leaked key can impersonate local services within those constraints. Transfer only `ca.pem`, never `ca-key.pem`.
     - Needs `openssl`; Git for Windows includes one. Windows' firewall may need to allow the app in on your network (private networks are usually already open).
   - **Your own certificate.** Set `remote.tlsCert` and `remote.tlsKey` (file paths) in `~/.dotpals/config.json`, choose "Anything on my network", and enter the matching HTTPS origin (including the port) in *Address your devices open*. If switching from a proxy to automatic LAN HTTPS, clear the old public address first.
3. **Pair.** *Pair a device* shows a QR code and a code like `7K2M-9QXD-4TBH`. Scan it with the phone's camera, or open `<your address>/pair` and type it. The code works once and expires in 5 minutes.
## What a paired device can do

Out of the box a device can **look** (the remote dashboard and its allowed data) and change how things **look and sound** (pal, sounds, notification settings, story view). It can not run anything on your computer.

Turn on **Let this device control** (on the computer, per device) and it can hand off sessions, rewind a request, start Blu's coding tasks and change ordinary settings, not remote administration. This grants powerful access to your computer, so it is separate and off by default. A look-only lost phone can still expose private session data: revoke it promptly.

Approval endpoints and the Apps tab stay on the desktop. A remote stream alone never intercepts Claude's terminal prompt.

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

## Security

- The remote listener is a **second** server. The bridge's own `127.0.0.1:5175` is not rebound or exposed. Only permitted API routes are forwarded internally; hooks, hook recap, quit, OAuth callback and remote administration stay local.
- A pairing code is 60 random bits, hashed in memory, single use, five minutes, and rides in the URL `#fragment` (not sent in the page request; the claim sends it in a POST body). The page removes it from the address bar. Pairing attempts are rate-limited.
- Browser pairing requires HTTPS, including on loopback. The device cookie is `HttpOnly; Secure; SameSite=Strict`, 256 random bits; only its SHA-256 is stored, in `~/.dotpals/remote.json` (0600). Plaintext never accepts browser device cookies.
- Protected API and live-stream requests require a device credential, host and origin checks, and a custom header on changes. The pairing page, HTTPS pairing claim, and public static assets are separate. Pages carry a hash-based Content Security Policy.
- Sign a device out from the computer or the device; it's cut off at once, mid-stream.
- Don't expose port 5176 to the internet without https. A tunnel is fine; port-forwarding plain http is not.
- Paired devices can read sensitive session data. Revocation cannot erase data already viewed or copied by a device. See [SECURITY.md](../SECURITY.md) for trust boundaries and private-CA cautions.
