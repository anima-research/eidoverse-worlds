// editschema — what can be edited on a thing, and how, as a PURE FUNCTION of
// its folded record. Dependency-free, shared verbatim by three surfaces:
//
//   desktop inspector   client/lib/editpanels.js renders the fields (panels.js)
//   VR quad             the same fields painted to a canvas (xrpanels.js)
//   models              mcpl `inspect` prints them, `edit` commits them
//
// This is the parity law made structural: anything a human can click, a
// model can say — because both read ONE declaration and both commit through
// editVerbs(). The fold (shared/fold.js) is the source of every value here;
// a client with a realized object may layer live extras on top (is the light
// actually casting) but never a different truth.
//
// inspectSchema(ent, id)          → { groups: [{ group, verb, fields }] }
//   fields are panels.js specs: { t, k, label, value, def?, … } with k a plain name (def: the
//   value the evaluator uses when the key is absent — the inspector offers ↺ back to it)
//   inside the group. Address a field from outside as "<group>.<k>"
//   (pos.x · light.intensity · motion.amp · sockets.seat.yaw · comp.recipe).
// editVerbs(ent, id, edits)       → { verbs: [{verb, args}], errors: [] }
//   edits: { "<group>.<k>": value } — a number, a boolean, a string, or a
//   relative expression ("+=2", "*=-1", "-=10%") against the current value.
//   Edits that share a verb coalesce: three transform channels are ONE place
//   carrying the full pose; two socket fields are ONE merged comp.

import { normalizePicture, PICTURE_LIT, PICTURE_LOOK_MAX } from './picture.js';
import { normalizeSound, SOUND_LOOK_MAX } from './sound.js';
import { componentsOf, addable, RECORDS, compRefusal, LIGHT_DEFAULTS } from './components.js';
import { eulerFromQ, qFromEuler, rotOrderOf, ROT_MODES, QUAT_MODE } from './euler.js';
import { qNorm, qHeading, qFromYaw, qWithHeading } from './rot.js';
import { scale3, scaleWire, entScale } from './scale3.js';
import { localOf, parentVerbs, childrenOf, worldPose } from './hierarchy.js';

const R2D = 180 / Math.PI;
export const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };
export const MOTION_TYPES = ['pendulum', 'spin', 'orbit', 'bob', 'path'];
export const PARTICLE_PRESETS = ['fire', 'sparks', 'embers', 'smoke', 'dust', 'snow', 'magic', 'stars', 'muzzle'];
const round = (v, dp = 3) => +(+v).toFixed(dp);

