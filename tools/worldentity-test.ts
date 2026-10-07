// worldentity-test — the world entity `@world` (design §3, shared/worldentity.js)
// and the Build tab's memory (design §5, client/lib/edittabs.js).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/worldentity-test.ts
//
// 1. the alias both ways, on REAL v4 states (a synthetic world through the real
//    door, then every spec fixture translated to v4): after every entry the
//    world reads as Sky / Weather / Terrain / Grass and writes back
//    canon-identical; Sky and Weather partition state.sky; each component at most once
// 2. picking a sky REPLACES the Sky (no leftovers from the old one) and keeps
//    the Weather; a ground/grass pick changes only its own dial
// 3. edits: every card field resolves, commits as the door requests (the sky
//    and weather tools, set/delete @world terrain|grass), reads back as typed;
//    the door's undo puts the world back; the owner gate
// 4. the tab memory: Build the first time (and for a pre-Build layout), then
//    whatever was used last
// 5. the text tier: inspect / edit / hierarchy speak @world (the agent's edit sent to a real door)
//
// v4 port (2026-10-06): the world is read from the v4 view (shared/v4/view.js viewState); every result is the
// door's (tools/v4/scratchworld.ts). worldInverse is gone: undo is the door's `undo`, checked as such.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canon, RECORDS, addable, componentsOf } from '../shared/components.js';
import { fieldAt, describeSchema } from '../shared/editschema.js';
import { terrainArgs, grassArgs, paletteDefaults } from '../shared/grounddefs.js';
import { WORLD_ID, worldComponents, worldOf, worldState, worldSchema, worldEditOps, worldPick, worldChoice, skyPresetOf, pickSky } from '../shared/worldentity.js';
import { TABS, openingTab, useTab, TAB_V } from '../client/lib/edittabs.js';
import { viewState, emptyView } from '../shared/v4/view.js';
import { translate } from './v4/import-v1/translate-v1.js';
import { emptyState as v4Empty, applyInPlace, opsOf } from '../shared/v4/fold.js';
import { v1FoldBuild } from './v4/import-v1/build.ts';
import { scratchWorld, flat } from './v4/scratchworld.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const now = () => Number(process.env.V4_NOW ?? Date.now()) + 500;   // the door's clock (scratchdoor steps it per request)
const ROOT = join(import.meta.dir, '..');
const PRESETS = JSON.parse(readFileSync(join(ROOT, 'defs/sky/_presets.json'), 'utf8'));
const PAL = JSON.parse(readFileSync(join(ROOT, 'defs/ground/_palette.json'), 'utf8'));
// one world change, as worldentity.js spells it, sent to the door
const terrainReq = (v: any) => ['set', { id: WORLD_ID, component: 'terrain', value: v }] as const;
const grassReq = (v: any) => (v == null ? ['delete', { id: WORLD_ID, component: 'grass' }] : ['set', { id: WORLD_ID, component: 'grass', value: v }]) as const;

/** The alias law on one state: round trip exact, Sky/Weather partition state.sky, one of each. */
function aliasBad(st: any): string | null {
  const view = worldComponents(st);
  if (canon(worldOf(view)) !== canon(worldState(st))) return `round trip: was ${canon(worldState(st)).slice(0, 200)} got ${canon(worldOf(view)).slice(0, 200)}`;
  const types = view.components.map((c: any) => c.type);
  if (types.some((t: string) => !['Sky', 'Weather', 'Terrain', 'Grass'].includes(t))) return `a non-world component: ${types}`;
  if (new Set(types).size !== types.length) return `a component twice: ${types}`;
  const sky = view.components.find((c: any) => c.type === 'Sky'); const wx = view.components.find((c: any) => c.type === 'Weather');
  if (sky?.params && wx?.params && Object.keys(wx.params).some((k) => k in sky.params)) return 'a key in both Sky and Weather';
  if (wx && !sky) return 'Weather without its Sky';
  return null;
}

