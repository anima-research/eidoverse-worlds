// The seven refusals of #104 amendment 1, proven through the SFU adapter.
//
// These are ALREADY proven in relay-decision-test.ts (23 tests) against the
// decision layer directly. This file exists to prove they still hold when the
// decision layer is driven through the in-process adapter — that reusing
// relaydecision.ts is a real inheritance and not a claim.
import { mintSfuCredential, admitSfuLeg, setSfuConsent, setSfuModeratorMute,
  revokeSfuLeg, sfuDiag, sfuState, registerSfuSender } from "../server/sfuadapter.ts";

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
// 7 expiry: there is no bearer token at all — the nonce is single-use and the
// leg dies with the websocket, so there is no window to expire INTO.
check("7 expiry: no bearer token exists to replay (nonce is single-use)", s.usedNonces.has(good.nonce));

// amendment 3: three independent states
setSfuConsent(W, "bob", 1, true);
check("consent is listener-authored and gen-bound", s.consent.get("bob")?.consent === true);
setSfuModeratorMute(W, "alice", true);
check("moderator mute is a DIFFERENT state than consent",
  // ONE store now: the SFU is the enforcement point and therefore owns the fact.
  // This read the adapter's shadow Set, which is exactly the duplication that
  // let the two diverge in production.
  s.sfu.diag().muted.includes("alice") && s.consent.get("alice") === undefined);

// measurement hygiene: delivered and suppressed reported separately
const d = sfuDiag(W) as any;
check("diag separates forwarded from suppressed", typeof d.forwarded === "number" && typeof d.suppressed?.gated === "number");
// 🔴 ASSERT OPACITY, NOT LENGTH. This read `.length > 20`, which pinned the old
// full-UUID suffix rather than the property it names — and went red when the
// incarnation moved to the DURABLE implementation (transport.ts), whose suffix
// is 8 hex chars. 8 hex is ~4 billion values, plenty to make a lost-file
// counter reuse non-colliding, which is the entropy suffix's actual job.
// What matters is: prefixed counter + a non-empty entropy suffix that a caller
// cannot predict — never that it is long.
check("incarnation is opaque, not a claimed-monotonic counter",
  /^i\d+-[0-9a-f]{6,}$/.test(d.incarnation));

revokeSfuLeg(W, "alice");
check("retirement clears the leg", (sfuDiag(W) as any).moderatorMuted.length === 0);

// ── THE REVOCATION FAMILY ─────────────────────────────────────────────────
// The live smoke caught ONE ordering ("audio survived revocation"). A privacy
// guarantee has to hold under EVERY ordering, so this pins the whole family:
// stale gen, newer gen, double revoke, reconnect, and a speaker who arrives
// after consent was given.
//
// 🔴 These assert `allows()`, NOT route existence. Routes and consent are
// deliberately separate — the transceiver stays negotiated and gets STARVED,
// which is what makes revocation a memory write instead of an SDP round trip.
// The first version of these tests counted pendingRoutes as "can hear" and
// reported four false failures on correct code.
{
  const allowed = (w: string, l: string, sp: string) =>
    (sfuState(w).sfu as unknown as { allows(a: string, b: string): boolean }).allows(l, sp);

// 1. the exact bug: revoke at a stale gen must still silence
{ const W="w1"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true);
  check("consent ON permits the pair", allowed(W,"L","S"));
  setSfuConsent(W,"L",0,false);                      // STALE gen
  check("revoke at a STALE gen still silences", !allowed(W,"L","S")); }

// 2. revoke at a NEWER gen (the reconnect case)
{ const W="w2"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true);
  setSfuConsent(W,"L",99,false);
  check("revoke at a NEWER gen silences", !allowed(W,"L","S")); }

// 3. double revoke (idempotent NO must stay NO)
{ const W="w3"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true); setSfuConsent(W,"L",2,false); setSfuConsent(W,"L",2,false);
  check("double revoke stays silent", !allowed(W,"L","S")); }

// 4. 🔴 THE RECONNECT: a retired leg's consent must NOT resurrect
{ const W="w4"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true);
  revokeSfuLeg(W,"L");                               // listener disconnects
  mintSfuCredential(W,"L",1,6);                      // …and comes back, new gen
  check("a reconnected listener starts FAIL-CLOSED (no resurrected yes)", !allowed(W,"L","S")); }

// 5. consent BEFORE the speaker exists, then speaker joins (tonight's 2nd bug)
{ const W="w5"; mintSfuCredential(W,"L",1,2);
  setSfuConsent(W,"L",2,true);
  mintSfuCredential(W,"S",1,4);                      // arrives LATER
  check("a speaker joining after consent IS permitted", allowed(W,"L","S"));
  setSfuConsent(W,"L",2,false);
  check("…and revoking still silences that late speaker", !allowed(W,"L","S")); }

