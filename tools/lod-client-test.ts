// lod-client-test — the product door of #170, headless and owned.
//
//   bun tools/lod-client-test.ts
//
// What the pure chooser (tools/lod-policy-test.ts) cannot say: that the
// resident's dial, the residency sweep, the loader's wire, the sequencer's
// answer, the in-place replacement and the collider all AGREE. Review of
// #170, point 4 — "the committed receipt stops at the pure chooser".
//
// Three parts. The REALIZER part runs the real client/lib/realize/models.js
// and the real governor.js (with the real policy, fold, scheduler and bus)
// over a stub of their dependency cone — tools/lod-client-stub.mjs: no
// renderer; a loader whose tier is the WIRE truth (askFor), whose
// "sequencer" answers a stamped variant for libs it baked and the original
// otherwise, and which the test can hold open and release by hand, so a
// tier swap is caught mid-flight; colliders recorded, never built; every
// governor lever below 'lod' answering "nothing to shed". The WIRE part
// spawns a sequencer child PROCESS-OWNED (WORLD_INSTANCE_NONCE, as
// object-lod-test does) over a fixture library and pushes the exact URLs the
// loader would send through it — capable, incapable, wrong generation, an
// authored `recipe` extra — reading the served tier with the same tierOf the
// loader uses. The PRODUCTION-LOADER part (round three of the review) then
// runs the real, unmodified client/lib/assets.js against that same child
// (tools/lod-loader-probe.ts: only a renderer that never draws and the frame
// conductors injected below it, its relative fetches resolved to the child),
// once per /version shape — the real one, one with no recipe, one with no
// key — and asserts the URL it fetched, the cache key it chose and the
// tierAsked / tierServed it stamped. A mutation at that seam (`tier =
// req.tier`, the url, the stamps) fails here; a stubbed loader could not
// say so, and the review caught exactly that.
//
// Negative controls, each named in its check: the churn of the first field
// run (an "already light" answer re-asked every cooldown), a held tier swap
// landing over a rider / cargo / a part motion / an edit hold, a lod ask a
// non-KTX2 browser reports without ever sending, an authored `recipe`
// extra read as a served lod, a governor lever overriding the resident's
// "full detail". Dies at import on main (no lod_policy.js).
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn as spawnProc, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STUB = fileURLToPath(new URL('./lod-client-stub.mjs', import.meta.url));
plugin({
  name: 'lod-client-stub',
  setup(b) {
    // the realizer's cone (imported from realize/ as ../x.js) and the
    // governor's cone (imported from lib/ as ./x.js) — state, scheduler,
    // policy, fold and the bus stay REAL, and so do models.js and governor.js
    for (const f of ['^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$',
      '^\\.\\./lightrig\\.js$', '^\\.\\./lights\\.js$', '^\\.\\./world\\.js$',
      '^\\./core\\.js$', '^\\./warmqueue\\.js$', '^\\./loadwork\\.js$', '^\\./lightrig\\.js$',
      '^\\./emitters\\.js$', '^\\./terrain\\.js$', '^\\./remotes\\.js$', '^\\./frame\\.js$', '^\\./ui\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
  },
});
// the dial persists through localStorage — a Map-backed one, inspectable
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const stub: any = await import('./lod-client-stub.mjs');
const M: any = await import('../client/lib/realize/models.js');
const S: any = await import('../client/lib/state.js');
const { emptyState } = await import('../shared/fold.js');
const { bus } = await import('../client/lib/base.js');
const { makeModelQuality, askFor, tierOf } = await import('../client/lib/lod_policy.js');
const { keyFromVersion, lodFromVersion, negotiate, withLod } = await import('../shared/ktx2.js');
const { LOD_RECIPE } = await import('../server/store-variants.ts');
const rig: any = await import('./rig-load.mjs');

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let the scheduler's microtask pump and the stub loader run out. */
const settle = async () => { for (let i = 0; i < 6; i++) await sleep(15); };
const until = async (pred: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(250); }
  return pred();
};

// ============================================================================
console.log('\nlod-client — the realizer half (real models.js over a held loader)\n');

const REC = stub.server.recipe as string;
const enc = encodeURIComponent(REC);
const lib = (id: string) => `eidoverse/assets/models/${id}.glb`;
const GEOM = { bbox: { size: [1, 1, 1], center: [0, 0.5, 0] } };   // diag 1.73 → R ≈ 86.9m, auto edge ≈ 39m, halved ≈ 19.5m
let seq = 1;
const fold = (verb: string, args: any) => S.foldLive({ seq: seq++, ts: 1_000_000 + seq, actor: 't', verb, args });
/** Place an entity on the z axis, `z` metres from the camera at the origin.
 *  Each id has its own lib, so loads and variants attribute per placement. */
const spawnAt = (id: string, z: number, variant = true) => {
  if (variant) stub.server.variants.add(lib(id));
  bus.emit('lib-geom', { [lib(id)]: GEOM });   // the geom side-channel, landed
  fold('spawn', { id, lib: lib(id), pos: [0, 0, z] });
};
const obj = (id: string) => stub.entities.get(id);
const loadsOf = (id: string) => stub.loads.filter((l: any) => l.lib === lib(id));
const drain = () => { for (let i = 0; i < 50 && M.promoteTailPending() > 0; i++) M.drainPromoteTail(); };
const res = () => M.residencyDebug();

M.initModelsRealizer();          // geom side-channel + fold wiring (+ a 2Hz beat we ignore: we beat by hand)
S.hydrate(emptyState(), [], 0);
stub.camera.position.set(0, 0, 0);

// ---- 1. the join: tiers chosen before the fetch, from distance against the entity's own radius
{
  spawnAt('near', 5);
  spawnAt('far', 70);
  spawnAt('light', 70, false);   // far, but the sequencer has no variant — its "already light" refusal answers the original
  await settle();
  check('three placements realized', res().real === 3, JSON.stringify(res()));
  check('near (5m) asked FULL — a plain ktx2 fetch', loadsOf('near')[0]?.tier === 'full' && loadsOf('near')[0]?.url === `${lib('near')}?ktx2=3`, loadsOf('near')[0]?.url);
  check('far (70m) asked LOD — the recipe rides the ktx2 negotiation on the wire', loadsOf('far')[0]?.tier === 'lod' && loadsOf('far')[0]?.url === `${lib('far')}?ktx2=3&lod=${enc}`, loadsOf('far')[0]?.url);
  check('far wears the served lod: asked lod, served lod', obj('far')?.userData.tierAsked === 'lod' && obj('far')?.userData.tier === 'lod');
  check('light asked lod, was answered the original, wears FULL honestly', obj('light')?.userData.tierAsked === 'lod' && obj('light')?.userData.tier === 'full');
  check('EW.residency(): lod 1 (served) / lodAsked 2 (asked) — the gap is the sequencer\'s honest fall-through', res().lod === 1 && res().lodAsked === 2, JSON.stringify(res()));
  drain();
  check('the promote tail fits colliders for the full tiers only — the reduced mesh owns NO collider',
    stub.colliders.has('near') && stub.colliders.has('light') && !stub.colliders.has('far'), JSON.stringify(stub.colliderLog));
  // the churn control (the first field run: 21 re-tiers in 100s)
  const nLoads = stub.loads.length;
  for (let i = 0; i < 4; i++) { M.residencySweep(); await settle(); }
  check('four beats later nothing re-asked: an "already light" answer is NOT re-fetched every cooldown (hysteresis keys on the ASK)',
    stub.loads.length === nLoads && res().retiers === 0, `loads ${nLoads}→${stub.loads.length}, retiers ${res().retiers}`);
}

// ---- 2. the dial: persisted locally, never a verb; a flip re-tiers in place
{
  const worldBefore = JSON.stringify(S.state.st);
  const farBefore = obj('far');
  M.modelQuality.setQuality('full');
  check('the dial persists in THIS browser (localStorage) and reads back on the next boot',
    store.get('ew-model-quality') === 'full' && makeModelQuality(globalThis.localStorage).quality === 'full');
  M.residencySweep(); await settle();
  const last = loadsOf('far').at(-1);
  check('"full detail" re-tiers far in place: a FULL load, the old lod proto released, the new object worn',
    last?.tier === 'full' && obj('far') !== farBefore && obj('far')?.userData.tierAsked === 'full'
    && stub.released.includes(`${lib('far')}#lod`), JSON.stringify({ last, retiers: res().retiers }));
  // light wore the original already, but its ASK was lod — under "full detail" the ask must be full,
  // so it re-asks once (a plain ktx2 fetch), and that is also how a provisional answer picks up a
  // later bake: the ask flips, the wire asks again. Two re-tiers: far and light.
  check('light (asked lod, wearing the original) re-asks FULL once — the ask is what the dial commands, and that is the path a later bake rides',
    res().retiers === 2 && loadsOf('light').at(-1)?.tier === 'full' && obj('light')?.userData.tierAsked === 'full', JSON.stringify(res()));
  drain();
  check('…and the full tier earns its collider on landing', stub.colliders.has('far'), JSON.stringify(stub.colliderLog.slice(-3)));
  check('the world fold is byte-identical: the dial and the swap wrote NOTHING shared', JSON.stringify(S.state.st) === worldBefore);

  spawnAt('mid', 25);   // under "full": a full load, 25m inside the auto edge anyway
  await settle();
  check('mid (25m) joined full', obj('mid')?.userData.tierAsked === 'full');
  M.modelQuality.setQuality('eco');
  M.residencySweep(); await settle();
  check('"eco" halves the edge: mid (25m > 19.5m) re-tiers to LOD; near (5m) stays full — no dial reduces what you stand beside',
    obj('mid')?.userData.tierAsked === 'lod' && obj('mid')?.userData.tier === 'lod' && loadsOf('near').length === 1,
    JSON.stringify({ mid: obj('mid')?.userData.tierAsked, nearLoads: loadsOf('near').length }));
  M.modelQuality.setQuality('auto');
}

// ---- 3. a browser that cannot ask: the wire decides, and reports honestly (review point 2)
{
  const askedBefore = res().lodAsked;
  stub.server.capable = false;             // no KTX2 transcoder in this browser
  spawnAt('nolod', 70);
  await settle();
  const l = loadsOf('nolod')[0];
  check('no transcoder: far placement loads FULL with NO lod= (and no ktx2=) on the wire', l?.tier === 'full' && l?.url === lib('nolod'), l?.url);
  check('…and is reported as never asked: tierAsked full, lodAsked unchanged', obj('nolod')?.userData.tierAsked === 'full' && res().lodAsked === askedBefore);
  M.modelQuality.setQuality('eco');
  for (let i = 0; i < 2; i++) { M.residencySweep(); await settle(); }
  check('even on "eco" it never re-asks: the policy sees no recipe where none can cross the wire', loadsOf('nolod').length === 1);
  M.modelQuality.setQuality('auto');
  stub.server.capable = true;
  stub.server.recipe = null;               // a sequencer that published no recipe
  spawnAt('norecipe', 70);
  await settle();
  const n = loadsOf('norecipe')[0];
  check('no recipe published: ktx2 negotiates, lod does not — a plain ktx2 fetch, asked full', n?.tier === 'full' && n?.url === `${lib('norecipe')}?ktx2=3`, n?.url);
  stub.server.recipe = REC;
}

// ---- 4. a tier swap is re-authorized at APPLICATION, not only when scheduled (review point 3)
console.log('\n  held swaps — a dependency arrives while the bytes fly\n');
/** Join reduced at 70m, walk it to 10m (a `place`), catch the FULL load in
 *  flight, let `dep` land, then release the load. Returns what stood before. */
async function heldSwap(id: string, dep: null | ((id: string) => void)) {
  spawnAt(id, 70); await settle();
  const before = obj(id);
  check(`${id}: joined reduced (asked lod, served lod)`, before?.userData.tierAsked === 'lod' && before?.userData.tier === 'lod');
  const mark = stub.colliderLog.length;
  const refusedBefore = res().retiersRefused, retiersBefore = res().retiers;
  stub.setHold(true);
  fold('place', { id, pos: [0, 0, 10] });   // walked toward: 10m < the inner edge (29m) → the sweep wants full
  M.residencySweep(); await settle();
  const h = stub.held.find((x: any) => x.lib === lib(id));
  // per-placement: other placements may legitimately re-tier in the same beat (a browser that
  // regained KTX2 re-asks its far ones), so count THIS lib's loads, not the global counter
  check(`${id}: the FULL load is in flight, held`, !!h && h.tier === 'full' && loadsOf(id).length === 2 && res().retiers > retiersBefore,
    JSON.stringify({ held: !!h, loads: loadsOf(id).length }));
  dep?.(id);                                 // …and now the world moves
  await settle();
  for (const x of stub.held.splice(0)) x.release();
  stub.setHold(false);
  await settle();
  drain();
  return { before, mark, refusedBefore };
}
const sinceMark = (mark: number, id: string) => stub.colliderLog.slice(mark).filter((e: any) => e[1] === id).map((e: any) => e[0]);

{ // the control: nothing intervenes → the swap lands
  const { before, mark } = await heldSwap('ctl', null);
  check('control: with nothing riding, the held swap LANDS — new object, asked full, old lod proto released, collider fitted',
    obj('ctl') !== before && obj('ctl')?.userData.tierAsked === 'full' && stub.released.includes(`${lib('ctl')}#lod`)
    && sinceMark(mark, 'ctl').includes('fit'), JSON.stringify(sinceMark(mark, 'ctl')));
}
const deps: [string, (id: string) => void][] = [
  ['a body sits on it (avatarMounts)', (id) => stub.avatarMounts.set(`rider-of-${id}`, { to: id })],
  ['cargo mounts on it (a `mount` verb folds parent.to)', (id) => { spawnAt(`cargo-${id}`, 10); fold('mount', { id: `cargo-${id}`, to: id }); }],
  ['a part motion arrives (comp.motion.part)', (id) => fold('motion', { id, type: 'swing', part: 'Door', axis: [0, 1, 0], amp: 0.3, period: 2 })],
  ['an edit hold begins (editHolds)', (id) => stub.editHolds.add(id)],
];
let k = 0;
for (const [what, dep] of deps) {
  const id = `held${k++}`;
  const { before, mark, refusedBefore } = await heldSwap(id, dep);
  const same = obj(id) === before;
  check(`${what}: the loaded clone is NOT worn — the standing object stays, asked lod, collider untouched, refusal counted`,
    same && obj(id)?.userData.tierAsked === 'lod' && sinceMark(mark, id).length === 0 && res().retiersRefused === refusedBefore + 1,
    JSON.stringify({ same, asked: obj(id)?.userData.tierAsked, colliderOps: sinceMark(mark, id), refused: res().retiersRefused - refusedBefore }));
}
check('no realizer error was reported through the whole realizer half', stub.reports.length === 0,
  stub.reports.map((r: any) => `${r.where}: ${r.e?.message ?? r.e}`).join(' | '));

// ---- 5. the other entry points (round three): the REAL governor's lever crosses into the sweep; the dial's callback is gated
console.log('\n  entry points — the governor lever and the dial callback\n');
{
  const G: any = await import('../client/lib/governor.js');   // real, over the same stub cone: every lever below "lod" answers "nothing to shed"
  M.modelQuality.setQuality('auto');
  spawnAt('gov', 25); await settle();                          // inside the auto edge (39m) — full
  drain();
  check('gov (25m) joined full under "auto"', obj('gov')?.userData.tierAsked === 'full');
  const toastsBefore = stub.toasts.length;
  const hist = () => G.governorDebug().history as string[];
  let windows = 0;
  while (!hist().some((h) => h.startsWith('− lod')) && windows++ < 4) for (let i = 0; i < 4; i++) G.governPerformance(12);
  check('slow seconds with nothing else to shed: the ladder reaches "lod" — the session dial sheds, the resident is told once',
    M.modelQuality.shed === true && hist().some((h) => h.startsWith('− lod')) && stub.toasts.length === toastsBefore + 1,
    JSON.stringify({ shed: M.modelQuality.shed, hist: hist().slice(-3), toasts: stub.toasts.slice(-1) }));
  M.residencySweep(); await settle(); drain();   // drained: the governor's grace holds while a promote tail is pending
  check('…and it CROSSES into the realizer: gov (25m > the halved 19.5m edge) re-tiers to lod on the next beat',
    obj('gov')?.userData.tierAsked === 'lod' && obj('gov')?.userData.tier === 'lod', JSON.stringify(obj('gov')?.userData));
  windows = 0;
  while (M.modelQuality.shed && windows++ < 4) for (let i = 0; i < 6; i++) G.governPerformance(60);
  check('smooth seconds: "lod" restores SILENTLY — the dial is off, no toast',
    !M.modelQuality.shed && hist().some((h) => h.startsWith('+ lod')) && stub.toasts.length === toastsBefore + 1,
    JSON.stringify({ shed: M.modelQuality.shed, hist: hist().slice(-3) }));
  M.modelQuality.setQuality('full');
  drain();
  const histLen = hist().length;
  for (let i = 0; i < 4; i++) G.governPerformance(12);
  check('the resident\'s "full detail" is never overridden: under load the lever declines and the ladder passes it by',
    M.modelQuality.shed === false && !hist().slice(histLen).some((h) => h.startsWith('− lod')), JSON.stringify(hist().slice(histLen)));
  M.modelQuality.setQuality('auto');

  // the dial's callback — skypanel.js binds it to the models⚙ row and shows what it returns
  const hintEco = M.dialModelQuality('eco');
  check('the row\'s callback sets and persists the dial and says it is yours only',
    M.modelQuality.quality === 'eco' && store.get('ew-model-quality') === 'eco' && hintEco === 'models: eco (yours only)', hintEco);
  stub.server.recipe = null;
  const hintNone = M.dialModelQuality('auto');
  check('…and where no reduced tier can be asked from this browser, the hint says so', /cannot be asked/.test(hintNone) && M.modelQuality.quality === 'auto', hintNone);
  stub.server.recipe = REC;
  const hintUnknown = M.dialModelQuality('ultra');
  check('an unknown level is refused; the dial stands', M.modelQuality.quality === 'auto' && hintUnknown.startsWith('models: auto'), hintUnknown);
}

// ============================================================================
console.log('\nlod-client — the wire half (an OWNED sequencer answers the loader\'s exact URLs)\n');

const ROOT = resolve(import.meta.dir, '..');
const OPT = join(ROOT, 'assets', 'opt');
const NOWHERE = mkdtempSync(join(tmpdir(), 'ew-lodc-nowhere-'));   // no encoder anywhere: an untextured fixture reduces without one
const LIB = mkdtempSync(join(tmpdir(), 'ew-lodc-lib-'));
mkdirSync(join(LIB, 'eidoverse', 'assets', 'models'), { recursive: true });
const HEAVY = 'eidoverse/assets/models/lod_client_heavy.glb';        // 161² verts → reduced
const AUTHORED = 'eidoverse/assets/models/lod_client_authored.glb';  // 81 verts, with an AUTHORED `recipe` extra equal to the running one
const mine = [HEAVY, AUTHORED].flatMap((r) => [`${r}.lod.${LOD_RECIPE}.glb`, `${r}.lod.${LOD_RECIPE}.glb.failed`, `${r}.ktx2.glb`, `${r}.ktx2.glb.failed`]);
let child: ChildProcess | null = null;
const cleanup = () => {
  try { child?.kill(); } catch { /* gone */ }
  for (const rel of mine) try { rmSync(join(OPT, rel), { force: true }); } catch { /* best effort */ }
  for (const d of [LIB, NOWHERE]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { cleanup(); process.exit(1); });
// a run killed mid-way may have left last time's variants in OPT_DIR: a STALE
// variant (older than the fixture written below) is exactly what the server
// refuses to serve (#156 freshness), so clear before writing, and wait for a
// variant NEWER than its source, never for a file that merely exists
for (const rel of mine) try { rmSync(join(OPT, rel), { force: true }); } catch { /* best effort */ }

async function gridGlb(tag: string, cells: number, extras: object | null): Promise<Uint8Array> {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const doc = new Document();
  if (extras) doc.getRoot().getAsset().extras = extras;
  const buf = doc.createBuffer();
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    pos[i * 3] = x / cells; pos[i * 3 + 1] = Math.sin(x * 0.37) * Math.cos(y * 0.29) * 0.02; pos[i * 3 + 2] = y / cells;
  }
  const idx = new Uint32Array(cells * cells * 6);
  let q = 0;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial('m'))
    .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buf).setArray(idx))
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(pos));
  doc.createScene('s').addChild(doc.createNode(`hero-${tag}`).setMesh(doc.createMesh('gridMesh').addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); } catch { return cand; }
  }
  throw new Error('no free port in 20 tries');
}
/** Process-owned, as object-lod-test spawns it: the per-run nonce goes INTO
 *  the child and must come back on /version before anything counts as up. */
