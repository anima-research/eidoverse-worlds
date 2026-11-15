// captions — what the `caption` verb MEANS, and the bag it folds into. Shared
// verbatim between the sequencer (validator + fold), the caption bot that
// writes it (services/captionbot), the mcpl agent that reads it (text-tier
// perception), and any client overlay, so no two of them can describe a
// different screen.
//
//   caption {id, session, n, t0, t1, text, speaker?, title?}   # one line, once
//   caption {id, session, end: true}                            # the screen goes quiet
//
// folds into the entity's comp bag, SERVER-WRITTEN (a client's `comp {type:
// "captions"}` is refused, so the bag has one writer path):
//
//   captions = {session, n, gen, title?, line: {t0, t1, text, speaker?}}
//
// Each write holds ITS line, once (as WebVTT and TTML store a cue once). A reader that wants earlier lines reads the
// earlier captions changes (the log is the transcript); an older stored value's `window` still reads.
//
// Writing one screen's captions takes the `caption` deed (a per-entity grant), not builder standing over the world.
// Captions are durable world testimony like `say`; `end` clears current perception, not history.
//
// WHO IS THE CAPTIONER: the LIVE LEG. The sequencer stamps every caption entry with the writer's join generation
// (server/world.ts legGen: monotonic across restarts; a same-identity join is a takeover); a client cannot supply it.
// The bag remembers the generation that wrote it: a lower one is refused as a superseded leg, a higher one takes over.
// Supersession is thus the authority's fact, never a clock the bot claims. The owner's recovery is `end` or `caption: null`.
//
// SESSION is the bot's media-clock label, minted at attach (ISO time plus a nonce): it says which attach a `00:30`
// belongs to. Within a session `n` is the bot's monotonic counter; the bag folds the high-water mark and refuses a
// caption at or below it BEFORE it becomes history, so a resend after a lost receipt is safe while the bag stands (an `end`
// clears it, and a resend after that is accepted again). A different session from the live leg's starts a fresh window.
//
// TIMES: t0/t1 are MEDIA TIME in seconds (today: since the bot attached to the stream).
//
// BOUNDS are in CHARACTERS (String.length), not bytes: the bag is folded state, not a verb payload, and the authority's
// 64 KiB value cap (shared/protocol/authority/gate.js) holds 20 full lines in any script.

import { shown } from './shown.js';

export const CAPTIONS_MAX_LINES = 20;
export const CAPTION_TEXT_MAX = 240;
export const CAPTIONS_TITLE_MAX = 120;
export const CAPTIONS_SPEAKER_MAX = 48;
export const CAPTION_SESSION_MAX = 64;
/** Sessions are `<ISO attach time>-<nonce>`: ordered by when the bot attached. */
export const SESSION_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z-[A-Za-z0-9]{2,16}$/;
const KNOWN_KEYS = new Set(['session', 'n', 'gen', 'title', 'line', 'mediaTime', 'window']);   // mediaTime and window: an older value's

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A line's parts and what keeps them from being a line: the one statement
 *  of the rule, for normalizeCaption and for the refusal that names what
 *  failed. */
function readLine(c) {
  const t0 = Number(c.t0), t1 = Number(c.t1), text = cleanText(c.text, CAPTION_TEXT_MAX);
  return { t0, t1, text, badTimes: !Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 < t0, badText: !text };
}

/** Mint a session id: attach time first so sessions sort by attach. */
export function mintSession(now = new Date(), nonce = Math.random().toString(36).slice(2, 8)) {
  return `${now.toISOString()}-${nonce}`;
}

/** One caption LINE, validated: finite non-negative times in order, non-empty text. */
export function normalizeCaption(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const { t0, t1, text, badTimes, badText } = readLine(c);
  if (badTimes || badText) return null;
  const out = { t0: Math.round(t0 * 100) / 100, t1: Math.round(t1 * 100) / 100, text };
  const speaker = cleanText(c.speaker, CAPTIONS_SPEAKER_MAX);
  if (speaker) out.speaker = speaker;
  return out;
}

