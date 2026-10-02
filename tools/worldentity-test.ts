// worldentity-test — the world entity `@world` (design §3, shared/worldentity.js)
// and the Build tab's memory (design §5, client/lib/edittabs.js).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/worldentity-test.ts
//
// 1. the alias both ways, on REAL fold states (a synthetic log through the real
//    fold, then every spec fixture): after every entry the world reads as
//    Sky / Weather / Ground / Grass and writes back canon-identical; Sky and
//    Weather partition state.sky; each component at most once
// 2. picking a sky REPLACES the Sky (no leftovers from the old one) and keeps
//    the Weather; a ground/grass pick changes only its own dial
// 3. edits: every card field resolves, commits as the existing verb, folds back
//    to the value typed; undo's inverse folds the world back; the owner gate
// 4. the tab memory: Build the first time (and for a pre-Build layout), then
//    whatever was used last
// 5. the text tier: inspect / edit / hierarchy speak @world
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState, foldEntry } from '../shared/fold.js';
import { canon, RECORDS, addable, componentsOf } from '../shared/components.js';
import { fieldAt, describeSchema } from '../shared/editschema.js';
import { hoursAt } from '../shared/forecast.js';
import { terrainArgs, grassArgs, paletteDefaults } from '../shared/grounddefs.js';
import { WORLD_ID, worldComponents, worldOf, worldState, worldSchema, worldEditVerbs, worldPick, worldChoice, skyPresetOf, pickSky, worldInverse } from '../shared/worldentity.js';
import { TABS, openingTab, useTab, TAB_V } from '../client/lib/edittabs.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
let seq = 0;
const T0 = 1786320000000;
const fold = (st: any, verb: string, args: any) => foldEntry(st, { seq: ++seq, ts: T0 + seq * 1000, actor: 'owner', verb, args });
const now = () => T0 + seq * 1000 + 500;
const ROOT = join(import.meta.dir, '..');
const PRESETS = JSON.parse(readFileSync(join(ROOT, 'defs/sky/_presets.json'), 'utf8'));
const PAL = JSON.parse(readFileSync(join(ROOT, 'defs/ground/_palette.json'), 'utf8'));

/** The alias law on one state: round trip exact, Sky/Weather partition state.sky, one of each. */
function aliasBad(st: any): string | null {
  const view = worldComponents(st);
  if (canon(worldOf(view)) !== canon(worldState(st))) return `round trip: was ${canon(worldState(st)).slice(0, 200)} got ${canon(worldOf(view)).slice(0, 200)}`;
  const types = view.components.map((c: any) => c.type);
  if (types.some((t: string) => !['Sky', 'Weather', 'Ground', 'Grass'].includes(t))) return `a non-world component: ${types}`;
  if (new Set(types).size !== types.length) return `a component twice: ${types}`;
  const sky = view.components.find((c: any) => c.type === 'Sky'); const wx = view.components.find((c: any) => c.type === 'Weather');
  if (sky?.params && wx?.params && Object.keys(wx.params).some((k) => k in sky.params)) return 'a key in both Sky and Weather';
  if (wx && !sky) return 'Weather without its Sky';
  return null;
}

