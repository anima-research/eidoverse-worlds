// Read-only projection of the canonical fold for non-JavaScript renderers.
// No new log verbs and no duplicate fold. Structures, terrain and motion use
// the same pure evaluators as the browser / headless perception.
import { createHash } from "node:crypto";
import { planStructure } from "../shared/structure.js";
import { terrainParams, makeHeightField } from "../shared/terrainmath.js";
import { waterParams as levelParams, shapeReady, shapeParams } from "../shared/terrainshape.js";
import { analyzeWater } from "../shared/waterkind.js";
import "./heightmap.ts";   // registers the heightmap grid loader the shaped terrain reads
import { effectiveWorldTransform } from "../mcpl/effective.ts";
import { since } from "../client/lib/motioneval.js";
import { effectiveSky, effectiveClock } from "../shared/forecast.js";
import { projectFlora } from "./render-flora.ts";
import { advanceSim, simSnapshot, tickOf } from "../shared/sim.js";
import { waterParams, vector, MAX_AIR } from "../shared/water.js";
import { normalizeParticles, emittersIn } from "../shared/particles.js";
import { normalizePicture } from "../shared/picture.js";
import { normalizeSound } from "../shared/sound.js";
import type { Client, World } from "./world.ts";

export const RENDER_VERSION = 1;
const MAX_ENTITIES = 512, MAX_BYTES = 6 * 1024 * 1024;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
type Cache = { world: World; generation: unknown; at: number; entities: Map<string, string>; environment: string; fast?: boolean };
const clients = new WeakMap<Client, Cache>();
const worlds = new WeakMap<World, { seq: number; entities: any[]; environment: any; signature: string; envSource: string }>();
const failures = new WeakMap<World, { seq: number; detail: string }>();

// The world's one water level (shared/terrainshape.js) and what it fills, analysed on the terrain's own
// vertex grid (shared/waterkind.js): only wet vertices travel, as [index, kind 0 still|1 river|2 ocean,
// flowX, flowZ, waveSpeed, toShoreX, toShoreZ, shore metres]. Depth is the level minus the heights sent.
function projectWater(terrain: any, height: (x: number, z: number) => number, size: number, n: number) {
  const w = levelParams(terrain);
  if (!w) return null;
  const raw = terrain?.water ?? {};
  const a = analyzeWater(height, size, { level: w.level, kind: raw.kind, flow: raw.flow }, n);
  const K: Record<string, number> = { still: 0, river: 1, ocean: 2 };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const cells: number[] = [];
  for (let k = 0; k < a.depth.length; k++) {
    if (!(a.depth[k] > 0) || a.comp[k] < 0) continue;
    const b = a.bodies[a.comp[k]]; if (!b) continue;
    const river = b.kind === "river", ocean = b.kind === "ocean";
    cells.push(k, K[b.kind] ?? 0, river ? r3(a.flow[2 * k]) : 0, river ? r3(a.flow[2 * k + 1]) : 0, river ? r3(b.waveSpeed ?? 0) : 0,
      ocean ? r3(a.toShore[2 * k]) : 0, ocean ? r3(a.toShore[2 * k + 1]) : 0, r3(Math.min(a.shore[k], 999)));
  }
  return { level: w.level, color: w.color, opacity: w.opacity, cells };
}

export function projectEnvironment(state: any) {
  const p = terrainParams(state.terrain ?? { size: 200, amplitude: 0 });
  if (!(p.size > 0 && p.size <= 10000)) throw Error("terrain size unsupported");
  // The shaped ground (placed features, heightmaps) over the base law — what the browser and agents stand on.
  // makeHeightField already applies terrainParams' shape: shaping it again doubled every feature (a −4 m pit
  // projected at −8 m), so native clients got different ground and water than browsers.
  const n = Math.min(128,Math.max(64,Math.round(Number(state.terrain?.segments)||64))), height = makeHeightField(p), heights: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++)
    heights.push(height((x / n - .5) * p.size, (z / n - .5) * p.size));
  const tint=state.terrain?.color??state.terrain?.layers?.[0]?.color??0x70815a;
  const color=typeof tint==='string'?parseInt(tint.replace('#',''),16):tint;
  const layers = Array.isArray(state.terrain?.layers) ? state.terrain.layers.slice(0, 8).map((l: any) => ({
    color: typeof l?.color === "string" ? parseInt(l.color.replace("#", ""), 16) : Number(l?.color ?? 0x70815a),
    repeat: Number.isFinite(l?.repeat) ? l.repeat : 16 })) : [];
  return { terrain: { size: p.size, segments: n, heights, color:Number.isFinite(color)?color:0x70815a, authored: !!state.terrain, layers },
    water: projectWater(state.terrain, height, p.size, n),
    sky: state.sky ?? null, grass: state.grass ?? null, flora: projectFlora(state.grass,height) };
}

