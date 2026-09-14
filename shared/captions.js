// captions — what a `captions` component MEANS. Shared verbatim between the
// caption bot that writes it (tools/captionbot), the mcpl agent that reads it
// (text-tier perception), and any client overlay, so no two of them can
// describe a different screen.
//
//   comp {id, type: "captions", data: {title?, speaker?, mediaTime, window: [
//     {t0, t1, text, speaker?}, …   // oldest first, bounded
//   ]}}
//   comp {id, type: "captions", data: null}          # the screen goes quiet
//
// Rung 2 of the projector ladder (anima_dev/eidoverse_projector_design.md):
// the music player — audio in, captions the models can read, no video yet.
// The design note names a `caption` VERB; the verb set is closed by design
// (AGENTS.md: a new verb is a protocol amendment), so this rung uses the
// door that exists — state-shaped extension by comp — and carries a bounded
// ROLLING WINDOW on the entity that owns the screen. The window is the log's
// record of what the screen said recently; the full transcript is the bot's
// to keep, not the world's. Captions never wake anyone: a comp edit is not
// addressed speech. A resident who wants them subscribes to the entity and
// lets their own gate rule decide — the tune-in model.
//
// TIMES. t0/t1 are MEDIA TIME in seconds: the stream's own clock, as far as
// the bot can know it. In this rung that is seconds since the bot attached
// to the stream (the source clock plumbing is phase 3); the field's meaning
// does not change when the source improves, only its accuracy.

export const CAPTIONS_MAX_LINES = 20;
export const CAPTION_TEXT_MAX = 240;
export const CAPTIONS_TITLE_MAX = 120;
export const CAPTIONS_SPEAKER_MAX = 48;
const KNOWN_KEYS = new Set(['title', 'speaker', 'mediaTime', 'window']);

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** One caption, validated: finite non-negative times in order, non-empty text. */
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

/** Validate an authored bag. `ok:false` carries WHY; `ok:true` carries the
 *  normalized captions plus notes for anything coerced or dropped. */
export function normalizeCaptions(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'captions data must be an object {window: [...], title?, speaker?, mediaTime?}' };
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
  // Oldest first, and the window is a window: the newest MAX lines survive.
  window.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  if (window.length > CAPTIONS_MAX_LINES) {
    notes.push(`window clipped to the newest ${CAPTIONS_MAX_LINES} of ${window.length}`);
    window = window.slice(-CAPTIONS_MAX_LINES);
  }
  const captions = { window };
  const title = cleanText(data.title, CAPTIONS_TITLE_MAX);
  if (title) captions.title = title;
  const speaker = cleanText(data.speaker, CAPTIONS_SPEAKER_MAX);
  if (speaker) captions.speaker = speaker;
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
  const who = last.speaker ?? captions.speaker;
  const line = who ? `${who}: ${last.text}` : last.text;
  return `a screen, ${showing}, ${clock(captions.mediaTime ?? last.t1)}, last line: ${line}`;
}

/** The `captions` detail level: the rolling window, oldest first, one line
 *  each, at most `lines` of them (default: all of the window). */
export function captionsDetail(data, lines = CAPTIONS_MAX_LINES) {
  const n = normalizeCaptions(data);
  if (!n.ok) return [];
  const w = n.captions.window.slice(-Math.max(0, lines));
  return w.map((c) => `[${clock(c.t0)}–${clock(c.t1)}] ${c.speaker ?? n.captions.speaker ? `${c.speaker ?? n.captions.speaker}: ` : ''}${c.text}`);
}
