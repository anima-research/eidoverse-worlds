// video — what a `video` component MEANS. Shared verbatim between the browser
// host (client/lib/videos.js), the authority (its door check and the look
// line) and the mcpl agent (text-tier perception), so no two of them can
// describe a different screen.
//
//   video {source, volume?, near?, radius?, spatial?, width?, lit?, alt?}
//   (a quad of its own, facing +Z on the thing's origin, as picture's; its
//   sound comes from the thing, as sound's)
//
// Rung 3 of the projector ladder (anima_dev/eidoverse_projector_design.md,
// revision 2, approved by Mica 2026-10-20 into the trial ladder). A "screen"
// is not a component: it is a thing carrying `video`, and `captions` with its
// `captioners` when someone is captioning it.
//
// THE SOURCE IS AN ID, NEVER A URL. `source` names a stream the OPERATOR
// admitted on this server ("solstice", "movie-night"). The endpoint behind it
// (a WHEP URL on the projector appliance, and any credential) lives in the
// operator's source registry, outside the world log, and is handed only to an
// admitted viewer for one playback session. The log is replayed, forked and
// read by every resident: a live endpoint in it is topology, and possibly a
// credential, in the one place everything is copied. This is deliberately
// stricter than picture and sound, which take https links under
// shared/mediasrc.js's tiers: a file is content, a live endpoint is plumbing.
//
// ADMISSION IS THE AUTHORITY'S. A video naming a source this server hasn't
// admitted is refused at the door, like any other invalid value. The browser
// also plays nothing it wasn't handed an endpoint for, but that is defence in
// depth, not the rule. admitVideoSources() is how the server tells the
// authority which ids exist; until it does, NO source is admitted (a server
// that forgot to say has admitted nothing, rather than everything).
//
// LIVE ONLY, SO NO PLAYHEAD. Every viewer plays the source's live edge, and
// there is no shared play state to stamp: `playing` and `t0` are absent from
// the shape on purpose (Mica, 10-20). A recorded source will add them, and
// their absence will go on meaning exactly this.
//
// TWO STATES, NEVER ONE (revision 2, item 4). A text-tier resident isn't
// playing the stream, so `look` can't honestly report a viewer's buffering.
//   - the SOURCE state is what the appliance observed: offline | live |
//     ended | unknown, with how fresh that observation is. It is ephemeral,
//     server-side, never logged, and it is what look says.
//   - the PLAYBACK state is each viewer's own: connecting | buffering |
//     playing | stalled | error | blocked, from local evidence only. It is
//     what that viewer's screen says, and nobody else's.
// Neither is inferred from the other. A frozen frame is never "playing".
//
// AUTHORED VERSUS LOCAL. The bag holds what is authored and shared: the
// source, the authored volume, the quad, the alt text. A viewer's own volume,
// mute and caption overlay are theirs and are never written: what they hear
// is the authored volume times their own media gain.
//
// ALT is fallback and perception text: what the author says the screen is
// for ("the solstice stage"). It is never a claim about the current frame.

import { gainAt, SOUND_MAX_RADIUS } from './sound.js';
import { graphemes, graphemeList, quoted } from './text.js';

export { gainAt };

/** A source id: a lowercase name the operator chose, 1–40 characters, letters, digits and hyphens, starting with a
 *  letter. Never a URL: no scheme, no dots, no slashes, so nothing that looks like an address fits. */
export const VIDEO_SOURCE_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const VIDEO_ALT_MAX = 200;
export const VIDEO_MAX_WIDTH = 20;
export const VIDEO_MAX_RADIUS = SOUND_MAX_RADIUS;
export const VIDEO_DEFAULTS = Object.freeze({ volume: 0.8, near: 1.5, radius: 12, spatial: true, width: 4, lit: 'self' });
export const VIDEO_LIT = Object.freeze({ self: 'self-lit (a screen)', scene: 'lit by the scene' });
const KNOWN_KEYS = new Set(['source', 'volume', 'near', 'radius', 'spatial', 'width', 'lit', 'alt']);