// Renderer-facing component parameters (tools/water/README.md). Water is
// normalized by the same law the browser uses; the rest pass through bounded.
const PASS_THROUGH = ["environment", "vehicle", "traversal", "collision"] as const;
export function projectComponentData(comp: any, entityId = "") {
  const data: Record<string, unknown> = {};
  // Presentation components, normalized by the same shared laws the browser uses
  // (a bag that does not normalize renders nothing there either).
  if (comp?.particles) { const r = normalizeParticles(comp.particles, { entityId }); if (r.ok) data.particles = r.emitter; }
  // Named emitters (`particles:<name>`), by name — the same normalization, so
  // a native renderer builds exactly what the browser does (incl. `scale`).
  const named: Record<string, unknown> = {};
  for (const [k, v] of emittersIn(comp)) {
    if (k === "particles") continue;
    const r = normalizeParticles(v, { entityId, key: k });
    if (r.ok) named[k.slice(10)] = r.emitter;
  }
  if (Object.keys(named).length) data.emitters = Object.fromEntries(Object.entries(named).slice(0, 32));
  if (comp?.picture) { const r = normalizePicture(comp.picture); if (r.ok) data.picture = r.picture; }
  if (comp?.sound) { const r = normalizeSound(comp.sound); if (r.ok) data.sound = r.sound; }
  // Named-part motions (motion.js): every motion:<part> key, plus motion with a part.
  // t0 is left as authored; partMotionsFor() resolves a missing t0 per request.
  const parts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(comp ?? {})) {
    if (!v || typeof v !== "object") continue;
    if (k.startsWith("motion:") && k.length > 7) parts[k.slice(7).slice(0, 64)] = v;
    else if (k === "motion" && typeof (v as any).part === "string") parts[(v as any).part.slice(0, 64)] = v;
  }
  if (Object.keys(parts).length) data.parts = Object.fromEntries(Object.entries(parts).slice(0, 32));
  if (comp?.water) { const { center, size, absorption, scatter, speed, waves } = waterParams(comp.water);
    data.water = { center, size, absorption, scatter, speed, waves }; }
  if (Array.isArray(comp?.air?.boxes)) data.air = { boxes: comp.air.boxes.slice(0, MAX_AIR).map((b: any) => {
    const q = Array.isArray(b?.q) && b.q.length === 4 && b.q.every(Number.isFinite) ? b.q : [0, 0, 0, 1];
    return { center: vector(b?.center), size: vector(b?.size, [1, 1, 1]).map(Math.abs), q }; }) };
  for (const k of PASS_THROUGH) if (comp?.[k] && typeof comp[k] === "object") {
    if (JSON.stringify(comp[k]).length > 16384) throw Error(`component ${k} exceeds native budget`);
    data[k] = comp[k];
  }
  return Object.keys(data).length ? data : null;
}

export function projectEntity(id: string, e: any) {
  let structure: any = null;
  if (e.comp?.structure) {
    const plan = planStructure(e.comp.structure);
    structure = { boxes: plan.boxes, parts: plan.levels.flatMap((l: any) => l.parts),
      sweeps: plan.levels.flatMap((l: any) => l.sweeps) };
    if (structure.parts.length + structure.boxes.length > 12000 ||
        structure.sweeps.reduce((n: number, s: any) => n + s.positions.length, 0) > 600000)
      throw Error("structure geometry budget exceeded");
  }
  const out = { id, lib: e.lib ?? "", kind: e.kind ?? "model", structure,
    color: e.color ?? 0xffe0b0, intensity: e.intensity ?? 1, range: e.range ?? 10,
    collide: e.collide ?? "exact", collideAuthored: e.collide ?? null, components: Object.keys(e.comp ?? {}), data: projectComponentData(e.comp, id),
    ...(e.kind === "light" ? { keep: !!e.keep, day: e.day !== false } : {}),
    interact: {actions:Object.keys(e.comp?.reactions??{}).slice(0,32),sockets:e.comp?.sockets??null,
      locked:!!e.comp?.lock, mounted:!!e.parent, moving:!!e.comp?.motion,
      // attribution for the inspector and the guard check (placer.js / build.js mayAuthor)
      guarded:!!e.comp?.guard, placer:e.placer?.id ?? null, placerSub:e.placer?.sub ?? null, lastActor:e.actor ?? null} };
  return { ...out, revision: hash(out) };
}

