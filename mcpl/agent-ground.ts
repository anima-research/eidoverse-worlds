// The agent's ground: the terrain it replicates, the floors of structures, and the collision meshes of placed things.
// Its public members are the body's (one-line delegates in agent.ts), and it calls them there (this.a.x), as before.

import type { WorldAgent } from "./agent.ts";
import { type Entity, bodyStructure, collisionElsewhere, WORLD_READ_MS } from "./agent-result.ts";
import { shapeParams, shapedHeightAt, requestGrid, setGridFetcher, waterParams } from "../shared/terrainshape.js";
import { flatHeightOf } from "../shared/terrainmath.js";
import { analyzeWater, waterGridSeg } from "../shared/waterkind.js";
import { setHeightField, setWaterField, registerSupport, registerSupportGrid, registerMeshSupport, removeSupport, navProbe, inWorld } from "./physics.ts";
import { NAV_STEP } from "../shared/navgrid.js";
import { collisionTriangles } from "../server/geometry.ts";
import { decideSupportClass, CERT_MAX_WORLD } from "../shared/supportclass.js";
import { lyingFrame } from "../shared/rot.js";
import { isFiniteVec3 } from "../shared/protocol/is.js";
import { cellKey, halfFloored, localizePoint, nodeAtPoint, planStructure, ROUTE_STEP_METRES } from "../shared/structure.js";
import { recordComponents } from "../shared/protocol/view.js";

type CollisionMesh = { positions: Float32Array; indices: Uint32Array; building?: unknown };
/** Collision triangles per (sequencer, lib), shared by every agent in this
 *  process. A lib's bytes are immutable while we run (content-hashed store;
 *  library changes redeploy), so each model decodes once. */
const meshCache = new Map<string, Promise<CollisionMesh | null>>();
/** Each model's own description of itself (its `building` extras), by the same
 *  key, once its bytes have been read — the defaults for its named places. */
const modelMeta = new Map<string, unknown>();
/** Decoded bytes the cache may keep. The colliders fitted from a model hold
 *  its geometry for as long as they stand; this only bounds what is kept for
 *  fits yet to come. Least recently used goes first; downloads in flight stay. */
const MESH_CACHE_BYTES = 256 * 1024 * 1024, MESH_FETCH_MS = 8000;
const meshBytes = new Map<string, number>();
/** Fetch-and-decode jobs at once (process-wide): replay fires one per spawn,
 *  and a world of many models must not download and decode them all at once.
 *  The rest queue; each job's own fetch timeout starts when it runs. */
const MESH_CONCURRENCY = 3;
/** Larger than this, a model is not decoded here: its /geom summary stands in
 *  (source bytes, checked by Content-Length and again on arrival), as does
 *  one decoding to more triangles than MESH_MAX_TRIS. */
const MESH_MAX_BYTES = 48 * 1024 * 1024, MESH_MAX_TRIS = 1_000_000;
/** What the governor is doing, for debugging and tests: jobs running and
 *  queued now, the most ever running at once, and why any model fell back. */
export const meshGovernor = { active: 0, queued: 0, maxActive: 0, fallbacks: new Map<string, string>() };
const meshWaiting: (() => void)[] = [];
/** Tests: forget every decoded model, so the next sync fetches afresh. */
export function forgetMeshCache() { meshCache.clear(); meshBytes.clear(); }
async function meshSlot<T>(job: () => Promise<T>): Promise<T> {
  if (meshGovernor.active >= MESH_CONCURRENCY) {
    meshGovernor.queued++;
    await new Promise<void>((r) => meshWaiting.push(r));   // the slot is handed over, not re-contended
    meshGovernor.queued--;
  } else meshGovernor.active++;
  meshGovernor.maxActive = Math.max(meshGovernor.maxActive, meshGovernor.active);
  try { return await job(); }
  finally {
    const next = meshWaiting.shift();
    if (next) next(); else meshGovernor.active--;
  }
}
function trimMeshCache(key: string, m: CollisionMesh) {
  meshBytes.set(key, m.positions.byteLength + m.indices.byteLength);
  let total = 0;
  for (const b of meshBytes.values()) total += b;
  for (const k of [...meshCache.keys()]) {
    if (total <= MESH_CACHE_BYTES) break;
    if (k === key || !meshBytes.has(k)) continue;
    total -= meshBytes.get(k)!; meshBytes.delete(k); meshCache.delete(k);
  }
}
/** Whether a structure's level has floor at a point in the structure's own
 *  frame: a tile under the point and, on a cell a diagonal cuts, a floor on
 *  the half the point falls in (the other half is a hole). */