async function startServer() {
  const PORT = await freePort();
  const nonce = crypto.randomUUID();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT), JOIN_TOKEN: 'test-door',
    WORLD_INSTANCE_NONCE: nonce, WORLDS_DIR: mkdtempSync(join(tmpdir(), 'ew-lodc-w-')), EIDOVERSE_DIR: LIB,
    KTX2_TOKTX: join(NOWHERE, 'no-such'), PATH: NOWHERE, HOME: NOWHERE, USERPROFILE: NOWHERE };
  const proc = spawnProc(process.execPath, [join(ROOT, 'server', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  let log = '';
  proc.stdout!.on('data', (d) => { log += d; });
  proc.stderr!.on('data', (d) => { log += d; });
  let up = false, version: any = null;
  for (let i = 0; i < 120 && !up; i++) {
    if (proc.exitCode != null) break;
    try {
      version = await fetch(`http://127.0.0.1:${PORT}/version`).then((r) => r.json());
      if (version && typeof version === 'object' && version.instance === nonce) up = true;
      else break;   // someone else answers here — refuse, never test into their world
    } catch { await sleep(250); }
  }
  if (!up) console.log(`      child did not come up OWNED — log tail:\n      ${log.split('\n').slice(-6).join('\n      ')}`);
  const base = `http://127.0.0.1:${PORT}`;
  return { up, base, key: keyFromVersion(version), lod: lodFromVersion(version), log: () => log,
    stop: async () => { try { proc.kill(); } catch { /* gone */ } child = null; await sleep(300); } };
}

writeFileSync(join(LIB, HEAVY), await gridGlb('heavy', 160, null));
writeFileSync(join(LIB, AUTHORED), await gridGlb('authored', 8, { recipe: LOD_RECIPE, note: 'an author wrote this' }));
const C = await startServer();
try {
  check('child sequencer came up OWNED over the fixture library', C.up);
  if (C.up) {
    const key = C.key as string, recipe = C.lod as string;
    check('it published a key and the recipe this client was built against', !!key && recipe === LOD_RECIPE, `${key} / ${recipe}`);
    const variant = join(OPT, `${HEAVY}.lod.${recipe}.glb`);
    const fresh = () => existsSync(variant) && statSync(variant).mtimeMs > statSync(join(LIB, HEAVY)).mtimeMs;
    const landed = await until(fresh, 60_000);
    check('the boot sweep baked the heavy fixture\'s LOD (untextured: no encoder needed)', landed,
      C.log().split('\n').filter((l) => l.includes('lod')).slice(-3).join(' | '));
    const served = async (url: string) => {
      const r = await fetch(`${C.base}/library/${url}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const json = rig.glbJson(bytes);
      return { status: r.status, cc: r.headers.get('cache-control'), json, tier: tierOf(json, recipe), url };
    };
    const capable = askFor({ libPath: HEAVY, key, capable: true, recipe, tier: 'lod' });
    const a = await served(capable.url);
    check('a CAPABLE browser\'s lod ask → the stamped variant; the loader\'s tierOf reads it as lod',
      capable.tier === 'lod' && a.status === 200 && a.tier === 'lod' && typeof a.json.asset?.extras?.lodOf === 'string',
      JSON.stringify({ url: a.url, extras: a.json.asset?.extras }));
    const incapable = askFor({ libPath: HEAVY, key, capable: false, recipe, tier: 'lod' });
    const b = await served(incapable.url);
    check('an INCAPABLE browser sends neither lod= nor ktx2=: the original comes back, read as full',
      incapable.tier === 'full' && !incapable.url.includes('=') && b.status === 200 && b.tier === 'full' && !b.json.asset?.extras?.lodOf, incapable.url);
    const c = await served(withLod(negotiate(HEAVY, key), 'some-future-recipe'));
    check('a WRONG-GENERATION ask answers provisionally (no-cache) and the loader reads it as full',
      c.status === 200 && c.cc === 'no-cache' && c.tier === 'full', `cc=${c.cc}`);
    const authored = askFor({ libPath: AUTHORED, key, capable: true, recipe, tier: 'lod' });
    const refused = await until(() => existsSync(join(OPT, `${AUTHORED}.lod.${recipe}.glb.failed`)), 30_000);
    const d = await served(authored.url);
    check('an authored `recipe` extra EQUAL to the running recipe, through the lod door: the sweep refused it typed (already light), the original answers, the loader reads FULL',
      refused && d.status === 200 && d.json.asset?.extras?.recipe === recipe && !d.json.asset?.extras?.lodOf && d.tier === 'full',
      JSON.stringify({ refused, extras: d.json.asset?.extras, cc: d.cc }));

    // ---- the PRODUCTION loader (round three): real client/lib/assets.js, only a renderer and
    // the frame conductors injected below it, its /version and /library fetches going to the
    // owned child. A mutation at the decision seam (tier / url / glbKey / the stamps) fails here.
    console.log('\n  the production loader — real assets.js against the owned child\n');
    const probe = async (strip: string) => {
      const p = Bun.spawn([process.execPath, join(ROOT, 'tools', 'lod-loader-probe.ts')], {
        env: { ...process.env, LODC_BASE: C.base, LODC_STRIP: strip, LODC_HEAVY: HEAVY, LODC_AUTHORED: AUTHORED },
        stdout: 'pipe', stderr: 'pipe',
      });
      const killer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 90_000);   // a wedged probe is a failure, not a hang
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      clearTimeout(killer);
      const line = out.split('\n').find((l) => l.startsWith('PROBE '));
      const r = line ? JSON.parse(line.slice(6)) : {};
      if (!line || r.error) r.error = (r.error ?? '') + (err + out).split('\n').filter(Boolean).slice(-8).join(' | ');
      return r;
    };
    const P = await probe('');
    check('the real loader came up against the child: its /version handshake read the real key and recipe, the transcoder is detected',
      !P.error && P.negotiable === true && P.capable === true, P.error ?? JSON.stringify(P));
    if (!P.error) {
      check('resolveLoadRequest(HEAVY, lod): the URL carries the child\'s key and recipe, the tier is lod, the cache key is <lib>#lod',
        P.resolve.url === `${HEAVY}?ktx2=${key}&lod=${encodeURIComponent(recipe)}` && P.resolve.tier === 'lod' && P.resolve.glbKey === `${HEAVY}#lod`,
        JSON.stringify(P.resolve));
      check('loadGLB(HEAVY, {tier: lod}) FETCHED that URL, keyed #lod, stamped asked lod, and read the REAL variant\'s stamp as served lod',
        P.fetched.includes(`/library/${P.resolve.url}`) && P.lod.glbKey === `${HEAVY}#lod` && P.lod.asked === 'lod' && P.lod.served === 'lod',
        JSON.stringify({ lod: P.lod, fetched: P.fetched }));
      check('loadGLB(HEAVY, {tier: full}) fetched the plain ktx2 URL, keyed on the lib, asked and served full',
        P.fetched.includes(`/library/${HEAVY}?ktx2=${key}`) && P.full.glbKey === HEAVY && P.full.asked === 'full' && P.full.served === 'full',
        JSON.stringify(P.full));
      check('loadGLB(AUTHORED, {tier: lod}) asked lod and, parsing the ORIGINAL the child fell through to, served full — the authored extra fooled the real loader no more than the pure one',
        P.authored.asked === 'lod' && P.authored.served === 'full' && P.authored.glbKey === `${AUTHORED}#lod`, JSON.stringify(P.authored));
    }
    const older = await probe('lodRecipe');
    check('an OLDER sequencer (no lodRecipe on /version): the real loader never asks — plain ktx2 URL, keyed on the lib, asked full, no lod= anywhere',
      !older.error && older.negotiable === false && older.lod?.asked === 'full' && older.lod?.glbKey === HEAVY
      && older.fetched?.includes(`/library/${HEAVY}?ktx2=${key}`) && !older.fetched?.some((u: string) => u.includes('lod=')),
      older.error ?? JSON.stringify(older));
    const keyless = await probe('ktx2Key');
    check('no key on /version: nothing negotiates — the bare path, asked full',
      !keyless.error && keyless.negotiable === false && keyless.lod?.asked === 'full' && keyless.fetched?.includes(`/library/${HEAVY}`)
      && !keyless.fetched?.some((u: string) => u.includes('=')), keyless.error ?? JSON.stringify(keyless));
  }
} finally { await C.stop(); }

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32m0 failed\x1b[0m');
process.exit(failures ? 1 : 0);
