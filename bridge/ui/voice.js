// Blu's ears and voice, for Talk in the notch. Both run on this computer: listening is
// Whisper (Transformers.js, about 80 MB once), speaking is Kokoro (about 330 MB once), with
// the system's voice until Kokoro is ready. Only the models are downloaded; your voice
// never leaves the computer.
//
//   const voice = createVoice({ status, live, pal, heard });
//   voice.listen()   listen until you pause (or call it again to stop); heard(text) gets what you said
//   voice.say(text)  speak; resolves when done

const WHISPER = 'onnx-community/whisper-base.en';
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

export function createVoice({ status = () => {}, live = () => {}, pal = () => {}, heard = () => {}, voiceId = 'af_heart' } = {}) {
  // -- speaking ----------------------------------------------------------------------------
  let kokoro = null, kokoroLoading = null, kokoroBroken = false;
  function loadVoice() {
    if (kokoro || kokoroBroken) return Promise.resolve(kokoro);
    kokoroLoading ??= (async () => {
      const { KokoroTTS } = await import(KOKORO_JS);
      const progress_callback = (p) => { if (p.status === 'progress' && p.total) status(`Getting Blu’s voice ready (once, about 330 MB)… ${Math.round((p.loaded / p.total) * 100)}%`); };
      // Full precision on the graphics card: half precision comes out silent on some cards.
      try { if (!navigator.gpu) throw new Error('no WebGPU'); kokoro = await KokoroTTS.from_pretrained(KOKORO, { dtype: 'fp32', device: 'webgpu', progress_callback }); }
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
  let asr = null, asrLoading = null;
  function recognizer() {
    if (asr) return Promise.resolve(asr);
    asrLoading ??= (async () => {
      const { pipeline, env } = await import(TRANSFORMERS);
      env.allowLocalModels = false;
      const progress_callback = (p) => { if (p.status === 'progress' && p.total) status(`Getting the speech model ready (once, about 80 MB)… ${Math.round((p.loaded / p.total) * 100)}%`); };
      if (navigator.gpu) {
        try { asr = await pipeline('automatic-speech-recognition', WHISPER, { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }); return asr; } catch {}
      }
      asr = await pipeline('automatic-speech-recognition', WHISPER, { device: 'wasm', dtype: 'q8', progress_callback });
      return asr;
    })().finally(() => { asrLoading = null; });
    return asrLoading;
  }

  let rec = null; // the recording in progress
  async function listen() {
    if (rec) return stop();
    stopSpeaking();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { status(`Blu can’t use the microphone (${err.message}). Check the system’s microphone privacy settings.`, true); return; }
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    // Captured on the audio thread: loading the models while you talk can't drop any of it.
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' })));
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'blu-recorder');
    const chunks = [];
    const started = performance.now();
    let floor = 0, samples = 0, said = false, lastLoud = started;
    const r = rec = { stream, ctx, node, chunks, peak: 0, busy: false, device: stream.getAudioTracks()[0]?.label ?? '' };
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
      // Stop after a pause once you've spoken, after 7 s of nothing, or after a minute.
      if ((said && now - lastLoud > 1400) || (!said && now - started > 7000) || now - started > 60_000) stop();
    };
    source.connect(node); node.connect(ctx.destination);
    // Your words as you speak, about once a second.
    r.live = setInterval(async () => {
      if (rec !== r || r.busy || !asr || samples < 16000) return; // at least a second of you
      r.busy = true;
      try { const t = heardText(await asr(joined(chunks))); if (rec === r && t) live(t); } catch {}
      r.busy = false;
    }, 1000);
    pal('listening');
    status('Listening… pause when you’re done.');
    recognizer().catch(() => {}); // warm up while you talk
    loadVoice();
  }
  /** Stop listening and act on what was said; `discard`: throw it away (the notch closed). */
  async function stop({ discard = false } = {}) {
    const r = rec;
    if (!r) return;
    rec = null;
    clearInterval(r.live);
    r.node.disconnect(); r.stream.getTracks().forEach((t) => t.stop()); r.ctx.close();
    if (discard) { pal('idle'); return; }
    const audio = joined(r.chunks);
    const mic = r.device ? ` (${r.device})` : '';
    if (!audio.length) { status(`No sound reached Blu from the microphone${mic}.`, true); pal('idle'); return; }
    if (r.peak < 0.004) { status(`The microphone${mic} sent only silence. Check Windows Settings → Privacy & security → Microphone, and the input device.`, true); pal('idle'); return; }
    try {
      pal('thinking');
      status('Got it, one moment…');
      const text = heardText(await (await recognizer())(audio));
      if (!text || /^(you|thank you\.?|thanks for watching!?)$/i.test(text)) { live(null); status(`Blu didn’t catch that${mic}. Try again a little closer.`); pal('idle'); return; }
      live(text);
      heard(text);
    } catch (err) {
      status(`Speech didn’t work (${err.message}).`, true);
      pal('error');
    }
  }

  return { listen, stop, listening: () => !!rec, say, stopSpeaking };
}