export function floorAtLocal(plan: any, lv: any, lx: number, lz: number): boolean {
  const cx = Math.floor(lx / plan.grid.tile), cz = Math.floor(lz / plan.grid.tile);
  if (!lv.level.tiles.has(cellKey(cx, cz))) return false;
  const node = nodeAtPoint(lv.level, plan.grid, lx, lz);
  return !node.includes(":") || halfFloored(lv.level, cx, cz, node.split(":")[1]);
}
/** Fraction of a `/geom` top-surface band's bounding x/z rectangle that is real
 *  up-facing `area`. The rectangle alone would invent floors in sparse things
 *  (a palm canopy, a rubble pile). */
const fillOf = (t: { area: number; x: number[]; z: number[] }) => {
  const rect = (t.x[1] - t.x[0]) * (t.z[1] - t.z[0]);
  return rect > 1e-6 ? t.area / rect : 0;
};
/** Minimum fill before a band may be believed as a floor. Set from a library
 *  survey (docs/research/deck-fill-threshold.md); a real-but-open deck (a
 *  catwalk) is abstained on by design and a body falls to terrain instead. */
const DECK_FILL = 0.45;

export class AgentGround {
  constructor(readonly a: WorldAgent) {}

  terrain: { heightAt(x: number, z: number): number } | null = null;
  private terrainSrc: string | null = null;

  terrainRev = 0;       // build generation: bumped when a terrain request starts
  navTerrainRev = 0;    // committed terrain generation: route grids key on this
  /** A heightmap terrain received but not yet buildable — its grid has not arrived. The last ground stands
   *  (never noise in its place); tick() retries the grid, and the arrival builds THIS bag, once. */
  pendingTerrain: { args: any; rev: number; grid: string } | null = null;
  async buildTerrain(args: any) {
    // Builds can overlap (a grid fetch is slow, a terrain edit is not): only the newest one may commit.
    const rev = ++this.terrainRev;
    if (!this.terrainSrc) {
      const r = await fetch(`${this.a.httpBase}/library/eidoverse/terrain.js`, { signal: AbortSignal.timeout(WORLD_READ_MS) });
      if (!r.ok) throw new Error(`terrain.js: HTTP ${r.status}`);
      const src = await r.text();
      (0, eval)(src);
      this.terrainSrc = src;   // cached only once it ran: a failed load is retried (bot #333 107)
    }
    // Placed features and heightmaps (shared/terrainshape.js): the agent stands on the same shaped law the
    // client's mesh and the sim use. A heightmap's grid is fetched first; until it is here, the last ground
    // stands (pendingTerrain) — never noise in the heightmap's place.
    const shape = shapeParams(args);
    if (shape?.heightmap) {
      const base = this.a.httpBase;
      setGridFetcher(async (ref: string) => {
        const g = await fetch(`${base}/library/${ref}`, { signal: AbortSignal.timeout(WORLD_READ_MS) });
        if (!g.ok) throw new Error(`${g.status}`); return g.json();
      });
      const g = await requestGrid(shape.heightmap.grid);
      if (rev !== this.terrainRev) return;   // a newer terrain arrived while this one's grid was in flight
      if (!g) {
        // not here (yet): keep the ground we have rather than commit noise as this world's ground
        this.pendingTerrain = { args, rev, grid: shape.heightmap.grid };
        return;
      }
    }
    if (rev !== this.terrainRev) return;   // a newer terrain started while this one loaded
    // a body closed while this loaded commits nothing: the height and water fields are the process's, a successor's now
    if (this.a.closed) return;
    this.pendingTerrain = null;
    const flat = flatHeightOf(args);   // a flat terrain is level ground at its height: no mesh to build
    const t = flat !== null ? { heightAt: () => flat } : (globalThis as any).makeTerrain({ ...args, layers: [] });
    this.terrain = shape ? { heightAt: shapedHeightAt(t.heightAt, args) } : t;
    this.navTerrainRev++;       // only committed ground invalidates a route grid
    this.a.water = waterParams(args);
    const waterKey = this.a.water ? JSON.stringify([this.a.water.level, args.size, args.water]) : null;
    if (waterKey !== this.a.waterKey) { this.a.waterKey = waterKey; this.a.endFloat(); }
    if (this.a.water && this.a.statureFor !== this.a.avatar) this.a.measureStature();
    const size = typeof args?.size === "number" ? args.size : 80;
    this.a.waterKinds = this.a.water
      ? analyzeWater((x, z) => this.a.heightAt(x, z), size, { level: this.a.water.level, kind: args.water?.kind, flow: args.water?.flow },
        waterGridSeg(size))   // the browser's grid, so both read the same water
      : null;
    // …and a body that falls in floats on the same water, rising and falling on the same waves
    void setWaterField(this.a.waterFieldNow());
    // the settle sim clamps against the SAME ground the walking clamp reads —
    // not one height sampled at the fall site
    void setHeightField((x, z) => this.a.heightAt(x, z));
  }

