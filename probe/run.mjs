import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const node = process.execPath.replace(/\\/g, '/');
const child = resolve('probe/child.js').replace(/\\/g, '/');
const variants = {
  plain: `node "${child}"`,
  amp: `& "${node}" "${child}"`,
  input: `$input | & "${node}" "${child}"`,
};
for (const shell of ['powershell.exe', 'pwsh.exe']) for (const [name, cmd] of Object.entries(variants)) {
  const out = await new Promise((ok) => {
    let o = '', e = '';
    const p = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const t = setTimeout(() => { p.kill(); ok('TIMEOUT ' + o + e); }, 8000);
    p.stdout.on('data', (c) => (o += c)); p.stderr.on('data', (c) => (e += c));
    p.on('close', (code) => { clearTimeout(t); ok(`exit ${code} ${o.trim()} ${e.trim().slice(0, 200)}`); });
    p.stdin.end(JSON.stringify({ hook_event_name: 'stop', text: 'héllo ✓' }));
  });
  console.log(`${shell} ${name}: ${out}`);
}
