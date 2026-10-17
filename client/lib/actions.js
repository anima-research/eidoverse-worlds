// actions — the one list of things a person can DO here: every panel, section,
// emote, key and slash command registers once, where it is defined, and every
// surface that offers actions (the lantern prompt today; the help sheet, the ∃
// menu and VR's wrist later) reads this list instead of keeping its own copy.
//
// PURE, and it must stay that way: no imports, no DOM. Definition sites all over
// the client import this file, so a dependency here would close cycles through
// ui.js / chat.js / controller.js. It is unit-tested headless
// (tools/actions-test.mjs) for exactly that reason.
//
//   register({ id, title, keywords?, group?, key?, run, when?, fill? }) → unregister()
//     id       stable, unique. Registering an EXISTING id MERGES (defined fields
//              win), so a key table can add `key: 'F3'` to the dock's 'panel:debug'
//              without either site knowing the other's wording.
//     title    what the row says
//     keywords extra words that find it ("mute", "voice" for the mic)
//     group    the heading it lists under ("emotes", "panels", "world", …)
//     key      the keyboard key that does the same thing, shown right-aligned —
//              the keys teach themselves
//     run      () => void. Required (unless merging into an entry that has one).
//     when     () => bool — hidden while false (a builder-only wrench)
//     fill     text a prompt should put in its line instead of running (a command
//              that needs an argument: '/w ')
//     icon     optional: an icons.js glyph name, or an emoji literal (an emote
//              tile's own face) — how a row looks, never how it matches
//     detail   optional: a dim second phrase ("open the sky section"; a command's
//              help line) — display only, never matched
//   list(query, { limit }) → [{ action, score }] best first; '' lists everything
//   score(query, action)   → number, 0 = no match. Exported for the tests.

const actions = new Map();   // insertion order is the tie-break of last resort

export function register(spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error('actions.register: id required');
  const prev = actions.get(spec.id);
  const next = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(spec)) if (v !== undefined) next[k] = v;
  if (typeof next.title !== 'string' || !next.title) throw new Error(`actions.register(${spec.id}): title required`);
  if (typeof next.run !== 'function' && typeof next.fill !== 'string') throw new Error(`actions.register(${spec.id}): run or fill required`);
  next.keywords = [...new Set([...(prev?.keywords ?? []), ...(spec.keywords ?? [])])];
  next.group ??= 'other';
  actions.set(spec.id, next);
  return () => { if (actions.get(spec.id) === next) actions.delete(spec.id); };
}

export const unregister = (id) => actions.delete(id);
export const get = (id) => actions.get(id) ?? null;
export const all = () => [...actions.values()];
export function clear() { actions.clear(); }   // tests

const visible = (a) => { try { return a.when ? !!a.when() : true; } catch { return false; } };

// ---------------------------------------------------------------- ranking
// Tiers, highest first — the ranking contract the tests pin:
//   exact (1000) > prefix (900) > key (850) > word-start (700) > all-words (650)
//   > substring (400) > subsequence (100..199, tighter spans higher).
// A KEYWORD match (word-start or better) counts a tier lower (-100) than the same match on the title,
// so "mute" finds the mic through its keyword but a title that says "mute" wins,
// and a keyword merely STARTING with what you typed ("hi" → "hide") is never STRONG.
//
// STRONG (>= 850): a title exact/prefix, an exact keyword, or the key itself — a
// confident match. (The lantern once used it to guess command-or-speech; it no
// longer guesses: Enter says, Tab does. Kept for surfaces that want confidence.)
const WORD_SPLIT = /[\s\-_/·:▸.,()'"]+/;

function tier(q, text) {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(49, t.length - q.length);   // "sky" beats "skyline" for "sk"; never down to the key's 850
  const words = t.split(WORD_SPLIT).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 700;
  const qw = q.split(/\s+/).filter(Boolean);
  if (qw.length > 1 && qw.every((p) => words.some((w) => w.startsWith(p)))) return 650;
  if (q.length < 2) return 0;   // one stray letter is not a match: it must start the title or a word
  if (t.includes(q)) return 400;
  // subsequence: every query char in order; score by how tight the span is
  let i = 0, start = -1, end = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) { if (start < 0) start = j; end = j; i++; }
  }
  if (i < q.length) return 0;
  const span = end - start + 1;
  return 100 + Math.round(99 * (q.length / span));
}

export function score(query, a) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 1;
  let s = tier(q, a.title);
  // keywords count only as whole words or word-starts: a keyword SUBSTRING or subsequence ("sk" in "speak",
  // or anywhere inside a command's help line) is noise that buries the real match
  for (const k of a.keywords ?? []) { const t = tier(q, String(k)); if (t >= 650) s = Math.max(s, t - 100); }
  if (a.key && String(a.key).toLowerCase() === q) s = Math.max(s, 850);
  return s;
}

export const STRONG = 850;

export function list(query = '', { limit = 50 } = {}) {
  const out = [];
  let order = 0;
  for (const a of actions.values()) {
    order++;
    if (!visible(a)) continue;
    const s = score(query, a);
    if (s > 0) out.push({ action: a, score: s, order });
  }
  // best first; then the shorter title (the more specific one); then registration order
  out.sort((x, y) => y.score - x.score || x.action.title.length - y.action.title.length || x.order - y.order);
  return out.slice(0, limit).map(({ action, score: s }) => ({ action, score: s }));
}

/** Group ranked results for display, keeping the best row FIRST: a group sits
 *  where its best row ranks, and rows keep their rank inside it. */
export function grouped(results) {
  const groups = new Map();
  for (const r of results) {
    const g = r.action.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

export function run(id) {
  const a = actions.get(id);
  if (!a || !visible(a) || typeof a.run !== 'function') return false;
  a.run();
  return true;
}
