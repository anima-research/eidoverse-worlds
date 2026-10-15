// worldentity — the world entity `@world` (design §3), as an ALIAS both ways.
//
// A world's sky, ground and grass are the world entity's components (the view shows them as state.sky,
// state.terrain, state.grass; weather is part of the sky). This file reads them as ONE entity whose components are
// Sky, Weather, Terrain and Grass (records in shared/components.js), and writes every edit as requests: the
// door's `sky` and `weather` tools (they stamp the clock), and set/delete of @world's `terrain` and `grass`:
//
//   worldComponents(st)       → { id: '@world', components, stamps }
//   worldOf(view)             → { sky, terrain, grass }   (the inverse, exact:
//                               tools/components-corpus-test.ts holds it on every world log)
//   worldSchema(st, live)     → the inspector's schema (shared/editschema.js shape),
//                               so the desktop cards, the VR quad and an agent's
//                               `inspect @world` read one declaration
//   worldEditOps(st, edits)   → { ops, errors } — `edit @world`, as requests
//   worldPick(st, kind, v)    → the Build tab's World tiles: a preset pick as one request
//
// "One sky per world" is not a rule here: Sky is one-per-entity, and there is
// one world entity. Picking a sky preset REPLACES the Sky component's params
// (pickSky); the Weather component is a different component and is carried
// across the sky verb's wholesale fold. Pure: no DOM, no I/O, `now` passed in.

import * as OP from './protocol/requests.js';
import { RECORDS } from './components.js';
import { WEATHERS, CLOUDS, hoursAt, effectiveSky } from './forecast.js';
import { terrainArgs, grassArgs, groundChoice, paletteDefaults } from './grounddefs.js';
import { fieldAt, parseEntry, limitsOf } from './editschema.js';
import { TRUSTED } from './drafts.js';

export const WORLD_ID = '@world';
export const isWorldId = (id) => id === WORLD_ID;

// state.sky's keys that are the Weather component's (written by the weather
// verb, or the sky verb's forecast policy and the fold's override stamp), and
// the ones the fold stamps on the bag. Everything else in state.sky is the Sky.
const WEATHER_KEYS = ['weather', 'weatherK', 'weatherSeconds', 'forecast', 'override'];
const SKY_STAMPS = ['ts', 'seq', 'by'];
const DEFAULT_TZ = 'America/Los_Angeles';

const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const round = (v, dp = 3) => +(+v).toFixed(dp);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The world's part of the fold, absent = null (the fold's own empty value). */
export function worldState(st) {
  return { sky: st?.sky ?? null, terrain: st?.terrain ?? null, grass: st?.grass ?? null };
}

// ---------------------------------------------------------------- the alias

/** Read the fold's world as an entity: { id, components: [{type, key, params}], stamps }.
 *  `key` names the fold slot a component lives in (sky / terrain / grass). Sky and
 *  Weather share state.sky and partition its keys; a slot holding something that is
 *  not an object (no verb writes one, but a log is a log) rides `raw`, verbatim. */
export function worldComponents(st) {
  const { sky, terrain, grass } = worldState(st);
  const components = [];
  const stamps = {};
  if (isBag(sky)) {
    components.push({ type: 'Sky', key: 'sky', params: omit(sky, [...WEATHER_KEYS, ...SKY_STAMPS]) });
    const w = pick(sky, WEATHER_KEYS);
    if (Object.keys(w).length) components.push({ type: 'Weather', key: 'sky', params: w });
    const s = pick(sky, SKY_STAMPS);
    if (Object.keys(s).length) stamps.sky = s;
  } else if (sky != null) components.push({ type: 'Sky', key: 'sky', raw: sky });
  if (terrain != null) components.push(isBag(terrain) ? { type: 'Terrain', key: 'terrain', params: { ...terrain } } : { type: 'Terrain', key: 'terrain', raw: terrain });
  if (grass != null) components.push(isBag(grass) ? { type: 'Grass', key: 'grass', params: { ...grass } } : { type: 'Grass', key: 'grass', raw: grass });
  return { id: WORLD_ID, components, stamps };
}

