// sounds — the browser realizer for the `sound` component: an audio file
// playing FROM an entity, positional, through the page's ONE AudioContext.
//
//   set {id, component: "sound", value: {src, playing?, loop?, volume?, pitch?, near?, radius?, spatial?, t0?, description?}}
//
// Graph per sound: <audio> → MediaElementSource → gain (volume) → panner (position) → world bus → limiter →
// destination. The panner follows the entity every other frame (tickSounds, registered by main.js) and the listener follows
// the camera. The meaning of the bag lives in shared/sound.js; this file only renders it.
//
// Rules:
//   1. One AudioContext (../audioctx.js): a fresh context per sound would hit Chrome's cap in a room with six radios.
//   2. Autoplay: the browser may refuse play() until a gesture. Every sound rides the shared unlock queue
//      (../audiounlock.js), which retries all held elements on the first gesture and says so in chat.
//   3. The clock is the server's: with `t0` every client seeks to the same playhead ((serverNow - t0) mod duration
//      when looping), so a late joiner hears the same bar as everyone else. Without it, the top of the track.
//      serverNow() is this client's estimate of the authority's clock (../serverclock.js).
//   4. Replace (same id, new bag): same src → adjust in place (volume, loop, playing, re-seek on a new t0); new src →
//      tear down and rebuild. A sound whose entity left the scene keeps its graph but is silenced (gain 0) until the
//      entity is back.
//   5. The listener has the last word on loudness: every graph ends in one world bus whose gain is the audio panel's
//      `world volume` (voiceconsent.js volumeFor('world'), live on 'audio:volume'). What you hear is authored × yours.
//   6. Silent at radius. The distance gain is shared/sound.js gainAt (BasisVR's natural curve: inverse inside, a
//      (1-t)² taper over the last 5% to exactly 0), applied on the sound's own gain node in the tick. The panner only
//      places it (HRTF direction, rolloff 0): Web Audio's `inverse` model clamps at maxDistance instead of reaching 0.
//   7. At most VOICES (32) world sounds are heard at once, the loudest by what each would be heard at; the rest are
//      paused (their playhead is found again on the shared clock when they come back).
//   8. A limiter (DynamicsCompressor, −6 dB, 20:1, 3 ms) sits between the world bus and the speakers: a clipped upload
//      can't go past full scale.
//   9. Where the bytes come from (shared/mediasrc.js): a store file always; a trusted host's link always; any other
//      link ONLY if this viewer turned on "allow untrusted links" (mediaprefs.js); otherwise nothing is fetched. Links
//      go with no Referer (the page's <meta name="referrer">). Every link is tried as a CORS request first (Web Audio
//      needs it; its host sees the page's Origin); a host without CORS headers plays from a plain element instead,
//      volume by the same distance curve (no HRTF, no limiter: said once in the console).
//  10. Mute for me (mediaprefs.js): a muted thing's sound is gain 0, never logged.
import { THREE, camera } from '../core.js';
import { bus, CONFIG } from '../base.js';
import { entities, bags, bagOf } from '../world.js';
import { audioContext } from '../audio/audioctx.js';
import { serverNow } from '../serverclock.js';
import { playWhenAllowed } from '../audio/audiounlock.js';
import { volumeFor } from '../audio/voiceconsent.js';
import { registerEditor, registerHandler, commitEdit } from '../edit/inspect.js';
import { toast, flashHint } from '../ui/ui.js';
import { normalizeSound, gainAt, TAPER_START, SOUND_DESCRIPTION_MAX, SOUND_DESCRIPTION_HINT, SOUND_STORE, SOUND_MAX_RADIUS } from '../../../shared/sound.js';
import { mediaTier, clientMayFetch, mediaUrl } from '../../../shared/mediasrc.js';
import { allowUntrusted, isMineMuted, toggleMineMuted, RIGHTS_WARNING } from '../mediaprefs.js';
import { escapeHtml as esc } from '../ui/markup.js';

export const VOICES = 32;
// id → { sound, el, srcNode?, gain?, panner?, plain?, capped, want, done? }
const playing = new Map();
export const _playing = playing;   // probes
// id → why this browser didn't fetch it (an untrusted link without the opt-in, a page link): probes and the editor
const blocked = new Map();
export const _blocked = blocked;

// the world bus: one gain for everything placed, set from the listener's own preference, then the limiter
let worldBus = null, limiter = null;
function worldGain() {
  if (!worldBus) {
    const ctx = audioContext();
    worldBus = ctx.createGain();
    worldBus.gain.value = volumeFor('world');
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.25;
    worldBus.connect(limiter); limiter.connect(ctx.destination);
  }
  return worldBus;
}
bus.on('audio:volume', ({ cat, value }) => { if (cat === 'world' && worldBus) worldBus.gain.value = value; });
/** For probes: the listener-side gain, the limiter, and what a sound is actually heard at. */
export const _worldBus = () => worldBus;
export const _limiter = () => limiter;
export const effectiveGain = (id) => { const h = playing.get(id); if (!h) return null; return (h.plain ? h.el.volume : h.gain.gain.value * (worldBus?.gain.value ?? volumeFor('world'))); };
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _me = new THREE.Vector3();

