// videos — the browser realizer for the `video` component: a live stream on a quad of its own, with its sound coming
// from the thing (shared/video.js says what the bag MEANS; this file only renders it).
//
//   video {source, volume?, near?, radius?, spatial?, width?, lit?, alt?}
//
// The viewer never learns where the stream is. It makes a WebRTC offer (receive-only, video and audio) and sends it over
// its own connection (video-offer); the sequencer posts it to the projector with the operator's read credential and
// returns the answer (server/videosources.ts). Media then flows from the appliance to this browser.
//
// Rules:
//   1. Every change of intent bumps the screen's revision (picture's rule, Mica #186 blocker 1): a new bag, a removal,
//      the entity leaving, a world reset. An answer or a reconnect that arrives for an older revision is dropped and its
//      peer connection closed, so a stale stream can never land on a newer screen.
//   2. The quad is picture's: width from the bag, height from the stream's aspect (16:9 until a frame says otherwise),
//      facing +Z on the thing's origin, self-lit by default.
//   3. The sound is sound's: the stream's audio goes MediaStreamSource → gain → panner → the world bus (sounds.js), so the
//      listener's world volume and the limiter apply, and the gain is the authored volume × gainAt's distance law, set
//      in the tick. Mute for me (mediaprefs.js) is gain 0, never logged.
//   4. THE PLAYBACK STATE is this viewer's own, from local evidence only, and the screen says it:
//        connecting  the offer is out and no track has arrived
//        buffering   tracks arrived and no frame has been presented yet
//        playing     frames are being presented (requestVideoFrameCallback, or currentTime advancing)
//        stalled     connected, but no new frame for STALL_MS
//        error       the sequencer or the connection refused or failed (the reason is said)
//        blocked     this browser won't show it (a fifth screen at once; no WebRTC)
//      Anything but playing draws a plate with the state in words instead of the video: a frozen frame is never shown
//      as if it were live. The source's state (what the appliance observed) is look's, not this screen's.
//   5. A dropped or failed connection reconnects with backoff (1 s doubling to 30 s) while the bag is unchanged; a
//      session the sequencer closed because the screen changed or the source was revoked is not retried.
//   6. At most MAX_SCREENS (4) play at once in this browser, as the sequencer allows per viewer; the rest say blocked.
//   7. Autoplay: the video element is muted (video autoplays muted everywhere) and the sound is Web Audio's, so a held
//      AudioContext is the shared unlock queue's business (audiounlock.js), as every placed sound's is.
import { THREE, camera } from './core.js';
import { bus } from './base.js';
import { net } from './net.js';
import { entities, bagOf } from './world.js';
import { audioContext } from './audioctx.js';
import { worldBusNode } from './sounds.js';
import { isMineMuted, toggleMineMuted } from './mediaprefs.js';
import { registerHandler, registerLive } from './inspect.js';
import { flashHint } from './ui.js';
import { normalizeVideo, videoGain, noteSourceState, SOURCE_STATES } from '../../shared/video.js';

export const MAX_SCREENS = 4;
export const STALL_MS = 2_000;
export const ICE_GATHER_MS = 2_000;
/** A connection that hasn't shown a frame this long after its offer went out is retried: an answer that never came, or
 *  ICE that never connected, must not leave a screen saying connecting forever. */
export const CONNECT_WATCHDOG_MS = 15_000;
const BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const NO_RETRY = /changed|revoked|ended|isn't admitted|has no video|closed by the viewer/;

// id → the screen: { video, rev, state, why, pc, el, tex, plate, quad, aspect, session, req, lastFrame, attempt, timer, audio }
const screens = new Map();
export const _screens = screens;   // probes
export const _builds = [];         // probes: why each screen was (re)built, in order
const revision = new Map();
const bump = (id) => { const r = (revision.get(id) ?? 0) + 1; revision.set(id, r); return r; };
const current = (id, r) => revision.get(id) === r;
let reqN = 0;

/** This viewer's playback state for a screen (probes, the inspector): {state, why} or null. */
export function playbackState(id) { const s = screens.get(id); return s ? { state: s.state, why: s.why ?? null } : null; }

