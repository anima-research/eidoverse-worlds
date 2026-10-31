// presence-actor-test — a message about someone's body goes to their identity or not at all (house I197, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/presence-actor-test.ts
//
// puppet, bodydrag and typing name their person by identity (targetActor / toActor). Without one the server falls back
// to routing by name (server/messages.ts presenceTarget), and a name is whatever someone chose to wear. Through the real
// net.js: with no identity known nothing is sent; with one it rides the message; a typing broadcast (no `to`) still goes.
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
const { net, identities, sendPuppet, sendBodyDrag, sendTyping } = (await import("../client/lib/net.js")) as any;
const sent: any[] = [];
net.joined = true; net.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };

sendPuppet("mallory", { anim: "wave" }); sendBodyDrag("mallory", { phase: "grab" }); sendTyping("mallory", "chat");
check("no identity known: no puppet, bodydrag or typing goes out by name", sent.length === 0, JSON.stringify(sent));
identities.set("pip", "u-pip");
sendPuppet("pip", { anim: "wave" }); sendBodyDrag("pip", { phase: "grab" }); sendTyping("pip", "chat");
check("with one: each carries it", sent.length === 3 && sent[0].targetActor === "u-pip" && sent[1].targetActor === "u-pip" && sent[2].toActor === "u-pip", JSON.stringify(sent));
sent.length = 0; sendTyping(null, "mic");
check("a typing broadcast (no one named) still goes", sent.length === 1 && sent[0].type === "typing" && sent[0].state === "mic", JSON.stringify(sent));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