function buildGraph(id, sound, { plain = false } = {}) {
  const el = new Audio();
  el.preload = 'auto';
  if (!plain) el.crossOrigin = 'anonymous';
  el.loop = sound.loop;
  el.playbackRate = sound.pitch ?? 1;
  el.preservesPitch = false;                       // pitch is pitch (a tape slowed down), as Unity's AudioSource
  el.src = mediaUrl(sound.src);
  const h = { id, sound, el, plain, capped: false, want: 0 };
  if (!plain) {
    const ctx = audioContext();
    h.srcNode = ctx.createMediaElementSource(el);
    h.gain = ctx.createGain(); h.gain.gain.value = 0;   // the tick sets it from the distance
    h.panner = ctx.createPanner();
    h.panner.panningModel = 'HRTF';
    h.panner.distanceModel = 'linear'; h.panner.rolloffFactor = 0;   // direction only: the gain is gainAt's
    h.srcNode.connect(h.gain);
    if (sound.spatial !== false) { h.gain.connect(h.panner); h.panner.connect(worldGain()); } else h.gain.connect(worldGain());
    // a link whose host sends no CORS headers can't feed Web Audio: play it from a plain element instead
    if (/^https:/i.test(sound.src)) el.addEventListener('error', () => {
      if (playing.get(id) !== h) return;
      console.warn(`[sounds] ${id}: ${mediaTier(sound.src, 'audio').host} sends no CORS headers, so it can't be positional; playing it plainly (distance volume, no panning)`);
      teardown(id); const p = buildGraph(id, h.sound, { plain: true }); if (p.sound.playing) { seekTo(p); playWhenAllowed(p.el, `sound ${id}`); }
    }, { once: true });
  } else el.volume = 0;
  playing.set(id, h);
  return h;
}

function teardown(id) {
  const h = playing.get(id);
  if (!h) return;
  playing.delete(id);
  try { h.el.pause(); } catch { /* never started */ }
  h.el.removeAttribute('src'); try { h.el.load(); } catch { /* releases the decoder */ }
  try { h.srcNode?.disconnect(); h.gain?.disconnect(); h.panner?.disconnect(); } catch { /* partial graph */ }
}

/** Where the shared playhead is now (seconds), or null: a one-shot that has finished. */
export function playheadOf(sound, dur, now = serverNow()) {
  if (!sound.t0 || !Number.isFinite(dur) || dur <= 0) return 0;
  const elapsed = ((now - sound.t0) / 1000) * (sound.pitch ?? 1);   // t0 is the authority's clock: so is now
  if (sound.loop) return ((elapsed % dur) + dur) % dur;
  return elapsed >= dur ? null : Math.max(0, elapsed);
}
/** Seek to the shared playhead once the duration is known; a finished one-shot doesn't play. */
function seekTo(h) {
  const { el } = h;
  const apply = () => {
    const at = playheadOf(h.sound, el.duration);
    if (at === null) { h.done = true; try { el.pause(); } catch { /* fine */ } return; }
    h.done = false;
    try { el.currentTime = at; } catch { /* not seekable yet — the loadedmetadata retry below covers it */ }
  };
  if (Number.isFinite(el.duration) && el.duration > 0) apply();
  else el.addEventListener('loadedmetadata', apply, { once: true });
}

function applyFrom(id, data) {
  if (data == null) { blocked.delete(id); teardown(id); return; }
  const norm = normalizeSound(data);
  if (!norm.ok) { console.warn(`[sounds] ${id}: ${norm.why}`); blocked.delete(id); teardown(id); return; }
  const sound = norm.sound;
  // §9: this viewer's browser fetches it only when they may (an untrusted link needs their own opt-in)
  if (!clientMayFetch(sound.src, 'audio', allowUntrusted()) || norm.tier.page) {
    teardown(id);
    blocked.set(id, norm.tier.page ? 'page' : 'untrusted');
    if (norm.tier.page) console.warn(`[sounds] ${id}: ${norm.tier.host} is a page link, not a media file; this browser can't play pages yet`);
    return;
  }
  blocked.delete(id);
  let h = playing.get(id);
  if (h && h.sound.src !== sound.src) { teardown(id); h = null; }
  if (h && !h.plain && (h.sound.spatial !== false) !== (sound.spatial !== false)) { teardown(id); h = null; }   // re-wire the panner
  if (!h) h = buildGraph(id, sound);
  const prev = h.sound; h.sound = sound;
  h.el.loop = sound.loop;
  h.el.playbackRate = sound.pitch ?? 1;
  if (sound.playing) {
    if (prev.t0 !== sound.t0 || prev === sound || h.el.paused) seekTo(h);
    if (!h.capped && !h.done) playWhenAllowed(h.el, `sound ${id}`);
  } else {
    h.el.pause();
  }
}

