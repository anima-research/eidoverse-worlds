// shared/zone.js — a world's water bodies, dry pockets and physics areas in world space (zone + water / water-exclusion / physics-area: componentspec.js),
// and the waters/airs shared/water.js reads (mediumAt, inBox, waterPath, swimStep). Pure.
import { worldPose, offChain } from "./protocol/simlayer.js";
import { qRotate, qConj } from "./rot.js";
import { waterParams, mediumAt, waveHeight, inBox, excludes, MAX_WATER, MAX_AIR } from "./water.js";

const fin = Number.isFinite;
const v3 = (x) => Array.isArray(x) && x.length === 3 && x.every(fin);
const cmp = (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** {bodies, exclusions} in the order they apply (priority ascending, then id: the last one a point is in wins, mediumAt's rule).
 *  A body is {id, global, priority, water, center, size, q, toLocal, top, bottom}; @world's level is the one global body
 *  ({id: '@world', global: true, priority: -Infinity, water, top}). `poseOf(id)` → {pos, q, scale} in world space (a renderer
 *  passes its live one); absent, the fold's (simlayer worldPose). A switched-off thing, or one under one, holds nothing. */
export function zonesOf(st, { poseOf = (id) => worldPose(st, id) } = {}) {
  const bodies = [], exclusions = [];
  for (const id of Object.keys(st?.entities ?? {})) {
    const c = st.entities[id]?.c ?? {};
    if (id === "@world") { if (c.water && fin(c.water.level)) bodies.push({ id, global: true, priority: -Infinity, water: c.water, top: c.water.level }); continue; }
    const wet = c.water && typeof c.water === "object", dry = c["water-exclusion"] && typeof c["water-exclusion"] === "object";
    if (!(wet || dry) || c.zone?.shape !== "box" || c.zone.global === true || !v3(c.zone.size) || offChain(st, id)) continue;
    const pose = poseOf(id); if (!pose) continue;
    const scale = v3(pose.scale) ? pose.scale.map(Math.abs) : [1, 1, 1], q = pose.q ?? [0, 0, 0, 1], center = [...pose.pos];
    const size = c.zone.size.map((x, i) => Math.abs(x) * scale[i]);
    const toLocal = (p) => qRotate(qConj(q), [p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
    const priority = Number.isInteger(c.zone.priority) ? c.zone.priority : 0;
    if (wet) {   // a body's box is in its own frame (toLocal, as a pocket's); its surface stays level: the level or its top
      const zoneTop = center[1] + size[1] / 2, bottom = center[1] - size[1] / 2;
      const top = fin(c.water.level) ? Math.max(bottom, Math.min(zoneTop, center[1] + c.water.level * scale[1])) : zoneTop;
      bodies.push({ id, global: false, priority, water: c.water, center, size, q, toLocal, top, bottom });
    } else {
      const ids = c["water-exclusion"].bodies;
      exclusions.push({ id, priority, center, size, q, toLocal, bodies: Array.isArray(ids) ? [...ids] : null });
    }
  }
  return { bodies: bodies.sort(cmp), exclusions: exclusions.sort(cmp) };
}

/** The physics areas (componentspec physics-area on a box or global zone; Godot Area3D's overrides) in world space, in the
 *  order they apply (cmp: the last one a point is in wins): [{id, global, priority, kind, factor, toLocal, size}]. */
export function physicsAreasOf(st, { poseOf = (id) => worldPose(st, id) } = {}) {
  const out = [];
  for (const id of Object.keys(st?.entities ?? {})) {
    const c = st.entities[id]?.c ?? {}, a = c["physics-area"];
    if (id === "@world" || !a || typeof a !== "object" || !c.zone || offChain(st, id)) continue;
    const priority = Number.isInteger(c.zone.priority) ? c.zone.priority : 0, factor = fin(a.factor) && a.factor > 0 ? a.factor : 1;
    const modes = Array.isArray(a.modes) && a.modes.length ? a.modes : null;
    if (c.zone.global === true) { out.push({ id, global: true, priority, kind: a.kind, factor, modes }); continue; }
    if (c.zone.shape !== "box" || !v3(c.zone.size)) continue;
    const pose = poseOf(id); if (!pose) continue;
    const scale = v3(pose.scale) ? pose.scale.map(Math.abs) : [1, 1, 1], q = pose.q ?? [0, 0, 0, 1], center = [...pose.pos];
    out.push({ id, global: false, priority, kind: a.kind, factor, modes, size: c.zone.size.map((x, i) => Math.abs(x) * scale[i]), toLocal: (p) => qRotate(qConj(q), [p[0] - center[0], p[1] - center[1], p[2] - center[2]]) });
  }
  return out.sort(cmp);
}
/** × a body's own speed at p (physics-area kind speed) in movement `mode` (absent: any): the highest-priority speed area
 *  holding p that touches that mode decides; none: 1. */
export function speedFactorAt(areas, p, mode) {
  for (let i = (areas?.length ?? 0) - 1; i >= 0; i--) { const a = areas[i]; if (a.kind !== "speed" || (mode && a.modes && !a.modes.includes(mode))) continue;
    if (a.global) return a.factor; const l = a.toLocal(p); if (l.every((v, k) => Math.abs(v) <= a.size[k] / 2)) return a.factor; }
  return 1;
}

/** KHR_materials_volume's attenuation as the per-metre absorption σ shared/water.js reads: σ = −ln(c) / d (absent → undefined). */
export function absorptionOf(w) {
  if (w?.attenuationColor === undefined && w?.attenuationDistance === undefined) return undefined;
  const c = v3(w.attenuationColor) ? w.attenuationColor : [1, 1, 1], d = fin(w.attenuationDistance) && w.attenuationDistance > 0 ? w.attenuationDistance : Infinity;
  return c.map((x) => -Math.log(Math.max(1e-6, Math.min(1, x))) / d);
}

/** The waters and airs shared/water.js reads, from zonesOf: the bodies' (globals left to the level's own readers) as waterParams
 *  plus {toLocal, id, priority, top, bottom, q, color, opacity, kind, flow, density}; the exclusions as boxes with toLocal, priority and bodies. */
export function waterVolumes({ bodies = [], exclusions = [] } = {}) {
  const waters = bodies.filter((b) => !b.global).map((b) => {
    const w = b.water, h = b.top - b.bottom;
    const p = waterParams({ center: [b.center[0], b.bottom + h / 2, b.center[2]], size: [b.size[0], h, b.size[2]], waves: w.waves, absorption: absorptionOf(w), scatter: w.scatterColor });
    const c = p.center, qi = qConj(b.q ?? [0, 0, 0, 1]), toLocal = (x) => qRotate(qi, [x[0] - c[0], x[1] - c[1], x[2] - c[2]]);
    return { ...p, toLocal, id: b.id, priority: b.priority, top: b.top, bottom: b.bottom, q: b.q, color: w.color, opacity: w.opacity, kind: w.kind, flow: w.flow, density: fin(w.density) ? w.density : 1000 };
  });
  const airs = exclusions.map((x) => ({ id: x.id, priority: x.priority, bodies: x.bodies, center: x.center, size: x.size, q: x.q, toLocal: x.toLocal }));
  return { waters, airs };
}

/** A water's world AABB (its oriented box's corners, surface at its top): what the GPU fog's slots approximate it by. */
export function waterBox(w) {
  const q = w.q ?? [0, 0, 0, 1], h = [0, 1, 2].map((i) => [0, 1, 2].reduce((a, j) => a + Math.abs(qRotate(q, [0, 1, 2].map((k) => (k === j ? 1 : 0)))[i]) * w.size[j] / 2, 0));
  return { min: w.center.map((v, i) => v - h[i]), max: w.center.map((v, i) => v + h[i]) };
}

/** A water's heading (rad about +Y): the surface mesh turns by it (client/lib/watervolumes.js), its waves stay in world space. */
export const headingOf = (q) => { const x = qRotate(q ?? [0, 0, 0, 1], [1, 0, 0]); return Math.atan2(-x[2], x[0]); };

const AT_WORLD = { id: "@world", priority: -Infinity };
const worldFlow = (f, q) => (!Array.isArray(f) || !f.every(fin) ? null : f.length === 2 ? (q ? qRotate(q, [f[0], 0, f[1]]) : [f[0], 0, f[1]]) : f.length === 3 ? (q ? qRotate(q, f) : [...f]) : null);
/** The one reader of the combine law (the highest-priority body containing p decides, @world's level lowest of all; a pocket
 *  beats every body at or below its priority, @world's included): {medium: "water" | "air", level, flow, body, priority} at p.
 *  level is the surface's world y there (its waves at `time`), flow world-frame m/s; in air, all three are null. */
export function mediumOf(p, zones, { time = 0, volumes = waterVolumes(zones) } = {}) {
  const w = mediumAt(p, volumes.waters, volumes.airs, time);
  if (w) return { medium: "water", level: waveHeight(w, p[0], p[2], time), flow: worldFlow(w.flow, w.q), body: w.id, priority: w.priority };
  const g = zones.bodies.find((b) => b.global);
  if (g && p[1] <= g.top && !volumes.airs.some((a) => inBox(p, a) && excludes(a, AT_WORLD))) return { medium: "water", level: g.top, flow: worldFlow(g.water.flow, null), body: g.id, priority: g.priority };
  return { medium: "air", level: null, flow: null, body: null, priority: null };
}

/** @world's level at p as the client's walk and level dive read it: `level`, unless mediumOf says the point (at most the
 *  surface) is dry: a pocket that keeps @world's water out. No pockets, no change. */
export function worldLevelAt(p, zones, level, { volumes = waterVolumes(zones) } = {}) {
  if (!fin(level)) return null;
  const g = { id: "@world", global: true, priority: -Infinity, water: { level }, top: level };
  const m = mediumOf([p[0], Math.min(p[1], level), p[2]], { bodies: [g, ...(zones?.bodies ?? []).filter((b) => !b.global)], exclusions: zones?.exclusions ?? [] }, { volumes });
  return m.medium === "air" ? null : level;
}

/** What the GPU fog reads (client/lib/watervolumes.js): the highest `maxWater` bodies (slots 1.., slot 0 @world's level), the
 *  last `maxAir` pockets, and each pocket's mask of the slots it clears (bit 0 the level, bit i+1 waters[i]): excludes(). */
export function fogSlots({ waters = [], airs = [] } = {}, { maxWater = MAX_WATER, maxAir = MAX_AIR } = {}) {
  const ws = waters.slice(-maxWater), as = airs.slice(-maxAir);
  const masks = as.map((a) => [AT_WORLD, ...ws].reduce((m, w, i) => (excludes(a, w) ? m | (1 << i) : m), 0));
  return { waters: ws, airs: as, masks };
}

// the components and change kinds a rebuild of the bodies reads (client/lib/watervolumes.js; state.js's events)
const READS = new Set(["zone", "water", "water-exclusion", "physics-area", "disabled"]);
/** Does a world change touch what zonesOf read? `entities`: the view's (state.st.entities); `owners`: the ids that held a body
 *  or an exclusion at the last build (a removed one still counts). */
export function zoneChangeTouches(ev, entities, owners) {
  if (ev?.type === "hydrated" || ev?.type === "reset") return true;
  if (ev?.type === "world") return ev.key === "water";
  if (ev?.type !== "change") return false;
  const { what, comp: name } = ev; if (what === "comp" && !READS.has(name)) return false;
  const id = ev.id; if (owners.has(id)) return true;
  const c = entities?.[id]; if (c && (c.zone || c.water || c["water-exclusion"] || c["physics-area"])) return true;
  for (const v of owners) for (let p = entities?.[v]?.parent?.to, n = 0; p && n < 33; p = entities?.[p]?.parent?.to, n++) if (p === id) return true;   // a carrier above one
  return false;
}

/** The view (view.js viewState) as the fold shape zonesOf reads: each record's transform, parent and components, and @world's water. */
export function foldOfView(view) {
  const entities = {};
  for (const [id, r] of Object.entries(view?.entities ?? {})) {
    const { pos, q, scale, scale3, yaw, parent, born, ...rest } = r;
    entities[id] = { c: { ...rest, transform: { pos: pos ?? [0, 0, 0], q: q ?? [0, 0, 0, 1], scale: scale3 ?? (fin(scale) ? [scale, scale, scale] : [1, 1, 1]) }, ...(parent?.to ? { parent: { to: parent.to } } : {}) } };
  }
  if (view?.water) entities["@world"] = { c: { water: view.water } };
  return { entities };
}

/** The authored look: {gradient (@world.sky.gradient, OMI_environment_sky; bottom absent = horizon) | null, sun | null}. The sun
 *  is the first directional light thing by id (componentspec light): {id, color, intensity, toward (unit, world: its +Z)}. */
export function lookOf(st, sky, { poseOf = (id) => worldPose(st, id) } = {}) {
  const g = sky?.gradient, rgb = (c) => v3(c) && c.every((x) => x >= 0 && x <= 1);
  const gradient = g && rgb(g.top) && rgb(g.horizon) ? { top: [...g.top], horizon: [...g.horizon], bottom: rgb(g.bottom) ? [...g.bottom] : [...g.horizon] } : null;
  let sun = null;
  for (const id of Object.keys(st?.entities ?? {}).sort()) { const L = st.entities[id].c.light;
    if (id === "@world" || L?.kind !== "directional" || offChain(st, id)) continue;
    const sunPose = poseOf(id); if (!sunPose) continue;
    const t = qRotate(sunPose.q ?? [0, 0, 0, 1], [0, 0, 1]);   // it shines along its -Z, so the sun stands along its +Z
    sun = { id, color: Number.isInteger(L.color) ? L.color : 0xffffff, intensity: fin(L.intensity) ? L.intensity : 3, toward: t }; break; }
  return { gradient, sun };
}
/** Does a world change touch lookOf? @world's sky, any light, the sun thing itself (`sunIds`: the last look's), or a reset. */
export function lookChangeTouches(ev, sunIds) {
  if (ev?.type === "hydrated" || ev?.type === "reset") return true;
  if (ev?.type === "world") return ev.key === "sky";
  return ev?.type === "change" && (ev.comp === "light" || ev.comp === "disabled" || ev.what === "born" || sunIds.has(ev.id));
}
