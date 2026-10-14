// Blu's hands: what Blu does on your computer when you ask (the list is in bridge/buddy.js):
// play, pause and skip whatever's playing, the volume, opening apps, links and songs, moving
// and sizing windows and, only when you allow it (Settings → Blu → Your screen, music and computer), clicking,
// typing and pressing keys.
//
//   Windows  a PowerShell kept running: user32 for keys, windows and the mouse, the system's
//            audio API for the volume (exact, so it can say "40% → 30%"), Start for apps
//   macOS    osascript: AppleScript and JavaScript for Automation. Moving windows, keys and
//            clicks need dotpals allowed under Privacy & Security → Accessibility
//   Linux    playerctl (what's playing), wpctl or pactl (volume), xdotool (windows, keys and
//            clicks: X11 only, Wayland doesn't let one app move another's windows)
//
//   const hands = createHands({ shell, screen, typeOut, log });
//   await hands.run(actions, { shot, allow }) → [{ act, ok, words, error? }]
import { execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEDIA_VK = { playpause: 0xb3, play: 0xb3, pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 };
// NX_KEYTYPE_PLAY, FAST and REWIND: what Apple's own keyboards send (some apps ignore NEXT and PREVIOUS).
const MEDIA_MAC = { playpause: 16, play: 16, pause: 16, next: 19, previous: 20, stop: 16 };
const MEDIA_LINUX = { playpause: 'play-pause', play: 'play', pause: 'pause', next: 'next', previous: 'previous', stop: 'stop' };

// -- the pure parts (tested in test/hands.test.js) ---------------------------------------------

/**
 * Where a window goes: `how` (bridge/buddy.js WINDOW_MOVES), from its rectangle `cur` inside the
 * screen's work area `work` (both { x, y, w, h }, in one unit) → a new { x, y, w, h }, or
 * { cmd: 'maximize' | 'minimize' | 'restore' | 'focus' } for the ones the system does itself.
 */
export function windowRect(how, cur, work) {
  if (['maximize', 'minimize', 'restore', 'focus'].includes(how)) return { cmd: how };
  const half = (o) => ({ x: work.x, y: work.y, w: work.w, h: work.h, ...o });
  const mid = (w, h) => ({ x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.h - h) / 2, w, h });
  const step = { x: Math.round(work.w * 0.1), y: Math.round(work.h * 0.1) };
  const r = {
    smaller: () => mid(Math.max(320, cur.w * 0.8), Math.max(240, cur.h * 0.8)),
    bigger: () => mid(Math.min(work.w, cur.w * 1.25), Math.min(work.h, cur.h * 1.25)),
    left: () => half({ w: Math.round(work.w / 2) }),
    right: () => half({ x: work.x + Math.round(work.w / 2), w: work.w - Math.round(work.w / 2) }),
    top: () => half({ h: Math.round(work.h / 2) }),
    bottom: () => half({ y: work.y + Math.round(work.h / 2), h: work.h - Math.round(work.h / 2) }),
    center: () => ({ ...cur, x: work.x + (work.w - cur.w) / 2, y: work.y + (work.h - cur.h) / 2 }),
    up: () => ({ ...cur, y: cur.y - step.y }),
    down: () => ({ ...cur, y: cur.y + step.y }),
    'nudge-left': () => ({ ...cur, x: cur.x - step.x }),
    'nudge-right': () => ({ ...cur, x: cur.x + step.x }),
  }[how]?.();
  if (!r) return null;
  // Kept on the screen, whole pixels.
  const w = Math.round(Math.min(r.w, work.w)), h = Math.round(Math.min(r.h, work.h));
  return { x: Math.round(Math.min(Math.max(r.x, work.x), work.x + work.w - w)), y: Math.round(Math.min(Math.max(r.y, work.y), work.y + work.h - h)), w, h };
}

/** The app you meant, from a list of { name, … }: the exact name, else one starting with it, else one with all its words. */
export function pickApp(name, apps) {
  const q = String(name ?? '').toLowerCase().trim();
  if (!q) return null;
  const words = q.split(/\s+/);
  const score = (a) => {
    const n = String(a.name ?? '').toLowerCase();
    if (n === q) return 4;
    if (n.startsWith(q)) return 3;
    if (words.every((w) => n.includes(w))) return 2;
    if (q.includes(n) && n.length >= 3) return 1;
    return 0;
  };
  return apps.map((a) => [score(a), a]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length)[0]?.[1] ?? null;
}