// ------------------------------------------------------------ 1. the alias, on real v4 states
console.log('1. the alias both ways, through the real door:');
{
  const W = scratchWorld('worldentity');
  const bad: string[] = [];
  let n = 0;
  const refusals: string[] = [];
  const step = (tool: string, args: any) => { const r = W.call(tool, args); n++; if (!r.ok) { refusals.push(`${tool} ${JSON.stringify(args).slice(0, 50)}: ${r.refused?.reason}`); return; } const b = aliasBad(W.view()); if (b) bad.push(`${tool} ${JSON.stringify(args).slice(0, 60)}: ${b}`); };
  check('an empty world is an entity with no components (and round-trips to the view\'s nulls)', worldComponents(W.view()).components.length === 0 && aliasBad(W.view()) === null);
  step('weather', { weather: 'rain' });                                          // weather before any sky: the door makes a sky of it
  step('sky', { hours: 8, rate: 24, clouds: 'cumulus', exposure: 0.8 });
  step('weather', { weather: 'storm', weatherSeconds: 12 });                     // (v1's weatherK isn't a key of the door's sky)
  step('sky', { hours: 9, clouds: 'stratus', forecast: { seed: 7, states: ['clear', 'fair', 'rain'], dwellSec: [600, 1800], transitionSec: 45 } });
  step('weather', { weather: 'overcast' });                                      // a manual override under the forecast
  step('sky', { clock: 'real', tz: 'Europe/Paris', hours: 10, rate: 2 });         // parks hours/rate under dormantRated
  step(...terrainReq({ seed: 7, size: 160, segments: 200, amplitude: 2.6, flatRadius: 16, layers: [{ color: '#4a5d33', repeat: 16 }] }));
  step(...grassReq({ species: 'grass', width: 90, depth: 80, center: [0, 0], height: 0.42, density: 1 }));
  step(...grassReq(null));                                                       // mow: delete @world grass
  step(...grassReq({ preset: 'mojave', width: 90, depth: 80, center: [0, 0], density: 1.4 }));
  step('weather', { weather: 'clear', keepSky: false });                         // discards the standing sky
  step('sky', {});
  // KNOWN BUG (reported 2026-10-06, a door/catalogue mismatch, not fixed here): a weather pick under a forecast is a
  // manual override; the door's own skyValue (shared/forecast.js foldSkyEntry) writes sky.override, and the door's sky
  // schema (shared/v4/componentspec.js) has no `override` key, so the door refuses its own value: "unknown key 'override'".
  // The Build tab's weather tile and weather.state are refused in any v4 world with a forecast.
  check('the door takes every request of the synthetic world (KNOWN BUG: a weather under a forecast is refused)', refusals.length === 0, refusals.join(' | '));
  check(`the alias round-trips exactly after every request of a synthetic world (${n} states)`, bad.length === 0, bad.join(' | '));
  const W2 = scratchWorld('worldentity');
  W2.call('sky', { hours: 8, rate: 24, clouds: 'cirrus', forecast: { seed: 3, states: ['clear', 'rain'], dwellSec: [600, 900], transitionSec: 30 } });
  const ov = W2.call('weather', { weather: 'storm' });   // the override (the KNOWN BUG above refuses it)
  const types = worldComponents(W2.view()).components.map((c: any) => `${c.type}:${Object.keys(c.params).sort().join(',')}`);
  check('…and reads as Sky (the day, the clouds) + Weather (weather, forecast, override) — not one opaque bag (KNOWN BUG above: the override is refused)',
    canon(types) === canon(['Sky:clouds,hours,rate', 'Weather:forecast,override,weather']), `${types.join(' | ')} ${ov.ok ? '' : `(weather refused: ${ov.refused?.reason})`}`);
  check('the world records are components (one engine record each), never addable to a thing',
    ['Sky', 'Weather', 'Terrain', 'Grass'].every((t) => /^[0-9a-f]{64}$/.test((RECORDS as any)[t]?.hash ?? '') && (RECORDS as any)[t].category === 'World')
    && !addable(componentsOf({ pos: [0, 0, 0] }).components).some((a: any) => (RECORDS as any)[a.name]?.world));

  // every spec fixture, translated to v4 (shared/v4/translate-v1.js, as a world is migrated), state by state
  const logs: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) walk(p); else if (x === 'log.jsonl') logs.push(p); } };
  walk(join(ROOT, 'spec/fixtures'));
  let states = 0, worldStates = 0, translated = 0; const fbad: string[] = [];
  for (const p of logs) {
    const old: any[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) { try { old.push(JSON.parse(line)); } catch { /* a fixture of a malformed line */ } }
    let r: any; try { r = translate(old, { foldBuild: v1FoldBuild() }); } catch (e) { fbad.push(`${p.split('/').slice(-2).join('/')}: translate threw ${String(e).slice(0, 80)}`); continue; }
    translated++;
    const s: any = v4Empty();
    r.out.forEach((e: any, seq: number) => {
      if (e.kind !== 'change') return;
      applyInPlace(s, opsOf(e), seq);
      const v = viewState(s);
      states++; if (v.sky || v.terrain || v.grass) worldStates++;
      const b = aliasBad(v); if (b && fbad.length < 5) fbad.push(`${p.split('/').slice(-2).join('/')} @${seq}: ${b}`);
    });
  }
  check(`…and after every state of every spec fixture translated to v4 (${translated}/${logs.length} logs, ${states} states, ${worldStates} with a world — the fixtures grow terrain but author no sky)`, fbad.length === 0 && worldStates > 0 && translated === logs.length, fbad.join(' | '));
}

