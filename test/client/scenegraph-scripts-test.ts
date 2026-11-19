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
const removed: string[] = [];   // what each remove sent
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
  'edit/writes.js': { sendOps: (_ops: any, o: any) => removed.push(o?.what), del: noop, revertPose: noop },
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

// overlapping paints: each waits on its own log read, so they can land out of order
const glow = { kind: 'script', id: 'lamp/glow', attach: 'lamp', status: 'active' };
const deferred = () => { let answer: (v: any) => void = noop; const p = new Promise((r) => { answer = r; }); return { p, answer }; };
const logLine = (status: string, line: string) => ({ status, events: [{ ts: 0, kind: 'script-log', line }] });
const tick = async () => { for (let i = 0; i < 20; i++) await null; };   // the stand-ins answer as promises: microtasks are enough
// the roster changes while a paint waits: when it lands it shows the roster as it is then, not as it was when it began
let roster = [script], held = deferred(), heldAsked = false;
debugAnswer = async (o) => (o.scripts ? { events: roster } : (heldAsked ? new Promise(noop) : (heldAsked = true, held.p)));
const first = poll!();
await tick(); await tick();
roster = [script, glow];
poll!();   // a newer paint, its log read never answered
await tick(); await tick();
held.answer(logLine('active', 'first paint'));
await first;
check("a paint that lands while a newer one waits shows the roster as it is now, not as it was when it began",
  /first paint/.test(text()) && /lamp\/glow/.test(text()), text());
// an older paint, landing after a newer one, changes nothing: the same script, then after a switch to another
let calls = 0; held = deferred();
debugAnswer = async (o) => (o.scripts ? { events: roster } : ++calls === 1 ? held.p : logLine('active', 'newer paint'));
const olderPaint = poll!();
await tick(); await tick();
await poll!();
held.answer(logLine('asleep', 'older paint'));
await olderPaint;
check("an older paint's log answer, landing after a newer paint's, changes nothing", /newer paint/.test(text()) && !/older paint/.test(text()), text());
calls = 0; held = deferred();
debugAnswer = async (o) => (o.scripts ? { events: roster } : ++calls === 1 ? held.p : logLine('active', 'glow line'));
const blinkPaint = poll!();
await tick(); await tick();
(body.querySelector('.sg-script[data-id="lamp/glow"]') as HTMLElement).click();   // repaints at once, watching lamp/glow
await tick(); await tick();
held.answer(logLine('active', 'blink late'));
await blinkPaint;
check("after a switch to lamp/glow, lamp/blink's late log answer isn't painted over glow's", /glow line/.test(text()) && !/blink late/.test(text()), text());

// the reverse order: lamp/blink's read lands while lamp/glow's, asked after it, is still out
const header = () => body.querySelector('div[style*="border-top"] b')?.textContent ?? null;
let blinkRead = deferred(), glowRead = deferred();
debugAnswer = async (o) => (o.scripts ? { events: roster } : o.script === 'lamp/blink' ? blinkRead.p : glowRead.p);
(body.querySelector('.sg-script[data-id="lamp/blink"]') as HTMLElement).click();
await tick();
(body.querySelector('.sg-script[data-id="lamp/glow"]') as HTMLElement).click();
await tick();
blinkRead.answer(logLine('active', 'blink first'));
await tick(); await tick();
check("lamp/blink's read landing before lamp/glow's (asked after it) isn't painted: glow is what is watched", !/blink first/.test(text()) && header() !== 'lamp/blink', JSON.stringify({ header: header(), text: text() }));
glowRead.answer(logLine('active', 'glow slow'));
await tick(); await tick();
check("(control) …and glow's read, when it lands, is", header() === 'lamp/glow' && /glow slow/.test(text()), JSON.stringify({ header: header(), text: text() }));
// remove removes the script the section shows, even while the paint for a newly watched one is out
blinkRead = deferred(); blinkRead.answer(logLine('active', 'blink shown')); glowRead = deferred();
(body.querySelector('.sg-script[data-id="lamp/blink"]') as HTMLElement).click();
await tick(); await tick();
(body.querySelector('.sg-script[data-id="lamp/glow"]') as HTMLElement).click();   // its read is held: the section still shows blink
await tick();
const shown = header();
removed.length = 0;
(body.querySelector('[data-act="unbind"]') as HTMLElement).click();
check("remove, clicked under a header, removes that header's script", shown === 'lamp/blink' && removed.length === 1 && removed[0] === `remove ${shown}`, JSON.stringify({ shown, removed }));

done();
