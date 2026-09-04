// micstate transport selection — post-cutover (anima merge, §24n).
//
//   bun tools/micstate-mesh-fallback-test.mjs
//
// TOMBSTONE: this suite's original purpose — proving micstate DELEGATES to
// the mesh (voice.js) when no SFU hook is installed — died with the mesh
// (#104 phase-1 cutover deleted voice.js). Upstream's copy still tests the
// deleted delegation and is red on their tree (flagged for them). What
// SURVIVES the cutover, tested here: the SFU hook is the transport when
// installed, micstate stands alone when it is not (the honest hint instead
// of a dead-mesh call), and the answer API defaults closed. The module's
// own behavior (gate, release, mute) is micstate-exec-test and
// micstate-release-test's job.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

const hints = [];
mock.module(new URL("../client/lib/core.js", import.meta.url).pathname, () => ({
  bus: { emit: () => {}, on: () => {} },
  report: () => {},
  CONFIG: { params: new URLSearchParams() },
}));
mock.module(new URL("../client/lib/ui.js", import.meta.url).pathname, () => ({
  flashHint: (m) => hints.push(m),
}));
mock.module(new URL("../client/lib/net.js", import.meta.url).pathname, () => ({ sendTyping: () => {} }));
mock.module(new URL("../client/lib/voiceconsent.js", import.meta.url).pathname, () => ({
  gateThreshold: () => 0.02,
}));
mock.module(new URL("../client/lib/audioctx.js", import.meta.url).pathname, () => ({
  audioContext: () => { throw new Error("no audio in a test"); },
}));

const m = await import("../client/lib/micstate.js");

console.log("\nmicstate transport selection (post-cutover)");

check("micOn() defaults false (no lane, no device)", m.micOn() === false);

// no transport installed: toggling must NOT pretend — the honest hint
const before = hints.length;
await m.toggleMic("tester");
await new Promise((r) => setTimeout(r, 30));
check("with no transport, toggleMic answers the honest hint, not success",
  hints.length > before && m.micOn() === false, hints.join(" | "));

// SFU hook installed: it IS the transport
let sfuCalls = 0, sfuState = false;
window.__sfuMic = async () => { sfuCalls++; sfuState = !sfuState; return sfuState; };
const on = await m.toggleMic("tester");
check("with __sfuMic installed, the SFU hook is called", sfuCalls === 1);
check("…and its state is returned", on === true);
const off = await m.toggleMic("tester");
check("…and toggles back through the same hook", sfuCalls === 2 && off === false);

console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
