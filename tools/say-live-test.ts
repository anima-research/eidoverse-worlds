// say-live-test — a spoken transcript's say (stt.js) through the real net.js (house I135, I217, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/say-live-test.ts
//
//   1. a typed say while the socket is down is queued for the reconnect (unchanged); a LIVE one (a transcript) is
//      dropped and answered offline at once: queued, it would publish after the mic went off, with no mic check
//   2. the spoken trio (spoken, utt, t0) rides the request, so the authority logs the say as voice-performed and the
//      attention policy keys on it; a say without it carries none
// Same stub set as chat-resync-wire-test.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const stubs: any = await import("./remotes-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "assets", "world", "chat", "fp_view", "boot", "ui", "avatar", "xrbody"]) {
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);
}
const { net, say } = (await import("../client/lib/net.js")) as any;
const within = (p: Promise<any>, ms = 50) => Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), ms))]);

// 1. offline
net.joined = false; net.status = "reconnecting"; net.ws = null;
const typed = await within(say("typed while down"));
check("a typed say while down is queued (still pending)", typed === "pending", JSON.stringify(typed));
const live = await within(say("🎙 spoken while down", { spoken: true, utt: 3, live: true }));
check("a live say while down is not queued: answered offline at once", live !== "pending" && live?.ok === false && live?.refused?.code === "offline", JSON.stringify(live));

// 2. online: what goes on the wire
const sent: any[] = [];
net.joined = true; net.status = "connected"; net.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
void say("🎙 hello", { spoken: true, utt: 4, t0: 1234, live: true });
const spoken = sent.find((m) => m.type === "request" && m.verb === "say" && m.args.text === "🎙 hello");
check("a spoken say carries spoken, utt and t0", spoken?.args.spoken === true && spoken?.args.utt === 4 && spoken?.args.t0 === 1234, JSON.stringify(spoken?.args));
check("…and nothing of the 'live' option", spoken && !("live" in spoken.args), JSON.stringify(spoken?.args));
void say("plain");
const plain = sent.find((m) => m.type === "request" && m.verb === "say" && m.args.text === "plain");
check("a plain say carries no spoken trio", plain && !("spoken" in plain.args) && !("utt" in plain.args), JSON.stringify(plain?.args));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
