// Escape is a chain, not a broadcast — the pad legend is taught once — and E
// is claimed before it is used.
//
// The defects this exists for (PR #171 review, items 4 and 6, and the E seam):
//
//  4. Escape became a KEYBOARD binding for `cancel` (stand up, leave photo
//     mode, drop pointer lock) while build.js already owned Escape as its
//     deselect chain. The controller dispatched `cancel` BEFORE the key bus,
//     so one press while sitting-and-building did both: it deselected AND
//     stood you up. The editor gets first refusal now and declines the
//     default on the press it consumes; the pad's B/○ never enters this path
//     at all (it emits `input-action` straight out of pollInput), so
//     cancel-while-building still works on a controller.
//
//  6. `input-device` fires on every SWITCH, so a mouse-for-UI, pad-for-play
//     session re-read the same six-second banner on every swap.
//
//  E is shared the same way: a climb route (controller.js) claims the press on
//  the key bus and marks it `worldHandled`; useprompt.js uses the nearest thing
//  only for a press nobody claimed, and the pad's X / □ is the same act. One
//  press must not climb a ladder AND ring the bell beside it.
//
// Real controller.js, build.js, useprompt.js and input.js on the real bus: the
// whole point is the seam between the key handlers, and a stub of either end
// would test the stub. Every OTHER client module they import is a no-op stub,
// derived from their import lists so the harness follows them as they change.
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { until } from './protocol/wait.ts';
// three by explicit path: tools/ sits outside client/, where the install is
// (see tools/core-stub.mjs) — a bare specifier only resolves with a root copy.
import * as THREE from '../client/node_modules/three/build/three.module.js';
GlobalRegistrator.register({ url: 'https://renderer.example/' });
// base.js tees the console to POST /clientlog; there is no server here
globalThis.fetch = (async () => new Response('')) as any;

const base = `${import.meta.dir}/../client/lib/`;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const canvas = document.createElement('canvas');
document.body.append(canvas);
Object.defineProperty(document, 'hasFocus', { value: () => true });

const hints: string[] = [];
const uses: string[] = [];           // what useprompt.js sent: "<id>:<action>"
const lamp = new THREE.Group();      // a bell-ringable thing beside the player
const entities = new Map<string, any>([['lamp', lamp]]);
const things = new Map<string, any>();   // id → bag, what useprompt reads through bags()
let ladder = false;                  // a climb route in reach: E boards it

// windows.js is real for escapeDismisses(): which open menus an Escape closes is the very thing under test
const REAL = new Set(['edit/selection.js', 'base.js', 'input.js', 'controller.js', 'build.js', 'useprompt.js', 'markup.js', 'windows.js']);
const overrides: Record<string, Record<string, unknown>> = {
  'core.js': { THREE, scene, camera, canvas, renderer: null },
  'ui.js': {
    isOverlayOpen: () => false,
    flashHint: (html: string) => { hints.push(String(html)); },
    html: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
  },
  'climb.js': { climbing: () => false, startClimb: () => ladder, cancelClimb() {} },
  'colliders.js': { resolveColliders: (p: any) => p, lastBlockedTop: () => null, findSeat: () => null, raySegment: () => null },
  'world.js': { entities, bags: () => things, bagOf: (id: string) => things.get(id) ?? null, comps: new Map(), entityMeta: new Map(), editHolds: new Set() },
  'myview.js': { outOfMyView: () => false },
  'xrask.js': { xrActive: () => false },
  'plainwords.js': { nameOf: (id: string) => id, plain: (w: string) => w },
  'net.js': { net: { myId: 'me' } },
  'thingphysics.js': {
    requestWithBody: async (verb: string, args: any) => { if (verb === 'use') uses.push(`${args.id}:${args.action}`); return { ok: true }; },
    physicsApi: {},
  },
  'seatedit.js': { seatSelected: () => false, cancelSeatArm: () => false, seatArmed: () => false },
  'actions.js': { register() {} },
  // build.js reads these through a namespace import (import * as Edits), which the import scan can't enumerate
  'editwrites.js': { compsOf: () => ({}), revertPose() {} },
};
const wanted = new Map<string, Set<string>>();
for (const file of ['controller.js', 'build.js', 'useprompt.js', 'input.js']) {
  const src = readFileSync(base + file, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*'\.\/([\w./]+\.js)'/g)) {
    const names = wanted.get(m[4]) ?? new Set<string>();
    for (const part of (m[2] ?? '').split(',')) { const n = part.trim().split(/\s+as\s+/)[0]; if (n) names.add(n); }
    if (m[1]) names.add('default');
    wanted.set(m[4], names);
  }
  for (const m of src.matchAll(/^import\s*'\.\/([\w./]+\.js)'/gm)) if (!wanted.has(m[1])) wanted.set(m[1], new Set());
}
for (const [file, names] of wanted) {
  if (REAL.has(file)) continue;
  const exports: Record<string, unknown> = {};
  for (const n of names) exports[n] = () => undefined;
  Object.assign(exports, overrides[file] ?? {});
  mock.module(base + file, () => exports);
}