/** Write the world entity back in the fold's spelling: the exact inverse of
 *  worldComponents (canon-equal to worldState(st) for every state). */
export function worldOf({ components = [], stamps = {} } = {}) {
  const out = { sky: null, terrain: null, grass: null };
  for (const c of components) {
    if ('raw' in c) { out[c.key] = c.raw; continue; }
    switch (c.type) {
      case 'Sky': case 'Weather': out.sky = { ...(out.sky ?? {}), ...c.params }; break;
      case 'Terrain': out.terrain = { ...c.params }; break;
      case 'Grass': out.grass = { ...c.params }; break;
      default: throw new Error(`worldOf: ${c.type} is not a world component`);
    }
  }
  if (stamps.sky) out.sky = { ...(out.sky ?? {}), ...stamps.sky };
  return out;
}

// ---------------------------------------------------------------- re-issuing the existing verbs

/** sky-verb args that re-author `sky` with `patch` applied (undefined in the
 *  patch deletes a key). The sky verb folds WHOLESALE, so everything standing
 *  rides along — the Weather component included — minus what the fold stamps
 *  itself (ts/seq/by, the override, a forecast's epoch/seq/by). A rated clock is
 *  re-anchored at `now` (unless the patch sets hours) so the day doesn't snap
 *  back to the hour it was last authored at — the weather fold's own rule. */
export function skyReissue(sky, patch = {}, now = 0) {
  const base = isBag(sky) ? omit(sky, [...SKY_STAMPS, 'override']) : {};
  if (isBag(base.forecast)) base.forecast = omit(base.forecast, ['epoch', 'seq', 'by']);
  if (isBag(sky) && (sky.rate ?? 0) !== 0 && sky.clock !== 'real' && !('hours' in patch)) base.hours = round(hoursAt(sky, now), 4);
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete base[k]; else base[k] = clone(v); }
  return base;
}

/** The sky preset a world's Sky currently IS, by name, or null: every preset
 *  key matches and the Sky holds nothing the preset doesn't say. */
export function skyPresetOf(sky, presets) {
  if (!isBag(sky) || !isBag(presets)) return null;
  const own = omit(sky, [...WEATHER_KEYS, ...SKY_STAMPS, 'dormantRated']);
  for (const [name, p] of Object.entries(presets)) {
    if (name === 'doc' || !isBag(p)) continue;
    const keys = Object.keys(p).filter((k) => !WEATHER_KEYS.includes(k));
    if (keys.every((k) => own[k] === p[k]) && Object.keys(own).every((k) => keys.includes(k))) return name;
  }
  return null;
}

/** Picking a sky REPLACES the Sky (design §3): the new Sky's params are the
 *  preset's and nothing else. The Weather component is carried (the sky verb
 *  would otherwise wipe it); a preset that names weather itself wins. */
export function pickSky(sky, preset) {
  const weather = isBag(sky) ? pick(sky, ['weather', 'weatherK', 'weatherSeconds', 'forecast']) : {};
  if (isBag(weather.forecast)) weather.forecast = omit(weather.forecast, ['epoch', 'seq', 'by']);
  return { ...clone(weather), ...omit(clone(preset) ?? {}, ['doc']) };
}

/** One world change as its request: the sky and weather are the authority's `sky`/`weather` tools (they stamp the
 *  clock: PROTOCOL sky tools), the ground and grass are @world's `terrain`/`grass` components; mow removes grass. */
const skyOp = (args) => ({ verb: 'sky', args });
const weatherOp = (weather) => ({ verb: 'weather', args: { weather } });
const terrainOp = (args) => OP.set(WORLD_ID, 'terrain', args);
const grassOp = (args) => (args == null ? OP.unset(WORLD_ID, 'grass') : OP.set(WORLD_ID, 'grass', args));