/** The `caption` verb's args, shape-checked: `ok:false` carries WHY (the
 *  refusal the authority sends), `ok:true` the normalized args that become
 *  history. Pure — the sequencer's validator and the bot's own pre-check
 *  are the same function. */
export function normalizeCaptionArgs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, why: 'caption wants {id, session, n, t0, t1, text, speaker?, title?} or {id, session, end: true}' };
  const id = String(a.id ?? '').slice(0, 64);
  const session = String(a.session ?? '');
  if (!id) return { ok: false, why: 'caption wants an entity id' };
  if (!session || session.length > CAPTION_SESSION_MAX || !SESSION_RX.test(session)) {
    return { ok: false, why: `caption wants a session like "2026-09-16T20:00:00.000Z-k3f9": the UTC time the captioner attached, a hyphen, then 2–16 letters or digits (got ${shown(a.session)}); mint it once when the captioner attaches and send it with every line` };
  }
  if (a.end === true) return { ok: true, args: { id, session, end: true } };
  const n = Number(a.n);
  if (!Number.isInteger(n) || n < 1) return { ok: false, why: `caption wants an integer n of 1 or more (got ${shown(a.n)}): number a session's lines in order, each higher than the last` };
  const line = normalizeCaption(a);
  if (!line) {
    const { badTimes, badText } = readLine(a);
    const wants = [
      ...(badTimes ? [`t0 and t1, the line's start and end in seconds of media time, with 0 ≤ t0 ≤ t1 (got t0 ${shown(a.t0)}, t1 ${shown(a.t1)})`] : []),
      ...(badText ? [`text, the line's words (got ${shown(a.text)})`] : []),
    ];
    return { ok: false, why: `caption wants ${wants.join(', and ')}` };
  }
  const args = { id, session, n, ...line };
  const title = cleanText(a.title, CAPTIONS_TITLE_MAX);
  if (title) args.title = title;
  return { ok: true, args };
}

/** Why the folded bag refuses these (already normalized, server-stamped)
 *  args, or null. Lives HERE, before append, so a refusal never becomes
 *  history: a superseded leg (a lower generation than the one that wrote
 *  the bag), a duplicate or old `n` in the bag's session, or an `end` for a
 *  session that is not the current one. `gen` is the sequencer's stamp
 *  (vCaption); entries that predate it read as generation 0. */
export function captionRefusal(bag, args) {
  const cur = bag && typeof bag === 'object' ? bag : null;
  if (!cur) return args.end ? `"${args.id}" has no captions to end, so it's already quiet` : null;
  const g = Number(args.gen) || 0, cg = Number(cur.gen) || 0;
  if (g < cg) return `"${args.id}" is captioned by a newer leg (generation ${cg}; yours is ${g}) — a superseded captioner: a connection that joined after yours has captioned this screen since, and the newest one to caption it holds it; rejoin, and your next line takes it back`;
  if (args.end) {
    if (cur.session !== args.session) return `"${args.id}" is captioned under session ${cur.session}, not ${args.session}; to end what it shows, end session ${cur.session}`;
    return null;
  }
  if (args.session === cur.session && args.n <= (Number(cur.n) || 0)) {
    return `caption n=${args.n} is not after the folded high-water n=${cur.n} for session ${cur.session} — duplicate or out of order; this session's next line needs n=${(Number(cur.n) || 0) + 1} or higher`;
  }
  return null;   // the same session continues; a different one starts fresh
}

/** Fold normalized args into the bag (pure; returns the new bag, or null when
 *  the screen went quiet): the current line only. The title carries within a
 *  session; a new session starts fresh. */
