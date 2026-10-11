// editschema — what can be edited on a thing, and how, as a PURE FUNCTION of
// its folded record. Dependency-free, shared verbatim by three surfaces:
//
//   desktop inspector   client/lib/editpanels.js renders the fields (panels.js)
//   VR quad             the same fields painted to a canvas (xrpanels.js)
//   models              mcpl `inspect` prints them, `edit` commits them
//
// This is the parity law made structural: anything a human can click, a
// model can say — because both read ONE declaration and both commit through
// editOps(). The fold (shared/fold.js) is the source of every value here;
// a client with a realized object may layer live extras on top (is the light
// actually casting) but never a different truth.
//
// inspectSchema(ent, id)          → { groups: [{ group, verb, fields }] }
//   fields are panels.js specs: { t, k, label, value, def?, … } with k a plain name (def: the
//   value the evaluator uses when the key is absent — the inspector offers ↺ back to it)
//   inside the group. Address a field from outside as "<group>.<k>"
//   (pos.x · light.intensity · motion.amp · sockets.seat.yaw · comp.recipe).
// editOps(ent, id, edits)       → { ops: [{verb, args}], errors: [] }
//   edits: { "<group>.<k>": value } — a number, a boolean, a string, or a
//   relative expression ("+=2", "*=-1", "-=10%") against the current value.
//   Edits that share a verb coalesce: three transform channels are ONE place
//   carrying the full pose; two socket fields are ONE merged comp.

// the held poses a socket can give a person (the posture clips every body has)
// a socket's rotation as [pitch, heading, roll]: q = qY(heading)·qX(pitch)·qZ(roll), the tilt in the turned frame (Maya order ZXY = three.js 'YXZ'), radians
const sockRot = (s) => eulerFromQ(socketQ(s), 'ZXY').e;
// the postures every body has, and the library's other seated clips (any library clip name works; these are offered)
const SOCKET_POSES = ['sitchair', 'sit', 'lie', 'idle', 'sitting_nervous_arm_rub_chair'];
import * as OP from './protocol/requests.js';
import { normalizePicture, PICTURE_LIT, PICTURE_ALT_MAX, ALT_HINT } from './picture.js';
import { normalizeSound, SOUND_ALT_MAX, SOUND_MAX_RADIUS } from './sound.js';
import { mediaTier, tierWords } from './mediasrc.js';
import { graphemes } from './text.js';
import { ESSENTIAL_NAMES, instanceOf, effectFor, modernize, instanceProblem, paramShown } from './particle_effects.js';
import { readOut, readLine } from './a11y.js';
import { COMPONENTS as SPEC, registered } from './protocol/componentspec.js';
import { componentsOf, addable, RECORDS, compRefusal, LIGHT_DEFAULTS, bodyOf, socketQ } from './components.js';
import { checkSockets, ANCHORS, ACTION_DEFAULTS } from './sockbody.js';
import { grabOf, checkGrabbable, DEFAULTS as GRAB_DEFAULTS, WHO as GRAB_WHO, HOLDS as GRAB_HOLDS, POSES as GRAB_POSES, RELEASES as GRAB_RELEASES } from './grab.js';
import { eulerFromQ, qFromEuler, rotOrderOf, ROT_MODES, QUAT_MODE, setEulerChannel } from './euler.js';
import { qNorm, qHeading, qFromYaw, qWithHeading, qRotate } from './rot.js';
import { scale3, scaleWire, entScale } from './scale3.js';
import { localOf, parentOps, childrenOf, worldPose } from './hierarchy.js';

const R2D = 180 / Math.PI;
export const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };
export const MOTION_TYPES = ['pendulum', 'spin', 'orbit', 'bob', 'path'];
// a spin's or an orbit's rate in °/s, read as client/lib/motioneval.js rateOf reads it (shared/ can't import the client;
// tools/protocol/shiplist-check.ts holds the two together): degPerSec, else 360 / period, else an old rpm × 6, else the default
const rateOf = (m, def) => (Number.isFinite(m.degPerSec) ? m.degPerSec : Number.isFinite(m.period) && m.period > 0 ? 360 / m.period : Number.isFinite(m.rpm) ? m.rpm * 6 : def);
export const PARTICLE_PRESETS = ESSENTIAL_NAMES;   // the Essentials (shared/particle_effects.js): the effects every world has by name
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
const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// The light component (PROTOCOL §4, 2026-10-01): a lamp is a thing with a `light` component.
const compLight = (ent) => isBag(ent?.comp?.light);
// The reading a viewer with no hint gets: canonical (middle axis within ±90°,
// shared/euler.js) — except an UPRIGHT thing with a q (a pure turn about +Y,
// which every lease release and settle writes), which reads (0, yaw, 0) in
// every order, exactly as the same thing without a q does.
const uprightHint = (ent) => (ent?.q && Math.abs(ent.q[0]) < 1e-12 && Math.abs(ent.q[2]) < 1e-12 ? [0, ent.yaw ?? 0, 0] : null);
const motionKeys = (ent) => Object.keys(ent?.comp ?? {}).filter((k) => (k === 'motion' || k.startsWith('motion:')) && ent.comp[k] && typeof ent.comp[k] === 'object');

// ---------------------------------------------------------------- schema

/** @param ent   the folded entity record (shared/fold.js), or null
 *  @param id    its id
 *  @param live  optional viewer extras: { casting?: boolean,
 *               parts?: string[] (the model's named mesh parts — a picture's `part`
 *               becomes a dropdown and '+ picture' is offered), now?: number }
 *               Who may change it is the authority's to decide (it refuses, saying why). */