// ------------------------------------------------------------ 1. the alias, on real fold states
console.log('1. the alias both ways, through the real fold:');
{
  const st: any = emptyState();
  const bad: string[] = [];
  let n = 0;
  const step = (verb: string, args: any) => { fold(st, verb, args); n++; const b = aliasBad(st); if (b) bad.push(`${verb} ${JSON.stringify(args).slice(0, 60)}: ${b}`); };
  check('an empty world is an entity with no components (and round-trips to the fold\'s nulls)', worldComponents(st).components.length === 0 && aliasBad(st) === null);
  step('weather', { weather: 'rain' });                                          // weather before any sky: the fold makes a sky of it
  step('sky', { hours: 8, rate: 24, clouds: 'cumulus', exposure: 0.8 });
  step('weather', { weather: 'storm', weatherK: 0.6, weatherSeconds: 12 });
  step('sky', { hours: 9, clouds: 'stratus', forecast: { seed: 7, states: ['clear', 'fair', 'rain'], dwellSec: [600, 1800], transitionSec: 45 } });
  step('weather', { weather: 'overcast' });                                      // a manual override under the forecast
  step('sky', { clock: 'real', tz: 'Europe/Paris', hours: 10, rate: 2 });         // parks hours/rate under dormantRated
  step('terrain', { seed: 7, size: 160, segments: 200, amplitude: 2.6, flatRadius: 16, layers: [{ color: '#4a5d33', repeat: 16 }] });
  step('grass', { species: 'grass', width: 90, depth: 80, center: [0, 0], height: 0.42, density: 1 });
  step('grass', { clear: true });
  step('grass', { preset: 'mojave', width: 90, depth: 80, center: [0, 0], density: 1.4 });
  step('weather', { weather: 'clear', keepSky: false });                         // discards the standing sky
  step('sky', {});
  check(`the alias round-trips exactly after every entry of a synthetic world (${n} states)`, bad.length === 0, bad.join(' | '));
  const st2: any = emptyState();
  fold(st2, 'sky', { hours: 8, rate: 24, clouds: 'cirrus', forecast: { seed: 3, states: ['clear', 'rain'], dwellSec: [600, 900], transitionSec: 30 } });
  fold(st2, 'weather', { weather: 'storm' });
  const types = worldComponents(st2).components.map((c: any) => `${c.type}:${Object.keys(c.params).sort().join(',')}`);
  check('…and reads as Sky (the day, the clouds) + Weather (weather, forecast, override) — not one opaque bag',
    canon(types) === canon(['Sky:clouds,hours,rate', 'Weather:forecast,override,weather']), types.join(' | '));
  check('the world records are components (one engine record each), never addable to a thing',
    ['Sky', 'Weather', 'Ground', 'Grass'].every((t) => /^[0-9a-f]{64}$/.test((RECORDS as any)[t]?.hash ?? '') && (RECORDS as any)[t].category === 'World')
    && !addable(componentsOf({ pos: [0, 0, 0] }).components).some((a: any) => (RECORDS as any)[a.name]?.world));

  // every spec fixture, entry by entry (the corpus test runs the same law over every local world)
  const logs: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) walk(p); else if (x === 'log.jsonl') logs.push(p); } };
  walk(join(ROOT, 'spec/fixtures'));
  let states = 0, worldStates = 0; const fbad: string[] = [];
  for (const p of logs) {
    const s: any = emptyState();
    for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); foldEntry(s, e); } catch { continue; }
      states++; if (s.sky || s.terrain || s.grass) worldStates++;
      const b = aliasBad(s); if (b && fbad.length < 5) fbad.push(`${p.split('/').slice(-2).join('/')} @${e.seq}: ${b}`);
    }
  }
  check(`…and after every entry of every spec fixture (${logs.length} logs, ${states} states, ${worldStates} with a world — the fixtures grow terrain but author no sky; components-corpus-test holds the skies of every real world)`, fbad.length === 0 && worldStates > 0, fbad.join(' | '));
}

