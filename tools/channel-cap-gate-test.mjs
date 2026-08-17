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
//
// 🔴 REVISED 2026-08-17 (review agent): the first extraction was
// `grant ? matches : true` — which faithfully copied a BUG and thereby pinned
// it. capAllowed now shares granted()'s full semantics: plain-MCP hosts get
// no channel verbs (channels are MCPL-only; the fallback-to-MCP rationale
// that lets toolsAllowed default open applies to tools alone), and a 0.5+
// host is denied until its first featureSets/update arrives (§5.3
// deny-until-policy). The extraction takes (mcplClient, version, grant).
const capAllowed = (mcplClient, version, grant, cap) => {
  if (!mcplClient) return false;
  if (grant) return grant.some((g) => capabilityMatches(g, cap));
  const major = Number(version?.split('.')[0] ?? 0);
  const minor = Number(version?.split('.')[1] ?? 0);
  return !(major > 0 || minor >= 5);
};
const withGrant = (grant, cap) => capAllowed(true, '0.5', grant, cap);

// ---- the matcher itself (§5.4 path semantics) ------------------------------

ok('exact path grants', withGrant(['channels.publish'], CAP.channelsPublish));
ok('one-segment wildcard grants', withGrant(['channels.*'], CAP.channelsPublish));
ok('ANCESTOR PREFIX DOES NOT GRANT — the fail-closed rule',
   !withGrant(['channels'], CAP.channelsPublish));
ok('a sibling grant does not confer publish',
   !withGrant(['channels.incoming'], CAP.channelsPublish));
ok('a sibling grant does not confer lifecycle',
   !withGrant(['channels.incoming'], CAP.channelsLifecycle));
ok('tools does not confer channels',
   !withGrant(['tools'], CAP.channelsPublish));
ok('bare * does not span two segments',
   !withGrant(['*'], CAP.channelsPublish));
ok('an EMPTY grant list denies (declared, granted nothing)',
   !withGrant([], CAP.channelsPublish));
// The three fences the first extraction missed:
ok('plain-MCP host (never declared MCPL) gets NO channel verbs',
   !capAllowed(false, null, null, CAP.channelsPublish));
ok('0.5 host with no policy yet is DENIED (deny-until-policy window)',
   !capAllowed(true, '0.5', null, CAP.channelsPublish));
ok('legacy 0.4 MCPL host with no policy keeps everything',
   capAllowed(true, '0.4', null, CAP.channelsPublish));

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

// The streaming path is a NOTIFICATION — no response, so the gate must drop it
// silently rather than refuse. Assert the drop happens before agent.typing().
{
  const at = src.indexOf('CHANNELS_OUTGOING_CHUNK');
  const body = src.slice(at, at + 900);
  const gate = body.indexOf('capAllowed(CAP.channelsStreaming)');
  const typing = body.indexOf('this.agent.typing()');
  ok('channels/outgoing/chunk is gated on channelsStreaming', gate >= 0);
  ok('the streaming gate precedes agent.typing()', gate >= 0 && typing >= 0 && gate < typing);
}

// tools/list and tools/call were the original offenders — keep them pinned.
for (const m of ['tools/list', 'tools/call']) {
  const at = src.indexOf(`case "${m}"`);
  ok(`${m} consults toolsAllowed()`,
     at >= 0 && src.slice(at, at + 600).includes('toolsAllowed()'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
