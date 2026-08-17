#!/usr/bin/env bun
// The channel capability gates — do denied capabilities actually refuse?
//
// 🔴 WHY. `channels.publish`, `channels.lifecycle` and `channels.streaming` are
// declared in CAP and were checked NOWHERE (found 2026-08-16). Only
// `channels.register` and `channels.incoming` had gates. So a host granting
// `channels.incoming` alone — "receive, do not send" — still had its agent's
// channels/publish answered: the DOOR SPOKE IN THE WORLD on behalf of an agent
// whose host never granted speech.
//
// This is the same shape as toolsAllowed(), which existed with twelve lines of
// spec-citing prose above it and NO CALLER. The logic was right; nothing asked.
// So the test that matters is not "does the gate function return false" — it is
// "does the REQUEST get refused", which is the thing that was broken.
//
// Spec (declaration.ts, §5.4): "absence is denial and there is no unspecified
// state, so an ambiguous entry fails closed." A peer that declares NO grant at
// all is a different case — plain MCP, no declaration — and keeps everything.

import { capabilityMatches, CAP } from '../mcpl/declaration.ts';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// The gate, extracted exactly as net-server implements it. If this drifts from
// the source the door will pass here and fail in the world — so the shape is
// kept trivial and the REAL assertion is the wiring check at the bottom.
const capAllowed = (grant, cap) =>
  grant ? grant.some((g) => capabilityMatches(g, cap)) : true;

// ---- the matcher itself (§5.4 path semantics) ------------------------------

ok('exact path grants', capAllowed(['channels.publish'], CAP.channelsPublish));
ok('one-segment wildcard grants', capAllowed(['channels.*'], CAP.channelsPublish));
ok('ANCESTOR PREFIX DOES NOT GRANT — the fail-closed rule',
   !capAllowed(['channels'], CAP.channelsPublish));
ok('a sibling grant does not confer publish',
   !capAllowed(['channels.incoming'], CAP.channelsPublish));
ok('a sibling grant does not confer lifecycle',
   !capAllowed(['channels.incoming'], CAP.channelsLifecycle));
ok('tools does not confer channels',
   !capAllowed(['tools'], CAP.channelsPublish));
ok('bare * does not span two segments',
   !capAllowed(['*'], CAP.channelsPublish));
ok('no declaration at all ⇒ everything (plain-MCP host)',
   capAllowed(null, CAP.channelsPublish) && capAllowed(null, CAP.channelsLifecycle));
ok('an EMPTY grant list denies (declared, granted nothing)',
   !capAllowed([], CAP.channelsPublish));

// ---- the wiring: is the gate actually CALLED at each verb? ------------------
//
// 🔴 THIS is the assertion that would have caught the original bug. A unit test
// of the predicate passes happily while nothing invokes it. Read the source and
// require a gate inside each case block, before the handler runs.

const src = await Bun.file(new URL('../mcpl/net-server.ts', import.meta.url)).text();

const gatedCase = (caseName, capConst) => {
  const at = src.indexOf(`case method.${caseName}:`);
  if (at < 0) return { ok: false, why: `case ${caseName} not found` };
  // the case body up to the next `case ` at the same level — enough to see
  // whether a gate precedes the work
  const body = src.slice(at, at + 700);
  const gate = body.indexOf(`capAllowed(CAP.${capConst})`);
  if (gate < 0) return { ok: false, why: `no capAllowed(CAP.${capConst}) in the case body` };
  return { ok: true };
};

for (const [caseName, capConst] of [
  ['CHANNELS_PUBLISH', 'channelsPublish'],
  ['CHANNELS_OPEN', 'channelsLifecycle'],
  ['CHANNELS_CLOSE', 'channelsLifecycle'],
]) {
  const r = gatedCase(caseName, capConst);
  ok(`${caseName} is gated on ${capConst}`, r.ok, r.why);
}

// tools/list and tools/call were the original offenders — keep them pinned.
for (const m of ['tools/list', 'tools/call']) {
  const at = src.indexOf(`case "${m}"`);
  ok(`${m} consults toolsAllowed()`,
     at >= 0 && src.slice(at, at + 600).includes('toolsAllowed()'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