  heightAt(x: number, z: number): number {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }
  /** The world's terrain is gone: back on the level floor. A build still on its way commits nothing. */
  dropTerrain() {
    this.terrainRev++; this.pendingTerrain = null;
    if (!this.terrain) return;
    this.terrain = null; this.navTerrainRev++;
    void setHeightField((x, z) => this.a.heightAt(x, z));
  }
  /** This world's @world.bounds as written (the edge flight banks at; shared/flight.js boxOf reads it), else null. */
  worldBox(): unknown { return this.a.replica?.st?.entities?.["@world"]?.c?.bounds ?? null; }

  /** Each structure's plan per entity id, for the revision it holds now: the same object is a hit; else the same
   *  content (JSON) is (view.js clones every component every view); else it is planned afresh. Entity transforms and
   *  each walk's support basis stay outside this cache. */
  plans = new Map<string, { data: object; json: string; plan: ReturnType<typeof planStructure> }>();
  planFor(id: string, data: unknown): ReturnType<typeof planStructure> {
    // Opaque primitive components normalize as empty and are planned afresh each time.
    if (typeof data !== "object" || data === null) return planStructure(data);
    const had = this.plans.get(id);
    if (had?.data === data) return had.plan;
    const json = JSON.stringify(data);
    if (had && had.json === json) { had.data = data; return had.plan; }
    const plan = planStructure(data);
    this.plans.set(id, { data, json, plan });
    return plan;
  }
  /** The plan of whichever known thing holds `data` as its structure (planFor), or an uncached plan. */
  private planOf(data: unknown): ReturnType<typeof planStructure> {
    for (const e of this.a.entities.values()) if ((e as any).structure === data) return this.planFor(e.id, data);
    return planStructure(data);
  }

