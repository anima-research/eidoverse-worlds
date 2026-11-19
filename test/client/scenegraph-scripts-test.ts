// scenegraph-scripts-test — the scene graph's 📜 scripts section tells a roster read that got no answer from a world with no scripts (#291).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/scenegraph-scripts-test.ts
// The real scenegraph.js, its client imports stood in; requestDebug answers, rejects, or answers again as each case sets.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
import { mock } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { suite } from '../gate/suite.ts';
const { check, done } = suite('scenegraph-scripts');
const noop = () => {};
let debugAnswer: (opts: any) => Promise<any> = async () => ({ events: [] });
const sections = new Map<string, (body: HTMLElement) => Promise<void>>();
class V3 { x = 0; y = 0; z = 0; set() { return this; } copy() { return this; } }
const modules: any = {
  'core.js': { THREE: { Vector3: V3 } },
  'base.js': { CONFIG: { name: 'me' }, bus: { on: noop, emit: noop } },
  'edit/selection.js': { selection: () => ({ kind: 'none', ids: [] }), select: noop, clear: noop },
  'world.js': { entities: new Map(), metaOf: () => null, bagOf: () => null, avatarMounts: new Map() },
  'edit/inspect.js': { editorsFor: () => [], commitEdit: () => ({}) },
  'net.js': { requestDebug: (o: any) => debugAnswer(o), replica: { active: false } },
  'edit/writes.js': { sendOps: noop, del: noop, revertPose: noop },
  'state.js': { state: {} },
  'realize/models_field.js': { offIn: () => null },
  'ui/ui.js': { makeSection: (title: string, onOpen: any) => { sections.set(title, onOpen); return { isOpen: true, remove: noop }; }, flashHint: noop, html: String },
  'ui/chat.js': { logChat: noop },
  'player/controller.js': { myState: { pos: { x: 0, y: 0, z: 0 } } },
  'ui/plainwords.js': { called: String },
};
const at = (name: string) => fileURLToPath(new URL('../../client/lib/' + name, import.meta.url));
const stale = Object.keys(modules).filter((name) => !existsSync(at(name)));   // a mock on a path that moved mocks nothing
if (stale.length) { check('every stand-in names a module that exists', false, stale.join(', ')); done(); }
for (const [name, exports] of Object.entries(modules)) mock.module(at(name), () => exports as any);
const { initSceneGraph } = await import('../../client/lib/scenegraph.js');
initSceneGraph();

// the section opens once and stays open: each check after that is one turn of its own 2.5 s poll
const body = document.createElement('div');
let poll: (() => Promise<void>) | null = null;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => Promise<void>) => { poll = fn; return 0; }) as any;
const text = () => body.textContent ?? '';
const script = { kind: 'script', id: 'lamp/blink', attach: 'lamp', status: 'active' };
debugAnswer = async () => ({ events: [script] });
try { await sections.get('📜 scripts')!(body); } finally { globalThis.setInterval = realSetInterval; }
check('(control) an answered roster lists its script', /lamp\/blink/.test(text()) && !!poll, text());
debugAnswer = async () => { throw new Error('debug: no answer within 8 s'); };
await poll!();
check("a roster read with no answer says the scripts couldn't be read, keeping the last answered script, marked",
  /couldn't be read/.test(text()) && /lamp\/blink/.test(text()) && /from the last answer/.test(text()) && !/no scripts here/.test(text()), text());
debugAnswer = async () => ({ events: [] });
await poll!();
check('(control) an answered empty roster says there are no scripts', /no scripts here/.test(text()) && !/couldn't be read/.test(text()), text());

// polls overlap (2.5 s apart, 8 s to time out); an older read's timeout landing after a newer answer changes nothing
let timeOut: (e: Error) => void = noop;
debugAnswer = () => new Promise((_, reject) => { timeOut = reject; });
const older = poll!();
debugAnswer = async () => ({ events: [script] });
await poll!();
timeOut(new Error('debug: no answer within 8 s'));
await older;
check("an older poll's timeout, landing after a newer poll's answer, leaves the newer answer standing",
  /lamp\/blink/.test(text()) && !/couldn't be read/.test(text()), text());

// the watched script's log read that got no answer is said, not shown as an empty console
debugAnswer = async (o) => (o.scripts ? { events: [script] } : { status: 'active', events: [] });
await poll!();
(body.querySelector('.sg-script') as HTMLElement).click();
await poll!();
check('(control) a watched script whose answered log is empty says the console is empty', /active/.test(text()) && /console empty/.test(text()), text());
debugAnswer = async (o) => { if (o.scripts) return { events: [script] }; throw new Error('debug: no answer within 8 s'); };
await poll!();
check("a watched script's log read with no answer says so, not that the console is empty",
  /couldn't be read/.test(text()) && !/console empty/.test(text()), text());

done();