// ------------------------------------------------------------ 2. picking replaces
console.log('\n2. picking a sky replaces the Sky; the Weather stays:');
{
  const W = scratchWorld('worldentity');
  // the storm is authored with the sky (not a weather override under the forecast: see the KNOWN BUG in section 1)
  const s0 = W.call('sky', { hours: 8, rate: 24, clouds: 'stratus', exposure: 0.7, fog: 2, azimuth: 90, weather: 'storm', forecast: { seed: 7, states: ['clear', 'rain'], dwellSec: [600, 1800], transitionSec: 45 } });
  check('(setup) a sky with a storm and a forecast', s0.ok && W.view().sky.weather === 'storm' && !!W.view().sky.forecast, JSON.stringify(s0.refused));
  const st = () => W.view();
  const policy = (s: any) => { const { epoch: _e, seq: _s, by: _b, ...p } = s.forecast ?? {}; return canon(p); };
  const before = { weather: st().sky.weather, policy: policy(st().sky) };
  const r = worldPick(st(), 'sky', 'golden', { presets: PRESETS, now: now() });
  check('a sky pick is ONE door request, the door\'s sky tool', r.errors.length === 0 && r.ops.length === 1 && r.ops[0].verb === 'sky', JSON.stringify(r));
  const skyBefore = st().sky;
  const sent = W.sendAll(r.ops);
  const sky = () => worldComponents(st()).components.find((c: any) => c.type === 'Sky');
  const { doc: _d, ...golden } = PRESETS.golden;
  check('…the door takes it; after it, the Sky IS the preset: no rate, exposure, fog or azimuth left from the old sky', sent.ok && canon(sky()?.params) === canon(golden), JSON.stringify([sent.refused, sky()?.params]));
  check('…there is one Sky (one per entity, one world entity)', worldComponents(st()).components.filter((c: any) => c.type === 'Sky').length === 1);
  check('…the Weather component keeps its weather and its forecast policy', st().sky.weather === before.weather && policy(st().sky) === before.policy, `${st().sky.weather} ${policy(st().sky)}`);
  check('…and the world reads the preset by name', skyPresetOf(st().sky, PRESETS) === 'golden' && worldChoice(st(), { presets: PRESETS, now: now() }).sky === 'golden');
  const u0 = W.call('undo', {});
  check('the door\'s undo puts the whole sky back as it was (the Weather included)', u0.ok && canon(st().sky) === canon(skyBefore), JSON.stringify([u0.refused, st().sky, skyBefore]));
  W.sendAll(worldPick(st(), 'sky', 'golden', { presets: PRESETS, now: now() }).ops);   // and forward again
  // two presets with different keys: the second must not inherit the first's
  const P = { lit: { hours: 6, clouds: 'stratus', exposure: 0.8, fog: 0.4 }, bare: { hours: 12 } };
  W.sendAll(worldPick(st(), 'sky', 'lit', { presets: P, now: now() }).ops);
  W.sendAll(worldPick(st(), 'sky', 'bare', { presets: P, now: now() }).ops);
  check('picking "bare" after "lit" leaves exactly {hours: 12} — the old clouds, exposure and fog are replaced, not merged', canon(sky()?.params) === canon({ hours: 12 }), canon(sky()?.params));
  check('…and the weather is still the storm', st().sky.weather === 'storm');
  check('a preset that names weather itself wins over the carried one', pickSky(st().sky, { hours: 3, weather: 'clear' }).weather === 'clear');
  check('an unknown preset is refused by name, nothing sent', worldPick(st(), 'sky', 'nope', { presets: P }).ops.length === 0 && /nope/.test(worldPick(st(), 'sky', 'nope', { presets: P }).errors[0]));

  console.log('  the ground and grass picks:');
  const G = scratchWorld('worldentity');
  const g = () => G.view();
  const pk = (kind: string, v: string) => { const r = worldPick(g(), kind, v, { pal: PAL, now: now() }); const s = G.sendAll(r.ops); if (!s.ok) check(`the door takes the ${kind} pick`, false, JSON.stringify(s.refused)); return r; };
  const shape = pk('shape', 'rugged');
  check('a ground pick is ONE set @world terrain', shape.ops.length === 1 && shape.ops[0].verb === 'set' && shape.ops[0].args.id === WORLD_ID && shape.ops[0].args.component === 'terrain', JSON.stringify(shape.ops));
  check('a shape on a world with no ground grows the panel\'s ground in that shape (the default tint)', g().terrain?.amplitude === PAL.shapes.rugged && g().terrain.layers[0].color === PAL.tints.meadow.layer && g().terrain.size === 160, canon(g().terrain));
  pk('tint', 'arid');
  check('…a tint pick changes the colour and keeps the shape', g().terrain.amplitude === PAL.shapes.rugged && g().terrain.layers[0].color === PAL.tints.arid.layer, canon(g().terrain));
  G.call(...terrainReq({ ...g().terrain, size: 300 }));
  pk('shape', 'flat');
  check('…a shape pick keeps a hand-authored size', g().terrain.size === 300 && g().terrain.amplitude === PAL.shapes.flat);
  pk('plant', 'meadow');
  G.call(...grassReq({ ...g().grass, height: PAL.grassHeight.tall, density: PAL.grassDensity.lush }));
  pk('plant', 'tufts');
  check('…a planting pick replaces what grows but keeps the height and density dials', g().grass.species === PAL.plantings.tufts.args.species && g().grass.height === PAL.grassHeight.tall && g().grass.density === PAL.grassDensity.lush, canon(g().grass));
  const mow = pk('mow', '');
  check('…mow is delete @world grass, and clears the field', mow.ops[0]?.verb === 'delete' && mow.ops[0].args.component === 'grass' && g().grass === null, JSON.stringify([mow.ops, g().grass]));
  check('the panel\'s args and the World tiles\' are one recipe: terrainArgs = what groundpanel wrote',
    canon(terrainArgs(PAL, { seed: 7, shape: 'hills', tint: 'meadow' })) === canon({ seed: 7, size: 160, segments: 200, amplitude: PAL.shapes.hills, flatRadius: 16, layers: [{ color: PAL.tints.meadow.layer, repeat: 16 }] })
    && canon(grassArgs(PAL, { ...paletteDefaults(PAL), plant: 'meadow' })) === canon({ ...PAL.plantings.meadow.args, height: PAL.grassHeight.meadow, density: PAL.grassDensity.normal }));
  check('weather picks are the door\'s weather tool, and only real weathers', canon(worldPick(g(), 'weather', 'rain').ops) === canon([{ verb: 'weather', args: { weather: 'rain' } }]) && worldPick(g(), 'weather', 'hail').errors.length === 1);
}

