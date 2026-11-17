// seatcore — the seat-profile contract as pure functions (#101).
//
// A socket owns the WORLD ANCHOR of a seat; an avatar's seat profile owns
// where that body's posed contact sits relative to its own root. This module
// turns both into arithmetic: profile schema validation, the serve-time status
// verdict, the runtime gate that decides whether a profile may move a body,
// and the one subtraction that puts a pelvis on a cushion.
//
// Shared verbatim by three runtimes (the browser's mountTransform, the
// sequencer's /avatars judgment, the mcpl agent's effective-transform seat
// branch), so it stays dependency-free beyond rot.js's qRotate and clipdefs.js's
// clip name: no THREE, no DOM, no clock, no fetch. Callers pass state in.
//
// Contract highlights:
//  - in the renderer a profile applies ONLY behind the full gate (seatGate:
//    authored surface socket ∧ countersigned profile ∧ the action that
//    ACTUALLY ran ∧ exact clip bytes); the agent has no mixer and applies the
//    contract half alone (seatGateCore, mcpl/effective.ts); everything else
//    is a DECLARED approximation, never silence;
//  - the correction subtracts along the body's actual up (world +Y), since
//    mounted bodies render upright;
//  - no minimum vertex is promoted to truth without its support patch (a
//    skirt hem or loose accessory is an isolated, detectable winner);
//  - a stale hash is never read as fresh, and an old fetch never overwrites a
//    newer generation.

import { qRotate as qApply } from "./rot.js";

// ---- constants (versioned by derivation.toolVersion — change them, bump it) --

export const SEAT_METHOD = "skinned-pelvis-contact-v1";
import { SEAT_CLIP_FILE } from "./clipdefs.js";
export { SEAT_CLIP_FILE };
const CONTACT_MIN = 0.02;   // metres root-local; below this the "contact" is the root itself
const CONTACT_MAX = 1.0;    // above this no humanoid sit pose is plausible
export const MIN_PATCH_VERTS = 8;  // fewer neighbours than this = the winner sits alone
export const MAX_PATCH_SPREAD_Y = 0.02; // a real pelvis underside clusters within 2cm
const SCALE_UNIFORM_EPS = 1e-3;  // |sx−sy|,|sy−sz| beyond this = nonuniform, abstain

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,48}$/;   // roster-name syntax — also what keeps map keys inert
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
  // The store indexes maps with these two strings and a profile moves every
  // wearer of an avatar: the name is roster syntax exactly (the class /avatars
  // sanitizes to), and this slice supports ONE pose.
  if (typeof p.avatar !== "string" || !SAFE_NAME.test(p.avatar))
    return { ok: false, why: "avatar must be a roster name ([a-zA-Z0-9_-], ≤48 chars)" };
  // legal SYNTAX but reserved by the language: these index inherited slots on
  // any plain object, so they are refused at the schema — and the store's
  // null-prototype maps refuse them a second time (defense in depth)
  if (p.avatar === "__proto__" || p.avatar === "constructor" || p.avatar === "prototype")
    return { ok: false, why: `"${p.avatar}" is not an avatar` };
  if (typeof p.avatarSha256 !== "string" || !HEX64.test(p.avatarSha256))
    return { ok: false, why: "avatarSha256 must be 64 hex chars" };
  if (p.pose !== "sitchair") return { ok: false, why: 'this slice profiles pose "sitchair" only' };

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
  // Placeholder-shaped evidence is invalid evidence: a measured patch is never
  // empty and never zero-spread-with-one-vertex.
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

// ---- the socket's word -------------------------------------------------------

/** Legacy sockets were authored under root-at-socket and may encode either a
 *  physical plane or a root target; nothing infers which. Only `anchor:
 *  'surface'` (D14: one enum, shared/sockbody.js ANCHORS) consumes a profile;
 *  everything else is legacy by construction. `sock` is the seat's station, or
 *  an older socket value (below). */
export function socketAnchor(sock) {
  // the seat's station (its anchor is top-level), or the older spelling a fixture or a lifted log may still hand in: a
  // socket value with a body block
  return (sock?.anchor ?? sock?.body?.anchor) === "surface" ? "surface" : "legacy-root";
}

// ---- occupant scale ----------------------------------------------------------

/** occupantEffectiveScale: the occupant avatar root's world scalar scale at
 *  compose time, times its chosen body size (occupants.js passes root scale ×
 *  avatar.bodyScale(); the text tier passes presence `scale`, mcpl/effective.ts
 *  occupantScale). Nonuniform scale is an abstention, never an average. */
export function occupantScalar(scaleVec3) {
  if (scaleVec3 == null) return { ok: true, s: 1 };
  const [sx, sy, sz] = scaleVec3;
  if (!fin(sx) || !fin(sy) || !fin(sz)) return { ok: false, why: "non-finite occupant scale" };
  if (Math.abs(sx - sy) > SCALE_UNIFORM_EPS || Math.abs(sy - sz) > SCALE_UNIFORM_EPS)
    return { ok: false, why: "nonuniform occupant scale" };
  return { ok: true, s: sy };
}

// ---- the gate ----------------------------------------------------------------

/** The contract half of the gate: authored surface socket, countersigned
 *  fresh verdict, pose identity. Everything a consumer WITHOUT a mixer can
 *  check (the browser adds its runtime half in seatGate; parity between them
 *  is pinned by test). */