/** What the appliance can say about a source (the SOURCE state). */
export const SOURCE_STATES = Object.freeze(['offline', 'live', 'ended', 'unknown']);
/** What a viewer's own player can say (the PLAYBACK state), from local evidence only. */
export const PLAYBACK_STATES = Object.freeze(['connecting', 'buffering', 'playing', 'stalled', 'error', 'blocked']);
/** An observation older than this is no longer an observation: look says "unknown" and how stale it was. */
export const SOURCE_STATE_FRESH_MS = 30_000;

// ---- which ids the authority admits (the server installs them; nothing is admitted until it does) ----
let ADMITTED = new Set();
/** The server tells the authority which source ids its operator admitted. Ids that don't fit VIDEO_SOURCE_ID are
 *  dropped (and returned), so a malformed registry entry can't be named by a world. Returns {admitted, dropped}. */
export function admitVideoSources(ids) {
  const list = [...(ids ?? [])];
  const ok = list.filter((x) => typeof x === 'string' && VIDEO_SOURCE_ID.test(x));
  ADMITTED = new Set(ok);
  return { admitted: [...ADMITTED], dropped: list.filter((x) => !ok.includes(x)) };
}
export const isAdmittedSource = (id) => typeof id === 'string' && ADMITTED.has(id);
export const admittedSources = () => [...ADMITTED];

// ---- what the appliance last observed of each source (ephemeral: never logged, never a world's state) ----
// The process that holds the observations fills this: the server from its appliance poller (server/videosources.ts),
// mcpl from the server's video-state broadcasts. A broadcast carries the observation's AGE, never a timestamp, so a
// reader on another machine with another clock can't make a stale state look fresh: it records `at` on its own clock.
const OBSERVED = new Map();
/** Record what the appliance observed of `id`: {state, at} (at: epoch ms on THIS process's clock). */
export function noteSourceState(id, obs) { if (typeof id === 'string' && obs && SOURCE_STATES.includes(obs.state) && Number.isFinite(obs.at)) OBSERVED.set(id, { state: obs.state, at: obs.at }); }
/** Forget a source (revoked by the operator): look reads it as unknown, never observed. */
export function forgetSourceState(id) { OBSERVED.delete(id); }
export const sourceStateOf = (id) => OBSERVED.get(id) ?? null;

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, n));
};

/** Is `id` shaped like a source id? (Shape only: whether this server admitted it is isAdmittedSource's question.) */
export function sourceIdProblem(id) {
  if (typeof id !== 'string' || !id) return 'source names a stream the operator admitted: a short lowercase id, like "solstice"';
  if (/^[a-z][a-z0-9+.-]*:/i.test(id) || id.includes('/') || id.includes('.')) return 'source is an id the operator admitted, never a URL or a path: the endpoint stays out of the world log';
  if (!VIDEO_SOURCE_ID.test(id)) return 'source is 1–40 lowercase letters, digits and hyphens, starting with a letter';
  return null;
}