// ---------------------------------------------------------------- the schema

const SKY_NUMS = [   // the sky panel's sliders (client/lib/skypanel.js SLIDERS): key, label, min, softMax, step, default, unit
  ['hours', 'time of day', 0, 24, 0.1, 12, 'h'], ['rate', 'rate', 0, 48, 0.5, 0, '×'],
  ['azimuth', 'sun azimuth', 0, 360, 5, 180, '°'], ['sun', 'sun', 0, 2.5, 0.05, 1], ['ambient', 'ambient', 0, 2.5, 0.05, 1],
  ['fill', 'fill', 0, 2.5, 0.05, 1], ['exposure', 'exposure', 0.3, 1.8, 0.05, 1], ['fog', 'fog', 0, 3, 0.05, 1],
];
const hex = (n) => `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
const colorInt = (s) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : null);

/** A one-line reading of the world, for the Hierarchy's pinned row and the text tier. */
export function describeWorld(st, now = 0, { presets = null, clock = true } = {}) {
  const { sky, terrain, grass } = worldState(st);
  const parts = [];
  if (isBag(sky)) {
    const h = hoursAt(sky, now);
    const name = skyPresetOf(sky, presets);
    // clock:false leaves the time out — a panel row whose text is its shape would rebuild every minute
    const hm = clock ? ` ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}` : '';
    parts.push(`sky${name ? ` ${name}` : ''}${hm}${sky.clouds ? ` ${sky.clouds}` : ''}`.replace(/^sky$/, 'sky authored'));
    const e = effectiveSky(sky, now);
    if (e.weather) parts.push(`${e.weather}${e.source !== 'authored' ? ` (${e.source})` : ''}`);
  } else parts.push('default sky');
  parts.push(isBag(terrain) ? `ground ${terrain.amplitude ?? 0} m relief` : 'flat ground');
  if (isBag(grass)) parts.push(`${grass.preset ?? grass.species ?? 'grass'} growing`);
  return parts.join(' · ');
}

/** The world entity's inspector schema — the same shape inspectSchema returns
 *  ({ id, groups, sections }), so editpanels' cards, the VR quad, describeSchema
 *  and fieldAt all read it unchanged. Addresses: sky.* weather.state terrain.*
 *  grass.* (grass.mow mows).
 *  @param live { now?: number, mayShape?: boolean } — mayShape false = this viewer
 *  is known not to hold owner rank (sky/terrain/grass/weather are owner verbs);
 *  undefined = unknown: nothing is disabled on its account and the authority decides. */
export function worldSchema(st, live = {}) {
  const { sky, terrain, grass } = worldState(st);
  const now = live.now ?? 0;
  const ro = live.mayShape === false ? { disabled: true, hint: 'shaping the world is the owner\'s: sky, weather, terrain and grass are owner-rank' } : {};
  const groups = [];

  // Sky
  const real = isBag(sky) && sky.clock === 'real';
  const s = isBag(sky) ? sky : {};
  const skyFields = [
    { t: 'enum', k: 'clock', label: 'clock', value: real ? 'real' : 'authored', def: 'authored', options: [{ v: 'authored', label: 'authored' }, { v: 'real', label: 'real time' }], ...ro,
      hint: ro.hint ?? 'authored: the hour and rate below; real time: the hour IS a timezone\'s wall hour' },
    ...(real ? [{ t: 'text', k: 'tz', label: 'timezone', value: s.tz ?? DEFAULT_TZ, ...ro }] : []),
  ];
  for (const [k, label, min, softMax, step, def, unit] of SKY_NUMS) {
    const clocked = real && (k === 'hours' || k === 'rate');
    const value = k === 'hours' ? round(isBag(sky) ? hoursAt(sky, now) : def, 2) : (typeof s[k] === 'number' ? s[k] : def);
    skyFields.push({ t: 'num', k, label, value, def, min, ...(k === 'hours' ? { max: 24 } : { softMax }), step, dp: step < 0.1 ? 2 : 1, ...(unit ? { unit } : {}),
      ...(clocked ? { disabled: true, hint: `the clock is real: the hour is ${s.tz ?? DEFAULT_TZ}'s` } : ro),
      ...(k === 'hours' && !clocked && (s.rate ?? 0) !== 0 ? { hint: ro.hint ?? 'the hour now — the day turns at the rate below; setting it re-anchors the day here' } : {}) });
    if (k === 'rate') skyFields.push({ t: 'enum', k: 'clouds', label: 'clouds', value: s.clouds ?? 'cumulus', def: 'cumulus', options: CLOUDS.map((v) => ({ v, label: v })), ...ro });
  }
  if (sky != null) skyFields.push({ t: 'btn', k: 'remove', label: 'remove the sky', danger: true, hint: 'back to a plain clear sky (weather goes with it)', ...ro });
  groups.push({ group: 'sky', label: 'Sky', fields: skyFields });

  // Weather — state.sky's weather half; under a forecast a pick is a manual
  // override that holds until the segment boundary (AGENTS.md "Weather")
  const eff = isBag(sky) ? effectiveSky(sky, now) : null;
  const f = isBag(sky?.forecast) ? sky.forecast : null;
  const wxFields = [
    { t: 'enum', k: 'state', label: 'weather', value: eff?.weather ?? 'clear', def: 'clear', options: WEATHERS.map((v) => ({ v, label: v })), ...ro,
      ...(f && !ro.hint ? { hint: 'a forecast governs: a pick holds until the next segment boundary, then the forecast resumes' } : {}) },
    { t: 'info', label: 'now', value: eff ? `${eff.weather ?? 'clear'} — ${eff.source === 'forecast' ? 'the forecast\'s' : eff.source === 'manual' ? `set by ${eff.by ?? '?'} until the next segment` : 'authored'}` : 'clear — no sky authored yet' },
    ...(f ? [{ t: 'info', label: 'forecast', value: `seed ${f.seed ?? '?'} · ${(f.states ?? []).map((x) => (typeof x === 'string' ? x : x?.state)).join(', ')} · by ${f.by ?? '?'} — set or cleared by the authority's sky tool (its forecast)` }] : []),
  ];
  groups.push({ group: 'weather', label: 'Weather', fields: wxFields });

  // Terrain
  const t = isBag(terrain) ? terrain : null;
  const layerColor = colorInt(Array.isArray(t?.layers) ? t.layers[0]?.color : null);
  // hard limits and units are the registry's (componentspec terrain / grass, through limitsOf); the slider's soft ends are this card's
  const T = (k) => limitsOf('terrain', k), G = (k) => limitsOf('grass', k);
  const terrainFields = t ? [
    { t: 'num', k: 'amplitude', label: 'relief', value: t.amplitude ?? 0, def: 0, ...T('amplitude'), softMin: 0, softMax: 12, step: 0.1, dp: 1, ...ro },
    { t: 'num', k: 'seed', label: 'seed', value: t.seed ?? 0, step: 1, dp: 0, ...ro },
    { t: 'num', k: 'size', label: 'size', value: t.size ?? 160, ...T('size'), softMin: 1, softMax: 1000, step: 10, dp: 0, ...ro },
    { t: 'num', k: 'segments', label: 'segments', value: t.segments ?? 200, ...T('segments'), step: 1, dp: 0, ...ro },
    { t: 'num', k: 'flatRadius', label: 'flat within', value: t.flatRadius ?? 0, ...T('flatRadius'), softMax: 200, step: 1, dp: 0, ...ro },
    ...(layerColor != null ? [{ t: 'color', k: 'color', label: 'colour', value: layerColor, ...ro }] : []),
  ] : [{ t: 'info', label: '', value: 'no terrain authored: the default flat ground. Pick a shape in Build ▸ World' }];
  if (terrain != null) terrainFields.push({ t: 'btn', k: 'remove', label: 'remove the terrain', danger: true, hint: 'back to the default flat ground', ...ro });
  groups.push({ group: 'terrain', label: 'Terrain', fields: terrainFields });

  // Grass
  const g = isBag(grass) ? grass : null;
  const grassFields = g ? [
    { t: 'info', label: 'planting', value: String(g.preset ?? g.species ?? '?') },
    { t: 'num', k: 'density', label: 'density', value: g.density ?? 1, def: 1, ...G('density'), softMin: 0.05, softMax: 3, step: 0.05, dp: 2, ...ro },
    ...(g.height != null ? [{ t: 'num', k: 'height', label: 'blade height', value: g.height, ...G('height'), softMin: 0.02, softMax: 2, step: 0.01, dp: 2, ...ro }] : []),
    ...(g.width != null ? [{ t: 'num', k: 'width', label: 'width', value: g.width, ...G('width'), softMin: 1, softMax: 400, step: 1, dp: 0, ...ro }] : []),
    ...(g.depth != null ? [{ t: 'num', k: 'depth', label: 'depth', value: g.depth, ...G('depth'), softMin: 1, softMax: 400, step: 1, dp: 0, ...ro }] : []),
    { t: 'btn', k: 'mow', label: 'mow', danger: true, ...ro },
  ] : [{ t: 'info', label: '', value: 'nothing growing. Pick a planting in Build ▸ World' }];
  groups.push({ group: 'grass', label: 'Grass', fields: grassFields });

  // Trusted components (docs/COMPONENT-LADDER.md, the second rung; R 10-12): the drafts this world's owner trusts here,
  // @world.trusted — live.trusted is the list as the client read it (mayTrust: this viewer is the owner)
  const trusted = Array.isArray(live.trusted) ? live.trusted : [];
  const trustedFields = trusted.length ? trusted.flatMap((n) => [{ t: 'info', label: 'trusted', value: n, hint: 'a draft used and trusted in this world: a blue chip, offered in the main Add Component list. The engine still doesn\'t read it' },
    ...(live.mayTrust === true ? [{ t: 'btn', k: `remove|${n}`, label: `stop trusting ${n}`, danger: true, hint: 'back to a plain draft (amber, under "drafts"). Nothing stored changes' }] : [])])
    : [{ t: 'info', label: '', value: 'none: every draft here is unproven. An owner trusts one from its card on a thing' }];
  groups.push({ group: TRUSTED, label: 'Trusted components', fields: trustedFields });

  // the cards (design §5): one per component, in the inspector's order
  const have = new Set(worldComponents(st).components.map((c) => c.type));
  const list = groups.map(({ group, fields }) => {
    const type = { sky: 'Sky', weather: 'Weather', terrain: 'Terrain', grass: 'Grass' }[group];
    if (!type) return { type: 'Trusted', key: group, title: 'Trusted components', hash: null, category: 'World', summary: 'the drafts this world\'s owner trusts here (@world.trusted): not engine-official, but used and trusted in this world',
      fields: fields.filter((x) => x.k != null).map((x) => `${group}.${x.k}`), removable: false, info: fields.filter((x) => x.t === 'info' && x.value).map((x) => [x.label, x.value]), present: trusted.length > 0 };
    const rec = RECORDS[type];
    return { type, key: group, title: type, hash: rec.hash, category: rec.category, summary: rec.summary,
      fields: fields.filter((x) => x.k != null).map((x) => `${group}.${x.k}`), removable: false,
      info: fields.filter((x) => x.t === 'info' && x.value).map((x) => [x.label, x.value]), present: have.has(type) };
  });
  return { id: WORLD_ID, world: true, groups, sections: { header: [], list, add: [], lib: null, libLabel: 'the world' } };
}

