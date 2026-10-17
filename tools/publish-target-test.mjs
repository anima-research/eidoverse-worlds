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
// The decision is declaration.ts's decidePublish(), run here as a function:
// a session needs a live world to construct. The wiring that can't run
// without one (the descriptor, the travel prepare, handlePublish saying only
// what the decision says) is asserted against net-server.ts's source, as in
// channel-cap-gate-test.mjs.

import { PUBLISH_TARGET, SAY_LIMIT, publishTargetRefusal, decidePublish } from '../mcpl/declaration.ts';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the target and the refusal ---------------------------------------------

// RFC-011 §3's own word, not the constant compared with itself.
ok("the world declares RFC-011's 'root'", same(PUBLISH_TARGET, { target: 'root' }));
ok('absent threadId: a legacy caller, not refused', publishTargetRefusal(undefined) === undefined);
ok('null threadId: the world itself, not refused', publishTargetRefusal(null) === undefined);
for (const bad of ['t-1', '', 7, { id: 't' }, ['t'], false]) {
  ok(`threadId ${JSON.stringify(bad)} is refused`, typeof publishTargetRefusal(bad) === 'string');
}
ok('a thread is refused as one the world lacks', /no threads \(thread "t-1" requested\)/.test(publishTargetRefusal('t-1') ?? ''));
ok('any other value is refused as invalid', /^invalid threadId 7: expected null/.test(publishTargetRefusal(7) ?? ''));
{
  const huge = 'x'.repeat(100_000);
  ok("a huge threadId isn't echoed whole", (publishTargetRefusal(huge) ?? '').length < 200);
  ok('nor a huge invalid one', (publishTargetRefusal({ id: huge }) ?? '').length < 200);
}

// ---- the decision ------------------------------------------------------------

const W = 'world:w1';
const live = { channelId: W, canSay: true };
const text = (t) => [{ type: 'text', text: t }];
const decide = (params, world = live) => decidePublish({ channelId: W, ...params }, world);

