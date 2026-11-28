// admitParticipant's eight refusal branches (#104 amendment 1's seven, less expiry, plus two), through the decision layer
// AND the in-process SFU adapter, one table: this proves reusing relaydecision.ts is a real inheritance
import { admitParticipant } from "../../server/relaydecision.ts";
import { mintSfuCredential, admitSfuLeg, setSfuConsent, setSfuModeratorMute,
  revokeSfuLeg, sfuDiag, sfuState, registerSfuSender } from "../../server/sfuadapter.ts";
import { tryUntil, pause } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";

const S = suite("sfu-adapter");
const check = (n: string, c: unknown, d?: unknown) => S.check(n, c, d);

// one refusal table, two columns: the decision layer and the adapter must agree row for row (reuse, not a re-telling)
const W = "spike";
const s = sfuState(W);
const c = mintSfuCredential(W, "alice", 412, 413);
const live = (o = {}) => ({ world: W, incarnation: c.incarnation, primaryGen: 412, mediaGen: 413, usedNonces: new Set<string>(), ...o });
const claims = (o = {}) => ({ world: W, id: "alice", primaryGen: 412, mediaGen: 413, incarnation: c.incarnation, nonce: crypto.randomUUID(), ...o });
const REFUSALS: [string, object, Partial<ReturnType<typeof live>>, string | null][] = [
  ["valid credential admits", {}, {}, null],
  ["1 wrong world", { world: "elsewhere" }, {}, "wrong world"],
  ["2 no identity", { id: "" }, {}, "no identity"],
  ["2b no relay leg issued for the id", {}, { mediaGen: undefined }, "no relay leg issued"],
  ["3 retired primary generation", { primaryGen: 411 }, {}, "retired primary generation"],
  ["3b primary gone entirely", {}, { primaryGen: undefined }, "no living primary"],
  ["4 retired media generation", { mediaGen: 409 }, {}, "retired media generation"],
  ["5 prior relay incarnation", { incarnation: "i0-old" }, {}, "prior relay incarnation"],
  ["6 removed participant's replay", { nonce: "burnt" }, { usedNonces: new Set(["burnt"]) }, "credential replay"],
];
for (const [name, co, lo, reason] of REFUSALS) {
  const want = JSON.stringify(reason ? { admit: false, reason } : { admit: true });
  const decision = JSON.stringify(admitParticipant(claims(co), live(lo) as any));
  // the adapter keeps its own nonce store: burn the row's nonces by a real admission first
  const burnt = [...(lo.usedNonces ?? [])].every((n) => admitSfuLeg(W, claims({ nonce: n }), live()).admit === true);
  const adapter = JSON.stringify(admitSfuLeg(W, claims(co), live(lo)));
  check(`${name}: decision and adapter both say ${reason ?? "admit"}`, burnt && decision === want && adapter === want, `decision=${decision} adapter=${adapter}`);
}
const good = claims();
check("   (a valid credential IS admitted)", admitSfuLeg(W, good, live()).admit === true);
check("6 removed participant cannot reuse its token", admitSfuLeg(W, good, live()).reason === "credential replay");
// 7 expiry: there is no bearer token to expire; the nonce is single-use and the leg dies with the websocket
check("7 expiry: no bearer token exists to replay (nonce is single-use)", s.usedNonces.has(good.nonce));

// amendment 3: three independent states
setSfuConsent(W, "bob", 1, true);
check("consent set by the listener is stored as theirs", s.consent.get("bob")?.consent === true);
setSfuModeratorMute(W, "alice", true);
check("moderator mute is a DIFFERENT state than consent",
  // ONE store: the SFU is the enforcement point and owns the fact; a shadow Set in the adapter is the duplication that diverges
  s.sfu.diag().muted.includes("alice") && s.consent.get("alice") === undefined);

// measurement hygiene: delivered and suppressed reported separately
const d = sfuDiag(W) as any;
check("diag separates forwarded from suppressed", typeof d.forwarded === "number" && typeof d.suppressed?.gated === "number");
// 🔴 ASSERT OPACITY, NOT LENGTH: a prefixed counter + a non-empty unpredictable suffix (transport.ts uses 8 hex, enough
// to keep a lost-file counter reuse from colliding)
check("incarnation is opaque, not a claimed-monotonic counter",
  /^i\d+-[0-9a-f]{6,}$/.test(d.incarnation));