// ------------------------------------------------------------ 3. edits, undo, the owner gate
console.log('\n3. the cards: every field commits as door requests and reads back:');
{
  const W = scratchWorld('worldentity');
  W.call('sky', { hours: 9, rate: 24, clouds: 'cumulus' });
  W.call(...terrainReq(terrainArgs(PAL, { seed: 7, shape: 'hills', tint: 'meadow' })));
  W.call(...grassReq(grassArgs(PAL, { ...paletteDefaults(PAL), plant: 'meadow' })));
  const st = () => W.view();
  const sc = worldSchema(st(), { now: now() });
  const own = new Map<string, string>(); const bad: string[] = [];
  for (const sec of sc.sections.list) for (const a of sec.fields) { if (!fieldAt(sc, a)) bad.push(`${a} is no field`); if (own.has(a)) bad.push(`${a} twice`); own.set(a, sec.title); }
  check('four cards (Sky, Weather, Terrain, Grass), every field address resolves and is owned once', canon(sc.sections.list.map((s: any) => s.title)) === canon(['Sky', 'Weather', 'Terrain', 'Grass']) && !bad.length && own.size > 12, bad.join(' · '));
  // one edit is ONE request (inspect.js commitEdit / the agent's edit send OP.batch(ops)); `acts` counts what undo must take back
  const edit = (set: any) => {
    const r = worldEditOps(st(), set, { now: now() }); const was = JSON.parse(JSON.stringify(worldState(st())));
    const one = W.sendAll(r.ops); let acts = r.ops.length ? 1 : 0;
    // the gesture as one request was refused: send its ops one by one so the readback checks below still run
    if (!one.ok) { for (const o of r.ops) W.send(o); acts = r.ops.length; }
    return { ...r, was, one, acts };
  };
  const readBack = (addr: string) => fieldAt(worldSchema(st(), { now: now() }), addr)?.value;
  const e1 = edit({ 'sky.hours': 17, 'sky.clouds': 'cirrus', 'sky.exposure': '+=0.25' });
  check('three sky fields are ONE sky request, and the door takes it', e1.ops.length === 1 && e1.ops[0].verb === 'sky' && e1.one.ok, JSON.stringify([e1.ops, e1.one.refused]));
  check('…and read back as typed (hours 17 now, on a turning day)', Math.abs(readBack('sky.hours') - 17) < 0.05 && readBack('sky.clouds') === 'cirrus' && readBack('sky.exposure') === 1.25, `${readBack('sky.hours')} ${readBack('sky.clouds')} ${readBack('sky.exposure')}`);
  const e2 = edit({ 'terrain.amplitude': '*=2', 'terrain.color': '#112233', 'grass.density': 1.4, 'weather.state': 'rain' });
  check('ground, grass and weather edits: one set terrain, one set grass, one weather request', canon(e2.ops.map((o: any) => o.verb === 'set' ? `set ${o.args.component}` : o.verb).sort()) === canon(['set grass', 'set terrain', 'weather']), JSON.stringify(e2.ops));
  // KNOWN BUG (reported 2026-10-06, not fixed here): a multi-field world edit is ONE batch, and the door's batch takes
  // only create/set/delete/place — the `weather` (and `sky`) tool can't ride in it, so the whole edit is refused.
  // inspect.js commits one field per gesture (unaffected); the agent's `edit @world` with two groups is (section 5).
  check('…and the door takes the edit as ONE request (one act, one undo) (KNOWN BUG: weather can\'t go in a batch)', e2.one.ok, JSON.stringify(e2.one.refused));
  check('…read back as typed', readBack('terrain.amplitude') === PAL.shapes.hills * 2 && readBack('terrain.color') === 0x112233 && readBack('grass.density') === 1.4 && readBack('weather.state') === 'rain'
    && st().terrain.size === 160 && st().terrain.layers[0].repeat === 16, canon(st().terrain));
  const undo = (e: any) => { let ok = true; for (let i = 0; i < e.acts; i++) ok = W.call('undo', {}).ok && ok; return ok; };
  const u2 = undo(e2);
  check('the door\'s undo puts the ground and grass back exactly, and the weather back', u2 && canon(st().terrain) === canon(e2.was.terrain) && canon(st().grass) === canon(e2.was.grass) && (st().sky.weather ?? 'clear') === (e2.was.sky.weather ?? 'clear'), JSON.stringify([st().terrain, st().sky.weather]));
  const e3 = edit({ 'grass.mow': true });
  check('grass.mow mows (delete @world grass); undo grows the same field back', e3.ops[0]?.verb === 'delete' && st().grass === null && (undo(e3), canon(st().grass) === canon(e3.was.grass)), JSON.stringify(e3.ops));
  check('grass.mow on a world with nothing growing sends nothing', (() => { const M = scratchWorld('worldentity'); return worldEditOps(M.view(), { 'grass.mow': true }, { now: now() }).ops.length === 0; })());
  const e4 = edit({ 'sky.clock': 'real' });
  check('clock → real time: the hour and rate become read-only and say whose clock it is', fieldAt(worldSchema(st(), { now: now() }), 'sky.hours')?.disabled === true && /Los_Angeles/.test(fieldAt(worldSchema(st(), { now: now() }), 'sky.hours')?.hint ?? '') && e4.ops[0].args.tz === 'America/Los_Angeles' && e4.one.ok);
  const e5 = edit({ 'sky.clock': 'authored' });
  check('…and back to authored hands the parked rated clock back (rate 24)', st().sky.clock === undefined && st().sky.rate === 24 && e5.errors.length === 0 && e5.one.ok, canon(st().sky));
  check('a refused edit says why and sends nothing for it (unknown field, bad enum, bad colour); the good edit beside them still goes', (() => {
    const r = worldEditOps(st(), { 'sky.nope': 1, 'sky.clouds': 'fluffy', 'terrain.color': 'red', 'weather.state': 'rain' }, { now: now() });
    return r.errors.length === 3 && r.ops.length === 1 && r.ops[0].verb === 'weather';
  })());
  const ro = worldSchema(st(), { now: now(), mayShape: false });
  check('the owner gate: for a known non-owner every field is read-only, saying so, and an edit or a pick sends nothing',
    ro.groups.every((g: any) => g.fields.filter((f: any) => f.k != null).every((f: any) => f.disabled && /owner/.test(f.hint)))
    && worldEditOps(st(), { 'sky.hours': 3 }, { mayShape: false }).ops.length === 0 && worldPick(st(), 'sky', 'golden', { presets: PRESETS, mayShape: false }).ops.length === 0);
  W.call('set', { id: WORLD_ID, component: 'roles:bob', value: { role: 'builder' } });
  const asBob = W.send(worldEditOps(st(), { 'sky.hours': 3 }, { now: now() }).ops[0], {}, 'bob');
  check('…and the door is the gate: a builder\'s sky request is refused (rights)', asBob.ok === false && asBob.refused?.code === 'rights', JSON.stringify(asBob));
  check('unknown rights disable nothing (the door decides, as for things)', worldSchema(st(), { now: now() }).groups.every((g: any) => g.fields.every((f: any) => !f.disabled || /clock is real/.test(f.hint ?? ''))));
  const txt = describeSchema(sc, { verbsHint: false });
  check('describeSchema reads it (what an agent\'s inspect prints)', /sky\.hours = /.test(txt) && /weather\.state = /.test(txt) && /terrain\.amplitude = /.test(txt) && /grass\.mow: action/.test(txt), txt.slice(0, 200));
  const empty = worldSchema(emptyView(), {});
  check('an empty world still shows four cards, defaults marked, saying how to grow ground and grass', empty.sections.list.length === 4 && empty.sections.list.every((s: any) => s.present === false)
    && /Build ▸ World/.test(empty.sections.list.find((s: any) => s.type === 'Terrain').info[0][1]));
}

