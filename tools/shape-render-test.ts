// shape-render-test — the shape audit's wave 2, render-media-env family (notes/eidoverse/shape-audit/render-media-env.md;
// PLAN.md "Wave 2" + LOCKED). Each row is a behaviour the audit changes, through the real door (a scratch world), the pure
// reader that carries it, or the load repair (shared/protocol/shaperepair.js). Written red first, against the tree before
// the change (wt/w2-physics, ec535895).
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shape-render-test.ts
// @ts-nocheck
import { fileURLToPath } from "node:url";
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from 'node:fs';
import { scratchWorld } from './protocol/scratchworld.ts';
import { COMPONENTS, statusOf, pinOf, materialize } from '../shared/protocol/componentspec.js';
import { lightOf } from '../shared/components.js';
import { isMeshBag } from '../shared/protocol/kind.js';
import * as PE from '../shared/particle_effects.js';
import { foldCaption, describeCaptions, captionsDetail } from '../shared/captions.js';
import { terrainParams } from '../shared/terrainmath.js';
import { hoursAt, effectiveSky, foldSkyEntry } from '../shared/forecast.js';
import { translate } from './protocol/import-v1/translate-v1.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const code = (r: any) => r?.refused?.code ?? (r?.ok ? 'ok' : 'error');
const tryRow = async (name: string, f: () => any) => { try { await f(); } catch (e) { check(`${name} (threw)`, false, String(e?.stack ?? e).slice(0, 300)); } };
const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(ENGINE + p, 'utf8');
// the authority is authority.js and its leaves under authority/ (refactor split, 2026-10-17): a source check reads them all
const readAuthority = () => ['shared/protocol/authority.js', ...fs.readdirSync(ENGINE + 'shared/protocol/authority').filter((f) => f.endsWith('.js')).sort().map((f) => 'shared/protocol/authority/' + f)].map(read).join('\n');
const keys = (o: any) => JSON.stringify(Object.keys(o ?? {}).sort());
const repairMod = async () => await import('../shared/protocol/shaperepair.js');
const v1 = (...rest: any[]) => [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
  ...rest.map((e, i) => ({ seq: i + 1, ts: i + 2, actor: 'ann', ...e }))];

// ===================================================================== light: +decay, −shadows, day → daytime, on thing
await tryRow('LI', async () => {
  const L = COMPONENTS.light;
  check('LI1 light: on thing; fields kind, color, intensity, range, angle, inner, decay, important, daytime (no shadows, no day)', L.on === 'thing' && keys(L.fields) === keys({ kind: 1, color: 1, intensity: 1, range: 1, angle: 1, inner: 1, decay: 1, important: 1, daytime: 1 }), [L.on, Object.keys(L.fields)]);
  check('LI1 …decay default 2 (inverse square: glTF, Godot), 0..4; daytime dim | full, default dim; what an older value without them meant is written', L.defaults?.decay === 2 && L.ranges?.decay?.min === 0 && L.ranges?.decay?.max === 4 && JSON.stringify(L.enums?.daytime) === '["dim","full"]' && L.defaults?.daytime === 'dim' && /1\.7/.test(L.absentMeans?.decay ?? '') && !!L.absentMeans?.daytime, [L.defaults, L.enums, L.absentMeans]);
  const W = scratchWorld('w2r-light').seed({ lamp: { pos: [0, 2, 0] }, porch: { pos: [3, 2, 0] } });
  const C = (id: string) => W.state().entities[id].c;
  let r = W.call('set', { id: 'lamp', component: 'light', value: { color: 0xffffff } });
  check('LI2 a new light stores decay 2 and daytime dim', r.ok && C('lamp').light.decay === 2 && C('lamp').light.daytime === 'dim' && !('shadows' in C('lamp').light) && !('day' in C('lamp').light), [r.refused, C('lamp').light]);
  r = W.call('set', { id: 'porch', component: 'light', value: { day: false } });
  check('LI3 day: false is taken and stored as daytime: full (it burns at noon)', r.ok && C('porch').light.daytime === 'full' && !('day' in C('porch').light), [r.refused, C('porch')?.light]);
  r = W.call('set', { id: 'porch', component: 'light', value: { day: true } });
  check('LI3 …day: true as daytime: dim', r.ok && C('porch').light.daytime === 'dim', [r.refused, C('porch')?.light]);
  r = W.call('set', { id: 'lamp', component: 'light', value: { shadows: true } });
  check('LI4 shadows is refused (read by nothing; it returns when the rig reads it)', code(r) === 'schema' && /shadows/.test(r.refused?.reason ?? ''), r.refused);
  r = W.call('set', { id: '@world', component: 'light', value: {} });
  check('LI5 a light on @world is refused (on: thing)', code(r) === 'thing-only', r.refused);
  const Lo = lightOf({ light: { color: 0xff0000, decay: 1.7, daytime: 'full' } });
  check('LI6 lightOf reads decay and daytime', Lo?.decay === 1.7 && Lo?.daytime === 'full', Lo);
  check('LI6 …an older value without decay reads 1.7 (the rig\'s old constant), without daytime as dim', lightOf({ light: {} })?.decay === 1.7 && lightOf({ light: { day: false } })?.daytime === 'full' && lightOf({ light: {} })?.daytime === 'dim', [lightOf({ light: {} }), lightOf({ light: { day: false } })]);
  check('LI7 an unknown kind is that light absent (one rule with isMeshBag)', lightOf({ light: { kind: 'area' } }) === null && !isMeshBag({ shape: 'torus' }), lightOf({ light: { kind: 'area' } }));
  check('LI8 the realizer passes decay and daytime to the rig', /decay: L\.decay/.test(read('client/lib/realize/models.js')) && /L\.daytime/.test(read('client/lib/realize/models.js')), '');
  const { repairComps } = await repairMod();
  const R = repairComps({ light: { kind: 'point', color: 1, intensity: 16, range: 10, shadows: false, important: false, day: false } }).c;
  check('LI9 repair: a stored light keeps its look (decay 1.7), day → daytime, shadows dropped', JSON.stringify(R.light) === JSON.stringify({ kind: 'point', color: 1, intensity: 16, range: 10, important: false, decay: 1.7, daytime: 'full' }), R.light);
  check('LI9 …a second run finds nothing', repairComps(R).set.length === 0, '');
  const t = translate(v1({ verb: 'light', args: { id: 'l1', pos: [0, 2, 0], color: '#ffeedd', intensity: 8, range: 6, day: false } }));
  const tl = t.final.translated.l1?.light;
  check('LI10 translate-v1@12 writes a v1 light as the load repairs it (decay 1.7, daytime)', tl?.decay === 1.7 && tl?.daytime === 'full' && !('day' in (tl ?? {})) && !t.stats.divergences, [tl, t.stats.divergences]);
});