/** Per-frame: the distance gain (silent at radius), the VOICES loudest heard, panners follow their entities, the listener
 *  follows the camera. */
export function tickSounds() {
  if (!playing.size) return;
  const ctx = audioContext();
  const L = ctx.listener;
  camera.getWorldPosition(_me); camera.getWorldDirection(_fwd); _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  if (L.positionX) {
    L.positionX.value = _me.x; L.positionY.value = _me.y; L.positionZ.value = _me.z;
    L.forwardX.value = _fwd.x; L.forwardY.value = _fwd.y; L.forwardZ.value = _fwd.z;
    L.upX.value = _up.x; L.upY.value = _up.y; L.upZ.value = _up.z;
  } else { L.setPosition(_me.x, _me.y, _me.z); L.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z); }
  const want = [];
  for (const h of playing.values()) {
    const root = entities.get(h.id);
    if (!root || isMineMuted(h.id) || !h.sound.playing || h.done) { h.want = 0; continue; }   // authored, but nowhere to play from / muted by you
    root.getWorldPosition(_pos);
    const d = _pos.distanceTo(_me), R = h.sound.radius;
    const dist = h.sound.spatial === false ? (d >= R ? 0 : d <= TAPER_START * R ? 1 : (1 - (d - TAPER_START * R) / ((1 - TAPER_START) * R)) ** 2) : gainAt(d, h.sound.near, R);
    h.want = h.sound.volume * dist;
    if (h.panner) { const p = h.panner; if (p.positionX) { p.positionX.value = _pos.x; p.positionY.value = _pos.y; p.positionZ.value = _pos.z; } else p.setPosition(_pos.x, _pos.y, _pos.z); }
    if (h.want > 0) want.push(h);
  }
  // §7: the loudest VOICES are heard; the rest wait, paused, and rejoin the shared playhead when they're back
  want.sort((a, b) => b.want - a.want);
  const heard = new Set(want.slice(0, VOICES));
  for (const h of playing.values()) {
    const on = heard.has(h);
    if (h.plain) h.el.volume = on ? Math.min(1, h.want * (worldBus?.gain.value ?? volumeFor('world'))) : 0;
    else h.gain.gain.value = on ? h.want : 0;
    // silent by distance: it keeps playing at 0 (no gap when you walk back in); held back by the cap: paused
    if (on && h.capped) { h.capped = false; if (h.sound.playing && !h.done) { seekTo(h); playWhenAllowed(h.el, `sound ${h.id}`); } }
    else if (!on && h.want > 0 && !h.capped) { h.capped = true; try { h.el.pause(); } catch { /* fine */ } }
  }
}

bus.on('comp', ({ id, type, data }) => { if (type === 'sound') applyFrom(id, data); });
bus.on('entity', ({ id, kind }) => { if (kind === 'remove') { blocked.delete(id); teardown(id); } });   // demote/promote: the tick re-finds the root
bus.on('world-reset', () => clearSounds());
// the viewer changed what their browser may fetch: every sound is read again under the new rule
bus.on('media:trust', () => { for (const [id, c] of bags()) if (c?.sound) applyFrom(id, c.sound); });
function clearSounds() { blocked.clear(); for (const id of [...playing.keys()]) teardown(id); }

// ---- the editor block: how a human puts a sound on a thing ------------------
const SOUND_ACCEPT = 'audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,.mp3,.ogg,.opus,.wav,.webm,.m4a';

async function uploadSound(file) {
  const q = new URLSearchParams({ as: 'audio', name: file.name });
  if (CONFIG.token) q.set('token', CONFIG.token);
  const r = await fetch(`/upload?${q}`, { method: 'POST', body: file });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const { path } = await r.json();
  if (typeof path !== 'string' || !path.startsWith(SOUND_STORE)) throw new Error(`upload answered with an unexpected path: ${path}`);
  return path;
}

