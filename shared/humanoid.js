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
/** The wing chains, by the same naming contract flight and the ragdoll use:
 *  `<side>_Wing_<row>` then `_1`, `_2` outward. Identical to
 *  shared/flightbody.js's WING_RE, deliberately not imported -- this module is
 *  the vocabulary and must not depend on flight to describe a bone. */
export const WING_RE = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/;

/** True for a bone this module accepts but does NOT own a humanoid name for.
 *
 *  Wings are RAW bones: VRM's humanoid vocabulary has no word for them, so
 *  `canonicalBone` returned null and the pose verb answered "not a VRM
 *  humanoid bone" -- correct, and useless to an agent with wings who wants to
 *  move them. They are addressable because the rig NAMES them, which is the
 *  same contract by which hair and wings reach the springbone and ragdoll
 *  systems (rigtest/EIDOVERSE-DEPLOY.md: "the pipeline recognises bones by
 *  NAME and nothing else").
 *
 *  Case-SENSITIVE, unlike the humanoid names. Those are a vocabulary this
 *  module owns and can spell forgivingly; a raw bone name is a fact about one
 *  body's skeleton, and `l_wing_upper` is not a bone that exists. Accepting a
 *  near-miss would resolve to nothing at the client and report success. */
export const isRawBone = (name) => typeof name === 'string' && WING_RE.test(name);

export function canonicalBone(name) {
  if (typeof name !== 'string') return null;
  // A raw bone is already canonical: it names itself, exactly.
  if (isRawBone(name)) return name;
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
 * Validate a sparse pose map, reporting everything it did rather than
 * silently keeping the good parts.
 *
 * @param {unknown} bones raw input, straight off the wire or a tool call
 * @param {{known?: string[]|null}} [opts] `known` = the bones THIS rig actually
 *        has, when the caller knows them; a valid name missing from the rig is
 *        reported as `absent` rather than accepted into a pose that can't land.
 * @returns {{pose: Record<string, number[]>, accepted: string[],
 *            renamed: Array<{from: string, to: string}>,
 *            renormalized: string[], absent: string[],
 *            rejected: Array<{name: string, why: string, suggest?: string}>}}
 */
export function validatePose(bones, opts = {}) {
  const out = {
    pose: {}, accepted: [], renamed: [], renormalized: [], absent: [], rejected: [],
  };
  if (!bones || typeof bones !== 'object' || Array.isArray(bones)) {
    out.rejected.push({ name: '(whole pose)', why: 'want an object mapping bone name to [x,y,z,w]' });
    return out;
  }
  const known = opts.known ? new Set(opts.known) : null;
  for (const [raw, v] of Object.entries(bones)) {
    const name = canonicalBone(raw);
    if (!name) {
      const suggest = suggestBone(raw);
      out.rejected.push({
        name: raw,
        why: /wing/i.test(raw)
          // A wing name that failed the regex is almost always a spelling or a
          // case slip, and "not a VRM humanoid bone" sends the reader looking
          // in the wrong dictionary entirely.
          ? 'wing bones are addressable but case-sensitive: L_Wing_Upper, '
            + 'R_Wing_Lower_2 and so on (exactly as the rig spells them)'
          : 'not a VRM humanoid bone',
        ...(suggest ? { suggest } : {}),
      });
      continue;
    }
    const q = normalizeQuat(v);
    if (q.why) { out.rejected.push({ name: raw, why: q.why }); continue; }
    if (known && !known.has(name)) { out.absent.push(name); continue; }
    // A raw bone is only real if THIS body has it. The humanoid names above
    // are a vocabulary VRM guarantees; a wing is a fact about one skeleton,
    // so accepting `L_Wing_Upper` on a wingless body would report success and
    // move nothing -- the silent failure this module exists to prevent.
    if (opts.rawKnown && isRawBone(name) && !opts.rawKnown.has(name)) {
      out.rejected.push({ name: raw, why: 'your body has no bone by that name' });
      continue;
    }
    // Two written names can fold to one bone ("leftElbow" and "LeftLowerArm").
    // Last-write-wins would drop one of them without a word — the exact silent
    // overwrite this module exists to stop. Keep the first, name the clash.
    if (name in out.pose) {
      out.rejected.push({ name: raw, why: `also names ${name}, already set here — one bone, one rotation` });
      continue;
    }
    if (name !== raw) out.renamed.push({ from: raw, to: name });
    if (q.renormalized) out.renormalized.push(name);
    out.pose[name] = q.q;
    out.accepted.push(name);
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
      out.rejected.push({
        name: raw,
        why: /wing/i.test(raw)
          // A wing name that failed the regex is almost always a spelling or a
          // case slip, and "not a VRM humanoid bone" sends the reader looking
          // in the wrong dictionary entirely.
          ? 'wing bones are addressable but case-sensitive: L_Wing_Upper, '
            + 'R_Wing_Lower_2 and so on (exactly as the rig spells them)'
          : 'not a VRM humanoid bone',
        ...(suggest ? { suggest } : {}),
      });
      continue;
    }
    if (known && !known.has(name)) { out.absent.push(name); continue; }
    // A raw bone is only real if THIS body has it. The humanoid names above
    // are a vocabulary VRM guarantees; a wing is a fact about one skeleton,
    // so accepting `L_Wing_Upper` on a wingless body would report success and
    // move nothing -- the silent failure this module exists to prevent.
    if (opts.rawKnown && isRawBone(name) && !opts.rawKnown.has(name)) {
      out.rejected.push({ name: raw, why: 'your body has no bone by that name' });
      continue;
    }
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