// ------------------------------------------------------------ 4. the tab memory
console.log('\n4. the left column\'s tab memory (edittabs.js):');
{
  check('two tabs, Build first', canon(TABS.map(([id]) => id)) === canon(['build', 'hierarchy']));
  check('nothing stored: B opens on Build', openingTab(null) === 'build' && openingTab(undefined) === 'build');
  check('a layout saved before Build existed (leftTab hierarchy or the retired create, no tabV) opens on Build once', openingTab({ leftW: 280, leftTab: 'hierarchy' }) === 'build' && openingTab({ leftTab: 'create' }) === 'build');
  const used = useTab({ leftW: 280, leftTab: 'build' }, 'hierarchy');
  check('after the viewer picks Hierarchy, that is what opens next time (the rest of the layout kept)', openingTab(JSON.parse(JSON.stringify(used))) === 'hierarchy' && used.leftW === 280 && used.tabV === TAB_V);
  check('…and Build again after picking Build', openingTab(useTab(used, 'build')) === 'build');
  check('an unknown tab changes nothing; a stored unknown tab opens on Build', canon(useTab(used, 'create')) === canon(used) && openingTab({ leftTab: 'create', tabV: TAB_V }) === 'build');
}

// ------------------------------------------------------------ 5. the text tier
console.log('\n5. the text tier (mcpl/tools.ts): inspect, edit and hierarchy speak @world:');
{
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const { HANDLERS } = await import('../mcpl/tools.ts');
  const W = scratchWorld('worldentity');
  W.call('sky', { hours: 17.6, clouds: 'cumulus' });
  W.call(...terrainReq(terrainArgs(PAL, { seed: 7, shape: 'hills', tint: 'meadow' })));
  W.call('create', { id: 'pivot', components: { transform: { pos: [1, 0, 1] } } });
  const ag = new WorldAgent({ name: 'eye' });
  const A = ag as any;
  // the agent's world is the v4 view; its door is this scratch world's real door (dry runs answered by the door itself)
  const sync = () => { A.st = W.view(); A.reconcileFromFold(); };
  sync();
  A.door = async (tool: string, args: any) => W.call(tool, args);
  const out = (r: any) => (r?.content ?? []).map((c: any) => c.text).join('\n');
  const insp = out(await HANDLERS.inspect(ag as any, { id: WORLD_ID }));
  check('inspect @world: its components and every field, by address', /\[@world\] the world entity/.test(insp) && /components: Sky, Weather \(default\), Terrain, Grass \(default\)/.test(insp) && /sky\.clouds = cumulus/.test(insp) && /terrain\.amplitude = 2\.6/.test(insp), insp.slice(0, 300));
  const one = out(await HANDLERS.edit(ag as any, { id: WORLD_ID, set: { 'sky.hours': 6 }, dry: true }));
  check('edit @world (dry), one group: the sky tool carrying everything standing, and the door answers the dry run', /would send sky \{"hours":6,"clouds":"cumulus"\}/.test(one) && !/refused/.test(one), one);
  const ed = out(await HANDLERS.edit(ag as any, { id: WORLD_ID, set: { 'sky.hours': 6, 'terrain.amplitude': '+=1' }, dry: true }));
  check('edit @world (dry), two groups: ONE request with the sky verb and set terrain (amplitude 3.6)', /would send batch .*"verb":"sky".*"hours":6.*"component":"terrain".*"amplitude":3\.6/.test(ed), ed);
  // KNOWN BUG (reported 2026-10-06): that batch carries the `sky` tool, which the door's batch refuses
  check('…and the door accepts that request (KNOWN BUG: refused, sky can\'t go in a batch)', !/refused|can't go in a batch/.test(ed), ed);
  const bad = out(await HANDLERS.edit(ag as any, { id: WORLD_ID, set: { 'pos.x': 1 }, dry: true }));
  check('…an address the world has not is refused by name', /refused: pos\.x: no such field on @world/.test(bad), bad);
  const wet = out(await HANDLERS.edit(ag as any, { id: WORLD_ID, set: { 'terrain.amplitude': '+=1' } }));
  sync();
  check('edit @world for real: the door accepts it and the world reads back the new amplitude', /the door accepted it/.test(wet) && A.st.terrain?.amplitude === 3.6, wet);
  const hier = out(await HANDLERS.hierarchy(ag as any, {}));
  check('hierarchy pins the world first, then the things', /^\[@world\] World — sky /.test(hier) && /\[pivot\]/.test(hier.split('\n')[1] ?? ''), hier.split('\n').slice(0, 2).join(' / '));
  const filtered = out(await HANDLERS.hierarchy(ag as any, { filter: 'zzz' }));
  check('…even under a filter that matches nothing else', /^\[@world\]/.test(filtered) && /no placed thing matches "zzz"/.test(filtered), filtered);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