  /** The upper storey of a griddled building the feet stand on at (x, z), if
   *  any: the structure, the level's index and the floor's world height.
   *  Griddled structures are outside the headless colliders, so this is how
   *  the feet, a walk's support and its routes know such a floor is there.
   *  A floor within NAV_STEP of the terrain, or at/below the base, is the
   *  terrain's; where storeys' ranges meet the highest wins; `yHint` only picks
   *  which real floor qualifies, never the height. The full rule:
   *  docs/research/headless-storeys.md. */
  storeyUnder(x: number, z: number, yHint = this.a.pos.y): { entity: string; level: number; height: number } | null {
    const terrain = this.a.heightAt(x, z), nowMs = this.a.serverNow();
    let best: { entity: string; level: number; height: number } | null = null;
    for (const e of this.a.entities.values()) {
      const data = bodyStructure(e);   // none whose collision is off for bodies
      if (!data) continue;
      try {
        const plan = this.planFor(e.id, data);
        if (!plan.levels.some((lv: any) => lv.base > 0)) continue;
        const fx = this.a.eff(e.id, nowMs);
        if (!fx.ok) continue;
        const sc = fx.scale > 0 ? fx.scale : 1;
        const [lx, ly, lz] = localizePoint({ pos: fx.pos, yaw: fx.yaw, scale: sc }, x, yHint, z);
        for (let i = 0; i < plan.levels.length; i++) {
          const lv: any = plan.levels[i];
          if (!(lv.base > 0) || lv.y - ly > ROUTE_STEP_METRES / sc || ly - lv.y >= plan.grid.wallH || !floorAtLocal(plan, lv, lx, lz)) continue;
          const height = fx.pos[1] + lv.y * sc;
          if (height - terrain > NAV_STEP && (!best || height > best.height)) best = { entity: e.id, level: i, height };
        }
      } catch { /* a malformed house must not cost the body its feet */ }
    }
    return best;
  }

  /** The floors a floor walk tells apart at (x, z): the ground (entity null:
   *  the terrain and every floor within a step of it, as in storeyUnder) and
   *  each griddled storey with a floor at the point. Where the walk's own floor
   *  `own` lies within a step of the terrain (a deck's low end), the ground
   *  there is that floor. */
  floorsAt(x: number, z: number, own: { entity: string; level: number }): { entity: string | null; level: number; height: number }[] {
    type Floor = { entity: string | null; level: number; height: number };
    const terrain = this.a.heightAt(x, z), nowMs = this.a.serverNow();
    const floors: Floor[] = [{ entity: null, level: -1, height: terrain }];
    for (const e of this.a.entities.values()) {
      const data = bodyStructure(e);   // none whose collision is off for bodies
      if (!data) continue;
      try {
        const plan = this.planFor(e.id, data);
        const fx = this.a.eff(e.id, nowMs);
        if (!fx.ok) continue;
        const sc = fx.scale > 0 ? fx.scale : 1;
        const [lx, , lz] = localizePoint({ pos: fx.pos, yaw: fx.yaw, scale: sc }, x, 0, z);
        plan.levels.forEach((lv: any, i: number) => {
          if (!(lv.base > 0) || !floorAtLocal(plan, lv, lx, lz)) return;
          const height = fx.pos[1] + lv.y * sc;
          if (height - terrain > NAV_STEP) floors.push({ entity: e.id, level: i, height });
          else if (own.entity === e.id && own.level === i && terrain - height <= NAV_STEP) floors[0] = { entity: e.id, level: i, height };
        });
      } catch { /* a malformed house costs only itself, as in storeyUnder */ }
    }
    return floors;
  }

  /** Of floorsAt's floors, the one a destination height means, by the navgrid's
   *  rule (shared/navgrid.js, route): nearest y, at most `above` (NAV_STEP
   *  default) above it and, with `below`, at most that below; null if none.
   *  Ties go to the walk's own floor, then the higher. With `body`, y is a
   *  body's root and the floor is the highest that fits (a body lies up to
   *  RAGDOLL_ROOT_DROP above its root). Placed surfaces: placedNear. */
  floorMeant(x: number, z: number, y: number, near: { above?: number; below?: number },
    own: { entity: string; level: number }, body = false): { entity: string | null; level: number; height: number } | null {
    type Floor = { entity: string | null; level: number; height: number };
    const floors = this.floorsAt(x, z, own);
    const fits = (h: number) => h <= y + (near.above ?? NAV_STEP) && (near.below == null || h >= y - near.below);
    const isOwn = (f: Floor) => f.entity === own.entity && f.level === own.level;
    let best: Floor | null = null;
    for (const f of floors) {
      if (!fits(f.height)) continue;
      const d = body ? -f.height : Math.abs(f.height - y), bd = !best ? Infinity : body ? -best.height : Math.abs(best.height - y);
      if (!best || d < bd - 1e-6 || (Math.abs(d - bd) <= 1e-6 && (isOwn(f) && !isOwn(best) || isOwn(f) === isOwn(best) && f.height > best.height))) best = f;
    }
    return best;
  }