const { bus } = await import('../client/lib/base.js');
const { noteInput } = await import('../client/lib/input.js');
const { myState, setPosture, getPosture, togglePhotoMode } = await import('../client/lib/controller.js');
const photo = async () => (await import('../client/lib/controller.js')).photoMode;   // a live binding, read fresh
const { setBuildMode, isBuilding, select, hasSelection } = await import('../client/lib/build.js');
const { initUsePrompt } = await import('../client/lib/useprompt.js');
initUsePrompt({ myPos: () => myState.pos, camera, editing: () => isBuilding(), busy: () => false });

const actions: string[] = [];
bus.on('input-action', (a: string) => actions.push(a));
let stands = 0;                      // localbody.js's mounted-seat dismount listens here
bus.on('cancel-stand', () => { stands++; });
const escape = () => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Escape', key: 'Escape' });
  window.dispatchEvent(e);
  return e;
};
const sitOnABench = () => { setPosture('sit'); myState.seat = 'bench'; };

// ---- item 4: one press, one action -----------------------------------------

sitOnABench();
setBuildMode(true, { quiet: true });
select('lamp');
assert.equal(hasSelection(), true, 'fixture: something is selected');

let e = escape();
assert.equal(hasSelection(), false, 'the editor still gets the press');
assert.equal(e.defaultPrevented, true, 'a consumed press is a declined default');
assert.deepEqual(actions, [], 'deselecting must not ALSO stand you up');
assert.equal(myState.seat, 'bench');
assert.equal(getPosture(), 'sit');

// The bottom rung of the editor's chain is still the editor's: leaving build
// mode is one press, and not one press plus a dismount.
e = escape();
assert.equal(isBuilding(), false, 'the next press leaves build mode');
assert.equal(e.defaultPrevented, true);
assert.deepEqual(actions, []);
assert.equal(myState.seat, 'bench', 'leaving build mode is not leaving the seat');

// Nothing left to dismiss: the press falls all the way through, which is the
// binding the PR added and it has to keep working.
e = escape();
assert.equal(e.defaultPrevented, false, 'an unclaimed press is not declined');
assert.deepEqual(actions, ['cancel'], 'Escape with nothing selected still cancels');
assert.equal(myState.seat, null);
assert.equal(getPosture(), null);

// ---- item 4: the pad is not the keyboard -----------------------------------
// B/○ reaches `cancel` through pollInput, never through the keydown handler,
// so the editor's first refusal must not reach it: standing up with a
// selection live is exactly what the button is for.
actions.length = 0;
sitOnABench();
setBuildMode(true, { quiet: true });
select('lamp');
bus.emit('input-action', 'cancel');
assert.deepEqual(actions, ['cancel']);
assert.equal(myState.seat, null, 'B / ○ stands you up even mid-build');
assert.equal(getPosture(), null);
assert.equal(hasSelection(), true, 'and it leaves the editor alone');
setBuildMode(false, { quiet: true });

