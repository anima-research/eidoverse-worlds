#!/usr/bin/env bun
// The channel capability gates: do denied capabilities refuse the REQUEST, not just the gate function?
// Absence is denial (declaration.ts §5.4); with no grant, a pre-0.5 MCPL host keeps everything, a 0.5+ host nothing, a plain-MCP host no channel verbs.

import { capabilityMatches, CAP } from '../../mcpl/declaration.ts';
import { suite } from "../gate/suite.ts";

const S = suite("channel-cap-gate");
const ok = (name, cond, detail) => S.check(name, cond, detail);

// the gate, extracted as net-server implements it (the wiring check at the bottom is the real assertion):
// plain-MCP hosts get no channel verbs, and a 0.5+ host is denied until its first featureSets/update (§5.3)
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
// the three fences the first extraction missed
ok('plain-MCP host (never declared MCPL) gets NO channel verbs',
   !capAllowed(false, null, null, CAP.channelsPublish));
ok('0.5 host with no policy yet is DENIED (deny-until-policy window)',
   !capAllowed(true, '0.5', null, CAP.channelsPublish));
ok('legacy 0.4 MCPL host with no policy keeps everything',
   capAllowed(true, '0.4', null, CAP.channelsPublish));
ok('0.5 host whose featureSets/update OMITS effectiveCapabilities stays denied (fail-closed, §5.4)',
   !capAllowed(true, '0.5', null, CAP.channelsPublish));  // update-without-grant leaves grant null

// ---- the wiring (every dispatch case's gate, typing gated before the relay, one listener, the say hook): test/client/wiring-check.ts

// a host sends channels/typing only under a channels.typing grant and grants only what's advertised, so the
// advertisement and the feature set turn the dots on
{
  const { MCPL_ADVERTISEMENT, FEATURE_SETS } = await import('../../mcpl/declaration.ts');
  ok('the door advertises channels.typing', MCPL_ADVERTISEMENT.channels.typing === true);
  ok('eidoverse.typing uses channels.typing', FEATURE_SETS['eidoverse.typing'].uses.includes(CAP.channelsTyping));
  ok('the door does not advertise channels.streaming', MCPL_ADVERTISEMENT.channels.streaming === false);
  ok('no feature set uses channels.streaming',
     Object.values(FEATURE_SETS).every((fs) => !fs.uses.includes('channels.streaming')));
}

S.done();
