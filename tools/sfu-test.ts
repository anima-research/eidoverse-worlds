/**
 * SFU unit proof — the acceptance rows that are checkable without a browser.
 * Loopback werift peers stand in for browsers: same RTP, same negotiation,
 * no Chromium. The browser smoke is a separate (and mandatory) step; passing
 * here proves the POLICY, not the interop.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? "  " + detail : ""}`); fail++; }
};

/** A stand-in browser: publishes a mic, counts what it hears. */
class FakePeer {
  pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
  mic = new MediaStreamTrack({ kind: "audio" });
  heard = 0;
  seq = 0;
  constructor(publish = true) {
    if (publish) this.pc.addTransceiver(this.mic, { direction: "sendonly" });
    this.pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { this.heard++; });
  }
  /** speak N packets of (fake) encoded Opus */
  async speak(n: number) {
    for (let i = 0; i < n; i++) {
      this.mic.writeRtp(new RtpPacket(
        new RtpHeader({ payloadType: 111, sequenceNumber: this.seq++, timestamp: this.seq * 960, ssrc: 42 }),
        Buffer.from([0xf8, 0xff, 0xfe, i & 0xff]),
      ));
      await sleep(6);
    }
  }
}

/** Full offer/answer, BROWSER-OFFERS direction.
 *
 *  🔴 THIS IS THE OPPOSITE OF PRODUCTION, and the comment here used to say "the
 *  SFU always answers" as though it were the contract. It is not: sfu.ts:394-398
 *  is emphatic that THE SERVER MUST OFFER, because a browser's re-offer arrives
 *  `sendonly` and an answer cannot add a receive direction the offer never
 *  proposed — "answering a browser re-offer silently produces a route that
 *  forwards packets into a track nobody is receiving."
 *
 *  So this helper exercises a direction production never uses. It is fine for
 *  the POLICY assertions it serves (consent, caps, leaks — none of which depend
 *  on who offered), and the tests that care about direction drive
 *  `room.negotiate(...)` themselves. But it means a green run here says NOTHING
 *  about SDP direction handling, and the stale comment was itself evidence that
 *  production flipped without anyone revisiting this file.
 *
 *  Found by a second-agent audit, 2026-08-16. Left in place rather than
 *  rewritten mid-audit: changing negotiation direction under 57 passing
 *  assertions is its own change, with its own review. */
async function negotiate(browser: RTCPeerConnection, sfuPc: RTCPeerConnection) {
  const offer = await browser.createOffer();
  await browser.setLocalDescription(offer);
  await sfuPc.setRemoteDescription(browser.localDescription);
  const answer = await sfuPc.createAnswer();
  await sfuPc.setLocalDescription(answer);
  await browser.setRemoteDescription(sfuPc.localDescription);
}

console.log("\nSFU — policy proof (loopback peers)\n");
const renegotiations: string[] = [];
const sfu = new Sfu({ onNegotiationNeeded: (id) => renegotiations.push(id) });

// ── two participants join ──────────────────────────────────────────────────
const alice = new FakePeer(), bob = new FakePeer();
const aLeg = sfu.createLeg("alice", 1), bLeg = sfu.createLeg("bob", 1);
await negotiate(alice.pc, aLeg.pc);
await negotiate(bob.pc, bLeg.pc);
await sleep(900);
check("both legs negotiated", !!sfu.getLeg("alice") && !!sfu.getLeg("bob"));

// ── FAIL-CLOSED: no consent means no audio, even with a live mic ───────────
await alice.speak(15);
await sleep(300);
check("fail-closed: 0 packets to bob before consent", bob.heard === 0, `heard=${bob.heard}`);
// 🔴 E1: the assertion above is satisfied by route ABSENCE, so it survives
// deleting the consent check entirely (proven by mutation testing in review).
// This one cannot: the route EXISTS and is negotiated, and only the consent
// check stands between alice's mic and bob's ear.
{
  const armed = new Sfu();
  const a2 = new FakePeer(), b2 = new FakePeer();
  await negotiate(a2.pc, armed.createLeg("a", 1).pc);
  await negotiate(b2.pc, armed.createLeg("b", 1).pc);
  armed.setConsent("b", "a", true);                 // build + negotiate the route
  await sleep(10);
  await armed.negotiate("b", (pc) => negotiate(pc, b2.pc));
  await sleep(400);
  armed.setConsent("b", "a", false);                // …then withdraw consent only
  const heardAtRevoke = b2.heard;
  await a2.speak(15);
  await sleep(300);
  check("fail-closed HOLDS with a live negotiated route (kills the mutant)",
    b2.heard === heardAtRevoke, `heard ${heardAtRevoke}→${b2.heard}`);
  armed.closeAll();
}
check("…but the SFU DID receive alice's mic", (sfu.getLeg("alice")?.rxPackets ?? 0) > 0,
  `rx=${sfu.getLeg("alice")?.rxPackets}`);

