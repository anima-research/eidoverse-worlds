// bun tools/full-detail-test.ts — the resident's "keep full detail" switch (governor.js setFullDetail). While it is on
// the governor never sheds a lever and the dead-band cruise never steps pixels; turning it on hands back whatever was
// already shed, at once — including a pixel ratio shed before VR entry and a grass budget shed before the meadow was
// cleared — and the choice persists. The REAL governor.js runs over tools/full-detail-stub.mjs (lod-client-stub with
// stateful levers), so each restore is asserted on the value it sets, not on the governor's own flags. Controls: the
// same drives with the switch off DO shed, so every "nothing moved" has a subject.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./full-detail-stub.mjs', import.meta.url));
plugin({ name: 'full-detail-stub', setup(b) {
  for (const f of ['^\\./core\\.js$', '^\\./warmqueue\\.js$', '^\\./loadwork\\.js$', '^\\./lightrig\\.js$', '^\\./emitters\\.js$',
    '^\\./terrain\\.js$', '^\\./remotes\\.js$', '^\\./frame\\.js$', '^\\./ui\\.js$', '^\\./statuschips\\.js$',
    '^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$', '^\\.\\./lightrig\\.js$', '^\\.\\./lights\\.js$', '^\\.\\./world\\.js$'])
    b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
} });
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, String(v)), removeItem: (k: string) => mem.delete(k) };
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : `  ${JSON.stringify(d)}`}`); };

const stub: any = await import(STUB);
const S = stub.state;
const ratios: number[] = [];
stub.renderer.setPixelRatio = (r: number) => { ratios.push(r); };
stub.renderer.xr = { isPresenting: false };
const G: any = await import('../client/lib/governor.js');
const { modelQuality } = await import('../client/lib/realize/models.js');
const { bus } = await import('../client/lib/base.js');
const dbg = () => G.governorDebug();
const sheds = () => (dbg().history as string[]).filter((h) => h.startsWith('−')).length;
const tick = (fps: number) => { G.governPerformance(fps); G.applyPendingPixelRatio(); };
stub.setSystemEvery('autos', 1);   // the shared stub starts cosmetics pre-shed; begin from full rate
// every visible value the ladder moves, as the renderer would see it
const visible = () => ({ slotCap: S.slotCap, casterBudget: S.casterBudget, emitters: S.emitterQuality,
  autos: stub.getSystemEvery('autos'), grass: S.grass, lodShed: modelQuality.shed, pixelRatio: dbg().pixelRatio,
  lodBias: S.lodBias, shadowMap: S.shadowMap });
const FULL = { slotCap: 4, casterBudget: 12, emitters: 'auto', autos: 1, grass: 1, lodShed: false, pixelRatio: 1, lodBias: 1, shadowMap: 2048 };
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

check('default is off (the governor drives, as upstream)', G.getFullDetail() === false && dbg().fullDetail === false);
check('(setup) the scene starts at full detail', same(visible(), FULL), visible());

// CONTROL: switch off, a long slow stretch walks the whole ladder down
for (let i = 0; i < 150; i++) tick(12);
const down = visible();
const moved = Object.keys(FULL).filter((k) => (down as any)[k] !== (FULL as any)[k]);
check('control — off, slow: every lever shed', moved.length === Object.keys(FULL).length, { down, unmoved: Object.keys(FULL).filter((k) => !moved.includes(k)) });

// switching on hands everything back at once — no 5s-smooth streak per notch
G.setFullDetail(true);
G.applyPendingPixelRatio();
check('on: every visible value restored immediately', same(visible(), FULL), visible());
check('on: the renderer got the base pixel ratio', ratios.at(-1) === 1, ratios.slice(-3));
check('on: persisted', mem.get('ew-full-detail') === '1', [...mem]);

// on, slow + dead band: nothing moves
const s0 = sheds();
for (let i = 0; i < 60; i++) tick(12);
check('on, slow for 60s: nothing sheds', sheds() === s0 && same(visible(), FULL), visible());
for (let i = 0; i < 60; i++) tick(40);
check('on, sustained mid fps: no cruise pixel step', sheds() === s0 && dbg().pixelRatio === 1, visible());

// off again: the governor resumes, cruise included
G.setFullDetail(false);
check('off: persisted', mem.get('ew-full-detail') === '0');
for (let i = 0; i < 30; i++) tick(40);
check('control — off, sustained mid fps: the cruise DOES step pixels', dbg().pixelRatio < 1, visible());
G.setFullDetail(true); G.setFullDetail(false); G.applyPendingPixelRatio();

// GRASS SHED, THEN CLEARED: restore() needs a live field, so the switch must reset the budget itself
for (let i = 0; i < 150 && S.grass >= 1; i++) tick(12);
check('(setup) the meadow was thinned', S.grass < 1, visible());
S.hasGrass = false;   // the meadow is cleared while thinned
G.setFullDetail(true);
check('grass cleared while thinned: the budget is back to full, so a regrown meadow is not thin', S.grass === 1, visible());
S.hasGrass = true;
G.setFullDetail(false); G.applyPendingPixelRatio();

// PIXELS SHED, THEN VR: the pixels lever declines in a headset, so the switch must queue the base for after exit
for (let i = 0; i < 150 && dbg().pixelRatio >= 1; i++) tick(12);
check('(setup) the desktop pixel ratio was shed', dbg().pixelRatio < 1, visible());
stub.renderer.xr.isPresenting = true;
const w0 = ratios.length;
G.setFullDetail(true);
G.applyPendingPixelRatio();
check('in a headset: switching on does not resize the headset view', ratios.length === w0, ratios.slice(w0));
stub.renderer.xr.isPresenting = false;
bus.emit('xr:exit-resized'); G.applyPendingPixelRatio();
check('…and after exit the desktop comes back at the base ratio, not the shed one', ratios.at(-1) === 1 && dbg().pixelRatio === 1, { writes: ratios.slice(w0), now: dbg().pixelRatio });

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