// ---------------------------------------------------------------- edits → requests

/** Turn `edit @world` edits into the fewest requests: every sky.* edit is
 *  ONE re-authored sky, weather.state ONE weather, terrain.* ONE terrain set, grass.*
 *  ONE grass set (grass.mow: delete @world grass). Relative math works on numbers, as
 *  on any entity. Pure: never sends, never mutates `st`. */
export function worldEditOps(st, edits, live = {}) {
  const { sky, terrain, grass } = worldState(st);
  const now = live.now ?? 0;
  const schema = worldSchema(st, live);
  const errors = [];
  let skyPatch = null, weather = null, ground = null, grassPatch = null, mow = false, noSky = false, noGround = false;   // ground: the terrain patch
  let untrust = null;   // names to take off @world.trusted
  for (const [key, raw] of Object.entries(edits ?? {})) {
    const f = fieldAt(schema, key);
    if (!f || f.t === 'info') { errors.push(`${key}: no such field on ${WORLD_ID} (sky.* weather.state terrain.* grass.* trusted.*; inspect @world lists them)`); continue; }
    if (f.disabled) { errors.push(`${key}: ${f.hint ?? 'read-only'}`); continue; }
    const group = key.slice(0, key.indexOf('.')); const k = key.slice(key.indexOf('.') + 1);
    let v = raw;
    if (f.t === 'num') {
      v = parseEntry(raw, +f.value);
      if (v == null) { errors.push(`${f.label}: not a number (${JSON.stringify(raw)})`); continue; }
      v = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v));
    } else if (f.t === 'enum') {
      if (!f.options.some((o) => o.v === v)) { errors.push(`${f.label}: one of ${f.options.map((o) => o.v).join('|')} (got ${JSON.stringify(raw)})`); continue; }
    } else if (f.t === 'color') {
      v = typeof raw === 'string' ? colorInt(raw.startsWith('#') ? raw : `#${raw.replace(/^0x/i, '')}`) : raw;
      if (!Number.isInteger(v)) { errors.push(`${f.label}: a colour (#rrggbb or 0xrrggbb)`); continue; }
    } else if (f.t === 'text') v = String(raw ?? '').trim();
    switch (group) {
      case 'sky':
        if (k === 'remove') { noSky = true; break; }
        skyPatch ??= {};
        if (k === 'clock') {
          if (v === 'real') Object.assign(skyPatch, { clock: 'real', tz: sky?.tz ?? DEFAULT_TZ });
          else {
            // back to the authored clock: the fold parked the rated clock under
            // dormantRated (#65); hand it back, as the sky panel does
            Object.assign(skyPatch, { clock: undefined, tz: undefined });
            const d = sky?.dormantRated;
            if (isBag(d)) { if (d.rate != null) skyPatch.rate = d.rate; if (d.hours != null) skyPatch.hours = round(d.rate ? hoursAt({ hours: d.hours, rate: d.rate, ts: d.ts }, now) : d.hours, 4); }
          }
        } else if (k === 'tz') { if (!v) { errors.push('timezone: empty'); continue; } skyPatch.tz = v; }
        else skyPatch[k] = v;
        break;
      case 'weather': weather = v; break;
      case 'terrain':
        if (k === 'remove') { noGround = true; break; }
        ground ??= {};
        if (k === 'color') ground.layers = (Array.isArray(terrain?.layers) ? terrain.layers : [{ repeat: 16 }]).map((l, i) => (i ? l : { ...l, color: hex(v) }));
        else ground[k] = v;
        break;
      case 'grass': if (k === 'mow') mow = true; else (grassPatch ??= {})[k] = v; break;
      case TRUSTED: if (k.startsWith('remove|')) (untrust ??= new Set()).add(k.slice(7)); break;
    }
  }
  const ops = [];
  // R 10-11: "no way to get rid of the weather, sky, or terrain once created": remove is a plain component delete
  if (noSky) { if (sky != null) ops.push(OP.unset(WORLD_ID, 'sky')); }
  else if (skyPatch) ops.push(skyOp(skyReissue(sky, skyPatch, now)));
  if (weather != null) ops.push(weatherOp(weather));
  if (noGround) { if (terrain != null) ops.push(OP.unset(WORLD_ID, 'terrain')); }
  else if (ground) ops.push(terrainOp({ ...clone(terrain), ...ground }));
  if (mow) { if (isBag(grass)) ops.push(grassOp(null)); }
  else if (grassPatch) ops.push(grassOp({ ...clone(grass), ...grassPatch }));
  if (untrust) { const next = (Array.isArray(live.trusted) ? live.trusted : []).filter((n) => !untrust.has(n)); ops.push(next.length ? OP.set(WORLD_ID, TRUSTED, { components: next }) : OP.unset(WORLD_ID, TRUSTED)); }
  return { ops, errors };
}