{
  const d = decide({ content: text('hello') });
  ok('legacy: says the text', d.say === 'hello');
  ok('legacy: answers exactly { delivered: true }', same(d.result, { delivered: true }), JSON.stringify(d.result));
}
{
  const d = decide({ content: [] });
  ok('legacy, no text: says nothing', d.say === undefined);
  ok('legacy, no text: answers exactly { delivered: false }', same(d.result, { delivered: false }), JSON.stringify(d.result));
}
{
  const d = decide({ threadId: null, content: text('hello') });
  ok('null target: says the text', d.say === 'hello');
  ok('null target: echoes threadId null', same(d.result, { delivered: true, threadId: null }), JSON.stringify(d.result));
}
for (const bad of ['t-1', '', 7]) {
  const d = decide({ threadId: bad, content: text('hello') });
  ok(`target ${JSON.stringify(bad)}: says nothing`, d.say === undefined);
  ok(`target ${JSON.stringify(bad)}: a refusal result, not an error`,
     d.result.delivered === false && typeof d.result.reason === 'string' && !('error' in d.result) && !('messageId' in d.result));
}
{
  const empty = decide({ threadId: null, content: [] });
  ok('null target, no text: says nothing', empty.say === undefined);
  ok('null target, no text: refused with its reason', same(empty.result, { delivered: false, reason: 'no text content; nothing was said' }), JSON.stringify(empty.result));
  const imageOnly = decide({ threadId: null, content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] });
  ok('null target, image only: refused the same way', imageOnly.say === undefined && imageOnly.result.reason === 'no text content; nothing was said');
}
{
  // The §3.2.3 boundary comes before the target: a stale channel stays an
  // error, which an RFC-011 host reads as unconfirmed, never a refusal.
  const d = decidePublish({ channelId: 'world:old', threadId: 't-1', content: text('hi') }, live);
  ok('a stale channel with a thread target gets the boundary error', d.say === undefined && d.result.error === 'unknown channel: world:old' && !('reason' in d.result), JSON.stringify(d.result));
}
{
  const away = { channelId: W, canSay: false };
  const targeted = decide({ threadId: null, content: text('hello') }, away);
  ok("null target, body can't say: refused, nothing said", targeted.say === undefined && targeted.result.delivered === false && /isn't connected/.test(targeted.result.reason ?? ''), JSON.stringify(targeted.result));
  const legacy = decide({ content: text('hello') }, away);
  ok("legacy, body can't say: goes on to say(), as before", legacy.say === 'hello' && same(legacy.result, { delivered: true }));
}
{
  const long = 'a'.repeat(SAY_LIMIT + 10);
  const legacy = decide({ content: text(long) });
  ok('legacy, long: says the first SAY_LIMIT characters', legacy.say?.length === SAY_LIMIT);
  ok('legacy, long: the result is unchanged', same(legacy.result, { delivered: true }));
  const targeted = decide({ threadId: null, content: text(long) });
  ok('null target, long: says the first SAY_LIMIT characters', targeted.say?.length === SAY_LIMIT);
  ok('null target, long: keeps the echo and names the cut', targeted.result.delivered === true && targeted.result.threadId === null && /cut to 4000 of 4010 characters/.test(targeted.result.reason ?? ''), JSON.stringify(targeted.result));
  // A pair straddling the limit is cut whole, never split.
  const pair = 'a'.repeat(SAY_LIMIT - 1) + '😀' + 'b';
  const cut = decide({ content: text(pair) }).say ?? '';
  ok('the cut never splits a surrogate pair', cut.length === SAY_LIMIT - 1 && !/[\uD800-\uDBFF]$/.test(cut));
}
{
  const mixed = decide({ threadId: null, content: [...text('look'), { type: 'image', data: 'x', mimeType: 'image/png' }] });
  ok('null target, text and an image: says the text', mixed.say === 'look');
  ok('null target, text and an image: keeps the echo and names the dropped blocks', mixed.result.threadId === null && /other blocks weren't/.test(mixed.result.reason ?? ''), JSON.stringify(mixed.result));
}

// ---- the wiring ----------------------------------------------------------------

const src = await Bun.file(new URL('../mcpl/net-server.ts', import.meta.url)).text();
// Comments don't count: a commented-out line must fail these checks.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

{
  const at = code.indexOf('private channelDescriptors()');
  const body = code.slice(at, code.indexOf('private async registerChannels()', at));
  ok('the world channel descriptor declares PUBLISH_TARGET',
     at >= 0 && /capabilities:\s*\{\s*publish:\s*PUBLISH_TARGET\s*\}/.test(body));
  ok('channels/list answers with channelDescriptors()',
     /case method\.CHANNELS_LIST:\s*this\.conn\.sendResponse\(req\.id, \{ channels: this\.channelDescriptors\(\) \}\)/.test(code));
}
{
  const at = code.indexOf('private handlePublish(');
  const body = code.slice(at, code.indexOf('\n  }\n', at));
  ok('net-server imports decidePublish', /import \{[^}]*\bdecidePublish\b[^}]*\} from "\.\/declaration\.ts"/.test(code));
  ok('handlePublish decides with decidePublish, on the agent\'s canSay',
     body.includes('decidePublish(params, { channelId: this.channelId, canSay: this.agent.canSay })'));
  ok('handlePublish says only what the decision says',
     body.includes('if (decision.say !== undefined) this.agent.say(decision.say);') &&
     (body.match(/this\.agent\.say\(/g) ?? []).length === 1);
  ok('handlePublish answers the decision\'s result', body.includes('return decision.result;'));
}
{
  // The join prepare proposes the next world's descriptor by spreading the
  // current one, so a traveled-to world declares the same target, as long as
  // nothing after the spread sets capabilities.
  const at = code.indexOf('...this.channelDescriptors()[0],');
  const literal = at >= 0 ? code.slice(at, code.indexOf('};', at)) : '';
  ok('the travel prepare inherits the declaration', at >= 0 && !/\bcapabilities\s*:/.test(literal));
}
{
  // RFC-011 §6: nothing is shown for a stream aimed at a place the world refuses.
  ok('the typing indicator skips a chunk whose target the world would refuse',
     /publishTargetRefusal\(chunk\?\.threadId\) === undefined\) this\.agent\.typing\(\)/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
