// Consent over my body — who may stand near it, follow it, touch it, pose it,
// shove it, drag it, speak at it. Deliberately a leaf with ZERO lib imports:
// consent is consulted from the puppet path, the drag path, and the command
// surface, and a yes/no question should not drag anyone's module graph along
// to get answered. (shared/protocol/consent.js is pure data + functions, the
// SAME file the authority runs; importing it is what keeps the two tables one
// vocabulary.) localStorage-backed so a choice survives the session it was
// made in.
//
// The table is the authority's (PROTOCOL L6): every CLASS × every TIER, each
// cell allow | ask | deny. Until 10-14 the client could only say two bits
// (pushable, posable) and the server filled the other 13 cells with Normal.
// Now the client holds the whole table and the two old switches are a PRESET
// over it — setPushable/setPosable still exist, still mean what they meant
// (everyone's shove+displace / everyone's pose), so /pushable, bodydrag and the
// puppet path are untouched.
import { CLASSES, PRESETS, DEFAULT_PRESET, TIERS, MODES, LEGACY_TIER, LEGACY_MODE, LEGACY_CLASS } from '../../shared/protocol/consent.js';

export { CLASSES, TIERS, MODES };
// what each class means, for a settings row (the server's words, PROTOCOL §5)
export const CLASS_WORDS = {
  near: 'stand close to me', follow: 'follow me around', touch: 'touch me (hands, shoulders, back)',
  intimate: 'touch me intimately (face, eyes, chest, waist, hips)', pose: 'pose my body', shove: 'knock me over',
  displace: 'drag or carry me', voice: 'speak into my ear',
};

const KEY = 'ew-consent';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const fresh = (preset = DEFAULT_PRESET) => ({ everyone: { ...PRESETS[preset].everyone }, friends: { ...PRESETS[preset].friends } });
const isMode = (m) => MODES.includes(m);

// Load: the full table if one was saved; else the two OLD keys (ew-pushable,
// ew-posable — the pre-10-14 switches) laid over Normal, so nobody's earlier
// choice is lost by the upgrade. Every cell is validated: a stale or edited
// store never puts a word the server would refuse into the table. A table
// saved before 10-17 (strangers / everyone|nobody / move) is read in its old
// words and saved back in today's (allow|ask|deny, everyone, displace).
const word = (map, k) => (Object.hasOwn(map, k) ? map[k] : k);
function load() {
  const t = fresh();
  const saved = lsGet(KEY);
  if (saved) {
    try { const s = JSON.parse(saved); let old = false;
      for (const [tier0, row] of Object.entries(s ?? {})) { const tier = word(LEGACY_TIER, tier0); if (!TIERS.includes(tier) || !row || typeof row !== 'object') continue;
        for (const [c0, m0] of Object.entries(row)) { const c = word(LEGACY_CLASS, c0), m = word(LEGACY_MODE, m0);
          if (tier !== tier0 || c !== c0 || m !== m0) old = true;
          if (CLASSES.includes(c) && isMode(m)) t[tier][c] = m; } }
      if (old) lsSet(KEY, JSON.stringify(t));
      return t;
    } catch { /* fall through to the old keys */ }
  }
  if (lsGet('ew-pushable') === '1') { t.everyone.shove = 'allow'; t.everyone.displace = 'allow'; }
  if (lsGet('ew-posable') === '1') t.everyone.pose = 'allow';
  return t;
}
let _table = load();
const save = () => lsSet(KEY, JSON.stringify(_table));

// The table, read-only by convention (a copy: nobody edits it behind the listeners' backs).
export function table() { return { everyone: { ...(_table.everyone) }, friends: { ...(_table.friends) } }; }
export function cell(tier, cls) { return _table[tier]?.[cls]; }
function put(tier, cls, mode) {
  if (!TIERS.includes(tier) || !CLASSES.includes(cls) || !isMode(mode)) return null;
  if (_table[tier][cls] === mode) return false;
  _table[tier][cls] = mode; return true;
}
export function setCell(tier, cls, mode) { const r = put(tier, cls, mode); if (r) { save(); changed(); } return r !== null; }
// A whole preset (the server's: normal, open, friends-only, performer), replacing every cell.
export function applyPreset(name) {
  if (!Object.hasOwn(PRESETS, name)) return false;
  _table = fresh(name); save(); changed(); return true;
}
export const PRESET_NAMES = Object.keys(PRESETS);

// Being posed by someone else.
//
// A puppet is an input to MY body, applied by MY client — never a pose forced
// on me from outside. So it goes through the same presence path as my own
// movement: a pose becomes my held pose (and broadcasts), an animation I play
// and re-send as mine. Every body opts in, from the same defaults (a director
// staging a scene is welcome; a stranger yanking your limbs is not): the
// table and its preset are one for every participant (PROTOCOL §5, §6a).
//
// The client's final word reads the EVERYONE row: it cannot tell a friend
// from anyone else (friendship is the authority's, mutual, stamped), so it
// takes the narrower answer. The server has already refused what the friends
// row forbids before anything arrives here.
export function posable() { return _table.everyone.pose === 'allow'; }
export function setPosable(v) { setCell('everyone', 'pose', v ? 'allow' : 'deny'); }

// Being SHOVED is a separate consent from being POSED. Posing is directorial —
// someone else deciding what your body expresses. A shove is the world's
// rough-and-tumble: it moves you without speaking for you. Both are OPT-IN
// (R, 10-12: no one is shove-able by default): a stranger starts at the
// server's Normal — shove/displace/pose deny — and only its owner opens it.
// Pushable covers being shoved and being dragged (bodydrag asks the same
// switch). Both are still only requests: my client applies them to my body,
// or doesn't.
export function pushable() { return _table.everyone.shove === 'allow'; }
export function setPushable(v) { const m = v ? 'allow' : 'deny'; const a = put('everyone', 'shove', m), b = put('everyone', 'displace', m); if (a || b) { save(); changed(); } }

// The table as the authority takes it (consent verb, shared/protocol/consent.js setConsent): one `set {class, tier,
// mode}` for EVERY cell, and no preset. A preset empties the authority's cells, so a sync sends none: set cell by cell,
// each goes straight from what the authority held to what I chose (review of #260). With every cell set or already as
// I chose it, the stored preset changes nothing I chose (a table that never had one reads as Normal, the server's
// default). The sync (consentsync.js) sends the cells of it that differ from what the authority holds, on every arrival
// and whenever a cell changes.
export function bodyTable() {
  const sets = [];
  for (const tier of TIERS) for (const c of CLASSES) sets.push({ class: c, tier, mode: _table[tier][c] });
  return { sets };
}
const listeners = new Set();
export function onConsentChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch { /* a listener's trouble is its own */ } } }
