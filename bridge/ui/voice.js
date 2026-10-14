// Blu's ears and voice, for Talk in the notch. Both run on this computer: listening is
// Whisper (Transformers.js), speaking is Kokoro (about 330 MB once), with the system's voice
// until Kokoro is ready. Only the models are downloaded; your voice never leaves the computer.
//
//   const voice = createVoice({ status, live, pal, heard, hearing });
//   voice.listen()   listen until you pause (or call it again to stop); heard(text) gets what you said
//   voice.listen({ quiet: true })   the same, but if you say nothing it just stops (a follow-up)
//   voice.say(text)  speak; resolves when done
//
// `hearing()`: which Whisper (Settings → Blu → Talking to Blu → Hearing), read each time it
// listens: 'quick' (English only, about 80 MB), 'better' (Whisper small: any accent, names in
// any language, about 600 MB) or 'best' (Whisper large-v3 turbo, about 760 MB, for a good
// graphics card). Options for listening only (Dictate, bridge/dictate.html): `pause` (ms of
// quiet that ends it), `longest` (ms), `speaks: false` (don't get the speaking voice ready),
// `level(rms)` (how loud the microphone is, as it comes in), `liveSeconds` (the live words come
// from only the last this many seconds: quicker, so the final words don't wait long behind them).

export const HEARING = {
  quick: { model: 'onnx-community/whisper-base.en', gpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, cpu: 'q8', size: 'about 80 MB', english: true },
  better: { model: 'onnx-community/whisper-small', gpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, cpu: 'q8', size: 'about 600 MB' },
  best: { model: 'onnx-community/whisper-large-v3-turbo', gpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, cpu: null, size: 'about 760 MB' },
};
const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
const KOKORO_JS = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