/** "ctrl+shift+t" → ['ctrl', 'shift', 't'], with the usual other names made one: control → ctrl, cmd → meta… */
export function keyNames(keys) {
  const alias = { control: 'ctrl', option: 'alt', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta', return: 'enter', escape: 'esc', del: 'delete', pgup: 'pageup', pgdn: 'pagedown' };
  return String(keys ?? '').toLowerCase().split('+').map((k) => alias[k.trim()] ?? k.trim()).filter(Boolean);
}
/** Windows virtual-key codes for key names; null when one isn't known. */
export function windowsKeys(names) {
  const named = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b, enter: 0x0d, tab: 0x09, esc: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22 };
  const vks = names.map((k) => named[k] ?? (/^[a-z0-9]$/.test(k) ? k.toUpperCase().charCodeAt(0) : /^f([1-9]|1[0-2])$/.test(k) ? 0x6f + Number(k.slice(1)) : null));
  return vks.every((v) => v !== null) ? vks : null;
}
/** X11 key names (xdotool) for key names; null when one isn't known (xdotool would skip it and still say it pressed them). */
export function linuxKeys(names) {
  const named = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super', enter: 'Return', tab: 'Tab', esc: 'Escape', space: 'space', backspace: 'BackSpace', delete: 'Delete',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
  const keys = names.map((k) => named[k] ?? (/^[a-z0-9]$/.test(k) ? k : /^f([1-9]|1[0-2])$/.test(k) ? k.toUpperCase() : null));
  return keys.every(Boolean) ? keys.join('+') : null;
}

/** A point on the screenshot (its pixels) → on the screen it showed (the screen's own units: `bounds` and `scale`). */
export function shotToScreen({ x, y }, shot) {
  const d = shot.display;
  return { x: d.bounds.x + (x * d.bounds.width) / shot.w, y: d.bounds.y + (y * d.bounds.height) / shot.h };
}

/** A string for PowerShell, in single quotes (PowerShell takes the curly ones ‘ ’ ‚ ‛ as quotes too). */
export const ps = (s) => `'${String(s ?? '').replace(/[\r\n]/g, ' ').replace(/['‘’‚‛]/g, '$&$&')}'`;
/** A whole number for a PowerShell line, or $null. */
const psNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '$null');
/** A string for AppleScript, in double quotes. */
const as = (s) => `"${String(s ?? '').replace(/[\r\n]/g, ' ').replace(/[\\"]/g, '\\$&')}"`;

