// captions — what the `caption` verb MEANS, and the bag it folds into. Shared
// verbatim between the sequencer (validator + fold), the caption bot that
// writes it (tools/captionbot), the mcpl agent that reads it (text-tier
// perception), and any client overlay, so no two of them can describe a
// different screen.
//
//   caption {id, session, n, t0, t1, text, speaker?, title?}   # one line, once
//   caption {id, session, end: true}                            # the screen goes quiet
//
// folds into the entity's comp bag, SERVER-WRITTEN (a client's `comp {type:
// "captions"}` is refused, so the bag has one writer path):
//
//   comp.captions = {session, n, title?, mediaTime, window: [
//     {t0, t1, text, speaker?}, …      // oldest first, the newest MAX_LINES
//   ]}
//
// Rung 2 of the projector ladder (anima_dev/eidoverse_projector_design.md):
// the music player — audio in, captions the models can read, no video yet.
// This is the design note's `caption` verb, made as a protocol amendment
// (AGENTS.md) after the comp door proved to carry the wrong contract: every
// window write was a log entry, so the append-only log held each line up to
// twenty times, and writing one screen's captions took builder standing
// over the whole world (Mica, #187 review). One line per entry fixes the
// first; the `caption` deed (a per-entity grant) fixes the second.
//
// RETENTION, stated truthfully: captions are durable world testimony like
// `say`; `end` clears current perception, not history. The bot keeps no
// transcript the world does not already hold.
//
// WHO IS THE CAPTIONER: the LIVE LEG. The sequencer issues every accepted
// join a generation (World.legGen: the log seq the world was opened at,
// times a million, plus the admission count — so it survives a sequencer
// restart and never goes backwards; a same-identity join is a TAKEOVER that
// retires the older leg), and vCaption stamps that generation onto every
// caption entry — a client cannot supply it. The bag remembers the
// generation that wrote it; a caption from a lower generation is refused as
// a superseded leg, a higher one takes over. So supersession is the door's
// own fact, never a clock the bot claims: a restart under clock rollback
// still takes over (its leg is newer), a stale predecessor cannot present a
// "later" timestamp and win (its leg is older), and two captioners for one
// screen resolve to whichever joined last — the owner's recovery is `end`
// or `caption: null` (Mica, #187 round 2).
//
// SESSION is the bot's media-clock label, minted at attach (ISO time plus a
// nonce, human-readable): it says which attach a `00:30` belongs to. Within
// one session `n` is the bot's monotonic counter; the bag folds the
// high-water mark, and a caption at or below it is refused BEFORE it
// becomes history — a resend after a lost receipt is safe by construction,
// and a reader never meets the same line twice under one clock. A caption
// under a different session from the live leg starts a fresh window.
//
// TIMES. t0/t1 are MEDIA TIME in seconds: the stream's own clock, as far as
// the bot can know it. In this rung that is seconds since the bot attached
// to the stream (the source clock plumbing is phase 3); the field's meaning
// does not change when the source improves, only its accuracy — and the
// session says which attach a `00:30` belongs to.
//
// BOUNDS are in CHARACTERS (String.length), not bytes: a 240-character line
// of CJK is ~720 UTF-8 bytes and that is fine — the bag is folded state, not
// a verb payload under the 8 KB comp cap.

export const CAPTIONS_MAX_LINES = 20;
export const CAPTION_TEXT_MAX = 240;
export const CAPTIONS_TITLE_MAX = 120;
export const CAPTIONS_SPEAKER_MAX = 48;
export const CAPTION_SESSION_MAX = 64;
/** Sessions are `<ISO attach time>-<nonce>`: ordered by when the bot attached. */
export const SESSION_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z-[A-Za-z0-9]{2,16}$/;
const KNOWN_KEYS = new Set(['session', 'n', 'gen', 'title', 'mediaTime', 'window']);

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Mint a session id: attach time first so sessions sort by attach. */
export function mintSession(now = new Date(), nonce = Math.random().toString(36).slice(2, 8)) {
  return `${now.toISOString()}-${nonce}`;
}