// Parameters for client-side evaluation, so native renderers animate at frame
// rate from the same closed forms instead of polling sampled transforms.
// A missing t0 is resolved to this process's anchor: every native client then
// agrees with the server's own sampled transform.
export function localMotion(raw: any, nowMs: number, simBody: boolean) {
  const m = raw?.comp?.motion;
  if (raw?.parent || simBody || !m || typeof m.type !== "string" || typeof m.part === "string") return null;
  const t0 = Number.isFinite(m.t0) ? m.t0 : nowMs - since(m, nowMs) * 1000;
  return { base: { pos: raw.pos, yaw: raw.yaw ?? 0 }, m: { ...m, t0 } };
}
/** child world = carrier world ∘ (offset scaled by the carrier, then the mount's yaw); scale multiplies. */
export function composeMount(pt: { pos: number[]; quat: number[]; scale: number }, mount: { offset: number[]; yaw: number }, ownScale = 1) {
  const [qx, qy, qz, qw] = pt.quat, o = mount.offset.map((v: number) => v * (pt.scale ?? 1));
  // rotate o by the carrier's quaternion
  const ix = qw * o[0] + qy * o[2] - qz * o[1], iy = qw * o[1] + qz * o[0] - qx * o[2], iz = qw * o[2] + qx * o[1] - qy * o[0], iw = -qx * o[0] - qy * o[1] - qz * o[2];
  const pos = [pt.pos[0] + ix * qw + iw * -qx + iy * -qz - iz * -qy, pt.pos[1] + iy * qw + iw * -qy + iz * -qx - ix * -qz, pt.pos[2] + iz * qw + iw * -qz + ix * -qy - iy * -qx];
  const h = (mount.yaw ?? 0) / 2, yq = [0, Math.sin(h), 0, Math.cos(h)];
  const quat = [qw * yq[0] + qx * yq[3] + qy * yq[2] - qz * yq[1], qw * yq[1] - qx * yq[2] + qy * yq[3] + qz * yq[0], qw * yq[2] + qx * yq[1] - qy * yq[0] + qz * yq[3], qw * yq[3] - qx * yq[0] - qy * yq[1] - qz * yq[2]];
  return { pos, quat, scale: (pt.scale ?? 1) * ownScale };
}
export function localMount(raw: any, parent: any) {
  const m = raw?.parent;
  if (!m?.to) return null;
  const sock = m.slot ? parent?.comp?.sockets?.[m.slot] : undefined;
  // A socket on a named part: the native renderer rides the part's live transform.
  const part = sock && typeof sock.part === "string" ? { part: sock.part.slice(0, 64) } : {};
  return { to: m.to, offset: m.offset ?? sock?.pos ?? [0, 0, 0], yaw: m.yaw ?? sock?.yaw ?? 0, scale: raw.scale ?? 1, ...(m.slot ? { slot: m.slot } : {}), ...part };
}
// Resolve each part motion's t0 the way localMotion does, so every native client agrees.
export function partMotionsFor(raw: any, nowMs: number) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw?.comp ?? {})) {
    let part: string | null = null;
    if (k.startsWith("motion:") && k.length > 7) part = k.slice(7);
    else if (k === "motion" && typeof (v as any)?.part === "string") part = (v as any).part;
    if (!part || !v || typeof (v as any).type !== "string") continue;
    const m = v as any;
    out[part.slice(0, 64)] = { ...m, t0: Number.isFinite(m.t0) ? m.t0 : nowMs - since(m, nowMs) * 1000 };
  }
  return Object.keys(out).length ? out : null;
}

