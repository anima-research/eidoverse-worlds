// SINGLE-TRANSPORT micstate — the #132 cutover's successor to
// micstate-mesh-fallback-test.mjs, which pinned the mesh-delegation seam that
// made #131 standalone-safe on mesh-main. The cutover deletes the mesh
// (client/lib/voice.js) and that seam with it, so the discriminator's premise
// ("current main's transport is the mesh") is no longer true anywhere. What
// must hold instead, and what this pins:
//
//   1. NO transport hook → toggleMic is an honest hint + the current answer,
//      never a throw, never a false "on". (The pre-#131 failure mode — a
//      permanently unreachable mic — must stay impossible even with the mesh
//      branch gone.)
//   2. SFU hook installed → toggleMic calls it, emits audio:mic, returns its
//      state; micOn() stays THE one answer, fed by setMicLive.
//   3. MESH RESIDUE REGRESSION NET: micstate must not import voice.js at all.
//      A revert that re-introduces the delegation would silently resurrect a
//      dead module path; this fails loud instead.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

mock.module(new URL("../client/lib/core.js", import.meta.url).pathname, () => ({
  report: () => {}, bus: { on() {}, emit(ev, v) { emitted.push([ev, v]); } },
}));
mock.module(new URL("../client/lib/net.js", import.meta.url).pathname, () => ({ sendTyping: () => {} }));
mock.module(new URL("../client/lib/audioctx.js", import.meta.url).pathname, () => ({
  audioContext: () => null,
}));

const emitted = [];
const m = await import("../client/lib/micstate.js");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// ── 3 first, statically: no mesh residue in the module source ───────────────
const src = readFileSync(new URL("../client/lib/micstate.js", import.meta.url), "utf8");
check("micstate has NO import of the deleted mesh (voice.js) — code or dynamic",
  !/import\s*\(\s*['"]\.\/voice\.js['"]\s*\)/.test(src) && !/from\s+['"]\.\/voice\.js['"]/.test(src));

// ── 1: no hook installed — honest hint, honest answer ───────────────────────
check("precondition: no transport hook installed", typeof window.__sfuMic !== "function");
check("micOn() starts false", m.micOn() === false);
const none = await m.toggleMic();
check("toggleMic without a transport returns the (false) current state, no throw", none === false);
check("…and did not claim the mic went live", m.micOn() === false);

// ── 2: the SFU hook is THE transport ────────────────────────────────────────
let sfuCalls = 0, sfuOn = false;
window.__sfuMic = async () => { sfuCalls++; sfuOn = !sfuOn; m.setMicLive(sfuOn); return sfuOn; };
const s1 = await m.toggleMic();
check("with __sfuMic installed, toggleMic calls it", sfuCalls === 1);
check("…returns its resulting state", s1 === true);
check("…emits audio:mic with that state", emitted.some(([ev, v]) => ev === "audio:mic" && v === true));
const s2 = await m.toggleMic();
check("OFF→ back through the same hook", sfuCalls === 2 && s2 === false);
const s3 = await m.toggleMic();
check("ON→OFF→ON discriminator completes through the single transport", s3 === true);

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
