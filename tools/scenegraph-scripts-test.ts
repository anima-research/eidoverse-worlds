// scenegraph-scripts-test — the scene graph's 📜 scripts section tells a roster read that got no answer from a world with no scripts (#291).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/scenegraph-scripts-test.ts
// The real scenegraph.js, its client imports stood in; requestDebug answers, rejects, or answers again as each case sets.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
const noop = () => {};
let debugAnswer: (opts: any) => Promise<any> = async () => ({ events: [] });
const sections = new Map<string, (body: HTMLElement) => Promise<void>>();
class V3 { x = 0; y = 0; z = 0; set() { return this; } copy() { return this; } }
const modules: any = {
  'core.js': { THREE: { Vector3: V3 } },
  'base.js': { CONFIG: { name: 'me' }, bus: { on: noop, emit: noop } },
  'edit/selection.js': { selection: () => ({ kind: 'none', ids: [] }), select: noop, clear: noop },
  'world.js': { entities: new Map(), metaOf: () => null, bagOf: () => null, avatarMounts: new Map() },
  'inspect.js': { editorsFor: () => [], commitEdit: () => ({}) },
  'lights.js': {},
  'net.js': { requestDebug: (o: any) => debugAnswer(o), replica: { active: false } },
  'editwrites.js': { sendOps: noop, del: noop, revertPose: noop },
  'state.js': { state: {} },
  'realize/models_field.js': { offIn: () => null },
  'ui.js': { makeSection: (title: string, onOpen: any) => { sections.set(title, onOpen); return { isOpen: false, remove: noop }; }, flashHint: noop, html: String },
  'chat.js': { logChat: noop },
  'controller.js': { myState: { pos: { x: 0, y: 0, z: 0 } } },
  'plainwords.js': { called: String },
};
for (const [name, exports] of Object.entries(modules)) mock.module(fileURLToPath(new URL('../client/lib/' + name, import.meta.url)), () => exports as any);
const { initSceneGraph } = await import('../client/lib/scenegraph.js');
initSceneGraph();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const open = async () => { const body = document.createElement('div'); let threw: unknown = null;
  try { await sections.get('📜 scripts')!(body); } catch (e) { threw = e; } return { text: body.textContent ?? '', threw }; };

const script = { kind: 'script', id: 'lamp/blink', attach: 'lamp', status: 'active' };
debugAnswer = async () => ({ events: [script] });
let r = await open();
check('(control) an answered roster lists its script', r.threw === null && /lamp\/blink/.test(r.text), JSON.stringify(r));
debugAnswer = async () => { throw new Error('debug: no answer within 8 s'); };
r = await open();
check('a roster read with no answer says the world did not answer, not that there are no scripts',
  r.threw === null && /didn't answer/.test(r.text) && !/no scripts here/.test(r.text), JSON.stringify(r));
debugAnswer = async () => ({ events: [] });
r = await open();
check('(control) an answered empty roster says there are no scripts', r.threw === null && /no scripts here/.test(r.text) && !/didn't answer/.test(r.text), JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