  /** Whether something placed on a floor walk's own floor stands at about y at
   *  (x, z): a collider top within `above`/`below` (a step each by default), no
   *  lower than the floor (as onOrAboveFloor) and under `ceiling`, the next floor up. */
  placedNear(x: number, z: number, y: number, near: { above?: number; below?: number }, floor: number, ceiling = Infinity): boolean {
    const probe = navProbe((px, pz) => this.a.heightAt(px, pz));
    if (!probe) return false;
    const top = inWorld(this.a.world, () => probe.surfaceUnder(x, z, Math.min(y + (near.above ?? NAV_STEP), ceiling - 0.02)));
    return top > this.a.heightAt(x, z) + 1e-6 && top >= y - (near.below ?? NAV_STEP) && top >= floor - 0.02;
  }

  /** The height the feet belong at: an upper storey's floor under them
   *  (storeyUnder), else the terrain. Every standing body's ground goes through
   *  here (a walk's is walkSupport's); a flight under way and a tumble's physics
   *  read the terrain alone, since griddled floors aren't headless colliders. */
  groundAt(x: number, z: number, yHint = this.a.pos.y): number {
    return this.storeyUnder(x, z, yHint)?.height ?? this.a.heightAt(x, z);
  }

  // ---- support surfaces -----------------------------------------------------
  // Each entity this agent knows contributes support to the sim's collider map
  // (except one whose collision is off or lives elsewhere: collisionElsewhere):
  // the browser's own collider fitted from the model's triangles when they can
  // be fetched (meshFor → registerMeshSupport), so walls, furniture and stairs
  // are as solid here as in a browser. Fallback, from GET /geom's summary:
  // small things their whole box, room-scale things their floor DECKS as thin
  // slabs (floors, not architecture).

  private geomCache = new Map<string, Promise<any | null>>();
  supportIds = new Map<string, string[]>();
  /** Each awaited fit's own reservation, a token: its bid is no identity, since a later sync of the same thing reuses it. */
  private fits = new Map<string, object>();
  private reserve(id: string, bid: string): object {
    const t = {};
    this.supportIds.set(id, [bid]); this.fits.set(id, t);
    return t;
  }
  /** This agent's claim token on shared support boxes, per INSTANCE: two agents
   *  can share a name across a reconnect, and must not release each other's floors. */
  private readonly supportHolder = `agent#${++AgentGround.holderSeq}`;
  private static holderSeq = 0;
  /** Every support sync in flight (`/geom` is a round trip, so just after a join
   *  floors exist in the log before the sim). supportReady() is the barrier. */
  supportPending = new Set<Promise<void>>();

