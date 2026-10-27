// grant-command-test — /grant changes a grant without losing what it doesn't name (house review of #260, client/lib I6, I42).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/grant-command-test.ts
// The real handlers.js and registry.js, with the door (editwrites send), the replica and the person lookup stood in.
// Mutation (must go red): in handlers.js /grant build the non-forever value as {role, can, until} alone again (I6), or
// drop the `!role && !cur` refusal (I42).
import './reach-frame-fixture.ts';   // stands in for the renderer cone handlers.js reaches (avatar.js, reachnet.js)
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
const noop = () => {};
const sent: any[] = [], messages: string[] = [];
const world: any = { c: {} };
const modules: any = {
  'base.js': { CONFIG: { name: 'owner' }, bus: { on: noop, emit: noop }, report: noop },
  'capture.js': { captureFrame: noop },
  'world.js': { entities: new Map(), bagOf: () => null, roleOf: noop, worldHasOwner: () => true },
  'net.js': { net: { myId: 'owner' }, identityOf: (n: string) => (n === 'wren' ? 'u-wren' : null), replica: { st: { entities: { '@world': world } }, active: true }, replicaActive: () => true,
    sendRequest: async () => ({ ok: true, people: [] }), sendMod: noop, sendPuppet: noop, sendWorldFork: noop, sendWorldFound: noop, sendWorldReset: noop, requestDebug: noop, sendAnim: noop, sendDrag: noop },
  'remotes.js': { remotes: new Map() },
  'controller.js': { myState: { pos: { x: 0, y: 0, z: 0 } }, setPosture: noop, flightReport: () => '' },
  'thingphysics.js': { punt: noop, grab: noop, put: noop, drop: noop, throwHeld: noop }, 'chat.js': { logChat: (_w: string, t: string) => messages.push(t) },
  'ui.js': { toggleHelp: noop, flashHint: noop, toast: noop }, 'scenegraph.js': { sceneAttach: noop, sceneDetach: noop },
  'consent.js': { setPushable: noop, pushable: () => false }, 'localbody.js': { trySitOn: noop }, 'mybody.js': { getMe: () => null },
  'editwrites.js': { send: async (req: any) => { sent.push(req); return { ok: true }; } }, 'stylepanel.js': { panelAlpha: () => 1, setPanelAlpha: noop },
};
for (const [name, exports] of Object.entries(modules)) mock.module(fileURLToPath(new URL('../client/lib/' + name, import.meta.url)), () => exports as any);
await import('../client/lib/commands/handlers.js');
const { dispatch } = await import('../client/lib/commands/registry.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const settle = () => new Promise((r) => setTimeout(r, 10));
const run = async (arg: string) => { sent.length = 0; messages.length = 0; dispatch('grant', arg); await settle(); return sent.at(-1); };

// I6: a new role keeps the person's exceptions and their end, unless the command re-times it
world.c = { 'roles:u-wren': { role: 'inhabitant', can: { fly: true }, until: 9_000_000_000_000 } };
let r = await run('wren builder');
check('/grant <name> <role> keeps their exceptions and their end', r?.args?.value?.role === 'builder' && r.args.value.can?.fly === true && r.args.value.until === 9_000_000_000_000, JSON.stringify(r?.args));
r = await run('wren builder +gen');
check('…and a new exception joins the old ones', r?.args?.value?.can?.fly === true && r.args.value.can.generate === true, JSON.stringify(r?.args));
r = await run('wren builder for 2h');
const until = r?.args?.value?.until;
check('…a new duration replaces the end', typeof until === 'number' && until < 9_000_000_000_000 && r.args.value.can?.fly === true, JSON.stringify(r?.args));
r = await run('wren forever');
check('…and forever clears it', r?.args?.value && !('until' in r.args.value) && r.args.value.role === 'inhabitant' && r.args.value.can?.fly === true, JSON.stringify(r?.args));
// I42: exceptions (or a time) for someone with no grant: refused here, with what to do, never a role-less record
world.c = {};
r = await run('wren +fly');
check('exceptions for someone who holds no role send nothing, and say why', sent.length === 0 && messages.some((m) => /holds no role/.test(m)), JSON.stringify({ sent, messages }));
r = await run('wren for 2h');
check('…as does a time', sent.length === 0 && messages.some((m) => /holds no role/.test(m)), JSON.stringify({ sent, messages }));
// an owner's grant never ends (the authority refuses an owner with an until): making a timed holder owner drops the end,
// with no `forever` needed (adversarial review of the merged I6/I124 /grant)
world.c = { 'roles:u-wren': { role: 'builder', can: { fly: true }, until: 9_000_000_000_000 } };
r = await run('wren owner');
check('/grant <name> owner on a timed holder sends no end (ownership never expires)', r?.args?.value?.role === 'owner' && !('until' in r.args.value), JSON.stringify(r?.args));
r = await run('wren owner for 2h');
check('…and refuses a duration for owner rather than sending one', r === undefined || !('until' in (r?.args?.value ?? {})), JSON.stringify(r?.args));
world.c = {};
r = await run('wren builder +fly');
check('a role with exceptions for someone new is one whole grant', r?.args?.value?.role === 'builder' && r.args.value.can?.fly === true && !('until' in r.args.value), JSON.stringify(r?.args));

// the help teaches only what runs (sweep-2 C2/C3, R 10-27): the base role is inhabitant, and +gen, +fly and /epoch still work
sent.length = 0; dispatch('epoch', ''); await settle();
check('/epoch still sends the physics-engine set the help teaches', sent.at(-1)?.verb === 'set' && sent.at(-1)?.args?.component === 'physics-engine', JSON.stringify(sent.at(-1)));
{ const fs = await import('node:fs'); const help = fs.readFileSync(fileURLToPath(new URL('../defs/ui/_help.json', import.meta.url)), 'utf8');
  const { COMMANDS } = await import('../client/lib/commands/registry.js'); const g = (COMMANDS as any[]).find((c) => c.name === 'grant')?.help ?? '';
  check('the help sheet teaches no visitor role (it is inhabitant)', !/\bvisitors?\b/i.test(help) && /\/grant \* inhabitant/.test(help), help.match(/[^.]*visitor[^.]*/i)?.[0]);
  check('…and names +gen, +fly and /epoch', /\+gen/.test(help) && /\+fly/.test(help) && /\/epoch/.test(help) && /\+gen/.test(g) && /\+fly/.test(g), g); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
