// tools/protocol/soundclock-check.ts — a sound's shared playhead runs on the SERVER's clock (review 2026-10-07, with the
// pre-translation fixes). `t0` is stamped by the authority (its clock); a client whose own clock is a minute off must still
// seek every listener to the same bar, so the playhead is (serverNow() - t0), never (Date.now() - t0).
//   bun tools/protocol/soundclock-check.ts
// @ts-nocheck
import { plugin } from "bun";
import path from "node:path";
import { ENGINE } from "./common.ts";

let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => {
  if (cond) { pass++; console.log(`  ok ${id} ${what}`); } else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); } };
plugin({ name: "soundclock-stubs", setup(b) {   // sound-guard-test's stubs: sounds.js loads with its DOM and audio seams faked
  for (const m of ["core", "base", "world", "net"]) b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: path.join(ENGINE, "tools/guard-label-stub.mjs") }));
  for (const m of ["inspect", "ui", "audioctx", "audiounlock", "voiceconsent"]) b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: path.join(ENGINE, "tools/sound-guard-stub.mjs") }));
} });
const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
const S = await import(path.join(ENGINE, "client/lib/sounds.js"));
const CLK = await import(path.join(ENGINE, "client/lib/serverclock.js")).catch(() => null);
ok("K0", typeof S.playheadOf === "function" && !!CLK, "sounds.js exports its playhead and the client has one server clock module", { playheadOf: typeof S.playheadOf, clock: !!CLK });
if (CLK && S.playheadOf) {
  // this client's clock runs 60 s behind the server's: the server's `t` in a frame is 60 s ahead of our own
  for (let i = 0; i < 40; i++) CLK.noteServerTime(Date.now() + 60_000);
  const t0 = CLK.serverNow() - 5_000;   // the authority started the loop 5 s ago, by its clock
  const at = S.playheadOf({ t0, loop: true, pitch: 1 }, 100);
  ok("K1", Math.abs(at - 5) < 0.5, "a looping sound started 5 s ago (server clock) plays at 5 s on a client 60 s behind", at);
  const once = S.playheadOf({ t0: CLK.serverNow() - 3_000, loop: false }, 10);
  ok("K2", once !== null && Math.abs(once - 3) < 0.5, "a one-shot started 3 s ago is 3 s in, not finished", once);
  const remotes = await import(path.join(ENGINE, "client/lib/serverclock.js"));
  ok("K3", remotes.serverNow === CLK.serverNow, "one clock: the module everyone imports is the one sounds reads");
}
console.log(`\nsoundclock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
