// browservoice — BRING YOUR OWN VOICE: a synthesized voice for anyone in a browser, with the server serving nothing.
// You point at a synthesizer you choose (local or remote: each utterance's text goes to it); nobody else pays for it (bundling an
// in-browser TTS would charge every visitor ~82 MB for a voice they didn't choose).
//
//   ws://  / http://   a synthesizer you are already running — the same protocol a headless harness speaks.
//                      Piper, Coqui, a cloud TTS, a two-line Flask app.
//
// Not the browser's speechSynthesis: it plays straight to the output device with no route to an AudioNode,
// MediaStream or Blob (WICG/speech-api#69). A voice that can be SENT must come from a synthesizer that returns bytes.

import { setTtsSource } from './tts.js';
import { report } from '../base.js';

/** Point the mouth at a ws:// or http:// synthesizer (the same ws protocol a headless harness uses). */
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
    // a synthesizer that goes away surfaces as a failed utterance, never a caller left hanging
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

  // HTTP: POST {text} → wav/mp3 bytes — the dumbest possible contract, so anything fits.
  const probe = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'test' }),
  }).catch(() => null);
  if (!probe?.ok) return false;
  // ONE AudioContext per page (audioctx.js); decodeAudioData works on the shared context even suspended.
  const { audioContext } = await import('./audioctx.js');
  const ctx = audioContext();
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

// A raw .onnx voice model from disk is the Piper engine plugin's (engine-piper.js, with its phonemizer piperphon.js), not this file's.
