// net-send-shape-test — what net.js puts on the wire about a person or a performance (house I135, I197, I217, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/net-send-shape-test.ts
//
// A puppet, bodydrag or typing names its person by identity (targetActor / toActor) or is not sent: without one the server
// routes by name (server/messages.ts presenceTarget), and a name is whatever someone chose to wear. A spoken say carries
// spoken/utt/t0 and nothing of `live`; a plain one carries none; offline a typed say queues and a live one is refused.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { mkCheck } from "../harness/harness.ts";

const { check, tally } = mkCheck();
const stubs: any = await import("../stubs/remotes-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "assets", "world", "ui/chat", "avatar/fp_view", "boot", "ui/ui", "avatar/avatar", "xr/xrbody"]) {
  mock.module(`${import.meta.dir}/../../client/lib/${m}.js`, () => stubs);
}
const { net, identities, say, sendPuppet, sendBodyDrag, sendTyping, sendJoined } = (await import("../../client/lib/net.js")) as any;
const sent: any[] = [];
const online = () => { net.joined = true; net.status = "connected"; net.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) }; };
const offline = () => { net.joined = false; net.status = "reconnecting"; net.ws = null; };
identities.set("pip", "u-pip");

// sendJoined (the SFU bridge's sender): an open socket that has not joined yet carries nothing
{ online(); net.joined = false; sent.length = 0;
  check("sendJoined: an open socket not yet joined → nothing goes out", sendJoined?.({ type: "sfu-pos" }) === false && sent.length === 0, JSON.stringify(sent));
  net.joined = true;
  check("sendJoined: joined → it goes out as sent", sendJoined({ type: "sfu-pos", x: 1 }) === true && sent.length === 1 && sent[0].type === "sfu-pos" && sent[0].x === 1, JSON.stringify(sent));
  sent.length = 0; offline(); }

// every sender that names a person, every typing state
const SENDERS: { name: string; type: string; key: string; send: (to: string | null) => void }[] = [
  { name: "puppet", type: "puppet", key: "targetActor", send: (to) => sendPuppet(to, { anim: "wave" }) },
  { name: "bodydrag", type: "bodydrag", key: "targetActor", send: (to) => sendBodyDrag(to, { phase: "grab" }) },
  ...["chat", "mic", null, undefined].map((st) => ({ name: `typing ${st}`, type: "typing", key: "toActor", send: (to: string | null) => sendTyping(to, st) })),
];
const run = (s: (typeof SENDERS)[number], to: string | null) => { sent.length = 0; s.send(to); return sent.splice(0); };
for (const s of SENDERS) {
  online();
  let out = run(s, "mallory");
  check(`${s.name}: no identity known → nothing goes out by name`, out.length === 0, JSON.stringify(out));
  out = run(s, "pip");
  check(`${s.name}: with one → it carries ${s.key}`, out.length === 1 && out[0].type === s.type && out[0][s.key] === "u-pip", JSON.stringify(out));
  out = run(s, null);
  if (s.type === "typing") check(`${s.name}: a broadcast (no one named) still goes, naming no one`, out.length === 1 && out[0].type === "typing" && !("toActor" in out[0]), JSON.stringify(out));
  else check(`${s.name}: no one named → nothing`, out.length === 0, JSON.stringify(out));
  offline();
  out = run(s, "pip");
  check(`${s.name}: offline → nothing`, out.length === 0, JSON.stringify(out));
}

// say: `extra` × connection → pending (queued) | refused offline | the args on the wire
const within = (p: Promise<any>, ms = 50) => Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), ms))]);
const SPOKEN = { spoken: true, utt: 4, t0: 1234, live: true };
const SAYS: { name: string; extra?: any; state: "online" | "offline"; expect: "pending" | "offline" | ((args: any) => boolean) }[] = [
  { name: "a typed say while down is queued (still pending)", state: "offline", expect: "pending" },
  { name: "a live say while down is answered offline at once", extra: { spoken: true, utt: 3, live: true }, state: "offline", expect: "offline" },
  { name: "a spoken say carries spoken, utt and t0 exactly, and nothing of 'live'", extra: SPOKEN, state: "online",
    expect: (a) => a.spoken === true && a.utt === 4 && a.t0 === 1234 && !("live" in a) },
  { name: "a plain say carries no spoken trio", state: "online", expect: (a) => !("spoken" in a) && !("utt" in a) && !("t0" in a) },
];
for (const [i, r] of SAYS.entries()) {
  (r.state === "online" ? online : offline)(); sent.length = 0;
  const text = `say ${i}`;
  const res = await within(say(text, r.extra));
  if (r.expect === "pending") check(r.name, res === "pending", JSON.stringify(res));
  else if (r.expect === "offline") check(r.name, res !== "pending" && res?.ok === false && res?.refused?.code === "offline", JSON.stringify(res));
  else { const m = sent.find((x) => x.type === "request" && x.verb === "say" && x.args.text === text); check(r.name, !!m && r.expect(m.args), JSON.stringify(m?.args)); }
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed\n`);
process.exit(tally.failed ? 1 : 0);
