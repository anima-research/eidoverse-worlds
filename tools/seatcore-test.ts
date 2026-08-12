/**
 * seatcore fixture — #101 Phase B: the seat-profile contract as hand math.
 *
 * Pins, in order: profile schema validation (including the review amendment
 * that placeholder-shaped patch evidence is INVALID evidence), the serve-time
 * status verdict, the B1 socket-anchor rule (nothing infers intent), the B3
 * runtime gate (the action that actually ran, the exact clip bytes), the B5
 * rider-scale definition (uniform-or-abstain), the B2 world-up correction
 * with the pitch/roll DISCRIMINATOR (hand-computed lateral term that fails a
 * parent-normal implementation by name), the seat-claim purity regression
 * (the _v alias lesson — nonzero-Y socket), and the generation guard (a slow
 * fetch from before an acceptance may never roll the acceptance back — the
 * #95 lesson generalized).
 *
 * Run: bun run tools/seatcore-test.ts   (no servers, no clock, all injected)
 */

import {
  validateProfile, profileStatus, socketAnchor, seatGate,
  applySeatCorrection, riderScalar, seatClaim, makeGenerationGuard,
  SEAT_METHOD, MIN_PATCH_VERTS, MAX_PATCH_SPREAD_Y,
} from "../client/lib/seatcore.js";
import { qAxisAngle } from "../client/lib/motioneval.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const near3 = (a: number[] | null, b: number[], eps = 1e-9) => !!a && a.length === 3 && a.every((v, i) => near(v, b[i], eps));

const A_SHA = "a".repeat(64), C_SHA = "c".repeat(64), OTHER = "b".repeat(64);

/** A profile that passes every gate — tests below break exactly one field. */
const good = () => ({
  avatar: "claude", avatarSha256: A_SHA, pose: "sitchair", clipSha256: C_SHA,
  seatContactY: 0.2055,
  derivation: {
    toolVersion: "seatlab-3", method: SEAT_METHOD,
    winner: { mesh: "Body", vertexIndex: 42, rootLocal: [-0.01, 0.2055, 0.03] },
    supportPatch: { count: 214, spreadY: 0.0031, radiusXZ: 0.1 },
    runs: 3, deterministic: true,
  },
  review: { status: "accepted", receipt: "https://…/101#x", by: "mica" },
});

// ---- schema ----------------------------------------------------------------
console.log("schema");
{
  check("well-formed contact profile validates", validateProfile(good()).ok === true);
  const noReceipt = good(); (noReceipt.review as any) = { status: "accepted" };
  check("accepted without receipt/by refused", !validateProfile(noReceipt).ok);
  const badY = good(); badY.seatContactY = 1.4;
  check("implausible seatContactY refused", !validateProfile(badY).ok);
  const drift = good(); drift.derivation.winner.rootLocal = [0, 0.31, 0];
  check("winner/seatContactY disagreement refused", !validateProfile(drift).ok);
  const sparse = good(); sparse.derivation.supportPatch.count = MIN_PATCH_VERTS - 1;
  check("sparse patch refused (isolated winner = hem/accessory shape)", !validateProfile(sparse).ok);
  const wide = good(); wide.derivation.supportPatch.spreadY = MAX_PATCH_SPREAD_Y + 0.001;
  check("wide patch spread refused", !validateProfile(wide).ok);
  const placeholder = good(); placeholder.derivation.supportPatch = { count: 0, spreadY: 0, radiusXZ: 0.1 };
  check("placeholder-shaped patch evidence refused", !validateProfile(placeholder).ok);
  const oneRun = good(); oneRun.derivation.runs = 1;
  check("underivable determinism (runs<3) refused", !validateProfile(oneRun).ok);
  const unsup = { avatar: "crow", avatarSha256: A_SHA, pose: "sitchair", unsupported: { refusal: "no humanoid mapping — no seat landmark derivable" } };
  check("unsupported record with refusal validates", validateProfile(unsup).ok === true && validateProfile(unsup).kind === "unsupported");
  check("unsupported without refusal refused", !validateProfile({ ...unsup, unsupported: {} }).ok);
}

