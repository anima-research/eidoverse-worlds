// text — words a builder writes into the world (a sign's text, a story, a picture's description), read by every visitor and every
// agent. Pure: the authority (shared/protocol/authority.js), the editor (shared/editschema.js), the renderer (client/lib/texts.js) and
// the agent describers all use these, so they can't disagree about what a string is, how long it is, or how it wraps.
//
//   graphemes(s)            how long a string is, the way a reader counts it: a ZWJ family emoji is 1, a CJK character
//                           is 1, "é" written as e + U+0301 is 1 (Intl.Segmenter; Bun and every browser have it)
//   cleanText(s, {lines})   null, or why the authority refuses it (bidi overrides spoof, controls hide, zalgo smears)
//   quoted(s, max)          «…» with any « » inside escaped, so author text reads as data and can't close its own quote
//   layoutLines(text, w, m) the sign's line breaks, by words, falling back to graphemes for a word wider than a line
//                           (CJK, a URL): m(str) → width in the same unit as w
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const WORDS = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/** The graphemes of s (a reader's characters). */
export function graphemeList(s) {
  if (typeof s !== 'string') return [];
  return SEG ? Array.from(SEG.segment(s), (x) => x.segment) : Array.from(s);
}
/** How many characters a reader sees in s. */
export const graphemes = (s) => graphemeList(s).length;

// U+202A–U+202E (embeddings, overrides) and U+2066–U+2069 (isolates): they reorder what a reader sees ("txt.exe" shown
// as "exe.txt"). The marks LRM U+200E, RLM U+200F and ALM U+061C only nudge neutral characters, and are kept.
const BIDI = /[‪-‮⁦-⁩]/;
const COMBINING = /\p{M}/gu;
export const MAX_MARKS = 3;   // combining marks on one grapheme: Vietnamese stacks 2, Devanagari 2–3; zalgo stacks dozens
const hex = (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

/** null when s is clean; else {why, fix}. lines: true allows \n (a sign's, a story's), false a single line (a title). */
export function cleanText(s, { lines = true } = {}) {
  if (typeof s !== 'string') return { why: 'is not text', fix: 'a string' };
  const b = BIDI.exec(s);
  if (b) return { why: `has a direction override (${hex(b[0])}), which can make text read differently than it's stored`, fix: 'remove it; the reader\'s browser already sets the direction of Arabic, Hebrew and the rest from the letters themselves' };
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\n' && lines) continue;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return { why: `has a control character (${hex(ch)})${ch === '\n' ? ': this is one line' : ''}`, fix: ch === '\n' ? 'write it on one line' : 'remove it (only a line break is allowed, and only where there can be several lines)' };
  }
  for (const g of graphemeList(s)) { const n = (g.match(COMBINING) ?? []).length;
    if (n > MAX_MARKS) return { why: `has a character carrying ${n} accents (more than ${MAX_MARKS})`, fix: 'that piles marks over the text around it; write the letter with its usual accents' }; }
  return null;
}

/** Author text as data: «…», with « and » inside written ‹‹ and ››, clipped to max graphemes (+ "…"). */
export function quoted(s, max = 200) {
  const g = graphemeList(String(s ?? '').replace(/\s+/g, ' ').trim());
  const body = g.slice(0, max).join('').replace(/«/g, '‹‹').replace(/»/g, '››');
  return `«${body}${g.length > max ? '…' : ''}»`;
}

// the first strong character decides a paragraph's base direction (the bidi algorithm's P2–P3, which a canvas then applies)
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/u, LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿가-힯]/u;
export function directionOf(p) { for (const ch of p) { if (RTL.test(ch)) return 'rtl'; if (LTR.test(ch)) return 'ltr'; } return 'ltr'; }

/** Break text into lines no wider than `width`. measure(str) → width. Returns [{text, dir}] (dir per paragraph). */
export function layoutLines(text, width, measure) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const dir = directionOf(para);
    if (!para) { out.push({ text: '', dir }); continue; }
    const words = WORDS ? Array.from(WORDS.segment(para), (x) => x.segment) : para.split(/(\s+)/).filter(Boolean);
    let line = '';
    const push = () => { out.push({ text: line.replace(/\s+$/, ''), dir }); line = ''; };
    for (const w of words) {
      if (measure(line + w) <= width) { line += w; continue; }
      if (line.trim()) push(); else line = '';
      if (/^\s+$/.test(w)) continue;                       // a space never starts a line
      if (measure(w) <= width) { line = w; continue; }
      for (const g of graphemeList(w)) {                   // a word wider than the line: break it by character
        if (line && measure(line + g) > width) push();
        line += g;
      }
    }
    if (line || !out.length) push();
  }
  return out;
}