/** The microphone's samples, passed on from the audio thread. */
const RECORDER = `registerProcessor('blu-recorder', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0]?.[0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

/** Words as they should sound: "checkout.js" → "checkout dot js", no Markdown. */
const spoken = (t) => String(t).replace(/`/g, '').replace(/(\w)\.(js|ts|jsx|tsx|mjs|py|json|md|go|rs|rb|java|css|html|yml|yaml|toml|sh)\b/gi, '$1 dot $2').replace(/\s+/g, ' ').trim();
const sentences = (t) => t.split(/(?<=[.!?])\s+/).filter(Boolean);
const joined = (chunks) => { const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; };
const heardText = (r) => String(r?.text ?? '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

export function createVoice({ status = () => {}, live = () => {}, pal = () => {}, heard = () => {}, hearing = () => 'quick', voiceId = 'af_heart', pause = 1000, longest = 60_000, speaks = true, level = () => {}, liveSeconds = 0 } = {}) {
  // A graphics card to run the models on: WebGPU with an adapter. Trying WebGPU without one fails, and
  // can leave the processor fallback broken too (Linux with no graphics card).
  const gpu = (navigator.gpu?.requestAdapter() ?? Promise.resolve(null)).then((a) => !!a, () => false);

  // -- speaking ----------------------------------------------------------------------------
  let kokoro = null, kokoroLoading = null, kokoroBroken = false;
  function loadVoice() {
    if (kokoro || kokoroBroken) return Promise.resolve(kokoro);
    kokoroLoading ??= (async () => {
      const { KokoroTTS } = await import(KOKORO_JS);
      const progress_callback = (p) => { if (p.status === 'progress' && p.total) status(`Getting Blu’s voice ready (once, about 330 MB)… ${Math.round((p.loaded / p.total) * 100)}%`); };
      // Full precision on the graphics card: half precision comes out silent on some cards.
      try { if (!(await gpu)) throw new Error('no graphics card'); kokoro = await KokoroTTS.from_pretrained(KOKORO, { dtype: 'fp32', device: 'webgpu', progress_callback }); }
      catch { kokoro = await KokoroTTS.from_pretrained(KOKORO, { dtype: 'q8', device: 'wasm', progress_callback }); }
      return kokoro;
    })().catch(() => { kokoroBroken = true; return null; });
    return kokoroLoading;
  }

  let audioCtx = null, playing = null, token = 0;
  function stopSpeaking() { token++; speechSynthesis.cancel(); try { playing?.stop(); } catch {} playing = null; }
  async function say(text) {
    const words = spoken(text ?? '');
    if (!words) return;
    stopSpeaking();
    const mine = token;
    pal('speaking');
    try {
      if (!kokoro) { loadVoice(); throw new Error('not ready'); }
      // Sentence by sentence: the next one is made while this one plays.
      audioCtx ??= new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
      const parts = sentences(words);
      let next = kokoro.generate(parts[0], { voice: voiceId });
      for (let i = 0; i < parts.length; i++) {
        const audio = await next;
        if (mine !== token) return;
        next = i + 1 < parts.length ? kokoro.generate(parts[i + 1], { voice: voiceId }) : null;
        const pcm = audio.audio;
        let energy = 0; for (let k = 0; k < pcm.length; k += 64) energy += Math.abs(pcm[k]);
        if (!(energy > 0)) { kokoroBroken = true; kokoro = null; throw new Error('silent'); }
        await new Promise((ok) => {
          const buf = audioCtx.createBuffer(1, pcm.length, audio.sampling_rate);
          buf.copyToChannel(pcm, 0);
          const src = audioCtx.createBufferSource();
          src.buffer = buf; src.connect(audioCtx.destination); src.onended = () => ok();
          playing = src; src.start();
        });
      }
    } catch {
      if (mine === token) await saySystem(words);
    }
  }
  function saySystem(text) {
    return new Promise((ok) => {
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
      const v = voices.find((x) => /natural/i.test(x.name)) ?? voices.find((x) => /aria|jenny|zira|samantha/i.test(x.name)) ?? voices[0];
      if (v) u.voice = v;
      u.rate = 1.05;
      u.onend = u.onerror = () => ok();
      speechSynthesis.speak(u);
    });
  }
  speechSynthesis.getVoices();

  // -- listening ---------------------------------------------------------------------------
  let asr = null, asrKind = null, asrLoading = null;
  /** The Whisper you chose, loaded (again, when you chose another). → { run(audio), kind } */
  function recognizer() {
    const want = HEARING[hearing()] ? hearing() : 'quick';
    if (asr && asrKind === want) return Promise.resolve(asr);
    asrLoading ??= (async () => {
      const { pipeline, env } = await import(TRANSFORMERS);
      env.allowLocalModels = false;
      try { await asr?.dispose?.(); } catch {}
      asr = null;
      const load = async (kind) => {
        const h = HEARING[kind];
        const progress_callback = (p) => { if (p.status === 'progress' && p.total) status(`Getting the speech model ready (once, ${h.size})… ${Math.round((p.loaded / p.total) * 100)}%`); };
        if (await gpu) {
          try { const a = await pipeline('automatic-speech-recognition', h.model, { device: 'webgpu', dtype: h.gpu, progress_callback }); console.log(`[voice] speech model (${kind}) on the graphics card`); return a; }
          catch (err) { console.log(`[voice] graphics card didn’t work for ${kind} (${err.message})`); }
        }
        if (!h.cpu) return null; // too big for the processor
        try {
          const a = await pipeline('automatic-speech-recognition', h.model, { device: 'wasm', dtype: h.cpu, progress_callback });
          console.log(`[voice] speech model (${kind}) on the processor`);
          return a;
        } catch (err) { console.log(`[voice] the processor didn’t work for ${kind} (${err.message})`); throw err; }
      };
      let kind = want, a = await load(want);
      if (!a) { kind = 'quick'; a = await load('quick'); }
      // Whisper for any language writes what you said in English letters (a name from another language too), not in another script.
      const opts = HEARING[kind].english ? {} : { language: 'english', task: 'transcribe' };
      asr = Object.assign((audio) => a(audio, opts), { dispose: () => a.dispose?.() });
      asrKind = want;
      return asr;
    })().finally(() => { asrLoading = null; });
    return asrLoading;
  }
  // One run at a time: a second run started while another is still going can hang on the
  // graphics card. `running`: one is going now (the live words skip a turn then).
  let queue = Promise.resolve(), running = 0;
  function transcribe(audio) {
    const run = queue.then(() => recognizer()).then((a) => { running++; return a(audio).finally(() => running--); });
    queue = run.catch(() => {});
    return run;
  }

  let rec = null; // the recording in progress
  let holdNext = false; // the shortcut is held, and listening hasn't started yet
  let starting = false; // getting the microphone ready
  async function listen(options) {
    if (rec) return stop();
    if (starting) return;
    starting = true;
    try { return await begin(options); } finally { starting = false; }
  }
  async function begin({ quiet = false } = {}) {
    stopSpeaking();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { status(`Blu can’t use the microphone (${err.message}). Check the system’s microphone privacy settings.`, true); return; }
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    // Captured on the audio thread: loading the models while you talk can't drop any of it.
    const code = URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' }));
    let source, node;
    try {
      await ctx.audioWorklet.addModule(code);
      source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'blu-recorder');
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      ctx.close().catch(() => {});
      status(`Blu can’t listen (${err.message}).`, true);
      return;
    } finally { URL.revokeObjectURL(code); }
    const chunks = [];
    const started = performance.now();
    let floor = 0, samples = 0, said = false, lastLoud = started;
    const r = rec = { stream, ctx, node, chunks, peak: 0, device: stream.getAudioTracks()[0]?.label ?? '', quiet, held: holdNext };
    holdNext = false;
    node.port.onmessage = ({ data: d }) => {
      if (rec !== r) return;
      chunks.push(d);
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      r.peak = Math.max(r.peak, rms);
      samples += d.length;
      if (samples <= 6400) floor = Math.max(floor, rms); // the room's own noise, in the first 0.4 s (capped below)
      const now = performance.now();
      if (rms > Math.max(0.015, Math.min(floor, 0.02) * 2.5)) { said = true; lastLoud = now; }
      level(rms);
      // Stop after a pause once you've spoken, after 7 s of nothing, or after a minute. A
      // follow-up (quiet) that heard nothing just ends, without "didn't catch that".
      // Held (you hold the shortcut while you talk): only letting go ends it.
      if (!said && r.quiet && !r.held && now - started > 6000) stop({ discard: true, quiet: true });
      else if ((!r.held && ((said && now - lastLoud > pause) || (!said && now - started > 7000))) || now - started > longest) stop();
    };
    source.connect(node); node.connect(ctx.destination);
    // Your words as you speak, about once a second.
    r.live = setInterval(async () => {
      if (rec !== r || running || !asr || samples < 16000) return; // at least a second of you
      const all = joined(chunks);
      try { const t = heardText(await transcribe(liveSeconds ? all.subarray(Math.max(0, all.length - liveSeconds * 16000)) : all)); if (rec === r && t) live(t); } catch {}
    }, 1000);
    pal('listening');
    status(r.held ? 'Listening… let go when you’re done.' : quiet ? 'Listening… (say nothing and I’ll stop)' : 'Listening… pause when you’re done.');
    recognizer().catch(() => {}); // warm up while you talk
    if (speaks) loadVoice();
  }
  /** Stop listening and act on what was said; `discard`: throw it away (the notch closed); `quiet`: and say nothing about it. */
  async function stop({ discard = false, quiet = false } = {}) {
    const r = rec;
    if (!r) return;
    rec = null;
    clearInterval(r.live);
    r.node.disconnect(); r.stream.getTracks().forEach((t) => t.stop()); r.ctx.close();
    if (discard) { pal('idle'); if (quiet) status(''); return; }
    const audio = joined(r.chunks);
    const mic = r.device ? ` (${r.device})` : '';
    if (!audio.length) { status(`No sound reached Blu from the microphone${mic}.`, true); pal('idle'); return; }
    if (r.peak < 0.004) { status(`The microphone${mic} sent only silence. Check that dotpals may use the microphone (your system's privacy settings), and the input device.`, true); pal('idle'); return; }
    try {
      pal('thinking');
      status('Got it, one moment…');
      const text = heardText(await transcribe(audio));
      if (!text || /^(you|thank you\.?|thanks for watching!?)$/i.test(text)) { live(null); status(`Blu didn’t catch that${mic}. Try again a little closer.`); pal('idle'); return; }
      live(text);
      heard(text);
    } catch (err) {
      status(`Speech didn’t work (${err.message}).`, true);
      pal('error');
    }
  }

  // Ready ahead of time: loaded, and run once on a moment of silence (the first run on the
  // graphics card is about three times slower than the ones after it).
  const warm = () => transcribe(new Float32Array(16000)).catch(() => {});
  /** You're holding the shortcut: a pause doesn't end it, letting go (release) does. It can come before listening starts. */
  const hold = () => { if (rec) { rec.held = true; status('Listening… let go when you’re done.'); } else holdNext = true; };
  const release = () => { holdNext = false; if (rec?.held) return stop(); };
  return { listen, stop, hold, release, listening: () => !!rec, say, stopSpeaking, warm };
}