// ── consent ON → route created, renegotiation requested, audio flows ───────
sfu.setConsent("bob", "alice", true);
check("consent created a route", (sfu.getLeg("bob")?.outbound.has("alice")) === true);
// Coalesced: the ask lands on the next microtask, so N routes added in one
// turn produce ONE renegotiation rather than N. (N exchanges also inflates the
// SDP — werift adds a transceiver per exchange — and double-delivers.)
await sleep(10);
check("consent asked the caller to renegotiate", renegotiations.includes("bob"));
check("…exactly once, however many routes were added",
  renegotiations.filter((r) => r === "bob").length === 1, `${renegotiations.filter(r=>r==="bob").length}×`);
// The SFU OFFERS here, it does not answer: bob's browser offered sendonly (his
// mic), and an answer cannot add a receive direction the offer never proposed.
// Adding a track server-side therefore makes the SERVER the offerer — which is
// why createLeg's caller gets onNegotiationNeeded rather than a re-answer.
await negotiate(sfu.getLeg("bob")!.pc, bob.pc);
await sleep(600);
const before = bob.heard;
await alice.speak(20);
await sleep(400);
check("consent ON → bob hears alice", bob.heard > before, `heard=${bob.heard}`);

// ── consent OFF → audio stops, WITHOUT renegotiating ───────────────────────
// NOTE: this shares the top-level `sfu`/`alice`/`bob` with earlier sections,
// which made it intermittently read a doubled count (heard 20→40) from
// accumulated state rather than from a real leak. Isolated below in its own
// room; the shared version stays only as the no-renegotiation check.
const renegCount = renegotiations.length;
sfu.setConsent("bob", "alice", false);
await sleep(250);                                    // let in-flight packets land
const atRevoke = bob.heard;
await alice.speak(20);
await sleep(400);
check("consent OFF → audio stops", bob.heard === atRevoke, `heard ${atRevoke}→${bob.heard}`);
check("…and cost no renegotiation (SDP untouched)", renegotiations.length === renegCount);

// ── moderator mute is enforced at INGRESS: nobody hears, no route survives ─
sfu.setConsent("bob", "alice", true);
await sleep(200);
sfu.setMuted("alice", true);
const atMute = bob.heard;
await alice.speak(20);
await sleep(400);
check("moderator mute silences alice for everyone", bob.heard === atMute, `heard ${atMute}→${bob.heard}`);
sfu.setMuted("alice", false);

// ── revocation is LOCAL and immediate (no webhook, no TTL) ─────────────────
const t0 = Date.now();
sfu.closeLeg("alice");
const revokeMs = Date.now() - t0;
check("revoke is synchronous (<50ms, vs LiveKit's ~4700ms webhook path)", revokeMs < 50, `${revokeMs}ms`);
check("revoked leg is gone", sfu.getLeg("alice") === undefined);
check("…and nobody holds a route to it", sfu.getLeg("bob")?.outbound.has("alice") === false);

// ── takeover: same id re-joining retires the predecessor (#57 one body) ────
const bob2 = new FakePeer();
const bLeg2 = sfu.createLeg("bob", 2);
await negotiate(bob2.pc, bLeg2.pc);
await sleep(500);
check("takeover replaced the leg", sfu.getLeg("bob")?.gen === 2);
check("…and the old PC was closed", bLeg.pc.connectionState === "closed" || bLeg.closed);

