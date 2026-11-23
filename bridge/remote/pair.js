// The pairing page. The code arrives in the URL's #fragment (from the QR code), which a browser never
// sends to a server or writes in a log. It's read once, taken out of the address bar and history,
// and traded for a device cookie. Typing the code works the same way.
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = (text, kind = '') => { $('msg').textContent = text; $('msg').className = kind; };
  const clean = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  const show = (s) => clean(s).replace(/(.{4})(?=.)/g, '$1-');

  // A friendly default name: "Pixel 9 Pro Fold" if the browser says, else the platform.
  async function guessName() {
    try {
      const hint = await navigator.userAgentData?.getHighEntropyValues?.(['model', 'platform']);
      if (hint?.model) return hint.model;
      if (hint?.platform) return `${hint.platform} device`;
    } catch {}
    const ua = navigator.userAgent;
    return /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android device' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'This device';
  }

  const fromHash = clean(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname); // out of the address bar and the history entry
  $('code').value = show(fromHash);
  $('code').addEventListener('input', () => { const at = $('code').selectionStart; $('code').value = show($('code').value); try { $('code').setSelectionRange(at, at); } catch {} });
  guessName().then((n) => { if (!$('name').value) $('name').value = n; });

  async function claim() {
    if (location.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return msg('Open the HTTPS pairing address before sending a code.', 'bad');
    const code = clean($('code').value);
    if (code.length !== 12) return msg('The code has 12 letters and numbers.', 'bad');
    $('go').disabled = true;
    msg('Pairing…');
    try {
      const res = await fetch('/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify({ code, name: $('name').value.trim() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { msg(body.error || `Couldn’t pair (${res.status}).`, 'bad'); $('go').disabled = false; return; }
      msg(`Paired as “${body.name}”. Opening…`, 'ok');
      location.replace('/?paired=1');
    } catch {
      msg('Couldn’t reach your computer. Is it on, and is this the right address?', 'bad');
      $('go').disabled = false;
    }
  }
  $('form').addEventListener('submit', (e) => { e.preventDefault(); claim(); });
  // Scanned: the code is already here, so there's only the name to confirm. One tap.
  if (fromHash.length === 12) { msg('Code received. Check the name, then tap Pair.'); $('name').focus(); } else $('code').focus();
})();
