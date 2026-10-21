// Voice state on the pose wire (`mic`, `hear` — shared/presencewire.js voiceWire) under the owner's recorded privacy
// decision (docs/pose-wire.md "Voice state — who sees it", 2026-10-02): it is shared with EVERYONE in the world, like
// a mute/deafen indicator, and it is live-only. End to end through a scratch sequencer:
//   a browser-shaped owner (raw WS join + the exact packet client/lib/net.js sendPose builds, voice via the real
//   voiceWire) → the posecheck fence → the stage frame → a browser-shaped peer, a spectator, and a real WorldAgent.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/voice-wire-test.ts
//   mutations: bun tools/voice-wire-mutation-test.ts
//
// What this pins:
//   - every receiver in the world gets the sender's mic/hear, at any distance (the browser shows it only in the hover
//     card, client/lib/platecard.js — a DISPLAY choice, not a scope on the data) — peer, spectator and agent alike;
//   - latest wins: a toggle reaches everyone on the next frame;
//   - a non-boolean is dropped at the fence, field by field, and the rest of the pose still travels;
//   - a sender that says nothing (an older client) is UNKNOWN to receivers: no key, never a default "false";
//   - it is not remembered: a late joiner's `present` roster and the sender's own `restore` carry neither field.
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { voiceWire } = await import("../shared/presencewire.js");
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
const { fixture, postureFixture } = await import("./body-fixture.ts");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { check, tally } = mkCheck();

const lib = mkdtempSync(join(tmpdir(), "voice-wire-library-"));
mkdirSync(join(lib, "fixtures"));
mkdirSync(join(lib, "defs/animations"), { recursive: true });
writeFileSync(join(lib, "fixtures/idle.vrma"), postureFixture("idle"));
writeFileSync(join(lib, "defs/animations/idle.json"), JSON.stringify({ vrma: "fixtures/idle.vrma" }));
writeFileSync(join(lib, "fixtures/body.vrm"), fixture());
const AVATAR = "fixtures/body.vrm", WORLD = "voice-wire", OWNER = "voice-owner";
const preload = process.env.CONTACT_MUTATION ? join(import.meta.dir, "contact-mutation-preload.ts") : undefined;
const h = await scratchSequencer("voice-wire", { preload, serverEnv: { EIDOVERSE_DIR: lib, DEFS_DIR: join(lib, "defs"), SKIP_OPT_SWEEP: "1" }, portFrom: 9590 });
const WS = h.BASE.replace("http", "ws") + "/ws";