// ── INCREMENTAL JOINS + GLARE: the case a batch-setup test never exercises ──
// People arrive one at a time, and two can arrive at once. Concurrent offers on
// one PC is SDP glare — the failure class that grew voice.js to 1388 lines.
{
  const room = new Sfu({ onNegotiationNeeded: (id) => { pend.push(id); } });
  const pend: string[] = [];
  const members = new Map<string, FakePeer>();
  for (let i = 0; i < 5; i++) {
    const id = `j${i}`;
    const p = new FakePeer();
    members.set(id, p);
    const leg = room.createLeg(id, 1);
    await negotiate(p.pc, leg.pc);
    for (const other of members.keys()) if (other !== id) {
      room.setConsent(other, id, true); room.setConsent(id, other, true);
    }
    await sleep(10);                                  // let the coalesced asks land
    const asks = [...new Set(pend)]; pend.length = 0;
    // Drain CONCURRENTLY — this is the glare case, and negotiate() must serialize it.
    const r = await Promise.allSettled(asks.map((legId) =>
      room.negotiate(legId, (pc) => negotiate(pc, members.get(legId)!.pc))));
    check(`join ${i + 1}/5: every renegotiation succeeded (no glare rejection)`,
      r.every((x) => x.status === "fulfilled"), r.map((x) => x.status).join(","));
  }
  await sleep(800);
  const routes = [...members.keys()].reduce((n, id) => n + (room.getLeg(id)?.outbound.size ?? 0), 0);
  check("incremental joins converge to a full room", routes === 20, `${routes}/20 routes`);
  for (let k = 0; k < 12; k++) { for (const p of members.values()) await p.speak(1); }
  await sleep(600);
  const under = [...members.values()].filter((p) => p.heard < 12 * 4 * 0.9).length;
  check("…and everyone actually hears everyone", under === 0, `${under} peers under-hearing`);
  room.closeAll();
}

// ── CRASH PATH: a listener dying mid-fanout must not take the process down ──
// werift binds "message" on its UDP socket but never "error", so a dead peer's
// ICMP port-unreachable surfaces as an unhandled ECONNREFUSED. Measured before
// sfuguard: 8 uncaught exceptions from closing 6 listeners during fanout.
{
  const { transportErrorsSwallowed } = await import("../server/sfuguard.ts");
  const room = new Sfu();
  const spk = new FakePeer();
  await negotiate(spk.pc, room.createLeg("spk", 1).pc);
  const ls: FakePeer[] = [];
  for (let i = 0; i < 4; i++) {
    const p = new FakePeer(); ls.push(p);
    await negotiate(p.pc, room.createLeg(`L${i}`, 1).pc);
    room.setConsent(`L${i}`, "spk", true);
  }
  await sleep(20);
  for (let i = 0; i < 4; i++) await room.negotiate(`L${i}`, (pc) => negotiate(pc, ls[i].pc));
  await sleep(500);
  const before = transportErrorsSwallowed();
  const pump = (async () => { for (let i = 0; i < 80; i++) { await spk.speak(1); } })();
  await sleep(80);
  for (let i = 0; i < 4; i++) { room.closeLeg(`L${i}`); await sleep(40); }
  await pump; await sleep(300);
  check("a listener dying mid-fanout does not crash the process",
    room.getLeg("spk") !== undefined, "process reached this line");
  check("…and the benign transport errors were contained, not ignored globally",
    transportErrorsSwallowed() >= before, `swallowed ${transportErrorsSwallowed() - before}`);
  room.closeAll();
}

// ── LEAK: werift's memleak harness (PR #665) warns that un-unsubscribed
// Event.subscribe closures retain RTCPeerConnection. We never call the
// unSubscribe that onReceiveRtp.subscribe returns, so pin that it's fine.
{
  const room = new Sfu();
  const rss0 = process.memoryUsage().rss;
  for (let c = 0; c < 6; c++) {
    const ps: FakePeer[] = [];
    for (let i = 0; i < 3; i++) {
      const p = new FakePeer(); ps.push(p);
      await negotiate(p.pc, room.createLeg(`c${c}p${i}`, 1).pc);
    }
    await sleep(60);
    for (let i = 0; i < 3; i++) { room.closeLeg(`c${c}p${i}`); ps[i].pc.close(); }
    await sleep(60);
  }
  await sleep(200);
  const grewMB = (process.memoryUsage().rss - rss0) / 1048576;
  check("18 legs created+destroyed leaks no legs", room.diag().legs.length === 0);
  check("…and RSS growth stays bounded (<60MB)", grewMB < 60, `grew ${grewMB.toFixed(0)}MB`);
  room.closeAll();
}

