// Private attention UI. No wire writes, audio receive consent, TTS, world
// volume, or positional audio. The shared context only supplies the clock and
// destination; each short tone owns its gain. Missed notices are never queued.
import { audioContext } from './audioctx.js';
import { createAttentionGate } from './attention-policy.js';

const KEY = 'ew-attention';
const SOUNDS = Object.freeze({ soft: 'soft', chime: 'chime', tap: 'tap' });
const DEFAULTS = { enabled: false, volume: 0.2, sound: 'soft' };
function normalize(raw) {
  return {
    enabled: raw?.enabled === true,
    volume: typeof raw?.volume === 'number' && Number.isFinite(raw.volume)
      ? Math.min(1, Math.max(0, raw.volume)) : DEFAULTS.volume,
    sound: Object.hasOwn(SOUNDS, raw?.sound) ? raw.sound : DEFAULTS.sound,
  };
}
let prefs = { ...DEFAULTS };
try { prefs = normalize(JSON.parse(localStorage.getItem(KEY))); } catch {}
export const attentionPrefs = () => ({ ...prefs });
export function setAttentionPrefs(update) {
  prefs = normalize({ ...prefs, ...update });
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
  // Preferences remain local, including error/status reporting.
  for (const h of active) h.gain.gain.value = prefs.enabled ? prefs.volume * 0.15 : 0;
}

const active = new Set();
function tone(ctx, sound, volume) {
  const gain = ctx.createGain();
  gain.gain.value = volume * 0.15;
  gain.connect(ctx.destination);
  const h = { gain }; active.add(h);
  const notes = sound === 'chime' ? [[660, 0, 0.18], [880, 0.12, 0.22]]
    : sound === 'tap' ? [[440, 0, 0.07]] : [[660, 0, 0.24]];
  let left = notes.length;
  for (const [freq, delay, duration] of notes) {
    const osc = ctx.createOscillator(), envelope = ctx.createGain();
    const start = ctx.currentTime + delay;
    osc.type = 'sine'; osc.frequency.value = freq;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(1, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(envelope); envelope.connect(gain);
    osc.onended = () => {
      osc.disconnect(); envelope.disconnect();
      if (--left === 0) { gain.disconnect(); active.delete(h); }
    };
    osc.start(start); osc.stop(start + duration + 0.01);
  }
}

let status = 'Mentions and whispers stay highlighted when sound is off.';
const views = new Set();
function showStatus(message) {
  status = message;
  for (const el of views) {
    if (!el.isConnected) views.delete(el);
    else el.textContent = status;
  }
}
function playNotice() {
  if (!prefs.enabled || !prefs.volume) return;
  try {
    const ctx = audioContext();
    if (ctx.state !== 'running') {
      showStatus('Click or press a key to enable sound; missed notices stay visual.');
      return;
    }
    tone(ctx, prefs.sound, prefs.volume);
    return true;
  } catch {
    showStatus('Attention audio unavailable; mentions and whispers stay highlighted.');
  }
}

function unlock() {
  if (!prefs.enabled || !prefs.volume) return;
  try {
    const ctx = audioContext();
    // Unlock future notices only. No sound is scheduled on this promise.
    if (ctx.state === 'running') return;
    ctx.resume().then(() => {
      if (ctx.state === 'running') showStatus('Private live mentions and whispers; chat highlights remain on.');
    }).catch(() => {});
  } catch { showStatus('Attention audio unavailable; chat highlights remain on.'); }
}

let gate;
export function initAttention({ bus, me, scope, mentions }) {
  if (gate) return;
  gate = createAttentionGate({ me, scope, mentions, play: playNotice });
  bus.on('participant-session', gate.participant);
  bus.on('participant-sessions', gate.roster);
  bus.on('participant-teardown', gate.forget);
  bus.on('live-entry', gate.say);
  for (const event of ['pointerdown', 'keydown', 'touchend']) addEventListener(event, unlock, { passive: true });
}

/** Called only by the incoming whisper path, which carries replay on held DMs. */
export function attentionWhisper(msg) {
  gate?.whisper(msg);
}

async function preview() {
  // Clicking Preview explicitly requests a local sample, even while disabled.
  try {
    const ctx = audioContext();
    await ctx.resume();
    if (ctx.state === 'running' && prefs.volume) {
      tone(ctx, prefs.sound, prefs.volume);
      showStatus('Preview played locally. Mentions and whispers stay highlighted.');
    } else showStatus('Sound is muted or held by the browser; chat highlights remain on.');
  } catch { showStatus('Attention audio unavailable; chat highlights remain on.'); }
}

/** Mounted into the chat gear in both full and renderer-free clients. */
export function mountAttentionControls(parent) {
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="gp-row"><label><input type="checkbox" data-attention="enabled"> attention sound</label></div>
    <div class="gp-row"><label>sound <select data-attention="sound">
      <option value="soft">soft</option><option value="chime">chime</option><option value="tap">tap</option>
    </select></label><button type="button" data-attention="preview">preview</button></div>
    <div class="gp-row"><label>volume <input type="range" min="0" max="100" step="1" data-attention="volume"></label></div>
    <div data-attention="status" role="status" style="max-width:240px;white-space:normal;font-size:11px"></div>`;
  const enabled = box.querySelector('[data-attention="enabled"]');
  const sound = box.querySelector('[data-attention="sound"]');
  const volume = box.querySelector('[data-attention="volume"]');
  const note = box.querySelector('[data-attention="status"]');
  enabled.checked = prefs.enabled; sound.value = prefs.sound; volume.value = String(Math.round(prefs.volume * 100));
  for (const el of views) if (!el.isConnected) views.delete(el);
  note.textContent = status; views.add(note);
  enabled.onchange = () => {
    setAttentionPrefs({ enabled: enabled.checked });
    showStatus(prefs.enabled
      ? 'Private live mentions and whispers; click Preview to test sound.'
      : 'Attention sound off; mentions and whispers stay highlighted.');
    unlock(); // onchange is still inside the enabling gesture, unlike the earlier pointerdown
  };
  sound.onchange = () => setAttentionPrefs({ sound: sound.value });
  volume.oninput = () => {
    setAttentionPrefs({ volume: Number(volume.value) / 100 });
    unlock(); // raising a saved zero volume is also an intentional audio gesture
  };
  box.querySelector('[data-attention="preview"]').onclick = preview;
  parent.append(box);
}
