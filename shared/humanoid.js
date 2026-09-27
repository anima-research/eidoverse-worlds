// shared/humanoid.js — the VRM humanoid bone vocabulary, and what counts as a
// well-formed pose over it.
//
// Why this exists: `pose` is the one tool that lets a body be put in a shape
// nothing else can express, and until now it accepted ANY object. A typo'd
// bone name, a quaternion with three components, a [0,0,0,0] — all were taken
// silently, rode the presence packet, and did nothing on every renderer. The
// author's only feedback was a snapshot round-trip through a GPU host, which
// is not a feedback loop anyone can pose a body with.
//
// So: one vocabulary, one validator, three runtimes. The bone list is VRM 1.0's
// (three-vrm normalizes VRM0 rigs onto these names, so this is what
// `getNormalizedBoneNode` answers to on both).

/** Bones every humanoid rig has. */
export const REQUIRED_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
];

/** Bones a rig MAY have. Absent ones are not an error — they are a fact about
 *  that body, and a pose naming one simply lands nowhere on that rig. */
export const OPTIONAL_BONES = [
  'upperChest', 'leftShoulder', 'rightShoulder',
  'leftToes', 'rightToes', 'leftEye', 'rightEye', 'jaw',
];

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const SEGMENTS = ['Metacarpal', 'Proximal', 'Intermediate', 'Distal'];

/** The 30 finger bones. Thumb takes Metacarpal/Proximal/Distal; the other four
 *  take Proximal/Intermediate/Distal. (VRM 1.0's naming — VRM0's thumb used
 *  Proximal/Intermediate/Distal, and three-vrm remaps it on load.) */
export const FINGER_BONES = (() => {
  const out = [];
  for (const side of ['left', 'right']) {
    for (const f of FINGERS) {
      const segs = f === 'Thumb'
        ? ['Metacarpal', 'Proximal', 'Distal']
        : ['Proximal', 'Intermediate', 'Distal'];
      for (const s of segs) out.push(`${side}${f}${s}`);
    }
  }
  return out;
})();

/** Every bone name a VRM humanoid can carry. */
export const HUMANOID_BONES = [...REQUIRED_BONES, ...OPTIONAL_BONES, ...FINGER_BONES];
const HUMANOID_SET = new Set(HUMANOID_BONES);

const BY_KEY = new Map();
for (const b of HUMANOID_BONES) BY_KEY.set(b.toLowerCase(), b);

/** Names people reach for that the spec does not use. Kept deliberately short:
 *  this resolves genuine synonyms from other rig conventions (Mixamo, Blender
 *  Rigify, VRChat docs), not guesses. Anything not here gets a suggestion
 *  instead, so a wrong name is never silently turned into a different bone. */
const ALIASES = {
  leftarm: 'leftUpperArm', rightarm: 'rightUpperArm',
  leftforearm: 'leftLowerArm', rightforearm: 'rightLowerArm',
  leftelbow: 'leftLowerArm', rightelbow: 'rightLowerArm',
  leftknee: 'leftLowerLeg', rightknee: 'rightLowerLeg',
  leftthigh: 'leftUpperLeg', rightthigh: 'rightUpperLeg',
  leftshin: 'leftLowerLeg', rightshin: 'rightLowerLeg',
  leftwrist: 'leftHand', rightwrist: 'rightHand',
  leftankle: 'leftFoot', rightankle: 'rightFoot',
  pelvis: 'hips', root: 'hips', torso: 'chest', spine1: 'chest', spine2: 'upperChest',
};

/** Fold a written name to its canonical form: case, separators and a few
 *  cross-rig synonyms. Returns null if it is not a humanoid bone at all. */
export function canonicalBone(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase().replace(/[\s_.-]/g, '');
  return BY_KEY.get(key) ?? ALIASES[key] ?? null;
}

/** Levenshtein, bounded — only ever run over 55 short strings. */
function distance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** The closest real bone name to something that isn't one — so a rejection can
 *  say "did you mean", which is the difference between a wall and a hint. */
