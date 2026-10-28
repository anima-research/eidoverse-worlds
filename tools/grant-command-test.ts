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
world.c = { 'roles:u-wren': { role: 'member', can: { fly: true }, until: 9_000_000_000_000 } };
let r = await run('wren builder');
check('/grant <name> <role> keeps their exceptions and their end', r?.args?.value?.role === 'builder' && r.args.value.can?.fly === true && r.args.value.until === 9_000_000_000_000, JSON.stringify(r?.args));
r = await run('wren builder +gen');
check('…and a new exception joins the old ones', r?.args?.value?.can?.fly === true && r.args.value.can.generate === true, JSON.stringify(r?.args));
r = await run('wren builder for 2h');
const until = r?.args?.value?.until;
check('…a new duration replaces the end', typeof until === 'number' && until < 9_000_000_000_000 && r.args.value.can?.fly === true, JSON.stringify(r?.args));
r = await run('wren forever');
check('…and forever clears it', r?.args?.value && !('until' in r.args.value) && r.args.value.role === 'member' && r.args.value.can?.fly === true, JSON.stringify(r?.args));
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

// the help teaches only what runs (sweep-2 C2/C3, R 10-27): the base role is member, and +gen, +fly and /epoch still work
sent.length = 0; dispatch('epoch', ''); await settle();
check('/epoch still sends the physics-engine set the help teaches', sent.at(-1)?.verb === 'set' && sent.at(-1)?.args?.component === 'physics-engine', JSON.stringify(sent.at(-1)));
{ const fs = await import('node:fs'); const help = fs.readFileSync(fileURLToPath(new URL('../defs/ui/_help.json', import.meta.url)), 'utf8');
  const { COMMANDS } = await import('../client/lib/commands/registry.js'); const g = (COMMANDS as any[]).find((c) => c.name === 'grant')?.help ?? '';
  check('the help sheet teaches no visitor role (it is member)', !/\bvisitors?\b/i.test(help) && /\/grant \* member/.test(help), help.match(/[^.]*visitor[^.]*/i)?.[0]);
  check('…and names +gen, +fly and /epoch', /\+gen/.test(help) && /\+fly/.test(help) && /\/epoch/.test(help) && /\+gen/.test(g) && /\+fly/.test(g), g); }

// R 10-28 (item 13): a word /access doesn't take is refused with the doors it does take, each said; the role names are the
// world's registry's (an owner renamed member here), never typed into the words. No aliases.
{ const cmd = async (c: string, arg: string) => { sent.length = 0; messages.length = 0; dispatch(c, arg); await settle(); };
  world.c = { 'role-defs': { member: { name: 'Regular' } } };
  for (const w of ['members', 'visitors']) { await cmd('access', w);
    const m = messages.join(' ');
    check(`/access ${w} sends nothing and teaches the four doors`, sent.length === 0 && new RegExp(`'${w}' isn't one of the doors`).test(m) && ['invite-only', 'watch', 'public', 'open'].every((d) => m.includes(`${d} (`)), m); }
  const m = messages.join(' ');
  check('…naming the newcomer roles from the registry (a renamed member reads as its name)', /newcomers get the Regular role/.test(m) && /newcomers get the Builder role/.test(m), m);
  await cmd('access', 'public');
  check('…and a real door still sets it', sent.length === 1 && JSON.stringify(sent[0]).includes('"join":"anyone"'), JSON.stringify(sent));
  // R 10-28 (item 4): /boom [power] [radius] and /blast are a force request at my feet
  await cmd('boom', '5 10');
  check('/boom 5 10 sends force {at: my feet, power 5, radius 10}', sent.length === 1 && sent[0].verb === 'force' && JSON.stringify(sent[0].args) === JSON.stringify({ at: [0, 0, 0], power: 5, radius: 10 }), JSON.stringify(sent));
  const { resolveCommand } = await import('../client/lib/commands/registry.js');
  await cmd(resolveCommand('blast')?.name ?? 'blast', '');   // chat.js resolves the typed word, then dispatches
  check('/blast is /boom, with the authority\'s defaults', sent.length === 1 && sent[0].verb === 'force' && JSON.stringify(sent[0].args) === JSON.stringify({ at: [0, 0, 0] }), JSON.stringify(sent)); }

// SWEEP-3 N5: /grant * ±gen / ±fly write default-role.can (merged over what it holds, the role kept); N6: /role shows +gen / +fly
{ world.c = { 'default-role': { role: 'builder', can: { fly: true } } };
  let g = await run('* +gen');
  check('/grant * +gen merges generate into default-role.can, keeping fly and the role', g?.args?.component === 'default-role' && g.args.merge === true && g.args.value?.can?.generate === true && g.args.value.can.fly === true && !('role' in g.args.value), JSON.stringify(g?.args));
  g = await run('* member -fly');
  check('/grant * <role> -fly sets both', g?.args?.value?.role === 'member' && g.args.value.can?.fly === false, JSON.stringify(g?.args));
  const net: any = modules['net.js'].net; net.myRights = { role: 'builder', permissions: ['build', 'generate', 'fly'] };
  messages.length = 0; dispatch('role', ''); await settle();
  check('/role shows +gen and +fly', messages.some((m) => /^you: builder \+gen \+fly/.test(m)), JSON.stringify(messages)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
