// test/protocol/soundclock-check.ts — a sound's shared playhead runs on the SERVER's clock (review 2026-10-07, with the
// pre-translation fixes). `t0` is stamped by the authority (its clock); a client whose own clock is a minute off must still
// seek every listener to the same bar, so the playhead is (serverNow() - t0), never (Date.now() - t0).
//   bun test/protocol/soundclock-check.ts
// @ts-nocheck
import { plugin } from "bun";
import { stubResolve } from "../harness/stub.ts";
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "../gate/common.ts";
import { suite } from "../gate/suite.ts";

const SU = suite("soundclock", { cap: Infinity });
const ok = (id: string, cond: any, what: string, detail?: any) => { if (SU.runs(id)) SU.ok(cond, `${id} ${what}`, detail); };
plugin({ name: "soundclock-stubs", setup(b) {   // sound-guard-stub: sounds.js loads with its DOM and audio seams faked
  for (const m of ["core", "base", "world"]) stubResolve(b, new RegExp(`^(\\.\\.?/)+${m}\\.js$`), () => ({ path: path.join(ENGINE, "test/stubs/guard-label-stub.mjs") }));
  for (const m of ["edit/inspect", "ui", "audioctx", "audiounlock", "voiceconsent"]) stubResolve(b, new RegExp(`^(\\.\\.?/)+${m}\\.js$`), () => ({ path: path.join(ENGINE, "test/stubs/sound-guard-stub.mjs") }));
} });
const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
const S = await import(path.join(ENGINE, "client/lib/realize/sounds.js"));
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
  const src = fs.readFileSync(path.join(ENGINE, "client/lib/realize/sounds.js"), "utf8");   // a module compared to itself proved nothing
  ok("K3", /from '\.\.\/serverclock\.js'/.test(src) && !/Date\.now\(/.test(src), "one clock: sounds.js reads the server clock module and never Date.now()", { imports: /from '\.\.\/serverclock\.js'/.test(src), dateNow: (src.match(/Date\.now\(/g) ?? []).length });
}
SU.done();