registerEditor(({ id, obj, bag, commit }) => {
  if (!obj) return null;
  const cur = bag?.sound && typeof bag.sound === 'object' ? bag.sound : null;
  const vol = Number(cur?.volume ?? 0.8), rad = Number(cur?.radius ?? 12);   // numbers into markup: never a string from the world
  return {
    html: `<div data-se-root style="display:flex;flex-direction:column;gap:4px;margin:4px 0">
      <div><b>🔊 sound</b> <span style="color:var(--dim);font-size:11px">${cur ? (cur.playing === false ? 'paused' : 'playing') : 'none'}</span></div>
      <label style="display:flex;gap:6px;align-items:center">file
        <input data-se="src" type="text" placeholder="store/audio/… or an https link" value="${esc(cur?.src ?? '')}" style="flex:1;font-size:11px">
        <input data-se="file" type="file" accept="${SOUND_ACCEPT}" style="display:none">
        <button data-se="pick" title="upload an MP3, Ogg, WAV, WebM or M4A into the store and use it">upload…</button></label>
      <label style="display:flex;flex-direction:column;gap:2px" title="${esc(SOUND_DESCRIPTION_HINT)}">description <span style="color:var(--dim);font-size:11px">(what is playing, in words; ≤${SOUND_DESCRIPTION_MAX})</span>
        <textarea data-se="description" maxlength="${SOUND_DESCRIPTION_MAX}" rows="2" style="font-size:11px;font-family:inherit">${esc(cur?.description ?? '')}</textarea></label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:4px;align-items:center">volume <input data-se="volume" type="range" min="0" max="1" step="0.05" value="${vol}"></label>
        <label style="display:flex;gap:4px;align-items:center">radius <input data-se="radius" type="number" min="1" max="${SOUND_MAX_RADIUS}" step="1" value="${rad}" style="width:4em"> m (silent beyond)</label>
        <label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input data-se="loop" type="checkbox"${cur?.loop === false ? '' : ' checked'}> loop</label>
      </div>
      <div style="display:flex;gap:6px">
        <button data-se="play">${cur ? 'apply + play' : 'play'}</button>
        ${cur && cur.playing !== false ? '<button data-se="pause">pause</button>' : ''}
        ${cur ? '<button data-se="silence" title="delete {id, component: \\"sound\\"}">silence</button>' : ''}
        <span data-se="msg" style="color:var(--dim);font-size:11px"></span>
      </div>
    </div>`,
    wire(root) {
      const q = (k) => root.querySelector(`[data-se="${k}"]`);
      const msg = (t, warn = false) => { const m = q('msg'); if (m) { m.textContent = t; m.style.color = warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'; } };
      const bagFrom = (playingNow) => {
        const data = { src: q('src').value.trim(), volume: Number(q('volume').value), radius: Number(q('radius').value), loop: !!q('loop').checked, playing: playingNow };
        const said = q('description').value.trim(); if (said) data.description = said;   // (re)start: the authority stamps t0 on its clock
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
        commit('sound', norm.sound);
        msg(norm.notes.length ? norm.notes.join(' · ') : 'playing');
        if (norm.notes.length) flashHint(`🔊 ${norm.notes[0]}`);
        ev.target.blur();
      });
      q('pause')?.addEventListener('click', (ev) => {
        const norm = normalizeSound({ ...bagFrom(false), ...(bagOf(id)?.sound?.t0 ? { t0: bagOf(id).sound.t0 } : {}) });
        if (!norm.ok) { msg(norm.why, true); return; }
        commit('sound', norm.sound); msg('paused'); ev.target.blur();
      });
      q('silence')?.addEventListener('click', (ev) => { commit('sound', null); msg('silenced'); ev.target.blur(); });
    },
  };
});

// ---- the build-mode inspector's gestures (fields: the schema's `sound` group).
// A new sound plays (no start-paused); the authority stamps its t0. Before the file picker: whose it is to upload.
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}
async function uploadThenSet(id) {
  flashHint(`🔊 ${RIGHTS_WARNING}`, 4000);
  const file = await pickFile(SOUND_ACCEPT); if (!file) return;
  flashHint(`uploading ${file.name}…`);
  try {
    const path = await uploadSound(file);
    const r = commitEdit(id, 'sound.src', path);
    if (r.errors?.length) flashHint(`🔊 ${r.errors.join(' · ')}`, 6000);
    else flashHint(`🔊 ${path.split('/').pop()} — playing`, 3000);
  } catch (err) { toast(`sound upload failed — ${err.message}`, 'warn', 8000); }
}
registerHandler('sound', (id, _obj, k, _v, opts) => { if (k !== 'upload' || opts?.live) return false; uploadThenSet(id); return true; });
registerHandler('sound', (id, _obj, k, _v, opts) => { if (k !== 'mute' || opts?.live) return false; const m = toggleMineMuted(id); flashHint(m ? '🔇 muted for you (nobody else)' : '🔊 you hear it again', 2500); return true; });
registerHandler('comp', (id, _obj, k, _v, opts) => { if (k !== 'add:sound' || opts?.live) return false; uploadThenSet(id); return true; });
