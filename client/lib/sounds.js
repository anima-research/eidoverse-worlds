// sounds — the browser realizer for the `sound` component: an audio file
// playing FROM an entity, positional, through the page's ONE AudioContext.
//
//   comp {id, type: "sound", data: {src, playing?, loop?, volume?, radius?, t0?, look?}}
//
// Graph per sound: <audio> → MediaElementSource → gain (volume) → panner
// (position, distance falloff) → destination. The panner follows the entity
// every other frame (registerSystem 'sounds', from main.js) and the listener
// follows the camera, so walking past the radio sounds like walking past a
// radio. The meaning of the bag lives in shared/sound.js; this file only
// renders it.
//
// Rules:
//   1. ONE AudioContext (client/lib/audioctx.js): a fresh context per sound
//      would hit Chrome's cap in a room with six radios and go silent.
//   2. Autoplay: the browser may refuse play() until a gesture. Every sound
//      rides the shared unlock queue (client/lib/audiounlock.js), which retries
//      all held elements on the first gesture and SAYS SO in chat.
//   3. The clock is the author's: with `t0` every client seeks to the same
//      playhead ((now - t0) mod duration when looping), so a late joiner hears
//      the same bar as everyone else. Without it, the top of the track.
//   4. Replace (same id, new bag): same src → adjust in place (volume, loop,
//      playing, re-seek on a new t0); new src → tear down and rebuild. A
//      sound whose entity left the scene keeps its graph but is silenced
//      (gain 0) until the entity is back — the bag is still authored.
import { THREE, camera } from './core.js';
import { bus, CONFIG } from './base.js';
import { entities } from './world.js';
import { audioContext } from './audioctx.js';
import { playWhenAllowed } from './audiounlock.js';
import { registerEditor } from './inspect.js';
import { toast, flashHint } from './ui.js';
import { net } from './net.js';
import { normalizeSound, SOUND_LOOK_MAX, SOUND_STORE } from '../../shared/sound.js';

// id → { sound, el, srcNode, gain, panner }
const playing = new Map();
export const _playing = playing;   // probes
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

function buildGraph(id, sound) {
  const ctx = audioContext();
  const el = new Audio(`/library/${sound.src}`);
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';
  el.loop = sound.loop;
  const srcNode = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1.5;
  panner.rolloffFactor = 1.5;
  panner.maxDistance = sound.radius;
  srcNode.connect(gain); gain.connect(panner); panner.connect(ctx.destination);
  const h = { id, sound, el, srcNode, gain, panner, seeked: false };
  playing.set(id, h);
  return h;
}

function teardown(id) {
  const h = playing.get(id);
  if (!h) return;
  playing.delete(id);
  try { h.el.pause(); } catch { /* never started */ }
  h.el.removeAttribute('src'); try { h.el.load(); } catch { /* releases the decoder */ }
  try { h.srcNode.disconnect(); h.gain.disconnect(); h.panner.disconnect(); } catch { /* partial graph */ }
}

/** Seek to the shared playhead once the duration is known. */
function seekTo(h) {
  const { el, sound } = h;
  const apply = () => {
    const dur = el.duration;
    if (!sound.t0 || !Number.isFinite(dur) || dur <= 0) return;
    const elapsed = (Date.now() - sound.t0) / 1000;
    const at = sound.loop ? ((elapsed % dur) + dur) % dur : Math.min(dur, Math.max(0, elapsed));
    try { el.currentTime = at; } catch { /* not seekable yet — the loadedmetadata retry below covers it */ }
  };
  if (Number.isFinite(el.duration) && el.duration > 0) apply();
  else el.addEventListener('loadedmetadata', apply, { once: true });
}

