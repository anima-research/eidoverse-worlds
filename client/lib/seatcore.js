// seatcore — the seat-profile contract as pure functions (#101).
//
// A socket owns the WORLD ANCHOR of a seat; an avatar's seat profile owns
// where that body's posed contact sits relative to its own root. This module
// is the single place both halves of that sentence become arithmetic: schema
// validation for profiles, the serve-time status verdict, the runtime gate
// that decides whether a profile may move a body, and the one subtraction
// that finally puts a pelvis on a cushion.
//
// Shared verbatim by three runtimes (the forecast.js/motioneval.js pattern):
// the browser's mountTransform, the sequencer's /avatars judgment, and the
// mcpl agent's effective-transform seat branch all import THIS file — the
// only way three consumers agree forever is to evaluate the same code.
// Deliberately dependency-free beyond motioneval's quaternion lines: no
// THREE, no DOM, no clock, no fetch. Callers pass state in.
//
// Contract highlights, each one a review scar from the #101 design round:
//  - a profile applies ONLY behind the full gate (authored surface socket ∧
//    countersigned profile ∧ the action that ACTUALLY ran ∧ exact clip
//    bytes) — everything else is a DECLARED approximation, never silence;
//  - the correction subtracts along the body's actual up (world +Y this
//    slice): mounted bodies render upright, and subtracting along a tilted
//    parent normal smears them sideways (B2 — conceded and pinned by test);
//  - no minimum vertex is promoted to truth without its support patch: a
//    skirt hem or loose accessory is an isolated winner, and isolation is
//    detectable (B-evidence);
//  - a stale hash can never be read as fresh, and an old fetch can never
//    overwrite a newer generation (B3 — the #95 lesson, generalized).

import { qApply } from "./motioneval.js";

// ---- constants (versioned by derivation.toolVersion — change them, bump it) --

export const SEAT_METHOD = "skinned-pelvis-contact-v1";
export const SEAT_CLIP_FILE = "sitting_normal_chair"; // the library VRMA every chair profile binds to
export const CONTACT_MIN = 0.02;   // metres root-local; below this the "contact" is the root itself
export const CONTACT_MAX = 1.0;    // above this no humanoid sit pose is plausible
export const MIN_PATCH_VERTS = 8;  // fewer neighbours than this = the winner sits alone
export const MAX_PATCH_SPREAD_Y = 0.02; // a real pelvis underside clusters within 2cm
export const SCALE_UNIFORM_EPS = 1e-3;  // |sx−sy|,|sy−sz| beyond this = nonuniform, abstain

const HEX64 = /^[0-9a-f]{64}$/;
const fin = Number.isFinite;
const fin3 = (v) => Array.isArray(v) && v.length === 3 && v.every(fin);

// ---- profile schema ---------------------------------------------------------

/** Validate a seat-profile record (the shape POST /seat-profile accepts and
 *  profiles.json stores). Returns {ok:true, kind:"contact"|"unsupported"} or
 *  {ok:false, why} — the why is a 4xx body, so it names the field.
 *
 *  Two legitimate shapes: a measured contact profile, and an "unsupported"
 *  record carrying the derivation's refusal (a rig with no humanoid mapping
 *  is a FINDING worth storing — it converts "missing" into a named reason). */
