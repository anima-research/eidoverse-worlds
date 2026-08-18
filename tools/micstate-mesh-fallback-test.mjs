// DISCRIMINATOR for #131 item 1: current-main + this PR, with NO SFU globals,
// must still drive the existing mesh mic — ON→OFF→ON — and the visible state
// (micstate.micOn, the ladder's last rung) must follow it. On the pre-fix head
// this fails: toggleMic checked only window.__sfuMic, which nothing on current
// main installs, so V/click flashed "still connecting" forever and the mesh
// mic was unreachable.
//
// The mesh module is MOCKED here (a stateful stand-in with the same exported
// surface: toggleMic(name) flips, micOn() answers), which proves the
// delegation seam — micstate routes the mutation to the mesh and defers the
// answer to it. The full-stack proof against the real voice.js is the
// reviewer's own current-main + #131 run; this vector is what makes the seam
// unable to silently regress.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

let meshOn = false;
const meshCalls = [];
mock.module(new URL("../client/lib/voice.js", import.meta.url).pathname, () => ({
  toggleMic: async (name) => { meshCalls.push(name); meshOn = !meshOn; return meshOn; },
  micOn: () => meshOn,
}));
mock.module(new URL("../client/lib/core.js", import.meta.url).pathname, () => ({
  report: () => {}, bus: { on() {}, emit() {} },
}));
mock.module(new URL("../client/lib/net.js", import.meta.url).pathname, () => ({ sendTyping: () => {} }));
mock.module(new URL("../client/lib/audioctx.js", import.meta.url).pathname, () => ({
  audioContext: () => null,
}));

const m = await import("../client/lib/micstate.js");
await new Promise((r) => setTimeout(r, 20));   // let micstate's mesh import settle

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// ── no SFU globals: the mesh is the transport ──────────────────────────────
check("precondition: no SFU hook installed", typeof window.__sfuMic !== "function");
check("micOn() starts false, answered by the mesh", m.micOn() === false);

const on1 = await m.toggleMic("prosper");
check("toggleMic ON reaches the MESH (not a 'still connecting' hint)", meshCalls.length === 1);
check("…passes the caller's name through", meshCalls[0] === "prosper");
check("…returns the mesh's resulting state", on1 === true);
check("…and the visible state follows: micOn() is true", m.micOn() === true);

const on2 = await m.toggleMic("prosper");
check("toggleMic OFF reaches the mesh and returns false", meshCalls.length === 2 && on2 === false);
check("…visible state follows down: micOn() is false", m.micOn() === false);

const on3 = await m.toggleMic("prosper");
check("toggleMic ON again completes the ON→OFF→ON discriminator", on3 === true && m.micOn() === true);

// ── SFU hook installed: it outranks the mesh (no regression) ───────────────
let sfuCalls = 0, sfuOn = false;
window.__sfuMic = async () => { sfuCalls++; sfuOn = !sfuOn; return sfuOn; };
const meshCallsBefore = meshCalls.length;
const s1 = await m.toggleMic("prosper");
check("with __sfuMic installed, the SFU hook is called instead of the mesh",
  sfuCalls === 1 && meshCalls.length === meshCallsBefore);
check("…and its state is returned", s1 === true);

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