type Sock = { ws: WebSocket; last: Record<string, any> | null; snapshot: any };
/** A raw browser-shaped client. Records the newest pose it has seen for OWNER from stage frames. */
async function join_(id: string, extra: Record<string, unknown> = {}): Promise<Sock> {
  const s: Sock = { ws: new WebSocket(WS), last: null, snapshot: null };
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${id} join timed out`)), 5000);
    s.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { s.snapshot = m; clearTimeout(t); res(); }
      if (m.type === "frame" && m.poses?.[OWNER]) s.last = m.poses[OWNER];
    };
    s.ws.onopen = () => s.ws.send(JSON.stringify({ type: "join", world: WORLD, id, avatar: AVATAR, ...extra }));
  });
  return s;
}
async function until(fn: () => boolean, what: string) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}

const owner = await join_(OWNER);
const peer = await join_("voice-peer");
const spectator = await join_("voice-spectator", { spectate: true });
const agent = new WorldAgent({ name: "voice-agent", avatar: AVATAR, world: WORLD, url: WS }) as any;
await agent.connect();

/** client/lib/net.js sendPose's packet shape; voice ONLY through the real voiceWire unless `raw` (a garbled sender). */
let n = 0;
function ownerSends(voice: Record<string, unknown> | null, raw = false) {
  const p = [1000 + n++ * 0.01, 0, 1000];   // a kilometre from everyone: far past VOICE_SILENT_M
  const pose: Record<string, unknown> = { p, yaw: 0, speed: 0, clip: "idle", pitch: 0 };
  if (voice) Object.assign(pose, raw ? voice : voiceWire(voice));
  owner.ws.send(JSON.stringify({ type: "pose", pose }));
  return p[0];
}
const at = (x: number) => (s: Sock) => s.last?.p?.[0] === x;
const agentPose = () => agent.people.get(OWNER)?.pose ?? null;
async function everyoneHas(x: number, what: string) {
  await until(() => at(x)(peer) && at(x)(spectator) && agentPose()?.p?.[0] === x, what);
}
const both = (o: any, mic: unknown, hear: unknown) => !!o && o.mic === mic && o.hear === hear;

console.log("every receiver in the world gets it, at any distance:");
let x = ownerSends({ mic: true, hear: false });
await everyoneHas(x, "first voice frame");
check("a browser peer 1 km away reads mic on, hearing off", both(peer.last, true, false), JSON.stringify(peer.last));
check("a spectator reads the same", both(spectator.last, true, false), JSON.stringify(spectator.last));
check("an agent's socket reads the same (raw pose in agent.people)", both(agentPose(), true, false), JSON.stringify(agentPose()));
const ownerLine = () => (agent.look() as string).split("\n").find((l: string) => l.includes(`- ${OWNER}:`)) ?? "";
check("the agent's look says it in words: headphones off, still sees chat text; mic on",
  /headphones off: they won't hear anything spoken aloud, yours included, but they still see chat text/.test(ownerLine()) && /mic on/.test(ownerLine()), ownerLine());

console.log("latest wins:");
x = ownerSends({ mic: false, hear: true });
await everyoneHas(x, "toggled frame");
check("the toggle reaches the peer", both(peer.last, false, true), JSON.stringify(peer.last));
check("the toggle reaches the spectator", both(spectator.last, false, true));
check("the toggle reaches the agent", both(agentPose(), false, true));

console.log("the fence drops non-booleans, field by field:");
x = ownerSends({ mic: "yes", hear: 1 }, true);
await everyoneHas(x, "garbled frame");
check("a string mic and a numeric hear never reach the peer", !!peer.last && !("mic" in peer.last) && !("hear" in peer.last), JSON.stringify(peer.last));
check("...and the rest of that pose still travelled", peer.last?.clip === "idle");
check("voiceWire itself sends no non-boolean", JSON.stringify(voiceWire({ mic: "yes", hear: 1 })) === "{}");

console.log("silence is unknown, never a default:");
x = ownerSends(null);
await everyoneHas(x, "voiceless frame");
check("a sender that says nothing leaves no mic/hear key at the peer", !("mic" in peer.last!) && !("hear" in peer.last!), JSON.stringify(peer.last));
check("...nor at the agent", !("mic" in agentPose()) && !("hear" in agentPose()));
check("...and the agent's look makes no voice claim for it", !/headphones|mic /.test(ownerLine()), ownerLine());

console.log("live only, not remembered:");
x = ownerSends({ mic: true, hear: false });
await everyoneHas(x, "voice again before the late join");
const late = await join_("voice-late");
const seen = late.snapshot?.present?.find((o: any) => o.id === OWNER)?.pose;
check("a late joiner's roster has the owner's body", Array.isArray(seen?.p), JSON.stringify(seen));
check("...without mic or hear (the next live frame brings them)", !!seen && !("mic" in seen) && !("hear" in seen), JSON.stringify(seen));
x = ownerSends({ mic: true, hear: false });
await until(() => at(x)(late), "late joiner live frame");
check("...and the next live frame does", both(late.last, true, false), JSON.stringify(late.last));
owner.ws.close();
await sleep(300);
const back = await join_(OWNER);
check("the owner's own restore carries neither", !!back.snapshot && (back.snapshot.restore == null || (!("mic" in back.snapshot.restore) && !("hear" in back.snapshot.restore))), JSON.stringify(back.snapshot?.restore));

for (const s of [peer, spectator, late, back]) { try { s.ws.close(); } catch {} }
try { agent.close?.(); agent.disconnect?.(); } catch {}
try { rmSync(lib, { recursive: true, force: true }); } catch {}
console.log(`\nvoice-wire: ${tally.passed} passed, ${tally.failed} failed`);
await h.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