function applyFrom(id, data) {
  if (data == null) { teardown(id); return; }
  const norm = normalizeSound(data);
  if (!norm.ok) { console.warn(`[sounds] ${id}: ${norm.why}`); teardown(id); return; }
  if (norm.notes?.length) console.warn(`[sounds] ${id}: ${norm.notes.join(' · ')}`);
  const sound = norm.sound;
  let h = playing.get(id);
  if (h && h.sound.src !== sound.src) { teardown(id); h = null; }
  if (!h) h = buildGraph(id, sound);
  const prev = h.sound; h.sound = sound;
  h.el.loop = sound.loop;
  h.gain.gain.value = sound.volume;
  h.panner.maxDistance = sound.radius;
  if (sound.playing) {
    if (prev.t0 !== sound.t0 || prev === sound || h.el.paused) seekTo(h);
    playWhenAllowed(h.el, `sound ${id}`);
  } else {
    h.el.pause();
  }
}

/** Per-frame: panners follow their entities, the listener follows the camera. */
export function tickSounds() {
  if (!playing.size) return;
  const ctx = audioContext();
  const L = ctx.listener;
  camera.getWorldPosition(_pos); camera.getWorldDirection(_fwd); _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  if (L.positionX) {
    L.positionX.value = _pos.x; L.positionY.value = _pos.y; L.positionZ.value = _pos.z;
    L.forwardX.value = _fwd.x; L.forwardY.value = _fwd.y; L.forwardZ.value = _fwd.z;
    L.upX.value = _up.x; L.upY.value = _up.y; L.upZ.value = _up.z;
  } else { L.setPosition(_pos.x, _pos.y, _pos.z); L.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z); }
  for (const h of playing.values()) {
    const root = entities.get(h.id);
    if (!root) { h.gain.gain.value = 0; continue; }   // authored, but nowhere to play from right now
    if (h.gain.gain.value === 0 && h.sound.volume > 0) h.gain.gain.value = h.sound.volume;
    root.getWorldPosition(_pos);
    const p = h.panner;
    if (p.positionX) { p.positionX.value = _pos.x; p.positionY.value = _pos.y; p.positionZ.value = _pos.z; }
    else p.setPosition(_pos.x, _pos.y, _pos.z);
  }
}

bus.on('comp', ({ id, type, data }) => { if (type === 'sound') applyFrom(id, data); });
bus.on('entity', ({ id, kind }) => { if (kind === 'remove') teardown(id); });   // demote/promote: the tick re-finds the root
bus.on('world-reset', () => clearSounds());
export function clearSounds() { for (const id of [...playing.keys()]) teardown(id); }

// ---- the editor block: how a HUMAN puts a sound on a thing ------------------
const SOUND_ACCEPT = 'audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,.mp3,.ogg,.opus,.wav,.webm,.m4a';
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function uploadSound(file) {
  const q = new URLSearchParams({ as: 'audio', name: file.name });
  if (CONFIG.token) q.set('token', CONFIG.token);
  const r = await fetch(`/upload?${q}`, { method: 'POST', body: file });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const { path } = await r.json();
  if (typeof path !== 'string' || !path.startsWith(SOUND_STORE)) throw new Error(`upload answered with an unexpected path: ${path}`);
  return path;
}