// ===================================================================== model: its library path as written; the bytes' hash rides beside it
// (R 10-17, binding: "definitely serve path again alongside hash"; review r7 F3/F4, Fable #3)
await tryRow('MD', async () => {
  const A = await import('../shared/protocol/assetref.js');
  const HEX = 'a'.repeat(64);
  const cat = { get: (n: string) => (n === 'props/ball.glb' ? { label: 'ball', surfaces: [], sha256: HEX } : undefined), list: () => [] };
  const out = A.atWrite('model', 'props/ball.glb', { catalogue: cat });
  check('MD1 the door keeps a model as written: its library path, no rewrite, no note', out.value === 'props/ball.glb' && out.notes.length === 0, out);
  const MC = read('server/modelcatalogue.ts');
  check('MD2 the engine\'s catalogue never turns a path into an address (no address()), and hashes at measure, off the authority (a stream, never readFileSync of the original)', !/\baddress\(name/.test(MC) && !/contentAddressOf/.test(MC) && /createReadStream/.test(MC), '');
  check('MD3 model\'s help says a library path; model-hash is registered: on thing, a sha256:<64 hex>, written by the server', /library path/.test(COMPONENTS.model.help) && !/resolved at write to its content address/.test(COMPONENTS.model.help) && COMPONENTS['model-hash']?.on === 'thing' && COMPONENTS['model-hash']?.type === 'sha256' && COMPONENTS['model-hash']?.writtenBy === 'server', [COMPONENTS.model.help, COMPONENTS['model-hash']]);
  const MCAT = { get: (n: string) => (n === 'props/ball.glb' ? { label: 'ball', size: [1, 1, 1], surfaces: [], sha256: HEX } : n === 'props/odd.glb' ? { label: 'odd', size: [1, 1, 1], surfaces: [] } : undefined), list: () => [] };
  const W = scratchWorld('w2r-mhash', { catalogue: MCAT });
  const C = () => W.state().entities.b?.c ?? {};
  let r = W.call('create', { id: 'b', model: 'props/ball.glb', components: { transform: { pos: [0, 0, 0] } } });
  check('MH1 a create stores the path and the server stamps model-hash sha256:<hex> beside it when its catalogue knows the bytes', r.ok && C().model === 'props/ball.glb' && C()['model-hash'] === `sha256:${HEX}`, [r.refused, C()]);
  r = W.call('set', { id: 'b', component: 'model', value: 'props/odd.glb' });
  check('MH2 a model whose bytes the catalogue can\'t name carries no hash: the old one (other bytes) goes with the old model', r.ok && C().model === 'props/odd.glb' && !('model-hash' in C()), [r.refused, C()]);
  r = W.call('set', { id: 'b', component: 'model', value: 'props/ball.glb' });
  check('MH3 …and is stamped again with a model it can name', r.ok && C()['model-hash'] === `sha256:${HEX}`, [r.refused, C()]);
  r = W.call('set', { id: 'b', component: 'model-hash', value: 'abc' });
  check('MH4 a model-hash that isn\'t sha256:<64 hex> is refused', code(r) === 'shape', r.refused);
  r = W.call('delete', { id: 'b', component: 'model' });
  check('MH5 deleting the model deletes its hash', r.ok && !('model' in C()) && !('model-hash' in C()), [r.refused, C()]);
  const W2 = scratchWorld('w2r-mhash-lab');
  r = W2.call('create', { id: 'c', model: 'crate', components: { transform: { pos: [0, 0, 0] } } });
  check('MH6 a catalogue that hashes nothing (the lab\'s) stamps nothing: the hash is optional', r.ok && W2.state().entities.c.c.model === 'crate' && !('model-hash' in W2.state().entities.c.c), [r.refused, W2.state().entities.c?.c]);
});

// ===================================================================== the readers of a model: a path is its own word; an address stored before
// 10-17 still loads and reads as "thing" (never its hex), with no host-local registry
await tryRow('AD', async () => {
  const E = await import('../shared/eido.js');
  const H = 'c'.repeat(64), ADDR = `eido:sha256/${H}`, CW = 'eidoverse/assets/models/crate_wood.glb';
  const hx = E.hexOfLibRel;
  check('AD1 an address stored before 10-17 still fetches: /library/<model> takes eido:sha256/<hex> (the colon raw or %3A) and libRelOf\'s spelling',
    hx(`eido:sha256/${H}`) === H && hx(`eido%3Asha256/${H}`) === H && hx(E.libRelOf(ADDR)) === H && hx(`eido:sha256/${H}.glb`) === null && hx('props/crate.glb') === null, [hx(`eido:sha256/${H}`), hx(`eido%3Asha256/${H}`)]);
  check('AD1 …and the learned address→path registry and its x-library-path header are gone (they only recovered the path the door threw away)',
    !('learnModelPath' in E) && !('learnedModelPath' in E) && !/x-library-path/.test(read('server/routes.ts')) && !/x-library-path/.test(read('client/lib/assets.js')) && !/x-library-path|learnModelPath/.test(read('mcpl/agent.ts')), Object.keys(E));
  check('AD2 one word for a model (shared/eido.js modelWord): a path is its file\'s name, a name given wins, an address nobody names is "thing", never its hex',
    E.modelWord(ADDR) === 'thing' && E.modelWord(ADDR, () => H) === 'thing' && E.modelWord(ADDR, () => ADDR) === 'thing' && E.modelWord(CW) === 'crate_wood' && E.modelWord(CW, () => 'Wooden crate') === 'Wooden crate' && E.modelWord('props/ball.glb') === 'ball', [E.modelWord(ADDR), E.modelWord(CW)]);
  const { kindHint } = await import('../shared/hierarchy.js');
  const { libLabel } = await import('../shared/editschema.js');
  check('AD3 the shared readers: the Hierarchy\'s kind hint and the inspector\'s lib label (a path by its file, an old address "thing")',
    kindHint({ model: ADDR, c: { model: ADDR } }) === 'thing' && libLabel(ADDR) === 'thing' && kindHint({ model: CW, c: { model: CW } }) === 'crate wood' && libLabel(CW) === 'crate wood', [kindHint({ model: ADDR, c: { model: ADDR } }), libLabel(ADDR), libLabel(CW)]);
  const { defaultLayer } = await import('../shared/layers.js');
  check('AD3 …and the layer guess knows a VRM by its path', defaultLayer({ model: 'avatars/statue.vrm', c: { model: 'avatars/statue.vrm' } }) === 'people', defaultLayer({ model: 'avatars/statue.vrm', c: { model: 'avatars/statue.vrm' } }));
  const W = scratchWorld('w2r-addr').seed({ box: { model: ADDR, pos: [0, 0, 0] }, cr: { model: CW, pos: [3, 0, 0] } });
  const ids0 = new Set(Object.keys(W.state().entities));
  let r = W.call('create', { from: 'box' });
  const dup = Object.keys(W.state().entities).find((k) => !ids0.has(k));
  check('AD4 a copy of a thing with an old address gets an opaque id, never the hash (create {from}; R 10-17: no word either)', r.ok && /^[a-z2-7]{26}$/.test(dup ?? ''), [r.refused, dup]);
  const ids1 = new Set(Object.keys(W.state().entities));
  r = W.call('create', { from: 'cr' });
  const dup2 = Object.keys(W.state().entities).find((k) => !ids1.has(k));
  check('AD4 …a copy of one with a path too (its name is its label, never its id)', r.ok && /^[a-z2-7]{26}$/.test(dup2 ?? ''), [r.refused, dup2]);
  const ids2 = new Set(Object.keys(W.state().entities));
  r = W.call('create', { model: ADDR, components: { transform: { pos: [6, 0, 0] } } });
  const mk = Object.keys(W.state().entities).find((k) => !ids2.has(k));
  check('AD4 …and so does a create that names an address and no id', r.ok && /^[a-z2-7]{26}$/.test(mk ?? ''), [r.refused, mk]);
  check('AD5 a script\'s api-1 world.create (an older act re-run) still mints from a word (no lookups: a re-run mints the same id)', /isEido\(comps\.model\)/.test(read('shared/protocol/sandbox.js')), '');
  const { ENGINE_CATALOGUE } = await import('../server/modelcatalogue.ts');
  const cold = ENGINE_CATALOGUE.get(`eido:sha256/${'f'.repeat(64)}`);
  check('AD6 the engine\'s catalogue never labels an address by its hex (a cold entry: "thing")', cold && !/[0-9a-f]{16}/.test(cold.label), cold);
  // the client and agent readers can't run headless here: each is held to the shared word (and not to the value's file name)
  const OLD = /model\??\.split\(['"]\/['"]\)|\(meta\?\.model \?\? meta\?\.kind[^)]*\)\.split|libLabels\.get\(one\.model\) \?\? libLabel|String\(lib \?\? ''\)\.split\('\/'\)|String\(ghost\.lib \?\? ''\)\.split|String\(e?\.?model\)\.split\(["']\/["']\)|String\(rec\.model\)\.split|String\(meta\.model\)\.split|String\(a\.model\)\.split|libLabels\.get\(libPath\) \?\? libPath\.split/;
  const FILES = ['client/lib/build.js', 'client/lib/socketedit.js', 'client/lib/editpanels.js', 'client/lib/scenegraph.js', 'client/lib/plainwords.js', 'client/lib/perfscope.js', 'client/lib/assets.js', 'mcpl/agent.ts', 'mcpl/tools.ts', 'shared/hierarchy.js', 'shared/editschema.js'];   // worldquad and the authority minted from a word: R 10-17, they mint nothing readable now
  const stale = FILES.filter((f) => OLD.test(read(f)) || !/modelWord|modelName/.test(read(f)));
  check('AD7 every client and agent reader that names a thing by its model goes through the shared word', stale.length === 0, stale);
  // the sim (shiplist FL1, 10-16): an addressed dynamic thing is stamped, punted, and flies in the authority and in a client's fold
  {
    const { request, LAB_CATALOGUE } = await import('../shared/protocol/authority.js');
    const { readLog } = await import('../shared/protocol/fold.js');
    const { openLive } = await import('../server/livehost.ts');
    const { makeReplica, clientCutOf } = await import('../shared/protocol/replica.js');
    const { scratch } = await import('./protocol/common.ts');
    const CA = `eido:sha256/${'5'.repeat(64)}`;
    const cat = { get: (n: string) => LAB_CATALOGUE.get(n === CA ? 'crate' : n), list: (q: string) => LAB_CATALOGUE.list(q) };
    const dir = `${scratch('w2r-addr-fly')}w/`; fs.mkdirSync(dir, { recursive: true }); let now = 1800000000000;
    const lw = openLive(dir, 'w', { now: () => ++now, catalogue: cat, custodyFile: `${dir}../custody.json`, nameOf: () => null, kindOf: () => 'human' });
    const lc = (a: string, v: string, x: any = {}, st = 100) => { now += st; return request(lw, a, v, x); };
    const LL = () => readLog(fs.readFileSync(dir + 'world.jsonl'));
    lc('rowan', 'create-world', { title: 'fly' });
    lc('rowan', 'set', { id: '@world', component: 'physics-engine', value: { engine: 'eidosim@1.0.0' } });
    lc('rowan', 'create', { id: 'cuball', model: CA, components: { physics: { kind: 'dynamic', who: 'inhabitant' }, transform: { pos: [0, 0, 0], scale: 0.3 } } });
    lc('rowan', 'move', { to: [0, 0, -0.5] });
    const rep = makeReplica(); rep.adopt(JSON.parse(JSON.stringify({ ...clientCutOf(lw), you: 'vic' })));
    const from = LL().length; const pr = lc('rowan', 'punt', { id: 'cuball', power: 6 }); rep.ingest(LL().slice(from), from);
    const flown: string[] = []; for (let t = 0; t < 40; t++) { const b = rep.simAt?.(now + t * 33)?.bodies?.cuball; if (b) flown.push(b.p.join()); }
    const c0 = lw.state().entities.cuball.c;
    check('AD8 a thing with an old address (written as it is) is stamped with its measured shape, punted, and flies in a client\'s fold (guard: the shared sim keys by the stored model)',
      c0.model === CA && Array.isArray(c0.physics?.shape) && pr.ok && new Set(flown).size > 10, [c0.model, c0.physics, pr.refused, new Set(flown).size]);
  }
});

// ===================================================================== particles: an Essential by its name (an address stored before 10-17 still reads), legacy list dropped, on thing
await tryRow('PT', async () => {
  const P = COMPONENTS.particles;
  check('PT1 particles: on thing; its fields are the instance only (the ten first-protocol fields are gone from the registry)', P.on === 'thing' && keys(P.fields) === keys({ effect: 1, part: 1, at: 1, seed: 1, playing: 1, scale: 1, params: 1 }) && !P.legacy, [P.on, Object.keys(P.fields), P.legacy]);
  const fire = PE.essentialAddress?.('fire');
  check('PT2 each Essential has a content address (eido:sha256/<hash of its canonical document>), pinned in code', /^eido:sha256\/[0-9a-f]{64}$/.test(fire ?? '') && PE.ESSENTIAL_NAMES.every((k) => PE.essentialAddress(k) === `eido:sha256/${PE.effectAddress(PE.ESSENTIALS[k]).slice(7)}` && PE.ESSENTIAL_ADDRESSES?.[k] === PE.essentialAddress(k)), [fire, PE.ESSENTIAL_ADDRESSES]);
  check('PT3 an Essential\'s address reads as that Essential (its document, its name)', PE.effectFor(fire) === PE.ESSENTIALS.fire && PE.essentialNameOf?.(fire) === 'fire', '');
  const a = PE.resolveParticles({ effect: 'fire' }, { entityId: 'h' }), b = PE.resolveParticles({ effect: fire }, { entityId: 'h' });
  check('PT3 …and draws the same as the name did (the derived seed too)', a.ok && b.ok && a.seed === b.seed && JSON.stringify(a.emitters) === JSON.stringify(b.emitters) && a.reads === b.reads, [a.seed, b.seed, a.why, b.why]);
  const W = scratchWorld('w2r-particles').seed({ torch: { model: 'crate', pos: [0, 0, 0] } });
  let r = W.call('set', { id: 'torch', component: 'particles', value: { effect: 'fire' } });
  check('PT4 effect: fire is stored as written, by its name (R 10-17: a reference is its name or path; the code that ships the Essential is what resolves it)', r.ok && W.state().entities.torch.c.particles.effect === 'fire', [r.refused, W.state().entities.torch.c.particles]);
  r = W.call('set', { id: 'torch', component: 'particles', value: { effect: 'fire', params: { count: 40 } } });
  check('PT4 …its params are still checked against fire\'s own', r.ok && code(W.call('set', { id: 'torch', component: 'particles', value: { effect: 'fire', params: { nope: 1 } } })) !== 'ok', r.refused);
  check('PT5 the first protocol\'s spelling is still refused at write', code(W.call('set', { id: 'torch', component: 'particles', value: { preset: 'fire' } })) !== 'ok');
  check('PT6 particles on @world is refused (on: thing)', code(W.call('set', { id: '@world', component: 'particles', value: { effect: 'fire' } })) === 'thing-only');
  const { repairComps } = await repairMod();
  const R = repairComps({ particles: { effect: 'smoke', scale: 2 } }).c;
  check('PT7 repair: a stored Essential name stays its name; a stored document address is left alone', R.particles?.effect === 'smoke' && repairComps({ particles: { effect: 'smoke' } }).set.length === 0 && repairComps({ particles: { effect: `sha256:${'b'.repeat(64)}` } }).set.length === 0, R);
});

// ===================================================================== grass: one spelling, a preset kept by its name (Fable #4), seed/size registered
await tryRow('GR', async () => {
  const G = COMPONENTS.grass;
  check('GR1 grass\'s fields are the flora spelling (no bladeHeight, spacing, perCell, colorTip); preset is stored as written; seed, size and strokes registered', ['bladeHeight', 'spacing', 'perCell', 'colorTip'].every((k) => !(k in G.fields)) && G.fields.preset === 'string' && !('preset' in (G.dropped ?? {})) && G.fields.seed === 'int' && G.fields.size === 'number' && G.fields.strokes === 'array', Object.keys(G.fields));
  const FA = await import('../shared/flora_args.js');
  const P = await import('../shared/flora_presets.js');
  check('GR2 the presets the door checks a name against are the defs file\'s (shared/flora_presets.js = defs/flora/_presets.json)', JSON.stringify(P.FLORA_PRESETS.mojave) === JSON.stringify(JSON.parse(read('defs/flora/_presets.json')).mojave), '');
  const W = scratchWorld('w2r-grass');
  let r = W.call('set', { id: '@world', component: 'grass', value: { preset: 'mojave', width: 40, depth: 30, seed: 5 } });
  const g = W.state().entities['@world'].c.grass;
  check('GR3 a preset is kept by its name at write (expanding later is cheap; un-expanding is impossible)', r.ok && JSON.stringify(g) === JSON.stringify({ preset: 'mojave', width: 40, depth: 30, seed: 5 }), [r.refused, g]);
  check('GR3 …and the reader composes its strokes from the name', JSON.stringify(FA.presetStrokes(g, P.FLORA_PRESETS)).length > 2 && FA.presetStrokes(g, P.FLORA_PRESETS)[0].species === 'galleta_dry', '');
  const S = FA.presetStrokes(g, P.FLORA_PRESETS);
  check('GR4 the reader draws stored strokes as they are', JSON.stringify(FA.presetStrokes({ width: 40, depth: 30, strokes: S })) === JSON.stringify(S), '');
  r = W.call('set', { id: '@world', component: 'grass', value: { width: 20, depth: 20, bladeHeight: 0.5, spacing: 0.26, perCell: 4, color: 0x557733 } });
  const g2 = W.state().entities['@world'].c.grass;
  check('GR5 the old makeGrass knobs are taken and stored in the flora spelling (the reader\'s own mapping, once)', r.ok && JSON.stringify(g2) === JSON.stringify(FA.mapGrassArgs({ width: 20, depth: 20, bladeHeight: 0.5, spacing: 0.26, perCell: 4, color: 0x557733 })), [r.refused, g2]);
  r = W.call('set', { id: '@world', component: 'grass', value: { species: 'grass', width: 10, depth: 10, seed: 3, size: 12 } });
  check('GR6 seed and size are taken (the reader honours both)', r.ok, r.refused);
  check('GR6 …an unknown preset is refused at write (it would throw in every reader)', code(W.call('set', { id: '@world', component: 'grass', value: { preset: 'tundra' } })) !== 'ok');
  const { repairWorld } = await repairMod();
  const R1 = repairWorld({ grass: { preset: 'mojave', width: 40, depth: 30, seed: 5 } }).c.grass;
  const R2 = repairWorld({ grass: { width: 20, bladeHeight: 0.5, color: 0x557733 } }).c.grass;
  check('GR7 repair: a stored preset is kept by its name, stored makeGrass knobs mapped', JSON.stringify(R1) === JSON.stringify({ preset: 'mojave', width: 40, depth: 30, seed: 5 }) && JSON.stringify(R2) === JSON.stringify(FA.mapGrassArgs({ width: 20, bladeHeight: 0.5, color: 0x557733 })), [R1, R2]);
});

// ===================================================================== picture: −part −flip (to material)
await tryRow('PI', () => {
  const P = COMPONENTS.picture;
  check('PI1 picture is {src, width, alt, lit}', keys(P.fields) === keys({ src: 1, width: 1, alt: 1, lit: 1 }) && !('flip' in (P.defaults ?? {})), [Object.keys(P.fields), P.defaults]);
  const W = scratchWorld('w2r-picture').seed({ frame: { model: 'crate', pos: [0, 0, 0] } });
  const r = W.call('set', { id: 'frame', component: 'picture', value: { src: 'store/images/0123456789abcdef.png', part: 'canvas' } });
  check('PI2 part (and flip) are refused, saying texturing a model\'s node is the reserved material\'s', code(r) === 'schema' && /material/.test(`${r.refused?.reason} ${r.refused?.fix}`), r.refused);
  check('PI2 …material is reserved', statusOf('material') === 'reserved');
});

// ===================================================================== captions: the current cue only
await tryRow('CA', () => {
  const C = COMPONENTS.captions;
  check('CA1 captions stores {session, n, gen, title?, line}: no window, no mediaTime', keys(C.fields) === keys({ session: 1, n: 1, gen: 1, title: 1, line: 1 }), Object.keys(C.fields));
  const S = '2026-10-16T20:00:00.000Z-abc';
  const b1 = foldCaption(null, { session: S, n: 1, gen: 1, t0: 0, t1: 2, text: 'hello' });
  const b2 = foldCaption(b1, { session: S, n: 2, gen: 1, t0: 2, t1: 4, text: 'world', speaker: 'Mica' });
  check('CA2 each caption write holds its own line once (the log is the transcript)', !('window' in b2) && !('mediaTime' in b2) && JSON.stringify(b2.line) === JSON.stringify({ t0: 2, t1: 4, text: 'world', speaker: 'Mica' }) && b2.n === 2, b2);
  check('CA3 readers read the current line', /Mica: world/.test(describeCaptions(b2)) && captionsDetail(b2).length === 1, [describeCaptions(b2), captionsDetail(b2)]);
  check('CA3 …and an older value\'s window still reads', /last line: old/.test(describeCaptions({ session: S, n: 1, window: [{ t0: 0, t1: 1, text: 'old' }] })), describeCaptions({ session: S, n: 1, window: [{ t0: 0, t1: 1, text: 'old' }] }));
});

// ===================================================================== sky: 19 → 14, radians, stamped fields refused, defaults in the registry
await tryRow('SK', async () => {
  const K = COMPONENTS.sky;
  const want = ['hours', 'rate', 'ts', 'tz', 'clouds', 'weather', 'weatherK', 'transition', 'azimuth', 'fog', 'exposure', 'ambient', 'forecast', 'override'];
  check('SK1 sky has 14 fields (clock, dormantRated, sun, fill, world cut; weatherSeconds → transition)', keys(K.fields) === keys(Object.fromEntries(want.map((k) => [k, 1]))), Object.keys(K.fields));
  check('SK1 …azimuth in radians (default π), defaults and enums in the registry, units written', K.units?.azimuth === 'rad' && K.defaults?.azimuth === Math.PI && K.defaults?.hours === 12 && K.defaults?.clouds === 'cumulus' && K.enums?.weather?.includes('storm') && K.enums?.clouds?.includes('cirrus') && K.units?.ts === 'ms' && K.units?.transition === 's', [K.units, K.defaults]);
  const W = scratchWorld('w2r-sky');
  let r = W.call('set', { id: '@world', component: 'sky', value: { hours: 9, ts: 5 } });
  check('SK2 a stamped field (ts) is refused from a writer', code(r) === 'stamped' || code(r) === 'derived', r.refused);
  r = W.call('set', { id: '@world', component: 'sky', value: { hours: 9, override: { state: 'rain', ts: 1 } } });
  check('SK2 …override too (the weather act stamps it)', code(r) === 'stamped' || code(r) === 'derived', r.refused);
  r = W.call('set', { id: '@world', component: 'sky', value: { hours: 9, forecast: { seed: 1, states: ['rain'], epoch: 3 } } });
  check('SK2 …and a forecast\'s epoch', code(r) === 'stamped' || code(r) === 'derived', r.refused);
  r = W.call('sky', { hours: 8, clock: 'real', tz: 'Europe/Paris', weatherSeconds: 12 });
  const s = W.state().entities['@world'].c.sky;
  check('SK3 the sky act takes the old spellings and stores today\'s: clock real → tz governs (no clock, no dormantRated), weatherSeconds → transition', r.ok && s.tz === 'Europe/Paris' && !('clock' in s) && !('dormantRated' in s) && s.transition === 12 && !('weatherSeconds' in s) && s.hours === 8, [r.refused, s]);
  check('SK3 …tz present means the wall clock governs', Math.abs(hoursAt({ tz: 'UTC', hours: 3, rate: 0, ts: 0 }, Date.UTC(2026, 0, 1, 15, 30)) - 15.5) < 1e-9, hoursAt({ tz: 'UTC', hours: 3, rate: 0, ts: 0 }, Date.UTC(2026, 0, 1, 15, 30)));
  check('SK4 the sky reader turns the sun by azimuth in radians', /a\.azimuth \?\? Math\.PI/.test(read('client/lib/sky.js')) && !/degToRad\(a\.azimuth/.test(read('client/lib/sky.js')), '');
  check('SK5 a forecast reads dwell and transition (dwellSec/transitionSec read too, in an older value)', effectiveSky({ forecast: { seed: 1, states: ['rain', 'clear'], dwell: [600, 600], transition: 20, epoch: 1 } }, 2).seconds === 20, effectiveSky({ forecast: { seed: 1, states: ['rain', 'clear'], dwell: [600, 600], transition: 20, epoch: 1 } }, 2));
  const { repairWorld } = await repairMod();
  const R = repairWorld({ sky: { clock: 'real', tz: 'America/Los_Angeles', dormantRated: { hours: 7, rate: 2, ts: 100 }, ts: 500, azimuth: 90, weatherSeconds: 20, sun: 1, fill: 1, world: 'earth', forecast: { seed: 2, states: ['rain'], dwellSec: [600, 900], transitionSec: 40, epoch: 9 } } }).c.sky;
  check('SK6 repair: clock real + dormantRated → tz with hours/rate/ts the parked clock; azimuth ×π/180; weatherSeconds → transition; forecast dwell/transition; sun, fill, world dropped', R && R.tz === 'America/Los_Angeles' && R.hours === 7 && R.rate === 2 && R.ts === 100 && Math.abs(R.azimuth - Math.PI / 2) < 1e-12 && R.transition === 20 && keys(R.forecast) === keys({ seed: 2, states: ['rain'], dwell: [600, 900], transition: 40, epoch: 9 }) && JSON.stringify(R.forecast.dwell) === '[600,900]' && R.forecast.transition === 40 && ['clock', 'dormantRated', 'sun', 'fill', 'world', 'weatherSeconds'].every((k) => !(k in R)), R);
  const R2 = repairWorld({ sky: { tz: 'Europe/Paris', hours: 4, ts: 1 } }).c.sky;
  check('SK6 …a tz with no clock is today\'s spelling: kept (it governs; no stored sky held the pre-#65 tz-without-clock)', R2 && R2.tz === 'Europe/Paris' && R2.hours === 4, R2);
});

// ===================================================================== terrain: the sim's defaults, raster reserved, layer colours ints, water split out
await tryRow('TE', async () => {
  const T = COMPONENTS.terrain; const sim = terrainParams({});
  check('TE1 terrain\'s defaults are the sim\'s law (shared/terrainmath.js)', T.defaults?.seed === sim.seed && T.defaults?.size === sim.size && T.defaults?.amplitude === sim.amplitude && T.defaults?.octaves === sim.octaves && T.defaults?.frequency === sim.frequency && T.defaults?.flatRadius === sim.flatRadius && T.defaults?.flatHeight === sim.flatHeight, [T.defaults, sim]);
  const CJ = read('shared/components.js'); const tr = CJ.slice(CJ.indexOf("name: 'Terrain'"), CJ.indexOf("name: 'Grass'"));
  check('TE2 the inspector\'s Terrain reads its defaults from the registry (no seed 7 / size 160 / amplitude 0 / flatRadius 16 of its own)', !/seed: \{ default: 7 \}/.test(tr) && !/size: \{ default: 160 \}/.test(tr) && !/amplitude: \{ default: 0 \}/.test(tr), tr.slice(0, 300));
  check('TE3 kind raster is reserved; water is not a terrain field; layers hold int colours', !('water' in T.fields) && !('blob' in T.fields) && JSON.stringify(T.enums?.kind) === '["noise"]' && /raster/.test(JSON.stringify(T.reservedKinds ?? T.reservedFields ?? {})), [Object.keys(T.fields), T.enums]);
  const W = scratchWorld('w2r-terrain');
  let r = W.call('set', { id: '@world', component: 'terrain', value: { kind: 'raster', blob: 'x', w: 2, h: 2 } });
  check('TE4 a raster terrain is refused as reserved', code(r) === 'reserved', r.refused);
  r = W.call('set', { id: '@world', component: 'terrain', value: { seed: 4, layers: [{ color: '#4a5d33', repeat: 16 }] } });
  const t = W.state().entities['@world'].c.terrain;
  check('TE5 a layer colour "#rrggbb" is taken and stored as an int; the sim\'s defaults are written', r.ok && t.layers[0].color === 0x4a5d33 && t.amplitude === 3 && t.size === 80 && t.octaves === 4 && t.frequency === 2.5 && t.flatHeight === 0, [r.refused, t]);
  r = W.call('set', { id: '@world', component: 'terrain', value: { seed: 4, water: { level: 1 } } });
  check('TE6 terrain.water is refused: water is its own component', code(r) === 'schema' && /water/.test(`${r.refused?.reason} ${r.refused?.fix}`), r.refused);
  const Wa = COMPONENTS.water;
  check('TE7 water: on world, {level (m, required), color (int), opacity, kind, flow}, trial', Wa?.on === 'world' && keys(Wa.fields) === keys({ level: 1, color: 1, opacity: 1, kind: 1, flow: 1 }) && (Wa.required ?? []).includes('level') && Wa.fields.color === 'int' && statusOf('water') === 'trial', Wa);
  r = W.call('set', { id: '@world', component: 'water', value: { level: 0.5, color: 0x1d5a6e } });
  check('TE8 the door takes a water', r.ok, r.refused);
  check('TE8 …on @world only', code(W.call('set', { id: 'x', component: 'water', value: { level: 0 } })) !== 'ok');
  const S = read('shared/protocol/authority/spatial.js');
  check('TE9 the authority\'s ground reads its water level from the water component', /c\.water|waterOfWorld|worldWater/.test(S), '');
  const { repairWorld } = await repairMod();
  const R = repairWorld({ terrain: { seed: 3, size: 100, segments: 64, flatRadius: 4, amplitude: 2, layers: [{ color: '#112233', repeat: 8 }], water: { level: 1, color: '#204060' } } }).c;
  check('TE10 repair: layer colours to ints, the sim\'s defaults written, a stored terrain.water moved to water (its colour an int)', R.terrain.layers[0].color === 0x112233 && R.terrain.octaves === 4 && R.terrain.frequency === 2.5 && R.terrain.flatHeight === 0 && !('water' in R.terrain) && JSON.stringify(R.water) === JSON.stringify({ level: 1, color: 0x204060 }), R);
});

// ===================================================================== label/mesh/sound/text: who may attach; pinned facts
await tryRow('OT', () => {
  check('OT1 label: on thing', COMPONENTS.label.on === 'thing');
  check('OT2 mesh pins its origin (the centre of its base) as a fact', /centre of its base|center of its base/.test(JSON.stringify(COMPONENTS.mesh.absentMeans ?? {}) + (COMPONENTS.mesh.docs?.shape ?? '')), COMPONENTS.mesh.absentMeans);
  check('OT3 sound pins its gain law (inverse distance from near, (1−t)² taper over the last 5%, silent at radius) and that volume is linear gain', /inverse/.test(COMPONENTS.sound.absentMeans?.law ?? COMPONENTS.sound.help) && /5%/.test(COMPONENTS.sound.help) && /linear/.test(COMPONENTS.sound.docs?.volume ?? ''), COMPONENTS.sound.docs?.volume);
  check('OT4 text pins its anchor (where the block sits on its origin)', /anchor|centred|centered/.test(JSON.stringify(COMPONENTS.text.absentMeans ?? {}) + COMPONENTS.text.help), COMPONENTS.text.absentMeans);
  check('OT5 water joins the world look (editWorld)', /WORLD_LOOK = new Set\(\[[^\]]*"water"/.test(readAuthority()), '');
});

// ===================================================================== the load, and the translator, apply the same rules
await tryRow('LD', async () => {
  const { shapeRepairOps } = await repairMod();
  const st = { entities: { '@world': { c: { sky: { azimuth: 180, hours: 6 } } }, l: { c: { light: { kind: 'point', day: true, shadows: false } } } } };
  const ops = shapeRepairOps(st);
  check('LD1 the load\'s ops reach @world (sky) and things (light)', ops.some((o: any) => o.id === '@world' && o.comp === 'sky' && Math.abs(o.value.azimuth - Math.PI) < 1e-12) && ops.some((o: any) => o.id === 'l' && o.comp === 'light' && o.value.decay === 1.7), ops);
  const t = translate(v1({ verb: 'sky', args: { hours: 9, azimuth: 90 } }, { verb: 'terrain', args: { seed: 2, layers: [{ color: '#010203', repeat: 4 }] } }));
  const w = t.final.translated['@world'];
  check('LD2 translate-v1@12 writes @world as the load repairs it (sky radians and the registry\'s defaults, terrain colours and the sim\'s defaults)', Math.abs((w?.sky?.azimuth ?? 0) - Math.PI / 2) < 1e-12 && w?.sky?.fog === 1 && w?.terrain?.layers?.[0]?.color === 0x010203 && w?.terrain?.octaves === 4 && !t.stats.divergences, [w?.sky, w?.terrain, t.stats.divergences]);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