// ---- the plate: the state in words, drawn where the video would be ----
const WORDS = { connecting: 'connecting…', buffering: 'buffering…', stalled: 'stalled: no new frames', error: 'not playing', blocked: 'not shown here', playing: '' };
function plateTexture(state, why) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 288;
  const g = cv.getContext('2d'); g.fillStyle = '#0b0d10'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = state === 'error' || state === 'blocked' ? '#e8a29a' : '#c9d1d9'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '600 34px system-ui, sans-serif'; g.fillText(WORDS[state] ?? state, cv.width / 2, cv.height / 2 - (why ? 18 : 0));
  if (why) { g.font = '22px system-ui, sans-serif'; g.fillStyle = '#8b949e'; g.fillText(String(why).slice(0, 48), cv.width / 2, cv.height / 2 + 26); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function quadOf(video, aspect) {
  const w = video.width, h = w * aspect;
  const g = new THREE.Group(); g.name = 'video-quad'; g.userData.videoQuad = true;
  const M = video.lit === 'scene' ? THREE.MeshStandardMaterial : THREE.MeshBasicMaterial;
  const mat = new M(M === THREE.MeshStandardMaterial ? { roughness: 0.9, metalness: 0 } : {});
  const geo = new THREE.PlaneGeometry(w, h); geo.translate(0, h / 2, 0);
  const front = new THREE.Mesh(geo, mat), back = new THREE.Mesh(geo, mat);
  back.rotation.y = Math.PI; front.position.z = 0.001; back.position.z = -0.001;
  g.add(front, back); g.userData.mat = mat; g.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return g;
}
function show(s) {
  const root = entities.get(s.id); if (!root) return;
  if (!s.quad) { s.quad = quadOf(s.video, s.aspect); root.add(s.quad); }
  const mat = s.quad.userData.mat;
  const want = s.state === 'playing' && s.tex ? s.tex : (s.plate?.userData?.key === `${s.state}|${s.why ?? ''}` ? s.plate : null) ?? (() => {
    s.plate?.dispose?.(); const t = plateTexture(s.state, s.why); t.userData.key = `${s.state}|${s.why ?? ''}`; s.plate = t; return t; })();
  if (mat.map !== want) { mat.map = want; mat.needsUpdate = true; }
}
function setState(s, state, why = null) {
  if (s.state === state && s.why === why) return;
  s.state = state; s.why = why; show(s);
  bus.emit('video:state', { id: s.id, state, why });
}

// ---- the connection ----
function closeConn(s, { tell = true } = {}) {
  clearTimeout(s.timer); s.timer = null;
  if (tell && s.session && net.ws?.readyState === 1) { try { net.ws.send(JSON.stringify({ type: 'video-close', session: s.session })); } catch { /* gone */ } }
  s.session = null; s.req = null;
  try { s.pc?.close(); } catch { /* closed */ } s.pc = null;
  if (s.audio) { try { s.audio.src.disconnect(); s.audio.gain.disconnect(); s.audio.panner.disconnect(); } catch { /* fine */ } s.audio = null; }
  if (s.el) { try { s.el.srcObject = null; s.el.remove(); } catch { /* fine */ } s.el = null; }
  s.tex?.dispose?.(); s.tex = null; s.lastFrame = 0; s.frames = 0;
}
async function connect(s, rev) {
  if (typeof RTCPeerConnection !== 'function') { setState(s, 'blocked', 'this browser has no WebRTC'); return; }
  closeConn(s, { tell: true }); setState(s, 'connecting');
  const pc = new RTCPeerConnection({}); s.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
  // rendered, 1×1 and invisible, never display:none: a video the page doesn't render may be decoded and presented at a
  // throttled rate, and the texture reads whatever it last presented
  const el = document.createElement('video'); el.muted = true; el.playsInline = true; el.autoplay = true;
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(el); s.el = el;
  const stream = new MediaStream();
  pc.ontrack = (ev) => {
    if (!current(s.id, rev) || s.pc !== pc) return;
    stream.addTrack(ev.track); el.srcObject = stream;
    if (s.state === 'connecting') setState(s, 'buffering');
    if (ev.track.kind === 'audio' && !s.audio) {
      // Chrome only feeds a remote WebRTC stream to Web Audio while a media element holds it: the muted <video> does
      const ctx = audioContext(); const src = ctx.createMediaStreamSource(stream); const gain = ctx.createGain(); gain.gain.value = 0;
      const panner = ctx.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'linear'; panner.rolloffFactor = 0;
      src.connect(gain); if (s.video.spatial !== false) { gain.connect(panner); panner.connect(worldBusNode()); } else gain.connect(worldBusNode());
      s.audio = { src, gain, panner };
    }
    if (ev.track.kind === 'video') { el.play().catch(() => {}); watchFrames(s, el, rev); }
  };
  pc.onconnectionstatechange = () => {
    if (!current(s.id, rev) || s.pc !== pc) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') retry(s, rev, `the connection ${pc.connectionState === 'failed' ? 'failed' : 'dropped'}`);
  };
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await new Promise((res) => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, ICE_GATHER_MS); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });
  if (!current(s.id, rev) || s.pc !== pc) { try { pc.close(); } catch { /* fine */ } return; }
  s.req = `v${++reqN}`;
  if (net.ws?.readyState !== 1) { retry(s, rev, 'not connected to the world'); return; }
  net.ws.send(JSON.stringify({ type: 'video-offer', id: s.id, sdp: pc.localDescription.sdp, req: s.req }));
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (current(s.id, rev) && s.pc === pc && !s.frames) retry(s, rev, 'no picture arrived'); }, CONNECT_WATCHDOG_MS);
}
function retry(s, rev, why) {
  if (!current(s.id, rev)) return;
  (s.retries ??= []).push({ at: Math.round(performance.now()), why });   // probes: why each reconnect happened
  closeConn(s, { tell: true }); setState(s, 'error', why);
  const wait = BACKOFF[Math.min(s.attempt, BACKOFF.length - 1)]; s.attempt++;
  s.timer = setTimeout(() => { if (current(s.id, rev)) void connect(s, rev); }, wait);
}
function watchFrames(s, el, rev) {
  // a NEW frame is the evidence of playing: requestVideoFrameCallback's mediaTime moving on (or currentTime, where that
  // callback doesn't exist). A callback that re-presents the same frame is a held frame, and the stall check sees it as one
  let lastMedia = -1;
  const seen = (mediaTime) => { if (!current(s.id, rev) || s.el !== el) return false;
    if (!(mediaTime > lastMedia)) return true;
    lastMedia = mediaTime; s.lastFrame = performance.now(); s.attempt = 0; s.frames = (s.frames ?? 0) + 1;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (el.videoWidth && el.videoHeight) { const a = el.videoHeight / el.videoWidth; if (Math.abs(a - s.aspect) > 1e-3) { s.aspect = a; if (s.quad) { s.quad.parent?.remove(s.quad); s.quad.userData.dispose(); s.quad = null; } } }
    if (!s.tex) { s.tex = new THREE.VideoTexture(el); s.tex.colorSpace = THREE.SRGBColorSpace; }
    if (s.state !== 'playing') setState(s, 'playing'); else show(s); return true; };
  if (typeof el.requestVideoFrameCallback === 'function') { const f = (_now, meta) => { if (seen(meta?.mediaTime ?? el.currentTime)) el.requestVideoFrameCallback(f); }; el.requestVideoFrameCallback(f); }
  else { const poll = () => { if (!current(s.id, rev) || s.el !== el) return; seen(el.currentTime); setTimeout(poll, 100); }; poll(); }
}