// ------------------------------------------------------------ 2. picking replaces
console.log('\n2. picking a sky replaces the Sky; the Weather stays:');
{
  const st: any = emptyState();
  fold(st, 'sky', { hours: 8, rate: 24, clouds: 'stratus', exposure: 0.7, fog: 2, azimuth: 90, forecast: { seed: 7, states: ['clear', 'rain'], dwellSec: [600, 1800], transitionSec: 45 } });
  fold(st, 'weather', { weather: 'storm' });
  const policy = (s: any) => { const { epoch: _e, seq: _s, by: _b, ...p } = s.forecast ?? {}; return canon(p); };
  const before = { weather: st.sky.weather, policy: policy(st.sky) };
  const r = worldPick(st, 'sky', 'golden', { presets: PRESETS, now: now() });
  check('a sky pick is ONE sky verb', r.errors.length === 0 && r.verbs.length === 1 && r.verbs[0].verb === 'sky', JSON.stringify(r));
  for (const v of r.verbs) fold(st, v.verb, v.args);
  const sky = () => worldComponents(st).components.find((c: any) => c.type === 'Sky');
  const { doc: _d, ...golden } = PRESETS.golden;
  check('…after it, the Sky IS the preset: no rate, exposure, fog or azimuth left from the old sky', canon(sky()?.params) === canon(golden), canon(sky()?.params));
  check('…there is one Sky (one per entity, one world entity)', worldComponents(st).components.filter((c: any) => c.type === 'Sky').length === 1);
  check('…the Weather component keeps its weather and its forecast policy', st.sky.weather === before.weather && policy(st.sky) === before.policy, `${st.sky.weather} ${policy(st.sky)}`);
  check('…and the world reads the preset by name', skyPresetOf(st.sky, PRESETS) === 'golden' && worldChoice(st, { presets: PRESETS, now: now() }).sky === 'golden');
  // two presets with different keys: the second must not inherit the first's
  const P = { lit: { hours: 6, clouds: 'stratus', exposure: 0.8, fog: 0.4 }, bare: { hours: 12 } };
  for (const v of worldPick(st, 'sky', 'lit', { presets: P, now: now() }).verbs) fold(st, v.verb, v.args);
  for (const v of worldPick(st, 'sky', 'bare', { presets: P, now: now() }).verbs) fold(st, v.verb, v.args);
  check('picking "bare" after "lit" leaves exactly {hours: 12} — the old clouds, exposure and fog are replaced, not merged', canon(sky()?.params) === canon({ hours: 12 }), canon(sky()?.params));
  check('…and the weather is still the storm', st.sky.weather === 'storm');
  check('a preset that names weather itself wins over the carried one', pickSky(st.sky, { hours: 3, weather: 'clear' }).weather === 'clear');
  check('an unknown preset is refused by name, nothing sent', worldPick(st, 'sky', 'nope', { presets: P }).verbs.length === 0 && /nope/.test(worldPick(st, 'sky', 'nope', { presets: P }).errors[0]));
  const u = worldInverse(st, { verb: 'sky' }, now());
  check('a sky pick\'s undo re-authors the Sky it replaced (Weather included)', u?.verb === 'sky' && u.args.hours === 12 && u.args.weather === 'storm' && !('seq' in u.args) && !('ts' in u.args), JSON.stringify(u));

  console.log('  the ground and grass picks:');
  const g: any = emptyState();
  const pk = (kind: string, v: string) => { const r = worldPick(g, kind, v, { pal: PAL, now: now() }); for (const x of r.verbs) fold(g, x.verb, x.args); return r; };
  pk('shape', 'rugged');
  check('a shape on a world with no ground grows the panel\'s ground in that shape (the default tint)', g.terrain?.amplitude === PAL.shapes.rugged && g.terrain.layers[0].color === PAL.tints.meadow.layer && g.terrain.size === 160, canon(g.terrain));
  pk('tint', 'arid');
  check('…a tint pick changes the colour and keeps the shape', g.terrain.amplitude === PAL.shapes.rugged && g.terrain.layers[0].color === PAL.tints.arid.layer, canon(g.terrain));
  fold(g, 'terrain', { ...g.terrain, size: 300 });
  pk('shape', 'flat');
  check('…a shape pick keeps a hand-authored size', g.terrain.size === 300 && g.terrain.amplitude === PAL.shapes.flat);
  pk('plant', 'meadow');
  fold(g, 'grass', { ...g.grass, height: PAL.grassHeight.tall, density: PAL.grassDensity.lush });
  pk('plant', 'tufts');
  check('…a planting pick replaces what grows but keeps the height and density dials', g.grass.species === PAL.plantings.tufts.args.species && g.grass.height === PAL.grassHeight.tall && g.grass.density === PAL.grassDensity.lush, canon(g.grass));
  pk('mow', '');
  check('…mow clears the field', g.grass === null);
  check('the panel\'s args and the World tiles\' are one recipe: terrainArgs = what groundpanel wrote',
    canon(terrainArgs(PAL, { seed: 7, shape: 'hills', tint: 'meadow' })) === canon({ seed: 7, size: 160, segments: 200, amplitude: PAL.shapes.hills, flatRadius: 16, layers: [{ color: PAL.tints.meadow.layer, repeat: 16 }] })
    && canon(grassArgs(PAL, { ...paletteDefaults(PAL), plant: 'meadow' })) === canon({ ...PAL.plantings.meadow.args, height: PAL.grassHeight.meadow, density: PAL.grassDensity.normal }));
  check('weather picks are the weather verb, and only real weathers', canon(worldPick(g, 'weather', 'rain').verbs) === canon([{ verb: 'weather', args: { weather: 'rain' } }]) && worldPick(g, 'weather', 'hail').errors.length === 1);
}

