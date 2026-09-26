// Read-only projection of the canonical fold for non-JavaScript renderers.
// No new log verbs and no duplicate fold. Structures, terrain and motion use
// the same pure evaluators as the browser / headless perception.
import { createHash } from "node:crypto";
import { planStructure } from "../shared/structure.js";
import { terrainParams, makeHeightField } from "../shared/terrainmath.js";
import { effectiveWorldTransform } from "../mcpl/effective.ts";
import { effectiveSky, effectiveClock } from "../shared/forecast.js";
import { projectFlora } from "./render-flora.ts";
import { advanceSim, simSnapshot, tickOf } from "../shared/sim.js";
import { waterParams, vector, MAX_AIR } from "../shared/water.js";
import type { Client, World } from "./world.ts";

export const RENDER_VERSION = 1;
const MAX_ENTITIES = 512, MAX_BYTES = 6 * 1024 * 1024;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
type Cache = { world: World; generation: unknown; at: number; entities: Map<string, string>; environment: string; fast?: boolean };
const clients = new WeakMap<Client, Cache>();
const worlds = new WeakMap<World, { seq: number; entities: any[]; environment: any; signature: string; envSource: string }>();
const failures = new WeakMap<World, { seq: number; detail: string }>();

export function projectEnvironment(state: any) {
  const p = terrainParams(state.terrain ?? { size: 200, amplitude: 0 });
  if (!(p.size > 0 && p.size <= 10000)) throw Error("terrain size unsupported");
  const n = Math.min(128,Math.max(64,Math.round(Number(state.terrain?.segments)||64))), height = makeHeightField(p), heights: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++)
    heights.push(height((x / n - .5) * p.size, (z / n - .5) * p.size));
  const tint=state.terrain?.color??state.terrain?.layers?.[0]?.color??0x70815a;
  const color=typeof tint==='string'?parseInt(tint.replace('#',''),16):tint;
  return { terrain: { size: p.size, segments: n, heights, color:Number.isFinite(color)?color:0x70815a },
    sky: state.sky ?? null, grass: state.grass ?? null, flora: projectFlora(state.grass,height) };
}

// Renderer-facing component parameters (tools/water/README.md). Water is
// normalized by the same law the browser uses; the rest pass through bounded.
const PASS_THROUGH = ["environment", "vehicle", "traversal", "collision"] as const;
export function projectComponentData(comp: any) {
  const data: Record<string, unknown> = {};
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
    collide: e.collide ?? "exact", components: Object.keys(e.comp ?? {}), data: projectComponentData(e.comp),
    interact: {actions:Object.keys(e.comp?.reactions??{}).slice(0,32),sockets:e.comp?.sockets??null,
      locked:!!e.comp?.lock, mounted:!!e.parent, moving:!!e.comp?.motion} };
  return { ...out, revision: hash(out) };
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
        const source = hash([e.lib, e.kind, e.comp, e.parent, e.color, e.intensity, e.range, e.collide]);
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
    const view = { entity: (id: string) => {
      const e = w.state.entities[id], b = sim?.bodies[id];
      return e && b ? { ...e, pos: b.p, yaw: b.yaw, comp: { ...e.comp, motion: null } } : e;
    }, mount: (id: string) => w.state.entities[id]?.parent };
    const transforms: any[] = []; const warnings: string[] = [];
    warnings.push(...cached.environment.flora.warnings);
    const weather=effectiveSky(w.state.sky,now),clock=effectiveClock(w.state.sky,now);
    let moving = !!w.state.sky || activeBodies > 0;
    for (const e of cached.entities) {
      const unsupported = e.components.filter((k: string) => ["particles", "flora", "panel", "physics"].includes(k) || k.startsWith("motion:"));
      if (unsupported.length) warnings.push(`${e.id}: unsupported native components: ${unsupported.join(", ")}`);
      const lease=w.leases?.get(e.id);
      if(lease?.lastState){const s=lease.lastState;transforms.push({id:e.id,p:s.p,q:s.q??[0,Math.sin((s.yaw??0)/2),0,Math.cos((s.yaw??0)/2)],scale:w.state.entities[e.id].scale??1,leased:true});moving=true;continue;}
      const t = effectiveWorldTransform(e.id, view, now);
      if (t.ok) { transforms.push({ id: e.id, p: t.pos, q: t.quat, scale: t.scale }); moving ||= !!t.moving; }
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