export function foldCaption(bag, args) {
  if (args.end) return null;
  const cur = bag && typeof bag === 'object' && bag.session === args.session ? bag : null;
  const line = { t0: args.t0, t1: args.t1, text: args.text, ...(args.speaker ? { speaker: args.speaker } : {}) };
  const title = args.title ?? cur?.title;
  return { session: args.session, n: args.n, gen: Number(args.gen) || 0, ...(title ? { title } : {}), line };
}

/** Validate a folded bag as a reader (look(), an overlay). `ok:false` carries
 *  WHY; `ok:true` the normalized captions plus notes for anything coerced. */
export function normalizeCaptions(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'captions must be an object {session, n, gen, title?, line: {t0, t1, text, speaker?}}' };
  }
  // today's value holds its current line; an older one its window of lines
  const lines0 = data.line !== undefined ? [data.line] : data.window;
  if (!Array.isArray(lines0)) return { ok: false, why: 'line must be {t0, t1, text, speaker?} (an older value: window, an array of them)' };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  let dropped = 0;
  let window = [];
  for (const c of lines0) {
    const n = normalizeCaption(c);
    if (n) window.push(n); else dropped++;
  }
  if (dropped) notes.push(`${dropped} malformed caption${dropped === 1 ? '' : 's'} dropped`);
  if (window.length > CAPTIONS_MAX_LINES) {
    notes.push(`window clipped to the newest ${CAPTIONS_MAX_LINES} of ${window.length}`);
    window = window.slice(-CAPTIONS_MAX_LINES);
  }
  const captions = { window };
  const session = String(data.session ?? '');
  if (session) captions.session = session.slice(0, CAPTION_SESSION_MAX);
  const n = Number(data.n);
  if (Number.isInteger(n) && n >= 0) captions.n = n;
  const gen = Number(data.gen);
  if (Number.isInteger(gen) && gen >= 0) captions.gen = gen;
  const title = cleanText(data.title, CAPTIONS_TITLE_MAX);
  if (title) captions.title = title;
  const mt = Number(data.mediaTime);
  if (Number.isFinite(mt) && mt >= 0) captions.mediaTime = Math.round(mt * 100) / 100;
  else if (window.length) captions.mediaTime = window[window.length - 1].t1;
  return { ok: true, captions, notes };
}

/** mm:ss or h:mm:ss for a media time in seconds. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The one line look() carries: what is showing, where in it, and the last
 *  thing it said. Never a claim about pixels or sound — only what the
 *  captioner wrote down. */
export function describeCaptions(data) {
  const n = normalizeCaptions(data);
  if (!n.ok) return 'a screen (malformed captions declaration)';
  const { captions } = n;
  const showing = captions.title ? `showing ${captions.title}` : 'showing something uncaptioned by title';
  const last = captions.window[captions.window.length - 1];
  if (!last) return `a screen, ${showing}, nothing captioned yet`;
  const line = last.speaker ? `${last.speaker}: ${last.text}` : last.text;
  return `a screen, ${showing}, ${clock(captions.mediaTime ?? last.t1)}, last line: ${line}`;
}

/** The `captions` detail level: the lines, oldest first, one each, at most
 *  `lines` of them. A value holds its current line (an older one its window);
 *  `earlier` is the screen's earlier captions values, oldest first (the log's
 *  captions changes), for a reader that wants the lines before it. */
export function captionsDetail(data, lines = CAPTIONS_MAX_LINES, earlier = []) {
  const n = normalizeCaptions(data);
  if (!n.ok) return [];
  const before = (Array.isArray(earlier) ? earlier : []).flatMap((b) => { const m = normalizeCaptions(b); return m.ok && m.captions.session === n.captions.session ? m.captions.window : []; });
  const k = Math.max(0, lines), all = [...before, ...n.captions.window], w = k ? all.slice(-k) : [];   // slice(-0) is slice(0): zero lines is none (#258)
  return w.map((c) => `[${clock(c.t0)}–${clock(c.t1)}] ${c.speaker ? `${c.speaker}: ` : ''}${c.text}`);
}
