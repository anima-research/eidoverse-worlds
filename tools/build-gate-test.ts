// Edit mode's rights gate (rung 3). build.js had NO test surface in this repo —
// `grep -l build.js tools/` matched comment text, not imports — so the gate the
// dock wrench advertises was, until this suite, enforced by reading only.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/build-gate-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'build-gate-stubs', setup(b) {
  for (const m of ['core', 'base', 'assets', 'lights', 'world', 'colliders', 'terrain', 'net', 'controller', 'ui', 'scenegraph', 'frames', 'seatedit'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./build-gate-stub.mjs') }));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const stub = await import('./build-gate-stub.mjs');
const build = await import('../client/lib/build.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const asRole = (role: any) => { (stub.net as any).myRights = role === undefined ? undefined : { role }; };

console.log('BUILD GATE — who may enter edit mode');

// PERMISSIVE WHEN UNKNOWN. net.myRights has no declaration in net.js's object
// literal; it lands at the snapshot or a live grant, so it is undefined for the
// whole pre-snapshot window. Denying there would make a build click vanish on a
// slow join. conjure.js:144 (`net.myRights?.gen !== false`) is the same idiom.
asRole(undefined);
check('rights not yet known: permitted (pre-snapshot, matches conjure.js)', build.mayEdit() === true);
asRole('builder');
check('builder: permitted', build.mayEdit() === true);
asRole('owner');
check('owner: permitted', build.mayEdit() === true);
asRole('visitor');
check('visitor: REFUSED', build.mayEdit() === false);
asRole('spectator');
check('any other known role: refused', build.mayEdit() === false);

console.log('\nBUILD GATE — the gate is applied at the chokepoint, not the keybind');

// Every entry point funnels through setEditMode: toggleEditMode, the dock
// action, KeyB, and the two quiet callers (holdGhost, armSeatPlacement).
asRole('visitor');
build.setEditMode(false);                       // settle
const h0 = stub.hints.length;
build.setEditMode(true);
check('a visitor cannot ENTER edit mode', build.isEditing() === false, `isEditing=${build.isEditing()}`);
check('...and is told why, out loud', stub.hints.slice(h0).some((t: string) => /build rights/.test(t)), JSON.stringify(stub.hints.slice(h0)));

// the quiet callers are gated too — "I picked a thing to place" is build intent
const h1 = stub.hints.length;
build.setEditMode(true, { quiet: true });
check('a quiet caller (holdGhost/armSeatPlacement) is gated too', build.isEditing() === false);
check('...but quietly, as asked', stub.hints.length === h1, JSON.stringify(stub.hints.slice(h1)));

// KeyB routes through toggleEditMode -> setEditMode
build.toggleEditMode();
check('KeyB/toggleEditMode is gated by the same chokepoint', build.isEditing() === false);

console.log('\nBUILD GATE — leaving is never gated');

// A client demoted MID-SESSION must not be trapped in edit mode.
asRole('builder');
build.setEditMode(true);
check('a builder enters', build.isEditing() === true);
asRole('visitor');                              // demoted while editing
build.setEditMode(false);
check('demoted mid-session: LEAVING still works (never trapped)', build.isEditing() === false);
build.setEditMode(true);
check('...and cannot re-enter afterwards', build.isEditing() === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