revokeSfuLeg(W, "alice");
check("retirement clears the leg's moderator mute", (sfuDiag(W) as any).moderatorMuted.length === 0);

// ── THE REVOCATION FAMILY ─────────────────────────────────────────────────
// a privacy guarantee must hold under EVERY ordering: stale gen, newer gen, double revoke, reconnect, a late speaker.
// 🔴 These assert `allows()`, NOT route existence: a revoked route stays negotiated and is STARVED (a memory write,
// not an SDP round trip). Each row runs on its own world with listener L and speaker S.
{
  type Op = ["mint", string, number] | ["consent", number, boolean] | ["revoke", string] | ["mute", string];
  const mL: Op = ["mint", "L", 2], mS: Op = ["mint", "S", 4], yes: Op = ["consent", 2, true];
  const REVOCATION: { name: string; ops: Op[]; allowed?: boolean; muted?: boolean }[] = [
    { name: "consent ON permits the pair", ops: [mL, mS, yes], allowed: true },
    { name: "revoke at a STALE gen still silences", ops: [mL, mS, yes, ["consent", 0, false]], allowed: false },
    { name: "revoke at a NEWER gen silences", ops: [mL, mS, yes, ["consent", 99, false]], allowed: false },
    { name: "double revoke stays silent", ops: [mL, mS, yes, ["consent", 2, false], ["consent", 2, false]], allowed: false },
    { name: "a reconnected listener starts FAIL-CLOSED (no resurrected yes)", ops: [mL, mS, yes, ["revoke", "L"], ["mint", "L", 6]], allowed: false },
    { name: "a speaker joining after consent IS permitted", ops: [mL, yes, mS], allowed: true },
    { name: "…and revoking still silences that late speaker", ops: [mL, yes, mS, ["consent", 2, false]], allowed: false },
    { name: "consent does not un-mute a moderator-muted speaker", ops: [mL, mS, ["mute", "S"], yes], muted: true },
  ];
  REVOCATION.forEach(({ name, ops, allowed, muted }, i) => {
    const w = `revoke-${i}`;
    for (const op of ops) {
      if (op[0] === "mint") mintSfuCredential(w, op[1], 1, op[2]);
      else if (op[0] === "consent") setSfuConsent(w, "L", op[1], op[2]);
      else if (op[0] === "revoke") revokeSfuLeg(w, op[1]);
      else setSfuModeratorMute(w, op[1], true);
    }
    const st = sfuState(w).sfu as unknown as { allows(a: string, b: string): boolean; diag(): { muted: string[] } };
    check(name, (allowed === undefined || st.allows("L", "S") === allowed) && (muted === undefined || st.diag().muted.includes("S") === muted));
  });
}

// ── RECONNECT MUST NOT RESURRECT CONSENT ──────
// 🔴 these call revokeSfuLeg themselves, so they pin that retirement CLEARS everything, not that server.ts
// retireRelayLeg REACHES it (nothing gated does: the browser smoke never reconnects; a live probe's job). A new per-listener map:
// add it here AND check the live path
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
  // a fresh leg must not inherit a moderation act aimed at its predecessor
  check("a reconnected speaker does not inherit its predecessor's mute",
    !st.sfu.diag().muted.includes("spk"),
    `muted=${JSON.stringify(st.sfu.diag().muted)}`);
}

// 🔴 senders is world-keyed: the SAME listener id in two worlds is routine, and bare-id keying clobbers or revokes the
// other world's. The cross-world revoke comes BEFORE any negotiation, so bare-id keying shows as wsA=0
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
  await tryUntil("world A's offer", () => wsA.length > 0, { ms: 3000 });
  check("world A's offer reaches world A's socket despite world B's register+revoke",
    wsA.length > 0, `wsA=${wsA.length}`);
  check("…and nothing leaks into world B's socket", wsB.length === 0, `wsB=${wsB.length}`);
}