bus.on('video-answer', async (m) => {
  for (const s of screens.values()) if (s.req && m.req === s.req && m.id === s.id && s.pc) {
    const rev = revision.get(s.id); s.session = m.session;
    try { await s.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch (e) { retry(s, rev, 'the answer was not usable'); }
  }
});
bus.on('video-error', (m) => {
  for (const s of screens.values()) if (s.req && m.req === s.req) {
    const rev = revision.get(s.id);
    if (NO_RETRY.test(m.why ?? '')) { closeConn(s, { tell: false }); setState(s, 'error', m.why); } else retry(s, rev, m.why);
  }
});
bus.on('video-closed', (m) => {
  for (const s of screens.values()) if (s.session && m.session === s.session) {
    const rev = revision.get(s.id); s.session = null;
    if (NO_RETRY.test(m.why ?? '')) { closeConn(s, { tell: false }); setState(s, 'error', m.why); } else retry(s, rev, m.why);
  }
});
// what the appliance observed of each source: kept for look's line in this browser (the inspector), as an age
bus.on('video-state', (m) => { const now = Date.now(); for (const x of m.states ?? []) if (SOURCE_STATES.includes(x?.state) && Number.isFinite(x?.ageMs)) noteSourceState(x.source, { state: x.state, at: now - x.ageMs }); });

// ---- the bag ----
function takeDown(id) {
  const s = screens.get(id); if (!s) return;
  screens.delete(id); closeConn(s, { tell: true });
  if (s.quad) { s.quad.parent?.remove(s.quad); s.quad.userData.dispose(); }
  s.plate?.dispose?.();
}
function applyFrom(id, data, { fresh = false, why = 'comp' } = {}) {
  const n = data == null ? null : normalizeVideo(data);
  const prev = screens.get(id);
  // a volume, distance or alt change: the same stream on the same quad, adjusted in the tick (no new intent, no bump)
  if (!fresh && prev && n?.ok && prev.video.source === n.video.source && prev.video.width === n.video.width && prev.video.lit === n.video.lit && prev.video.spatial === n.video.spatial) { prev.video = n.video; return; }
  const rev = bump(id);
  _builds.push({ id, why: n == null ? `${why}: down` : why, at: Math.round(performance.now()) });
  takeDown(id);
  if (n == null) return;
  const s = { id, video: n.ok ? n.video : { width: 4, lit: 'self' }, state: 'connecting', why: null, aspect: 9 / 16, attempt: 0 };
  screens.set(id, s);
  if (!n.ok) { setState(s, 'error', n.why); return; }
  const live = [...screens.values()].filter((x) => x !== s && x.state !== 'blocked' && x.state !== 'error').length;
  if (live >= MAX_SCREENS) { setState(s, 'blocked', `at most ${MAX_SCREENS} screens at once`); return; }
  show(s);
  if (entities.get(id)) void connect(s, rev);
}
export function clearVideos() { for (const id of [...screens.keys()]) { bump(id); takeDown(id); } }

/** Per-frame: the stall check, the distance gain (sound's law), the panners follow their screens. */
const _pos = new THREE.Vector3(), _me = new THREE.Vector3();
export function tickVideos() {
  if (!screens.size) return;
  camera.getWorldPosition(_me); const now = performance.now();
  for (const s of screens.values()) {
    if (s.state === 'playing' && now - s.lastFrame > STALL_MS) setState(s, 'stalled');
    const root = entities.get(s.id);
    if (!s.quad && root) show(s);
    if (!s.audio) continue;
    if (!root || isMineMuted(s.id)) { s.audio.gain.gain.value = 0; continue; }
    root.getWorldPosition(_pos);
    s.audio.gain.gain.value = s.state === 'playing' || s.state === 'stalled' ? videoGain(s.video, _pos.distanceTo(_me)) : 0;
    const p = s.audio.panner; if (p.positionX) { p.positionX.value = _pos.x; p.positionY.value = _pos.y; p.positionZ.value = _pos.z; } else p.setPosition(_pos.x, _pos.y, _pos.z);
  }
}

bus.on('comp', ({ id, type, data }) => { if (type === 'video') applyFrom(id, data); });
// the thing left the scene (remove, demote) or came back re-realized (spawn, a promote): whatever played on the old subtree
// is closed under a bump, and a spawn plays the bag again from the start, as picture's host re-hangs (Mica, #186 round 2)
bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove' || kind === 'demote') { if (screens.has(id)) { bump(id); takeDown(id); } }
  else if (kind === 'spawn') { const c = bagOf(id); if (c?.video) applyFrom(id, c.video, { fresh: true, why: 'spawn' }); }
});
bus.on('world-reset', () => clearVideos());

// the inspector: this viewer's own playback state (never logged, never anyone else's), and mute-for-me
registerLive((id) => { const s = screens.get(id); return s ? { videoState: s.why ? `${s.state}: ${s.why}` : s.state } : {}; });
registerHandler('video', (id, _obj, k, _v, opts) => { if (k !== 'mute' || opts?.live) return false; const m = toggleMineMuted(id); flashHint(m ? '🔇 muted for you (nobody else)' : '🔊 you hear it again', 2500); return true; });