export function inspectSchema(ent, id, live = {}) {
  if (!ent) return { id, groups: [] };
  const c = ent.comp ?? {};
  const mounted = !!ent.parent;
  const locked = !!c.lock;
  // a lock doesn't make the pose read-only here: the authority refuses the move, and a person (or agent) who may lift the lock
  // is asked "This is locked. Move anyway?" — or answers it with throughLock (PROTOCOL §5). Same for every surface.
  // the pose the channel box shows and edits: a child's is LOCAL to its parent
  // (design §3) — the mount's offset and relative q, as the renderer realizes
  // it — never the fold's pre-mount pos, which nothing draws while it rides
  const L = localOf(ent, live.world ?? null);
  const pv = L.mounted ? { ...ent, pos: L.pos, q: L.q ?? undefined, yaw: L.yaw } : ent;
  const groups = [];

  // transform — the entity's LOCAL frame: a root's is the world (`place`), a
  // child's is its parent's (`mount` with the new offset / relative q; scale
  // stays the child's own, so it is still a `place`). Only a part socket's
  // rider is read-only: its pose is baked at the moving part's phase.
  const partRide = mounted && L.part;
  const tf = { disabled: !!partRide, hint: locked ? 'locked — moving it asks first' : partRide ? `rides ${ent.parent.to}'s moving part ${L.part} — its pose is set where it mounted; unparent and parent it again to move it` : undefined };
  const pos = pv.pos ?? [0, 0, 0];
  const transform = [
    { t: 'num', k: 'x', label: 'translate x', value: round(pos[0]), def: 0, step: 0.1, dp: 2, unit: 'm', ...tf },
    { t: 'num', k: 'y', label: 'translate y', value: round(pos[1]), def: 0, step: 0.1, dp: 2, unit: 'm', ...tf },
    { t: 'num', k: 'z', label: 'translate z', value: round(pos[2]), def: 0, step: 0.1, dp: 2, unit: 'm', ...tf },
  ];
  const rotation = [];
  let gimbal = false;
  {
    // pos.yaw: the heading — the friendly subset (PROTOCOL §9.1: a bare yaw turns
    // the thing about world +Y and keeps any tilt). Kept for agents and old
    // callers; the channel box shows the Rotate channels instead (alias).
    transform.push({ t: 'num', k: 'yaw', label: 'heading', value: round(pv.yaw ?? 0, 4), step: 5, deg: true, alias: 'rot', ...tf,
      hint: tf.hint ?? `turn about ${L.mounted ? 'its parent\'s' : 'world'} up to this heading, keeping any tilt (the Rotate channels are the full orientation)` });
    // scale: three channels like translate and rotate (R 10-04); `scale` stays as the uniform setter (all three to one
    // number), an alias the channel box doesn't draw
    const S = scale3(entScale(ent));
    transform.push({ t: 'num', k: 'scale', label: 'scale', value: round(S[1]), def: 1, step: 0.05, dp: 2, min: 0.01, softMax: 12, ...tf,
      alias: 'scale', hint: tf.hint ?? 'sets all three axes to one number (the channels are scale x / y / z)' });
    ['x', 'y', 'z'].forEach((a, i) => transform.push({ t: 'num', k: `s${a}`, label: `scale ${a}`, value: round(S[i]), def: 1, step: 0.05, dp: 2, min: 0.01, softMax: 12, ...tf }));
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
      ['x', 'y', 'z'].forEach((k, i) => rotation.push({ t: 'num', k, label: `rotate ${k}`, value: round(e[i], 12), def: 0, step: 5, deg: true, ...tf }));
    }
    ['x', 'y', 'z', 'w'].forEach((a, i) => rotation.push({ t: 'num', k: `q${a}`, label: `quat ${a}`, value: round(q[i], 6), step: 0.01, dp: 4, min: -1, max: 1, row: 'quat', ...tf,
      hint: tf.hint ?? 'the stored orientation (unit quaternion x y z w); normalized on commit' }));
  }
  const driven = c.motion?.type && !c.motion.part ? 'motion' : null;   // a whole-entity motion composes onto this REST pose
  // drivenBy: the card's own title (a pendulum's card is Pendulum), so the field's ~ names what you'll land on
  if (driven) for (const f of [...transform, ...rotation]) if (f.t === 'num') { f.driven = driven; f.drivenBy = String(c.motion.type).replace(/^./, (x) => x.toUpperCase()); }
  if (L.mounted) transform.unshift({ t: 'info', label: 'frame', value: `local to its parent, ${ent.parent.to} — translate and rotate write its mount; scale is its own (the parent's multiplies it)` });
  groups.push({ group: 'pos', label: 'Transform', verb: L.mounted ? 'mount' : 'place', fields: transform, ...(L.mounted ? { local: ent.parent.to } : {}) });
  if (rotation.length) groups.push({ group: 'rot', label: 'Rotate', verb: L.mounted ? 'mount' : 'place', fields: rotation, ...(gimbal ? { gimbal: true } : {}) });

  // the hierarchy (design §3 "Children"): who this rides, who rides it. The
  // ref picks a new parent (a tree row, or the thing in the world) and keeps
  // the child where it stands; clearing it — or `unparent` — makes it a root.
  // The same edit the Hierarchy's drag commits, so a headset and an agent can.
  const kids = live.world ? childrenOf(live.world, id) : null;
  groups.push({ group: 'parent', label: 'Parent', fields: [
    { t: 'ref', k: 'to', label: 'parent', value: mounted ? ent.parent.to : null,
      hint: 'pick its new parent — a row, or the thing itself in the world; it stays where it stands. Clear it to make it a root' },
    ...(kids ? [{ t: 'info', k: 'children', label: 'children', value: kids.length ? kids.join(', ') : 'none' }] : []),
    ...(mounted ? [{ t: 'btn', k: 'unparent', label: 'unparent', ...({ hint: 'make it a root, where it stands' }) }] : []),
  ] });

  const flags = [];
  groups.push({ group: 'flags', label: 'Flags', fields: [...flags,
    { t: 'check', k: 'lock', label: 'locked in place', value: locked, hint: 'nail it down: nobody\'s drags, edits or scripts can move, replace or remove it (server-enforced); sitting on it and content edits stay open. Not a door\'s lock (that is Openable\'s "door locked")' },
    // lock levels (R, 10-07): who may lift it — builders and up (a plain lock), moderators and up, or owners only ("not this
    // piece"). Nobody locks above their own rank; whoever set it may always lift it (the authority's rule)
    ...(locked ? [{ t: 'enum', k: 'lockLevel', label: 'lock level', value: LOCK_LEVEL(c.lock), def: 'builder', options: LOCK_LEVEL_OPTIONS,
      hint: 'who may unlock it, change it, or move it anyway: builders and up (the default), moderators and up, or owners only. You can set it up to your own rank; whoever locked it can always unlock it' }] : []),
    { t: 'check', k: 'hidden', label: 'hidden', value: c.hidden === true, hint: 'not drawn, still there — a comp every client honours' },
    { t: 'text', k: 'label', label: 'name', value: typeof c.label === 'string' ? c.label : '', placeholder: 'give it a name', hint: 'what people see; rename it freely — its id never changes' },
    // R 10-07: how it is described to anyone who reads rather than sees (alt text); what it can do and its state are read
    // out from its components (shared/a11y.js), shown below as everyone who reads it gets it
    { t: 'text', k: 'description', label: 'description', value: typeof c.description === 'string' ? c.description : '', multiline: true, placeholder: 'what it is and looks like, for people who can\'t see it and for agents',
      hint: `${graphemes(typeof c.description === 'string' ? c.description : '')} / ${SPEC.description.maxLen}. Don't list what it does: that is read from its components. A visible nameplate is a child thing with a sign (Text, billboard yaw)` },
    { t: 'info', k: 'reads', label: 'reads as', value: (() => { const r = readOut(c, { name: typeof c.label === 'string' ? c.label : null }); return [r.name ? `«${r.name}»` : '(no name)', readLine(r, { max: 120 })].filter(Boolean).join(': ') || '—'; })() },
  ] });

  // pivot (research 52): where it turns and scales from, in its own frame (before scale). The buttons snap it to the
  // model's own box (live.box, the client's measure of the model in its frame); reset = back to the origin.
  if (isBag(c.pivot) && Array.isArray(c.pivot.pos)) {
    const pp = c.pivot.pos; const box = live.box;
    groups.push({ group: 'pivot', label: 'pivot', types: ['pivot'], fields: [
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
  // look-at (batch 2; the wire name, `look` is one letter off `lock` and the authority refuses it): a group per key, its
  // fields addressed `look-at.<k>` for the whole thing and `look-at.<part>|<k>` for a part's
  const laKeys = Object.keys(c).filter((k) => (k === 'look-at' || k.startsWith('look-at:')) && isBag(c[k]));
  if (laKeys.length) {
    const AX = ['z', 'x', 'y', '-z', '-x', '-y'];
    const fields = [];
    for (const key of laKeys) {
      const la = c[key]; const pre = key === 'look-at' ? '' : `${key.slice(8)}|`; const nm = key === 'look-at' ? '' : `${key.slice(8)} `;
      const T = typeof la.target === 'string' ? la.target : null;
      fields.push({ t: 'ref', k: `${pre}target`, label: `${nm}faces`, value: T && !T.startsWith('@') && !/^u-/.test(T) ? T : null, words: { '@viewer': 'the viewer', '@nearest': 'nearest person' }, word: T?.startsWith('@') || /^u-/.test(T ?? '') ? T : null,
          hint: 'what it turns to face: pick a thing (a row, or the thing in the world), or "the viewer" (each viewer sees it face them) or "nearest person"' },
        { t: 'enum', k: `${pre}target@`, label: `${nm}or`, value: T?.startsWith('@') ? T : '', options: [{ v: '', label: '(a thing)' }, { v: '@viewer', label: 'the viewer' }, { v: '@nearest', label: 'nearest person' }] },
        { t: 'enum', k: `${pre}mode`, label: `${nm}turns`, value: la.mode === 'aim' ? 'aim' : 'yaw', def: 'yaw', options: [{ v: 'yaw', label: 'around its up (stays upright)' }, { v: 'aim', label: 'fully (tilts too)' }] },
        { t: 'enum', k: `${pre}forward`, label: `${nm}front`, value: typeof la.forward === 'string' ? la.forward : 'z', def: 'z', options: AX.map((v) => ({ v, label: v === 'z' ? '+z (its front)' : v })), hint: 'which of its own axes points at the target' },
        { t: 'num', k: `${pre}speed`, label: `${nm}speed`, value: la.speed ?? 240, def: 240, step: 30, dp: 0, min: 0, max: 3600, unit: '°/s', hint: '0 = turns at once' },
        { t: 'num', k: `${pre}range`, label: `${nm}range`, value: la.range ?? 12, def: 12, step: 1, dp: 1, min: 0.1, max: 100, unit: 'm', hint: 'a person further than this: it turns back to rest' });
    }
    groups.push({ group: 'look-at', label: 'look at', types: laKeys, fields });
  }

  // the `light` group: `light.intensity` is the same address to the panel, the VR quad and the agent's edit tool
  if (compLight(ent)) {
    const src = c.light;
    const fields = [
      { t: 'color', k: 'color', label: 'color', value: src.color ?? 0xffd9a0, def: 0xffd9a0 },
      { t: 'num', k: 'intensity', label: 'brightness', value: src.intensity ?? 16, def: 16, step: 1, dp: 0, min: 0, softMax: Math.max(64, src.intensity ?? 16) },
      { t: 'num', k: 'range', label: 'range', value: src.range ?? 10, def: 10, step: 1, dp: 0, min: 1, softMax: Math.max(40, src.range ?? 10), unit: 'm' },
      { t: 'check', k: 'important', label: 'important', value: src.important === true, hint: 'always casts: first claim on a light slot, never governor-shed' },
      { t: 'check', k: 'noon', label: 'burns at noon', value: src.day === false, hint: 'opts out of the day cycle' },
    ];
    if (live.casting === false) fields.push({ t: 'info', label: '', value: 'glow-only right now (slot pool spent) — it may still cast for others' });
    groups.push({ group: 'light', label: 'light', types: ['light'], fields });
  }

  // the collider component (PROTOCOL §4, 2026-10-01), or the spawn verb's
  // legacy `collide` it overrides. Editing writes the component either way:
  // `collide` has no verb but spawn, and re-spawning would re-author the thing.
  if (isBag(c.collider) || ent.collide != null) {
    const shape = isBag(c.collider) ? c.collider.shape : ent.collide;
    const opts = ['exact', 'box', 'sphere'];
    groups.push({ group: 'collider', label: 'collider', ...(isBag(c.collider) ? { types: ['collider'] } : {}), fields: [
      { t: 'enum', k: 'shape', label: 'shape', value: shape, options: (opts.includes(shape) ? opts : [...opts, String(shape)]).map((v) => ({ v, label: v })),
        hint: isBag(c.collider) ? 'exact = its triangles, box = its bounding box, sphere = a ball (rolls, under an engine that carries spheres); remove the component to let its size decide'
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
          fields.push({ t: 'num', k: k('degPerSec'), label: `${P}rate`, value: rateOf(m, 36), def: 36, step: 5, dp: 1, unit: '°/s' });
          fields.push({ t: 'num', k: k('phase'), label: `${P}phase`, value: m.phase ?? 0, step: 5, deg: true });
          break;
        case 'orbit':
          fields.push({ t: 'num', k: k('radius'), label: `${P}radius`, value: m.radius ?? 1, def: 1, step: 0.1, dp: 2, min: 0, unit: 'm' });
          fields.push({ t: 'num', k: k('degPerSec'), label: `${P}rate`, value: rateOf(m, 12), def: 12, step: 5, dp: 1, unit: '°/s', hint: 'degrees a second (a lap of 30 s is 12°/s)' });
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
    groups.push({ group: 'motion', label: 'motion', types: mk, fields });
  }

  if (c.sockets && typeof c.sockets === 'object') {
    const slots = Object.keys(c.sockets);
    const fields = [{ t: 'list', k: 'slots', empty: 'no anchors yet', rows: slots.map((slot) => {
      const s = c.sockets[slot] ?? {}; const p = s.pos ?? [0, 0.5, 0];
      const b = bodyOf(s);
      return { id: slot, label: slot, sub: `(${p.map((v) => (+v).toFixed(2)).join(', ')}) · ${sockRot(s).map((v) => Math.round(v * R2D)).join('/')}°${s.part ? ` · rides ${s.part}` : ''} · ${b ? `${b.action} (${typeof b.pose === 'string' ? b.pose : 'a blend'}, ${b.anchor})${b.input.move === 'drive' ? ' · drives' : ''}${b.leaveBy === 'script' ? ' · held' : ''}` : 'things attach'}`, actions: [{ k: 'del', label: '✕', danger: true }] };
    }) }];
    for (const slot of slots) {
      const s = c.sockets[slot] ?? {}; const p = s.pos ?? [0, 0.5, 0];
      ['x', 'y', 'z'].forEach((ax, i) => fields.push({ t: 'num', k: `${slot}|pos|${i}`, label: `${slot} ${ax}`, value: p[i], step: 0.05, dp: 2, unit: 'm' }));
      // its whole rotation (Unreal sockets): heading, then pitch and roll — a rocket's seat lies on its back
      const e = sockRot(s);
      [['heading', 1], ['pitch', 0], ['roll', 2]].forEach(([nm, ax]) => fields.push({ t: 'num', k: `${slot}|rot|${ax}`, label: `${slot} ${nm}`, value: round(e[ax], 6), step: 5, deg: true }));
      // a socket a PERSON attaches to by using it (VRChat Station, Roblox Seat): a chair, a saddle, a car seat
      const b = bodyOf(s);
      fields.push({ t: 'check', k: `${slot}|body`, label: `${slot}: people attach`, value: !!b, hint: 'a person attaches here by using it (sit, ride…); off: an attachment point for things only' });
      if (b) {
        // the body block (shared/sockbody.js): the common fields as rows, the structured ones (reach) as JSON; the
        // component's own JSON hatch below reaches everything else (poses, sync, approach, exit, hold)
        const raw = s.body ?? {}; const d = ACTION_DEFAULTS[b.action] ?? ACTION_DEFAULTS.sit;
        fields.push({ t: 'text', k: `${slot}|action`, label: `${slot} action`, value: b.action, hint: "what using it is called: sit, ride, lie, stand, drive… (it also picks the default pose and anchor)" });
        fields.push({ t: 'enum', k: `${slot}|anchor`, label: `${slot} anchor`, value: b.anchor, def: d.anchor, options: ANCHORS.map((v) => ({ v, label: v })), hint: 'the body point that lands on the socket: hips (a seat), feet (a place to stand), head, or the root' });
        if (typeof b.pose === 'string') fields.push({ t: 'enum', k: `${slot}|pose`, label: `${slot} pose`, value: b.pose, def: d.pose, options: [...new Set([...SOCKET_POSES, b.pose])].map((v) => ({ v, label: v })), hint: 'the clip the body holds (any animation-library name; a blend or a phase-locked clip: edit as JSON)' });
        else fields.push({ t: 'json', k: `${slot}|pose`, label: `${slot} pose`, value: JSON.stringify(b.pose, null, 2), hint: '{clip, time: "phase"} or a blend {by: "speed", clips: [[0, "idle"], [2, "walk"]]}; a clip name string makes it one clip again' });
        fields.push({ t: 'enum', k: `${slot}|leaveBy`, label: `${slot} leave by`, value: b.leaveBy, def: 'any', options: [['any', 'moving, jumping or X'], ['jump', 'jump or X'], ['menu', 'X only'], ['script', 'only the world (a script)']].map(([v, label]) => ({ v, label })) });
        fields.push({ t: 'enum', k: `${slot}|who`, label: `${slot} who`, value: b.who ?? 'anyone', def: 'anyone', options: [['anyone', 'anyone'], ['builder', 'builders'], ['owner', 'owners']].map(([v, label]) => ({ v, label })) });
        fields.push({ t: 'check', k: `${slot}|fromSeat`, label: `${slot}: hop from another seat`, value: b.fromSeat, hint: 'someone seated elsewhere may move here without standing up' });
        fields.push({ t: 'text', k: `${slot}|enter`, label: `${slot} enter clip`, value: b.enter ?? '', hint: "one-shot clip while you're carried on (stand_to_sit); empty: ease on" });
        fields.push({ t: 'text', k: `${slot}|leave`, label: `${slot} leave clip`, value: b.leave ?? '', hint: "one-shot clip while you're carried off (sit_to_stand); empty: step off" });
        fields.push({ t: 'enum', k: `${slot}|input|move`, label: `${slot} movement keys`, value: b.input.move, def: 'none', options: [['none', 'get you off'], ['drive', 'drive the thing (one per thing)'], ['walk', 'steer your own pose']].map(([v, label]) => ({ v, label })), hint: 'drive publishes throttle/steer for the thing; walk publishes them for this body\'s pose only' });
        fields.push({ t: 'enum', k: `${slot}|input|look`, label: `${slot} looking`, value: b.input.look, def: 'free', options: [['free', 'look around'], ['aim', 'look aims (aimYaw/aimPitch)'], ['locked', 'view locked forward']].map(([v, label]) => ({ v, label })) });
        const lk = raw.look ?? {};
        [['yaw', 0, 'left', -180, 180], ['yaw', 1, 'right', -180, 180], ['pitch', 0, 'down', -90, 90], ['pitch', 1, 'up', -90, 90]].forEach(([ax, i, nm, lo, hi]) =>
          fields.push({ t: 'num', k: `${slot}|look|${ax}|${i}`, label: `${slot} look ${nm}`, value: (Array.isArray(lk[ax]) ? lk[ax][i] : b.look[ax][i]), step: 5, dp: 0, unit: '°', min: lo, max: hi, hint: ax === 'yaw' ? 'how far the head turns (yaw, degrees, + = left)' : 'how far the head tilts (pitch, degrees, + = up)' }));
        fields.push({ t: 'enum', k: `${slot}|look|up`, label: `${slot} view up`, value: b.look.up, def: 'world', options: [['world', 'the horizon stays level'], ['socket', 'the view rolls with it']].map(([v, label]) => ({ v, label })) });
        fields.push({ t: 'json', k: `${slot}|reach`, label: `${slot} reach`, value: JSON.stringify(raw.reach ?? {}, null, 2), collapsed: !raw.reach, hint: '{leftHand: {at: [x,y,z], q?, part?, hint?, vr: snap|track|near}}: hands (or feet) on the thing, in its frame; with part they move with it' });
      }
    }
    fields.push({ t: 'btn', k: 'add', label: '+ seat here', hint: 'click the spot on the thing where a sitter goes', client: true });
    groups.push({ group: 'sockets', label: 'sockets', types: ['sockets'], fields });
  }

  // openable (R 10-07; shared/protocol/componentspec.js): open and locked are its state; it turns `angle` about its pivot (or slides
  // `slide` in its own frame) over `time`. The hinge buttons put the pivot on an edge of the model's own box (live.box).
  if (isBag(c.openable)) {
    const o = c.openable; const slides = Array.isArray(o.slide); const box = live.box;
    const fields = [
      { t: 'check', k: 'open', label: 'open', value: o.open === true, hint: 'its state now; anyone using it flips this (its reactions)' },
      { t: 'check', k: 'locked', label: 'door locked', value: o.locked === true, hint: "bars opening while on (an open handler with unless: 'locked'): the door's own lock, for the people using it. Pinning it in place is the Lock component's" },
      { t: 'enum', k: 'by', label: 'opens by', value: slides ? 'slide' : 'turn', def: 'turn', options: [['turn', 'turning about its pivot (a hinge)'], ['slide', 'sliding']].map(([v, label]) => ({ v, label })) },
    ];
    if (slides) ['x', 'y', 'z'].forEach((a, i) => fields.push({ t: 'num', k: `slide|${i}`, label: `slide ${a}`, value: +o.slide[i] || 0, def: 0, step: 0.05, dp: 2, min: -10, max: 10, unit: 'm', hint: 'how far it moves when open, in its own frame' }));
    else {
      fields.push({ t: 'num', k: 'angle', label: 'turns', value: Number.isFinite(o.angle) ? o.angle : Math.PI / 2, def: Math.PI / 2, step: 15, deg: true, min: -Math.PI, max: Math.PI, hint: 'how far it turns when open; negative turns the other way' });
      fields.push({ t: 'enum', k: 'axis', label: 'hinge axis', value: axisName(o, 'y'), def: 'y', options: Object.keys(AXES).map((v) => ({ v, label: v })), hint: 'y: an upright hinge (a door); x: a lid or a hatch' });
      if (Array.isArray(box) && !o.part) {
        fields.push({ t: 'btn', k: 'hingeL', label: 'hinge on its left edge', hint: 'puts its pivot on the -x edge of its box (it turns about the pivot)' });
        fields.push({ t: 'btn', k: 'hingeR', label: 'hinge on its right edge', hint: 'puts its pivot on the +x edge of its box' });
      }
    }
    fields.push({ t: 'num', k: 'time', label: 'takes', value: Number.isFinite(o.time) ? o.time : 1, def: 1, step: 0.1, dp: 2, min: 0, max: 10, unit: 's', hint: 'seconds to open or close' });
    if (o.part) fields.push({ t: 'info', label: 'moves', value: `the part ${o.part} (about the part's own origin)` });
    groups.push({ group: 'openable', label: 'openable', types: ['openable'], fields });
  }

  // grabbable (shared/grab.js): the common fields as rows, read with their defaults; grips, home and fx through its JSON
  // hatch below. Every edit is checked by the same checkGrabbable the authority refuses with.
  if (c.grabbable && typeof c.grabbable === 'object') {
    const g = grabOf({ grabbable: c.grabbable }) ?? grabOf({ grabbable: {} }); const raw = c.grabbable;
    const opts = (list) => list.map((v) => ({ v, label: v }));
    const grips = Object.keys(g.grips);
    groups.push({ group: 'grabbable', label: 'grabbable', types: ['grabbable'], fields: [
      { t: 'check', k: 'enabled', label: 'can be picked up', value: g.enabled, hint: 'Off: nobody can pick it up for now. (A loose ball can still be kicked.)' },
      { t: 'enum', k: 'who', label: 'who may', value: g.who, def: GRAB_DEFAULTS.who, options: GRAB_WHO.map((v) => ({ v, label: v === 'visitor' ? 'anyone' : `${v}s` })) },
      { t: 'check', k: 'steal', label: 'can be taken from a hand', value: g.steal, hint: 'On: someone else can grab it out of your hands. Off: it stays with whoever holds it until they let go (a world owner can still take it).' },
      { t: 'num', k: 'range', label: 'reach', value: g.range, def: GRAB_DEFAULTS.range, step: 0.1, dp: 2, min: 0.1, max: 10, unit: 'm', hint: 'How far away your hand can pick it up from. Arm\'s reach is 1.5 m; set it further and the thing flies to your hand when grabbed.' },
      { t: 'num', k: 'priority', label: 'priority', value: g.priority, def: 0, step: 1, dp: 0, min: -10, max: 10, hint: 'When several things are in reach, the one with the highest number is picked up first. Give small things on big things a higher number: the key, not the table it sits on.' },
      { t: 'enum', k: 'hold', label: 'hold', value: g.hold, def: GRAB_DEFAULTS.hold, options: [['auto', 'auto: while gripping in VR, sticky on desktop'], ['press', 'only while gripping'], ['toggle', 'sticky everywhere (a tool)']].map(([v, label]) => ({ v, label })) },
      { t: 'enum', k: 'pose', label: 'body pose', value: raw.pose ?? 'by size', def: 'by size', options: opts(['by size', ...GRAB_POSES]), hint: 'How an avatar on desktop (no tracked hands) holds it: in one hand, carried in both arms, like a torch, like a pistol, in two hands, or on the shoulder. "by size" picks one hand for small things and both arms for big ones.' },
      { t: 'check', k: 'twoHanded', label: 'two-handed', value: g.twoHanded, hint: 'On: it can be held in both hands at once, like a rifle or a broom. The first hand carries it and the second hand aims it. Off: only one hand holds it, so grabbing it with your other hand moves it to that hand.' },
      { t: 'check', k: 'carries', label: 'can carry other entities', value: g.carries, hint: 'On: picking it up brings along whatever is resting on it, like a tray of food. Off: only it comes up, and what was on it falls off, like taking a book out of a pile.' },
      { t: 'num', k: 'throw', label: 'throw', value: g.throw, def: GRAB_DEFAULTS.throw, step: 0.1, dp: 2, min: 0, max: 3, unit: '×', hint: 'How hard it flies when thrown: 1 is normal, 2 is twice as fast, 0 means it can only be dropped.' },
      { t: 'enum', k: 'release', label: 'let go', value: g.release, def: GRAB_DEFAULTS.release, options: [['drop', 'it falls, or is set down'], ['stay', 'it stays where you let go'], ['return', 'it goes home']].map(([v, label]) => ({ v, label })) },
      { t: 'num', k: 'returnAfter', label: 'goes home after', value: g.returnAfter, def: 0, step: 5, dp: 0, min: 0, max: 3600, unit: 's', hint: 'Left lying around for this many seconds, it returns to its home spot. 0 = it never returns on its own.' },
      { t: 'text', k: 'fits', label: 'fits sockets', value: g.fits.join(', '), placeholder: 'key, sword…', hint: 'Words that say what it is (key, sword…). Let go near a socket that accepts one of these words and it snaps into the socket.' },
      { t: 'text', k: 'use', label: 'use while held', value: g.use ? [g.use.down ?? '', g.use.up ?? ''].filter((x, i) => x || i === 0).join(' / ') : '', placeholder: 'action, or down / up', hint: 'What happens when you press the use button while holding it: the name of one of this thing\'s actions. Two names as "down / up" run one on press and the other on release.' },
      { t: 'text', k: 'prompt', label: 'hover text', value: g.prompt ?? '', placeholder: 'Pick up…', hint: 'The words shown when you point at it, in place of "pick up …". Up to 40 characters.' },
      { t: 'btn', k: 'gripedit', label: grips.length ? `edit grips (${grips.length}): ${grips.join(', ')}` : 'add grips…', hint: 'Where the hand takes hold of it, and how. Opens a see-through hand you drag into place; mirror it for the other hand, then try it.' },
    ] });
  }

  if (c.particles && typeof c.particles === 'object') {
    // R 10-07: the instance is {effect, part?, at?, seed?, playing?, scale?, params?}; the knobs are the effect's own params
    // (an Essential's: count, size, opacity, speed, lifetime, area, texture, quality). An older value (the first
    // protocol's flat bag) is shown in today's shape and written back in it on the first edit
    const inst = instanceOf(c.particles) ?? {}; const doc = effectFor(inst.effect, live.effects ?? (() => null)); const at = Array.isArray(inst.at) ? inst.at : [0, 0, 0];
    const effects = ESSENTIAL_NAMES.includes(inst.effect) ? ESSENTIAL_NAMES : [...ESSENTIAL_NAMES, inst.effect ?? '?'];
    const params = Object.entries(doc?.params ?? {}).flatMap(([name, p]) => { const v = inst.params?.[name] ?? paramShown(doc, name); const k = `param|${name}`, hint = p.help;
      if (p.type === 'number') return [{ t: 'num', k, label: name, value: v, step: (p.max ?? 10) - (p.min ?? 0) > 20 ? 10 : 0.05, dp: Number.isInteger(v) && (p.max ?? 0) > 20 ? 0 : 2, min: p.min, max: p.max, hint }];
      if (p.type === 'area') return [{ t: 'num', k, label: name, value: Array.isArray(v) ? v[0] : v, step: 0.05, dp: 2, min: p.min, max: p.max, unit: 'm', hint: `${hint ?? ''}${Array.isArray(v) ? ' (per-axis [x, y, z] in the JSON below)' : ''}` }];
      if (p.type === 'enum') return [{ t: 'enum', k, label: name, value: v ?? p.values[0], options: p.values.map((x) => ({ v: x, label: x })), hint }];
      if (p.type === 'bool') return [{ t: 'check', k, label: name, value: v === true, hint }];
      if (p.type === 'color') return [{ t: 'color', k, label: name, value: v ?? 0xffffff, hint }];
      return [{ t: 'text', k, label: name, value: v ?? '', placeholder: p.type === 'texture' ? 'eidoverse/assets/particle_textures/….png' : '', hint }]; });
    groups.push({ group: 'particles', label: 'particles', types: ['particles'], fields: [
      { t: 'enum', k: 'effect', label: 'effect', value: inst.effect, options: effects.map((v) => ({ v, label: v.startsWith('sha256:') || v.startsWith('eido:') ? `${doc?.name ?? 'stored'} (${v.slice(0, 15)}…)` : v })), hint: 'an Essential, or a stored effect document (upload {effect})' },
      { t: 'check', k: 'playing', label: 'playing', value: inst.playing !== false, hint: 'off: no new particles; the living finish' },
      { t: 'num', k: 'scale', label: 'scale', value: inst.scale ?? 1, def: 1, step: 0.1, dp: 2, min: 0.01, max: 100 },
      ...[0, 1, 2].map((i) => ({ t: 'num', k: `at|${i}`, label: `at ${'xyz'[i]}`, value: at[i], step: 0.05, dp: 2, min: -8, max: 8, unit: 'm' })),
      { t: 'text', k: 'part', label: 'part', value: inst.part ?? '', placeholder: 'a node of its model (optional)', hint: 'emit from one part of its model' },
      ...params,
      { t: 'btn', k: 'out', label: 'put it out', danger: true },
    ] });
  }

  // picture (shared/picture.js): an image on a part of its model, or (no part) a framed picture of its own. Every field
  // edit merges into the bag and must pass normalizePicture before a verb goes out.
  if (c.picture && typeof c.picture === 'object') {
    const p = c.picture; const parts = live.parts ?? [];
    const partOpts = [{ v: '', label: '(its own: a framed picture)' }, ...[...new Set([...(p.part && !parts.includes(p.part) ? [p.part] : []), ...parts])].map((v) => ({ v, label: v }))];
    const tier = mediaTier(p.src, 'image');
    const fields = [
      { t: 'text', k: 'src', label: 'image', value: p.src ?? '', placeholder: 'upload, or store/images/…, or an https link', hint: tier.tier === 'bad' ? 'a file in the store, or an https link' : tierWords(tier, 'image') },
      ...(tier.tier === 'link' && live.untrusted === false ? [{ t: 'info', label: '', value: '🛡 you don\'t see this: it links to a site that isn\'t trusted (Settings › 🛡 safety)' }] : []),
      { t: 'btn', k: 'upload', label: 'upload image…', client: true, hint: 'PNG, JPEG or WebP into this server\'s store; the path fills in. Make sure you own the rights to it before you upload it' },
      { t: 'enum', k: 'part', label: 'where', value: p.part ?? '', options: partOpts, hint: 'on its own (a picture facing its front, sized by width), or on one of its model\'s parts' },
      ...(p.part ? [] : [{ t: 'num', k: 'width', label: 'width', value: p.width ?? 1, def: 1, step: 0.1, dp: 2, min: 0.05, max: 20, unit: 'm', hint: 'its height follows the image' }]),
      { t: 'text', k: 'alt', label: 'alt text', value: p.alt ?? '', placeholder: 'what it shows, in words', hint: `${ALT_HINT} (≤${PICTURE_ALT_MAX})` },
      { t: 'enum', k: 'lit', label: 'lit', value: p.lit === 'self' ? 'self' : 'scene', options: Object.entries(PICTURE_LIT).map(([v, label]) => ({ v, label })) },
      { t: 'check', k: 'flip', label: 'flip', value: p.flip === true, hint: 'for a part whose UVs were exported upside down' },
    ];
    const n = normalizePicture(p);
    if (!n.ok) fields.unshift({ t: 'info', label: '', value: `⚠ not shown: ${n.why}` });
    else if (n.notes.length) fields.push({ t: 'info', label: '', value: n.notes.join(' · ') });
    fields.push({ t: 'btn', k: 'down', label: 'take down', danger: true });
    groups.push({ group: 'picture', label: 'picture', types: ['picture'], fields });
  }

  // sound (shared/sound.js): positional audio, silent past its radius. Tuning a PLAYING sound keeps its t0 (nobody's
  // playhead jumps); play and restart send no t0, and the authority stamps one, so everyone starts together.
  if (c.sound && typeof c.sound === 'object') {
    const d = c.sound; const playing = d.playing !== false;
    const tier = mediaTier(d.src, 'audio');
    const rings = isBag(c.reactions) && Object.values(c.reactions).some((h) => h?.kind === 'play');
    const fields = [
      { t: 'info', label: 'state', value: playing ? (d.loop === false ? '▶ played (one-shot)' : '▶ playing') : '⏸ paused' },
      { t: 'text', k: 'src', label: 'file', value: d.src ?? '', placeholder: 'upload, or store/audio/…, or an https link', hint: tier.tier === 'bad' ? 'a file in the store, or an https link' : tierWords(tier, 'audio') },
      { t: 'btn', k: 'upload', label: 'upload audio…', client: true, hint: 'MP3, Ogg, WAV, WebM or M4A into this server\'s store; the path fills in. Make sure you own the rights to it before you upload it' },
      { t: 'text', k: 'alt', label: 'alt text', value: d.alt ?? '', placeholder: 'what is playing, in words', hint: `Alternative text: describes this for people who can't hear it, and for agents (≤${SOUND_ALT_MAX})` },
      { t: 'num', k: 'volume', label: 'volume', value: d.volume ?? 0.8, def: 0.8, step: 0.05, dp: 2, min: 0, max: 1 },
      { t: 'num', k: 'pitch', label: 'pitch', value: d.pitch ?? 1, def: 1, step: 0.05, dp: 2, min: 0.5, max: 2, hint: 'playback rate: 2 = an octave up and twice as fast' },
      { t: 'num', k: 'near', label: 'full volume within', value: d.near ?? 1.5, def: 1.5, step: 0.5, dp: 1, min: 0.1, max: SOUND_MAX_RADIUS, unit: 'm' },
      { t: 'num', k: 'radius', label: 'silent beyond', value: d.radius ?? 12, def: 12, step: 1, dp: 0, min: 1, max: SOUND_MAX_RADIUS, unit: 'm', hint: 'nobody further than this hears it at all' },
      { t: 'check', k: 'spatial', label: 'positional', value: d.spatial !== false, hint: 'off: heard evenly everywhere inside its radius (room tone, music in a hall)' },
      { t: 'check', k: 'loop', label: 'loop', value: d.loop !== false },
      // this viewer's own (client: never a value on the wire): a sound you never want to hear here again
      ...(live.mutedForMe !== undefined ? [{ t: 'check', k: 'mute', label: 'mute for me', value: !!live.mutedForMe, client: true, hint: 'only you stop hearing it; nobody else is affected, and nothing is recorded' }] : []),
      ...(tier.tier === 'link' && live.untrusted === false ? [{ t: 'info', label: '', value: '🛡 you don\'t hear this: it links to a site that isn\'t trusted (Settings › 🛡 safety)' }] : []),
      { t: 'check', k: 'rings', label: 'plays when used', value: rings, hint: 'using it plays it again from the top (a doorbell): adds a reaction {ring: {kind: "play"}}' },
    ];
    const n = normalizeSound(d);
    if (!n.ok) fields.unshift({ t: 'info', label: '', value: `⚠ not heard: ${n.why}` });
    fields.push(playing ? { t: 'btn', k: 'pause', label: 'pause' } : { t: 'btn', k: 'play', label: '▶ play', hint: 'starts it for everyone at the same moment' });
    if (playing) fields.push({ t: 'btn', k: 'play', label: 'restart', hint: 'back to the top, for everyone at once' });
    fields.push({ t: 'btn', k: 'silence', label: 'silence', danger: true });
    groups.push({ group: 'sound', label: 'sound', types: ['sound'], fields });
  }

  // story (batch 2): why it's here, a museum label. Shown on Inspect and read by agents
  if (isBag(c.story)) {
    const st = c.story;
    groups.push({ group: 'story', label: 'story', types: ['story'], fields: [
      { t: 'text', k: 'title', label: 'title', value: st.title ?? '', placeholder: 'its headline', hint: `≤${SPEC.story.ranges.title.maxLen} characters (${graphemes(st.title ?? '')} now)` },
      { t: 'text', k: 'text', label: 'text', value: st.text ?? '', multiline: true, placeholder: 'why it is here', hint: `plain text, a blank line between paragraphs; ${graphemes(st.text ?? '')} / ${SPEC.story.ranges.text.maxLen}` },
      { t: 'text', k: 'marks', label: 'marks', value: Array.isArray(st.marks) ? st.marks.join(', ') : '', placeholder: 'ids, comma-separated', hint: 'what it marks or commemorates (up to 8 things)' },
    ] });
  }

  // text (batch 2): a sign
  if (isBag(c.text)) {
    const tx = c.text; const D = SPEC.text.defaults;
    groups.push({ group: 'text', label: 'text', types: ['text'], fields: [
      { t: 'text', k: 'text', label: 'says', value: tx.text ?? '', multiline: true, hint: `${graphemes(tx.text ?? '')} / ${SPEC.text.ranges.text.maxLen} characters, ≤ 16 lines` },
      { t: 'num', k: 'size', label: 'size', value: tx.size ?? D.size, def: D.size, step: 0.01, dp: 2, min: 0.02, max: 2, unit: 'm', hint: 'the height of a line' },
      { t: 'num', k: 'width', label: 'width', value: tx.width ?? D.width, def: D.width, step: 0.1, dp: 2, min: 0.1, max: 10, unit: 'm', hint: 'where lines wrap' },
      { t: 'enum', k: 'align', label: 'align', value: tx.align ?? D.align, def: D.align, options: ['left', 'center', 'right'].map((v) => ({ v, label: v })) },
      { t: 'color', k: 'color', label: 'colour', value: Number.isInteger(tx.color) ? tx.color : D.color, def: D.color },
      { t: 'check', k: 'outline', label: 'outline', value: tx.outline !== false, hint: 'a contrasting edge, so it reads on any background' },
      { t: 'check', k: 'plate', label: 'background', value: Number.isInteger(tx.background), hint: 'a plate behind the words' },
      ...(Number.isInteger(tx.background) ? [{ t: 'color', k: 'background', label: 'plate colour', value: tx.background }] : []),
      { t: 'enum', k: 'billboard', label: 'faces', value: tx.billboard ?? D.billboard, def: D.billboard, options: [{ v: 'off', label: 'flat (readable from both sides)' }, { v: 'yaw', label: 'turns to face you' }, { v: 'full', label: 'always faces you' }] },
      { t: 'enum', k: 'lit', label: 'lit', value: tx.lit ?? D.lit, def: D.lit, options: [{ v: 'self', label: 'glows (unlit)' }, { v: 'scene', label: 'takes the scene\'s light' }] },
    ] });
  }

  // scripts (research 41): each script:<name> gets an on/off switch, `paused`, like Unity's `enabled`. Flipping it
  // writes only {paused} (a merge), so it needs nothing of the script (its source, its scope) and adopts nothing: the
  // script's sponsor stays who it was (R on lab 49 F4), and the authority's `scripts` view says who paused it, from the log
  const scriptKeys = Object.keys(c).filter((k) => k.startsWith('script:') && isBag(c[k]));
  if (scriptKeys.length) groups.push({ group: 'script', label: 'scripts', types: scriptKeys,
    fields: scriptKeys.map((k) => ({ t: 'check', k: k.slice(7), label: 'paused', value: c[k].paused === true,
      hint: 'stop this script without changing it (its source, scope and sponsor stay as they are); History and the world\'s scripts list say who paused it' })) });
  // every typed group keeps an escape hatch: its component(s) as JSON, collapsed. Its fields
  // don't speak for every key (a path's points, a socket's part, a particle seed/texture), and
  // a key nobody can reach from the panel is a key only a model can edit.
  for (const g of groups) {
    if (!g.types?.length || g.group === 'flags') continue;
    for (const type of g.types) if (c[type] != null) g.fields.push({ t: 'json', k: `json|${type}`, label: g.types.length > 1 ? type : '', value: JSON.stringify(c[type], null, 2), collapsed: true, commit: `comp.${type}`, hint: `the whole ${type} component — a saved edit replaces it wholesale` });
  }

  // every type no group speaks for: raw JSON, the blind fold's UI twin —
  // a type invented this morning is editable today
  const claimed = new Set(['lock', 'hidden', 'label', 'sockets', 'grabbable', 'particles', 'picture', 'sound', 'story', 'text', ...laKeys, ...mk, ...scriptKeys,
    ...(compLight(ent) ? ['light'] : []), ...(isBag(c.collider) ? ['collider'] : [])]);
  const rest = Object.keys(c).filter((t) => !claimed.has(t));
  const fields = rest.map((type) => ({ t: 'json', k: type, label: type, value: JSON.stringify(c[type], null, 2), hint: 'raw JSON — a saved edit replaces this type\'s data wholesale' }));
  // Add Component (Unity's pattern) for the kinds that need a gesture to begin:
  // a picture needs an image and a part, a sound a file. Both are uploads.
  if (!c.picture) fields.push({ t: 'btn', k: 'add:picture', label: '+ picture…', client: true, hint: 'upload an image and hang it on this thing (make sure you own the rights to it)' });
  if (!c.sound) fields.push({ t: 'btn', k: 'add:sound', label: '+ sound…', client: true, hint: 'upload audio and put it on this thing (make sure you own the rights to it)' });
  if (!c.sockets && live.parts) fields.push({ t: 'btn', k: 'add:seat', label: '+ seat…', client: true, hint: 'click the spot on the thing where a sitter goes' });
  fields.push({ t: 'text', k: '+', label: '+ component', value: '', placeholder: 'type (local/recipe, example.org/notice…) ⏎', hint: 'attach a component — any type folds, evaluators give known ones behavior' });
  groups.push({ group: 'comp', label: `Components (${rest.length})`, fields });

  return { id, groups, sections: componentSections(ent, groups, live, id) };
}

// ---------------------------------------------------------------- components (B)
// The same fields, presented the way Unity/Godot/Resonite do: one card per
// component instance on the entity (shared/components.js), each naming the
// fields it owns by their unchanged `group.k` address — so editOps, the
// agent's `edit` tool and the gizmo keep working — plus what may be added.
// A component today's wire cannot express is listed with the reason, not hidden.
const WIRE_BLOCKED = {
  // a lamp is a Model with a Light component; a model is swapped, not added, from the Library
  Model: () => 'swap the model from the Library',
  Structure: () => 'start a building from Create ▸ Structure',
  Parent: () => 'give it a parent: drag its row onto another in the Hierarchy, or pick one in this card',
  // the authority's one-turner rule (look-at vs a rotating motion, or physics turning it): said here, not refused there
  LookAt: (_have, ent) => { const m = ent?.comp?.motion; if (m && ['pendulum', 'spin'].includes(m.type)) return `it already turns by its ${m.type}; one thing turns at a time — remove that first, or add LookAt to a part`;
    return ent?.comp?.physics?.kind === 'dynamic' ? 'physics turns it (it is dynamic): make it static, or add LookAt to a part' : null; },
};
const MOTION_GROUP = { Pendulum: 1, Spin: 1, Orbit: 1, Bob: 1, Path: 1 };
// not offered by Add Component: what the authority refuses today (none: LookAt writes `look-at` since batch 2, and the
// agent's add.LookAt already worked while this list still hid it from people: audit 10-07). tools/protocol/shiplist-check.ts
// R1 sends every offered entry to the real door: all must be accepted.
const NOT_OFFERED = new Set();
// a lock's level as the inspector reads it: true (a plain lock) is builder level
const LOCK_LEVEL = (v) => (v && typeof v === 'object' && ['builder', 'moderator', 'owner'].includes(v.rank) ? v.rank : 'builder');
const LOCK_LEVEL_OPTIONS = [['builder', 'builders and up'], ['moderator', 'moderators and up'], ['owner', 'owners only']].map(([v, label]) => ({ v, label }));
/** The words people search Add Component with that aren't in a component's name or summary (review 10-07 S9: "seat"
 *  found nothing; the seat is Sockets). Shared so an agent's surface can use the same words. */
export const ADD_WORDS = Object.freeze({
  Sockets: ['seat', 'chair', 'sit', 'bench', 'stool', 'saddle', 'swing'], Reactions: ['button', 'switch', 'lever', 'trigger', 'press'],
  Text: ['sign', 'label', 'words', 'caption', 'write'], Picture: ['image', 'poster', 'photo', 'painting', 'decal'],
  Sound: ['music', 'audio', 'speaker', 'song'], Openable: ['door', 'gate', 'lid', 'hatch'], Grabbable: ['pick up', 'carry', 'hold', 'item', 'pickup'],
  Light: ['lamp', 'bulb', 'torch', 'glow'], LookAt: ['face', 'turn to', 'track', 'follow', 'watch'], Collider: ['solid', 'collide', 'walk on'],
  Particles: ['fire', 'smoke', 'sparks', 'fx', 'effect'], Spin: ['rotate', 'turn'], Bob: ['float', 'hover'], Story: ['description', 'info', 'plaque'],
  Lock: ['pin', 'nail down', 'freeze'], Pivot: ['hinge', 'origin'],
});
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
function componentSections(ent, groups, live = {}, id = '?') {
  const { components } = componentsOf(ent);
  const have = new Set(components.map((c) => c.type));
  const g = (name) => groups.find((x) => x.group === name);
  const refs = (group, pred = () => true) => (g(group)?.fields ?? []).filter((f) => f.k != null && pred(f)).map((f) => `${group}.${f.k}`);
  const out = [];
  let partOrdinal = 0;
  for (const inst of components) {
    const rec = RECORDS[inst.type];
    // every card's title starts with a capital (R 10-10: 'physics' was the only one that didn't)
    const sec = { type: inst.type, key: inst.key ?? null, title: String(inst.type).charAt(0).toUpperCase() + String(inst.type).slice(1), hash: rec.hash, category: rec.category, summary: rec.summary, fields: [], removable: false };
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
      case 'Parent': sec.info = ent.parent?.socket ? [['socket', String(ent.parent.socket)]] : []; sec.fields = refs('parent', (f) => f.k !== 'children'); break;   // children are the Hierarchy's (R, 10-04)   // the Parent card (R, 10-04: a component, named as engines name it)
      case 'Light':
        // keyless = the light-verb light (the light group is its); keyed = the
        // component: the group when it is the entity's light, raw JSON when a
        // hand-written log put one beside a legacy light
        if (inst.key == null || compLight(ent)) sec.fields = refs('light');
        else sec.fields = [`comp.${inst.key}`];
        sec.removable = inst.key != null;
        break;
      case 'Label': case 'Hidden': case 'Description': continue;       // the header's, like Unity's name and active box
      case 'Lock': sec.fields = refs('flags', (f) => f.k === inst.key || f.k === 'lockLevel'); sec.removable = true; break;
      case 'Sockets': sec.fields = refs('sockets'); sec.removable = true; break;
      case 'Grabbable': sec.fields = refs('grabbable'); sec.removable = true; break;
      case 'Openable': sec.fields = refs('openable'); sec.removable = true; break;
      case 'Particles': sec.fields = refs('particles', (f) => f.k !== 'out'); sec.removable = true; break;
      case 'Picture': sec.fields = refs('picture', (f) => f.k !== 'down'); sec.removable = true; break;
      case 'Sound': sec.fields = refs('sound', (f) => f.k !== 'silence'); sec.removable = true; break;
      case 'LookAt': { const pre = inst.key === 'look-at' ? '' : `${inst.key.slice(8)}|`;
        sec.fields = refs('look-at', (f) => f.t !== 'json' ? (pre ? f.k.startsWith(pre) : !f.k.includes('|')) : f.k === `json|${inst.key}`); sec.removable = true;
        if (pre) sec.title = `LookAt · ${partLabel(inst.key.slice(8), live.parts)}`; break; }
      case 'Story': sec.fields = refs('story'); sec.removable = true; break;
      case 'Text': sec.fields = refs('text'); sec.removable = true; break;
      case 'Pivot': sec.fields = refs('pivot'); sec.removable = true; break;
      default:
        if (MOTION_GROUP[inst.type]) {
          const part = inst.key === 'motion' ? (inst.params.part ?? null) : inst.key.slice(7);
          if (part) { sec.title = `${inst.type} · ${partLabel(part, live.parts, ++partOrdinal)}`; sec.part = part; }
          // the type is the card, not a field: changing it is remove + add
          const own = (f) => (inst.key === 'motion' ? !f.k.includes('|') : f.k.startsWith(`${inst.key.slice(7)}|`));
          sec.fields = refs('motion', (f) => own(f) && !/(^|\|)(type|rest)$/.test(f.k));
          sec.removable = true;
        } else if (inst.type === 'Annotation' && inst.key.startsWith('script:') && g('script')) {
          const name = inst.key.slice(7);            // a script: its switch first, then its JSON (src, scope, on, knobs)
          sec.title = `Script · ${name}`; sec.fields = [`script.${name}`, `script.json|${inst.key}`]; sec.removable = true;
        } else {
          sec.fields = [`comp.${inst.key}`];         // the raw-JSON floor (Annotation, Structure, Reactions, Captions, Stage)
          sec.removable = inst.type !== 'Captions';
          if (inst.type === 'Annotation') sec.title = inst.key;
        }
    }
    if (typeof sec.title === 'string' && sec.title) sec.title = sec.title.charAt(0).toUpperCase() + sec.title.slice(1);   // every card starts with a capital (R 10-10: 'physics')
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
  const add = addable(components, { unmet: true, met: (n) => needMet(n, ent) }).filter((a) => a.name !== 'Label' && a.name !== 'Hidden' && a.name !== 'Description' && !NOT_OFFERED.has(a.name))
    .map((a) => {
      const plan = a.unmet ? planNeeds(ent, id, a.name) : null;
      const needsWhy = plan?.choice && !plan.choice.options.length ? plan.choice.prompt : null;
      const blocked = needsWhy ?? WIRE_BLOCKED[a.name]?.(have, ent) ?? null;
      return { ...a, blocked, ...(plan?.brings ? { brings: plan.brings } : {}), ...(plan?.choice?.options.length ? { asks: plan.choice.need } : {}) };
    });
  for (const name of ['Model', 'Structure', 'Parent']) if (!have.has(name) && !add.some((a) => a.name === name) && WIRE_BLOCKED[name])
    add.push({ name, category: RECORDS[name].category, summary: RECORDS[name].summary, hash: RECORDS[name].hash, blocked: WIRE_BLOCKED[name](have, ent) });
  // the header's `lib` line reads the Model component (design §5), so it can
  // never disagree with the Model card; an Empty and a light say what they are
  const model = components.find((c) => c.type === 'Model')?.params.lib;
  const lib = model != null ? String(model) : null;
  // parenting lives on the Parent card (R, 10-04), not the header
  return { header: refs('flags', (f) => f.k === 'label' || f.k === 'hidden' || f.k === 'description' || f.k === 'reads'), list: out, add,
    lib, libLabel: lib != null ? libLabel(lib) : ent?.comp?.light ? 'light' : 'empty' };
}

// ---------------------------------------------------------------- needs
// What each need means on THIS entity, and how it is met when it is not
// (design §3). A need with one sensible default is added for you, as real
// ops, in the same undo step; a need that requires a choice returns a
// `choice` the panel renders as a prompt (and an agent reads), resolved by
// adding again with one of its option values. A choice with no options is a
// need that cannot be met in place — it reads as a refusal that says why.
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const NEEDS = {
  // a model is placed from the Library (spawn on the id would replace this
  // entity wholesale: its components, its placer, its born)
  Model: {
    met: (ent) => ent?.lib != null,
    plan: (ent, id, name) => ({ choice: { need: 'Model', options: [],
      prompt: `${article(name)} ${name.toLowerCase()} needs a model to act on (${id} has none) — place a model from the Library and add the ${name} to it, or put ${id} under one` } }),
  },
  // reactions push the WHOLE entity's pendulum (server/reactions.ts): a part's
  // pendulum does not count, and a whole-entity spin is in the way
  Pendulum: {
    met: (ent) => ent?.comp?.motion?.type === 'pendulum',
    plan: (ent, id, name) => {
      const m = ent?.comp?.motion;
      const ops = [OP.set(id, 'motion', { type: 'pendulum', amp: 0, period: 3.5 })];
      if (!m) return { ops, brings: 'a Pendulum at rest, for it to push' };
      return { choice: { need: 'Pendulum', prompt: `${name} pushes a pendulum, and ${id} already moves as a whole (${m.type ?? 'a motion'}) — replace that with a Pendulum?`,
        options: [{ v: 'replace', label: `replace its ${m.type ?? 'motion'} with a Pendulum`, ops }] } };
    },
  },
};
/** Is `need` met on this entity? The NEEDS table's reading, else a component of that type. */
export function needMet(need, ent) {
  return NEEDS[need] ? NEEDS[need].met(ent) : componentsOf(ent).components.some((c) => c.type === need);
}
/** Plan the needs of adding `name`: { ops } to prepend, `brings` (what is
 *  added for you), or a `choice` (unresolved). `value` resolves a choice when
 *  it names one of its options ("replace", or {choose: "replace"}). */
export function planNeeds(ent, id, name, value) {
  const ops = []; const brings = [];
  const pick = typeof value === 'string' ? value : value?.choose;
  for (const need of RECORDS[name]?.needs ?? []) {
    if (needMet(need, ent)) continue;
    const p = NEEDS[need]?.plan(ent, id, name) ?? { choice: { need, options: [], prompt: `${article(name)} ${name} needs ${article(need)} ${need} first` } };
    if (p.choice) {
      const opt = p.choice.options.find((o) => o.v === pick);
      if (!opt) return { ops: [], choice: { component: name, ...p.choice, options: p.choice.options.map(({ v, label }) => ({ v, label })) } };
      ops.push(...opt.ops); brings.push(opt.label);
      continue;
    }
    ops.push(...p.ops); brings.push(p.brings);
  }
  return { ops, ...(brings.length ? { brings: brings.join('; ') } : {}) };
}

/** What adding a component writes, in today's ops, needs included (one
 *  call = one undo step on every surface). `value` is the part name for a
 *  part motion, the type name for an Annotation, or a need's choice. Returns
 *  { ops, errors, choice? } — a `choice` sends nothing and asks. */
export function addOps(ent, id, name, value) {
  const np = planNeeds(ent, id, name, value);
  if (np.choice) return { ops: [], errors: np.choice.options.length ? [] : [np.choice.prompt], choice: np.choice };
  const own = addOwnOps(ent, id, name, np.ops.length ? undefined : value);
  if (own.errors.length) return own;
  return { ops: [...np.ops, ...own.ops], errors: [], ...(np.brings ? { brings: np.brings } : {}) };
}
function addOwnOps(ent, id, name, value) {
  const c = ent?.comp ?? {};
  // a path's points are in its parent's frame (as the renderer reads them): it starts where it stands and goes 2 m on
  const p0 = (Array.isArray(ent?.parent?.offset) ? ent.parent.offset : Array.isArray(ent?.pos) ? ent.pos : [0, 0, 0]).map((v) => round(+v || 0, 4));
  const motion = { Pendulum: { type: 'pendulum', amp: 0.26, period: 3.5 }, Spin: { type: 'spin', degPerSec: 36 }, Orbit: { type: 'orbit', radius: 1, degPerSec: 12 }, Bob: { type: 'bob', amp: 0.3, period: 4 }, Path: { type: 'path', points: [p0, [p0[0], p0[1], round(p0[2] + 2, 4)]], speed: 1 } };
  if (motion[name]) {
    const part = typeof value === 'string' && value.trim() ? value.trim() : null;
    if (part) { const key = `motion:${part}`; if (c[key]) return { ops: [], errors: [`${id} already has a motion on ${part}`] }; return { ops: [OP.set(id, key, motion[name])], errors: [] }; }
    if (c.motion) return { ops: [], errors: [`${id} already moves as a whole (${c.motion.type}) — remove it first, or add this one to a part`] };
    return { ops: [OP.set(id, 'motion', motion[name])], errors: [] };
  }
  const simple = { Pivot: ['pivot', { pos: Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : [0, 0, 0] }], Lock: ['lock', true], Hidden: ['hidden', true], Label: ['label', typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'unnamed'],
    Particles: ['particles', { effect: typeof value === 'string' && value ? value : 'fire' }], LookAt: ['look-at', { target: '@viewer' }], Story: ['story', { title: 'Untitled', text: 'Why is this here?' }], Text: ['text', { text: 'Hello' }], Reactions: ['reactions', { push: { kind: 'impulse', strength: 0.5 } }], Stage: ['stage', {}] };
  if (simple[name]) { const [type, data] = simple[name]; if (c[type] != null) return { ops: [], errors: [`${id} already has ${name}`] }; return { ops: [OP.set(id, type, data)], errors: [] }; }
  // write-new-on-edit: a Light added here is a component, never the light verb,
  // and it is written with its fields spelled out — the log records the result,
  // so a later change of the engine's defaults cannot change this lamp
  if (name === 'Light') {
    if (c.light != null) return { ops: [], errors: [`${id} already has a light`] };
    return { ops: [OP.set(id, 'light', { ...LIGHT_DEFAULTS })], errors: [] };
  }
  if (name === 'Collider') {
    if (ent?.lib == null) return { ops: [], errors: [`a collider needs a model to collide as (${id} has none)`] };
    if (c.collider != null) return { ops: [], errors: [`${id} already has a collider`] };
    const shape = value === 'box' || value === 'sphere' ? value : value == null || value === '' || value === 'exact' ? 'exact' : null;
    if (!shape) return { ops: [], errors: ['a collider shape is "exact", "box" or "sphere"'] };
    return { ops: [OP.set(id, 'collider', { shape })], errors: [] };
  }
  // write-new-on-edit, the way a Light is added: its fields spelled out from shared/grab.js DEFAULTS (the data, never a
  // copy of it), so a later change of the engine's defaults can't change this thing. The ones that are absent by
  // meaning (no grips, no home, no use, size-chosen pose) stay absent.
  if (name === 'Grabbable') {
    if (c.grabbable != null) return { ops: [], errors: [`${id} already has grabbable`] };
    const spec = Object.fromEntries(Object.entries(GRAB_DEFAULTS).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
    return { ops: [OP.set(id, 'grabbable', spec)], errors: [] };
  }
  // an Openable is usable at once: its state written out (write-new-on-edit, like a Light) and an `open` action that flips
  // it, barred while locked (one undo step). A thing that already has an `open` action keeps its own.
  if (name === 'Openable') {
    if (c.openable != null) return { ops: [], errors: [`${id} already opens`] };
    const rx = isBag(c.reactions) ? c.reactions : {};
    return { ops: [OP.set(id, 'openable', { open: false, locked: false, angle: round(Math.PI / 2, 6), time: 1 }),
      ...(rx.open ? [] : [OP.set(id, 'reactions', { ...rx, open: { kind: 'toggle', unless: 'locked' } })])], errors: [] };
  }
  if (name === 'Annotation') { const type = String(value ?? '').trim(); if (!type) return { ops: [], errors: ['an annotation needs a type name'] }; if (c[type] != null) return { ops: [], errors: [`${id} already has ${type}`] };
    // PROTOCOL §4: a bare name is the registry's; your own carries a namespace (local/recipe, example.org/recipe)
    if (!type.split(':')[0].includes('/') && !registered(type.split(':')[0])) return { ops: [], errors: [`'${type}' isn't a registered component: a component of your own carries a namespace, e.g. local/${type}`] };
    return { ops: [OP.set(id, type, {})], errors: [] }; }
  return { ops: [], errors: [`${name}: added by a gesture, not a value (${WIRE_BLOCKED[name]?.(new Set()) ?? 'see its card'})`] };
}

/** What removing one component instance writes. When another component
 *  needs it (design §3) nothing is sent: the result names the dependants in a
 *  `confirm`, and removing again with value "both" removes them too, in the
 *  same step. */
export function removeOps(ent, id, key, value) {
  const c = ent?.comp ?? {};
  if (c[key] != null) {
    const after = { ...ent, comp: Object.fromEntries(Object.entries(c).filter(([k]) => k !== key)) };
    const deps = componentsOf(ent).components.filter((inst) => inst.key != null && inst.key !== key
      && (RECORDS[inst.type]?.needs ?? []).some((n) => needMet(n, ent) && !needMet(n, after)));
    if (deps.length) {
      const what = componentsOf(ent).components.find((inst) => inst.key === key)?.type ?? key;
      if (value !== 'both') return { ops: [], errors: [], confirm: { key, type: what, dependants: deps.map((d) => ({ type: d.type, key: d.key })),
        prompt: `${deps.map((d) => d.type).join(' and ')} need${deps.length > 1 ? '' : 's'} this ${what} — remove ${deps.length > 1 ? 'them' : 'both'}?`, both: 'both' } };
      const ops = [];
      for (const d of deps) { const r = removeOwnOps(ent, id, d.key); if (r.errors.length) return r; ops.push(...r.ops); }
      const own = removeOwnOps(ent, id, key);
      return own.errors.length ? own : { ops: [...ops, ...own.ops], errors: [] };
    }
  }
  return removeOwnOps(ent, id, key);
}
function removeOwnOps(ent, id, key) {
  const c = ent?.comp ?? {};
  if (key === 'motion' && c.motion) return { ops: [OP.unset(id, 'motion')], errors: [] };
  if (key === 'openable' && c.openable != null && isBag(c.reactions)) {
    const keep = Object.fromEntries(Object.entries(c.reactions).filter(([, h]) => !((h?.kind === 'toggle' && (h.component ?? 'openable') === 'openable') || (h?.kind === 'set' && h.component === 'openable'))));
    const rx = Object.keys(keep).length === Object.keys(c.reactions).length ? [] : [Object.keys(keep).length ? OP.set(id, 'reactions', keep) : OP.unset(id, 'reactions')];
    return { ops: [...rx, OP.unset(id, 'openable')], errors: [] };
  }
  if (key === 'captions') return { ops: [], errors: ['captions are written by the caption verb only'] };
  if (c[key] != null) return { ops: [OP.unset(id, key)], errors: [] };
  return { ops: [], errors: [`${id} has no component at ${key}`] };
}

/** What a viewport gesture (the gizmo) commits, as edits for editOps: the
 *  realized object's pose → the fields this thing HAS. mode 'move' sends the
 *  position, 'scale' the scale, 'rotate' the orientation: a full q
 *  (rot.qx…qw, normalized by editOps) — except a pure turn about +Y on a
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

// ---------------------------------------------------------------- edits → door ops (shared/protocol/requests.js)

/** Look a field up by dotted address. */
export function fieldAt(schema, key) {
  const dot = key.indexOf('.');
  if (dot < 0) return null;
  const g = schema.groups.find((x) => x.group === key.slice(0, dot));
  return g ? (g.fields.find((f) => f.k === key.slice(dot + 1)) ?? null) : null;
}

/** Turn edits into the fewest door ops that commit them (one gesture = one batch = one act). Numbers may be
 *  relative expressions; a field's hard min/max clamp; disabled fields
 *  refuse. Pure: never sends, never mutates `ent`. */
export function editOps(ent, id, edits, live = {}) {
  const schema = inspectSchema(ent, id, live);
  const errors = [];
  const ops = [];
  const c = ent?.comp ?? {};
  let place = null;                 // coalesced full pose
  // a child's channels are LOCAL to its parent (inspectSchema): the pose they
  // edit is the mount's, and a translate/rotate on it is written as a mount
  const L = localOf(ent, live.world ?? null);
  const pv = L.mounted ? { ...ent, pos: L.pos, q: L.q ?? undefined, yaw: L.yaw } : ent;
  let moved = false;                // a translate/rotate/heading edit (vs. scale alone)
  let posTyped = false;             // translate typed explicitly: the pivot never second-guesses a typed position
  let parented = null;              // a parent edit's { ops }
  // the place every transform edit coalesces into, carrying the full pose: a
  // thing with q keeps its q (a move is not a turn), a yaw-only thing its yaw
  const basePlace = () => (place ??= { id, pos: [...(pv.pos ?? [0, 0, 0])],
    ...(pv.q ? { q: [...pv.q] } : {}), yaw: pv.yaw ?? 0, scale: entScale(ent) ?? 1 });
  const rotSet = {};                // axis index → radians (the Rotate channels)
  const quatSet = {};               // component index → value (the Quaternion row)
  let headingSet = false;
  let euler = null;                 // the triple a Rotate edit composed: the viewer's next hint
  const asks = [];                  // needs (design §3): a choice to make, or a remove-both to confirm
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
      const r = group === 'add' ? addOps(ent, id, k, raw) : removeOps(ent, id, k, raw);
      errors.push(...r.errors); ops.push(...r.ops);
      if (r.choice) asks.push({ kind: 'choice', ...r.choice, key });
      if (r.confirm) asks.push({ kind: 'confirm', ...r.confirm, comp: r.confirm.key, key });   // key = the address to answer on
      continue;
    }
    // actions and creations that have no field row: comp.<any>, sockets.del,
    // a socket slot that does not exist yet (sockets.<new>|pos|1 declares it)
    const known = f || group === 'parent' || (group === 'pivot' && ['x', 'y', 'z', 'centre', 'base', 'reset'].includes(k)) || (group === 'comp' && k) || (group === 'sockets' && (k === 'del' || k.includes('|')))
      || ((group === 'picture' || group === 'sound') && !['upload'].includes(k));   // creation needs no row
    if (key === 'flags.guard') { errors.push('flags.guard: `guard` is merged into `lock` (PROTOCOL §5): set flags.lock'); continue; }   // an old habit, taught
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
        else { place.pos['xyz'.indexOf(k)] = round(n); moved = true; posTyped = true; }
        break;
      }
      case 'parent': {
        // design §3: parent it (or make it a root) where it stands — the same
        // edit the Hierarchy's drag commits (shared/hierarchy.js parentOps)
        if (k !== 'to' && k !== 'unparent') { errors.push(`${key}: no such field`); break; }
        if (!live.world) { errors.push(`${key}: parenting needs the world's records (live.world)`); break; }
        if (parented) { errors.push(`${key}: one parent edit at a time`); break; }
        const r = parentOps(live.world, id, k === 'unparent' ? null : raw);
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
        if (k === 'lock') flagsComp('lock', bool(raw) ? (c.lock && c.lock !== true ? c.lock : true) : null);   // re-checking keeps its level
        else if (k === 'lockLevel') { const v = String(raw ?? ''); if (!['builder', 'moderator', 'owner'].includes(v)) { errors.push(`flags.lockLevel: builder, moderator or owner (got ${JSON.stringify(raw)})`); break; } flagsComp('lock', v === 'builder' ? true : { rank: v }); }
        else if (k === 'hidden') flagsComp('hidden', bool(raw) ? true : null);
        else if (k === 'label') { const s = String(raw ?? '').trim(); flagsComp('label', s ? s.slice(0, 80) : null); }
        else if (k === 'description') { const s = String(raw ?? '').trim(); flagsComp('description', s || null); }
        break;
      }
      case 'light': {
        // the light component: merge into its bag, important/day stored only in their non-default state, validated once at
        // the end like picture/sound
        const b = bag('light', () => ({}));
        if (f.t === 'num') { const n = num(f, raw); if (n == null) break; b[k] = n; }
        else if (k === 'color') b.color = typeof raw === 'string' ? parseInt(raw.replace(/^#|^0x/, ''), 16) : raw;
        else if (k === 'important') { if (bool(raw)) b.important = true; else delete b.important; }
        else if (k === 'noon') { if (bool(raw)) b.day = false; else delete b.day; }
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
        else { const n = num(f, raw); if (n == null) break; next[param] = round(n, 4); if (param === 'degPerSec') { delete next.rpm; delete next.period; } if (param === 'amp') delete next.amplitude; }
        motions.set(mkey, next);
        break;
      }
      case 'sockets': {
        const next = comps.get('sockets') ?? JSON.parse(JSON.stringify(c.sockets ?? {}));
        if (k === 'del' && !next[raw]) { errors.push(`sockets.del: no slot ${JSON.stringify(raw)} on ${id}`); break; }
        if (k === 'del') { delete next[raw]; comps.set('sockets', Object.keys(next).length ? next : null); break; }
        const [slot, what, idx, sub] = k.split('|');
        const cur = next[slot] ?? (next[slot] = { pos: [0, 0.5, 0], body: {} });   // a new slot is a seat, as '+ seat' makes
        if (what === 'body') { if (bool(raw)) cur.body = cur.body ?? {}; else delete cur.body; comps.set('sockets', next); break; }
        if (what === 'action') { const v = String(raw).trim().toLowerCase(); if (!/^[a-z][a-z0-9-]{0,31}$/.test(v)) { errors.push(`sockets.${slot}|action: a verb in lower case (sit, ride)`); break; }
          cur.body = { ...(cur.body ?? {}), action: v }; if (v === 'sit') delete cur.body.action; comps.set('sockets', next); break; }
        // the rest of the body block: each field written the way the authority reads it (shared/sockbody.js), a default left
        // out, and the result checked with the authority's own check, so a refusal here reads as the authority's would
        const BODY = ['anchor', 'pose', 'leaveBy', 'who', 'fromSeat', 'enter', 'leave', 'input', 'look', 'reach', 'hold', 'poses', 'sync', 'approach', 'exit'];
        if (BODY.includes(what)) {
          const b = cur.body = { ...(cur.body ?? {}) };
          const d = ACTION_DEFAULTS[b.action ?? 'sit'] ?? ACTION_DEFAULTS.sit;
          const json = (v) => { if (v == null || v === '') return undefined; if (typeof v !== 'string') return v; const t = v.trim(); if (!/^[[{"]/.test(t)) return t; try { return JSON.parse(t); } catch (e) { errors.push(`sockets.${slot}|${what}: not valid JSON (${e.message})`); return null; } };
          const put = (key, v, dflt) => { if (v === undefined || v === dflt || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete b[key]; else b[key] = v; };
          if (what === 'anchor') put('anchor', String(raw), d.anchor);
          else if (what === 'pose') { const v = json(raw); if (v === null) break; put('pose', v, d.pose); }
          else if (what === 'leaveBy') put('leaveBy', String(raw), 'any');
          else if (what === 'who') { const v = String(raw); put('who', v === 'visitor' ? 'anyone' : v, 'anyone'); }
          else if (what === 'fromSeat') put('fromSeat', bool(raw) || undefined, undefined);
          else if (what === 'enter' || what === 'leave' || what === 'sync') put(what, String(raw ?? '').trim() || undefined, undefined);
          else if (what === 'input') { const inp = { ...(b.input ?? {}) }; if (!['move', 'look'].includes(idx)) { errors.push(`sockets.${slot}|input|${idx}: input is move or look`); break; }
            inp[idx] = String(raw); if (inp[idx] === (idx === 'move' ? 'none' : 'free')) delete inp[idx]; put('input', inp, undefined); }
          else if (what === 'look') { const lk = { ...(b.look ?? {}) };
            if (idx === 'up') { lk.up = String(raw); if (lk.up === 'world') delete lk.up; }
            else if (idx === 'yaw' || idx === 'pitch') { const lim = idx === 'yaw' ? 180 : 90; const n = num(f ?? { value: (lk[idx] ?? [-lim, lim])[+sub] ?? 0, k }, raw); if (n == null) break;
              const r = [...(lk[idx] ?? [-lim, lim])]; r[+sub] = round(n, 2); lk[idx] = r; if (r[0] === -lim && r[1] === lim) delete lk[idx]; }
            else { errors.push(`sockets.${slot}|look|${idx}: look is yaw|0..1, pitch|0..1, up`); break; }
            put('look', lk, undefined); }
          else { const v = json(raw); if (v === null) break; put(what, v, undefined); }
          const bad = checkSockets(next);
          if (bad) { errors.push(`sockets.${slot}|${what}: ${bad.reason}${bad.fix ? ` — ${bad.fix}` : ''}`); break; }
          comps.set('sockets', next); break;
        }
        const n = num(f ?? { value: what === 'rot' ? sockRot(cur)[+idx] : (cur.pos ?? [0, 0.5, 0])[+idx] ?? 0, deg: what === 'rot', k }, raw); if (n == null) break;
        if (what === 'pos') { cur.pos = [...(cur.pos ?? [0, 0.5, 0])]; cur.pos[+idx] = round(n); }
        else if (what === 'rot') { const q = setEulerChannel(socketQ(cur), 'ZXY', sockRot(cur), +idx, n).q.map((v) => round(v, 6)); delete cur.yaw;
          if (Math.abs(q[3]) > 1 - 1e-12) delete cur.q; else cur.q = q; }
        else { errors.push(`sockets.${slot}|${what}: not a socket field (pos|0..2, rot|0..2, body, action, anchor, pose, leaveBy, who, fromSeat, enter, leave, input|move, input|look, look|yaw|0..1, look|pitch|0..1, look|up, reach, hold, poses, sync, approach, exit)`); break; }
        comps.set('sockets', next);
        break;
      }
      case 'openable': {
        const next = comps.get('openable') ?? JSON.parse(JSON.stringify(c.openable ?? {}));
        if (k === 'hingeL' || k === 'hingeR') { const box = live.box; if (!Array.isArray(box)) { errors.push(`${key}: its box isn't known yet`); break; }
          comps.set('pivot', { pos: [round(k === 'hingeL' ? box[0][0] : box[1][0], 4), round(box[0][1], 4), round((box[0][2] + box[1][2]) / 2, 4)] }); break; }
        if (k === 'open' || k === 'locked') next[k] = bool(raw);
        else if (k === 'by') { if (raw === 'slide') { delete next.angle; delete next.axis; next.slide = Array.isArray(next.slide) ? next.slide : [0.9, 0, 0]; } else if (raw === 'turn') { delete next.slide; next.angle = Number.isFinite(next.angle) ? next.angle : round(Math.PI / 2, 6); } else { errors.push(`${key}: turn or slide`); break; } }
        else if (k === 'axis') { if (!AXES[String(raw).toLowerCase()]) { errors.push(`${key}: axis must be one of ${Object.keys(AXES).join(' ')}`); break; } next.axis = String(raw).toLowerCase(); }
        else if (k.startsWith('slide|')) { const n = num(f, raw); if (n == null) break; next.slide = [...(Array.isArray(next.slide) ? next.slide : [0, 0, 0])]; next.slide[+k.slice(6)] = round(n, 4); }
        else if (k === 'angle' || k === 'time') { const n = num(f, raw); if (n == null) break; next[k] = round(n, 6); }
        else { errors.push(`${key}: no such field`); break; }
        comps.set('openable', next);
        break;
      }
      case 'grabbable': {
        const next = comps.get('grabbable') ?? JSON.parse(JSON.stringify(c.grabbable ?? {}));
        if (['enabled', 'steal', 'twoHanded', 'carries'].includes(k)) next[k] = bool(raw);
        else if (['range', 'priority', 'throw', 'returnAfter'].includes(k)) { const n = num(f, raw); if (n == null) break; next[k] = k === 'priority' ? Math.round(n) : round(n); }
        else if (k === 'pose') { if (raw === 'by size' || raw == null || raw === '') delete next.pose; else next.pose = String(raw); }
        else if (k === 'fits') { const w = String(raw ?? '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean); if (w.length) next.fits = w; else delete next.fits; }
        else if (k === 'use') { const [d, u] = String(raw ?? '').split('/').map((x) => x.trim()); if (!d && !u) delete next.use; else next.use = u ? { ...(d ? { down: d } : {}), up: u } : d; }
        else if (k === 'prompt') { const v = String(raw ?? '').trim(); if (v) next.prompt = v; else delete next.prompt; }
        else next[k] = raw;
        const bad = checkGrabbable(next);
        if (bad) { errors.push(`grabbable.${k}: ${bad.reason}${bad.fix ? ` — ${bad.fix}` : ''}`); break; }
        comps.set('grabbable', next);
        break;
      }
      case 'particles': {
        if (k === 'out') { comps.set('particles', null); break; }
        const next = modernize(comps.get('particles') ?? { ...c.particles });   // an older value is written back in today's shape
        if (k.startsWith('at|')) { const n = num(f, raw); if (n == null) break; next.at = [...(next.at ?? [0, 0, 0])]; next.at[+k.slice(3)] = round(n); }
        else if (k.startsWith('param|')) { const name = k.slice(6); const v = f?.t === 'num' ? num(f, raw) : f?.t === 'check' ? bool(raw) : f?.t === 'color' ? (typeof raw === 'string' ? parseInt(raw.replace(/^#|^0x/i, ''), 16) : +raw) : String(raw ?? '').trim();
          if (v == null || v === '') { const { [name]: _, ...rest } = next.params ?? {}; if (Object.keys(rest).length) next.params = rest; else delete next.params; }
          else next.params = { ...(next.params ?? {}), [name]: f?.t === 'num' ? round(v) : v }; }
        else if (k === 'scale') { const n = num(f, raw); if (n == null) break; next.scale = round(n); }
        else if (k === 'playing') next.playing = bool(raw);
        else if (k === 'part') { const v = String(raw ?? '').trim(); if (v) next.part = v; else delete next.part; }
        else if (k === 'effect') { if (String(raw) !== next.effect) { next.effect = String(raw); delete next.params; } }   // another effect's knobs aren't these
        else { errors.push(`${key}: no such field`); break; }
        // the authority's rules, here first (a known effect: an Essential, or a stored one the viewer has)
        const doc = effectFor(next.effect, live.effects ?? (() => null)); const bad = doc || ESSENTIAL_NAMES.includes(next.effect) ? instanceProblem(next, doc) : null;
        if (bad) { errors.push(`particles.${k}: ${bad}`); break; }
        comps.set('particles', next);
        break;
      }
      case 'picture': {
        if (k === 'down') { bags.set('picture', null); break; }
        const b = bag('picture', () => ({})); if (!b) { errors.push('picture: taken down in this same edit'); break; }
        if (!['part', 'src', 'alt', 'lit', 'flip', 'width'].includes(k)) { errors.push(`${key}: no such field`); break; }
        if (k === 'flip') b.flip = bool(raw);
        else if (k === 'width') { const n = num(f ?? { value: b.width ?? 1, min: 0.05, max: 20 }, raw); if (n == null) break; b.width = round(n); }
        else { const v = String(raw ?? '').trim(); if (v) b[k] = v; else if (k === 'alt' || k === 'part') delete b[k]; else b[k] = v; }
        break;
      }
      case 'sound': {
        if (k === 'silence') { bags.set('sound', null); break; }
        if (k === 'rings') {   // "plays when used": a reaction {ring: {kind: 'play'}}, beside whatever else it reacts to
          const rx = { ...(comps.get('reactions') ?? (isBag(c.reactions) ? c.reactions : {})) };
          if (bool(raw)) { if (!Object.values(rx).some((h) => h?.kind === 'play')) rx[rx.ring ? 'play' : 'ring'] = { kind: 'play' }; }
          else for (const [a, h] of Object.entries(rx)) if (h?.kind === 'play') delete rx[a];
          comps.set('reactions', Object.keys(rx).length ? rx : null); break; }
        // a new sound plays (R 10-07: no start-paused; its radius keeps it to its place)
        const b = bag('sound', () => ({ playing: true, loop: true, volume: 0.8, radius: 12 })); if (!b) { errors.push('sound: silenced in this same edit'); break; }
        // play and restart send no t0: the authority stamps it (shared/protocol/authority.js stampMedia), on its clock, for everyone
        if (k === 'play') { b.playing = true; delete b.t0; }
        else if (k === 'pause') { b.playing = false; }
        else if (k === 'loop' || k === 'spatial') b[k] = bool(raw);
        else if (['volume', 'radius', 'near', 'pitch'].includes(k)) { const lim = { volume: [0, 1, 0.8], radius: [1, SOUND_MAX_RADIUS, 12], near: [0.1, SOUND_MAX_RADIUS, 1.5], pitch: [0.5, 2, 1] }[k];
          const n = num(f ?? { value: b[k] ?? lim[2], min: lim[0], max: lim[1] }, raw); if (n == null) break; b[k] = round(n); }
        else if (k === 'src' || k === 'alt') { const v = String(raw ?? '').trim(); if (v) b[k] = v; else if (k === 'alt') delete b.alt; else b[k] = v; }
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
        const n = f ? num(f, raw) : (Number.isFinite(+raw) ? +raw : (errors.push(`${key}: not a number (${JSON.stringify(raw)})`), null)); if (n == null) break;   // no pivot yet: the first write makes one
        cur['xyz'.indexOf(k)] = round(n, 4); comps.set('pivot', { pos: cur }); break;
      }
      case 'look-at': {
        // look-at.<k> (the whole thing) or look-at.<part>|<k>; target@ is the chips (@viewer, @nearest)
        const bar = k.lastIndexOf('|'); const part = bar >= 0 ? k.slice(0, bar) : null; const fk = bar >= 0 ? k.slice(bar + 1) : k;
        const ck = part ? `look-at:${part}` : 'look-at';
        const next = { ...(comps.get(ck) ?? (isBag(c[ck]) ? c[ck] : {})) };
        if (fk === 'target' || fk === 'target@') { if (raw == null || raw === '') { if (fk === 'target') { comps.set(ck, null); break; } else break; } next.target = String(raw); }
        else if (fk === 'mode' || fk === 'forward' || fk === 'up') next[fk] = String(raw);
        else if (fk === 'speed' || fk === 'range') { const n = num(f ?? { value: next[fk] ?? (fk === 'speed' ? 240 : 12), min: fk === 'speed' ? 0 : 0.1, max: fk === 'speed' ? 3600 : 100 }, raw); if (n == null) break; next[fk] = round(n); }
        else { errors.push(`${key}: no such field`); break; }
        comps.set(ck, next); break;
      }
      case 'story': case 'text': {
        const next = { ...(comps.get(group) ?? (isBag(c[group]) ? c[group] : {})) };
        if (group === 'story' && k === 'marks') { const ids = String(raw ?? '').split(/[\s,]+/).filter(Boolean); if (ids.length) next.marks = ids; else delete next.marks; }
        else if (k === 'title' || k === 'text') next[k] = String(raw ?? '');
        else if (group === 'text' && (k === 'size' || k === 'width')) { const n = num(f, raw); if (n == null) break; next[k] = round(n); }
        else if (group === 'text' && (k === 'color' || k === 'background')) { const n = typeof raw === 'string' ? parseInt(raw.replace(/^#|^0x/i, ''), 16) : +raw; if (!Number.isInteger(n) || n < 0 || n > 0xffffff) { errors.push(`${key}: a colour 0xRRGGBB`); break; } next[k] = n; }
        else if (group === 'text' && k === 'plate') { if (bool(raw)) next.background = Number.isInteger(next.background) ? next.background : 0x202020; else delete next.background; }
        else if (group === 'text' && k === 'outline') next.outline = bool(raw);
        else if (group === 'text' && ['align', 'billboard', 'lit'].includes(k)) next[k] = String(raw);
        else { errors.push(`${key}: no such field`); break; }
        // the authority's rules, here first (the same catalogue): a refusal is a hint before any round-trip
        const lim = SPEC[group].ranges; for (const [fk, r] of Object.entries(lim)) if (typeof next[fk] === 'string' && r.maxLen && graphemes(next[fk]) > r.maxLen) errors.push(`${group}.${fk}: ${graphemes(next[fk])} characters; at most ${r.maxLen}`);
        comps.set(group, next); break;
      }
      case 'script': {   // the switch: only {paused}, merged (needs no knowledge of the script; adopts nothing)
        if (!isBag(c[`script:${k}`])) { errors.push(`${key}: no script:${k} on ${id}`); break; }
        ops.push(OP.set(id, `script:${k}`, { paused: bool(raw) }, { merge: true }));
        break;
      }
      case 'comp': {
        if (k === '+') { const type = String(raw ?? '').trim(); if (!type) break;
          // a component's own name ("Openable", "openable", "look-at") is Add Component, needs and defaults included — the
          // same ops a person's menu writes (review 10-07 B4: comp.+ "Openable" minted a junk x--… component instead)
          const rec = Object.keys(RECORDS).find((n) => n.toLowerCase() === type.toLowerCase().replace(/[-_ ]/g, ''));
          if (rec && !RECORDS[rec].world && !RECORDS[rec].readOnly) { const r = addOps(ent, id, rec); errors.push(...r.errors); ops.push(...r.ops); if (r.choice) asks.push({ kind: 'choice', ...r.choice, key: `add.${rec}` }); break; }
          if (!/^([a-z0-9.-]+\/)?[a-z][a-z0-9-]*$/.test(type)) { errors.push(`comp.+: '${type}' isn't a component name (lowercase a–z, 0–9 and '-'; one of your own carries a namespace, e.g. 'example.org/${type.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}'); Add Component's names are ${Object.keys(RECORDS).filter((n) => !RECORDS[n].world).join(', ')}`); break; }
          if (c[type] != null) { errors.push(`${id} already has ${type}`); break; } comps.set(type, {}); break; }
        if (raw == null || raw === '') { comps.set(k, null); break; }
        let data = raw;
        if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch (e) { errors.push(`comp.${k}: not valid JSON (${e.message})`); break; } }
        // the JSON door is not a way around the evaluators' rules — nor the authority's
        if ((k === 'light' || k === 'collider') && compRefusal(k, data, ent)) { errors.push(`comp.${k}: ${compRefusal(k, data, ent)}`); break; }
        if (k === 'grabbable' && data != null) { const bad = checkGrabbable(data); if (bad) { errors.push(`comp.grabbable: ${bad.reason}`); break; } }
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
  // the pivot (research 52; Maya's channel box): a rotate or scale edit goes ABOUT the pivot, so the position moves to
  // keep the pivot where it was (agent lab round 2, Rowan: 'edit rot.y +=90' turned the gate about its origin). A typed
  // translate in the same edit wins. The same frame for a root and a child: pos/q/scale here are the local pose.
  const pivp = Array.isArray(c.pivot?.pos) && c.pivot.pos.length === 3 ? c.pivot.pos : null;
  if (place && pivp && !posTyped) {
    const q0 = qNorm(pv.q) ?? qFromYaw(pv.yaw ?? 0); const q1 = qNorm(place.q) ?? (headingSet && pv.q ? qWithHeading(pv.q, place.yaw) : qFromYaw(place.yaw ?? 0));
    const s0 = scale3(entScale(ent) ?? 1), s1 = scale3(place.scale ?? 1);
    const before = qRotate(q0, pivp.map((v, i) => v * s0[i])), after = qRotate(q1, pivp.map((v, i) => v * s1[i]));
    const d = before.map((v, i) => v - after[i]);
    if (d.some((v) => Math.abs(v) > 1e-9)) { place.pos = place.pos.map((v, i) => round(v + d[i])); moved = true; }
  }
  if (parented && place) { errors.push('parent: a parent edit goes alone — move it before or after, not in the same edit'); place = null; parented = null; }
  if (parented) ops.push(...parented.ops);
  // one whole transform (§2.3): local to the parent for a child, which is the pose the channels edit (pv)
  if (place) ops.push(OP.set(id, 'transform', OP.transformOf(pv, { pos: place.pos, ...(place.q ? { q: place.q } : place.yaw != null ? { yaw: place.yaw } : {}), scale: place.scale })));
  for (const [mkey, next] of motions) ops.push(next ? OP.set(id, mkey, next) : OP.unset(id, mkey));
  for (const [type, data] of comps) { if (data == null) { if (c[type] != null) ops.push(OP.unset(id, type)); } else ops.push(OP.set(id, type, type === 'lock' && data !== true && !(data && typeof data === 'object' && LOCK_LEVEL(data) === data.rank) ? true : data)); }
  return { ops, errors, ...(euler ? { euler } : {}), ...(asks.length ? { asks } : {}), };
}

/** A one-screen text rendering of the schema — what a model reads. */
export function describeSchema(schema, { verbsHint = true } = {}) {
  const L = [];
  for (const g of schema.groups) {
    if (!g.fields.length) continue;
    L.push(`${g.label ?? g.group} (${g.group}.* → set ${g.types?.join(', ') ?? ({ pos: 'transform', rot: 'transform', parent: 'parent + transform', flags: 'lock / hidden / label', comp: 'the named component' })[g.group] ?? g.group})`);
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