// ── adversarial-review regressions ────────────────────────────────
{
  const W2 = "rev-regress";
  const s2 = sfuState(W2);

  // #1 a refused revoke must also flip the STANDING answer: the future tense
  mintSfuCredential(W2, "lis", 1, 2);
  setSfuConsent(W2, "lis", 2, true);                       // consent ON at gen 2
  setSfuConsent(W2, "lis", 1, false);                      // revoke at STALE gen → refused
  check("refused revoke still flips standing consent (future speakers stay silent)",
    s2.standingConsent.get("lis") === false);
  mintSfuCredential(W2, "late-speaker", 3, 4);             // joins AFTER the refused revoke
  check("…and a speaker joining later is NOT consented to the revoked listener",
    !s2.sfu.diag().consent?.["lis"]?.includes?.("late-speaker"));

  // #2 a re-mint is a retirement first: no inherited consent, admission, or mute
  const W3 = "rev-remint";
  const s3 = sfuState(W3);
  const c1 = mintSfuCredential(W3, "amy", 1, 2);
  setSfuConsent(W3, "amy", 2, true);                       // predecessor's standing YES
  const v = admitSfuLeg(W3, { world: W3, id: "amy", primaryGen: 1, mediaGen: 2,
    incarnation: c1.incarnation, nonce: c1.nonce },
    { world: W3, incarnation: c1.incarnation, primaryGen: 1, mediaGen: 2, usedNonces: s3.usedNonces });
  if (v.admit) s3.admitted.add("amy");
  s3.sfu.setMuted("amy", true);                            // moderation aimed at THIS leg
  mintSfuCredential(W3, "amy", 1, 3);                      // takeover re-mint
  check("re-mint clears predecessor's admission (fresh leg must prove itself)",
    !s3.admitted.has("amy"));
  check("re-mint does not inherit predecessor's standing consent",
    s3.standingConsent.get("amy") === undefined);
  check("re-mint does not inherit a moderation mute aimed at the predecessor",
    !s3.sfu.diag().muted.includes("amy"));

  // consent given while NO leg existed must survive the first mint (no predecessor to inherit from); takeover still wipes
  const W4 = "rev-premint";
  const s4 = sfuState(W4);
  setSfuConsent(W4, "early-bird", 1, true);        // consent BEFORE any leg
  mintSfuCredential(W4, "early-bird", 1, 2);       // first mint: no predecessor
  check("pre-mint consent survives the FIRST mint (no predecessor to inherit from)",
    s4.standingConsent.get("early-bird") === true);
  mintSfuCredential(W4, "early-bird", 1, 3);       // takeover: predecessor existed
  check("…and a takeover re-mint still wipes it (fail-closed rejoin)",
    s4.standingConsent.get("early-bird") === undefined);

  // the gen WATERMARK survives with the answer: a delayed replay of an older YES must not re-grant a revoked consent
  const W5 = "rev-watermark";
  const s5 = sfuState(W5);
  setSfuConsent(W5, "careful", 1, true);           // yes at gen 1, pre-leg
  setSfuConsent(W5, "careful", 2, false);          // no at gen 2, pre-leg: the last word
  mintSfuCredential(W5, "careful", 1, 2);          // first mint
  setSfuConsent(W5, "careful", 1, true);           // delayed REPLAY of the old yes
  check("a replayed older YES after the first mint is refused (watermark preserved)",
    s5.standingConsent.get("careful") === false);
}

// ── #130 item 4: ICE IS GENERATION-BOUND, LIKE ANSWERS ─────────────────────
// A stale predecessor must not trickle candidates into its successor's pc.
{
  const { sfuAcceptIce } = await import("../../server/sfuadapter.ts");
  const W = "ice-gen";
  const s6 = sfuState(W);
  mintSfuCredential(W, "walker", 1, 3);
  let accepted = 0;
  (s6.sfu as any).addIceCandidate = () => { accepted++; };
  sfuAcceptIce(W, "walker", { candidate: "c" });          // no gen at all
  check("ICE with NO generation is dropped (required, not opt-in)", accepted === 0);
  sfuAcceptIce(W, "walker", { candidate: "c" }, 2);        // predecessor's gen
  check("ICE claiming a RETIRED generation is dropped", accepted === 0);
  sfuAcceptIce(W, "walker", { candidate: "c" }, 3);        // the live gen
  check("ICE naming the LIVE generation is accepted", accepted === 1);
  mintSfuCredential(W, "walker", 1, 4);                    // takeover
  (s6.sfu as any).addIceCandidate = () => { accepted++; };
  sfuAcceptIce(W, "walker", { candidate: "c" }, 3);        // stale after takeover
  check("post-takeover, the predecessor's ICE gen is refused", accepted === 1);
}