export function renderScene(c: Client, msg: any, now = Date.now()): object | null {
  const w = c.world;
  if (!w || c.superseded || !w.clients.has(c) || (c.surface ?? "world") !== "world") return null;
  let old = clients.get(c);
  const awake = !!w.sim?.epoch && !w.sim.epoch.foreign && Object.values(w.sim.bodies).some(b => !b.resting);
  if (old && old.world === w && old.generation === c.gen && now - old.at < (awake || old.fast ? 60 : 250)) return null;
  if (!old || old.world !== w || old.generation !== c.gen || msg.reset === true)
    old = { world: w, generation: c.gen, at: 0, entities: new Map(), environment: "" };
  // Rate-limit errors too. Commit delivered revisions only after size checks.
  old.at = now; clients.set(c, old);
  if (msg.version !== RENDER_VERSION) return { type: "render-scene", version: 1, world: w.name, error: "unsupported_version" };
  // A saved heightmap whose grid has not loaded yet would project the noise fallback as the ground, and
  // cache it as success (terrain, water and plant positions all wrong until some unrelated edit). Refuse
  // until it is ready, caching nothing; `moving` keeps native clients polling at their usual interval.
  // (the NORMALIZED shape: a malformed grid ref the height law ignores must not hold the scene forever)
  if (!shapeReady(shapeParams(w.state.terrain ?? {})))
    return { type: "render-scene", version: 1, world: w.name, error: "terrain_pending", moving: true, updateIntervalMs: 300,
      detail: `heightmap grid ${String(w.state.terrain?.heightmap?.grid ?? "").slice(0, 120)} is not available yet` };
  try {
    const jp = w.joinPayload();
    const seq = Math.max(jp.throughSeq, ...jp.tail.slice(-1).map((e: any) => e.seq));
    const failed = failures.get(w);
    if (failed?.seq === seq) return { type: "render-scene", version: 1, world: w.name, error: "projection_failed", detail: failed.detail };
    let cached = worlds.get(w);
    if (!cached || cached.seq !== seq) {
      const entries = Object.entries(w.state.entities);
      if (entries.length > MAX_ENTITIES) throw Error("scene exceeds 512 entities");
      const envSource = hash([w.state.terrain, w.state.sky, w.state.grass]);
      const environment = cached?.envSource === envSource ? cached.environment : projectEnvironment(w.state);
      // Reuse expensive structure projections after transform/chat-only edits.
      const previous = new Map(cached?.entities.map(e => [e.id, e]) ?? []);
      let geometryNumbers = 0, parts = 0;
      const entities = entries.map(([id, e]: [string, any]) => {
        // every field projectEntity reads: a light's keep/day or new attribution must re-project
        const source = hash([e.lib, e.kind, e.comp, e.parent, e.color, e.intensity, e.range, e.collide, e.keep, e.day, e.actor, e.placer]);
        const projected = previous.get(id)?.source === source ? previous.get(id) : { ...projectEntity(id, e), source };
        geometryNumbers += projected.structure?.sweeps.reduce((n: number, s: any) => n + s.positions.length + s.indices.length, 0) ?? 0;
        parts += (projected.structure?.parts.length ?? 0) + (projected.structure?.boxes.length ?? 0);
        if (geometryNumbers > 600000 || parts > 12000) throw Error("total scene geometry budget exceeded");
        return projected;
      });
      cached = { seq, entities, environment, signature: hash(environment), envSource }; worlds.set(w, cached);
    }
    // Evaluate the SAME versioned physics law as the browser, at this render
    // time. Never advance the authoritative sim as a side effect of a read.
    // Snapshot fields alias the sim, so clone before advancing. Foreign epochs
    // retain their barrier poses without pretending to know their physics.
    const sim = w.sim?.epoch ? structuredClone(simSnapshot(w.sim)) : null;
    if (sim && !sim.epoch?.foreign) advanceSim(sim, tickOf(sim, now));
    const activeBodies = sim && !sim.epoch?.foreign ? Object.values(sim.bodies).filter(b => !b.resting).length : 0;
    // The pose each entity is at NOW: a live lease (a piloted vessel) beats the sim beats the fold — resolved
    // through the whole mount chain, so cargo and riders ride where the leased carrier actually is.
    const view = { entity: (id: string) => {
      const e = w.state.entities[id], s = w.leases?.get(id)?.lastState, b = sim?.bodies[id];
      if (e && s && Array.isArray(s.p)) return { ...e, pos: s.p, yaw: s.yaw ?? 0, livePose: { q: s.q }, comp: { ...e.comp, motion: null } };
      return e && b ? { ...e, pos: b.p, yaw: b.yaw, comp: { ...e.comp, motion: null } } : e;
    }, mount: (id: string) => w.state.entities[id]?.parent };
    // Each entity's pose now: the effective transform where it resolves, else (a part socket somewhere up
    // its chain) its carrier's pose composed with the mount — recursively, cycle- and depth-guarded.
    const poses = new Map<string, any>();
    const poseOf = (id: string, depth = 8): any => {
      if (poses.has(id)) return poses.get(id);
      poses.set(id, null);
      let r: any = null;
      const t = effectiveWorldTransform(id, view, now);
      if (t.ok) r = { pos: t.pos, quat: t.quat, scale: t.scale ?? 1 };
      else {
        const raw = w.state.entities[id];
        if (raw?.parent?.to && depth > 0) {
          const pt = poseOf(raw.parent.to, depth - 1), m = localMount(raw, w.state.entities[raw.parent.to]);
          if (pt && m) r = composeMount(pt, m, raw.scale ?? 1);
        }
      }
      poses.set(id, r); return r;
    };
    const transforms: any[] = []; const warnings: string[] = [];
    warnings.push(...cached.environment.flora.warnings);
    const weather=effectiveSky(w.state.sky,now),clock=effectiveClock(w.state.sky,now);
    let moving = !!w.state.sky || activeBodies > 0;
    for (const e of cached.entities) {
      const unsupported = e.components.filter((k: string) => ["flora", "panel", "physics"].includes(k));
      if (unsupported.length) warnings.push(`${e.id}: unsupported native components: ${unsupported.join(", ")}`);
      const lease=w.leases?.get(e.id);
      if(lease?.lastState){const s=lease.lastState;transforms.push({id:e.id,p:s.p,q:s.q??[0,Math.sin((s.yaw??0)/2),0,Math.cos((s.yaw??0)/2)],scale:w.state.entities[e.id].scale??1,leased:true});moving=true;continue;}
      const raw = w.state.entities[e.id];
      const partMotions = partMotionsFor(raw, now);
      const b = sim?.bodies[e.id];
      const simState = b ? { sim: { v: b.v, resting: !!b.resting, on: !!b.on, tickMs: sim?.epoch?.tickMs ?? 66 } } : {};
      const t = effectiveWorldTransform(e.id, view, now);
      if (t.ok) {
        const motion = localMotion(raw, now, !!b);
        const mount = raw?.parent ? localMount(raw, w.state.entities[raw.parent.to]) : null;
        transforms.push({ id: e.id, p: t.pos, q: t.quat, scale: t.scale, ...(motion ? { motion } : {}), ...(mount ? { mount } : {}),
          ...(partMotions ? { parts: partMotions } : {}), ...simState });
        moving ||= !!t.moving || !!partMotions;
      }
      else if (raw?.parent) {
        // Mounted on a part socket — directly, or further down a chain that rides one (a bag on a seat on a
        // swing): no server-side part pose, so send the rest-pose composition and the mount relation;
        // native clients ride the live part and everything mounted below it.
        const pt = poseOf(raw.parent.to), mount = localMount(raw, w.state.entities[raw.parent.to]);
        if (pt && mount) {
          const c = composeMount(pt, mount, raw.scale ?? 1);
          transforms.push({ id: e.id, p: c.pos, q: c.quat, scale: c.scale, mount, ...(partMotions ? { parts: partMotions } : {}) });
          moving = true;
        } else warnings.push(`${e.id}: ${t.why}`);
      }
      else warnings.push(`${e.id}: ${t.why}`);
    }
    const revisions = new Map(cached.entities.map(e => [e.id, e.revision]));
    const response = { type: "render-scene", version: 1, world: w.name, seq, time: now, moving,
      simulation: { enabled: !!sim, foreign: !!sim?.epoch?.foreign, activeBodies },
      updateIntervalMs: activeBodies ? 66 : 300,
      atmosphere:{clock,weather,time:now},
      upserts: cached.entities.filter(e => old!.entities.get(e.id) !== e.revision).map(({ source, ...e }) => e),
      removed: [...old.entities.keys()].filter(id => !revisions.has(id)), transforms,
      ...(old.environment !== cached.signature ? { environment: cached.environment } : {}), warnings };
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_BYTES) throw Error("scene exceeds message budget");
    old.entities = revisions; old.environment = cached.signature; old.fast = activeBodies > 0;
    return response;
  } catch (err) {
    const jp = w.joinPayload();
    const detail = String(err).slice(0, 160);
    failures.set(w, { seq: Math.max(jp.throughSeq, ...jp.tail.slice(-1).map((e: any) => e.seq)), detail });
    return { type: "render-scene", version: 1, world: w.name, error: "projection_failed", detail };
  }
}