// ------------------------------------------------------------ 3. edits, undo, the owner gate
console.log('\n3. the cards: every field commits through the existing verbs and folds back:');
{
  const st: any = emptyState();
  fold(st, 'sky', { hours: 9, rate: 24, clouds: 'cumulus' });
  fold(st, 'terrain', terrainArgs(PAL, { seed: 7, shape: 'hills', tint: 'meadow' }));
  fold(st, 'grass', grassArgs(PAL, { ...paletteDefaults(PAL), plant: 'meadow' }));
  const sc = worldSchema(st, { now: now() });
  const own = new Map<string, string>(); const bad: string[] = [];
  for (const sec of sc.sections.list) for (const a of sec.fields) { if (!fieldAt(sc, a)) bad.push(`${a} is no field`); if (own.has(a)) bad.push(`${a} twice`); own.set(a, sec.title); }
  check('four cards (Sky, Weather, Ground, Grass), every field address resolves and is owned once', canon(sc.sections.list.map((s: any) => s.title)) === canon(['Sky', 'Weather', 'Ground', 'Grass']) && !bad.length && own.size > 12, bad.join(' · '));
  const edit = (set: any) => { const r = worldEditVerbs(st, set, { now: now() }); const was = JSON.parse(JSON.stringify(worldState(st))); for (const v of r.verbs) fold(st, v.verb, v.args); return { ...r, was }; };
  const readBack = (addr: string) => fieldAt(worldSchema(st, { now: now() }), addr)?.value;
  const e1 = edit({ 'sky.hours': 17, 'sky.clouds': 'cirrus', 'sky.exposure': '+=0.25' });
  check('three sky fields are ONE sky verb', e1.verbs.length === 1 && e1.verbs[0].verb === 'sky', JSON.stringify(e1.verbs));
  check('…and read back as typed (hours 17 now, on a turning day)', Math.abs(readBack('sky.hours') - 17) < 0.05 && readBack('sky.clouds') === 'cirrus' && readBack('sky.exposure') === 1.25, `${readBack('sky.hours')} ${readBack('sky.clouds')} ${readBack('sky.exposure')}`);
  const e2 = edit({ 'ground.amplitude': '*=2', 'ground.color': '#112233', 'grass.density': 1.4, 'weather.state': 'rain' });
  check('ground, grass and weather edits: one terrain, one grass, one weather verb', canon(e2.verbs.map((v: any) => v.verb).sort()) === canon(['grass', 'terrain', 'weather']));
  check('…folded back as typed', readBack('ground.amplitude') === PAL.shapes.hills * 2 && readBack('ground.color') === 0x112233 && readBack('grass.density') === 1.4 && readBack('weather.state') === 'rain'
    && st.terrain.size === 160 && st.terrain.layers[0].repeat === 16, canon(st.terrain));
  const undo = (e: any) => { for (const v of [...e.inverses].reverse()) fold(st, v.verb, v.args); };
  undo(e2);
  check('undo\'s inverses fold the ground and grass back exactly, and the weather back', canon(st.terrain) === canon(e2.was.terrain) && canon(st.grass) === canon(e2.was.grass) && st.sky.weather === (e2.was.sky.weather ?? 'clear'), canon(st.terrain));
  const e3 = edit({ 'grass.mow': true });
  check('grass.mow mows (grass {clear:true}); its undo grows the same field back', st.grass === null && (undo(e3), canon(st.grass) === canon(e3.was.grass)));
  const e4 = edit({ 'sky.clock': 'real' });
  check('clock → real time: the hour and rate become read-only and say whose clock it is', fieldAt(worldSchema(st, { now: now() }), 'sky.hours')?.disabled === true && /Los_Angeles/.test(fieldAt(worldSchema(st, { now: now() }), 'sky.hours')?.hint ?? '') && e4.verbs[0].args.tz === 'America/Los_Angeles');
  const e5 = edit({ 'sky.clock': 'authored' });
  check('…and back to authored hands the parked rated clock back (rate 24)', st.sky.clock === undefined && st.sky.rate === 24 && e5.errors.length === 0, canon(st.sky));
  check('a refused edit says why and sends nothing for it (unknown field, bad enum, bad colour); the good edit beside them still goes', (() => {
    const r = worldEditVerbs(st, { 'sky.nope': 1, 'sky.clouds': 'fluffy', 'ground.color': 'red', 'weather.state': 'rain' }, { now: now() });
    return r.errors.length === 3 && r.verbs.length === 1 && r.verbs[0].verb === 'weather';
  })());
  const ro = worldSchema(st, { now: now(), mayShape: false });
  check('the owner gate: for a known non-owner every field is read-only, saying so, and an edit or a pick sends nothing',
    ro.groups.every((g: any) => g.fields.filter((f: any) => f.k != null).every((f: any) => f.disabled && /owner/.test(f.hint)))
    && worldEditVerbs(st, { 'sky.hours': 3 }, { mayShape: false }).verbs.length === 0 && worldPick(st, 'sky', 'golden', { presets: PRESETS, mayShape: false }).verbs.length === 0);
  check('unknown rights disable nothing (the door decides, as for things)', worldSchema(st, { now: now() }).groups.every((g: any) => g.fields.every((f: any) => !f.disabled || /clock is real/.test(f.hint ?? ''))));
  const txt = describeSchema(sc, { verbsHint: false });
  check('describeSchema reads it (what an agent\'s inspect prints)', /sky\.hours = /.test(txt) && /weather\.state = /.test(txt) && /ground\.amplitude = /.test(txt) && /grass\.mow: action/.test(txt), txt.slice(0, 200));
  const empty = worldSchema(emptyState(), {});
  check('an empty world still shows four cards, defaults marked, saying how to grow ground and grass', empty.sections.list.length === 4 && empty.sections.list.every((s: any) => s.present === false)
    && /Build ▸ World/.test(empty.sections.list.find((s: any) => s.type === 'Ground').info[0][1]));
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
  const ag = new WorldAgent({ name: 'eye' });
  const A = ag as any; let n = 1;
  const entry = (verb: string, args: Record<string, unknown>) => A.applyEntry({ verb, args, ts: T0 + n * 1000, seq: n++, actor: 'owner' }, false);
  entry('sky', { hours: 17.6, clouds: 'cumulus' });
  entry('terrain', terrainArgs(PAL, { seed: 7, shape: 'hills', tint: 'meadow' }));
  entry('spawn', { id: 'pivot', pos: [1, 0, 1] });
  const out = (r: any) => (r?.content ?? []).map((c: any) => c.text).join('\n');
  const insp = out(await HANDLERS.inspect(ag as any, { id: WORLD_ID }));
  check('inspect @world: its components and every field, by address', /\[@world\] the world entity/.test(insp) && /components: Sky, Weather \(default\), Ground, Grass \(default\)/.test(insp) && /sky\.clouds = cumulus/.test(insp) && /ground\.amplitude = 2\.6/.test(insp), insp.slice(0, 300));
  const ed = out(await HANDLERS.edit(ag as any, { id: WORLD_ID, set: { 'sky.hours': 6, 'ground.amplitude': '+=1' }, dry: true }));
  check('edit @world (dry): one sky and one terrain verb, the sky carrying everything standing', /would send sky \{"hours":6,"clouds":"cumulus"\}/.test(ed) && /would send terrain .*"amplitude":3\.6/.test(ed), ed);
  const bad = out(await HANDLERS.edit(ag as any, { id: WORLD_ID, set: { 'pos.x': 1 }, dry: true }));
  check('…an address the world has not is refused by name', /refused: pos\.x: no such field on @world/.test(bad), bad);
  const hier = out(await HANDLERS.hierarchy(ag as any, {}));
  check('hierarchy pins the world first, then the things', /^\[@world\] World — sky golden|^\[@world\] World — sky /.test(hier) && /\[pivot\]/.test(hier.split('\n')[1] ?? ''), hier.split('\n').slice(0, 2).join(' / '));
  const filtered = out(await HANDLERS.hierarchy(ag as any, { filter: 'zzz' }));
  check('…even under a filter that matches nothing else', /^\[@world\]/.test(filtered) && /no placed thing matches "zzz"/.test(filtered), filtered);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
