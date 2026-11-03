// posture tiles (client/lib/controller.js sitHere / standUp / setMountedHook / getPosture) — the emote bar's
// sit·stand·lie tiles share X's seat search, and a declared-seat MOUNT (sockets, localbody.js) is neither a
// posture nor myState.seat: on a mount the sit tile is a no-op and the stand tile is the dismount. Drives the
// REAL controller.js against tools/posture-tiles-stub.mjs (flat world, one optional chair pan) with the same
// hook pair localbody.js registers (mounted → dismount; seat in reach → mount; else fall through).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/posture-tiles-test.ts
//
// Each block names the product line that would silence it:
//   sitHere() without its mountedHook() guard        → "mounted: sit tile is a no-op" goes red
//   standUp() not calling seatHook() while mounted   → "mounted: stand tile dismounts through the seat hook" goes red
//   standUp() clearing posture without myState.seat  → "stand from a chair clears the seat" goes red
//   updateMe's seatedClip losing the chair branch    → "a chair sit renders the sitchair clip" goes red
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'posture-tiles-stubs',
  setup(b) {
    for (const m of ['core', 'base', 'terrain', 'colliders', 'chat', 'ui']) {
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./posture-tiles-stub.mjs') }));
    }
  },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const stub = await import('./posture-tiles-stub.mjs');
const ctl = await import('../client/lib/controller.js');
const { sitHere, standUp, setPosture, setMountedHook, setSeatHook, getPosture, myState, updateMe } = ctl;
const { THREE, world } = stub;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// the hook pair exactly as localbody.js registers them (initLocalBody): mounted → dismount and consume;
// a declared seat in reach → mount and consume; otherwise fall through to the controller's own layers
const socket = { mounted: false, inReach: false, dismounts: 0, mounts: 0 };
setMountedHook(() => socket.mounted);
setSeatHook(() => {
  if (socket.mounted) { socket.mounted = false; socket.dismounts++; setPosture('stand'); return true; }   // dismountMe
  if (socket.inReach) { socket.mounted = true; socket.mounts++; return true; }                            // trySitOn
  return false;
});
// a minimal body for updateMe: the clip is what the tiles' lit state reads (emotebar paint → myState.clip)
const me = { root: new THREE.Object3D(), clips: [] as string[], setClip(c: string) { this.clips.push(c); }, wingEffort: 0, pitch: 0,
  headWorldPosition: (v: any) => v.set(0, 1.5, 0), vrm: { scene: { visible: true } }, update() {} };
const tick = () => { updateMe(1 / 60, me); return myState.clip; };
const reset = () => { setPosture(null); myState.seat = null; myState.speed = 0; myState.pos.set(0, 0, 0); socket.mounted = false; socket.inReach = false; world.seat = null; };

console.log('\nno seat in reach (ground sit)');
reset();
check('starts standing: getPosture() null, clip idle', getPosture() === null && tick() === 'idle', `${getPosture()} ${myState.clip}`);
sitHere();
check('sit tile → posture sit, no seat', getPosture() === 'sit' && myState.seat === null);
check('...and the body renders the ground sit clip', tick() === 'sit', myState.clip);
sitHere();
check('sit again is a no-op (still sit, not toggled off)', getPosture() === 'sit');
standUp();
check('stand tile clears the posture', getPosture() === null && myState.seat === null);
check('...and the clip returns to idle', tick() === 'idle', myState.clip);
standUp();
check('stand while standing is a no-op', getPosture() === null);

console.log('\nlie');
reset();
setPosture('lie');
check('lie via setPosture → posture lie, clip lie', getPosture() === 'lie' && tick() === 'lie');
sitHere();
check('sit tile from lie runs the seat search → sit', getPosture() === 'sit');
setPosture('lie');
standUp();
check('stand from lie clears the posture', getPosture() === null && tick() === 'idle');

console.log('\na chair pan in reach (geometry seat, findSeat)');
reset();
world.seat = { id: 'stool-1', x: 2, y: 0.45, z: -1, yaw: 1.2 };
sitHere();
check('sit tile sits ON the chair: myState.seat {id, chair:true}', myState.seat?.id === 'stool-1' && myState.seat?.chair === true, JSON.stringify(myState.seat));
check('...moved to the pan and faced its yaw', myState.pos.x === 2 && myState.pos.z === -1 && myState.yaw === 1.2);
check('...posture sit', getPosture() === 'sit');
check('a chair sit renders the sitchair clip', tick() === 'sitchair', myState.clip);
check('...the hint says seated — X to stand', stub.hints.at(-1)?.startsWith('seated'), stub.hints.at(-1));
sitHere();
check('sit again on the chair is a no-op', getPosture() === 'sit' && myState.seat?.id === 'stool-1');
standUp();
check('stand from a chair clears the seat', getPosture() === null && myState.seat === null);
check('...and the clip is idle again', tick() === 'idle');

console.log('\na declared seat in reach (socket mount through the seat hook)');
reset();
socket.inReach = true;
sitHere();
check('sit tile: the socket gets first claim — mounted, not a posture', socket.mounted && socket.mounts === 1 && getPosture() === null, `mounted=${socket.mounted} posture=${getPosture()}`);
sitHere();
check('mounted: sit tile is a no-op (no second mount, no ground sit)', socket.mounts === 1 && getPosture() === null && socket.dismounts === 0);
world.seat = { id: 'stool-2', x: 5, y: 0.4, z: 5, yaw: 0 };
sitHere();
check('mounted: a chair pan in reach does not pull the body off the swing', socket.mounted && myState.seat === null && myState.pos.x === 0);
standUp();
check('mounted: stand tile dismounts through the seat hook', !socket.mounted && socket.dismounts === 1, `mounted=${socket.mounted} dismounts=${socket.dismounts}`);
check('...and does not re-mount the seat still in reach (the hook\'s mounted branch consumed it)', socket.mounts === 1);
check('...and does not sit on the chair pan either', myState.seat === null);
check('after the dismount getPosture() is what dismountMe set (stand), not sit/lie', getPosture() === 'stand');
standUp();
check('stand again after a dismount: no second dismount, posture untouched', socket.dismounts === 1 && getPosture() === 'stand');

console.log('\nthe hook is re-settable');
reset();
setMountedHook(() => true);
sitHere();
check('a hook answering mounted makes the sit tile a no-op even with nothing mounted', getPosture() === null);
setMountedHook(() => false);
sitHere();
check('...and answering not-mounted restores the ground sit', getPosture() === 'sit');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
