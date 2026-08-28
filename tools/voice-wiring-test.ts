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

const main = read("client/main.js");
const mouths = read("client/lib/voicemouths.js");   // 6c: the mouth/glyph driver moved out of main.js
const voice = read("client/lib/voice.js");
const consent = read("client/lib/voiceconsent.js");
const mictoggle = read("client/lib/mictoggle.js");
const net = read("client/lib/net.js");
const server = read("server/server.ts");

// --- entry point imports everything it calls (the bug this file was born from)
// The mouth/amplitude driver lives in lib/voicemouths.js now (§14 6c); the
// same per-file check follows it there — main.js must still bind what it
// calls itself (updateVoiceMouths, from the frame-system list).
for (const [label, src] of [["main.js", main], ["voicemouths.js", mouths]] as const) {
  for (const fn of ["initVoice", "updateVoiceMouths", "micOn", "isMuted", "micAnalyserLevel", "peerLevels"]) {
    const called = new RegExp(`\\b${fn}\\s*\\(`).test(src);
    // the last alternative is the dynamic-import destructure form
    // (`const { micOn } = await import(...)`) — bound at call time, same
    // guarantee, which the original regexes predate
    const bound = new RegExp(`\\b${fn}\\b[^\\n]*from|function ${fn}|import[^\\n]*\\b${fn}\\b|\\b${fn}\\b[^\\n]*=\\s*await import\\(`).test(src);
    check(`${label} binds ${fn} before calling it`, !called || bound);
  }
}
check("main.js actually starts the voice subsystem", /initVoice\s*\(/.test(main));
check("main.js loads the mic/headphone toggles", /mictoggle\.js/.test(main));

// --- every client-side emit this feature adds has a listener somewhere
const clientSrc = main + mouths + voice + consent + mictoggle + net + read("client/lib/audiopanel.js");
for (const ev of ["audio:receive", "rtc", "caption"]) {
  const emitted = new RegExp(`emit\\(\\s*['"]${ev}['"]`).test(clientSrc);
  const heard = new RegExp(`on\\(\\s*['"]${ev}['"]`).test(clientSrc);
  check(`'${ev}' is emitted AND consumed`, !emitted || heard,
    emitted && !heard ? "emitted into the void" : "");
}

// --- consent is load-bearing, not decorative
check("inbound RTC is gated on receivingVoice()", /receivingVoice\(\)/.test(voice));
check("receive-voice defaults OFF", /recvVoice:\s*false/.test(consent));
check("STT is gated on its own consent, not on the mic", /ensureSttConsent|sttConsented/.test(mictoggle));
check("STT consent names the third party in plain words",
  /vendor|third party/i.test(consent) && /transcrib/i.test(consent));
// Comment-stripped source: prose must never satisfy or break a code assertion.
const voiceCode = voice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Asserted on the HANDLER BODY rather than a character window: the old regex
// measured distance, so it broke when a comment grew between the two lines and
// would have passed if dropPeer moved into an unrelated branch. Slice the
// handler, then test the revoke arm for what it must actually do.
const receiveHandler = (() => {
  const i = voice.search(/on\(\s*['"]audio:receive['"]/);
  return i < 0 ? "" : voice.slice(i, i + 3000);
})();
check("the audio:receive handler exists", receiveHandler.length > 0);
check("revoking receive tears existing peers down (hard revoke, not just a gain)",
  /dropPeer/.test(receiveHandler));

// --- consent is STRUCTURAL: the direction, not a gate to remember
check("consent is expressed as a transceiver direction", /sendonly|recvonly|sendrecv/.test(voice));
// strip comments before this one: the word legitimately appears in the
// rationale explaining why we no longer USE it, and a test that cannot tell
// prose from code would forbid documenting the bug we fixed
check("no blanket offerToReceiveAudio in code", !/offerToReceiveAudio/.test(voiceCode));
check("every offer path states the direction first",
  (voice.match(/createOffer\(/g) ?? []).length <= (voice.match(/applyDirection\(/g) ?? []).length);
// The contract changed with the one-way fix (#63): refusal must be REVERSIBLE.
// stop() on a remote track is permanent — receiver.track is never reassigned —
// so the gate silences via `enabled` and consent-on re-enables. Assert the
// contract, not the old shape.
// Read from the COMMENT-STRIPPED source: the fix's own rationale mentions
// t.stop() by name to explain why we no longer call it, and a test that cannot
// tell prose from code would forbid documenting the bug we fixed. (The file
// already learned this once — see voiceCode above.)
const ontrackBody = (() => {
  const i = voiceCode.indexOf("ontrack");
  return i < 0 ? "" : voiceCode.slice(i, i + 2000);
})();
check("ontrack fails closed on revoked consent", /receivingVoice\(\)/.test(ontrackBody));
check("ontrack silences via enabled, never stop() — refusal must be reversible",
  /\.enabled\s*=\s*receivingVoice\(\)/.test(ontrackBody) && !/\bt\.stop\(\)/.test(ontrackBody));
check("consent-on re-enables what the gate silenced (no permanent deafness)",
  /reenableInbound/.test(receiveHandler));

// --- categories stay separate: the headphone must not touch world sound
check("voice volume runs through the 'voices' category", /volumeFor\(['"]voices['"]\)/.test(voice));
check("headphone toggle never references world volume",
  !/volWorld|volumeFor\(['"]world['"]\)/.test(mictoggle));

// --- server side of the protocol exists for what the client sends
check("server relays rtc", /case "rtc"/.test(server));
check("server whitelists typing state", /\["ear", "think", "tool", "mic"\]/.test(server));
check("rtc payloads are size-capped", /length\s*>\s*\d{4}/.test(server));
check("client can send rtc", /export function sendRtc/.test(net));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