/** Typed entry → number, with Maya's relative operators. null = not a number. */
export function parseEntry(text, current) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const t = String(text).trim();
  const m = /^([+\-*/])=\s*(-?\d*\.?\d+)\s*(%?)$/.exec(t);
  if (m) {
    let n = +m[2];
    if (m[3]) n = current * n / 100;
    switch (m[1]) {
      case '+': return current + n;
      case '-': return current - n;
      case '*': return current * n;
      case '/': return n ? current / n : null;
    }
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function axisName(m, def) {
  const a = m.axis;
  if (typeof a === 'string' && AXES[a.toLowerCase()]) return a.toLowerCase();
  if (Array.isArray(a) && a.length === 3) {
    for (const [k, v] of Object.entries(AXES)) if (v.every((c, i) => c === a[i])) return k;
    return 'custom';
  }
  return def;
}
const isLight = (ent) => ent?.kind === 'light';
const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// The light component (PROTOCOL §4, 2026-10-01) — on anything that is not a
// light-verb light. When both spellings are present the legacy one owns the
// `light` group (it is what renders) and the comp shows as raw JSON.
const compLight = (ent) => !isLight(ent) && isBag(ent?.comp?.light);
// The reading a viewer with no hint gets: canonical (middle axis within ±90°,
// shared/euler.js) — except an UPRIGHT thing with a q (a pure turn about +Y,
// which every lease release and settle writes), which reads (0, yaw, 0) in
// every order, exactly as the same thing without a q does.
const uprightHint = (ent) => (ent?.q && Math.abs(ent.q[0]) < 1e-12 && Math.abs(ent.q[2]) < 1e-12 ? [0, ent.yaw ?? 0, 0] : null);
const motionKeys = (ent) => Object.keys(ent?.comp ?? {}).filter((k) => (k === 'motion' || k.startsWith('motion:')) && ent.comp[k] && typeof ent.comp[k] === 'object');

// ---------------------------------------------------------------- schema

/** @param ent   the folded entity record (shared/fold.js), or null
 *  @param id    its id
 *  @param live  optional viewer extras: { casting?: boolean, mayAuthor?: boolean,
 *               parts?: string[] (the model's named mesh parts — a picture's `part`
 *               becomes a dropdown and '+ picture' is offered), now?: number }
 *               mayAuthor — may THIS viewer author the thing (its placer, the
 *               owner, an operator)? undefined = unknown: nothing is disabled
 *               on its account and the server decides, as it always does. */
export function inspectSchema(ent, id, live = {}) {
  if (!ent) return { id, groups: [] };
  const c = ent.comp ?? {};
  const mounted = !!ent.parent;
  const locked = !!c.lock;
  // live.doorLocks (a v4 world): a lock doesn't make the pose read-only here; the door refuses the move and a person who
  // may lift the lock is asked "This is locked. Move anyway?" (PROTOCOL-v4 §5). v1 and agents' schemas are unchanged.
  const binds = locked && !live.doorLocks;
  // the pose the channel box shows and edits: a child's is LOCAL to its parent
  // (design §3) — the mount's offset and relative q, as the renderer realizes
  // it — never the fold's pre-mount pos, which nothing draws while it rides
  const L = localOf(ent, live.world ?? null);
  const pv = L.mounted ? { ...ent, pos: L.pos, q: L.q ?? undefined, yaw: L.yaw } : ent;
  // guard (AGENTS.md "Guarding"): only its placer, the world's owner or an
  // operator may author it. The name comes from the STAMP, never the latest
  // actor — an owner's re-light moves `actor` and leaves the placer alone.
  const guarded = !!c.guard;
  const placer = ent.placer?.id ?? ent.actor ?? null;
  const held = guarded && live.mayAuthor === false;
  const groups = [];

  // transform — the entity's LOCAL frame: a root's is the world (`place`), a
  // child's is its parent's (`mount` with the new offset / relative q; scale
  // stays the child's own, so it is still a `place`). Only a part socket's
  // rider is read-only: its pose is baked at the moving part's phase.
  const partRide = mounted && L.part;
  const tf = { disabled: binds || !!partRide, hint: binds ? 'locked — unlock to move it' : locked ? 'locked — moving it asks first' : partRide ? `rides ${ent.parent.to}'s moving part ${L.part} — its pose is set where it mounted; unparent and parent it again to move it` : undefined };
  const pos = pv.pos ?? [0, 0, 0];
  const transform = [
    { t: 'num', k: 'x', label: 'translate x', value: round(pos[0]), step: 0.1, dp: 2, unit: 'm', ...tf },
    { t: 'num', k: 'y', label: 'translate y', value: round(pos[1]), step: 0.1, dp: 2, unit: 'm', ...tf },
    { t: 'num', k: 'z', label: 'translate z', value: round(pos[2]), step: 0.1, dp: 2, unit: 'm', ...tf },
  ];
  const rotation = [];
  let gimbal = false;
  if (!isLight(ent)) {
    // pos.yaw: the heading — the friendly subset (PROTOCOL §9.1: a bare yaw turns
    // the thing about world +Y and keeps any tilt). Kept for agents and old
    // callers; the channel box shows the Rotate channels instead (alias).
    transform.push({ t: 'num', k: 'yaw', label: 'heading', value: round(pv.yaw ?? 0, 4), step: 5, deg: true, alias: 'rot', ...tf,
      hint: tf.hint ?? `turn about ${L.mounted ? 'its parent\'s' : 'world'} up to this heading, keeping any tilt (the Rotate channels are the full orientation)` });
    // scale: in a v4 world (live.doorLocks) three channels like translate and rotate (R 10-04); `scale` stays as the
    // uniform setter agents already use (all three to one number), drawn only where it is the whole story (v1)
    const S = scale3(entScale(ent));
    transform.push({ t: 'num', k: 'scale', label: 'scale', value: round(S[1]), def: 1, step: 0.05, dp: 2, min: 0.01, softMax: 12, ...tf,
      ...(live.doorLocks ? { alias: 'scale', hint: tf.hint ?? 'sets all three axes to one number (the channels are scale x / y / z)' } : {}) });
    if (live.doorLocks) ['x', 'y', 'z'].forEach((a, i) => transform.push({ t: 'num', k: `s${a}`, label: `scale ${a}`, value: round(S[i]), def: 1, step: 0.05, dp: 2, min: 0.01, softMax: 12, ...tf }));
    // the channel box's Rotate (design §5): Euler degrees READ from q in the
    // entity's rotation order (shared/euler.js); a yaw-only thing reads exactly
    // (0, yaw, 0) in every order. live.euler is the triple this viewer last
    // saw — it picks the Euler branch, so channels don't jump while you work.
    const order = rotOrderOf(ent);
    const q = pv.q ?? qFromYaw(pv.yaw ?? 0);
    rotation.push({ t: 'enum', k: 'order', label: 'rotate order', value: order, def: 'XYZ', options: ROT_MODES.map((v) => ({ v, label: v === QUAT_MODE ? 'quaternion' : v })),
      hint: 'how the Rotate channels read the orientation (Maya\'s rotateOrder: XYZ applies X first). Changing it never moves the thing, so a lock or a mount does not stop it' });
    if (order !== QUAT_MODE) {
      let e;
      if (!pv.q) e = [0, pv.yaw ?? 0, 0];
      else { const r = eulerFromQ(pv.q, order, live.euler ?? uprightHint(pv)); e = r.e; gimbal = r.locked; }
      ['x', 'y', 'z'].forEach((k, i) => rotation.push({ t: 'num', k, label: `rotate ${k}`, value: round(e[i], 12), step: 5, deg: true, ...tf }));
    }
    ['x', 'y', 'z', 'w'].forEach((a, i) => rotation.push({ t: 'num', k: `q${a}`, label: `quat ${a}`, value: round(q[i], 6), step: 0.01, dp: 4, min: -1, max: 1, row: 'quat', ...tf,
      hint: tf.hint ?? 'the stored orientation (unit quaternion x y z w); normalized on commit' }));
  }
  const driven = c.motion?.type && !c.motion.part ? 'motion' : null;   // a whole-entity motion composes onto this REST pose
  if (driven) for (const f of [...transform, ...rotation]) if (f.t === 'num') f.driven = driven;
  if (L.mounted) transform.unshift({ t: 'info', label: 'frame', value: `local to its parent, ${ent.parent.to} — translate and rotate write its mount; scale is its own (the parent's multiplies it)` });
  groups.push({ group: 'pos', label: 'Transform', verb: L.mounted ? 'mount' : 'place', fields: transform, ...(L.mounted ? { local: ent.parent.to } : {}) });
  if (rotation.length) groups.push({ group: 'rot', label: 'Rotate', verb: L.mounted ? 'mount' : 'place', fields: rotation, ...(gimbal ? { gimbal: true } : {}) });

  // the hierarchy (design §3 "Children"): who this rides, who rides it. The
  // ref picks a new parent (a tree row, or the thing in the world) and keeps
  // the child where it stands; clearing it — or `unparent` — makes it a root.
  // The same edit the Hierarchy's drag commits, so a headset and an agent can.
  const kids = live.world ? childrenOf(live.world, id) : null;
  groups.push({ group: 'parent', label: 'Parent', verb: 'mount', fields: [
    { t: 'ref', k: 'to', label: 'parent', value: mounted ? ent.parent.to : null, ...(binds ? { disabled: true, hint: 'locked — unlock to move it' } : {}),
      hint: binds ? 'locked — unlock to move it' : 'pick its new parent — a row, or the thing itself in the world; it stays where it stands. Clear it to make it a root' },
    ...(kids ? [{ t: 'info', k: 'children', label: 'children', value: kids.length ? kids.join(', ') : 'none' }] : []),
    ...(mounted ? [{ t: 'btn', k: 'unparent', label: 'unparent', ...(binds ? { disabled: true, hint: 'locked — unlock to move it' } : { hint: 'make it a root, where it stands' }) }] : []),
  ] });

  const flags = [];
  if (held) flags.push({ t: 'info', label: '', value: `🛡 guarded by ${placer ?? 'its placer'} — only they, the world's owner or an operator may change, move or remove it (using it and sitting on it stay open)` });
  groups.push({ group: 'flags', label: 'Flags', verb: 'comp', fields: [...flags,
    { t: 'check', k: 'lock', label: 'locked', value: locked, hint: 'nail it down: nobody\'s drags, verbs or scripts can move, replace or remove it (server-enforced); sitting on it and content edits stay open' },
    { t: 'check', k: 'guard', label: 'guarded', value: guarded, disabled: live.mayAuthor === false,
      hint: live.mayAuthor === false ? `only ${placer ?? 'its placer'} or the world's owner can set or clear the guard on this`
        : 'make it yours to author: while guarded, only you, the world\'s owner or an operator can change its components, move it, remove it or bind scripts to it (server-enforced) — using it and sitting on it stay open' },
    { t: 'check', k: 'hidden', label: 'hidden', value: c.hidden === true, hint: 'not drawn, still there — a comp every client honours' },
    { t: 'text', k: 'label', label: 'name', value: typeof c.label === 'string' ? c.label : '', placeholder: 'give it a name', hint: 'what people see; rename it freely — its id never changes' },
  ] });

  // pivot (research 52): where it turns and scales from, in its own frame (before scale). The buttons snap it to the
  // model's own box (live.box, the client's measure of the model in its frame); reset = back to the origin.
  if (isBag(c.pivot) && Array.isArray(c.pivot.pos)) {
    const pp = c.pivot.pos; const box = live.box;
    groups.push({ group: 'pivot', label: 'pivot', verb: 'comp', types: ['pivot'], fields: [
      ...['x', 'y', 'z'].map((a, i) => ({ t: 'num', k: a, label: `pivot ${a}`, value: round(+pp[i] || 0), step: 0.05, dp: 2, unit: 'm', ...tf,
        hint: tf.hint ?? 'in its own frame, before scale: 0 is its origin. Moving the pivot never moves the thing' })),
      { t: 'btn', k: 'centre', label: 'centre', disabled: !box || !!tf.disabled, hint: box ? 'the middle of its model' : 'its model is still loading' },
      { t: 'btn', k: 'base', label: 'base', disabled: !box || !!tf.disabled, hint: box ? 'the middle of its bottom face (where it stands)' : 'its model is still loading' },
      { t: 'btn', k: 'reset', label: 'origin', disabled: !!tf.disabled, hint: 'back to the origin its author left (removes the pivot)' },
    ] });
  }

  // look — the first user of the `ref` field: name ANOTHER entity for this one
  // to face. The value is a target id (or null). The picker reuses attach's
  // arming: arm, then click a row or the thing in the world. Only shown once a
  // `look` comp exists (add it via + component) so we add no UI to things that
  // don't use it — the field TYPE is the deliverable; this is its demonstrator.
  if (c.look && typeof c.look === 'object') {
    groups.push({ group: 'look', label: 'look at', verb: 'comp', types: ['look'], fields: [
      { t: 'ref', k: 'target', label: 'target', value: typeof c.look.target === 'string' ? c.look.target : null,
        hint: 'the entity this one faces — pick a row, or the thing itself in the world' },
    ] });
  }

  // one `light` group for either spelling, so `light.intensity` means the same
  // address to the panel, the VR quad and the agent's edit tool. What it WRITES
  // follows the spelling the entity already has (editVerbs): the light verb for
  // a light-verb light, `comp light` for a light component.
  if (isLight(ent) || compLight(ent)) {
    const src = isLight(ent) ? ent : c.light;
    const fields = [
      { t: 'color', k: 'color', label: 'color', value: src.color ?? 0xffd9a0, def: 0xffd9a0 },
      { t: 'num', k: 'intensity', label: 'brightness', value: src.intensity ?? 16, def: 16, step: 1, dp: 0, min: 0, softMax: Math.max(64, src.intensity ?? 16) },
      { t: 'num', k: 'range', label: 'range', value: src.range ?? 10, def: 10, step: 1, dp: 0, min: 1, softMax: Math.max(40, src.range ?? 10), unit: 'm' },
      { t: 'check', k: 'keep', label: 'keep lit', value: src.keep === true, hint: 'first claim on a light slot, never governor-shed' },
      { t: 'check', k: 'noon', label: 'burns at noon', value: src.day === false, hint: 'opts out of the day cycle' },
    ];
    if (live.casting === false) fields.push({ t: 'info', label: '', value: 'glow-only right now (slot pool spent) — it may still cast for others' });
    groups.push({ group: 'light', label: 'light', ...(isLight(ent) ? { verb: 'light' } : { verb: 'comp', types: ['light'] }), fields });
  }

  // the collider component (PROTOCOL §4, 2026-10-01), or the spawn verb's
  // legacy `collide` it overrides. Editing writes the component either way:
  // `collide` has no verb but spawn, and re-spawning would re-author the thing.
  if (isBag(c.collider) || ent.collide != null) {
    const shape = isBag(c.collider) ? c.collider.shape : ent.collide;
    const opts = ['exact', 'box'];
    groups.push({ group: 'collider', label: 'collider', verb: 'comp', ...(isBag(c.collider) ? { types: ['collider'] } : {}), fields: [
      { t: 'enum', k: 'shape', label: 'shape', value: shape, options: (opts.includes(shape) ? opts : [...opts, String(shape)]).map((v) => ({ v, label: v })),
        hint: isBag(c.collider) ? 'exact = its triangles, box = its bounding box; remove the component to let its size decide'
          : 'set by its spawn; changing it here writes a collider component, which takes precedence' },
    ] });
  }

  const mk = motionKeys(ent);
  if (mk.length) {
    const fields = [];
    for (const key of mk) {
      const m = c[key];
      const P = key === 'motion' ? '' : `${key.slice(7)} · `;
      const k = (p) => (key === 'motion' ? p : `${key.slice(7)}|${p}`);
      const types = MOTION_TYPES.includes(m.type) ? MOTION_TYPES : [...MOTION_TYPES, m.type ?? '?'];
      fields.push({ t: 'enum', k: k('type'), label: `${P}type`, value: m.type, options: types.map((v) => ({ v, label: v })) });
      if (['pendulum', 'spin', 'bob'].includes(m.type)) {
        const ax = axisName(m, m.type === 'pendulum' ? 'x' : 'y');
        const opts = Object.keys(AXES).map((v) => ({ v, label: v }));
        fields.push({ t: 'enum', k: k('axis'), label: `${P}axis`, value: ax, options: ax === 'custom' ? [...opts, { v: 'custom', label: 'custom' }] : opts });
      }
      switch (m.type) {
        case 'pendulum':
          fields.push({ t: 'num', k: k('amp'), label: `${P}amp`, value: m.amp ?? m.amplitude ?? 0, step: 5, deg: true, min: 0, softMax: Math.PI });
          fields.push({ t: 'num', k: k('period'), label: `${P}period`, value: m.period ?? 3.5, def: 3.5, step: 0.1, dp: 2, min: 0.05, unit: 's' });
          fields.push({ t: 'num', k: k('phase'), label: `${P}phase`, value: m.phase ?? 0, step: 5, deg: true });
          fields.push({ t: 'num', k: k('damp'), label: `${P}damp`, value: m.damp ?? 0, def: 0, step: 0.01, dp: 3, min: 0, softMax: 2, hint: '0 swings forever; friction is opt-in' });
          break;
        case 'spin':
          fields.push({ t: 'num', k: k('degPerSec'), label: `${P}rate`, value: m.degPerSec != null ? m.degPerSec : (m.rpm ?? 6) * 6, def: 36, step: 5, dp: 1, unit: '°/s' });
          fields.push({ t: 'num', k: k('phase'), label: `${P}phase`, value: m.phase ?? 0, step: 5, deg: true });
          break;
        case 'orbit':
          fields.push({ t: 'num', k: k('radius'), label: `${P}radius`, value: m.radius ?? 1, def: 1, step: 0.1, dp: 2, min: 0, unit: 'm' });
          fields.push({ t: 'num', k: k('degPerSec'), label: `${P}rate`, value: m.degPerSec ?? 12, def: 12, step: 5, dp: 1, unit: '°/s' });
          fields.push({ t: 'check', k: k('face'), label: `${P}face along`, value: m.face !== false });
          break;
        case 'bob':
          fields.push({ t: 'num', k: k('amp'), label: `${P}amp`, value: m.amp ?? m.amplitude ?? 0.3, def: 0.3, step: 0.05, dp: 2, min: 0, unit: 'm' });
          fields.push({ t: 'num', k: k('period'), label: `${P}period`, value: m.period ?? 4, def: 4, step: 0.1, dp: 2, min: 0.05, unit: 's' });
          fields.push({ t: 'num', k: k('phase'), label: `${P}phase`, value: m.phase ?? 0, step: 5, deg: true });
          break;
        case 'path':
          fields.push({ t: 'info', label: `${P}points`, value: `${Array.isArray(m.points) ? m.points.length : 0} points — edit as JSON (comp.${key})` });
          if (m.duration != null && m.speed == null) fields.push({ t: 'num', k: k('duration'), label: `${P}duration`, value: m.duration, step: 0.5, dp: 1, min: 0.1, unit: 's' });
          else fields.push({ t: 'num', k: k('speed'), label: `${P}speed`, value: m.speed ?? 1, def: 1, step: 0.1, dp: 2, min: 0, unit: 'm/s' });
          fields.push({ t: 'enum', k: k('loop'), label: `${P}loop`, value: m.loop ?? 'loop', options: ['loop', 'pingpong', 'once'].map((v) => ({ v, label: v })) });
          fields.push({ t: 'check', k: k('face'), label: `${P}face along`, value: m.face !== false });
          break;
      }
      fields.push({ t: 'btn', k: k('rest'), label: P ? `${P.trim()} come to rest` : 'come to rest', danger: true });
    }
    groups.push({ group: 'motion', label: 'motion', verb: 'motion', types: mk, fields });
  }

  if (c.sockets && typeof c.sockets === 'object') {
    const slots = Object.keys(c.sockets);
    const fields = [{ t: 'list', k: 'slots', empty: 'no anchors yet', rows: slots.map((slot) => {
      const s = c.sockets[slot] ?? {}; const p = s.pos ?? [0, 0.5, 0];
      return { id: slot, label: slot, sub: `(${p.map((v) => (+v).toFixed(2)).join(', ')}) · ${Math.round((s.yaw ?? 0) * R2D)}°${s.part ? ` · rides ${s.part}` : ''}`, actions: [{ k: 'del', label: '✕', danger: true }] };
    }) }];
    for (const slot of slots) {
      const s = c.sockets[slot] ?? {}; const p = s.pos ?? [0, 0.5, 0];
      ['x', 'y', 'z'].forEach((ax, i) => fields.push({ t: 'num', k: `${slot}|pos|${i}`, label: `${slot} ${ax}`, value: p[i], step: 0.05, dp: 2, unit: 'm' }));
      fields.push({ t: 'num', k: `${slot}|yaw`, label: `${slot} yaw`, value: s.yaw ?? 0, step: 5, deg: true });
    }
    fields.push({ t: 'btn', k: 'add', label: '+ seat here', hint: 'click the spot on the thing where a sitter goes', client: true });
    groups.push({ group: 'sockets', label: 'sockets', verb: 'comp', types: ['sockets'], fields });
  }

  if (c.particles && typeof c.particles === 'object') {
    const p = c.particles; const o = p.origin ?? [0, 0, 0];
    const presets = PARTICLE_PRESETS.includes(p.preset) ? PARTICLE_PRESETS : [...PARTICLE_PRESETS, p.preset ?? '?'];
    groups.push({ group: 'particles', label: 'particles', verb: 'comp', types: ['particles'], fields: [
      { t: 'enum', k: 'preset', label: 'preset', value: p.preset, options: presets.map((v) => ({ v, label: v })) },
      { t: 'num', k: 'count', label: 'count', value: p.count ?? 150, def: 150, step: 10, dp: 0, min: 1, max: 600 },
      { t: 'num', k: 'origin|0', label: 'origin x', value: o[0], step: 0.05, dp: 2, min: -8, max: 8, unit: 'm' },
      { t: 'num', k: 'origin|1', label: 'origin y', value: o[1], step: 0.05, dp: 2, min: -8, max: 8, unit: 'm' },
      { t: 'num', k: 'origin|2', label: 'origin z', value: o[2], step: 0.05, dp: 2, min: -8, max: 8, unit: 'm' },
      { t: 'num', k: 'size', label: 'size', value: p.size ?? 1, def: 1, step: 0.1, dp: 2, min: 0.05, softMax: 4 },
      { t: 'num', k: 'opacity', label: 'opacity', value: p.opacity ?? 1, def: 1, step: 0.05, dp: 2, min: 0, max: 1 },
      { t: 'num', k: 'speed', label: 'speed', value: p.speed ?? 1, def: 1, step: 0.1, dp: 2, min: 0, softMax: 4 },
      { t: 'num', k: 'lifetime', label: 'lifetime', value: p.lifetime ?? 1, def: 1, step: 0.1, dp: 2, min: 0.05, softMax: 10, unit: 's' },
      { t: 'enum', k: 'quality', label: 'quality', value: p.quality ?? 'auto', def: 'auto', options: ['auto', 'high', 'med', 'low'].map((v) => ({ v, label: v })) },
      { t: 'btn', k: 'out', label: 'put it out', danger: true },
    ] });
  }

  // picture (shared/picture.js): an image on a named part. Every field edit
  // merges into the bag and must pass normalizePicture before a verb goes out.
  if (c.picture && typeof c.picture === 'object') {
    const p = c.picture; const parts = live.parts;
    const partOpts = parts?.length ? [...new Set([...(p.part && !parts.includes(p.part) ? [p.part] : []), ...parts])] : null;
    const fields = [
      partOpts ? { t: 'enum', k: 'part', label: 'part', value: p.part, options: partOpts.map((v) => ({ v, label: v })), hint: 'the named mesh part the image goes on' }
        : { t: 'text', k: 'part', label: 'part', value: p.part ?? '', hint: 'the GLB node to texture — measure {id} lists them' },
      { t: 'text', k: 'src', label: 'image', value: p.src ?? '', placeholder: 'eidoverse/assets/… or store/images/…', hint: 'a library path — never a URL' },
      { t: 'btn', k: 'upload', label: 'upload image…', client: true, hint: 'PNG, JPEG or WebP into the store; the path fills in' },
      { t: 'text', k: 'look', label: 'what it shows', value: p.look ?? '', placeholder: 'what text-tier residents read', hint: `≤${PICTURE_LOOK_MAX} chars; without it they see only the file name` },
      { t: 'enum', k: 'lit', label: 'lit', value: p.lit === 'self' ? 'self' : 'scene', options: Object.entries(PICTURE_LIT).map(([v, label]) => ({ v, label })) },
      { t: 'check', k: 'flip', label: 'flip', value: p.flip === true, hint: 'for a part whose UVs were exported upside down' },
    ];
    const n = normalizePicture(p);
    if (!n.ok) fields.unshift({ t: 'info', label: '', value: `⚠ not shown: ${n.why}` });
    else if (n.notes.length) fields.push({ t: 'info', label: '', value: n.notes.join(' · ') });
    fields.push({ t: 'btn', k: 'down', label: 'take down', danger: true });
    groups.push({ group: 'picture', label: 'picture', verb: 'comp', types: ['picture'], fields });
  }

  // sound (shared/sound.js): positional audio. Tuning a PLAYING sound keeps its
  // t0 (nobody's playhead jumps); only play re-stamps it, so everyone seeks together.
  if (c.sound && typeof c.sound === 'object') {
    const d = c.sound; const playing = d.playing !== false;
    const fields = [
      { t: 'info', label: 'state', value: playing ? '▶ playing' : '⏸ paused' },
      { t: 'text', k: 'src', label: 'file', value: d.src ?? '', placeholder: 'eidoverse/assets/… or store/audio/…', hint: 'a library path — never a URL' },
      { t: 'btn', k: 'upload', label: 'upload audio…', client: true, hint: 'MP3, Ogg, WAV, WebM or M4A into the store; the path fills in' },
      { t: 'text', k: 'look', label: 'what is playing', value: d.look ?? '', placeholder: 'what text-tier residents read', hint: `≤${SOUND_LOOK_MAX} chars` },
      { t: 'num', k: 'volume', label: 'volume', value: d.volume ?? 0.8, def: 0.8, step: 0.05, dp: 2, min: 0, max: 1 },
      { t: 'num', k: 'radius', label: 'radius', value: d.radius ?? 12, def: 12, step: 1, dp: 0, min: 1, max: 200, unit: 'm' },
      { t: 'check', k: 'loop', label: 'loop', value: d.loop !== false },
    ];
    const n = normalizeSound(d);
    if (!n.ok) fields.unshift({ t: 'info', label: '', value: `⚠ not heard: ${n.why}` });
    fields.push(playing ? { t: 'btn', k: 'pause', label: 'pause' } : { t: 'btn', k: 'play', label: '▶ play', hint: 'starts it for everyone at the same moment' });
    if (playing) fields.push({ t: 'btn', k: 'play', label: 'restart', hint: 'back to the top, for everyone at once' });
    fields.push({ t: 'btn', k: 'silence', label: 'silence', danger: true });
    groups.push({ group: 'sound', label: 'sound', verb: 'comp', types: ['sound'], fields });
  }

  // every typed group keeps an escape hatch: its component(s) as JSON, collapsed. Its fields
  // don't speak for every key (a path's points, a socket's part, a particle seed/texture), and
  // a key nobody can reach from the panel is a key only a model can edit.
  for (const g of groups) {
    if (!g.types?.length || g.group === 'flags') continue;
    for (const type of g.types) if (c[type] != null) g.fields.push({ t: 'json', k: `json|${type}`, label: g.types.length > 1 ? type : '', value: JSON.stringify(c[type], null, 2), collapsed: true, commit: `comp.${type}`, hint: `the whole ${type} component — a saved edit replaces it wholesale` });
  }

  // every type no group speaks for: raw JSON, the blind fold's UI twin —
  // a type invented this morning is editable today
  const claimed = new Set(['lock', 'guard', 'hidden', 'label', 'sockets', 'particles', 'picture', 'sound', ...mk,
    ...(compLight(ent) ? ['light'] : []), ...(isBag(c.collider) ? ['collider'] : [])]);
  const rest = Object.keys(c).filter((t) => !claimed.has(t));
  const fields = rest.map((type) => ({ t: 'json', k: type, label: type, value: JSON.stringify(c[type], null, 2), hint: 'raw JSON — a saved edit replaces this type\'s data wholesale' }));
  // Add Component (Unity's pattern) for the kinds that need a gesture to begin:
  // a picture needs an image and a part, a sound a file. Both are uploads.
  if (!c.picture && live.parts?.length) fields.push({ t: 'btn', k: 'add:picture', label: '+ picture…', client: true, hint: 'upload an image and hang it on this thing' });
  if (!c.sound && !isLight(ent) && live.parts) fields.push({ t: 'btn', k: 'add:sound', label: '+ sound…', client: true, hint: 'upload audio and put it on this thing (starts paused)' });
  if (!c.sockets && !isLight(ent) && live.parts) fields.push({ t: 'btn', k: 'add:seat', label: '+ seat…', client: true, hint: 'click the spot on the thing where a sitter goes' });
  fields.push({ t: 'text', k: '+', label: '+ component', value: '', placeholder: 'type (recipe, notice…) ⏎', hint: 'attach a component — any type folds, evaluators give known ones behavior' });
  groups.push({ group: 'comp', label: `Components (${rest.length})`, verb: 'comp', fields });

  // guarded by someone else: every authoring field reads as read-only, with the
  // reason. The server refuses these regardless — this says so before the trip.
  if (held) for (const g of groups) for (const f of g.fields) {
    if (f.t === 'info' || f.disabled) continue;
    f.disabled = true; f.hint = `guarded by ${placer ?? 'its placer'}`;
  }
  return { id, groups, sections: componentSections(ent, groups, held, live, id), ...(guarded ? { guard: { placer, held } } : {}) };
}

// ---------------------------------------------------------------- components (B)
// The same fields, presented the way Unity/Godot/Resonite do: one card per
// component instance on the entity (shared/components.js), each naming the
// fields it owns by their unchanged `group.k` address — so editVerbs, the
// agent's `edit` tool and the gizmo keep working — plus what may be added.
// A component today's wire cannot express is listed with the reason, not hidden.
const WIRE_BLOCKED = {
  // a lamp is a Model with a Light component; a light-verb light cannot grow a
  // model in place (spawn would replace it wholesale), and a model is swapped,
  // not added, from the Library (spawn on the same id)
  Model: (have, ent) => isLight(ent) ? 'this light was made with the light verb and cannot take a model — place the model, then add a Light to it' : 'swap the model from the Library',
  Structure: () => 'start a building from Create ▸ Structure',
  Parent: () => 'give it a parent: drag its row onto another in the Hierarchy, or pick one in this card',
};
const MOTION_GROUP = { Pendulum: 1, Spin: 1, Orbit: 1, Bob: 1, Path: 1 };
/** A library path as the inspector header shows it: the file stem, first three words. */
export const libLabel = (lib) => String(lib).split('/').pop().replace(/\.glb$/, '').split('_').slice(0, 3).join(' ');
// A node name a generator made (tripo_part_fused_0, mesh_12, Cube.003, a uuid)
// says nothing to a person; anything else is the modeller's own word.
const MACHINE_PART = [/^(tripo_)?(part|mesh|node|object|geometry|group|primitive|submesh)([_.\- ]?(fused|merged))?[_.\- ]?\d+$/i,
  /^(cube|sphere|cylinder|plane|mesh|object|node|empty)[._]?\d+$/i, /^\d+$/, /^[0-9a-f]{8}-?[0-9a-f]{4}/i];
/** A part's name for a card title: the modeller's word when it is one
 *  ("seat plank"), else its place in the model ("part 2": its index in the
 *  model's named parts when the viewer knows them, else the name's own
 *  trailing number + 1, else its order among this entity's part motions). */
export function partLabel(name, parts = null, ordinal = 1) {
  const n = String(name);
  if (!MACHINE_PART.some((re) => re.test(n))) return n.replace(/[_]+/g, ' ').trim();
  const at = parts?.indexOf(n) ?? -1;
  if (at >= 0) return `part ${at + 1}`;
  const tail = /(\d+)$/.exec(n);
  return `part ${tail ? +tail[1] + 1 : ordinal}`;
}
function componentSections(ent, groups, held, live = {}, id = '?') {
  const { components } = componentsOf(ent);
  const have = new Set(components.map((c) => c.type));
  const g = (name) => groups.find((x) => x.group === name);
  const refs = (group, pred = () => true) => (g(group)?.fields ?? []).filter((f) => f.k != null && pred(f)).map((f) => `${group}.${f.k}`);
  const out = [];
  let partOrdinal = 0;
  for (const inst of components) {
    const rec = RECORDS[inst.type];
    const sec = { type: inst.type, key: inst.key ?? null, title: inst.type, hash: rec.hash, category: rec.category, summary: rec.summary, fields: [], removable: false };
    switch (inst.type) {
      case 'Transform': {
        // the channel box: Translate, Rotate, Scale, the order, and the
        // Quaternion row (fields marked row:'quat', open in quaternion mode)
        const rot = g('rot');
        const isS = (f) => f.k === 'scale' || /^s[xyz]$/.test(f.k);
        sec.fields = [...refs('pos', (f) => !isS(f)), ...refs('rot', (f) => f.row !== 'quat'), ...refs('pos', isS), ...refs('rot', (f) => f.row === 'quat')];
        if (rot) sec.quatOpen = rot.fields.find((f) => f.k === 'order')?.value === QUAT_MODE;
        if (g('pos')?.local) sec.info = [['frame', `local to its parent, ${g('pos').local}`]];
        if (rot?.gimbal) sec.info = [...(sec.info ?? []), ['gimbal lock', 'the middle axis is at ±90°, so the first and last axes turn about the same line — a turn on either shows on the last; the Quaternion row is exact']];
        break;
      }
      case 'Model': sec.info = [['model', String(ent.lib)]]; break;
      // keyed = the component; keyless = the legacy spawn `collide`, which owns
      // the collider group only when no component overrides it
      case 'Collider':
        if (inst.key != null || !isBag(ent.comp?.collider)) sec.fields = refs('collider');
        else sec.info = [['shape', `${String(ent.collide)} (overridden by the collider component)`]];
        sec.removable = inst.key != null;
        break;
      case 'Parent': sec.info = ent.parent?.slot ? [['socket', String(ent.parent.slot)]] : []; sec.fields = refs('parent', (f) => f.k !== 'children'); break;   // children are the Hierarchy's (R, 10-04)   // the Parent card (R, 10-04: a component, named as engines name it)
      case 'Light':
        // keyless = the light-verb light (the light group is its); keyed = the
        // component: the group when it is the entity's light, raw JSON when a
        // hand-written log put one beside a legacy light
        if (inst.key == null || compLight(ent)) sec.fields = refs('light');
        else sec.fields = [`comp.${inst.key}`];
        sec.removable = inst.key != null;
        break;
      case 'Label': case 'Hidden': continue;       // the header's, like Unity's name and active box
      case 'Lock': case 'Guard': sec.fields = refs('flags', (f) => f.k === inst.key); sec.removable = true; break;
      case 'Seats': sec.fields = refs('sockets'); sec.removable = true; break;
      case 'Particles': sec.fields = refs('particles', (f) => f.k !== 'out'); sec.removable = true; break;
      case 'Picture': sec.fields = refs('picture', (f) => f.k !== 'down'); sec.removable = true; break;
      case 'Sound': sec.fields = refs('sound', (f) => f.k !== 'silence'); sec.removable = true; break;
      case 'LookAt': sec.fields = refs('look'); sec.removable = true; break;
      case 'Pivot': sec.fields = refs('pivot'); sec.removable = true; break;
      default:
        if (MOTION_GROUP[inst.type]) {
          const part = inst.key === 'motion' ? (inst.params.part ?? null) : inst.key.slice(7);
          if (part) { sec.title = `${inst.type} · ${partLabel(part, live.parts, ++partOrdinal)}`; sec.part = part; }
          // the type is the card, not a field: changing it is remove + add
          const own = (f) => (inst.key === 'motion' ? !f.k.includes('|') : f.k.startsWith(`${inst.key.slice(7)}|`));
          sec.fields = refs('motion', (f) => own(f) && !/(^|\|)(type|rest)$/.test(f.k));
          sec.removable = true;
        } else {
          sec.fields = [`comp.${inst.key}`];         // the raw-JSON floor (Annotation, Structure, Reactions, Captions, Stage)
          sec.removable = inst.type !== 'Captions';
          if (inst.type === 'Annotation') sec.title = inst.key;
        }
    }
    if (held) sec.removable = false;
    out.push(sec);
  }
  // a root still shows its Parent card, empty: picking a parent there is the no-drag path (a headset, a trackpad), and
  // Resonite shows Parent on every slot. present:false paints it quietly (· none), like the world's default cards.
  if (!have.has('Parent') && g('parent')) {
    const rec = RECORDS.Parent;
    out.push({ type: 'Parent', key: null, title: 'Parent', hash: rec.hash, category: rec.category, summary: rec.summary, fields: refs('parent', (f) => f.k === 'to'), removable: false, present: false });
  }
  // needs (design §3): an entry whose need has one sensible default says what
  // it brings; one that needs a choice says it will ask; one whose need cannot
  // be met in place (a Model: placed from the Library) is blocked, saying why
  const add = addable(components, { unmet: true, met: (n) => needMet(n, ent) }).filter((a) => a.name !== 'Label' && a.name !== 'Hidden')
    .map((a) => {
      const plan = a.unmet ? planNeeds(ent, id, a.name) : null;
      const needsWhy = plan?.choice && !plan.choice.options.length ? plan.choice.prompt : null;
      const blocked = (a.name === 'Guard' && live.mayAuthor === false ? 'only its placer or the world\'s owner can guard it' : null) ?? needsWhy ?? WIRE_BLOCKED[a.name]?.(have, ent) ?? null;
      return { ...a, blocked, ...(plan?.brings ? { brings: plan.brings } : {}), ...(plan?.choice?.options.length ? { asks: plan.choice.need } : {}) };
    });
  for (const name of ['Model', 'Structure', 'Parent']) if (!have.has(name) && !add.some((a) => a.name === name) && WIRE_BLOCKED[name])
    add.push({ name, category: RECORDS[name].category, summary: RECORDS[name].summary, hash: RECORDS[name].hash, blocked: WIRE_BLOCKED[name](have, ent) });
  // the header's `lib` line reads the Model component (design §5), so it can
  // never disagree with the Model card; an Empty and a light say what they are
  const model = components.find((c) => c.type === 'Model')?.params.lib;
  const lib = model != null ? String(model) : null;
  // parenting lives on the Parent card (R, 10-04), not the header
  return { header: refs('flags', (f) => f.k === 'label' || f.k === 'hidden'), list: out, add: held ? [] : add,
    lib, libLabel: lib != null ? libLabel(lib) : isLight(ent) ? 'light' : 'empty' };
}

// ---------------------------------------------------------------- needs
// What each need means on THIS entity, and how it is met when it is not
// (design §3). A need with one sensible default is added for you, as real
// verbs, in the same undo step; a need that requires a choice returns a
// `choice` the panel renders as a prompt (and an agent reads), resolved by
// adding again with one of its option values. A choice with no options is a
// need that cannot be met in place — it reads as a refusal that says why.
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const NEEDS = {
  // a model is placed from the Library (spawn on the id would replace this
  // entity wholesale: its components, its placer, its born)
  Model: {
    met: (ent) => ent?.lib != null && !isLight(ent),
    plan: (ent, id, name) => ({ choice: { need: 'Model', options: [],
      prompt: `${article(name)} ${name.toLowerCase()} needs a model to act on (${id} has none) — place a model from the Library and add the ${name} to it, or put ${id} under one` } }),
  },
  // reactions push the WHOLE entity's pendulum (server/reactions.ts): a part's
  // pendulum does not count, and a whole-entity spin is in the way
  Pendulum: {
    met: (ent) => ent?.comp?.motion?.type === 'pendulum',
    plan: (ent, id, name) => {
      const m = ent?.comp?.motion;
      const verbs = [{ verb: 'motion', args: { id, type: 'pendulum', amp: 0, period: 3.5 } }];
      if (!m) return { verbs, brings: 'a Pendulum at rest, for it to push' };
      return { choice: { need: 'Pendulum', prompt: `${name} pushes a pendulum, and ${id} already moves as a whole (${m.type ?? 'a motion'}) — replace that with a Pendulum?`,
        options: [{ v: 'replace', label: `replace its ${m.type ?? 'motion'} with a Pendulum`, verbs }] } };
    },
  },
};
/** Is `need` met on this entity? The NEEDS table's reading, else a component of that type. */
export function needMet(need, ent) {
  return NEEDS[need] ? NEEDS[need].met(ent) : componentsOf(ent).components.some((c) => c.type === need);
}
/** Plan the needs of adding `name`: { verbs } to prepend, `brings` (what is
 *  added for you), or a `choice` (unresolved). `value` resolves a choice when
 *  it names one of its options ("replace", or {choose: "replace"}). */
export function planNeeds(ent, id, name, value) {
  const verbs = []; const brings = [];
  const pick = typeof value === 'string' ? value : value?.choose;
  for (const need of RECORDS[name]?.needs ?? []) {
    if (needMet(need, ent)) continue;
    const p = NEEDS[need]?.plan(ent, id, name) ?? { choice: { need, options: [], prompt: `${article(name)} ${name} needs ${article(need)} ${need} first` } };
    if (p.choice) {
      const opt = p.choice.options.find((o) => o.v === pick);
      if (!opt) return { verbs: [], choice: { component: name, ...p.choice, options: p.choice.options.map(({ v, label }) => ({ v, label })) } };
      verbs.push(...opt.verbs); brings.push(opt.label);
      continue;
    }
    verbs.push(...p.verbs); brings.push(p.brings);
  }
  return { verbs, ...(brings.length ? { brings: brings.join('; ') } : {}) };
}

/** What adding a component writes, in today's verbs, needs included (one
 *  call = one undo step on every surface). `value` is the part name for a
 *  part motion, the type name for an Annotation, or a need's choice. Returns
 *  { verbs, errors, choice? } — a `choice` sends nothing and asks. */
export function addVerbs(ent, id, name, value) {
  const np = planNeeds(ent, id, name, value);
  if (np.choice) return { verbs: [], errors: np.choice.options.length ? [] : [np.choice.prompt], choice: np.choice };
  const own = addOwnVerbs(ent, id, name, np.verbs.length ? undefined : value);
  if (own.errors.length) return own;
  return { verbs: [...np.verbs, ...own.verbs], errors: [], ...(np.brings ? { brings: np.brings } : {}) };
}
function addOwnVerbs(ent, id, name, value) {
  const c = ent?.comp ?? {};
  const motion = { Pendulum: { type: 'pendulum', amp: 0.26, period: 3.5 }, Spin: { type: 'spin', degPerSec: 36 }, Orbit: { type: 'orbit', radius: 1, degPerSec: 12 }, Bob: { type: 'bob', amp: 0.3, period: 4 }, Path: { type: 'path', points: [[0, 0, 0], [0, 0, 2]], speed: 1 } };
  if (motion[name]) {
    const part = typeof value === 'string' && value.trim() ? value.trim() : null;
    if (part) { const key = `motion:${part}`; if (c[key]) return { verbs: [], errors: [`${id} already has a motion on ${part}`] }; return { verbs: [{ verb: 'comp', args: { id, type: key, data: motion[name] } }], errors: [] }; }
    if (c.motion) return { verbs: [], errors: [`${id} already moves as a whole (${c.motion.type}) — remove it first, or add this one to a part`] };
    return { verbs: [{ verb: 'motion', args: { id, ...motion[name] } }], errors: [] };
  }
  const simple = { Pivot: ['pivot', { pos: Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : [0, 0, 0] }], Lock: ['lock', true], Guard: ['guard', true], Hidden: ['hidden', true], Label: ['label', typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'unnamed'],
    Particles: ['particles', { preset: typeof value === 'string' && value ? value : 'fire' }], LookAt: ['look', {}], Reactions: ['reactions', { push: { impulse: 0.35 } }], Stage: ['stage', {}] };
  if (simple[name]) { const [type, data] = simple[name]; if (c[type] != null) return { verbs: [], errors: [`${id} already has ${name}`] }; return { verbs: [{ verb: 'comp', args: { id, type, data } }], errors: [] }; }
  // write-new-on-edit: a Light added here is a component, never the light verb,
  // and it is written with its fields spelled out — the log records the result,
  // so a later change of the engine's defaults cannot change this lamp
  if (name === 'Light') {
    if (isLight(ent)) return { verbs: [], errors: [`${id} is already a light (made with the light verb)`] };
    if (c.light != null) return { verbs: [], errors: [`${id} already has a light`] };
    return { verbs: [{ verb: 'comp', args: { id, type: 'light', data: { ...LIGHT_DEFAULTS } } }], errors: [] };
  }
  if (name === 'Collider') {
    if (ent?.lib == null || isLight(ent)) return { verbs: [], errors: [`a collider needs a model to collide as (${id} has none)`] };
    if (c.collider != null) return { verbs: [], errors: [`${id} already has a collider`] };
    const shape = value === 'box' ? 'box' : value == null || value === '' || value === 'exact' ? 'exact' : null;
    if (!shape) return { verbs: [], errors: ['a collider shape is "exact" or "box"'] };
    return { verbs: [{ verb: 'comp', args: { id, type: 'collider', data: { shape } } }], errors: [] };
  }
  if (name === 'Annotation') { const type = String(value ?? '').trim(); if (!type) return { verbs: [], errors: ['an annotation needs a type name'] }; if (c[type] != null) return { verbs: [], errors: [`${id} already has ${type}`] }; return { verbs: [{ verb: 'comp', args: { id, type, data: {} } }], errors: [] }; }
  return { verbs: [], errors: [`${name}: added by a gesture, not a value (${WIRE_BLOCKED[name]?.(new Set()) ?? 'see its card'})`] };
}

/** What removing one component instance writes. When another component
 *  needs it (design §3) nothing is sent: the result names the dependants in a
 *  `confirm`, and removing again with value "both" removes them too, in the
 *  same step. */
export function removeVerbs(ent, id, key, value) {
  const c = ent?.comp ?? {};
  if (c[key] != null) {
    const after = { ...ent, comp: Object.fromEntries(Object.entries(c).filter(([k]) => k !== key)) };
    const deps = componentsOf(ent).components.filter((inst) => inst.key != null && inst.key !== key
      && (RECORDS[inst.type]?.needs ?? []).some((n) => needMet(n, ent) && !needMet(n, after)));
    if (deps.length) {
      const what = componentsOf(ent).components.find((inst) => inst.key === key)?.type ?? key;
      if (value !== 'both') return { verbs: [], errors: [], confirm: { key, type: what, dependants: deps.map((d) => ({ type: d.type, key: d.key })),
        prompt: `${deps.map((d) => d.type).join(' and ')} need${deps.length > 1 ? '' : 's'} this ${what} — remove ${deps.length > 1 ? 'them' : 'both'}?`, both: 'both' } };
      const verbs = [];
      for (const d of deps) { const r = removeOwnVerbs(ent, id, d.key); if (r.errors.length) return r; verbs.push(...r.verbs); }
      const own = removeOwnVerbs(ent, id, key);
      return own.errors.length ? own : { verbs: [...verbs, ...own.verbs], errors: [] };
    }
  }
  return removeOwnVerbs(ent, id, key);
}
function removeOwnVerbs(ent, id, key) {
  const c = ent?.comp ?? {};
  if (key === 'motion' && c.motion) return { verbs: [{ verb: 'motion', args: { id, type: null } }], errors: [] };
  if (key === 'captions') return { verbs: [], errors: ['captions are written by the caption verb only'] };
  if (c[key] != null) return { verbs: [{ verb: 'comp', args: { id, type: key, data: null } }], errors: [] };
  return { verbs: [], errors: [`${id} has no component at ${key}`] };
}

/** What a viewport gesture (the gizmo) commits, as edits for editVerbs: the
 *  realized object's pose → the fields this thing HAS. mode 'move' sends the
 *  position, 'scale' the scale, 'rotate' the orientation: a full q
 *  (rot.qx…qw, normalized by editVerbs) — except a pure turn about +Y on a
 *  yaw-only thing, which stays a heading (pos.yaw, degrees) so its history
 *  keeps its bytes. */
export function poseEdits(ent, id, mode, { pos, q, scale } = {}, live = {}) {
  const sc = inspectSchema(ent, id, live);
  const out = {};
  if (mode === 'move' && pos) ['x', 'y', 'z'].forEach((k, i) => { if (fieldAt(sc, `pos.${k}`)) out[`pos.${k}`] = +(+pos[i]).toFixed(3); });
  if (mode === 'scale' && scale != null && fieldAt(sc, 'pos.sx')) scale3(scale).forEach((v, i) => { out[`pos.s${'xyz'[i]}`] = +(+v).toFixed(3); });
  else if (mode === 'scale' && scale != null && fieldAt(sc, 'pos.scale')) out['pos.scale'] = +(+scale3(scale)[1]).toFixed(3);
  if (mode === 'rotate' && q && fieldAt(sc, 'rot.qw')) {
    const n = qNorm(q);
    if (n && !ent.q && Math.abs(n[0]) < 1e-9 && Math.abs(n[2]) < 1e-9) out['pos.yaw'] = qHeading(n) * R2D;
    else if (n) ['x', 'y', 'z', 'w'].forEach((a, i) => { out[`rot.q${a}`] = n[i]; });
  }
  return out;
}

/** The channel box: every num in the schema, flat, with dotted addresses. */
export function channels(schema) {
  const out = [];
  for (const g of schema.groups) for (const f of g.fields) if (f.t === 'num') out.push({ ...f, key: `${g.group}.${f.k}`, group: g.group });
  return out;
}

// ---------------------------------------------------------------- edits → verbs

/** Look a field up by dotted address. */
export function fieldAt(schema, key) {
  const dot = key.indexOf('.');
  if (dot < 0) return null;
  const g = schema.groups.find((x) => x.group === key.slice(0, dot));
  return g ? (g.fields.find((f) => f.k === key.slice(dot + 1)) ?? null) : null;
}

/** Turn edits into the fewest verbs that commit them. Numbers may be
 *  relative expressions; a field's hard min/max clamp; disabled fields
 *  refuse. Pure: never sends, never mutates `ent`. */
export function editVerbs(ent, id, edits, live = {}) {
  const schema = inspectSchema(ent, id, live);
  const errors = [];
  const verbs = [];
  const c = ent?.comp ?? {};
  let place = null;                 // coalesced full pose
  // a child's channels are LOCAL to its parent (inspectSchema): the pose they
  // edit is the mount's, and a translate/rotate on it is written as a mount
  const L = localOf(ent, live.world ?? null);
  const pv = L.mounted ? { ...ent, pos: L.pos, q: L.q ?? undefined, yaw: L.yaw } : ent;
  let moved = false;                // a translate/rotate/heading edit (vs. scale alone)
  let parented = null;              // a parent edit's { verbs, inverses }
  // the place every transform edit coalesces into, carrying the full pose: a
  // thing with q keeps its q (a move is not a turn), a yaw-only thing its yaw
  const basePlace = () => (place ??= { id, pos: [...(pv.pos ?? [0, 0, 0])],
    ...(isLight(ent) ? {} : { ...(pv.q ? { q: [...pv.q] } : {}), yaw: pv.yaw ?? 0, scale: entScale(ent) ?? 1 }) });
  const rotSet = {};                // axis index → radians (the Rotate channels)
  const quatSet = {};               // component index → value (the Quaternion row)
  let headingSet = false;
  let euler = null;                 // the triple a Rotate edit composed: the viewer's next hint
  const asks = [];                  // needs (design §3): a choice to make, or a remove-both to confirm
  let light = null;                 // coalesced partial light
  const comps = new Map();          // type → next data (null = remove)
  const motions = new Map();        // key → next params (null = rest)
  const flagsComp = (type, data) => comps.set(type, data);
  // picture/sound: raw bags accumulate across this call's edits and are
  // validated ONCE at the end, so {src, part} can create a picture together
  const bags = new Map();            // type → raw next bag (null = remove)
  const bag = (type, fresh) => { if (!bags.has(type)) bags.set(type, c[type] && typeof c[type] === 'object' ? { ...c[type] } : fresh()); return bags.get(type); };

  const num = (f, v) => {
    const cur = +f.value;
    let n = parseEntry(f.deg && typeof v === 'string' ? v : v, f.deg ? cur * R2D : cur);
    if (n == null) { errors.push(`${f.label ?? f.k}: not a number (${JSON.stringify(v)})`); return null; }
    if (f.deg) n = n / R2D;
    n = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
    return n;
  };
  const bool = (v) => (typeof v === 'string' ? !/^(false|0|no|off)$/i.test(v) : !!v);

  for (const [key, raw] of Object.entries(edits ?? {})) {
    const f = fieldAt(schema, key);
    const dot = key.indexOf('.'); const group = key.slice(0, dot); const k = key.slice(dot + 1);
    // components (B): add.<Component> = value is a part name / annotation type; remove.<comp key>
    if (group === 'add' || group === 'remove') {
      if (schema.guard?.held) { errors.push(`${key}: guarded by ${schema.guard.placer ?? 'its placer'}`); continue; }
      const r = group === 'add' ? addVerbs(ent, id, k, raw) : removeVerbs(ent, id, k, raw);
      errors.push(...r.errors); verbs.push(...r.verbs);
      if (r.choice) asks.push({ kind: 'choice', ...r.choice, key });
      if (r.confirm) asks.push({ kind: 'confirm', ...r.confirm, comp: r.confirm.key, key });   // key = the address to answer on
      continue;
    }
    // actions and creations that have no field row: comp.<any>, sockets.del,
    // a socket slot that does not exist yet (sockets.<new>|pos|1 declares it)
    const known = f || group === 'parent' || (group === 'comp' && k) || (group === 'sockets' && (k === 'del' || k.includes('|')))
      || ((group === 'picture' || group === 'sound') && !['upload'].includes(k));   // creation needs no row
    if (!known) { errors.push(`${key}: no such field on ${id}`); continue; }
    if (f?.disabled) { errors.push(`${key}: ${f.hint ?? 'read-only'}`); continue; }
    if (f?.client) { errors.push(`${key}: a viewport gesture, not a value — set the fields it would have set`); continue; }
    switch (group) {
      case 'pos': {
        basePlace();
        const n = num(f, raw); if (n == null) break;
        // a bare heading: the fold turns the thing about +Y keeping its tilt
        // (PROTOCOL §9.1) — so it must travel WITHOUT q, which would win
        if (k === 'yaw') { place.yaw = round(n, 4); delete place.q; headingSet = true; moved = true; }
        else if (k === 'scale') place.scale = round(n);
        else if (k === 'sx' || k === 'sy' || k === 'sz') { const v = [...scale3(place.scale)]; v['xyz'.indexOf(k[1])] = round(n); place.scale = scaleWire(v); }
        else { place.pos['xyz'.indexOf(k)] = round(n); moved = true; }
        break;
      }
      case 'parent': {
        // design §3: parent it (or make it a root) where it stands — the same
        // edit the Hierarchy's drag commits (shared/hierarchy.js parentVerbs)
        if (k !== 'to' && k !== 'unparent') { errors.push(`${key}: no such field`); break; }
        if (!live.world) { errors.push(`${key}: parenting needs the world's records (live.world)`); break; }
        if (parented) { errors.push(`${key}: one parent edit at a time`); break; }
        const r = parentVerbs(live.world, id, k === 'unparent' ? null : raw, { mayAuthor: live.mayAuthorOf, doorLocks: live.doorLocks });
        errors.push(...r.errors);
        if (!r.errors.length) parented = r;
        break;
      }
      case 'rot': {
        if (k === 'order') {
          if (!ROT_MODES.includes(raw)) { errors.push(`rot.order: one of ${ROT_MODES.join(' ')}`); break; }
          // only how the channels read: never a place, never q. XYZ is the
          // absence of the comp (nothing writes XYZ)
          if (raw !== rotOrderOf(ent)) comps.set('rotOrder', raw === 'XYZ' ? null : raw);
          break;
        }
        const n = num(f, raw); if (n == null) break;
        if (k.startsWith('q')) quatSet['xyzw'.indexOf(k[1])] = n;
        else rotSet['xyz'.indexOf(k)] = n;
        moved = true;
        break;
      }
      case 'flags': {
        if (k === 'lock') flagsComp('lock', bool(raw) ? true : null);
        else if (k === 'guard') flagsComp('guard', bool(raw) ? true : null);
        else if (k === 'hidden') flagsComp('hidden', bool(raw) ? true : null);
        else if (k === 'label') { const s = String(raw ?? '').trim(); flagsComp('label', s ? s.slice(0, 80) : null); }
        break;
      }
      case 'light': {
        if (!isLight(ent)) {
          // the light component: merge into its bag, keep/day stored only in
          // their non-default state (as the light verb's fold stores them),
          // validated once at the end like picture/sound
          const b = bag('light', () => ({}));
          if (f.t === 'num') { const n = num(f, raw); if (n == null) break; b[k] = n; }
          else if (k === 'color') b.color = typeof raw === 'string' ? parseInt(raw.replace(/^#|^0x/, ''), 16) : raw;
          else if (k === 'keep') { if (bool(raw)) b.keep = true; else delete b.keep; }
          else if (k === 'noon') { if (bool(raw)) b.day = false; else delete b.day; }
          break;
        }
        light ??= { id };
        if (f.t === 'num') { const n = num(f, raw); if (n == null) break; light[k] = n; }
        else if (k === 'color') light.color = typeof raw === 'string' ? parseInt(raw.replace(/^#|^0x/, ''), 16) : raw;
        else if (k === 'keep') light.keep = bool(raw);
        else if (k === 'noon') light.day = !bool(raw);
        break;
      }
      case 'motion': {
        const bar = k.indexOf('|');
        const mkey = bar < 0 ? 'motion' : `motion:${k.slice(0, bar)}`;
        const param = bar < 0 ? k : k.slice(bar + 1);
        const prev = c[mkey]; if (!prev) { errors.push(`${key}: no ${mkey} on ${id}`); break; }
        if (param === 'rest') { motions.set(mkey, null); break; }
        const next = motions.get(mkey) ?? { ...prev };
        if (param === 'axis') { if (raw === 'custom') break; if (!AXES[String(raw).toLowerCase()]) { errors.push(`${key}: axis must be one of ${Object.keys(AXES).join(' ')}`); break; } next.axis = String(raw).toLowerCase(); }
        else if (param === 'type') {
          if (!MOTION_TYPES.includes(raw)) { errors.push(`${key}: type must be one of ${MOTION_TYPES.join(' ')}`); break; }
          // a type change keeps only what carries across (the evaluator would
          // ignore a spin's amp, and the server lints every leftover); t0 stays
          // so the change is not also a phase jump
          for (const p of Object.keys(next)) if (!['type', 'axis', 'pivot', 'phase', 't0', 'part'].includes(p)) delete next[p];
          next.type = raw;
        }
        else if (param === 'loop') next.loop = raw;
        else if (f.t === 'check') next[param] = bool(raw);
        else { const n = num(f, raw); if (n == null) break; next[param] = round(n, 4); if (param === 'degPerSec') delete next.rpm; if (param === 'amp') delete next.amplitude; }
        motions.set(mkey, next);
        break;
      }
      case 'sockets': {
        const next = comps.get('sockets') ?? JSON.parse(JSON.stringify(c.sockets ?? {}));
        if (k === 'del' && !next[raw]) { errors.push(`sockets.del: no slot ${JSON.stringify(raw)} on ${id}`); break; }
        if (k === 'del') { delete next[raw]; comps.set('sockets', Object.keys(next).length ? next : null); break; }
        const [slot, what, idx] = k.split('|');
        const cur = next[slot] ?? (next[slot] = { pos: [0, 0.5, 0], yaw: 0 });
        const n = num(f ?? { value: what === 'yaw' ? cur.yaw ?? 0 : (cur.pos ?? [0, 0.5, 0])[+idx] ?? 0, deg: what === 'yaw', k }, raw); if (n == null) break;
        if (what === 'pos') { cur.pos = [...(cur.pos ?? [0, 0.5, 0])]; cur.pos[+idx] = round(n); } else cur.yaw = round(n, 4);
        comps.set('sockets', next);
        break;
      }
      case 'particles': {
        if (k === 'out') { comps.set('particles', null); break; }
        const next = comps.get('particles') ?? { ...c.particles };
        if (k.startsWith('origin|')) { const n = num(f, raw); if (n == null) break; next.origin = [...(next.origin ?? [0, 0, 0])]; next.origin[+k.slice(7)] = round(n); }
        else if (f.t === 'num') { const n = num(f, raw); if (n == null) break; next[k] = round(n); }
        else next[k] = raw;
        comps.set('particles', next);
        break;
      }
      case 'picture': {
        if (k === 'down') { bags.set('picture', null); break; }
        const b = bag('picture', () => (live.parts?.length ? { part: live.parts[0] } : {})); if (!b) { errors.push('picture: taken down in this same edit'); break; }
        if (!['part', 'src', 'look', 'lit', 'flip'].includes(k)) { errors.push(`${key}: no such field`); break; }
        if (k === 'flip') b.flip = bool(raw);
        else { const v = String(raw ?? '').trim(); if (v) b[k] = v; else if (k === 'look') delete b.look; else b[k] = v; }
        break;
      }
      case 'sound': {
        if (k === 'silence') { bags.set('sound', null); break; }
        const b = bag('sound', () => ({ playing: false, loop: true, volume: 0.8, radius: 12 })); if (!b) { errors.push('sound: silenced in this same edit'); break; }
        if (k === 'play') { b.playing = true; b.t0 = live.now ?? Date.now(); }
        else if (k === 'pause') { b.playing = false; delete b.t0; }
        else if (k === 'loop') b.loop = bool(raw);
        else if (k === 'volume' || k === 'radius') { const n = num(f ?? { value: b[k] ?? (k === 'volume' ? 0.8 : 12), min: k === 'volume' ? 0 : 1, max: k === 'volume' ? 1 : 200 }, raw); if (n == null) break; b[k] = round(n); }
        else if (k === 'src' || k === 'look') { const v = String(raw ?? '').trim(); if (v) b[k] = v; else if (k === 'look') delete b.look; else b[k] = v; }
        else errors.push(`${key}: no such field`);
        break;
      }
      case 'collider': {
        if (k !== 'shape') { errors.push(`${key}: no such field`); break; }
        const why = compRefusal('collider', { shape: raw });
        if (why) { errors.push(`collider: ${why}`); break; }
        comps.set('collider', { ...(isBag(c.collider) ? c.collider : {}), shape: raw });
        break;
      }
      case 'pivot': {
        const cur = [...((comps.get('pivot') ?? c.pivot)?.pos ?? [0, 0, 0])];
        const box = live.box;
        if (k === 'reset') { comps.set('pivot', null); break; }
        if (k === 'centre' || k === 'base') {
          if (!box) { errors.push(`${key}: its model hasn't been measured yet`); break; }
          const mid = [0, 1, 2].map((i) => round((box[0][i] + box[1][i]) / 2, 4));
          comps.set('pivot', { pos: k === 'base' ? [mid[0], round(box[0][1], 4), mid[2]] : mid }); break;
        }
        const n = num(f, raw); if (n == null) break;
        cur['xyz'.indexOf(k)] = round(n, 4); comps.set('pivot', { pos: cur }); break;
      }
      case 'look': {
        // the ref field commits the target id, or null to clear it. The whole
        // `look` comp goes away when its only field is cleared.
        if (k === 'target') {
          const next = comps.get('look') ?? { ...c.look };
          if (raw == null || raw === '') { delete next.target; }
          else { next.target = String(raw); }
          comps.set('look', Object.keys(next).length ? next : null);
        }
        break;
      }
      case 'comp': {
        if (k === '+') { const type = String(raw ?? '').trim(); if (!type) break; if (c[type] != null) { errors.push(`${id} already has ${type}`); break; } comps.set(type, {}); break; }
        if (raw == null || raw === '') { comps.set(k, null); break; }
        let data = raw;
        if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch (e) { errors.push(`comp.${k}: not valid JSON (${e.message})`); break; } }
        // the JSON door is not a way around the evaluators' rules — nor the door's
        if ((k === 'light' || k === 'collider') && compRefusal(k, data, ent)) { errors.push(`comp.${k}: ${compRefusal(k, data, ent)}`); break; }
        if ((k === 'picture' || k === 'sound') && data != null) {
          const n = k === 'picture' ? normalizePicture(data) : normalizeSound(data);
          if (!n.ok) { errors.push(`${k}: ${n.why}`); break; }
          data = k === 'picture' ? n.picture : n.sound;
        }
        comps.set(k, data);
        break;
      }
      default: errors.push(`${key}: no such group`);
    }
  }
  // Rotate / Quaternion edits compose into ONE q on the coalesced place
  // (design §5): read q in the entity's order, set the typed channels, recompose.
  if (Object.keys(quatSet).length || Object.keys(rotSet).length) {
    basePlace();
    const q0 = pv.q ?? qFromYaw(pv.yaw ?? 0);
    const order = rotOrderOf(ent);
    if (Object.keys(quatSet).length) {
      const qn = qNorm(q0.map((v, i) => (quatSet[i] ?? v)));
      if (!qn) { errors.push('rot: a quaternion of zero length is no orientation'); place = null; }   // the pose is one verb: refused whole
      else { place.q = qn; place.yaw = qHeading(qn); }
    } else if (!pv.q && !headingSet) {
      // a yaw-only thing reads (0, yaw, 0) in every order; while the edit keeps
      // it that way it stays yaw-only, so untouched history keeps its bytes
      const e = [0, pv.yaw ?? 0, 0];
      for (const [i, v] of Object.entries(rotSet)) e[+i] = v;
      if (e[0] === 0 && e[2] === 0) place.yaw = round(e[1], 4);
      else { const q = qFromEuler(e, order); place.q = q; place.yaw = qHeading(q); euler = { order, e, q }; }
    } else {
      const { e } = eulerFromQ(place.q ?? q0, order, live.euler ?? uprightHint(pv));
      for (const [i, v] of Object.entries(rotSet)) e[+i] = v;
      const q = qFromEuler(e, order);
      place.q = q; place.yaw = qHeading(q); euler = { order, e, q };
    }
  }
  for (const [type, b] of bags) {
    if (b === null) { comps.set(type, null); continue; }
    if (type === 'light') { const why = compRefusal('light', b, ent); if (why) errors.push(`light: ${why}`); else comps.set('light', b); continue; }
    const n = type === 'picture' ? normalizePicture(b) : normalizeSound(b);
    if (!n.ok) { errors.push(`${type}: ${n.why}`); continue; }   // the rule, before any round-trip
    comps.set(type, type === 'picture' ? n.picture : n.sound);
  }
  if (parented && place) { errors.push('parent: a parent edit goes alone — move it before or after, not in the same edit'); place = null; parented = null; }
  if (parented) verbs.push(...parented.verbs);
  if (place && L.mounted) {
    // a child: translate/rotate → ONE mount carrying the new local pose (the
    // same carrier and slot); scale → a place carrying only scale (the mount
    // has no scale, and a place's pos would be read as the fold's absolute)
    if (moved) {
      // a bare heading on a tilted child turns it about the parent's up keeping
      // its tilt — exactly place's rule; the mount stores the result as q
      let q = place.q ? qNorm(place.q) : null;
      if (headingSet && !q && pv.q) q = qWithHeading(pv.q, place.yaw);
      const turn = isLight(ent) ? { ...(ent.parent.q ? { q: ent.parent.q } : {}), ...(ent.parent.yaw != null ? { yaw: ent.parent.yaw } : {}) }   // a light has no orientation to edit: keep the mount's
        : q && !(Math.abs(q[0]) < 1e-12 && Math.abs(q[2]) < 1e-12) ? { q, yaw: qHeading(q) } : { yaw: round(q ? qHeading(q) : place.yaw, 6) };
      const rel = { id, to: ent.parent.to, ...(ent.parent.slot ? { slot: ent.parent.slot } : {}), offset: place.pos.map((v) => round(v, 4)), ...turn };
      verbs.push({ verb: 'mount', args: rel });
    }
    if (!isLight(ent) && JSON.stringify(place.scale) !== JSON.stringify(entScale(ent) ?? 1)) verbs.push({ verb: 'place', args: { id, scale: place.scale } });
    place = null;
  }
  if (place) verbs.push({ verb: 'place', args: place });
  if (light) verbs.push({ verb: 'light', args: light });
  for (const [mkey, next] of motions) {
    if (mkey === 'motion') verbs.push({ verb: 'motion', args: next ? { id, ...next } : { id, type: null } });
    else verbs.push({ verb: 'comp', args: { id, type: mkey, data: next } });
  }
  for (const [type, data] of comps) verbs.push({ verb: 'comp', args: { id, type, data } });
  return { verbs, errors, ...(euler ? { euler } : {}), ...(asks.length ? { asks } : {}), ...(parented ? { inverses: parented.inverses } : {}) };
}

/** A one-screen text rendering of the schema — what a model reads. */
export function describeSchema(schema, { verbsHint = true } = {}) {
  const L = [];
  for (const g of schema.groups) {
    if (!g.fields.length) continue;
    L.push(`${g.label ?? g.group} (${g.group}.* → ${g.verb})`);
    for (const f of g.fields) {
      if (f.t === 'btn' || f.t === 'list' || (f.t === 'json' && f.commit)) continue;
      if (f.t === 'info') { if (f.value) L.push(`  ${f.label ? `${f.label}: ` : ''}${f.value}`); continue; }
      const val = f.t === 'num' ? (f.deg ? `${Math.round(f.value * R2D)}°` : `${+(+f.value).toFixed(f.dp ?? 2)}${f.unit ? ' ' + f.unit : ''}`)
        : f.t === 'color' ? '0x' + (f.value ?? 0).toString(16).padStart(6, '0')
        : f.t === 'enum' ? `${f.value}  [${f.options.map((o) => o.v).join('|')}]`
        : f.t === 'check' ? (f.value ? 'yes' : 'no')
        : f.t === 'text' ? (f.value === '' ? '—' : String(f.value).slice(0, 120))
        : f.t === 'json' ? String(f.value).replace(/\s+/g, ' ').slice(0, 120)
        : f.t === 'ref' ? (f.value == null ? '— (none)' : String(f.value)) : String(f.value);
      const lim = f.t === 'num' && (f.min != null || f.max != null || f.softMax != null) ? `  (${f.min ?? ''}…${f.max ?? f.softMax ?? ''}${f.max == null && f.softMax != null ? ' soft' : ''})` : '';
      const ro = f.disabled ? '  [read-only: ' + (f.hint ?? '') + ']' : f.driven ? `  [rest pose — driven by ${f.driven}]` : '';
      L.push(`  ${g.group}.${f.k} = ${val}${lim}${ro}`);
    }
    for (const f of g.fields) if (f.t === 'btn' && !f.client) L.push(`  ${g.group}.${f.k}: action — "${f.label}" (edit with any value)`);
  }
  if (verbsHint) L.push(`edit {id, set: {"pos.x": "+=1", "light.intensity": 24, "flags.lock": true, "comp.recipe": "{...}"}} — relative math (+= -= *= /= and %) works on every number.`);
  return L.join('\n');
}
