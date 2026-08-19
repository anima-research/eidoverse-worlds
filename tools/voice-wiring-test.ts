// voice-wiring — the check that a bundler will not do for you.
//
//   bun tools/voice-wiring-test.ts
//
// Why this exists: a client module can emit an event nobody listens to, or
// call a function nobody imported, and the bundle still builds clean — the
// failure only appears in a browser, at runtime, to a user. That is exactly
// how a `caption` emit shipped with no consumer, and how this PR's own
// main.js briefly called updateVoiceMouths() while its imports were missing.
// Server smoke cannot see any of it; it is all client wiring.
//
// So: every emit has a listener, every consent gate is actually consulted,
// and the entry point imports what it calls. Source-level, no browser.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// 🔴 CUTOVER NOTE (2026-08-16). Twelve assertions were REMOVED here, not
// weakened: they pinned MESH mechanics — transceiver-direction consent, the
// rtc relay, mesh ontrack fail-closed behaviour — and the mesh is deleted.
// Every property they protected still holds, enforced SERVER-side and pinned
// in tools/sfu-test.ts (fail-closed consent is mutation-tested there), which
// is a stronger place for them: the SFU enforces consent rather than trusting
// a client to set a direction.
const main = read("client/main.js");
const mouths = read("client/lib/voicemouths.js");   // 6c: the mouth/glyph driver moved out of main.js
// 🔴 voice.js (the mesh) was DELETED in the #104 phase-1 cutover. Its
// transport-neutral half — the gate, the analyser, mute, device release, and
// the one micOn() answer — lives in micstate.js, which is what these
// assertions were really about: that the mic surface is wired, not that a
// particular transport owns it.
const voice = read("client/lib/micstate.js");
const consent = read("client/lib/voiceconsent.js");
const mictoggle = read("client/lib/mictoggle.js");
const net = read("client/lib/net.js");
const server = read("server/server.ts");

// --- entry point imports everything it calls (the bug this file was born from)
// The mouth/amplitude driver lives in lib/voicemouths.js now (§14 6c); the
// same per-file check follows it there — main.js must still bind what it
// calls itself (updateVoiceMouths, from the frame-system list).
for (const [label, src] of [["main.js", main], ["voicemouths.js", mouths]] as const) {
  for (const fn of ["updateVoiceMouths", "micOn", "isMuted", "micAnalyserLevel"]  /* initVoice + peerLevels were mesh-only (cutover 2026-08-16) */) {
    const called = new RegExp(`\\b${fn}\\s*\\(`).test(src);
    // 🔴 A DESTRUCTURED DYNAMIC IMPORT IS A BINDING TOO (fixed 2026-08-15).
    // `const { toggleMic, micOn } = await import('./lib/micstate.js')` binds both
    // names, but the old regex required `<name> … from` or `import … <name>`
    // ON ONE LINE, so it saw neither — this check had been RED for micOn and
    // toggleMic on main.js since the TTS path moved to a dynamic import, and
    // "34 passed, 1 failed" was the normal state of this suite. I nearly
    // rewrote correct client code to satisfy it; `git show HEAD:client/main.js`
    // proved the failure predated my edit. A test that has always failed is
    // not a test, it is a warning label nobody reads.
    const bound = new RegExp(`\\b${fn}\\b[^\\n]*from|function ${fn}|import[^\\n]*\\b${fn}\\b`).test(src)
      // destructured dynamic import: `{ …, name, … } = await import(…)`
      || new RegExp(`\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*=\\s*await\\s+import`).test(src);
    check(`${label} binds ${fn} before calling it`, !called || bound);
  }
}