/** One caption LINE, validated: finite non-negative times in order, non-empty text. */
export function normalizeCaption(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const t0 = Number(c.t0), t1 = Number(c.t1);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 < t0) return null;
  const text = cleanText(c.text, CAPTION_TEXT_MAX);
  if (!text) return null;
  const out = { t0: Math.round(t0 * 100) / 100, t1: Math.round(t1 * 100) / 100, text };
  const speaker = cleanText(c.speaker, CAPTIONS_SPEAKER_MAX);
  if (speaker) out.speaker = speaker;
  return out;
}

/** The `caption` verb's args, shape-checked: `ok:false` carries WHY (the
 *  refusal the door sends), `ok:true` the normalized args that become
 *  history. Pure — the sequencer's validator and the bot's own pre-check
 *  are the same function. */
export function normalizeCaptionArgs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, why: 'caption wants {id, session, n, t0, t1, text, speaker?, title?} or {id, session, end: true}' };
  const id = String(a.id ?? '').slice(0, 64);
  const session = String(a.session ?? '');
  if (!id) return { ok: false, why: 'caption wants an entity id' };
  if (!session || session.length > CAPTION_SESSION_MAX || !SESSION_RX.test(session)) {
    return { ok: false, why: 'caption wants a session of the form <ISO attach time>Z-<nonce> (shared/captions.js mintSession)' };
  }
  if (a.end === true) return { ok: true, args: { id, session, end: true } };
  const n = Number(a.n);
  if (!Number.isInteger(n) || n < 1) return { ok: false, why: 'caption wants an integer n ≥ 1, monotonic within the session' };
  const line = normalizeCaption(a);
  if (!line) return { ok: false, why: `caption wants finite t0 ≤ t1 ≥ 0 and non-empty text (≤${CAPTION_TEXT_MAX} chars)` };
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
  if (!cur) return args.end ? `"${args.id}" has no captions to end` : null;
  const g = Number(args.gen) || 0, cg = Number(cur.gen) || 0;
  if (g < cg) return `"${args.id}" is captioned by a newer leg (generation ${cg}; yours is ${g}) — a superseded captioner`;
  if (args.end) {
    if (cur.session !== args.session) return `"${args.id}" is captioned under session ${cur.session}, not ${args.session}`;
    return null;
  }
  if (args.session === cur.session && args.n <= (Number(cur.n) || 0)) {
    return `caption n=${args.n} is not after the folded high-water n=${cur.n} for session ${cur.session} — duplicate or out of order`;
  }
  return null;   // the same session continues; a different one starts fresh
}

/** Fold normalized args into the bag (pure; returns the new bag, or null when
 *  the screen went quiet). A new session starts a fresh window; the same
 *  session appends and keeps the newest MAX_LINES. */
export function foldCaption(bag, args) {
  if (args.end) return null;
  const cur = bag && typeof bag === 'object' && bag.session === args.session ? bag : null;
  const line = { t0: args.t0, t1: args.t1, text: args.text, ...(args.speaker ? { speaker: args.speaker } : {}) };
  const window = [...(Array.isArray(cur?.window) ? cur.window : []), line].slice(-CAPTIONS_MAX_LINES);
  const title = args.title ?? cur?.title;
  return {
    session: args.session, n: args.n, gen: Number(args.gen) || 0,
    ...(title ? { title } : {}),
    mediaTime: Math.max(args.t1, Number(cur?.mediaTime) || 0),
    window,
  };
}

/** Validate a folded bag as a reader (look(), an overlay). `ok:false` carries
 *  WHY; `ok:true` the normalized captions plus notes for anything coerced. */
export function normalizeCaptions(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'captions must be an object {session, n, window: [...], title?, mediaTime?}' };
  }
  if (!Array.isArray(data.window)) return { ok: false, why: 'window must be an array of {t0, t1, text, speaker?}' };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  let dropped = 0;
  let window = [];
  for (const c of data.window) {
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

/** The `captions` detail level: the rolling window, oldest first, one line
 *  each, at most `lines` of them (default: all of the window). */
export function captionsDetail(data, lines = CAPTIONS_MAX_LINES) {
  const n = normalizeCaptions(data);
  if (!n.ok) return [];
  const w = n.captions.window.slice(-Math.max(0, lines));
  return w.map((c) => `[${clock(c.t0)}–${clock(c.t1)}] ${c.speaker ? `${c.speaker}: ` : ''}${c.text}`);
}