// ---- serve-time verdict ----------------------------------------------------
console.log("status verdict");
{
  check("fresh accepted → accepted with contactY",
    (() => { const v = profileStatus(good(), A_SHA, C_SHA); return v.status === "accepted" && near(v.contactY!, 0.2055); })());
  check("avatar bytes changed → stale(avatar), value withheld",
    (() => { const v = profileStatus(good(), OTHER, C_SHA); return v.status === "stale" && v.which === "avatar" && v.contactY === undefined; })());
  check("clip bytes changed → stale(clip)",
    (() => { const v = profileStatus(good(), A_SHA, OTHER); return v.status === "stale" && v.which === "clip"; })());
  const proposed = good(); proposed.review = { status: "proposed" } as any;
  check("proposed → proposed (never load-bearing)", profileStatus(proposed, A_SHA, C_SHA).status === "proposed");
  check("no record → missing", profileStatus(null, A_SHA, C_SHA).status === "missing");
  const unsup = { avatar: "crow", avatarSha256: A_SHA, pose: "sitchair", unsupported: { refusal: "no humanoid mapping" } };
  check("unsupported carries its refusal", (() => { const v = profileStatus(unsup, A_SHA, C_SHA); return v.status === "unsupported" && /humanoid/.test(v.refusal!); })());
  check("unsupported for changed bytes is stale, not unsupported", profileStatus(unsup, OTHER, C_SHA).status === "stale");
}

// ---- B1: the socket's word -------------------------------------------------
console.log("socket anchor (B1)");
{
  check("absent → legacy-root", socketAnchor({ pos: [0, 0.5, 0] }) === "legacy-root");
  check("explicit legacy-root → legacy-root", socketAnchor({ seatAnchor: "legacy-root" }) === "legacy-root");
  check("surface → surface", socketAnchor({ seatAnchor: "surface" }) === "surface");
  check("typo/nonsense never becomes surface", socketAnchor({ seatAnchor: "Surface" }) === "legacy-root" && socketAnchor({ seatAnchor: 1 as any }) === "legacy-root");
  check("no socket at all → legacy-root", socketAnchor(undefined) === "legacy-root");
}

// ---- B3: the runtime gate --------------------------------------------------
console.log("runtime gate (B3)");
{
  const surface = { seatAnchor: "surface", pos: [0, 0.5, 0] };
  const accepted = { status: "accepted", contactY: 0.2055 };
  const base = { sock: surface, verdict: accepted, currentSlot: "sitchair", loadedClipSha256: C_SHA, currentClipSha256: C_SHA };
  check("full gate open → apply with contactY",
    (() => { const g = seatGate(base); return g.apply === true && near(g.contactY!, 0.2055); })());
  check("legacy socket blocks even a fresh accepted profile",
    (() => { const g = seatGate({ ...base, sock: { pos: [0, 0.5, 0] } }); return !g.apply && g.reason === "legacy socket"; })());
  check("fallback slot (sit) never consumes a chair profile",
    (() => { const g = seatGate({ ...base, currentSlot: "sit" }); return !g.apply && g.reason === "pose fallback: sit"; })());
  check("clip not hydrated yet → declared, not applied",
    (() => { const g = seatGate({ ...base, currentSlot: undefined, loadedClipSha256: null }); return !g.apply && g.reason === "clip not loaded"; })());
  check("loaded clip bytes differ from served → blocked by digest, not filename",
    (() => { const g = seatGate({ ...base, loadedClipSha256: OTHER }); return !g.apply && /clip mismatch/.test(g.reason!); })());
  check("proposed blocked with its own reason",
    (() => { const g = seatGate({ ...base, verdict: { status: "proposed" } }); return !g.apply && /not countersigned/.test(g.reason!); })());
  check("stale blocked naming which bytes",
    (() => { const g = seatGate({ ...base, verdict: { status: "stale", which: "avatar" } }); return !g.apply && /avatar bytes changed/.test(g.reason!); })());
  check("unsupported blocked carrying the derivation refusal",
    (() => { const g = seatGate({ ...base, verdict: { status: "unsupported", refusal: "no humanoid mapping" } }); return !g.apply && /unsupported rig/.test(g.reason!); })());
  check("missing → 'no profile'",
    (() => { const g = seatGate({ ...base, verdict: { status: "missing" } }); return !g.apply && g.reason === "no profile"; })());
}

// ---- B5: rider scale -------------------------------------------------------
console.log("rider scale (B5)");
{
  check("no scale vector → 1 (today's every body)", (() => { const r = riderScalar(null); return r.ok && r.s === 1; })());
  check("uniform scale passes through", (() => { const r = riderScalar([1.25, 1.25, 1.25]); return r.ok && near(r.s, 1.25); })());
  check("nonuniform scale abstains, never averages", !riderScalar([1, 1.2, 1]).ok);
  check("non-finite scale abstains", !riderScalar([1, NaN, 1]).ok);
}

