// command-replies-test — what a chat command says when its request got no answer, and where its hints point.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/command-replies-test.ts
// The real handlers.js and registry.js, with net.js's requestDebug stood in (grant-command-test's harness).
// #291: /debug tells an unanswered flight-recorder read from an empty recorder. #285: /rename and /name's help name what reopens the door.
import '../fixtures/reach-frame-fixture.ts';   // stands in for the renderer cone handlers.js reaches (avatar.js, reachnet.js)
import { mock } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { until } from '../gate/wait.ts';
import { suite } from '../gate/suite.ts';
const { check, done } = suite('command-replies');
const noop = () => {};
const messages: string[] = [];
let debugAnswer: () => Promise<any> = async () => ({ events: [] });
const modules: any = {
  'base.js': { CONFIG: { name: 'me' }, bus: { on: noop, emit: noop }, report: noop },
  'render/capture.js': { captureFrame: noop },
  'world.js': { entities: new Map(), bagOf: () => null, roleOf: noop, worldHasOwner: () => true },
  'net.js': { net: { myId: 'me' }, identityOf: () => null, replica: { st: { entities: {} }, active: true }, replicaActive: () => true,
    sendRequest: async () => ({ ok: true }), sendMod: noop, sendPuppet: noop, sendWorldFork: noop, sendWorldFound: noop, sendWorldReset: noop,
    requestDebug: () => debugAnswer(), sendAnim: noop, sendDrag: noop },
  'player/remotes.js': { remotes: new Map() },
  'player/controller.js': { myState: { pos: { x: 0, y: 0, z: 0 } }, setPosture: noop, flightReport: () => '' },
  'thingphysics.js': { punt: noop, grab: noop, put: noop, drop: noop, throwHeld: noop }, 'ui/chat.js': { logChat: (_w: string, t: string) => messages.push(t) },
  'ui/ui.js': { toggleHelp: noop, flashHint: noop, toast: noop }, 'scenegraph.js': { sceneAttach: noop, sceneDetach: noop },
  'player/consent.js': { setPushable: noop, pushable: () => false }, 'player/localbody.js': { trySitOn: noop, sitOnGround: noop }, 'player/mybody.js': { getMe: () => null },
  'edit/writes.js': { send: async () => ({ ok: true }) }, 'ui/stylepanel.js': { panelAlpha: () => 1, setPanelAlpha: noop },
};
const at = (name: string) => fileURLToPath(new URL('../../client/lib/' + name, import.meta.url));
const stale = Object.keys(modules).filter((name) => !existsSync(at(name)));   // a mock on a path that moved mocks nothing
if (stale.length) { check('every stand-in names a module that exists', false, stale.join(', ')); done(); }
for (const [name, exports] of Object.entries(modules)) mock.module(at(name), () => exports as any);
await import('../../client/lib/ui/commands/handlers.js');
const { dispatch, COMMANDS } = await import('../../client/lib/ui/commands/registry.js');

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
check("/rename's hint says ?door re-opens the front door, a Discord-verified name being Discord's, and never to clear ew-name",
  said.length === 1 && /\?door/.test(said[0]) && /front door/.test(said[0]) && /Discord/.test(said[0]) && !/ew-name/.test(said[0]) && !/authority/.test(said[0]), JSON.stringify(said));
const nameHelp = COMMANDS.find((c: any) => c.name === 'name')?.help ?? '';
check("/name's help says the name is chosen at the front door by ?door (not 'the authority'), a Discord-verified one being Discord's",
  /front door/.test(nameHelp) && /\?door/.test(nameHelp) && !/authority/.test(nameHelp) && /Discord/.test(nameHelp), nameHelp);

done();