// ---------------------------------------------------------------- the Build tab's World tiles

/** A preset pick from Build ▸ World, as one request: picking replaces the current
 *  choice of that kind.
 *    kind 'sky'     v = a sky preset name (ctx.presets, defs/sky/_presets.json) → sky (pickSky)
 *    kind 'weather' v = one of WEATHERS                                          → weather
 *    kind 'shape' | 'tint'  v = a ground-palette name (ctx.pal)                  → terrain (only that dial changes)
 *    kind 'plant'   v = a planting name                                           → grass (height/density/tint kept)
 *    kind 'mow'                                                                   → grass {clear:true}
 *  ctx: { pal, presets, now, mayShape } */
export function worldPick(st, kind, v, ctx = {}) {
  const { sky, terrain, grass } = worldState(st);
  if (ctx.mayShape === false) return { ops: [], errors: ['shaping the world is the owner\'s: sky, weather, terrain and grass are owner-rank'] };
  const pal = ctx.pal; const def = paletteDefaults(pal);
  let op = null;
  switch (kind) {
    case 'sky': {
      const p = ctx.presets?.[v];
      if (!isBag(p) || v === 'doc') return { ops: [], errors: [`no sky preset "${v}"`] };
      op = skyOp(pickSky(sky, p));
      break;
    }
    case 'weather':
      if (!WEATHERS.includes(v)) return { ops: [], errors: [`weather: one of ${WEATHERS.join('|')}`] };
      op = weatherOp(v);
      break;
    case 'shape': case 'tint': {
      if (!(kind === 'shape' ? pal?.shapes?.[v] != null : pal?.tints?.[v])) return { ops: [], errors: [`no ground ${kind} "${v}"`] };
      op = terrainOp(isBag(terrain) ? terrainArgs(pal, { [kind]: v }, terrain) : terrainArgs(pal, { shape: def.shape, tint: def.tint, seed: def.seed, [kind]: v }));
      break;
    }
    case 'plant': {
      const c = groundChoice(pal, terrain, grass);
      const args = grassArgs(pal, { plant: v, height: c.height ?? def.height, density: c.density ?? def.density, tint: c.tint ?? def.tint });
      if (!args) return { ops: [], errors: [`no planting "${v}"`] };
      op = grassOp(args);
      break;
    }
    case 'mow': op = grassOp(null); break;
    default: return { ops: [], errors: [`nothing to pick for "${kind}"`] };
  }
  return { ops: [op], errors: [] };
}

/** Which World tile reads as armed, per row: the current choice by name. */
export function worldChoice(st, { pal, presets, now = 0 } = {}) {
  const { sky, terrain, grass } = worldState(st);
  const c = groundChoice(pal, terrain, grass);
  return { sky: skyPresetOf(sky, presets), weather: isBag(sky) ? (effectiveSky(sky, now).weather ?? null) : null,
    shape: c.shape, tint: c.tint, plant: isBag(grass) ? c.plant : null };
}