// ── REGRESSION B2: a route whose exchange FAILED must be re-asked ──────────
// Old behaviour: outbound.has() → return false, so one failed exchange
// silenced that pair forever while diag reported it healthy (forwarded=15,
// heard=0, diag green).
{
  const asks: string[] = [];
  const room = new Sfu({ onNegotiationNeeded: (id) => asks.push(id) });
  const spk = new FakePeer(), lis = new FakePeer();
  await negotiate(spk.pc, room.createLeg("S", 1).pc);
  await negotiate(lis.pc, room.createLeg("L", 1).pc);
  room.setConsent("L", "S", true);
  await sleep(10);
  const afterFirst = asks.filter((a) => a === "L").length;
  // the exchange never happens (simulating a blip) — the route stays pending
  room.setConsent("L", "S", false);
  room.setConsent("L", "S", true);
  await sleep(10);
  check("an un-negotiated route is re-asked, not silenced forever",
    asks.filter((a) => a === "L").length > afterFirst, `asks ${afterFirst}→${asks.filter(a=>a==="L").length}`);
  check("…and diag does not claim the listener hears them yet",
    room.diag().legs.find((l) => l.id === "L")?.hears.includes("S") === false,
    JSON.stringify(room.diag().legs.find((l) => l.id === "L")));
  // now actually negotiate: the route becomes real and stops being re-asked
  await room.negotiate("L", (pc) => negotiate(pc, lis.pc));
  await sleep(400);
  check("…and once negotiated, diag reports it as heard",
    room.diag().legs.find((l) => l.id === "L")?.hears.includes("S") === true);
  room.closeAll();
}

// ── REGRESSION: a route added AFTER the offer was created (B2, one level in) ─
// Marking every route negotiated on success looked right and resurrected the
// bug: a latecomer cannot be in an SDP that already exists, but got marked as
// if it were — silent forever, diag reporting it as heard.
{
  const asks: string[] = [];
  const room = new Sfu({ onNegotiationNeeded: (id) => asks.push(id) });
  const s1 = new FakePeer(), s2 = new FakePeer(), lis = new FakePeer();
  await negotiate(s1.pc, room.createLeg("s1", 1).pc);
  await negotiate(s2.pc, room.createLeg("s2", 1).pc);
  await negotiate(lis.pc, room.createLeg("lis", 1).pc);
  room.setConsent("lis", "s1", true);
  await sleep(10);
  await room.negotiate("lis", async (pc) => {
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    room.setConsent("lis", "s2", true);                  // ← after the offer exists
    await lis.pc.setRemoteDescription(pc.localDescription!);
    const ans = await lis.pc.createAnswer(); await lis.pc.setLocalDescription(ans);
    await pc.setRemoteDescription(lis.pc.localDescription!);
  });
  await sleep(20);
  const mid = room.diag().legs.find((l) => l.id === "lis") as any;
  check("a route added mid-exchange is NOT claimed as negotiated",
    mid?.hears.includes("s2") === false && mid?.pendingRoutes.includes("s2") === true,
    JSON.stringify({ hears: mid?.hears, pending: mid?.pendingRoutes }));
  check("…and the SFU asks for another round on its own", asks.filter((a) => a === "lis").length > 1);
  await room.negotiate("lis", (pc) => negotiate(pc, lis.pc));
  await sleep(500);
  const before = lis.heard;
  await s2.speak(12);
  await sleep(400);
  check("…after which the latecomer is actually heard", lis.heard > before, `heard ${before}→${lis.heard}`);
  room.closeAll();
}

