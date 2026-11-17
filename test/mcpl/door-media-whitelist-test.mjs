// The door's media lane is a SECURITY BOUNDARY.
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
import { suite } from "../gate/suite.ts";
const src = readFileSync(new URL('../../mcpl/agent.ts', import.meta.url), 'utf8');

const S = suite("door-media-whitelist");
const check = (n, c) => S.check(n, c);

// ---- OUTBOUND (sidecar → world): the dangerous direction ----
const guard = src.slice(src.indexOf('const t = String(frame?.type ?? "")'),
                        src.indexOf('this.ws.send(JSON.stringify(frame));'));
for (const allowed of ['sfu-answer', 'sfu-ice', 'sfu-want-negotiate', 'sfu-pos', 'voice-consent']) {
  check(`outbound allows ${allowed}`, guard.includes(`"${allowed}"`));
}
// 🔴 The point of the whitelist: a sidecar must NOT be able to author world
// state or moderate. If any of these ever appear here, that is the finding.
// (`request` is the message every write is; the rest are the old protocol's verbs and moderation frames)
for (const forbidden of ['request', 'say', 'spawn', 'place', 'remove', 'kick', 'ban',
                         'voice-moderate', 'grant', 'terrain', 'attest']) {
  check(`outbound REFUSES ${forbidden}`, !guard.includes(`"${forbidden}"`));
}
check('outbound refusal is logged, not silent', /refusing to forward non-media frame/.test(guard));
check('outbound refusal returns before the send', /refusing to forward non-media frame[^\n]*\n\s*return;/.test(guard));

// ---- INBOUND (world → sidecar): dropping is silent, so absence is invisible ----
const inbound = src.slice(src.indexOf('case "relay-cred":'), src.indexOf('case "snapshot":'));
for (const fwd of ['relay-cred', 'sfu-offer', 'sfu-ice', 'sfu-route',
                   'voice-consent', 'surface-transition',
                   // the server sends voice-service to every client, voice-moderated
                   // to every client of that world: without them an agent can't learn its voice has degraded or that it was muted
                   'voice-service', 'voice-moderated']) {
  check(`inbound forwards ${fwd}`, inbound.includes(`case "${fwd}":`));
}
check('inbound hands the frames to the sidecar', /this\.onMedia\?\.\(msg\);\s*break;/.test(inbound));

// ---- negative controls: both matchers must be able to fail ----
// A control runs the SAME predicate on a corruption of the REAL extracted
// text, so it also fails if the extraction anchors drift off the source.
check('control: both extraction anchors were actually found',
  src.indexOf('const t = String(frame?.type ?? "")') >= 0 && src.indexOf('case "relay-cred":') >= 0
  && src.indexOf('this.ws.send(JSON.stringify(frame));') > src.indexOf('const t = String(frame?.type ?? "")')
  && src.indexOf('case "snapshot":') > src.indexOf('case "relay-cred":')
  && guard.length > 40 && inbound.length > 40);
check('control: the forbidden-matcher detects "say" injected into the real guard',
  !guard.includes('"say"') && guard.replace('"sfu-answer"', '"sfu-answer" || t === "say"').includes('"say"'));
check('control: the inbound-matcher detects a case removed from the real block',
  inbound.includes('case "voice-service":') && !inbound.replace(/case "voice-service":/g, '').includes('case "voice-service":'));

S.done();
