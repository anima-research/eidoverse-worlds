// a11y — how a thing reads to anyone who perceives by reading (R 10-07: "this is how the object is described to any
// text-based entity"), on the accessibility model: its NAME (label), its DESCRIPTION (description), then what
// it CAN do and its STATE, GENERATED from its components, so a description never restates an affordance and can never
// contradict one. One reading for the authority's look/inspect (shared/protocol/authority.js describe), mcpl's look
// (mcpl/agent.ts) and the human inspector (shared/editschema.js), so they can't disagree. Compact on purpose: an agent's
// context is precious, so each line is a short phrase and only what a component actually says.
//
// What isn't here: a visible nameplate. That is a child thing carrying `text` (billboard: 'yaw'), drawn for eyes; this
// reading is what non-visual readers get, and a thing with no description still reads by its name and its components.
// Author text (label, description) is quoted «…» as data (shared/text.js quoted), never an instruction to the reader.
import { quoted } from './text.js';
import { isBase, whoWords } from './protocol/roles.js';
import { grabOf } from './grab.js';
import { bodyOf } from './sockbody.js';
import { describeParticles } from './particles.js';

export const DESCRIPTION_LOOK_MAX = 200;   // a look's line; inspect has all of it
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && v.purged !== true;

/** The reactions action that opens and shuts an openable (a toggle on openable.open), or null. */
export function openAction(c) {
  if (!isObj(c?.reactions)) return null;
  for (const [act, h] of Object.entries(c.reactions)) if (isObj(h) && h.kind === 'toggle' && (h.component ?? 'openable') === 'openable' && (h.field ?? 'open') === 'open') return act;
  return null;
}

/**
 * {name, description, can: [phrases], state: [phrases]} for a thing's components c. opts: {name (a fallback name: its
 * model's), heldBy (who holds it now, a display name), lookup (stored particle effects), sockets (its socket children,
 * [{name, sock}]: a thing's seats are children, never a component of its own)}.
 */
export function readOut(c, { name = null, heldBy = null, lookup = () => null, sockets = null } = {}) {
  c = isObj(c) ? c : {};
  const out = { name: typeof c.label === 'string' && c.label ? c.label : name, description: null, can: [], state: [] };
  if (typeof c.description === 'string' && c.description.trim()) out.description = c.description;
  // ---- what it can do ----
  const open = openAction(c);
  if (isObj(c.openable)) out.can.push(open ? `opens and shuts (use '${open}')` : 'opens and shuts (nothing here opens it)');
  const gr = grabOf(c);
  if (gr) out.can.push(!gr.enabled ? "can't be picked up now" : isBase(gr.who) ? 'can be picked up' : `${whoWords(gr.who)} can pick it up`);
  // its seats are its socket children ([{name, sock}], the caller's socketsOf / socketsIn: switched-off ones aren't offered)
  if (Array.isArray(sockets)) {
    const seats = sockets.map((x) => [x.name, bodyOf(x.station)]).filter(([, b]) => b);
    const acts = [...new Set(seats.map(([, b]) => b.action))];
    for (const a of acts) { const slots = seats.filter(([, b]) => b.action === a).map(([s]) => s); out.can.push(`can be ${a === 'sit' ? 'sat on' : `used to ${a}`} (${slots.join(', ')})`); }
  }
  if (isObj(c.reactions)) { const acts = Object.keys(c.reactions).filter((a) => a !== open); if (acts.length) out.can.push(`can be used: ${acts.join(', ')}`); }
  // ---- its state ----
  if (isObj(c.openable)) out.state.push(c.openable.open === true ? 'open' : c.openable.locked === true ? 'shut and locked' : 'shut');
  if (heldBy) out.state.push(`held by ${heldBy}`);
  if (c.lock === true || isObj(c.lock)) out.state.push(`fixed in place${isObj(c.lock) && c.lock.rank && c.lock.rank !== 'builder' ? ` (${c.lock.rank} lock)` : ''}`);
  if (c.hidden === true) out.state.push('hidden (not drawn)');
  if (isObj(c.particles)) out.state.push(describeParticles(c.particles, { lookup }).replace(/ \(particles;.*$/, (m) => (/stopped/.test(m) ? ' (stopped)' : '')));
  if (isObj(c.sound)) out.state.push(c.sound.playing === false ? 'silent' : 'playing a sound');
  if (isObj(c.motion) && c.motion.type) out.state.push(`moving (${c.motion.type})`);
  if (isObj(c.light)) out.state.push('lit');
  return out;
}

/** One compact line: «name»: «description» — can …; … · state … (what look prints for a thing). */
export function readLine(r, { max = DESCRIPTION_LOOK_MAX } = {}) {
  if (!r) return '';
  const bits = [];
  if (r.description) bits.push(quoted(r.description, max));
  if (r.can.length) bits.push(r.can.join('; '));
  if (r.state.length) bits.push(r.state.join(', '));
  return bits.join(' — ');
}