export function seatGateCore({ sock, verdict, pose = "sitchair" }) {
  if (socketAnchor(sock) !== "surface") return { apply: false, reason: "legacy socket" };
  if (!verdict || verdict.status === "missing") return { apply: false, reason: "no profile" };
  // an update event has landed and the fresh verdict hasn't: the held value
  // stops moving bodies NOW
  if (verdict.status === "pending") return { apply: false, reason: "profile update pending" };
  if (verdict.status === "unsupported") return { apply: false, reason: `unsupported rig: ${verdict.refusal}` };
  if (verdict.status === "stale") return { apply: false, reason: `profile stale (${verdict.which} bytes changed)` };
  if (verdict.status === "proposed") return { apply: false, reason: "profile proposed — not countersigned" };
  if (verdict.pose !== pose) return { apply: false, reason: `profile is for pose ${verdict.pose}, socket wants ${pose}` };
  if (!fin(verdict.contactY)) return { apply: false, reason: "no profile" };
  return { apply: true, contactY: verdict.contactY };
}

/** The renderer's full gate: the contract half plus the runtime truths only a
 *  mixer-owning consumer has. `currentSlot` is the slot ACTUALLY playing (a
 *  fallback "sit"/"idle" never consumes a chair profile); `loadedClipSha256` is
 *  the digest of the bytes the action was built from (null until loaded).
 *  Returns {apply:true, contactY} or {apply:false, reason}; the reason is the
 *  string the browser readers declare (the headless one, mcpl/effective.ts,
 *  has only the contract half, seatGateCore, so no runtime reasons). */
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

// ---- the correction (world-up) ------------------------------------------------

/** Place the profile's contact plane on the socket plane, along the mounted
 *  body's ACTUAL up: global +Y, since mounted avatars render upright
 *  (mountTransform yields yaw only). A tilted parent's normal would displace the
 *  root laterally by contactY·sin(tilt) (pinned by the pitch/roll fixture). */
export function applySeatCorrection(socketPoint, contactY, occupantScale = 1) {
  if (!fin3(socketPoint) || !fin(contactY) || !fin(occupantScale)) return null;
  return [socketPoint[0], socketPoint[1] - contactY * occupantScale, socketPoint[2]];
}

// ---- the passive instrument's seat claim ---------------------------------------

/** The seat's own claim, as pure math: world position of the socket and the
 *  parent's yaw, from values the caller already resolved. Pure arguments
 *  cannot alias scratch registers (pinned by the nonzero-Y regression). */
export function seatClaim(socketWorld, parentQuat) {
  if (!fin3(socketWorld)) return null;
  const f = qApply(parentQuat, [0, 0, 1]);
  return { seatY: socketWorld[1], parentYaw: Math.atan2(f[0], f[2]) };
}

// ---- fetch generations ---------------------------------------------------------

/** Whole-request epoch guard for async profile fetches. Every bump advances
 *  one global epoch and records it against the name; a request stamps the
 *  epoch it DEPARTED under, and a resolution is refused for any name bumped
 *  after that departure, known to the cache or not (so an initial empty-cache
 *  fetch is covered too).
 *
 *  Event revs: `avatar-profile-updated` announces the store revision that now
 *  exists, so a response carrying an older one is refused whole. heldRev stays
 *  monotonic, so a slow response can never roll an acceptance back. */
export function makeGenerationGuard() {
  let epoch = 0;
  const lastBump = new Map();  // name → epoch of its most recent bump
  let heldRev = -1;            // highest revision actually applied
  let floorRev = -1;           // highest revision ANNOUNCED by an event
  return {
    /** stamp for a departing request */
    begin() { return epoch; },
    bump(name, rev) {
      epoch++;
      lastBump.set(name, epoch);
      if (fin(rev)) floorRev = Math.max(floorRev, rev);
    },
    /** true = this name's slice of the response may be applied */
    accept(name, stampedEpoch, rev) {
      if ((lastBump.get(name) ?? 0) > stampedEpoch) return false;
      if (fin(rev)) {
        if (rev < heldRev || rev < floorRev) return false;
        heldRev = Math.max(heldRev, rev);
        return true;
      }
      // a response that cannot state its revision is refused once any event
      // has announced one — it might predate the announcement
      return floorRev < 0;
    },
    rev() { return heldRev; },
  };
}

// ---- the verdict cache: ONE implementation for every consumer ---------------

/** The seat-verdict cache the browser and the headless agent both run, once,
 *  here, where bun pins it. `fetchRoster` is the consumer's transport: an async
 *  () => ({ rev, entries: [{name, seat}] }) that throws on failure.
 *
 *  The contract:
 *   1. an update landing while ANY fetch is in flight (including the first,
 *      empty-cache one) discards that name's slice of the response;
 *   2. an update immediately demotes the HELD verdict to `pending` ("profile
 *      update pending"), so the old value stops moving bodies at once;
 *   3. a fresh response under the new generation restores service;
 *   4. names are independent by epoch: one avatar's update never discards another's slice; a newer announced
 *      revision (floorRev) does refuse an older response for every name. */
export function makeVerdictCache(fetchRoster) {
  const verdicts = new Map();  // name → served verdict (or {status:"pending"})
  const guard = makeGenerationGuard();
  async function refetch() {
    const stamp = guard.begin();
    try {
      const { rev, entries } = await fetchRoster();
      for (const e of entries ?? [])
        if (guard.accept(e.name, stamp, rev)) verdicts.set(e.name, e.seat ?? { status: "missing" });
    } catch { /* held state stays as marked (pending names stay pending); the next event or init retries */ }
  }
  return {
    get(name) { return verdicts.get(name); },
    /** an update event: invalidate FIRST, then refetch — the order is the guarantee */
    note(name, rev) {
      if (name) {
        guard.bump(String(name), rev);
        if (verdicts.has(String(name))) verdicts.set(String(name), { status: "pending" });
      }
      return refetch();
    },
    init() { return refetch(); },
    rev() { return guard.rev(); },
  };
}