// -- Windows: a PowerShell kept running ---------------------------------------------------------
// One statement a line (it reads its commands from stdin); every command prints one JSON line.
const WIN_SETUP = [
  `Add-Type -Namespace DotPals -Name Hands -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags); [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e); [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v); [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size); public struct RECT { public int L, T, R, B; } [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT M; public RECT W; public uint F; }'`,
  // The volume, exactly: the default speakers' endpoint volume (Core Audio).
  `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; namespace DotPals { [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float level, Guid ctx); int j(); int GetMasterVolumeLevelScalar(out float level); int k(); int l(); int m(); int n(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx); int GetMute(out bool mute); } [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid id, int ctx, int p, out IAudioEndpointVolume v); } [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); } [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { } public class Audio { static IAudioEndpointVolume V() { var e = new MMDeviceEnumerator() as IMMDeviceEnumerator; IMMDevice d = null; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); IAudioEndpointVolume v = null; var id = typeof(IAudioEndpointVolume).GUID; Marshal.ThrowExceptionForHR(d.Activate(ref id, 23, 0, out v)); return v; } public static float Volume { get { float x = 0; Marshal.ThrowExceptionForHR(V().GetMasterVolumeLevelScalar(out x)); return x; } set { Marshal.ThrowExceptionForHR(V().SetMasterVolumeLevelScalar(value, Guid.Empty)); } } public static bool Mute { get { bool x; Marshal.ThrowExceptionForHR(V().GetMute(out x)); return x; } set { Marshal.ThrowExceptionForHR(V().SetMute(value, Guid.Empty)); } } } }'`,
  // Real pixels, so windows land where they should on a scaled screen.
  '$null = [DotPals.Hands]::SetProcessDpiAwarenessContext([IntPtr](-4))',
  'function Out($o) { [Console]::Out.WriteLine((ConvertTo-Json $o -Compress -Depth 4)) }',
  'function Win($app) { if ($app) { $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID -and ($_.ProcessName -like "*$app*" -or $_.MainWindowTitle -like "*$app*") } | Select-Object -First 1; if (-not $p) { throw "No open window for $app" }; return $p.MainWindowHandle }; return [DotPals.Hands]::GetForegroundWindow() }',
  'function WinInfo($app) { $h = Win $app; $r = New-Object DotPals.Hands+RECT; $null = [DotPals.Hands]::GetWindowRect($h, [ref]$r); $f = New-Object DotPals.Hands+RECT; if ([DotPals.Hands]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) -ne 0) { $f = $r }; $mi = New-Object DotPals.Hands+MONITORINFO; $mi.cbSize = 40; $null = [DotPals.Hands]::GetMonitorInfo([DotPals.Hands]::MonitorFromWindow($h, 2), [ref]$mi); Out @{ h = [int64]$h; rect = @($r.L, $r.T, $r.R, $r.B); frame = @($f.L, $f.T, $f.R, $f.B); work = @($mi.W.L, $mi.W.T, $mi.W.R, $mi.W.B); max = [DotPals.Hands]::IsZoomed($h); min = [DotPals.Hands]::IsIconic($h) } }',
  'function WinMove($h, $x, $y, $w, $hh) { $p = [IntPtr][int64]$h; if ([DotPals.Hands]::IsZoomed($p) -or [DotPals.Hands]::IsIconic($p)) { $null = [DotPals.Hands]::ShowWindow($p, 9) }; $null = [DotPals.Hands]::SetWindowPos($p, [IntPtr]::Zero, $x, $y, $w, $hh, 0x14); Out "ok" }',
  // Focus: tapping Alt first lets a background process bring a window forward.
  'function WinShow($h, $cmd) { $p = [IntPtr][int64]$h; $null = [DotPals.Hands]::ShowWindow($p, $cmd); if ($cmd -ne 6) { [DotPals.Hands]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [DotPals.Hands]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); $null = [DotPals.Hands]::SetForegroundWindow($p) }; Out "ok" }',
  'function Ext($v) { if (($v -ge 0x21 -and $v -le 0x2E) -or ($v -ge 0xA6 -and $v -le 0xB7) -or $v -eq 0x5B) { 1 } else { 0 } }',
  'function Press([int[]]$vks) { foreach ($v in $vks) { [DotPals.Hands]::keybd_event($v, 0, (Ext $v), [UIntPtr]::Zero) }; [array]::Reverse($vks); foreach ($v in $vks) { [DotPals.Hands]::keybd_event($v, 0, (2 -bor (Ext $v)), [UIntPtr]::Zero) }; Out "ok" }',
  'function Click($x, $y) { $null = [DotPals.Hands]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 40; [DotPals.Hands]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [DotPals.Hands]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Out "ok" }',
  'function Vol($by, $set, $mute) { $before = [math]::Round([DotPals.Audio]::Volume * 100); $wasMuted = [DotPals.Audio]::Mute; if ($mute -ne $null) { [DotPals.Audio]::Mute = $mute } else { if ($wasMuted) { [DotPals.Audio]::Mute = $false }; $to = if ($set -ne $null) { $set } else { $before + $by }; [DotPals.Audio]::Volume = [math]::Min(1.0, [math]::Max(0.0, $to / 100.0)) }; Out @{ before = $before; after = [math]::Round([DotPals.Audio]::Volume * 100); muted = [DotPals.Audio]::Mute; wasMuted = $wasMuted } }',
  'function Apps { Out @(Get-StartApps | ForEach-Object { @{ name = $_.Name; id = $_.AppID } }) }',
  'function VolGet { Out @{ volume = [math]::Round([DotPals.Audio]::Volume * 100); muted = [DotPals.Audio]::Mute } }',
  // What's playing, and play, pause and skip, exactly: Windows' media controls (any app that shows in its media flyout: Spotify, a browser tab, …).
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  "$AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, [Type]$t) { $task = $AsTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(4000); $task.Result }',
  'function Session { $m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]); $m.GetCurrentSession() }',
  'function Playing { $s = Session; if (-not $s) { Out @{ none = $true }; return }; $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]); Out @{ title = $p.Title; artist = $p.Artist; status = $s.GetPlaybackInfo().PlaybackStatus.ToString(); app = $s.SourceAppUserModelId } }',
  "function Control($what) { $s = Session; if (-not $s) { throw 'nothing is playing' }; $ok = switch ($what) { 'play' { Await ($s.TryPlayAsync()) ([bool]) } 'pause' { Await ($s.TryPauseAsync()) ([bool]) } 'next' { Await ($s.TrySkipNextAsync()) ([bool]) } 'previous' { Await ($s.TrySkipPreviousAsync()) ([bool]) } 'stop' { Await ($s.TryStopAsync()) ([bool]) } default { Await ($s.TryTogglePlayPauseAsync()) ([bool]) } }; if (-not $ok) { throw 'the app said no' }; Out 'ok' }",
  'function Browse($exe, $url) { Start-Process -FilePath $exe -ArgumentList $url; Out "ok" }',
];
// Browsers by name, for "play it in Chrome": what each system starts them as.
const BROWSER_APPS = {
  win32: { chrome: 'chrome', edge: 'msedge', brave: 'brave', firefox: 'firefox', opera: 'opera', vivaldi: 'vivaldi' },
  darwin: { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave Browser', firefox: 'Firefox', safari: 'Safari', opera: 'Opera', vivaldi: 'Vivaldi', arc: 'Arc' },
  linux: { chrome: 'google-chrome', edge: 'microsoft-edge', brave: 'brave-browser', firefox: 'firefox', opera: 'opera', vivaldi: 'vivaldi' },
};

function windowsHelper(log) {
  let proc = null, out = '';
  const waiting = [];
  function start() {
    if (proc && proc.exitCode === null && !proc.killed) return proc;
    const p = proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    out = '';
    p.on('error', (err) => log(`hands helper: ${err.message}`));
    p.on('exit', (code) => { if (proc !== p) return; proc = null; for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.fail(new Error(`the helper stopped (${code})`)); } });
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => log(`hands helper error: ${String(d).trim().slice(0, 300)}`));
    p.stdout.on('data', (d) => {
      const lines = (out + d).split(/\r?\n/);
      out = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const w = waiting.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        let v; try { v = JSON.parse(line); } catch { v = line; }
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string') w.fail(new Error(v.error)); else w.ok(v);
      }
    });
    p.stdin.write(`${WIN_SETUP.join('\n')}\n`);
    return p;
  }
  /** Run one command → its JSON answer. Too slow and the helper starts over (the answers would come out of step). */
  function call(line, timeoutMs = 10_000) {
    return new Promise((ok, fail) => {
      const p = start();
      const w = { ok, fail };
      w.timer = setTimeout(() => { if (proc === p) proc = null; for (const x of waiting.splice(0)) { clearTimeout(x.timer); x.fail(new Error('Windows took too long')); } try { p.kill(); } catch {} }, timeoutMs);
      waiting.push(w);
      p.stdin.write(`try { ${line} } catch { Out @{ error = $_.Exception.Message } }\n`);
    });
  }
  return { call, warm: () => { start(); }, stop: () => { try { proc?.kill(); } catch {} } };
}

