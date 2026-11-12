// command-replies-test — what a chat command says when its request got no answer, and where its hints point.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/command-replies-test.ts
// The real handlers.js and registry.js, with net.js's requestDebug stood in (grant-command-test's harness).
// #291: /debug tells an unanswered flight-recorder read from an empty recorder. #285: /rename's hint names what reopens the door.
import './reach-frame-fixture.ts';   // stands in for the renderer cone handlers.js reaches (avatar.js, reachnet.js)
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { until } from './protocol/wait.ts';
const noop = () => {};
const messages: string[] = [];
let debugAnswer: () => Promise<any> = async () => ({ events: [] });
const modules: any = {
  'base.js': { CONFIG: { name: 'me' }, bus: { on: noop, emit: noop }, report: noop },
  'capture.js': { captureFrame: noop },
  'world.js': { entities: new Map(), bagOf: () => null, roleOf: noop, worldHasOwner: () => true },
  'net.js': { net: { myId: 'me' }, identityOf: () => null, replica: { st: { entities: {} }, active: true }, replicaActive: () => true,
    sendRequest: async () => ({ ok: true }), sendMod: noop, sendPuppet: noop, sendWorldFork: noop, sendWorldFound: noop, sendWorldReset: noop,
    requestDebug: () => debugAnswer(), sendAnim: noop, sendDrag: noop },
  'remotes.js': { remotes: new Map() },
  'controller.js': { myState: { pos: { x: 0, y: 0, z: 0 } }, setPosture: noop, flightReport: () => '' },
  'thingphysics.js': { punt: noop, grab: noop, put: noop, drop: noop, throwHeld: noop }, 'chat.js': { logChat: (_w: string, t: string) => messages.push(t) },
  'ui.js': { toggleHelp: noop, flashHint: noop, toast: noop }, 'scenegraph.js': { sceneAttach: noop, sceneDetach: noop },
  'consent.js': { setPushable: noop, pushable: () => false }, 'localbody.js': { trySitOn: noop }, 'mybody.js': { getMe: () => null },
  'editwrites.js': { send: async () => ({ ok: true }) }, 'stylepanel.js': { panelAlpha: () => 1, setPanelAlpha: noop },
};
for (const [name, exports] of Object.entries(modules)) mock.module(fileURLToPath(new URL('../client/lib/' + name, import.meta.url)), () => exports as any);
await import('../client/lib/commands/handlers.js');
const { dispatch } = await import('../client/lib/commands/registry.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const run = async (cmd: string, arg = '') => { messages.length = 0; dispatch(cmd, arg); await until(`/${cmd} says something`, () => messages.length > 0 || null, { ms: 2000 }).catch(() => null); return [...messages]; };

// #291: requestDebug rejects when no answer came (net.js, history-request-test); /debug says so
debugAnswer = async () => { throw new Error('debug: no answer within 8 s'); };
let said = await run('debug', '5');
check("/debug with no answer says the recorder couldn't be read, not that nothing bounced",
  said.length === 1 && /couldn't be read/.test(said[0]) && /no answer within 8 s/.test(said[0]) && !/empty/.test(said[0]), JSON.stringify(said));
debugAnswer = async () => ({ events: [] });
said = await run('debug', '5');
check('(control) /debug with an empty answer says the recorder is empty', said.length === 1 && /flight recorder is empty/.test(said[0]), JSON.stringify(said));
debugAnswer = async () => ({ events: [{ ts: 0, kind: 'deny', verb: 'spawn' }] });
said = await run('debug', '5');
check('(control) /debug with one event prints it', said.length === 1 && /\[deny\] verb=spawn/.test(said[0]), JSON.stringify(said));

// #285: the door opens on ?door (main.js firstRun), not on clearing ew-name, which only turns the name into a guest's
said = await run('rename');
check("/rename's hint says reload with ?door, at the door, and never to clear ew-name",
  said.length === 1 && /\?door/.test(said[0]) && /\bdoor\b/.test(said[0].replace(/\?door/g, '')) && !/ew-name/.test(said[0]) && !/authority/.test(said[0]), JSON.stringify(said));
// bot #6: a Discord sign-in's door shows that account's name, with no field, so ?door alone can't rename them
modules['base.js'].CONFIG.authed = true;
said = await run('rename');
modules['base.js'].CONFIG.authed = false;
check("/rename, signed in with Discord: says the name is the account's, and that logging out frees it",
  said.length === 1 && /Discord/.test(said[0]) && /log out/i.test(said[0]), JSON.stringify(said));
const { COMMANDS } = await import('../client/lib/commands/registry.js');
const nameHelp = COMMANDS.find((c: any) => c.name === 'name')?.help ?? '';
check("/name's help says the name is chosen at the door (not 'the authority'), a Discord sign-in's being the account's", /at the door/.test(nameHelp) && !/authority/.test(nameHelp) && /Discord/.test(nameHelp), nameHelp);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