  /** Resolves once every support sync issued so far has landed. Loops because a
   *  sync can enqueue while we wait; bounded so a hung fetch can't freeze a body. */
  async supportReady(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (this.supportPending.size && Date.now() < deadline) {
      await Promise.race([
        Promise.all([...this.supportPending]),
        new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
  }

  /** Run a support sync and keep it visible to the barrier for its lifetime. */
  trackSupport(p: Promise<void>) {
    this.supportPending.add(p);
    void p.finally(() => this.supportPending.delete(p));
  }

  /** Is anything on this entity animating right now?
   *
   *  A motion component is PARAMETERS, not frames: the browser evaluates a
   *  pendulum/spin/orbit/oscillate/path every frame and its collider rides along.
   *  A support box from the AUTHORED transform would be a ghost floor, which is
   *  worse than no floor. ANY motion, a `motion:<part>` included, disqualifies the
   *  whole entity: /geom measured the model with that part in it, and nothing
   *  here can tell which deck is the moving piece. */
  private hasActiveMotion(e: Entity | undefined): boolean {
    if (!e) return false;
    for (const [k, v] of Object.entries(recordComponents(e))) {
      if (k !== "motion" && !k.startsWith("motion:")) continue;
      if (v && (v as any).type != null) return true;
    }
    return false;
  }

  /** A model's box in its own frame ([[min], [max]]), as the server measures it: the pivot's centre/base snaps. */
  async modelBox(lib: string): Promise<number[][] | null> {
    const g = await this.geomFor(lib); const b = g?.bbox;
    return b && Array.isArray(b.min) && Array.isArray(b.max) ? [b.min, b.max] : null;
  }
  /** A model's own description of itself (its `building` extras, modelMeta), once meshFor has read its bytes. */
  modelMetaOf(lib: string): unknown { return modelMeta.get(`${this.a.httpBase}|${lib}`); }
  /** The model's collision triangles, decoded from the bytes /library serves
   *  (shared by every agent in the process — see meshCache). */
  private meshFor(lib: string): Promise<CollisionMesh | null> {
    const key = `${this.a.httpBase}|${lib}`;
    let p = meshCache.get(key);
    if (p) { meshCache.delete(key); meshCache.set(key, p); return p; }   // most recently used last
    // bounded: a stalled /library must not hold up the /geom fallback, and
    // a failure is forgotten so a later sync tries again
    // governed: a few at a time, none too large (meshSlot, MESH_MAX_*)
    const fallback = (why: string) => { meshGovernor.fallbacks.set(key, why); return null; };
    p = meshSlot(async () => {
      const r = await fetch(`${this.a.httpBase}/library/${lib}`, { signal: AbortSignal.timeout(MESH_FETCH_MS) });
      if (!r.ok) return fallback(`HTTP ${r.status}`);
      const len = Number(r.headers.get("content-length"));
      if (len > MESH_MAX_BYTES) { void r.body?.cancel(); return fallback(`${(len / 1e6).toFixed(0)}MB is over the ${MESH_MAX_BYTES / 1e6 | 0}MB exact-collision limit`); }
      const b = await r.arrayBuffer();
      if (b.byteLength > MESH_MAX_BYTES) return fallback(`${(b.byteLength / 1e6).toFixed(0)}MB is over the ${MESH_MAX_BYTES / 1e6 | 0}MB exact-collision limit`);
      const m = await collisionTriangles(new Uint8Array(b));
      if (!m) return fallback("not a readable GLB with triangles");
      if (m.indices.length / 3 > MESH_MAX_TRIS) return fallback(`${m.indices.length / 3} triangles is over the ${MESH_MAX_TRIS} exact-collision limit`);
      return m;
    })
      .then((m) => { if (!m) meshCache.delete(key); else { meshGovernor.fallbacks.delete(key); trimMeshCache(key, m); if (m.building) modelMeta.set(key, m.building); } return m; })
      .catch((err) => { meshCache.delete(key); fallback(String(err?.name === "TimeoutError" ? "fetch timed out" : err?.message ?? err)); return null; });   // no mesh: the /geom summary path stands in
    meshCache.set(key, p);
    return p;
  }

  private geomFor(lib: string): Promise<any | null> {
    let p = this.geomCache.get(lib);
    if (!p) {
      // no geometry is a soft state, never a crash; a read that threw, timed out or met a 5xx (the server's own trouble)
      // isn't kept, so the next one asks again (a 4xx is kept as no geometry)
      const q: Promise<any | null> = fetch(`${this.a.httpBase}/geom?lib=${encodeURIComponent(lib)}`,
        { signal: AbortSignal.timeout(WORLD_READ_MS) })
        .then((r) => (r.ok ? r.json() : r.status >= 500 ? Promise.reject(new Error(`HTTP ${r.status}`)) : null))
        .then((g) => (g && !g.error && g.bbox ? g : null))
        .catch(() => { if (this.geomCache.get(lib) === q) this.geomCache.delete(lib); return null; });
      this.geomCache.set(lib, p = q);
    }
    return p;
  }

  async syncSupport(id: string) {
    const before = this.a.entities.get(id);
    if (!before?.model) return;  // only a model carries a collider
    // the model's bytes carry its own description too (its places: modelMetaOf), and meshFor is their only reader, so
    // they're read whatever the thing supports; the drops below are issued before this or any other await
    const meshP = this.meshFor(before.model);
    // collision off (collider.enabled), or a structure's anchor: nothing to stand on. A moving thing supports nothing
    // here (drop path as well as skip path); so does mounted cargo, whose parent's transform this code doesn't track.
    if (collisionElsewhere(before) || this.hasActiveMotion(before) || this.a.mounts.has(id)) { this.dropSupport(id); await meshP; return; }
    const [g, mesh] = await Promise.all([this.geomFor(before.model), meshP]);
    // Re-read and re-CHECK: the id may have been removed and respawned as
    // something else while its geometry was in flight (hence the model comparison).
    // (and a body closed meanwhile has dropped its supports: registering now would leave ghosts)
    const e = this.a.entities.get(id);
    if ((!g && !mesh) || !e || e.model !== before.model || this.a.closed) return;
    // started moving, got mounted, or lost its collision / became an anchor while its geometry was in flight —
    // replay folds a mount right behind the spawn that triggered this fetch
    if (this.hasActiveMotion(e) || this.a.mounts.has(id) || collisionElsewhere(e)) { this.dropSupport(id); return; }
    const s = e.scale ?? 1;
    // a stretched thing's per-axis scale (scale3), beside the one number decide() reads, as the browser's applyScale
    const s3 = Array.isArray(e.scale3) && e.scale3.length === 3 && e.scale3.every(Number.isFinite) ? e.scale3 as number[] : [s, s, s];
    // A transform that can't be a place registers NOTHING, and abstains BEFORE
    // the drop, leaving whatever support already stands.
    if (!isFiniteVec3(e.pos) || !Number.isFinite(s) || !Number.isFinite(e.yaw ?? 0)) {
      // If position is readable, the entity has moved and any box at its old
      // address is now a ghost floor. Retaining existing support is correct
      // only when position itself is unreadable and the move did not land.
      if (isFiniteVec3(e.pos)) this.dropSupport(id);
      this.a.noteMalformed("support-sync", { id, pos: e.pos, yaw: e.yaw, scale: e.scale });
      return;
    }
    this.dropSupport(id);
    const xform = { position: e.pos, yaw: e.yaw ?? 0, scale: s, ...(Array.isArray(e.scale3) ? { scale3: s3 } : {}) };
    // A thing lying down (a tumbling engine's rest, or a hand's tilt) registers its box turned into its own frame, with
    // no decks or grid (those are measured upright).
    // A stretch acts on the model's own axes before its rotation: stretched first, then turned, registered at scale 1.
    const stretched = Array.isArray(e.scale3) && !(Math.abs(s3[0]) === Math.abs(s3[1]) && Math.abs(s3[1]) === Math.abs(s3[2]));
    const st = (v: number[]) => stretched ? v.map((x, i) => x * Math.abs(s3[i])) : v;
    const lying = Array.isArray(e.q) && e.q.length === 4 && g?.bbox?.min ? lyingFrame(e.q, st(g.bbox.min), st(g.bbox.max)) : null;
    if (lying) {
      const bid = `${this.a.world}/${id}`;
      void registerSupport(this.supportHolder, bid, lying.min, lying.max,
        stretched ? { position: e.pos, yaw: lying.yaw, scale: 1 } : { ...xform, yaw: lying.yaw });
      this.supportIds.set(id, [bid]);
      return;
    }
    // The real collider when the triangles are to hand: fitted by the same
    // decide() a browser runs, walls and furniture included. Everything below
    // is the summary fallback for a model whose bytes couldn't be read here.
    if (mesh) {
      const bid = `${this.a.world}/${id}`;
      // awaited, unlike the summary boxes: a joining body's feet wait on the fit
      // (supportReady). The id is RESERVED first, so a remove/mount/close during
      // the wait has something to drop, and a fit landing afterwards is taken back out.
      const t = this.reserve(id, bid);
      const ok = await registerMeshSupport(this.supportHolder, bid, mesh, { ...xform, collide: e.collide, model: e.model });
      if (this.overtaken(id, t, e.model)) return;
      if (ok) return;
      this.supportIds.delete(id);
    }
    if (!g) return;
    // its size in the world: a mirrored axis is read as its size, as physics reads it (registerSupport)
    const a3 = s3.map(Math.abs);
    const [w, h, d] = [g.bbox.size[0] * a3[0], g.bbox.size[1] * a3[1], g.bbox.size[2] * a3[2]];
    const ids: string[] = [];
    const roomScale = w * d >= 16 && h >= 2.2;         // decide()'s own gate, from the bbox alone
    const decks = roomScale
      ? (g.topSurfaces ?? [])
          .filter((t: any) => t.area * a3[0] * a3[2] >= 1 && fillOf(t) >= DECK_FILL)
          .slice(0, 6)
      : [];
    if (roomScale && decks.length) {
      for (let k = 0; k < decks.length; k++) {
        const t = decks[k], bid = `${this.a.world}/${id}#${k}`;
        void registerSupport(this.supportHolder, bid, [t.x[0], t.y - 0.15, t.z[0]], [t.x[1], t.y, t.z[1]], xform);
        ids.push(bid);
      }
    } else if (!roomScale) {
      const bid = `${this.a.world}/${id}`;
      // Floor-shaped things whose box top is a KNOWN lie (a blanket, a rubble
      // pile) get heightfield support from the served grid and NEVER the box.
      // Identified from the summary's `lie` by the browser's own classifier; a
      // summary without `lie` accuses nothing.
      const cls = decideSupportClass({ w, d, h, lie: Number.isFinite(g.lie) ? g.lie * a3[1] : 0 });
      if (cls.uneven) {
        // the certification is a MODEL-frame bound; this spawn's scale must not stretch it past the world bound
        // (a grid certified to 3cm serves a ×1.25 spawn but not a ×2)
        const stretched = Number.isFinite(g.topGrid?.certSpread) && g.topGrid.certSpread * a3[1] > CERT_MAX_WORLD;
        const t = this.reserve(id, bid);   // reserved across the await, as the mesh fit is
        const fit = !stretched && await registerSupportGrid(this.supportHolder, bid, g.topGrid, xform);
        if (this.overtaken(id, t, e.model)) return;
        this.supportIds.delete(id);
        if (fit) ids.push(bid);
        // refused grid: a DECLARED abstention (the body finds terrain), never a floating false floor
        else this.a.noteSupportSeam(id, `uneven top (lie ${(g.lie * a3[1]).toFixed(2)}m) without a usable grid${stretched ? ` (certification stretched past ${CERT_MAX_WORLD}m at ×${a3[1]} high)` : ""} — abstaining, no box`);
      } else {
        void registerSupport(this.supportHolder, bid, g.bbox.min, g.bbox.max, xform);
        ids.push(bid);
      }
    }                                                   // room-scale with no readable decks: browser-only, declared
    if (ids.length) this.supportIds.set(id, ids);
  }

  /** After an awaited fit reserved as `t`: did a close, a remove, a mount, a motion or a later sync overtake it?
   *  One that dropped the reservation (a close, a remove, a mount or a later sync: a structure comp is one) took the
   *  fit out itself: its removal was issued after this fit's registration, and each lands at its one `await loadSim()`
   *  in call order. Removing it again here would take out a newer sync's fit under the same bid. */
  private overtaken(id: string, t: object, model: string): boolean {
    if (this.fits.get(id) !== t) return true;
    this.fits.delete(id);
    const now = this.a.entities.get(id);
    if (!this.a.closed && now && now.model === model && !this.a.mounts.has(id) && !this.hasActiveMotion(now)) return false;
    this.dropSupport(id);   // still this fit's reservation, but the thing changed under it: take it back out
    return true;
  }

  dropSupport(id: string) {
    for (const bid of this.supportIds.get(id) ?? []) void removeSupport(this.supportHolder, bid);
    this.supportIds.delete(id); this.fits.delete(id);
  }
}