// -- the hands ----------------------------------------------------------------------------------

/** Run a program (no shell) → its output, trimmed; fails with what it said. */
const run = (file, args, timeout = 6000) => new Promise((ok, fail) => execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => (err ? fail(new Error(String(stderr || err.message).trim().slice(0, 200))) : ok(String(stdout).trim()))));
/** macOS: is dotpals allowed under Accessibility? (`ask`: show the system's prompt.) */
async function macTrusted(ask) {
  const { systemPreferences } = await import('electron');
  return systemPreferences.isTrustedAccessibilityClient(ask);
}

/**
 * `shell` and `screen`: Electron's. `typeOut(text)`: type where the cursor is (desktop/main.js
 * pastes it). `log(line)`: for what went wrong. For tests, the system can be swapped out:
 * `exec(file, args, timeout)` → output, `start(file, args)` (a program left running),
 * `trusted(ask)` (macOS Accessibility), `menuApps()` (Linux's menu).
 */
export function createHands({ shell, screen, typeOut, log = () => {}, platform = process.platform, exec = run, start = startDetached, trusted = macTrusted, menuApps = linuxApps }) {
  const win = platform === 'win32' ? windowsHelper(log) : null;
  let apps = null; // Windows: the Start menu's apps, looked up again after 10 minutes

  const osa = (script, lang = 'AppleScript') => exec('osascript', ['-l', lang, '-e', script]);
  const macAllowed = async () => {
    if (await trusted(false)) return;
    await trusted(true); // asks you
    throw new Error('allow dotpals under Privacy & Security → Accessibility, then ask again');
  };
  const missing = (tool) => (err) => { throw /ENOENT|not found/i.test(err.message) ? new Error(`install ${tool} for this`) : err; };
  // Linux: xdotool works on X11 only (Wayland doesn't let one app move another's windows or press its keys).
  const xdo = (args) => exec('xdotool', args).catch((err) => {
    if (process.env.WAYLAND_DISPLAY || /open display/i.test(err.message)) throw new Error('this needs an X11 session: Wayland doesn’t let one app move other apps’ windows or press their keys');
    return missing('xdotool')(err);
  });

  async function media(key) {
    // Windows: the media controls (play and pause each do just that); the media keys when nothing's there.
    if (platform === 'win32') return win.call(`Control ${ps(key)}`).catch(() => win.call(`Press @(${MEDIA_VK[key]})`));
    if (platform === 'darwin') {
      await macAllowed();
      const code = MEDIA_MAC[key];
      // The key down and up, as a system-defined event (NSEvent: AppKit; posting it: CoreGraphics).
      return osa(`ObjC.import('AppKit'); ObjC.import('CoreGraphics'); for (const down of [true, false]) { const e = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, {x: 0, y: 0}, down ? 0xa00 : 0xb00, 0, 0, $(), 8, (${code} << 16) | ((down ? 0xa : 0xb) << 8), -1); $.CGEventPost(0, e.CGEvent); }`, 'JavaScript');
    }
    return exec('playerctl', [MEDIA_LINUX[key]]).catch(missing('playerctl'));
  }

  /** → { before, after, muted } where the system can tell. */
  async function volume(a) {
    if (platform === 'win32') return win.call(`Vol ${psNum(a.by)} ${psNum(a.set)} ${a.mute === undefined ? '$null' : a.mute === true ? '$true' : '$false'}`);
    if (platform === 'darwin') {
      const before = Number(await osa('output volume of (get volume settings)'));
      // "missing value": speakers the Mac can't set the volume of (HDMI, some USB).
      if (a.mute === undefined && !Number.isFinite(before)) throw new Error('these speakers’ volume can’t be changed from the Mac');
      if (a.mute !== undefined) await osa(`set volume output muted ${a.mute === true}`);
      else await osa(`set volume output volume ${Math.max(0, Math.min(100, a.set ?? before + a.by))} without output muted`);
      return { before, after: Number(await osa('output volume of (get volume settings)')) };
    }
    const wp = a.mute !== undefined ? ['set-mute', '@DEFAULT_AUDIO_SINK@', a.mute ? '1' : '0'] : ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', a.set !== undefined ? `${a.set / 100}` : `${Math.abs(a.by)}%${a.by > 0 ? '+' : '-'}`];
    const pa = a.mute !== undefined ? ['set-sink-mute', '@DEFAULT_SINK@', a.mute ? '1' : '0'] : ['set-sink-volume', '@DEFAULT_SINK@', a.set !== undefined ? `${a.set}%` : `${a.by > 0 ? '+' : '-'}${Math.abs(a.by)}%`];
    // pactl, unlike wpctl, goes past 100% (and distorts): no louder than that.
    const pactl = async () => {
      await exec('pactl', pa);
      if (a.by > 0 && Number(/(\d+)%/.exec(await exec('pactl', ['get-sink-volume', '@DEFAULT_SINK@']).catch(() => ''))?.[1]) > 100) await exec('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '100%']);
    };
    await exec('wpctl', wp).catch(pactl).catch(missing('wpctl or pactl'));
    return {};
  }

  async function open(name) {
    if (platform === 'win32') {
      if (!apps || Date.now() - apps.at > 600_000) apps = { at: Date.now(), list: [].concat(await win.call('Apps', 15_000)).filter((a) => a?.name && a?.id) };
      const app = pickApp(name, apps.list);
      if (!app) throw new Error(`no app called “${name}” in the Start menu`);
      start('explorer.exe', [`shell:AppsFolder\\${app.id}`]);
      return app.name;
    }
    if (platform === 'darwin') {
      const app = BROWSER_APPS.darwin[name.toLowerCase()] ?? name; // "Chrome" is "Google Chrome" to macOS
      await exec('open', ['-a', app]).catch(() => { throw new Error(`no app called “${name}”`); });
      return app;
    }
    const app = pickApp(name, menuApps());
    if (!app) throw new Error(`no app called “${name}”`);
    // The launchers hand their output to the app: sent nowhere, or this would wait for the app to close it.
    const launch = (...cmd) => exec('sh', ['-c', '"$@" >/dev/null 2>&1', 'sh', ...cmd]);
    await launch('gtk-launch', app.id).catch(() => launch('gio', 'launch', app.path)).catch(() => { throw new Error(`couldn’t open ${app.name} (with gtk-launch or gio)`); });
    return app.name;
  }

  async function window(a) {
    if (platform === 'win32') {
      const i = await win.call(`WinInfo ${ps(a.app)}`);
      const [l, t, r, b] = i.frame, [rl, rt, rr, rb] = i.rect, [wl, wt, wr, wb] = i.work;
      const to = windowRect(a.how, i.max || i.min ? { x: wl, y: wt, w: wr - wl, h: wb - wt } : { x: l, y: t, w: r - l, h: b - t }, { x: wl, y: wt, w: wr - wl, h: wb - wt });
      if (!to) throw new Error(`can’t do “${a.how}” to a window`);
      if (to.cmd) return win.call(`WinShow ${i.h} ${{ maximize: 3, minimize: 6, restore: 9, focus: 5 }[to.cmd]}`);
      // SetWindowPos places the whole window, its invisible resize border too: add it back.
      const inset = { l: l - rl, t: t - rt, r: rr - r, b: rb - b };
      return win.call(`WinMove ${i.h} ${to.x - inset.l} ${to.y - inset.t} ${to.w + inset.l + inset.r} ${to.h + inset.t + inset.b}`);
    }
    if (platform === 'darwin') {
      await macAllowed();
      const proc = a.app ? `(first application process whose name contains ${as(a.app)})` : '(first application process whose frontmost is true)';
      const tell = (body) => osa(`tell application "System Events" to tell ${proc} to ${body}`);
      const [x, y, w, h] = (await tell('get (position of window 1) & (size of window 1)')).split(/,\s*/).map(Number);
      const work = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
      const to = windowRect(a.how, { x, y, w, h }, { x: work.x, y: work.y, w: work.width, h: work.height });
      if (!to) throw new Error(`can’t do “${a.how}” to a window`);
      if (to.cmd === 'minimize' || to.cmd === 'restore') return tell(`set value of attribute "AXMinimized" of window 1 to ${to.cmd === 'minimize'}`);
      if (to.cmd === 'focus') return tell('set frontmost to true');
      const r = to.cmd === 'maximize' ? { x: work.x, y: work.y, w: work.width, h: work.height } : to;
      return tell(`set position of window 1 to {${r.x}, ${r.y}}`).then(() => tell(`set size of window 1 to {${r.w}, ${r.h}}`));
    }
    // xdotool search fails without a word when it finds none. A minimized window isn't "visible":
    // to bring one back, all of them count (the app's own window is the last, usually).
    const search = (all) => xdo(['search', ...(all ? [] : ['--onlyvisible']), '--class', a.app]).then((ids) => ids.split('\n')).catch((err) => { if (err.message.startsWith('Command failed')) return []; throw err; });
    const id = a.app ? (await search(false))[0] ?? (['focus', 'restore'].includes(a.how) ? (await search(true)).pop() : undefined)
      : await xdo(['getactivewindow']).catch((err) => { throw err.message.includes('_NET_ACTIVE_WINDOW') ? new Error('can’t tell which window is in front: name the app') : err; });
    if (!id) throw new Error(`no open window for ${a.app}`);
    const geometry = async (first = []) => Object.fromEntries((await xdo([...first, 'getwindowgeometry', '--shell', id])).split('\n').map((l) => l.split('=')).map(([key, v]) => [key, Number(v)]));
    const g = await geometry();
    // Moving a window to where xdotool says it is moves it by its title bar (some versions count it
    // twice): for the moves that start from where it is, try that once and take off how far it went.
    // A busy window manager can take longer than 0.1 s: read again until it stops moving.
    if (['smaller', 'bigger', 'up', 'down', 'nudge-left', 'nudge-right'].includes(a.how)) {
      let m = await geometry(['windowmove', id, String(g.X), String(g.Y), 'sleep', '0.1']);
      for (let i = 0, was = ''; i < 8 && `${m.X},${m.Y}` !== was; i++) { was = `${m.X},${m.Y}`; m = await geometry(['sleep', '0.05']); }
      Object.assign(g, { X: 2 * g.X - m.X, Y: 2 * g.Y - m.Y });
    }
    const d = screen.getDisplayMatching({ x: g.X, y: g.Y, width: g.WIDTH, height: g.HEIGHT });
    const k = d.scaleFactor || 1, work = { x: d.workArea.x * k, y: d.workArea.y * k, w: d.workArea.width * k, h: d.workArea.height * k };
    const to = windowRect(a.how, { x: g.X, y: g.Y, w: g.WIDTH, h: g.HEIGHT }, work);
    if (!to) throw new Error(`can’t do “${a.how}” to a window`);
    if (to.cmd === 'minimize') return xdo(['windowminimize', id]);
    if (to.cmd === 'focus' || to.cmd === 'restore') return xdo(['windowactivate', id]);
    const r = to.cmd === 'maximize' ? work : to;
    return xdo(['windowsize', id, String(r.w), String(r.h), 'windowmove', id, String(r.x), String(r.y)]);
  }

  async function click(point, shot) {
    if (!shot?.display || !shot.w) throw new Error('there’s no screenshot to click on');
    const p = shotToScreen(point, shot);
    if (platform === 'win32') {
      const px = screen.dipToScreenPoint({ x: Math.round(p.x), y: Math.round(p.y) });
      return win.call(`Click ${Math.round(px.x)} ${Math.round(px.y)}`);
    }
    if (platform === 'darwin') {
      await macAllowed();
      // Move there, left button down, up (kCGEventMouseMoved, LeftMouseDown, LeftMouseUp), in points like Electron's screen.
      return osa(`ObjC.import('CoreGraphics'); const p = {x: ${Math.round(p.x)}, y: ${Math.round(p.y)}}; for (const t of [5, 1, 2]) $.CGEventPost(0, $.CGEventCreateMouseEvent(null, t, p, 0));`, 'JavaScript');
    }
    const k = shot.display.scale || 1;
    return xdo(['mousemove', String(Math.round(p.x * k)), String(Math.round(p.y * k)), 'click', '1']);
  }

  async function keys(combo) {
    const names = keyNames(combo);
    if (platform === 'win32') {
      const vks = windowsKeys(names);
      if (!vks) throw new Error(`don’t know the keys “${combo}”`);
      return win.call(`Press @(${vks.join(',')})`);
    }
    if (platform === 'darwin') {
      const mods = names.filter((k) => ['ctrl', 'alt', 'shift', 'meta'].includes(k)).map((k) => ({ ctrl: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down' }[k]));
      const key = names.filter((k) => !['ctrl', 'alt', 'shift', 'meta'].includes(k))[0] ?? '';
      // Key codes (Carbon's Events.h kVK_*); a letter or a digit is typed as itself, anything else would be typed out as words.
      const code = { enter: 36, tab: 48, space: 49, backspace: 51, esc: 53, delete: 117, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
        f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 }[key];
      if (code === undefined && !/^[a-z0-9]$/.test(key)) throw new Error(`don’t know the keys “${combo}”`);
      await macAllowed();
      const using = mods.length ? ` using {${mods.join(', ')}}` : '';
      return osa(`tell application "System Events" to ${code !== undefined ? `key code ${code}` : `keystroke ${as(key)}`}${using}`);
    }
    const x11 = linuxKeys(names);
    if (!x11) throw new Error(`don’t know the keys “${combo}”`);
    return xdo(['key', '--clearmodifiers', x11]);
  }

  /** Play a song: the link the bridge found (bridge/buddy.js resolvePlay), or the Music app on macOS. */
  async function play(a) {
    if (a.applemusic) {
      try { return await osa(`tell application "Music" to play (item 1 of (search library playlist 1 for ${as(a.applemusic)}))`); }
      catch { return openIn(`https://www.youtube.com/results?search_query=${encodeURIComponent(a.applemusic)}`, a.browser); } // not in your library
    }
    // Only YouTube's pages and Spotify's own links, whole (no quotes or spaces that would reach the app as more of its command line).
    const url = String(a.url ?? '');
    if (/^spotify:(track|search):[\w%.!~*'()-]+$/.test(url)) return shell.openExternal(url);
    if (!/^https:\/\/(www|music)\.youtube\.com\//.test(url)) throw new Error('nothing found to play');
    return openIn(url, a.browser);
  }
  /** A page in the browser you named, else your usual one (also when that browser isn't installed). */
  async function openIn(page, browser) {
    const url = new URL(page).href; // as one piece: spaces and quotes encoded, so it stays one argument
    const app = BROWSER_APPS[platform]?.[browser];
    if (!app) return shell.openExternal(url);
    try {
      if (platform === 'win32') return await win.call(`Browse ${ps(app)} ${ps(url)}`);
      if (platform === 'darwin') return await exec('open', ['-a', app, url]);
      return start(app, [url], () => shell.openExternal(url));
    } catch (err) {
      log(`hands: ${browser} didn’t open (${err.message}); your usual browser instead`);
      return shell.openExternal(url);
    }
  }

  /** What's playing → { title, artist, playing, app } or null. Windows: any app in the media flyout; macOS: Spotify or Music; Linux: any MPRIS player. */
  async function nowPlaying() {
    try {
      if (platform === 'win32') {
        const p = await win.call('Playing', 6000);
        return p?.none || !p?.title ? null : { title: p.title, artist: p.artist ?? '', playing: p.status === 'Playing', app: appName(p.app) };
      }
      if (platform === 'darwin') {
        // JavaScript, not AppleScript: AppleScript needs every app it names installed just to compile
        // (no Spotify, no answer about Music either). running() doesn't open an app that's closed.
        const out = await osa(`function run() { for (const name of ['Spotify', 'Music']) { try { const app = Application(name); if (!app.running()) continue; const state = app.playerState(); if (state !== 'stopped') return [app.currentTrack.name(), app.currentTrack.artist(), state, name].join('\\t'); } catch (e) {} } return ''; }`, 'JavaScript');
        const [title, artist, state, app] = out.split('\t');
        return title ? { title, artist, playing: state === 'playing', app } : null;
      }
      const out = await exec('playerctl', ['metadata', '--format', '{{title}}\t{{artist}}\t{{status}}\t{{playerName}}']);
      const [title, artist, status, app] = out.split('\t');
      return title ? { title, artist, playing: status === 'Playing', app: appName(app) } : null;
    } catch { return null; }
  }

  /** The volume as it is, without changing anything → { volume, muted } or null (Linux: not read). */
  async function readVolume() {
    if (platform === 'win32') return win.call('VolGet');
    if (platform === 'darwin') {
      const s = await exec('osascript', ['-e', 'get volume settings']); // "output volume:50, input volume:75, alert volume:100, output muted:false"
      const volume = Number(/output volume:(\d+)/.exec(s)?.[1]);
      return Number.isFinite(volume) ? { volume, muted: /output muted:true/.test(s) } : null;
    }
    return null;
  }
  // Quieter while you talk to Blu: music that's playing goes down to a third while it listens,
  // so it hears you and not the song, and back up after (unless the volume was changed meanwhile:
  // "turn it down" stays down).
  let ducked = null, wanted = false; // { from, to }; whether it should be down now
  async function duck(on) {
    wanted = on;
    try {
      if (on) {
        if (ducked) return;
        const [now, v] = await Promise.all([nowPlaying(), readVolume()]);
        if (!wanted || !now?.playing || !v || v.muted || v.volume < 15) return;
        const to = Math.max(8, Math.round(v.volume / 3));
        await volume({ set: to });
        ducked = { from: v.volume, to };
        if (!wanted) await duck(false); // listening ended while it was turned down
      } else if (ducked) {
        const was = ducked;
        ducked = null;
        const v = await readVolume();
        if (v && Math.abs(v.volume - was.to) <= 1) await volume({ set: was.from });
      }
    } catch (err) { log(`hands: ducking: ${err.message}`); }
  }

  /** Do the actions in order → a receipt for each. `allow`: { hands, click } from your settings. */
  async function run(actions, { shot = null, allow = { hands: true, click: false } } = {}) {
    const done = [];
    for (const a of (Array.isArray(actions) ? actions : []).slice(0, 6)) {
      const receipt = { act: a.act, ok: false, words: a.words ?? a.act };
      try {
        if (!allow.hands) throw new Error('Blu’s hands are off (Settings)');
        if (['click', 'type', 'keys'].includes(a.act) && !allow.click) throw new Error('clicking and typing are off (Settings)');
        if (a.act === 'media') await media(a.key);
        else if (a.act === 'volume') {
          const v = await volume(a);
          if (Number.isFinite(v?.before) && Number.isFinite(v?.after)) receipt.words = a.mute !== undefined ? (a.mute ? `Muted (${v.after}%)` : `Unmuted, ${v.after}%`) : `Volume ${v.before}% → ${v.after}%`;
        } else if (a.act === 'play') await play(a);
        else if (a.act === 'open') receipt.words = `Opened ${await open(a.app)}`;
        else if (a.act === 'url') { if (!/^https?:\/\//.test(a.url)) throw new Error('only web pages'); await openIn(a.url, a.browser); }
        else if (a.act === 'window') await window(a);
        else if (a.act === 'click') await click(a, shot);
        else if (a.act === 'type') { const r = await typeOut(a.text); if (!r?.ok) throw new Error(r?.error ?? 'couldn’t type'); }
        else if (a.act === 'keys') await keys(a.keys);
        else throw new Error('Blu can’t do that');
        receipt.ok = true;
      } catch (err) {
        receipt.error = err.message;
        log(`hands: ${a.act} failed: ${err.message}`);
      }
      done.push(receipt);
      // Give an app a moment to open before the next step works on it ("open Spotify and make it smaller").
      if (receipt.ok && ['open', 'play', 'url'].includes(a.act)) await new Promise((r) => setTimeout(r, 1200));
    }
    return done;
  }

  return { run, nowPlaying, duck, warm: () => win?.warm(), stop: () => win?.stop() };
}

/** An app's id as a name: "Spotify.exe" → "Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" → "Spotify", "chromium.instance42" → "Chromium". */
export function appName(id) {
  const s = String(id ?? '').split('!').pop().replace(/\.exe$/i, '').split('.').filter((x) => x && !/^instance\d*$/.test(x)).pop() ?? '';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Start a program and leave it running; `failed()` if it can't start. */
function startDetached(file, args, failed = () => {}) {
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', failed).unref();
}

/** Linux: the apps in the menu (.desktop files), { name, id, path }. */
function linuxApps() {
  const dirs = ['/usr/share/applications', '/usr/local/share/applications', join(homedir(), '.local/share/applications'), '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications'];
  const list = [];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      try {
        const text = readFileSync(join(dir, f), 'utf8');
        const name = /^Name=(.+)$/m.exec(text)?.[1];
        if (name && !/^NoDisplay=true$/m.test(text)) list.push({ name, id: f.replace(/\.desktop$/, ''), path: join(dir, f) });
      } catch {}
    }
  }
  return list;
}