// ── #130 item 2: DEGRADED NEVER AGES INTO GREEN; RECOVERY IS A RECEIPT ─────
// degraded is sticky (no silence timer) until a POSITIVE receipt: a completed negotiation calls markVoiceLive
{
  const { markVoiceDegraded, markVoiceLive, voiceServiceState } =
    await import("../../server/sfusupervisor.ts");
  markVoiceDegraded("fault-1");
  markVoiceDegraded("fault-2");                            // repeat, mid-degraded
  check("repeat fault UPDATES the reason (latest fault is what an operator needs)",
    voiceServiceState().state === "degraded" && voiceServiceState().reason === "fault-2");
  await pause("degraded must not age into live", 50);
  check("degraded stays degraded with no receipt (50 ms; a timer longer than that is not this row's)",
    voiceServiceState().state === "degraded");
  markVoiceLive("negotiation completed for test-leg");
  check("a positive receipt (completed negotiation) returns the service to live",
    voiceServiceState().state === "live" && /negotiation completed/.test(voiceServiceState().reason));
}

// ── a leg revoked while its offer was being made gets no offer ─
// revokeSfuLeg lands between createOffer's await and the send: the retired leg's
// socket must not receive an offer (and no resolver is left for its successor).
{
  const WR = "revoke-mid-offer"; const sent: any[] = [];
  mintSfuCredential(WR, "spk", 1, 2); mintSfuCredential(WR, "lis", 1, 2);
  const pcR: any = sfuState(WR).sfu.getLeg("lis")!.pc; const sld = pcR.setLocalDescription.bind(pcR);
  let hooked = false; pcR.setLocalDescription = async (d: any) => { await sld(d); hooked = true; revokeSfuLeg(WR, "lis"); };   // the revoke lands after the last await, before the send
  registerSfuSender(WR, "lis", (p: any) => sent.push(p));
  setSfuConsent(WR, "lis", 2, true);                 // negotiation fires: sfu-route, then the awaits, then sfu-offer
  await pause("the negotiation runs to where an offer would go", 600);
  check("a leg revoked mid-negotiation is sent no offer (the route was sent, the offer was not)",
    hooked && sent.some((p) => p.type === "sfu-route") && !sent.some((p) => p.type === "sfu-offer"), `hooked=${hooked} sent=${JSON.stringify(sent.map((p) => p.type))}`);
}

// ── a leg re-minted (same id) while its offer was being made: the old offer is not sent to the new leg ─
{
  const WR = "remint-mid-offer"; const sent: any[] = [];
  mintSfuCredential(WR, "spk", 1, 2); mintSfuCredential(WR, "lis", 1, 2);
  const pcR: any = sfuState(WR).sfu.getLeg("lis")!.pc; const sld = pcR.setLocalDescription.bind(pcR);
  pcR.setLocalDescription = async (d: any) => { await sld(d); mintSfuCredential(WR, "lis", 1, 4); };   // retired and re-minted after the last await
  registerSfuSender(WR, "lis", (p: any) => sent.push(p));
  setSfuConsent(WR, "lis", 2, true);
  await pause("the negotiation runs to where an offer would go", 600);
  check("a leg re-minted mid-negotiation is sent no offer from its predecessor's negotiation",
    sent.some((p) => p.type === "sfu-route") && !sent.some((p) => p.type === "sfu-offer"), `sent=${JSON.stringify(sent.map((p) => p.type))}`);
}

console.log(S.fail === 0 ? `\n\x1b[32m✅ sfu-adapter: ${S.pass} passed\x1b[0m` : `\n\x1b[31m❌ ${S.fail} failed\x1b[0m`);
S.done();