registerEditor(({ id, obj, meta, bag, commit }) => {
  if (!obj || obj.userData?.isLight) return null;
  const cur = bag?.sound && typeof bag.sound === 'object' ? bag.sound : null;
  const heldBy = bag?.guard && meta?.actor !== net.myId && net.myRights?.role !== 'owner' ? (meta?.actor ?? 'its placer') : null;
  if (heldBy) {
    return { html: `<div style="margin:4px 0;color:var(--dim)">🔊 sound — guarded by ${esc(heldBy)}; only they or the world's owner can change it${cur ? ` (${cur.playing === false ? 'paused' : 'playing'}: ${esc(cur.look ?? cur.src?.split('/').pop() ?? '?')})` : ''}</div>`, wire() {} };
  }
  const vol = cur?.volume ?? 0.8, rad = cur?.radius ?? 12;
  return {
    html: `<div data-se-root style="display:flex;flex-direction:column;gap:4px;margin:4px 0">
      <div><b>🔊 sound</b> <span style="color:var(--dim);font-size:11px">${cur ? (cur.playing === false ? 'paused' : 'playing') : 'none'}</span></div>
      <label style="display:flex;gap:6px;align-items:center">file
        <input data-se="src" type="text" placeholder="eidoverse/assets/… or store/audio/…" value="${esc(cur?.src ?? '')}" style="flex:1;font-size:11px">
        <input data-se="file" type="file" accept="${SOUND_ACCEPT}" style="display:none">
        <button data-se="pick" title="upload an MP3, Ogg, WAV, WebM or M4A into the store and use it">upload…</button></label>
      <label style="display:flex;flex-direction:column;gap:2px">what is playing <span style="color:var(--dim);font-size:11px">(what text-tier residents read; ≤${SOUND_LOOK_MAX})</span>
        <textarea data-se="look" maxlength="${SOUND_LOOK_MAX}" rows="2" style="font-size:11px;font-family:inherit">${esc(cur?.look ?? '')}</textarea></label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:4px;align-items:center">volume <input data-se="volume" type="range" min="0" max="1" step="0.05" value="${vol}"></label>
        <label style="display:flex;gap:4px;align-items:center">radius <input data-se="radius" type="number" min="1" max="200" step="1" value="${rad}" style="width:4em"> m</label>
        <label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input data-se="loop" type="checkbox"${cur?.loop === false ? '' : ' checked'}> loop</label>
      </div>
      <div style="display:flex;gap:6px">
        <button data-se="play">${cur ? 'apply + play' : 'play'}</button>
        ${cur && cur.playing !== false ? '<button data-se="pause">pause</button>' : ''}
        ${cur ? '<button data-se="silence" title="comp {type: \\"sound\\", data: null}">silence</button>' : ''}
        <span data-se="msg" style="color:var(--dim);font-size:11px"></span>
      </div>
    </div>`,
    wire(root) {
      const q = (k) => root.querySelector(`[data-se="${k}"]`);
      const msg = (t, warn = false) => { const m = q('msg'); if (m) { m.textContent = t; m.style.color = warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'; } };
      const bagFrom = (playingNow) => {
        const data = { src: q('src').value.trim(), volume: Number(q('volume').value), radius: Number(q('radius').value), loop: !!q('loop').checked, playing: playingNow };
        const look = q('look').value.trim(); if (look) data.look = look;
        if (playingNow) data.t0 = Date.now();   // (re)start: everyone seeks to the same place
        return data;
      };
      q('pick')?.addEventListener('click', () => q('file')?.click());
      q('file')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0]; if (!file) return;
        msg(`uploading ${file.name}…`);
        try { const path = await uploadSound(file); q('src').value = path; msg(`in the store as ${path.split('/').pop()} — now play it`); }
        catch (err) { msg(`upload failed: ${err.message}`, true); toast(`sound upload failed — ${err.message}`, 'warn', 8000); }
        ev.target.value = '';
      });
      q('play')?.addEventListener('click', (ev) => {
        const norm = normalizeSound(bagFrom(true));
        if (!norm.ok) { msg(norm.why, true); return; }
        commit('comp', { id, type: 'sound', data: norm.sound });
        msg(norm.notes.length ? norm.notes.join(' · ') : 'playing');
        if (norm.notes.length) flashHint(`🔊 ${esc(norm.notes[0])}`);
        ev.target.blur();
      });
      q('pause')?.addEventListener('click', (ev) => {
        const norm = normalizeSound({ ...bagFrom(false), t0: undefined });
        if (!norm.ok) { msg(norm.why, true); return; }
        commit('comp', { id, type: 'sound', data: norm.sound }); msg('paused'); ev.target.blur();
      });
      q('silence')?.addEventListener('click', (ev) => { commit('comp', { id, type: 'sound', data: null }); msg('silenced'); ev.target.blur(); });
    },
  };
});