export function validateProfile(p) {
  if (!p || typeof p !== "object") return { ok: false, why: "profile must be an object" };
  if (typeof p.avatar !== "string" || !p.avatar) return { ok: false, why: "avatar name required" };
  if (typeof p.avatarSha256 !== "string" || !HEX64.test(p.avatarSha256))
    return { ok: false, why: "avatarSha256 must be 64 hex chars" };
  if (typeof p.pose !== "string" || !p.pose) return { ok: false, why: "pose required" };

  if (p.unsupported) {
    if (typeof p.unsupported.refusal !== "string" || !p.unsupported.refusal)
      return { ok: false, why: "unsupported record must carry its refusal string" };
    return { ok: true, kind: "unsupported" };
  }

  if (typeof p.clipSha256 !== "string" || !HEX64.test(p.clipSha256))
    return { ok: false, why: "clipSha256 must be 64 hex chars" };
  if (!fin(p.seatContactY) || p.seatContactY <= CONTACT_MIN || p.seatContactY >= CONTACT_MAX)
    return { ok: false, why: `seatContactY out of plausible range (${CONTACT_MIN}..${CONTACT_MAX})` };

  const d = p.derivation;
  if (!d || typeof d !== "object") return { ok: false, why: "derivation record required" };
  if (typeof d.toolVersion !== "string" || !d.toolVersion) return { ok: false, why: "derivation.toolVersion required" };
  if (d.method !== SEAT_METHOD) return { ok: false, why: `derivation.method must be ${SEAT_METHOD}` };
  const w = d.winner;
  if (!w || typeof w.mesh !== "string" || !w.mesh || !Number.isInteger(w.vertexIndex) || w.vertexIndex < 0 || !fin3(w.rootLocal))
    return { ok: false, why: "derivation.winner must name mesh, vertexIndex, rootLocal" };
  // The winner's own coordinate and the promoted value must be the same fact.
  if (Math.abs(w.rootLocal[1] - p.seatContactY) > 1e-6)
    return { ok: false, why: "winner.rootLocal[1] disagrees with seatContactY" };
  const sp = d.supportPatch;
  if (!sp || !Number.isInteger(sp.count) || !fin(sp.spreadY) || !fin(sp.radiusXZ) || sp.radiusXZ <= 0)
    return { ok: false, why: "derivation.supportPatch must carry count, spreadY, radiusXZ" };
  // Placeholder-shaped evidence is invalid evidence (review amendment): a
  // measured patch is never empty and never zero-spread-with-one-vertex.
  if (sp.count < MIN_PATCH_VERTS)
    return { ok: false, why: `support patch too sparse (${sp.count} < ${MIN_PATCH_VERTS}) — winner may be a hem, accessory, or outlier` };
  if (sp.spreadY > MAX_PATCH_SPREAD_Y)
    return { ok: false, why: `support patch spread ${sp.spreadY} exceeds ${MAX_PATCH_SPREAD_Y} — surface is not a contact cluster` };
  if (!Number.isInteger(d.runs) || d.runs < 3 || d.deterministic !== true)
    return { ok: false, why: "derivation requires ≥3 runs and deterministic:true" };

  const r = p.review;
  if (!r || (r.status !== "proposed" && r.status !== "accepted"))
    return { ok: false, why: "review.status must be proposed or accepted" };
  if (r.status === "accepted" && (typeof r.receipt !== "string" || !r.receipt || typeof r.by !== "string" || !r.by))
    return { ok: false, why: "accepted requires review.receipt and review.by" };
  return { ok: true, kind: "contact" };
}

// ---- serve-time status verdict ----------------------------------------------

/** The server's judgment, computed against the CURRENT bytes on disk. One
 *  judge, three readers: consumers receive this verdict and never rehash.
 *  `missing` is the caller's word for "no record at all". */
export function profileStatus(profile, currentAvatarSha256, currentClipSha256) {
  if (!profile) return { status: "missing" };
  if (profile.unsupported)
    return profile.avatarSha256 === currentAvatarSha256
      ? { status: "unsupported", refusal: profile.unsupported.refusal }
      : { status: "stale", which: "avatar" };
  if (profile.avatarSha256 !== currentAvatarSha256) return { status: "stale", which: "avatar" };
  if (profile.clipSha256 !== currentClipSha256) return { status: "stale", which: "clip" };
  if (profile.review?.status !== "accepted") return { status: "proposed" };
  return { status: "accepted", contactY: profile.seatContactY };
}

// ---- the socket's word (B1) -------------------------------------------------

/** Legacy sockets were authored under root-at-socket and may encode either a
 *  physical plane or an empirically-placed root target — nothing infers which.
 *  Only the exact authored string "surface" consumes a profile; everything
 *  else (absent, "legacy-root", typos, numbers) is legacy by construction. */
export function socketAnchor(sock) {
  return sock?.seatAnchor === "surface" ? "surface" : "legacy-root";
}

// ---- rider scale (B5) -------------------------------------------------------

/** The named shared definition of riderEffectiveScale: the rider avatar
 *  root's world scalar scale at compose time. No current code path scales an
 *  avatar root, so this is 1 everywhere today — but the definition is stated
 *  here, once, so that if body scaling ever ships it plugs in at this seam
 *  instead of diverging per consumer. Nonuniform scale is an abstention,
 *  never an average. */
export function riderScalar(scaleVec3) {
  if (scaleVec3 == null) return { ok: true, s: 1 };
  const [sx, sy, sz] = scaleVec3;
  if (!fin(sx) || !fin(sy) || !fin(sz)) return { ok: false, why: "non-finite rider scale" };
  if (Math.abs(sx - sy) > SCALE_UNIFORM_EPS || Math.abs(sy - sz) > SCALE_UNIFORM_EPS)
    return { ok: false, why: "nonuniform rider scale" };
  return { ok: true, s: sy };
}

// ---- the gate (B1 ∧ served verdict ∧ B3) -----------------------------------

/** The contract half of the gate — authored surface socket, countersigned
 *  fresh verdict, pose identity. This is everything a consumer WITHOUT a
 *  mixer can honestly check: the headless reader has no action playing, so
 *  its runtime truth IS the contract (the browser adds its own runtime half
 *  in seatGate below; each consumer gates on the truths it actually has,
 *  and steady-state parity between them is pinned by test). */