// 6. moderator mute vs consent — independent states (amendment 3)
{ const W="w6"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuModeratorMute(W,"S",true);
  setSfuConsent(W,"L",2,true);
  const s = sfuState(W);
  check("consent does not un-mute a moderator-muted speaker", s.sfu.diag().muted.includes("S")); }


}

// ── RECONNECT MUST NOT RESURRECT CONSENT (live-path bug, 2026-08-14) ──────
// A reviewer found this by reconnecting a real websocket against a live server:
// retireRelayLeg never routed to the SFU, so revokeSfuLeg was imported and
// NEVER CALLED. The old leg lingered, standingConsent survived, and a fresh
// voice leg inherited a yes it never gave.
//
// 🔴 THESE TESTS STILL CANNOT CATCH THE ORIGINAL BUG, and saying so is the
// point. Verified by mutation: deleting the SFU branch in server.ts's
// retireRelayLeg — the exact defect that shipped — leaves this file at 25/25,
// because these tests CALL revokeSfuLeg themselves, which is precisely the call
// the live path was missing. What they pin is that retirement CLEARS
// everything; what no unit test here can pin is that retirement is REACHED.
// That gap belongs to tools/sfu-browser-smoke.mjs and to live probes.
// If you add a new per-listener map, add it below AND check the live path.
{
  const W = "reconnect";
  const st = sfuState(W);
  const allows = (l: string, sp: string) =>
    (st.sfu as unknown as { allows(a: string, b: string): boolean }).allows(l, sp);
  mintSfuCredential(W, "lis", 1, 2);
  mintSfuCredential(W, "spk", 1, 4);
  setSfuConsent(W, "lis", 1, true);
  check("consent ON permits the pair", allows("lis", "spk"));
  setSfuModeratorMute(W, "spk", true);

  revokeSfuLeg(W, "lis");                       // the leg dies WITHOUT a revoke
  mintSfuCredential(W, "lis", 1, 6);            // …and reconnects, new mediaGen
  check("a reconnected listener does NOT inherit consent", !allows("lis", "spk"));
  check("…and its standing answer is gone too", st.standingConsent.get("lis") === undefined);

  revokeSfuLeg(W, "spk");
  mintSfuCredential(W, "spk", 1, 8);            // the MUTED speaker reconnects
  // Was "cleared in BOTH stores" — the duplication is gone, so there is one
  // store to clear and the divergence it guarded against is now unrepresentable.
  // The BEHAVIOUR it protected still matters and is still asserted: a fresh leg
  // must not inherit a moderation act aimed at its predecessor.
  check("a reconnected speaker does not inherit its predecessor's mute",
    !st.sfu.diag().muted.includes("spk"),
    `muted=${JSON.stringify(st.sfu.diag().muted)}`);
}

// 🔴 senders is world-keyed. The SAME listener id in two worlds is routine
// (ids are per-identity, not per-world), and bare-id keying failed BOTH ways:
// the world registered last clobbered the first's sender, and revoking the leg
// in one world deleted the other's. `waiting` in this same file was fixed for
// this class first; this pins the second map.
//
// Ordering matters: the cross-world revoke happens BEFORE any negotiation, so
// with bare-id keying the surviving entry is deleted and world A's offer has
// nowhere to go — wsA=0. (A second negotiation round can't be observed here:
// sfuNegotiate serialises per leg behind a 15s answer wait, by design.)
{
  const wsA: unknown[] = [], wsB: unknown[] = [];
  const WA = "senders-a", WB = "senders-b";
  mintSfuCredential(WA, "spk", 1, 2);
  mintSfuCredential(WA, "dupL", 1, 4);
  mintSfuCredential(WB, "dupL", 1, 4);
  registerSfuSender(WA, "dupL", (p) => wsA.push(p));
  registerSfuSender(WB, "dupL", (p) => wsB.push(p));  // bare keying: clobbers wsA…
  revokeSfuLeg(WB, "dupL");                           // …and this then deletes it
  setSfuConsent(WA, "dupL", 4, true);                 // negotiation fires in world A
  await new Promise((r) => setTimeout(r, 300));
  check("world A's offer reaches world A's socket despite world B's register+revoke",
    wsA.length > 0, `wsA=${wsA.length}`);
  check("…and nothing leaks into world B's socket", wsB.length === 0, `wsB=${wsB.length}`);
}

console.log(fail === 0 ? `\n\x1b[32m✅ sfu-adapter: ${pass} passed\x1b[0m` : `\n\x1b[31m❌ ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
