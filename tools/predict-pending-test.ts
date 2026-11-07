// predict-pending-test.ts — a predicted release (thingphysics.js planRelease/predict) is PRESENTATION only: whereIs never
// answers from the provisional body (bot #574), and a guess no entry confirms within PENDING_MS is dropped even when no
// sim update arrives (bot #575). Headless, through the real client/lib/thingphysics.js over put-settle-test's stubs, with a
// REAL eidosim epoch (shared/sim.js) for the replica's sim so the launch folds into the copy.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/predict-pending-test.ts
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const STUB = here('./put-settle-stub.mjs');
plugin({
  name: 'predict-pending-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    for (const m of ['world', 'remotes', 'colliders', 'autohooks', 'bodyscale', 'net', 'ui', 'chat', 'actions', 'emitters', 'plainwords', 'markup', 'xrask'])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: STUB }));
    // a measured round trip: the stub's null would refuse every guess (planRelease)
    b.onResolve({ filter: /^\.\/serverclock\.js$/ }, () => ({ path: 'rtt', namespace: 'rtt' }));
    b.onLoad({ filter: /.*/, namespace: 'rtt' }, () => ({ contents: 'export const clockRtt = () => 100;', loader: 'js' }));
  },
});
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); } };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const J = (x: any) => JSON.stringify(x, (_k, v) => typeof v === 'number' ? +v.toFixed(3) : v);

const S: any = await import('./put-settle-stub.mjs');
const { THREE } = await import('./core-stub.mjs');
const { bus }: any = await import('../client/lib/base.js');
const sim: any = await import('../shared/sim.js');
const { engineViewM }: any = await import('../shared/protocol/simlayer.js');
let T = 0;
const tick = (t: number) => { T = t; S.setClock(t); };
(globalThis.performance as any).now = () => T;
const tp: any = await import('../client/lib/thingphysics.js');
const me = { root: new THREE.Object3D(), vrm: null };
tp.initThingPhysics({ myPos: () => me.root.position, me: () => me, camera: null, editing: () => false, myState: () => ({ yaw: 0 }) });
const frame = (wall: number) => { tick(wall); for (const fn of S.hostHooks) fn(wall); };
const scene = new THREE.Scene();
const ball = new THREE.Group(); scene.add(ball); ball.position.set(0, 1.2, 0.4); S.entities.set('ball', ball);
S.replica.st.entities.ball = { c: { transform: { pos: [0, 1.2, 0.4] }, physics: { kind: 'dynamic', shape: { type: 'sphere', radius: 0.1 } } } };
// the canonical sim: a real epoch with the ball seated; its copy is what the guess folds into
const canon = sim.emptySim();
sim.simEntry(canon, { seq: 0, ts: 0, actor: 'srv', verb: 'epoch', args: { sim: sim.SIM_ID, tickMs: 50 } }, engineViewM(S.replica.st, {}));
check('setup: the epoch took (a live engine, the ball a static)', !!canon.e2 && !!canon.statics.ball, J({ e2: !!canon.e2, statics: Object.keys(canon.statics) }));
S.replica.sim = { sim: canon, launched: {}, foreign: false, spec: { engine: sim.SIM_ID } };
S.replica.simVersion = 1;
S.replica.simClone = () => JSON.parse(JSON.stringify(canon));
const { PENDING_MS } = tp;

// ---- hold it, then let it go upward: the guess goes into the presentation copy before the reply
tick(0); bus.emit('holds', { ball: { by: 'me' } });
await tp.release([0, 3, 0]);
const pend0 = tp.physicsApi.pending();
check('setup: the throw was sent and is a pending guess', S.sent.some(([v]: any) => v === 'throw') && !!pend0.ball && pend0.ball.sentAt === 0, J({ sent: S.sent.map(([v]: any) => v), pend0 }));
const pres0 = tp.physicsApi.shown();
const b0 = pres0?.bodies?.ball;
check('setup: the copy holds the ball as a PROVISIONAL flying body', !!b0 && b0.provisional === true && b0.resting === false, J({ b0 }));

// ---- #574: whereIs (reach, grab, punt) never answers from the provisional body
// a display time half a tick past the launch's tick + 1: the drawing lerps between two ticks, so the drawn place and the body's p differ
const wall1 = pres0.epoch.ts + (pres0.tick + 1.5) * pres0.epoch.tickMs;
frame(wall1);
const b1 = tp.physicsApi.shown().bodies.ball;
ball.updateWorldMatrix(true, false); const drawn = ball.getWorldPosition(new THREE.Vector3()).toArray();
const apart = Math.hypot(drawn[0] - b1.p[0], drawn[1] - b1.p[1], drawn[2] - b1.p[2]);
check('setup: still provisional and flying, drawn between ticks (its p is elsewhere)', b1.provisional === true && b1.resting === false && apart > 1e-3, J({ b1: { p: b1.p, prov: b1.provisional, resting: b1.resting }, drawn, apart }));
const w = tp.physicsApi.whereIs('ball');
const dp = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// the drawing moved the thing along the guess too, so "the thing" is no answer either: the release point the authority still has it at is
const release = S.sent.find(([v]: any) => v === 'throw')?.[1]?.pos;
check('#574 whereIs ignores the provisional body AND the place the guess drew it (answers the release point)', !!w && !!release && dp(w, b1.p) > 1e-3 && dp(w, drawn) > 1e-3 && dp(w, release) < 1e-9, J({ whereIs: w, bodyP: b1.p, drawn, release }));

// ---- #575: no entry within PENDING_MS, and no sim update either: the guess is still dropped
const c0 = S.replica.simVersion;
frame(PENDING_MS - 1);
check('setup: inside PENDING_MS, no sim update: the guess stays', S.replica.simVersion === c0 && !!tp.physicsApi.pending().ball && !!tp.physicsApi.shown().bodies.ball, J({ pending: tp.physicsApi.pending(), simVersion: S.replica.simVersion }));
frame(PENDING_MS + 1);
check('#575 past PENDING_MS with no sim update: the guess is removed and the copy is the truth again (back in the hand)', S.replica.simVersion === c0 && !tp.physicsApi.pending().ball && !tp.physicsApi.shown().bodies.ball, J({ pending: tp.physicsApi.pending(), bodies: Object.keys(tp.physicsApi.shown()?.bodies ?? {}) }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