/** Validate an authored bag. `ok:false` carries WHY; `ok:true` carries the normalized video plus notes. */
export function normalizeVideo(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'video data must be an object {source, volume?, near?, radius?, spatial?, width?, lit?, alt?}' };
  }
  const bad = sourceIdProblem(data.source);
  if (bad) return { ok: false, why: bad };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const radius = num(data.radius, 1, VIDEO_MAX_RADIUS, VIDEO_DEFAULTS.radius);
  const video = {
    source: data.source,
    volume: num(data.volume, 0, 1, VIDEO_DEFAULTS.volume),
    near: Math.min(radius, num(data.near, 0.01, VIDEO_MAX_RADIUS, VIDEO_DEFAULTS.near)),
    radius,
    spatial: data.spatial !== false,
    width: VIDEO_DEFAULTS.width,
    lit: VIDEO_DEFAULTS.lit,
  };
  if (data.width !== undefined) { const w = Number(data.width); if (Number.isFinite(w) && w > 0) video.width = Math.min(VIDEO_MAX_WIDTH, w); else notes.push(`width is a number of metres above 0 — using ${VIDEO_DEFAULTS.width}`); }
  if (data.lit != null) {
    if (Object.hasOwn(VIDEO_LIT, data.lit)) video.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(VIDEO_LIT).join('/')}) — using ${VIDEO_DEFAULTS.lit}`);
  }
  if (data.alt != null) {
    const alt = String(data.alt).replace(/\s+/g, ' ').trim();
    if (graphemes(alt) > VIDEO_ALT_MAX) { notes.push(`alt clipped to ${VIDEO_ALT_MAX} characters`); video.alt = graphemeList(alt).slice(0, VIDEO_ALT_MAX).join(''); }
    else if (alt) video.alt = alt;
  }
  if (!video.alt) notes.push('no alt text — anyone who can\'t see it (or reads the world as text) gets only the source\'s id; say what the screen is for');
  return { ok: true, video, notes };
}

/** A viewer's gain for a video at d metres: the authored volume, times the distance law (sound's, unchanged), times the
 *  listener's own media gain (local, never written; 1 when they haven't touched it). */
export function videoGain(video, d, listenerGain = 1) {
  const v = video ?? {};
  const radius = num(v.radius, 1, VIDEO_MAX_RADIUS, VIDEO_DEFAULTS.radius);
  const near = Math.min(radius, num(v.near, 0.01, VIDEO_MAX_RADIUS, VIDEO_DEFAULTS.near));
  const lg = Number.isFinite(listenerGain) ? Math.min(1, Math.max(0, listenerGain)) : 1;
  return num(v.volume, 0, 1, VIDEO_DEFAULTS.volume) * (v.spatial === false ? (d >= 0 && d < radius ? 1 : 0) : gainAt(d, near, radius)) * lg;
}

/** Read an appliance observation honestly: {state, at} with `at` in epoch ms. A missing, malformed or stale one reads
 *  as unknown, and says how stale. Returns {state, ageS} (ageS null when there was no observation at all). */
export function sourceStateNow(obs, now) {
  if (!obs || typeof obs !== 'object' || !SOURCE_STATES.includes(obs.state) || !Number.isFinite(obs.at) || !Number.isFinite(now)) return { state: 'unknown', ageS: null };
  const age = Math.max(0, now - obs.at);
  const ageS = Math.round(age / 1000);
  if (age > SOURCE_STATE_FRESH_MS) return { state: 'unknown', ageS };
  return { state: obs.state, ageS };
}

const STATE_WORDS = { offline: 'its source is offline', live: 'its source is live', ended: 'its source has ended', unknown: 'its source\'s state is unknown' };

/** The one line look() carries for a video — the same string on the authority, in mcpl and in every client, from the same
 *  bag and the same appliance observation. Says what the author said the screen is for (quoted, as data), and what the
 *  APPLIANCE last observed of its source, with how fresh that is. Never claims anything about frames or about any
 *  viewer's playback. `obs` is {state, at}; `now` is epoch ms. */
export function describeVideo(data, obs = sourceStateOf(data?.source), now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a video (malformed declaration)';
  const bad = sourceIdProblem(data.source);
  const alt = typeof data.alt === 'string' && data.alt.trim() ? data.alt : null;
  const head = alt ? `a video screen: ${quoted(alt, VIDEO_ALT_MAX)}` : `a video screen (source ${bad ? 'invalid' : `"${data.source}"`})`;
  if (bad) return `${head} (not shown: invalid declaration)`;
  const { state, ageS } = sourceStateNow(obs, now);
  const fresh = ageS == null ? 'never observed' : state === 'unknown' ? `last observed ${ageS} s ago` : `as of ${ageS} s ago`;
  return `${head}; ${STATE_WORDS[state]} (${fresh})`;
}
