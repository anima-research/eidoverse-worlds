#!/usr/bin/env bun
// MCPL RFC-011 targeted publish: the world channel declares where a publish
// lands, and a publish naming a place is honored or refused.
//
// The world has no threads inside it, so its descriptor declares
// `capabilities.publish.target: 'root'`: a publish is said aloud in the world
// itself or not at all. A `threadId` of null is the world (echoed back as
// null); a thread id, or any other value, is refused before anything is said;
// an absent one is a legacy caller, answered exactly as before.
//
// Like channel-cap-gate-test.mjs, the decision is tested as a function and
// the wiring is asserted against net-server.ts's source, because a session
// needs a live world to construct.

import { PUBLISH_TARGET, publishTargetRefusal } from '../mcpl/declaration.ts';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- the decision ----------------------------------------------------------

ok('the world declares root', PUBLISH_TARGET.target === 'root');
ok('absent threadId: a legacy caller, not refused', publishTargetRefusal(undefined) === undefined);
ok('null threadId: the world itself, not refused', publishTargetRefusal(null) === undefined);
for (const bad of ['t-1', '', 7, { id: 't' }, ['t'], false]) {
  ok(`threadId ${JSON.stringify(bad)} is refused`, typeof publishTargetRefusal(bad) === 'string');
}
ok('a refusal says why', /no threads/.test(publishTargetRefusal('t-1') ?? ''));

// ---- the wiring ------------------------------------------------------------

const src = await Bun.file(new URL('../mcpl/net-server.ts', import.meta.url)).text();

{
  const at = src.indexOf('private channelDescriptors()');
  const body = src.slice(at, at + 1400);
  ok('the world channel descriptor declares PUBLISH_TARGET',
     at >= 0 && body.includes('capabilities: { publish: PUBLISH_TARGET }'));
}
{
  const at = src.indexOf('private handlePublish(');
  const body = src.slice(at, at + 2200);
  const refusal = body.indexOf('publishTargetRefusal(params.threadId)');
  const say = body.indexOf('this.agent.say(');
  ok('handlePublish consults publishTargetRefusal', refusal >= 0);
  ok('the refusal precedes anything said', refusal >= 0 && say >= 0 && refusal < say);
  ok('a refusal is a result with a reason and no message, not an error',
     body.includes('return { delivered: false, reason: refusal }'));
  ok('a null target is echoed back as null',
     body.includes('...(targeted ? { threadId: null } : {})'));
  ok('the legacy result shape stays { delivered: true } without the field',
     body.includes('const targeted = params.threadId === null'));
}
{
  // The join prepare proposes the next world's descriptor by spreading the
  // current one, so a traveled-to world declares the same target.
  const at = src.indexOf('...this.channelDescriptors()[0],');
  ok('the travel prepare inherits the declaration', at >= 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