// ---- one press, one rung: photo mode goes before the seat --------------------
// controller.js's cancel used to leave photo mode AND stand you up (and
// localbody.js dismounted on the same raw cancel). Now the chain stops at the
// first rung it takes, for the key and the pad alike.
// the pad section left its selection live (on purpose); a key Escape would deselect it first, which is the chain working
escape();
assert.equal(hasSelection(), false, 'fixture: nothing selected');
for (const press of [() => { escape(); }, () => bus.emit('input-action', 'cancel')]) {
  stands = 0; sitOnABench();
  togglePhotoMode();
  assert.equal(await photo(), true, 'fixture: photo mode on, seated');
  press();
  assert.equal(await photo(), false, 'the first press leaves photo mode');
  assert.equal(myState.seat, 'bench', 'and only that: still seated');
  assert.equal(getPosture(), 'sit');
  assert.equal(stands, 0, 'no mounted-seat dismount either');
  press();
  assert.equal(myState.seat, null, 'the second press stands you up');
  assert.equal(stands, 1);
}

// ---- an Escape that closes a menu does nothing else -------------------------
// ui.js / chat.js / dropdown.js close their own pops on a window keydown, and
// they run before the controller without declining the default. Here a closer
// registered FIRST stands in for them: by the time the controller hears the
// press, the menu is already gone.
const menu = document.createElement('div');
menu.className = 'dd-pop';
// (registered after the controller, so on document's capture phase to run first). A real press targets the focused
// element and passes window → document → body, so these presses do too (escape() above fires at window alone).
document.addEventListener('keydown', (k) => { if (k.code === 'Escape') menu.remove(); }, true);
const escapeAtBody = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Escape', key: 'Escape' }));
for (const [what, open] of [['a dropdown', () => document.body.append(menu)],
                            ['an overlay', () => { menu.className = 'scrim open'; document.body.append(menu); }]] as const) {
  actions.length = 0; stands = 0; sitOnABench();
  open();
  escapeAtBody();
  assert.equal(menu.isConnected, false, `fixture: the press closed ${what}`);
  assert.deepEqual(actions, [], `closing ${what} is not also a cancel`);
  assert.equal(myState.seat, 'bench', `closing ${what} leaves you seated`);
  assert.equal(stands, 0);
}
sitOnABench(); setBuildMode(true, { quiet: true }); select('lamp');
menu.className = 'dd-pop'; document.body.append(menu);
escapeAtBody();
assert.equal(hasSelection(), true, 'closing a menu while building does not also deselect');
setBuildMode(false, { quiet: true });
myState.seat = null; setPosture(null);

// ---- item 6: the legend is taught once -------------------------------------

const legends = () => hints.filter(h => h.startsWith('controller —')).length;
assert.equal(legends(), 0, 'fixture: no pad has spoken yet');
noteInput('gamepad');
assert.equal(legends(), 1, 'the first pad frame teaches the legend');
noteInput('keyboard'); noteInput('gamepad');
noteInput('keyboard'); noteInput('gamepad');
assert.equal(legends(), 1, 'reaching for the mouse and back does not re-teach it');

// ---- E: a ladder's press is not also a use ---------------------------------

things.set('lamp', { reactions: { toggle: { kind: 'toggle' } } });
myState.pos.set(0, 0, 0);
const pressE = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyE', key: 'e' }));
  window.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, code: 'KeyE', key: 'e' }));
};
// A use is async (useNearest awaits the authority), so a press that must NOT use is followed by one that must, and
// the wait is for that one (wait.ts until, no fixed sleep): had the first used, it would have landed first.
const used = (n: number) => until(`${n} use(s)`, () => uses.length >= n || null, { ms: 2000 });
ladder = true; pressE();
ladder = false; pressE(); await used(1);
assert.deepEqual(uses, ['lamp:toggle'], 'E at a ladder climbs and does not also use; E with no ladder is the contextual use');

// ---- X / □ is the same act as E --------------------------------------------

uses.length = 0;
bus.emit('input-action', 'use'); await used(1);
assert.deepEqual(uses, ['lamp:toggle'], 'the pad\'s use button uses what E would');
setBuildMode(true, { quiet: true });
bus.emit('input-action', 'use');
setBuildMode(false, { quiet: true });
bus.emit('input-action', 'use'); await used(2);
assert.deepEqual(uses, ['lamp:toggle', 'lamp:toggle'], 'and, like E, does nothing while building');

console.log('Escape priority, E arbitration and pad-hint checks passed');
process.exit(0);   // the DOM shim keeps timers alive