// ---- B2: world-up correction + the pitch/roll discriminator ----------------
console.log("correction (B2)");
{
  // Level parent, hand math: socket at [2, 1.5, -3], contactY .2055, scale 1
  check("level seat: root sits contactY below the socket, XZ untouched",
    near3(applySeatCorrection([2, 1.5, -3], 0.2055), [2, 1.5 - 0.2055, -3]));
  check("scale composes: contactY×1.25 at scale 1.25",
    near3(applySeatCorrection([0, 1, 0], 0.2, 1.25), [0, 1 - 0.25, 0]));

  // THE DISCRIMINATOR — parent pitched 30° about X. Socket local [0,1,0] →
  // world [0, cos30, sin30] = [0, 0.8660254, 0.5]. contactY 0.2.
  //   world-up (this slice):  [0, cos30 − 0.2, 0.5]
  //   parent-normal (WRONG):  socket − 0.2·n̂ where n̂ = [0, cos30, sin30]
  //                           = [0, cos30 − 0.2·cos30, 0.5 − 0.2·sin30]
  // The wrong implementation's signature is the lateral term 0.2·sin30 = 0.1
  // — a body slid 10cm along the bench because the bench is tilted.
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  const sockW = [0, c30, s30];
  const worldUp = applySeatCorrection(sockW, 0.2)!;
  const parentNormal = [sockW[0] - 0.2 * 0, sockW[1] - 0.2 * c30, sockW[2] - 0.2 * s30];
  check("pitched 30°: world-up result matches hand math", near3(worldUp, [0, c30 - 0.2, s30]));
  check("pitched 30°: parent-normal implementation FAILS by its lateral term (0.1 in Z)",
    near(Math.abs(worldUp[2] - parentNormal[2]), 0.2 * s30) && !near3(worldUp, parentNormal, 1e-3));
  // Roll 45° about Z, socket local [0,1,0] → world [−sin45, cos45, 0]; the
  // wrong vector's lateral term moves X by 0.2·sin45.
  const c45 = Math.cos(Math.PI / 4), s45 = Math.sin(Math.PI / 4);
  const sockR = [-s45, c45, 0];
  const upR = applySeatCorrection(sockR, 0.2)!;
  const wrongR = [sockR[0] + 0.2 * s45, sockR[1] - 0.2 * c45, sockR[2]];
  check("rolled 45°: world-up matches hand math", near3(upR, [-s45, c45 - 0.2, 0]));
  check("rolled 45°: parent-normal FAILS by 0.2·sin45 in X", near(Math.abs(upR[0] - wrongR[0]), 0.2 * s45));
  check("non-finite inputs refuse (null, not garbage)", applySeatCorrection([0, NaN, 0], 0.2) === null && applySeatCorrection([0, 1, 0], NaN) === null);
}

// ---- the _v lesson: seat claim purity at nonzero Y -------------------------
console.log("seat claim (the _v regression)");
{
  // The alias bug returned the FORWARD VECTOR's Y as seatY — ≈0 for a level
  // parent, so a seat near y=0 hid it. This fixture is the nonzero-Y case:
  // seat at y=3.638 (the chapel's cushion height), parent yawed 90°.
  const q = qAxisAngle([0, 1, 0], Math.PI / 2);
  const claim = seatClaim([-22.116, 3.638, 16.694], q)!;
  check("seatY is the socket's Y, not the forward vector's", near(claim.seatY, 3.638));
  check("parentYaw survives alongside (no register to clobber)", near(claim.parentYaw, Math.PI / 2, 1e-6));
  check("non-finite socket world refuses", seatClaim([0, NaN, 0], q) === null);
}

// ---- generations (B3/B4: the #95 lesson) -----------------------------------
console.log("generation guard");
{
  const g = makeGenerationGuard();
  const s0 = g.stamp("claude");
  check("resolution under the current generation applies", g.accept("claude", s0, 1) === true);
  const s1 = g.stamp("claude");
  g.bump("claude");                       // avatar-updated lands mid-flight
  check("resolution stamped before a bump is discarded whole", g.accept("claude", s1, 2) === false);
  const s2 = g.stamp("claude");
  check("post-bump fetch applies at rev 5", g.accept("claude", s2, 5) === true);
  check("a slow rev-3 response can never roll rev 5 back", g.accept("claude", g.stamp("claude"), 3) === false);
  check("equal rev re-applies (idempotent refresh)", g.accept("claude", g.stamp("claude"), 5) === true);
  check("names are independent generations", g.accept("aletheia", g.stamp("aletheia"), 6) === true);
}

console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : "\n\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
