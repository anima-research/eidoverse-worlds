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
  // wearer of an avatar (#105 review B2): the name is roster syntax exactly
  // (the same character class /avatars sanitizes to — "__proto__" and
  // friends cannot pass), and this slice supports ONE pose.
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
  // an update event has landed and the fresh verdict hasn't — the held value
  // is no longer trusted and stops moving bodies NOW (#105 review B1)
  if (verdict.status === "pending") return { apply: false, reason: "profile update pending" };
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

/** Whole-request epoch guard for async profile fetches (#105 review B1).
 *
 *  The per-name-stamp version had a hole: an initial fetch stamps nothing
 *  (the cache is empty), so an update landing mid-flight was read at its
 *  POST-bump generation at response time and the stale response won. The
 *  epoch closes it: every bump advances one global epoch and records it
 *  against the name, a request stamps the epoch it DEPARTED under, and a
 *  resolution is refused for any name bumped after that departure — known
 *  to the cache or not.
 *
 *  Event revs are incorporated (review B1, "incorporate the event's rev"):
 *  `avatar-profile-updated` announces the store revision that now exists,
 *  so any response carrying an older revision is pre-event by definition
 *  and is refused whole. heldRev stays monotonic — a slow response from
 *  before an acceptance can never roll the acceptance back. */
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

/** The seat-verdict cache the browser and the headless agent both run
 *  (#105 review B1 — the logic existed twice and each copy had the same
 *  holes; mirrored math stays mirrored, so now it exists once, here, where
 *  bun pins it). `fetchRoster` is the consumer's transport: an async
 *  () => ({ rev, entries: [{name, seat}] }) that throws on failure.
 *
 *  The contract, per the review's four vectors:
 *   1. an update landing while ANY fetch is in flight — including the very
 *      first, empty-cache fetch — discards that name's slice of the response;
 *   2. an update immediately demotes the HELD verdict to `pending` (the gate
 *      declares "profile update pending"): if the refetch is slow or fails,
 *      the old accepted value stops moving bodies the moment the event lands;
 *   3. a fresh response under the new generation restores service;
 *   4. names are independent — one avatar's update never invalidates another's
 *      verdict. */
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
