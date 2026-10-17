// first person hides your own nameplate (owner, 10-01: "make it invisible in first-person mode"). Drives the REAL
// controller.js (against tools/posture-tiles-stub.mjs, as posture-tiles-test does): the wheel zooms through into first
// person, updateMe → updateFollowCamera marks the body (firstPersonView), and the body's ownPlateHidden — what
// avatar.js update() reads for the plate, its mark, the typing pill and the bubble — follows it back out again.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/firstperson-plate-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'fp-plate-stubs',
  setup(b) {
    // controller.js gets the posture-tiles world; avatar.js (and what it pulls in) the core stub the plate tests use
    b.onResolve({ filter: /^\.\/core\.js$/ }, (a) => ({ path: here(a.importer.endsWith('/controller.js') ? './posture-tiles-stub.mjs' : './core-stub.mjs') }));
    for (const m of ['base', 'terrain', 'colliders', 'chat', 'ui']) {
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, (a) => (a.importer.endsWith('/controller.js') ? { path: here('./posture-tiles-stub.mjs') } : undefined));
    }
    b.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    b.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
globalThis.fetch = (() => new Promise(() => {})) as any;   // avatar.js's emote defs ask the server; there is none here

const stub: any = await import('./posture-tiles-stub.mjs');
const ctl: any = await import('../client/lib/controller.js');
const { Avatar } = await import('../client/lib/avatar.js');
const { THREE, canvas } = stub;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// a body with the real Avatar's ownPlateHidden, and just enough of the rest for updateMe
const me: any = Object.assign(Object.create(Avatar.prototype), {
  root: new THREE.Object3D(), vrm: { scene: { visible: true } }, wingEffort: 0, pitch: 0,
  setClip() {}, update() {}, headWorldPosition: (v: any) => v.set(0, 1.5, 0),
});
const wheel = (deltaY: number) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY, cancelable: true }));
const tick = () => ctl.updateMe(1 / 60, me);

tick();
check('third person (the starting camera): your own plate shows', me.ownPlateHidden === false && ctl.firstPerson === false,
  `hidden ${me.ownPlateHidden} fp ${ctl.firstPerson}`);
wheel(-5000); tick();
check('wheel all the way in → first person: your own plate is hidden', ctl.firstPerson === true && me.ownPlateHidden === true,
  `hidden ${me.ownPlateHidden} fp ${ctl.firstPerson}`);
check('...and so is the body (the old rule, unchanged)', me.vrm.scene.visible === false);
wheel(5000); tick();
check('wheel back out → third person: it shows again', ctl.firstPerson === false && me.ownPlateHidden === false,
  `hidden ${me.ownPlateHidden} fp ${ctl.firstPerson}`);
me.hideLabel = true; tick();
check('presenting in VR (xr.js hideLabel) still hides it in third person', me.ownPlateHidden === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