// ── MUTATION-DERIVED TESTS ─────────────────────────────────────────────────
// Review ran mutants of fanout()'s four guards against the then-37 tests; five
// survived. M4 is the one that mattered and IS now killed (verified: inverting
// `!this.allows(...)` to a denylist turns this suite red in 3 places).
//
// HONEST NOTE on the others: M1 (source-closed), M5 (route check) and M7
// (self-echo) STILL survive, and that is defensible rather than a hole —
// each is redundant with a guard that runs first. A closed leg's routes are
// deleted by closeLeg, so M1 cannot leak; self-consent never builds a route,
// so M7 cannot either; and `route?.track` is semantically identical to the
// early-continue. The assertions below pin the BEHAVIOUR either way, which is
// what a reader cares about, but they are not discriminating tests and this
// comment exists so nobody mistakes them for coverage they are not.
{
  const room = new Sfu();
  const a = new FakePeer(), b = new FakePeer(), c = new FakePeer();
  await negotiate(a.pc, room.createLeg("a", 1).pc);
  await negotiate(b.pc, room.createLeg("b", 1).pc);
  await negotiate(c.pc, room.createLeg("c", 1).pc);
  // Build a NEGOTIATED route, then remove the consent ENTRY entirely (not set
  // false). This is the state after closeLeg cleanup, and for any pair policy
  // never spoke about — the "absent" case the allowlist claims to deny.
  room.setConsent("b", "a", true);
  await sleep(10);
  await room.negotiate("b", (pc) => negotiate(pc, b.pc));
  await sleep(400);
  // Remove the ENTIRE listener row — the true "absent" state. Deleting only the
  // inner key leaves the row, and `=== false` vs `!== true` behave identically
  // there, which is why the first version of this test did not discriminate.
  (room as unknown as { consent: Map<string, Map<string, boolean>> }).consent.delete("b");
  const atDelete = b.heard;
  await a.speak(20);
  await sleep(400);
  check("M4: ABSENT consent denies (not merely explicit-false)",
    b.heard === atDelete, `heard ${atDelete}→${b.heard}`);

  // M5: a listener with consent but NO route must hear nothing.
  room.setConsent("c", "a", true);
  (room.getLeg("c") as unknown as { outbound: Map<string, unknown> }).outbound.delete("a");
  const cAt = c.heard;
  await a.speak(15);
  await sleep(300);
  check("M5: consent without a route still delivers nothing", c.heard === cAt, `heard ${cAt}→${c.heard}`);

  // M1: a CLOSED speaker's in-flight packets reach nobody.
  room.setConsent("b", "a", true);
  await sleep(10);
  await room.negotiate("b", (pc) => negotiate(pc, b.pc));
  await sleep(300);
  const beforeClose = b.heard;
  room.closeLeg("a");
  await a.speak(15);                                  // the corpse keeps talking
  await sleep(300);
  check("M1: a closed speaker's packets reach nobody", b.heard === beforeClose, `heard ${beforeClose}→${b.heard}`);

  // M7: nobody hears their own voice echoed back.
  const solo = new Sfu();
  const s1 = new FakePeer();
  await negotiate(s1.pc, solo.createLeg("s1", 1).pc);
  solo.setConsent("s1", "s1", true);                  // even if policy says yes
  await sleep(10);
  const selfAt = s1.heard;
  await s1.speak(15);
  await sleep(300);
  check("M7: no self-echo even with self-consent set", s1.heard === selfAt, `heard ${selfAt}→${s1.heard}`);
  solo.closeAll();
  room.closeAll();
}

// ── PROXIMITY GATE (Basis BasisDistanceJob.cs:74-84) ───────────────────────
// An efficiency hint applied AFTER consent, so it can only ever subtract.
// Measured motivation: two conversation groups 40m apart waste 55%% of fanout;
// people scattered over 100m waste 100%%; a huddle wastes 0%% (gating costs
// nothing exactly when it cannot help).
// The mechanism is HYSTERESIS, not a fixed margin — my first version invented
// MARGIN_M=10 from a sprint-speed story, and reading Basis showed the real
// shape: exit threshold 10%% further than enter, keyed on previous state. A
// margin does not stop flapping; two thresholds with memory cannot flap.
{
  const room = new Sfu();
  const s = room as unknown as { inEarshot(a: string, b: string): boolean };
  room.createLeg("a", 1); room.createLeg("b", 1);



check("no positions → forwards (fail-open)", s.inEarshot("a","b")===true);
room.setPosition("a",0,0,0); room.setPosition("b",5,0,0);
check("5m apart → in range", s.inEarshot("a","b")===true);
room.setPosition("b",100,0,0);
check("100m apart → gated", s.inEarshot("a","b")===false);
// hysteresis: enter at 20, exit at 22
room.setPosition("b",19,0,0); check("19m → enters range", s.inEarshot("a","b")===true);
room.setPosition("b",21,0,0); check("21m → STAYS (was in, exit is 22)", s.inEarshot("a","b")===true);
room.setPosition("b",23,0,0); check("23m → drops out", s.inEarshot("a","b")===false);
room.setPosition("b",21,0,0); check("back to 21m → STAYS OUT (enter is 20)", s.inEarshot("a","b")===false);
// the anti-flap property, stated directly
let flips=0, prev=s.inEarshot("a","b");
for(let i=0;i<40;i++){ room.setPosition("b",20+(i%2?0.2:-0.2),0,0); const v=s.inEarshot("a","b"); if(v!==prev)flips++; prev=v; }
check(`jitter across the boundary 40× → ${flips} flips (fixed cutoff would give ~40)`, flips<=1);
// stale
room.setPosition("a",0,0,0,Date.now()-9999); room.setPosition("b",100,0,0);
check("stale position → forwards (fail-open)", s.inEarshot("a","b")===true);

  room.closeAll();
}

