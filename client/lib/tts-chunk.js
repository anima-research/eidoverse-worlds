/**
 * tts-chunk — the spoken form of an utterance, in synthesis-sized pieces.
 *
 * Ported from the porch token-router aggregation (aggregate.py → LiveSay in
 * eido-cc-extras.ts). Constants are MEASURED, not guessed (porch, 2026-07-25):
 * a real turn opened with a 152-char sentence ≈ 5s of unbroken speech, so
 * soft clause-splitting past 90 chars gives the voice somewhere to breathe.
 * This is the BATCH adaptation: a complete utterance in, chunks out — the
 * streaming form (delta lookahead, arm/flush) stays in LiveSay.
 *
 * Sanitization lives here too because this is the boundary where text stops
 * being for eyes: markdown emphasis marks vanish (piper read "*" aloud —
 * voicebox, R at 14:21) and emoji are stripped (piper READS THEM BY NAME —
 * first public listener session, R laughing at her own moon glyph, 03:27Z).
 * The say keeps its glyphs; only the voice drops them.
 */

const ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft',
  'vs', 'etc', 'eg', 'e.g', 'ie', 'i.e', 'cf', 'ca', 'approx',
  'no', 'vol', 'fig', 'dept', 'est', 'min', 'max', 'misc',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const BOUNDARY = /[.!?…]+["'’”)\]»]*\s/g;
const SOFT = /(?:[,;:—–]["'’”)\]»]*\s)|(?:\s(?=(?:and|but|so|or|yet|because|which|while|though|although)\s))/g;
const MIN_LEN = 20;
const SOFT_LEN = 90;
const SOFT_MIN = 35;

/** Markdown is for eyes; emoji are for the log. Neither is for the larynx.
 *
 *  🔴 EXTENDED 2026-08-16 (R, from the phone test: "update the reader-rules so
 *  it doesn't read things like : out loud" — copy eido-cc-extras' rules).
 *  What was missing, in the order it bites:
 *
 *  · FENCED CODE NEVER SPEAKS — extras rule #5, the load-bearing one. The old
 *    form stripped the backticks and then read the CONTENTS of the fence as
 *    prose. Fenced content is work, not words; it goes entirely.
 *  · URLs become "link". espeak spells them out — "h t t p s colon slash
 *    slash mazda dash mic dash…" is most of a minute of noise for one tap.
 *    A markdown [label](url) keeps its label, which was already the speech.
 *  · The symbol runs espeak vocalizes by name: arrows and bullets (→ ▸ ·),
 *    ASCII arrows (->, =>), separator colons in "world:staging" shapes, bare
 *    | and ~ runs. Each maps to a comma or a space — the PAUSE the symbol
 *    meant, not the NAME of the glyph. Times (6:04) and ratios keep their
 *    colon: digit:digit is something espeak already says correctly. */
export function spokenForm(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')                     // fenced code never speaks
    .replace(/\[([^\]]{1,80})\]\((?:[^)]+)\)/g, '$1')           // [label](url) → label
    .replace(/\bhttps?:\/\/\S+/gi, 'link')                     // bare URLs → "link"
    .replace(/[*_`#]+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[→⇒↔▸▶◦‣·•]+/g, ', ')                            // glyphs espeak names aloud
    .replace(/(?:->|=>|::)+/g, ', ')                           // ASCII arrows / double colon
    .replace(/(?<=[a-zA-Z])[:](?=[a-zA-Z])/g, ', ')            // world:staging → pause, 6:04 untouched
    .replace(/\s[|~]+\s/g, ', ')                               // separator pipes/tildes
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:, )+(?=, )/g, '')                             // collapse comma pileups
    .trim();
}

function isRealBoundary(head) {
  const trimmed = head.replace(/\s+$/, '').replace(/[.!?…"')\]»]+$/, '');
  const last = trimmed.trim() ? trimmed.trim().split(/\s+/).pop() : '';
  if (ABBREVS.has(last.toLowerCase().replace(/\.+$/, ''))) return false;
  if (last.length === 1 && /[A-Z]/.test(last)) return false;   // J. R. R. Tolkien
  return true;
}

function splitLong(sentence) {
  if (sentence.length <= SOFT_LEN) return [sentence];
  const chunks = [];
  let rest = sentence;
  while (rest.length > SOFT_LEN) {
    let best = null;
    SOFT.lastIndex = 0;
    let m;
    while ((m = SOFT.exec(rest))) {
      const end = m.index + m[0].length;
      if (end < SOFT_MIN) continue;
      if (rest.length - end < SOFT_MIN) break;
      best = m;
    }
    if (!best) break;
    const end = best.index + best[0].length;
    chunks.push(shapeContinuation(rest.slice(0, end).trim()));
    rest = rest.slice(end);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

const FIRST_MAX = 64;   // the opener: small enough that synth(first) is fast (research: 60-80)
const FIRST_MIN = 20;   // ...but never a comic stub (research: 20-25 floor for piper quality)

/** Split the OPENING chunk aggressively: time-to-first-word is synth(chunk 1),
 *  so the first piece should be a short clause even when the sentence is long.
 *  Relaxed minimum, any soft boundary, and a hard word-boundary cap as the
 *  last resort — better a slightly abrupt first clause than a silent second. */
function fastFirst(chunk) {
  if (chunk.length <= FIRST_MAX) return [chunk];
  let cut = -1;
  SOFT.lastIndex = 0;
  let m;
  while ((m = SOFT.exec(chunk))) {
    const end = m.index + m[0].length;
    if (end < FIRST_MIN) continue;
    if (end > FIRST_MAX) break;
    cut = end;
  }
  if (cut < 0) {
    const sp = chunk.lastIndexOf(' ', FIRST_MAX);
    cut = sp > FIRST_MIN ? sp + 1 : -1;
  }
  if (cut < 0 || chunk.length - cut < FIRST_MIN) return [chunk];
  return [shapeContinuation(chunk.slice(0, cut).trim()), chunk.slice(cut).trim()];
}

/** A mid-sentence chunk should END WITH A COMMA: espeak renders comma as a
 *  continuation RISE where a bare end gets sentence-final FALL — the split
 *  stops sounding like a full stop. (Research pass, 2026-08-10: the one
 *  free prosody mitigation piper actually supports.) */
function shapeContinuation(chunk) {
  return /[,;:—–.!?…]$/.test(chunk) ? chunk : chunk + ',';
}

/** A complete utterance → synthesis-sized spoken chunks (possibly none:
 *  an emoji-only utterance is in the log, not the air). */
export function ttsChunks(text) {
  const spoken = spokenForm(text);
  if (!spoken) return [];
  // hard sentence boundaries with abbreviation/initial guards
  const sentences = [];
  let pos = 0;
  BOUNDARY.lastIndex = 0;
  let m;
  while ((m = BOUNDARY.exec(spoken))) {
    const end = m.index + m[0].length;
    if (!isRealBoundary(spoken.slice(pos, end))) continue;
    sentences.push(spoken.slice(pos, end).trim());
    pos = end;
  }
  if (spoken.slice(pos).trim()) sentences.push(spoken.slice(pos).trim());
  // glue fragments forward, then clause-split anything overlong
  const glued = [];
  for (const s of sentences) {
    if (glued.length && glued[glued.length - 1].length < MIN_LEN) glued[glued.length - 1] += ' ' + s;
    else glued.push(s);
  }
  const chunks = glued.flatMap(splitLong);
  if (!chunks.length) return chunks;
  return [...fastFirst(chunks[0]), ...chunks.slice(1)];
}
