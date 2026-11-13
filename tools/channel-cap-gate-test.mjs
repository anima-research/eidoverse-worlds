#!/usr/bin/env bun
// The channel capability gates — do denied capabilities actually refuse?
//
// 🔴 WHY. `channels.publish`, `channels.lifecycle` and `channels.streaming` were
// declared in CAP and were checked NOWHERE (found 2026-08-16; the stream is no
// longer advertised or declared, since nothing reads it). Only
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
ok('0.5 host whose featureSets/update OMITS effectiveCapabilities stays denied (fail-closed, §5.4)',
   !capAllowed(true, '0.5', null, CAP.channelsPublish));  // update-without-grant leaves grant null

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

// The typing path is a NOTIFICATION — no response, so the gate must drop it
// silently rather than refuse. Assert the drop happens before the relay starts.
// (The generation stream, channels/outgoing/chunk, drives nothing any more, so
// it has no gate to check.)
{
  const at = src.indexOf('private onTyping(');
  const body = at >= 0 ? src.slice(at, at + 1400) : '';
  const gate = body.indexOf('capAllowed(CAP.channelsTyping)');
  const start = body.indexOf('this.typing.start(');
  ok('channels/typing is gated on channelsTyping', gate >= 0);
  ok('the typing gate precedes the relay starting', gate >= 0 && start >= 0 && gate < start);
  ok('nothing acts on a chunk of the generation stream', !src.includes('method.CHANNELS_OUTGOING_CHUNK'));
  // The signal is taken as it arrives, from the connection's notification
  // event, and only there: the serve loop also reads every notification from
  // its queue, and must not act on the same signal a second time.
  ok('the typing signal is handled in one place, the notification listener',
     src.split('method.CHANNELS_TYPING').length === 2 && src.split('this.onTyping(').length === 2 &&
     /this\.conn\.on\("notification"[\s\S]{0,200}method\.CHANNELS_TYPING[\s\S]{0,200}this\.onTyping\(/.test(src));
}

// A host sends channels/typing only to a server whose grant has
// channels.typing, and grants only what the server advertises, so the
// advertisement and the feature set are what turn the dots on. Nothing reads
// the generation stream, so the door doesn't ask for it.
{
  const { MCPL_ADVERTISEMENT, FEATURE_SETS } = await import('../mcpl/declaration.ts');
  ok('the door advertises channels.typing', MCPL_ADVERTISEMENT.channels.typing === true);
  ok('eidoverse.typing uses channels.typing', FEATURE_SETS['eidoverse.typing'].uses.includes(CAP.channelsTyping));
  ok('the door does not advertise channels.streaming', MCPL_ADVERTISEMENT.channels.streaming === false);
  ok('no feature set uses channels.streaming',
     Object.values(FEATURE_SETS).every((fs) => !fs.uses.includes('channels.streaming')));
}

// The body's speech ends the dots: the session hands each body a hook that
// stops the relay, and travel hands it on to the next body. (The live test
// covers the say itself; these pin the wiring for a travelled body, which no
// test drives.)
{
  const ctorAt = src.indexOf('this.channelId = `world:${this.agent.world}`;');
  const ctor = ctorAt >= 0 ? src.slice(ctorAt, ctorAt + 400) : '';
  ok('the session gives its first body a say hook that stops the relay',
     ctor.includes('this.agent.onSaid = () => this.typing.stop();'));
  const travelAt = src.indexOf('next.onEvent = old.onEvent;');
  const travel = travelAt >= 0 ? src.slice(travelAt, travelAt + 1600) : '';
  const handed = travel.indexOf('next.onSaid = old.onSaid;');
  const taken = travel.indexOf('old.onSaid = null;');
  ok('travel hands the say hook to the next body before taking it from the old one',
     handed >= 0 && taken >= 0 && handed < taken);
}

// tools/list and tools/call were the original offenders — keep them pinned.
for (const m of ['tools/list', 'tools/call']) {
  const at = src.indexOf(`case "${m}"`);
  ok(`${m} consults toolsAllowed()`,
     at >= 0 && src.slice(at, at + 600).includes('toolsAllowed()'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