// ── SPEAKER CAP + STICKINESS (Basis BasisAudioCapJob) ──────────────────────
// Distance gating alone is not enough: forty people in one plaza are all within
// 20m of each other, so every pair passes the gate and we are back to N².
// A per-listener cap bounds the worst case at N x MAX. Stickiness (an incumbent's
// distance is discounted when competing for a slot) is what stops two speakers
// at near-equal distance from swapping the last slot every tick and stuttering.
{
  const room = new Sfu(); const s = room as any;

for (const id of ["L","a","b","c","d"]) room.createLeg(id,1);
room.setPosition("L",0,0,0);
room.setPosition("a",1,0,0); room.setPosition("b",2,0,0); room.setPosition("c",3,0,0); room.setPosition("d",4,0,0);

check("cap disabled (0) → everyone admitted", ["a","b","c","d"].every(x=>s.withinCap("L",x)===true));

const r2 = new Sfu(); const t:any = r2;
for (const id of ["L","a","b","c","d"]) r2.createLeg(id,1);
r2.setPosition("L",0,0,0);
r2.setPosition("a",1,0,0); r2.setPosition("b",2,0,0); r2.setPosition("c",3,0,0); r2.setPosition("d",40,0,0);
r2.maxAudiblePerListener = 2;
check("first 2 get slots", t.withinCap("L","a")===true && t.withinCap("L","b")===true);
check("3rd (further) is capped out", t.withinCap("L","c")===false);
check("…and incumbents keep theirs", t.withinCap("L","a")===true && t.withinCap("L","b")===true);

// c walks much closer than b → should displace despite stickiness
r2.setPosition("c",0.2,0,0);
check("much-closer newcomer DOES displace", t.withinCap("L","c")===true);
check("…and the displaced one is now out", t.withinCap("L","b")===false);

// STICKINESS: two at nearly equal distance must not swap every tick
const r3 = new Sfu(); const u:any = r3;
for (const id of ["L","x","y"]) r3.createLeg(id,1);
r3.setPosition("L",0,0,0); r3.setPosition("x",10,0,0);
r3.maxAudiblePerListener = 1;
u.withinCap("L","x");                       // x holds the only slot
let swaps=0, holder="x";
for (let i=0;i<40;i++){
  // y hovers at essentially the same distance as x, jittering either side
  r3.setPosition("y", 10 + (i%2?0.05:-0.05), 0, 0);
  if (u.withinCap("L","y")) { if(holder!=="y"){swaps++;holder="y";} }
  else if (u.withinCap("L","x")) { if(holder!=="x"){swaps++;holder="x";} }
}
check(`near-tie jitter 40× → ${swaps} slot swaps (no stickiness would thrash)`, swaps<=1);

}

// ── REGRESSION C2: the guard must not swallow a real bug ───────────────────
{
  const { __isBenignTransportError: benign } = await import("../server/sfuguard.ts");
  const mk = (msg: string, code?: string, syscall?: string) => {
    const e = new Error(msg) as NodeJS.ErrnoException;
    if (code) e.code = code; if (syscall) e.syscall = syscall; return e;
  };
  check("guard swallows a real dgram ECONNREFUSED",
    benign(mk("ECONNREFUSED: connection refused, recv", "ECONNREFUSED", "recv")) === true);
  check("guard does NOT swallow a TypeError that merely mentions an errno",
    benign(mk("Cannot read properties of undefined (reading 'ECONNRESET')")) === false);
  check("guard does NOT swallow a non-transport errno", benign(mk("no such file", "ENOENT", "open")) === false);
}

const d = sfu.diag();
check("diag reports live legs", Array.isArray(d.legs) && typeof d.forwarded === "number");

sfu.closeAll();
console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
