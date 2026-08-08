// handgrab unit matrix (2026-08-06) — the DESKTOP CLIENT half of #44, tested
// against stubs (tools/handgrab-stubs.mjs): a real THREE camera, a synthetic
// canvas, recorded verbs. The server half is grabtest.ts; this file proves
// the client speaks the room act correctly and reverts honestly.
//   bun run tools/handgrab-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'handgrab-stubs',
  setup(b) {
    for (const m of ['core', 'world', 'net', 'ui', 'controller', 'build'])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./handgrab-stubs.mjs') }));
  },
});

(globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 800;
const S = await import('./handgrab-stubs.mjs');
const { THREE, camera, entities, comps, sentVerbs, _canvasHandlers, _setEditing, bus } = S as any;
const grab = await import('../client/lib/handgrab.js');

let passed = 0; let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const scene = new THREE.Object3D();
scene.add(camera);
function spawn(id: string, x: number, y: number, z: number, grabbable = true, size = 0.2) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial());
  m.position.set(x, y, z);
  scene.add(m);
  entities.set(id, m);
  if (grabbable) comps.set(id, { grab: {} });
  m.updateWorldMatrix(true, false);
  return m;
}
const click = (x = 400, y = 400) => _canvasHandlers.get('click')({ clientX: x, clientY: y });

grab.initHandGrab();

// ---- the gate and the reach ----------------------------------------------
const die = spawn('die', 0, 1, -1.5);          // in reach, in view
camera.lookAt(die.position); camera.updateMatrixWorld();   // dead-centre under the crosshair
spawn('boulder', 0.35, 1, -1.5, false, 1.0);   // in view, NOT grabbable
spawn('fardie', 0, 1, -8);                     // grabbable but out of reach
click();
check("click takes the grabbable under the cursor", grab.heldId() === 'die', String(grab.heldId()));
check("the wire heard `use take`, not an edit verb",
  sentVerbs.length === 1 && sentVerbs[0].verb === 'use' && sentVerbs[0].args.action === 'take',
  JSON.stringify(sentVerbs));
check("held thing rides the camera", (() => { let p = die.parent; while (p) { if (p === camera) return true; p = p.parent; } return false; })());

// ---- put ------------------------------------------------------------------
click();
const put = sentVerbs[1];
check("second click speaks `use put` with a landing pos",
  put?.verb === 'use' && put.args.action === 'put' && Array.isArray(put.args.pos), JSON.stringify(put));
check("the thing is back in the world graph", die.parent !== null && (() => { let p = die.parent; while (p) { if (p === camera) return false; p = p.parent; } return true; })());
check("no longer holding", !grab.isHolding());

// ---- what can never be taken ---------------------------------------------
sentVerbs.length = 0;
entities.get('die').position.set(0, 1, -30); entities.get('die').updateWorldMatrix(true, false);
click();
check("an ungrabbable thing under the cursor is not taken", !grab.isHolding() && sentVerbs.length === 0, JSON.stringify(sentVerbs));
entities.get('die').position.set(0, 1, -1.5); entities.get('die').updateWorldMatrix(true, false);

// ---- editing owns the click ----------------------------------------------
_setEditing(true); click();
check("while editing, clicks never grab (interact/build split)", !grab.isHolding() && sentVerbs.length === 0);
_setEditing(false);

// ---- refusal reverts the optimism ----------------------------------------
click();
check("(setup) holding again", grab.heldId() === 'die');
const before = { x: 0, y: 1, z: -1.5 };
bus.emit('server-error', 'cannot take "die": someone else is holding it');
check("server refusal puts the thing back where it was",
  !grab.isHolding() && Math.abs(die.position.x - before.x) < 1e-6 && Math.abs(die.position.z - before.z) < 1e-6,
  `${die.position.toArray()}`);

// ---- vanished under you ---------------------------------------------------
sentVerbs.length = 0; click();
check("(setup) holding once more", grab.isHolding());
bus.emit('entity', { id: 'die', kind: 'remove' });
check("a removed entity releases the hold without a put", !grab.isHolding() && !sentVerbs.some((v: any) => v.args?.action === 'put'));

// ---- hints: instance-safe warmth ------------------------------------------
const a = spawn('twin-a', -0.5, 1, -1.6);
const b = spawn('twin-b', 0.5, 1, -1.6);
(b as any).material = (a as any).material;      // shared material — the trap
grab.updateGrabHints();
const warmA = (a as any).material.emissiveIntensity > 0;
check("in-reach grabbables warm up", warmA, `intensity=${(a as any).material.emissiveIntensity}`);
check("warming one twin does NOT light its material-sharing sibling the same way",
  (a as any).material !== (b as any).material);
_setEditing(true); grab.updateGrabHints(); _setEditing(false);
check("hints cool (and restore the shared material) when editing opens",
  (a as any).material === (b as any).material && (a as any).material.emissive.getHex() === 0x000000);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