export function suggestBone(name) {
  if (typeof name !== 'string' || !name) return null;
  const key = name.trim().toLowerCase().replace(/[\s_.-]/g, '');
  let best = null, bestD = 4;
  for (const b of HUMANOID_BONES) {
    const d = distance(key, b.toLowerCase());
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

const EPS = 1e-6;

/** Check and clean one quaternion. Returns {q} or {why}. */
export function normalizeQuat(v) {
  if (!Array.isArray(v)) return { why: 'not an array — want [x,y,z,w]' };
  if (v.length !== 4) return { why: `${v.length} components — want 4, [x,y,z,w]` };
  const n = v.map(Number);
  if (!n.every(Number.isFinite)) return { why: 'has a non-finite component' };
  const len = Math.hypot(n[0], n[1], n[2], n[3]);
  if (len < EPS) return { why: 'zero length — a quaternion needs a direction' };
  // Always normalize; only SAY so when the input was off unit by enough to
  // mean something. Hand-written quaternions land a couple of thousandths
  // out (this repo's own DOWNED_POSE does), and reporting that is noise
  // that trains the reader to ignore the line the real problems arrive on.
  const off = Math.abs(len - 1);
  return { q: off <= 1e-9 ? n : n.map((c) => c / len), renormalized: off > 1e-2 };
}

/**
 * One bone's entry in a held pose, read into its channels. A pose value is
 * either the original bare quaternion `[x,y,z,w]`, or `{q?, t?, s?}`:
 *   q  rotation [x,y,z,w] — the parent-relative rotation, as ever
 *   t  translation [x,y,z] in model metres (Y up, +Z forward), measured in the
 *      parent's rest axes turned by the parent's pose; on hips, plain model
 *      space — `{t:[0,-0.3,0]}` on hips lowers the body 30 cm
 *   s  scale in the bone's own axes: [x,y,z], or one number for uniform
 * Returns `{q, t, s}` with absent channels null, or null when nothing in the
 * value is usable. Every consumer that only understands rotations reads `.q`.
 */
export function poseChannels(v) {
  const fin = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (fin(v, 4)) return { q: v, t: null, s: null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const q = fin(v.q, 4) ? v.q : null;
  const t = fin(v.t, 3) ? v.t : null;
  const s = fin(v.s, 3) ? v.s : (typeof v.s === 'number' && Number.isFinite(v.s) ? [v.s, v.s, v.s] : null);
  return q || t || s ? { q, t, s } : null;
}

/**
 * Posing only the bones you name. `base` is the pose being held (or null),
 * `delta` the new bones; a bone whose value is null in `delta` is RELEASED
 * back to the clip. Returns a new object, or null when nothing is left held.
 *
 * Merge is what sitting already did for free — a sit is a clip, and a pose
 * composes over a clip — and what a held pose did not: posing an arm while
 * kneeling replaced the kneel, and the body stood up.
 */
export function mergePose(base, delta) {
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [k, v] of Object.entries(delta ?? {})) {
    if (v == null) delete out[k]; else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Check and clean one pose value: a bare quaternion, or {q?, t?, s?}.
 *  Returns {value, renormalized} or {why}. The value comes back in the
 *  smallest form that says it — a bare array when only q was given. */
export function normalizePoseValue(v) {
  if (Array.isArray(v)) {
    const q = normalizeQuat(v);
    return q.why ? { why: q.why } : { value: q.q, renormalized: q.renormalized };
  }
  if (!v || typeof v !== 'object') return { why: 'want [x,y,z,w], or {q, t, s}' };
  const extra = Object.keys(v).filter((k) => !['q', 't', 's'].includes(k));
  if (extra.length) return { why: `unknown channel ${extra.map((k) => `"${k}"`).join(', ')} — want q (rotation), t (translation), s (scale)` };
  const out = {};
  let renormalized = false;
  if (v.q != null) {
    const q = normalizeQuat(v.q);
    if (q.why) return { why: `q: ${q.why}` };
    out.q = q.q; renormalized = q.renormalized;
  }
  if (v.t != null) {
    if (!Array.isArray(v.t) || v.t.length !== 3 || !v.t.map(Number).every(Number.isFinite)) return { why: 't: want [x,y,z] in metres' };
    out.t = v.t.map(Number);
  }
  if (v.s != null) {
    const s = typeof v.s === 'number' ? [v.s, v.s, v.s] : v.s;
    if (!Array.isArray(s) || s.length !== 3 || !s.map(Number).every(Number.isFinite)) return { why: 's: want one number, or [x,y,z]' };
    if (!s.every((c) => Number(c) > 0)) return { why: 's: every component must be above 0 — 0 collapses the bone, a negative mirrors it' };
    out.s = typeof v.s === 'number' ? Number(v.s) : s.map(Number);
  }
  if (!('q' in out) && !('t' in out) && !('s' in out)) return { why: 'empty — give at least one of q, t, s' };
  return { value: 't' in out || 's' in out ? out : out.q, renormalized };
}

/** The closest name in a list, for a "did you mean" over a rig's own bones. */
function nearest(name, names) {
  const key = String(name).toLowerCase();
  let best = null, bestD = 4;
  for (const n of names) {
    const d = distance(key, n.toLowerCase());
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/**
 * Validate a sparse pose map, reporting everything it did rather than
 * silently keeping the good parts.
 *
 * Names resolve in this order: an exact VRM humanoid name; then an exact bone
 * of the rig (`opts.rig`) — a raw humanoid bone reads as its VRM name, any
 * other is kept as a CUSTOM bone; then humanoid synonyms ("forearm"). Exact
 * rig names outrank synonyms because rigs reuse them: mythos-alpha has a real
 * `Pelvis` below its hips, and folding that onto `hips` would pose the wrong
 * bone without a word. Bones ABOVE the hips are refused: the body's place
 * comes from hips every frame, so posing them would be undone.
 *
 * @param {unknown} bones raw input, straight off the wire or a tool call
 * @param {{known?: string[]|null, rig?: {bones: string[], humanoidOf: Record<string,string>,
 *          aboveHips?: string[]}|null}} [opts]
 *        `known` = the humanoid bones THIS rig has (a valid name it lacks is
 *        `absent`); `rig` = every bone it has. Without a rig, a name that is
 *        no humanoid bone and no likely typo of one is kept but `unchecked`.
 * A null value RELEASES that bone (listed in `released`, kept as null in
 * `pose` for mergePose), after the same name checks — a typo'd release is
 * as silent a failure as a typo'd pose.
 *
 * @returns {{pose: Record<string, number[]|object|null>, accepted: string[], released: string[], custom: string[],
 *            unchecked: string[], renamed: Array<{from: string, to: string}>,
 *            renormalized: string[], absent: string[],
 *            rejected: Array<{name: string, why: string, suggest?: string}>}}
 */
export function validatePose(bones, opts = {}) {
  const out = {
    pose: {}, accepted: [], released: [], custom: [], unchecked: [], renamed: [], renormalized: [], absent: [], rejected: [],
  };
  if (!bones || typeof bones !== 'object' || Array.isArray(bones)) {
    out.rejected.push({ name: '(whole pose)', why: 'want an object mapping bone name to [x,y,z,w] or {q, t, s}' });
    return out;
  }
  const rig = opts.rig ?? null;
  const rigBones = rig ? new Set(rig.bones) : null;
  const above = new Set(rig?.aboveHips ?? []);
  const known = opts.known ? new Set(opts.known)
    : rig ? new Set(Object.values(rig.humanoidOf ?? {})) : null;
  for (const [raw, v] of Object.entries(bones)) {
    let name = null, isCustom = false, isUnchecked = false;
    if (HUMANOID_SET.has(raw)) name = raw;
    else if (rigBones?.has(raw)) {
      if (above.has(raw)) {
        out.rejected.push({ name: raw, why: 'sits above the hips — the body is placed from hips every frame, so move hips ({t: [x,y,z]}) instead' });
        continue;
      }
      name = rig.humanoidOf?.[raw] ?? raw;
      isCustom = !rig.humanoidOf?.[raw];
    } else name = canonicalBone(raw);
    if (!name) {
      const suggest = suggestBone(raw);
      if (rigBones || suggest) {
        const near = rigBones ? nearest(raw, rig.bones) : null;
        out.rejected.push({ name: raw, why: rigBones ? 'not a bone of this rig' : 'not a VRM humanoid bone',
          ...((near ?? suggest) ? { suggest: near ?? suggest } : {}) });
        continue;
      }
      name = raw; isCustom = true; isUnchecked = true;   // no rig to check against
    }
    if (v === null) {                  // release this bone (a merge — shared/humanoid.js mergePose)
      if (name in out.pose) { out.rejected.push({ name: raw, why: `also names ${name}, already set here — one bone, one value` }); continue; }
      if (name !== raw) out.renamed.push({ from: raw, to: name });
      out.pose[name] = null; out.released.push(name);
      continue;
    }
    const pv = normalizePoseValue(v);
    if (pv.why) { out.rejected.push({ name: raw, why: pv.why }); continue; }
    if (!isCustom && known && !known.has(name)) { out.absent.push(name); continue; }
    // Two written names can fold to one bone ("leftElbow" and "LeftLowerArm").
    // Last-write-wins would drop one of them without a word — the exact silent
    // overwrite this module exists to stop. Keep the first, name the clash.
    if (name in out.pose) {
      out.rejected.push({ name: raw, why: `also names ${name}, already set here — one bone, one value` });
      continue;
    }
    if (name !== raw) out.renamed.push({ from: raw, to: name });
    if (pv.renormalized) out.renormalized.push(name);
    out.pose[name] = pv.value;
    out.accepted.push(name);
    if (isCustom) out.custom.push(name);
    if (isUnchecked) out.unchecked.push(name);
  }
  return out;
}

/** One line an agent can read back and act on. Empty string when a pose was
 *  taken exactly as written — silence means nothing went wrong. */
export function poseReport(v) {
  const bits = [];
  // Tolerant of either validator's result shape — validateTracks has no
  // `renormalized`, and a caller should never have to rebuild a record to
  // ask for a sentence about it.
  const renamed = v?.renamed ?? [], renormalized = v?.renormalized ?? [];
  const absent = v?.absent ?? [], rejected = v?.rejected ?? [];
  if (renamed.length) bits.push(`read ${renamed.map((r) => `${r.from}→${r.to}`).join(', ')}`);
  if (renormalized.length) bits.push(`normalized ${renormalized.join(', ')}`);
  if (absent.length) bits.push(`your rig has no ${absent.join(', ')} — those did nothing`);
  const unchecked = v?.unchecked ?? [];
  if (unchecked.length) bits.push(`could not check ${unchecked.join(', ')} against the rig — a bone it lacks does nothing`);
  for (const r of rejected) {
    bits.push(`dropped ${r.name}: ${r.why}${r.suggest ? ` (did you mean ${r.suggest}?)` : ''}`);
  }
  return bits.join('; ');
}

/**
 * Validate keyframe tracks for a one-off animation — the same vocabulary
 * check as a pose, plus the time axis. Keys are sorted by `t`; a track whose
 * keyframes are all unusable is dropped with a reason rather than sent as an
 * empty track that plays as a freeze.
 *
 * @param {unknown} tracks bone -> [{t, q:[x,y,z,w]}]
 * @param {{known?: string[]|null, maxKeys?: number}} [opts]
 */
export function validateTracks(tracks, opts = {}) {
  const out = { tracks: {}, accepted: [], renamed: [], absent: [], rejected: [] };
  if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) {
    out.rejected.push({ name: '(tracks)', why: 'want an object mapping bone name to [{t, q}]' });
    return out;
  }
  const known = opts.known ? new Set(opts.known) : null;
  const maxKeys = opts.maxKeys ?? 64;
  for (const [raw, keys] of Object.entries(tracks)) {
    const name = canonicalBone(raw);
    if (!name) {
      const suggest = suggestBone(raw);
      out.rejected.push({ name: raw, why: 'not a VRM humanoid bone', ...(suggest ? { suggest } : {}) });
      continue;
    }
    if (known && !known.has(name)) { out.absent.push(name); continue; }
    if (name in out.tracks) {
      out.rejected.push({ name: raw, why: `also names ${name}, already tracked here — one bone, one track` });
      continue;
    }
    if (!Array.isArray(keys) || !keys.length) {
      out.rejected.push({ name: raw, why: 'want a non-empty list of {t, q} keyframes' });
      continue;
    }
    if (keys.length > maxKeys) {
      out.rejected.push({ name: raw, why: `${keys.length} keyframes — keep it under ${maxKeys}` });
      continue;
    }
    const clean = [];
    let bad = null;
    for (const k of keys) {
      const t = Number(k?.t);
      if (!Number.isFinite(t) || t < 0) { bad ??= 'a keyframe has no finite t >= 0'; continue; }
      const q = normalizeQuat(k?.q);
      if (q.why) { bad ??= `a keyframe's q is ${q.why}`; continue; }
      clean.push({ t, q: q.q });
    }
    if (!clean.length) { out.rejected.push({ name: raw, why: bad ?? 'no usable keyframes' }); continue; }
    clean.sort((x, y) => x.t - y.t);
    if (bad) out.rejected.push({ name: raw, why: `${bad} — kept the ${clean.length} that parsed` });
    if (name !== raw) out.renamed.push({ from: raw, to: name });
    out.tracks[name] = clean;
    out.accepted.push(name);
  }
  return out;
}

/** The latest keyframe time across every track — the duration an animation
 *  actually needs, so a caller can be told when `dur` cuts its own motion off. */
export function tracksSpan(tracks) {
  let end = 0;
  for (const keys of Object.values(tracks ?? {})) {
    for (const k of keys) if (Number.isFinite(k?.t)) end = Math.max(end, k.t);
  }
  return end;
}
