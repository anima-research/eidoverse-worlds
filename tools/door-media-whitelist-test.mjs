// The door's media lane is a SECURITY BOUNDARY and nothing tested it.
//
// The door forwards media-signalling frames between the world and a voice
// sidecar. It is "a whitelist, not a pipe" (agent.ts) for the reason #100
// established: server-side validation stays the one authority. A sidecar is a
// process holding a peer connection — NOT an identity — so anything it can send
// through this lane is authority the door has handed to a non-identity.
//
// Source-level, because the door needs a live world websocket to run. It reads
// the shipped file, so it cannot pass against a copy.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../mcpl/agent.ts', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// ---- OUTBOUND (sidecar → world): the dangerous direction ----
const guard = src.slice(src.indexOf('const t = String(frame?.type ?? "")'),
                        src.indexOf('this.ws.send(JSON.stringify(frame));'));
for (const allowed of ['sfu-answer', 'sfu-ice', 'sfu-want-negotiate', 'sfu-pos', 'voice-consent']) {
  check(`outbound allows ${allowed}`, guard.includes(`"${allowed}"`));
}
// 🔴 The point of the whitelist: a sidecar must NOT be able to author world
// state or moderate. If any of these ever appear here, that is the finding.
for (const forbidden of ['say', 'spawn', 'place', 'remove', 'kick', 'ban',
                         'voice-moderate', 'grant', 'terrain', 'attest']) {
  check(`outbound REFUSES ${forbidden}`, !guard.includes(`"${forbidden}"`));
}
check('outbound refusal is logged, not silent', /refusing to forward non-media frame/.test(guard));

// ---- INBOUND (world → sidecar): dropping is silent, so absence is invisible ----
const inbound = src.slice(src.indexOf('case "relay-cred":'), src.indexOf('case "snapshot":'));
for (const fwd of ['relay-cred', 'sfu-offer', 'sfu-ice', 'sfu-route',
                   'voice-consent', 'surface-transition',
                   // added 2026-08-16 — the server broadcasts both to every
                   // client and the door dropped them, so an agent could not
                   // learn its voice had degraded or that it had been muted
                   'voice-service', 'voice-moderated']) {
  check(`inbound forwards ${fwd}`, inbound.includes(`case "${fwd}":`));
}

// ---- negative controls: both matchers must be able to fail ----
// 🔴 The first version tested string literals against themselves — constants
// that pass regardless of what ships (review agent, 2026-08-17: "the comment
// claims the matchers were shown falsifiable; they weren't"). A control must
// run the SAME predicate on a corruption of the REAL extracted text, so it
// also fails if the extraction anchors ever drift off the source.
check('control: both extraction anchors were actually found',
  src.indexOf('const t = String(frame?.type ?? "")') >= 0 && src.indexOf('case "relay-cred":') >= 0
  && guard.length > 40 && inbound.length > 40);
check('control: the forbidden-matcher detects "say" injected into the real guard',
  guard.replace('"sfu-answer"', '"sfu-answer" || t === "say"').includes('"say"'));
check('control: the inbound-matcher detects a case removed from the real block',
  !inbound.replace(/case "voice-service":/g, '').includes('case "voice-service":'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
