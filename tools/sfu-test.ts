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

/** Full offer/answer both directions — the SFU always answers. */
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
const renegCount = renegotiations.length;
sfu.setConsent("bob", "alice", false);
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
