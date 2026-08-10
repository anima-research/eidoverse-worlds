// browservoice — BRING YOUR OWN VOICE.
//
// A synthesized voice for a human, with the server serving nothing. The obvious
// alternative was bundling an in-browser TTS (kokoro-js, ~82MB), and it works —
// but it charges every visitor 82MB of bandwidth for a generic voice they did
// not choose, including everyone who only ever wanted a microphone. Wrong cost
// in the wrong place (R, 2026-08-08).
//
// So: a file field. You point at a model or an endpoint you already have, it
// stays on your machine, and nobody else pays for it.
//
//   ws://  / http://   a synthesizer you are already running — the same
//                      protocol an agent's harness speaks, so a human and an
//                      agent point at the same kind of thing through the same
//                      call. Piper, Coqui, a cloud TTS, a two-line Flask app.
//
// Why not the browser's own speechSynthesis: it plays straight to the output
// device and offers no route to an AudioNode, MediaStream or Blob — on Linux
// synthesis is not even in the browser (speech-dispatcher over a socket).
// WICG/speech-api#69 asks for exactly that and is still open. A voice that can
// be SENT must come from a synthesizer that returns bytes.

import { setTtsSource } from './tts.js';
import { report } from './core.js';

/** Point the mouth at a synthesizer already running locally — the same ws
 *  protocol an agent's harness uses, so a human and an agent are pointing at
 *  the same kind of thing through the same call. */
export async function setEndpointVoice(url, label) {
  const isWs = /^wss?:/.test(url);
  if (isWs) {
    const ws = await new Promise((resolve) => {
      let s; try { s = new WebSocket(url); } catch { return resolve(null); }
      const t = setTimeout(() => resolve(null), 4000);
      s.onopen = () => { clearTimeout(t); resolve(s); };
      s.onerror = () => { clearTimeout(t); resolve(null); };
    });
    if (!ws) return false;
    const pending = new Map();
    let nextId = 1;
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'synth-result') return;
      const r = pending.get(m.id); if (!r) return;
      pending.delete(m.id);
      if (!m.pcm) return r({ pcm: new Int16Array(0), sampleRate: 22050 });
      const bin = atob(m.pcm), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      r({ pcm: new Int16Array(bytes.buffer), sampleRate: m.sampleRate || 22050 });
    };
    // A synthesizer that goes away must surface as a failed utterance, never as
    // a caller left hanging forever.
    ws.onclose = () => { for (const [, r] of pending) r({ pcm: new Int16Array(0), sampleRate: 22050 }); pending.clear(); };
    setTtsSource((text) => new Promise((resolve) => {
      if (ws.readyState !== 1) return resolve({ pcm: new Int16Array(0), sampleRate: 22050 });
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'synth', id, text }));
      setTimeout(() => { if (pending.delete(id)) resolve({ pcm: new Int16Array(0), sampleRate: 22050 }); }, 15000);
    }), label || `endpoint: ${url}`);
    return true;
  }

  // HTTP: POST {text} → wav/mp3 bytes. Deliberately the dumbest possible
  // contract, so anything from a two-line Flask app to a cloud TTS fits.
  const probe = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'test' }),
  }).catch(() => null);
  if (!probe?.ok) return false;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  setTtsSource(async (text) => {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      const f32 = buf.getChannelData(0);
      const pcm = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
      return { pcm, sampleRate: buf.sampleRate };
    } catch (e) { report('tts endpoint', e); return { pcm: new Int16Array(0), sampleRate: 22050 }; }
  }, label || `endpoint: ${new URL(url).host}`);
  return true;
}

// NOT OFFERED YET: a raw .onnx voice model from disk. Piper's graph takes
// PHONEME IDS, not text, so it needs the espeak-ng phonemizer (a second wasm
// blob) before a file picker could do anything but fail silently. A field that
// accepts a model and then never speaks is worse than no field. When the
// phonemizer is wired this is where it goes — the seam does not change.
