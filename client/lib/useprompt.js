// useprompt — "E  open “Gate”" (ship list 10-07: a desktop visitor could use a thing only through the unlisted
// `/use <hex id>`). The conventional affordance: Roblox's ProximityPrompt (E, within a few metres, the action's words on
// screen), Unity/Unreal interact-on-E. The nearest thing within reach that offers an action (its reactions), preferring
// what you face, shows on the hint bar beside the seat hint (localbody.js updateSeatHint asks usePromptHint when there's
// no seat to offer); E uses it through the door, and a refusal reads in a person's words (editwrites showRefusal). Not in
// edit mode (E rotates there), not while typing (controller.js filters), not in a headset (no hint bar there).
import { THREE } from './core.js';
import { comps, entities } from './world.js';
import { bus } from './base.js';
import { register as registerAction } from './actions.js';
import { send } from './editwrites.js';
import { xrActive } from './xrask.js';
import { nameOf } from './plainwords.js';
import { html } from './markup.js';
import * as OP from '../../shared/protocol/requests.js';

export const USE_REACH = 2.5;   // m, feet to the thing (Roblox's prompt reaches ~10 studs ≈ 2.8 m)
let hooks = null;               // { myPos(): {x,y,z}, camera, editing(): bool, busy(): bool (photo mode, limp) }
export function initUsePrompt(h) { hooks = h; }

const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const _v = new THREE.Vector3(), _d = new THREE.Vector3();
/** What E would use now: {id, action, verb, barred?} or null. */
export function usable() {
  if (!hooks || hooks.editing?.() || hooks.busy?.() || xrActive()) return null;
  const me = hooks.myPos?.(); if (!me) return null;
  let fx = 0, fz = 0;
  if (hooks.camera?.getWorldDirection) { hooks.camera.getWorldDirection(_d); fx = _d.x; fz = _d.z; }
  let best = null, bestS = Infinity;
  for (const [id, bag] of comps) {
    const rx = bag.reactions; if (!isBag(rx) || !Object.keys(rx).length) continue;
    const obj = entities.get(id); if (!obj?.getWorldPosition) continue;
    obj.getWorldPosition(_v);
    const dx = _v.x - me.x, dz = _v.z - me.z, d = Math.hypot(dx, dz);
    if (d > USE_REACH || Math.abs(_v.y - me.y) > 2.5) continue;
    const facing = d > 1e-3 ? (dx * fx + dz * fz) / (d * (Math.hypot(fx, fz) || 1)) : 1;
    const s = d - 0.75 * facing;   // what you face wins over what's a little closer behind you
    if (s < bestS) { bestS = s; best = id; }
  }
  if (!best) return null;
  const all = actionsOf(best);
  // the action: one open to everyone if there is one (a builder-only bolt beside a door isn't what E does)
  const u = all.find((a) => !a.who) ?? all[0];
  return { id: best, action: u.action, verb: u.verb, ...(u.barred ? { barred: u.barred } : {}) };
}
/** Every action a thing offers (its reactions), in its own order: [{action, verb, who?, barred?}]. */
export function actionsOf(id) {
  const bag = comps.get(id), rx = bag?.reactions; if (!isBag(rx)) return [];
  return Object.keys(rx).map((action) => {
    const h = rx[action] ?? {};
    const comp = h.kind === 'toggle' ? (h.component ?? 'openable') : null;
    const field = h.kind === 'toggle' ? (h.field ?? ((h.component ?? 'openable') === 'openable' ? 'open' : undefined)) : undefined;   // same rule as the door's toggleOf
    const cur = comp && field && isBag(bag[comp]) ? bag[comp][field] === true : null;
    // a door that's open says "close" (ProximityPrompt's ActionText follows the state)
    const verb = comp === 'openable' && field === 'open' ? (cur ? 'close' : 'open') : action;
    const barred = h.kind === 'toggle' && h.unless && isBag(bag[comp]) && bag[comp][h.unless] === true ? h.unless : null;
    return { action, verb, ...(h.who ? { who: h.who } : {}), ...(barred ? { barred } : {}) };
  });
}
/** Use one action of one thing (the mouse: clickuse.js). The door's reply. */
export async function useThing(id, action, verb = action) {
  const r = await send(OP.use(id, action), { what: `${verb} ${id}`, record: false });
  bus.emit('use-prompt', { id, action, ok: !!r?.ok });
  return r;
}

/** The hint bar's line for it, or null. */
export function usePromptHint() {
  const u = usable(); if (!u) return null;
  return html`<kbd>E</kbd> ${u.verb} ${nameOf(u.id) ?? 'it'}${u.barred ? html` <span>(${u.barred})</span>` : ''}`;   // html``: every value escaped (markup.js)
}
/** Use what E points at. Returns the door's reply (or null when there's nothing in reach). */
export async function useNearest() {
  const u = usable(); if (!u) return null;
  const r = await send(OP.use(u.id, u.action), { what: `${u.verb} ${u.id}`, record: false });   // a use isn't an edit: no undo step
  bus.emit('use-prompt', { id: u.id, action: u.action, ok: !!r?.ok });
  return r;
}

registerAction({ id: 'body:use', key: 'E', title: 'use what\'s in front of you (open a door, ring a bell)', keywords: ['use', 'open', 'interact', 'press'], icon: 'hand', group: 'body', run: () => { void useNearest(); } });
bus.on('key', (e) => {
  if (e.code !== 'KeyE' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || hooks?.editing?.() || hooks?.busy?.()) return;
  void useNearest();
});
