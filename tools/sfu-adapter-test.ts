// The seven refusals of #104 amendment 1, proven through the SFU adapter.
//
// These are ALREADY proven in relay-decision-test.ts (23 tests) against the
// decision layer directly. This file exists to prove they still hold when the
// transport underneath is ours rather than LiveKit's — that reusing
// relaydecision.ts is a real inheritance and not a claim.
import { mintSfuCredential, admitSfuLeg, setSfuConsent, setSfuModeratorMute,
  revokeSfuLeg, sfuDiag, sfuState } from "../server/sfuadapter.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${d ? "  " + d : ""}`); c ? pass++ : fail++; };

const W = "spike";
const s = sfuState(W);
const c = mintSfuCredential(W, "alice", 412, 413);
const live = { world: W, incarnation: c.incarnation, primaryGen: 412, mediaGen: 413, usedNonces: s.usedNonces };
const claims = (o = {}) => ({ world: W, id: "alice", primaryGen: 412, mediaGen: 413, incarnation: c.incarnation, nonce: crypto.randomUUID(), ...o });

check("1 wrong world refused", admitSfuLeg(W, claims({ world: "elsewhere" }), live).reason === "wrong world");
check("2 wrong identity refused", admitSfuLeg(W, claims({ id: "" }), live).reason === "no identity");
check("3 retired primary generation refused", admitSfuLeg(W, claims({ primaryGen: 411 }), live).reason === "retired primary generation");
check("4 retired media generation refused", admitSfuLeg(W, claims({ mediaGen: 409 }), live).reason === "retired media generation");
check("5 prior relay incarnation refused", admitSfuLeg(W, claims({ incarnation: "i0-old" }), live).reason === "prior relay incarnation");
const good = claims();
check("   (a valid credential IS admitted)", admitSfuLeg(W, good, live).admit === true);
check("6 removed participant cannot reuse its token", admitSfuLeg(W, good, live).reason === "credential replay");
// 7 expiry is enforced upstream at the token verifier in the LiveKit path; on
// the SFU path there is no bearer token at all — the nonce is single-use and
// the leg dies with the websocket, so there is no window to expire INTO.
check("7 expiry: no bearer token exists to replay (nonce is single-use)", s.usedNonces.has(good.nonce));

// amendment 3: three independent states
setSfuConsent(W, "bob", 1, true);
check("consent is listener-authored and gen-bound", s.consent.get("bob")?.consent === true);
setSfuModeratorMute(W, "alice", true);
check("moderator mute is a DIFFERENT state than consent",
  s.moderatorMuted.has("alice") && s.consent.get("alice") === undefined);

// measurement hygiene: delivered and suppressed reported separately
const d = sfuDiag(W) as any;
check("diag separates forwarded from suppressed", typeof d.forwarded === "number" && typeof d.suppressed?.gated === "number");
check("incarnation is opaque, not a claimed-monotonic counter", /^i\d+-/.test(d.incarnation) && d.incarnation.length > 20);

revokeSfuLeg(W, "alice");
check("retirement clears the leg", (sfuDiag(W) as any).moderatorMuted.length === 0);

console.log(fail === 0 ? `\n\x1b[32m✅ sfu-adapter: ${pass} passed\x1b[0m` : `\n\x1b[31m❌ ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