export function seatGateCore({ sock, verdict, pose = "sitchair" }) {
  if (socketAnchor(sock) !== "surface") return { apply: false, reason: "legacy socket" };
  if (!verdict || verdict.status === "missing") return { apply: false, reason: "no profile" };
  if (verdict.status === "unsupported") return { apply: false, reason: `unsupported rig: ${verdict.refusal}` };
  if (verdict.status === "stale") return { apply: false, reason: `profile stale (${verdict.which} bytes changed)` };
  if (verdict.status === "proposed") return { apply: false, reason: "profile proposed — not countersigned" };
  if (verdict.pose !== pose) return { apply: false, reason: `profile is for pose ${verdict.pose}, socket wants ${pose}` };
  if (!fin(verdict.contactY)) return { apply: false, reason: "no profile" };
  return { apply: true, contactY: verdict.contactY };
}

/** The renderer's full gate: the contract half plus the runtime truths only
 *  a mixer-owning consumer has. `currentSlot` is the slot ACTUALLY playing
 *  (setClip's fallback walk lands on "sit"/"idle" — those never consume a
 *  chair profile), and `loadedClipSha256` is the digest of the bytes the
 *  action was built from, hashed once at fetch (null until hydration
 *  delivers the clip). Returns {apply:true, contactY} or {apply:false,
 *  reason} — the reason is the string all three consumers declare. */
export function seatGate({ sock, verdict, pose = "sitchair", currentSlot, loadedClipSha256, currentClipSha256 }) {
  const core = seatGateCore({ sock, verdict, pose });
  if (!core.apply) return core;
  if (currentSlot !== pose) return { apply: false, reason: currentSlot ? `pose fallback: ${currentSlot}` : "clip not loaded" };
  if (!loadedClipSha256) return { apply: false, reason: "clip not loaded" };
  if (loadedClipSha256 !== currentClipSha256) return { apply: false, reason: "clip mismatch (loaded bytes differ from served clip)" };
  return core;
}

/** The roster name an avatar path implies — the key /avatars verdicts use.
 *  Pure string surgery, shared by every consumer that must map a wearer to
 *  a profile. */
export function nameFromAvatarPath(path) {
  const m = /([^/\\]+)\.vrm/i.exec(String(path ?? ""));
  return m ? m[1] : null;
}

// ---- the correction (B2: world-up, this slice) ------------------------------

/** Place the profile's contact plane on the socket plane. The subtraction is
 *  along the mounted body's ACTUAL up — global +Y, because mounted avatars
 *  render upright (mountTransform yields yaw only). Subtracting along a
 *  tilted parent's normal instead would displace the root laterally while
 *  the body's contact geometry stays world-vertical: contactY·sin(tilt) of
 *  pure error, the named discriminator in the pitch/roll fixture. Body
 *  orientation-to-plane is a separate future mechanic, not this one. */
export function applySeatCorrection(socketPoint, contactY, riderScale = 1) {
  if (!fin3(socketPoint) || !fin(contactY) || !fin(riderScale)) return null;
  return [socketPoint[0], socketPoint[1] - contactY * riderScale, socketPoint[2]];
}

// ---- the passive instrument's seat claim (the _v lesson) --------------------

/** The seat's own claim, as pure math: world position of the socket and the
 *  parent's yaw, from values the caller already resolved. Exists because the
 *  browser instrument computed these with shared scratch registers and the
 *  forward-vector reuse clobbered the socket position before its Y was read
 *  — invisible at y≈0, corrupt everywhere else. Pure arguments cannot alias;
 *  the nonzero-Y regression pins this function instead of a register habit. */
export function seatClaim(socketWorld, parentQuat) {
  if (!fin3(socketWorld)) return null;
  const f = qApply(parentQuat, [0, 0, 1]);
  return { seatY: socketWorld[1], parentYaw: Math.atan2(f[0], f[2]) };
}

// ---- fetch generations (B3/B4: the #95 lesson, generalized) -----------------

/** Per-name generation guard for async profile fetches. Every update event
 *  (avatar-updated, avatar-profile-updated) bumps the name's generation; a
 *  fetch stamps the generation it departed under; a resolution whose stamp is
 *  no longer current is discarded WHOLE. profilesRev is monotonic and a
 *  lower-or-equal rev never replaces a higher one, so a slow response from
 *  before an acceptance cannot roll the acceptance back. */
export function makeGenerationGuard() {
  const gen = new Map();     // name → generation counter
  let heldRev = -1;
  return {
    bump(name) { gen.set(name, (gen.get(name) ?? 0) + 1); },
    stamp(name) { return gen.get(name) ?? 0; },
    /** true = this resolution may be applied (and the rev is recorded) */
    accept(name, stampedGen, rev) {
      if ((gen.get(name) ?? 0) !== stampedGen) return false;
      if (fin(rev)) {
        if (rev < heldRev) return false;
        heldRev = rev;
      }
      return true;
    },
    rev() { return heldRev; },
  };
}
