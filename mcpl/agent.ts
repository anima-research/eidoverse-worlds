// WorldAgent — a headless world participant: the MCPL's body.
// Owns its avatar exactly like the browser client owns a human's: simulated
// position/yaw/speed ticked at 10Hz, pose intent streamed to the sequencer,
// terrain replicated (Skye's terrain.js eval'd in Bun) so feet agree with
// every renderer. No GPU here — rendering is the retina's job (see server.ts).

import { bodyOf } from "../shared/components.js";
import { CLASSES, KIND_CLASS, REACH_NOTE_MS, namedPointClass, pointClass } from "../shared/protocol/consent.js";
import { kindOf } from "../shared/protocol/kind.js";
import { describeBody, mayLeave, resolveSeat, socketsUnder, vacatedFromMine, vacatedAt } from "../shared/sockbody.js";
import { grabOf, describeGrab } from "../shared/grab.js";
import { r3 } from "../shared/protocol/round.js";
import { BodyStateReader, type BodyObservation, type PublicPose } from "./body-state.ts";
import { mentionRegexFor } from "./mention.ts";
import { mergePose } from "../shared/humanoid.js";
import { shapeParams, shapedHeightAt, requestGrid, setGridFetcher, shapeReady, waterParams } from "../shared/terrainshape.js";
import { flatHeightOf } from "../shared/terrainmath.js";
import { foldOffset } from "../shared/clockoffset.js";
import { bodyHeightFor } from "./rigbones.ts";
import { surfaceOffset, waveClock } from "../shared/waves.js";
import { floatStep, footprintSurface } from "../shared/buoyancy.js";
import { analyzeWater, compass, waterGridSeg } from "../shared/waterkind.js";
import * as THREE_W from "three/webgpu";
import * as TSL from "three/tsl";
import { NoiseGate, SHORT_STINT_MS, APPROACH_REFRACT_MS, APPROACH_RADIUS, REARM_RADIUS,
  APPROACH_DWELL_MS, APPROACH_STILL_MPS, APPROACH_MAX_WAIT_MS,
  ACTIVITY_RADIUS_M, ACTIVITY_PULSE_MS, ACTIVITY_REFRESH_MS, MOVER_MIN_M } from "./denoise.ts";
import { HeadlessBody, ReachBody, setHeightField, setWaterField, registerSupport, registerSupportGrid, registerMeshSupport, removeSupport, standOn, collidersReady, navProbe, collidersGeneration, inWorld, lineOfSight, withoutColliders } from "./physics.ts";
import { makeNavGrid, NAV_SUBSTEP, NAV_NUDGE, NAV_STEP, type NavProbe, type NavTarget } from "./navgrid.ts";
import { placesOf, inRegion, names, destinationOf, toLocal, frameVolume, type Place, type Destination, type PlaceHolder } from "./places.ts";
import { collisionTriangles } from "../server/geometry.ts";
import { colliderOf } from "../shared/components.js";
// FLIGHT. The same deterministic integrator the browser bench and the capture
// path run -- one function, every runtime, per the spec's Q2 ruling.
import {
  makeConfig as flightConfig, initialState as flightState, step as flightStep,
  bodyDown as flightDown, bodyRecovered as flightRecovered, takeOff as flightTakeOff,
  foldDown as flightFold, unfold as flightUnfold,
  bestGlide, glideRange,
} from "../shared/flight.js";
import { MOVER, TRACK, walkToward, toleranceOf, waterStance } from "../shared/mover.js";
import { resolveFlight, worldFlightProvider } from "../shared/flightcap.js";
import { inspectBody } from "../shared/flightbody.js";
import { foldedIn, wingFoldPresence } from "../shared/wingpresence.js";
import { onceAnimOf } from "../shared/onceanim.js";
import { bodyModeTracker, isBodyMode, readBodyMode } from "../shared/bodymode.js";
import { clampBodyScale } from "../shared/presencewire.js";
import { DEFAULT_LEAF_FORCE as LEAF_FORCE } from "../shared/leafforce.js";

/** An act's answer for its tool. `ok` is false when the call didn't do what
 *  it asked: a refusal, a cut, a climb or glide that fell short, a name the
 *  world refused. A call that changed nothing because what it asked for
 *  already held is ok. */
export interface ActResult { ok: boolean; text: string }
const done = (text: string): ActResult => ({ ok: true, text });
const refused = (text: string): ActResult => ({ ok: false, text });
/** A body down: limp wings, in the air (LEAF), on the ground (RAGDOLL) or sitting up (RECOVER). */
const isDown = (phase: string) => phase === "LEAF" || phase === "RAGDOLL" || phase === "RECOVER";
// In the air the limp fall ends when the body reaches the ground (RAGDOLL) or with a recovery
// (shared/flight.js bodyRecovered, which the door sends only in rehearsal); on the ground, take_off
// launches afresh from wherever the body lies (takeOff).
/** Why a body that's down can't fly now, and what gets it flying again. A limp fall whose recovery began
 *  in the air (LEAF with recoverAt set) flies on by itself once it's done, unless it meets the ground
 *  first (shared/flight.js). */
const downRefusal = (f: { phase: string; recoverAt?: number | null }) => f.phase === "LEAF"
  ? f.recoverAt != null
    ? "you're falling limp (leaf) with your recovery under way — you fly again once it's done, unless you reach the ground first"
    : "you're falling limp (leaf) — once you're down on the ground, move {mode: \"fly\"} launches you again"
  : `you're down on the ground (${f.phase.toLowerCase()}) — move {mode: "fly"} to fly again`;
/** How long a flight wait allows for a leg the flight model flies in `legS` seconds of its own time. The tick that
 *  flies it is a timer and runs late under load, so it allows half again, which covers a tick up to 50% late, and
 *  8 s beside for what the leg's rate leaves out, such as a climb's lift easing in. */
const legWaitMs = (legS: number) => Math.round((legS * 1.5 + 8) * 1000);

/** integrator yaw (atan2(dz,dx), forward = (cos,sin)) -> world yaw
 *  (atan2(dx,dz), which every renderer and walkTo already speak). */
const worldYaw = (y: number) => Math.PI / 2 - y;
/** ...and back. The map is its own inverse, but naming both directions is
 *  cheaper than working that out at every call site. */
const intYaw = (y: number) => Math.PI / 2 - y;
import { canonicalLimb, normalizeReachTarget, normalizeReachBag, describeTarget, diffReach,
  TOUCH_GAP, sameReach } from "../shared/reachwire.js";
import { shown } from "../shared/shown.js";
/** reach and clear_reach refuse a limb in the same words. */
const unknownLimb = (raw: unknown, done: string) =>
  `there's no limb called ${shown(raw)}, so nothing was ${done}; limb takes leftHand, rightHand, leftFoot or rightFoot`;
import { decideSupportClass, CERT_MAX_WORLD } from "../client/lib/supportclass.js";
import { lyingFrame } from "../shared/rot.js";
import { isFiniteVec3 } from "./shape.ts";
// The same pure sky fold + weather derivation the browser client and the
// sequencer run — text-tier perception must land on the SAME hour and
// weather every renderer shows (issue #29's shared-fact boundary).
import { foldSkyEntry, describeSky, effectiveSky, effectiveClock, dayPhase, hoursAt } from "../shared/forecast.js";
// the world: this process folds the authority's own stream and reads the VIEW of that fold, like the browser
import { makeReplica } from "../shared/protocol/replica.js";
import { PURGED } from "../shared/protocol/fold.js";
import { diffView } from "../shared/protocol/viewdiff.js";
import { emptyView, idOut } from "../shared/protocol/view.js";
import { hear } from "../shared/chatwindow.js";
import * as OP from "../shared/protocol/requests.js";
// The `particles` component's meaning, shared verbatim with the browser host:
// a renderer client and a resident who perceives by reading must agree about
// what is burning (#25's shared-facts boundary).
import { describeParticles, emitterTransition, transitionLine } from "../shared/particles.js";
import { saysOf } from "../shared/says.js";
import { readOut, openAction } from "../shared/a11y.js";
import { quoted } from "../shared/text.js";
import { lightOf } from "../shared/components.js";
import { describeCaptions } from "../shared/captions.js";
import { cellKey, describeStructure, describeHere, halfFloored, localizePoint, nodeAtPoint, planStructure, prepareRouteLocal, ROUTE_STEP_METRES } from "../shared/structure.js";
import { effectiveWorldTransform, partHint, type Effective } from "./effective.ts";
import { makeVerdictCache, seatGateCore, nameFromAvatarPath } from "../client/lib/seatcore.js";
import { redialer, REDIAL } from "../shared/redial.js";
import { createShover, shoveable, footprint, obbOf, aabbOfObb, contactOf, massOf, budges, SHOVE_FEEL } from "../shared/shove.js";
import { SHOVE } from "../shared/protocol/physconst.js";
import { worldPose, solidOff } from "../shared/protocol/simlayer.js";
import { spawnOf, belowWorld, FELL } from "../shared/spawn.js";
/** A record (components flat, view.js) whose collision is off: componentspec collider.enabled, the authority's own reading. */
const solidOffRecord = (e: any) => solidOff(e);
import { colliderFor } from "../client/lib/bodyscale.js";

import { recordComponents } from "../shared/protocol/view.js";
import { modelWord } from "../shared/eido.js";
import { handleOf, resolveThing } from "../shared/thingref.js";
import { oldFormatWords } from "../shared/oldformat.js";
(globalThis as any).THREE = Object.assign({}, THREE_W, TSL);

/** The body's clock: one stride of shared/mover.js (the one walker: the client's and the authority's too) per tick. */
const TICK_MS = 100;
/** E1: a walk asks the authority for the next stretch (PERMIT_STEP m; its track takes TRACK.cap m at most at once) when the
 *  body is within PERMIT_AHEAD m of the end of what it has accepted, so a run never waits on a local server. */
const PERMIT_STEP = TRACK.cap / 2, PERMIT_AHEAD = 1;
/** A loose thing in the way of a walk (the authority's "solid" naming a shoveable blocker): the walk goes up against it,
 *  the body's contact shoves it, and the walk asks again once it has moved. At most SHOVE_TRIES per walk; a body that
 *  reaches it without shoving it (or is refused) stops as any refused walk does after SHOVE_WAIT_MS. */
const SHOVE_TRIES = 5, SHOVE_WAIT_MS = 2500, SHOVE_SETTLE_MS = 800;
type Blocker = { id: string; ref: any; phase: "approach" | "pushed"; until: number };
type WalkGate = { mode: "sync" | "tracked" | "open"; permit: number[] | null; busy: boolean; blocker?: Blocker | null; shoves?: number; slow?: number; waitUntil?: number; hold?: number; retrackAt?: number };
const STATURE_FALLBACK = MOVER.body.height;   // an ordinary adult (the mover's body), while a body's own height is being read (main #242)
/** Longest horizontal move between two collision checks. A run covers 0.4m in
 *  one 100ms tick; checked only at its end, that leaps a 0.2m wall the walking
 *  capsule (r 0.32) never touched. The planner steps lines at the same scale
 *  (navgrid.ts NAV_SUBSTEP, which says why it is a browser frame's worth). */
const COLLIDE_SUBSTEP = NAV_SUBSTEP;
/** A walk that has made less than this fraction of its intended progress for
 *  STALL_TICKS consecutive ticks is held by something solid: it ends, saying
 *  so, instead of pressing against the wall until the 90s timeout. */
const STALL_PROGRESS = 0.2, STALL_TICKS = 15;
const GRAVITY = 16;
/** How far below its supporting surface a settled ragdoll's root lies. */
const RAGDOLL_ROOT_DROP = 0.7;   // client/lib/controller.js: vy -= 16 * dt
/** Why fold_wings can't judge a body whose bones haven't been read. */
const BONES_NOT_KNOWN = "this body's bones aren't known (its model hasn't loaded, or couldn't be read), so whether it has wings can't be checked";
/** shared/flight.js's refusals (main #245) name the fix as an act — "unfold them first", "land first" — and the browser
 *  has those acts by those names; here they are other tools' presets, so the reply names the call that does it. */
const flightFixInOurTools = (reason: string) => String(reason)
  .replace(/unfold them first/, 'open them first (anim {stop: "wings-folded"})')
  .replace(/land first/, 'land first (act {verb: "land", args: {to}})');
/** Quiet window for world-change narration, per (entity, component). Tuning a
 *  live emitter is a burst of `comp` entries; this is how long they fold into
 *  one line. Long enough to swallow a slider drag, short enough that "puts the
 *  fire out" still arrives while you are looking at it. */
const EMITTER_COALESCE_MS = Number(process.env.EW_EMITTER_COALESCE_SEC ?? 4) * 1000;

type Vec2 = { x: number; z: number };
type CollisionMesh = { positions: Float32Array; indices: Uint32Array; building?: unknown };
/** Collision triangles per (sequencer, lib), for every agent in this process.
 *  A lib's bytes are immutable for its lifetime here (store paths are content
 *  hashes; library models change only on a redeploy, which restarts us), and
 *  the decode is the expensive part — a world full of agents decodes each
 *  model once. */
const meshCache = new Map<string, Promise<CollisionMesh | null>>();
/** Each model's own description of itself (its `building` extras), by the same
 *  key, once its bytes have been read — the defaults for its named places. */
const modelMeta = new Map<string, unknown>();
/** Decoded bytes the cache may keep. The colliders fitted from a model hold
 *  its geometry for as long as they stand; this only bounds what is kept for
 *  fits yet to come. Least recently used goes first; downloads in flight stay. */
const MESH_CACHE_BYTES = 256 * 1024 * 1024, MESH_FETCH_MS = 8000;
/** How long a walk waits for placed geometry still loading before it is
 *  refused (see walkTo). Covers a fetch's own timeout plus some queueing. */
const WALK_READY_MS = 15_000;
/** The world entity (places that belong to no thing live on it), and how far and how many places look lists (owner
 *  22:40/22:43: only what you can see, nearest first; move {to: "?"} lists every one). */
const WORLD_ENTITY = "@world", PLACE_SIGHT_M = 30, PLACE_LOOK_MAX = 12, PLACE_LIST_MAX = 200;
/** A thing with no entrance is walked up to: stopped this far short of its origin (its footprint unknown) / out from its
 *  footprint's nearest point (metres; the body's own, not the thing's). */
const THING_STOP = 0.8, THING_STANDOFF = 0.5;
/** This body's walking capsule: an agent's body is its authored size (no agent sets a scale: occupantScale answers 1 for
 *  it), so its walk resolves with colliderFor(1) (mcpl/physics.ts WALKING), and its shoves and stalls touch with the same. */
const BODY_CAP = colliderFor(1);
const GEOMETRY_LOADING = "things placed nearby are still loading their shape, so a walk now could pass through them — try again in a moment";
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
type Pose = PublicPose;
type Kind = ReturnType<typeof kindOf>;
type Entity = { id: string; model: string; kind: Kind; pos: number[]; yaw: number; actor: string; scale?: number;
  /** a stretched thing's per-axis scale, and a tilted one's whole rotation (the fold keeps both beside scale and yaw) */
  scale3?: number[]; q?: number[];
  /** the spawn's collider override ("exact" | "box"); the browser's decide() reads it, and so does ours */
  collide?: string;
  /** component bag (sockets, reactions, motion, …) — what a thing can DO;
   *  this is how affordances reach text-tier perception */
  comp?: Record<string, any> };
type Person = { id: string; avatar: string; pose: Pose | null; declares?: string | null; observedAt?: number | null; bodyGeneration?: number };

// ---- walking through buildings (#218, Sage; ported onto the one walker 10-15) ----
/** What a walk's feet stand on: the terrain (followed live, tick by tick), or one identified floor of one structure at a
 *  fixed height (the storey-standing work, #200, answers this; on this branch walkSupport answers terrain only). */
type WalkSupport = { kind: "terrain"; height: number } |
  { kind: "floor"; height: number; entity: string; level: number };

/** A known structure as one walk sees it (walkStructures). */
type WalkStructure = {
  id: string;
  route: ReturnType<typeof prepareRouteLocal>;
  /** World x/z to the structure's local metres, and back. */
  local(p: Vec2): [number, number];
  world(lx: number, lz: number): Vec2;
  /** Whether the world leg a→b clears this structure's walls. */
  clear(a: Vec2, b: Vec2): boolean;
};

/** Why walkTo refused a call for its arguments: the move tool's own words (mcpl/tools.ts says the same). */
export const WALK_ARGS_REASON = "move needs a finite destination and a tolerance between 0 and 0.4 metres";

/** Component revisions a walk has skipped as unplannable, so the operator's
 *  log names each once (walkStructures). */
const UNPLANNABLE_LOGGED = new Map<string, string>();   // "<agent>\0<id>" → the revision's JSON last logged

/** Whether a structure's level has floor at a point in the structure's own
 *  frame: a tile under the point and, on a cell a diagonal cuts, a floor on
 *  the half the point falls in (the other half is a hole). */
function floorAtLocal(plan: any, lv: any, lx: number, lz: number): boolean {
  const cx = Math.floor(lx / plan.grid.tile), cz = Math.floor(lz / plan.grid.tile);
  if (!lv.level.tiles.has(cellKey(cx, cz))) return false;
  const node = nodeAtPoint(lv.level, plan.grid, lx, lz);
  return !node.includes(":") || halfFloored(lv.level, cx, cz, node.split(":")[1]);
}

/** A floor walk's navgrid probe, standing nowhere lower than the walk's
 *  floor. The walk's feet go no lower than that floor's height to its end:
 *  its ground is the floor's height (walkHeightAt), and stepFeet stands them
 *  on what's placed above it, never below. So a column whose ground is
 *  lower is no ground at all. Without that, placed tops a step apart could
 *  lead the grid down beside the floor, to the drop walkProbeGround answers
 *  off it or onto a platform below, and route the walk across them with the
 *  feet held at the floor's height, over the air. At or above the floor the
 *  grid stands where the feet do, on what's placed there. `GROUNDED` is
 *  stepFeet's own nearness: feet that near a surface stand on it. */
function onOrAboveFloor(probe: NavProbe, floor: number): NavProbe {
  const GROUNDED = 0.02;
  return {
    surfaceUnder: probe.surfaceUnder,
    stand: (x, y, z) => {
      const s = probe.stand(x, y, z);
      return s.ground >= floor - GROUNDED ? s : { ground: -Infinity, push: s.push };
    },
  };
}

/** How far a body standing in a wall looks for a clear point to step out
 *  to, nearest first, and in how many directions (planWalk). */
const STEP_OUT_METRES = [0.05, 0.1, 0.2, 0.35, 0.5], STEP_OUT_DIRECTIONS = 16;

/** One step point for each side of the wall a body stands in: the middle of
 *  each run of clear points around the circle (`null` where a direction is
 *  blocked). */
function stepSides(ok: (Vec2 | null)[]): Vec2[] {
  const n = ok.length, sides: Vec2[] = [];
  if (ok.every(Boolean)) return [ok[0]!];
  // Start just after a blocked direction, so no run wraps past the start.
  const start = ok.findIndex((p) => !p);
  for (let i = 1; i <= n;) {
    if (!ok[(start + i) % n]) { i++; continue; }
    let len = 0;
    while (i + len <= n && ok[(start + i + len) % n]) len++;
    sides.push(ok[(start + i + Math.floor((len - 1) / 2)) % n]!);
    i += len;
  }
  return sides;
}

/** Presence is a live, lossy plane: a just-joining browser can briefly send a
 * pose shell whose coordinates are null/non-finite before its controller has
 * a real transform. Treat that as "position unknown", never as a reason for
 * the entire text-tier sense to throw. */
function posePosition(pose: Pose | null | undefined): [number, number, number] | null {
  const p = pose?.p;
  if (!Array.isArray(p) || p.length < 3) return null;
  const [x, y, z] = p;
  return typeof x === "number" && Number.isFinite(x)
    && typeof y === "number" && Number.isFinite(y)
    && typeof z === "number" && Number.isFinite(z) ? [x, y, z] : null;
}
/** A point in a body's root frame → world, matching THREE's rotation.y=yaw
 *  (x' = x·cos + z·sin, z' = −x·sin + z·cos) — the same transform every
 *  browser's localToWorld applies to the same descriptor. */
function frameToWorld(p: number[], yaw: number, local: number[]): number[] {
  const c = Math.cos(yaw ?? 0), s = Math.sin(yaw ?? 0);
  return [
    p[0] + local[0] * c + local[2] * s,
    (p[1] ?? 0) + local[1],
    p[2] - local[0] * s + local[2] * c,
  ];
}
type InboxItem = { ts: number; kind: "say" | "arrive" | "leave" | "act"; who: string; text?: string; seq?: number | null };

/** How much of a `/geom` top-surface band is actually SURFACE.
 *
 *  A Surface carries the real up-facing `area` and, separately, the x/z
 *  rectangle that BOUNDS the band. Those are very different claims, and this
 *  is the first consumer to have treated the rectangle as solid extent. A
 *  palm's fronds bound a wide rectangle around almost nothing; a rubble pile
 *  spreads 1.8m² of jagged faces across 404m² of bounding box. Registering
 *  the rectangle invents a floor in the canopy and rests bodies on air. */
const fillOf = (t: { area: number; x: number[]; z: number[] }) => {
  const rect = (t.x[1] - t.x[0]) * (t.z[1] - t.z[0]);
  return rect > 1e-6 ? t.area / rect : 0;
};

/** Minimum fill before a band may be believed as a floor.
 *
 *  From a survey of the shipped library (59 libs, 342 surfaces, 57 that this
 *  code would otherwise register), NOT from taste. The two populations
 *  separate cleanly and the gap is empty: everything sparse lands at or below
 *  0.361 (rubble piles 0.004–0.036 — the worst is 226× overclaim, 1.8m² of
 *  surface in a 404m² rectangle; palm canopy 0.101; excavators and rig
 *  superstructure 0.019–0.31), while every real deck lands at or above 0.532
 *  (perimeter walls 0.53–0.57, tank hull 0.73, wall pillar 0.76, watchtower
 *  decks 0.76 and 0.86, rig top deck 0.83, wall gate 1.00). No surveyed
 *  surface falls between. 0.45 sits in the middle of that empty band, so
 *  library drift in either direction has to travel before it changes an
 *  answer. This is the one line to move if the split needs revisiting.
 *
 *  The cost is deliberate: a real-but-open deck (a catwalk, a grating) is
 *  abstained on and a body falls to terrain instead. That is the honest
 *  pre-#17 answer. The alternative is inventing geometry, and a body resting
 *  in a palm canopy is exactly the bug this PR exists to end. */
const DECK_FILL = 0.45;

// A canned "knocked over" pose for headless agents, which cannot simulate.
/** One bone of a held pose: a rotation, or {q, t, s} (shared/humanoid.js poseChannels). */
type PoseValue = number[] | { q?: number[]; t?: number[]; s?: number[] | number };

const DOWNED_POSE: Record<string, number[]> = {
  spine: [0.6, 0, 0, 0.8], chest: [0.5, 0, 0, 0.87], neck: [0.3, 0, 0, 0.95],
  leftUpperArm: [0, 0, -0.9, 0.44], rightUpperArm: [0, 0, 0.9, 0.44],
  leftUpperLeg: [0.9, 0, 0, 0.44], rightUpperLeg: [0.9, 0, 0, 0.44],
  leftLowerLeg: [-0.7, 0, 0, 0.71], rightLowerLeg: [-0.7, 0, 0, 0.71],
};

/** What a person's voice state means for YOU, in words (owner, 10-02: "something more understandable — their headphones
 *  are off, but they can still receive text"). Read from the live pose (shared/presencewire.js voiceWire, shared with
 *  everyone in the world: docs/pose-wire.md). The headphones gate spoken voice only (people's mics and synthesized
 *  speech, an agent's included); chat text always arrives. Absent = the client didn't say: no claim is made. */
export function voiceNote(pose: unknown): string {
  const v = (pose ?? {}) as { mic?: unknown; hear?: unknown; xr?: unknown };
  const parts: string[] = [];
  if (v.hear === false) parts.push("headphones off: they won't hear anything spoken aloud, yours included, but they still see chat text");
  else if (v.hear === true) parts.push("headphones on: they hear spoken voices");
  if (v.mic === true) parts.push("mic on: they may be talking aloud");
  else if (v.mic === false) parts.push("mic off");
  if (v.xr) parts.push("in VR");
  return parts.length ? `; ${parts.join("; ")}` : "";
}

export class WorldAgent {
  url: string; name: string; displayName: string; world: string; avatar: string; agentToken = "";
  private dropMentionQualifiers: boolean;
  /** The status this body declares at join (PROTOCOL §6a): "agent" unless told otherwise (AGENT_DECLARES; "" declares
   *  nothing). The harness chooses it; the server relays it and never sets it from the credential. */
  declares: string | null = "agent";
  ws: WebSocket | null = null;
  joined = false;
  pos = { x: 0, y: 0, z: 0 };
  yaw = 0; speed = 0; clip = "idle";
  private target: (Vec2 & { run: boolean; tolerance?: number; y?: number }) | null = null;
  /** Remaining validated centerline waypoints (walkTo). Only the destination uses
   * the caller's tolerance; intermediate waypoints are reached exactly. */
  /** …each with the floor height the route stands on there, when the navgrid planned it (the authority is asked for
   *  stretches at that height: up a stair, the stretch's end is on the stair, not the floor beneath it) */
  private legs: (Vec2 & { y?: number })[] = [];
  private walkTolerance: number = MOVER.arrive.tolerance;
  /** The height the walk under way stands at, wherever it is: the live terrain for a terrain walk, the admitted floor
   *  for a floor walk. Null when no walk is under way. */
  private walkHeightAt: ((x: number, z: number) => number) | null = null;
  /** Why the last walkTo() call was refused, or null when it was accepted:
   * its arguments, or no route. Planning is synchronous; a caller can capture
   * this immediately after walkTo() so a later replacement walk cannot change
   * its refusal receipt. */
  walkRefusal: string | null = null;
  /** This body's standing height (rigbones.ts bodyHeightFor) — what water depth is measured against. */
  bodyH: number | null = null;
  /** Which avatar `bodyH` is (being) measured for, and the measurement's generation: a body swap starts a
   *  new one, and a reply for an older body is dropped — the stature always belongs to the CURRENT body. */
  private statureFor: string | null = null;
  private statureGen = 0;
  /** What `water` was when the float state last made sense: a change of water (drained, refilled, a new
   *  level) ends the float, so no position or velocity crosses from one water to the next. */
  private waterKey: string | null = null;
  /** A swimming body's buoyant column (shared/buoyancy.js) — on the same swell everyone's water draws. */
  private float = { on: false, y: 0, vy: 0 };
  /** Why the last walk stopped short, when something stopped it mid-way. */
  walkStopReason: string | null = null;
  /** The world's water (shared/terrainshape.js), from the terrain bag; null when it has none. */
  water: { level: number } | null = null;
  /** What kind of water lies where (shared/waterkind.js) — the same reading the renderers draw from. */
  private waterKinds: ReturnType<typeof analyzeWater> | null = null;
  /** A held custom pose — sparse humanoid-bone quaternions. Presence only:
   *  it rides the pose packet and is never a log verb, because it is a moment,
   *  not a change to the world. `null` clears. */
  heldPose: Record<string, PoseValue> | null = null;
  /** Where heldPose came from. An AUTHORED pose (set deliberately — the pose
   *  tool, a puppet, the server's settled memory) is a place: it survives
   *  walking, posture changes and sleep. A PHYSICS pose (ragdoll sim frame,
   *  drag stream, knockdown slump) is a moment: it may only ever leave this
   *  process under the "ragdoll" clip, and any decision to move sheds it.
   *  Without this line the two were indistinguishable — one settled tumble
   *  frame got relabelled "idle", slipped every clip-keyed sanitizer, and
   *  haunted princess across sessions and joiners for weeks (#61). */
  heldPoseAuthored = false;

  /** The height of the feet when this body was last knocked over standing
   *  (knockDown). A canned slump, held before any sim has run or with no sim
   *  to run, keeps its root at that height: the fallback with no body to
   *  simulate shoves it along, and nothing lifts or lowers it until a sim's
   *  frame or a dragging hand puts it where physics lays it. So a slumped
   *  body whose root is still at this height is a canned slump (rootCanned),
   *  and any other has its feet RAGDOLL_ROOT_DROP above its root (feetY). */
  private cannedY: number | null = null;

  /** The exact pose object that was granted "hold this while I walk".
   *
   *  Stored as the OBJECT, not a boolean, and compared by identity — so any
   *  other writer of `heldPose` (a tumble frame, a puppet, a drag sample, a
   *  restore) revokes stickiness for free by simply assigning a different
   *  object. A parallel boolean would have to be cleared at all nine of those
   *  sites, and the one that got missed would be a pose that outlived every
   *  walk forever. This cannot be missed: it is the same identity trick the
   *  renderer's `_composeBegin` and the interpolator's `lastPose` both use. */
  private heldPoseSticky: Record<string, PoseValue> | null = null;
  draggedBy: string | null = null;   // whose takeover sim drives this body (bodydrag)
  dragAt = 0;                        // last drag sample, for the silence timeout
  pins = new Map<string, number[]>(); // persistent bodydrag nails: joint -> [x,y,z]
  body: HeadlessBody | null | undefined = undefined; // the REAL ragdoll (undefined = not tried yet)
  private simTicker: ReturnType<typeof setInterval> | null = null;
  private walkDone: ((arrived: boolean) => void) | null = null;
  // ---- the authority's track of this body (E1, tools audit 10-07: "two bodies") ----
  // The authority keeps its own body for every actor (authority.js EMBODIED_VERBS.move: 6 m/s, 4 m at most in one go, not
  // through what it calls solid) and every hand verb measures from it. A person's client streams `move` steps to it
  // (client/lib/thingphysics.js track); this body walks the same way: it asks the authority for each stretch BEFORE it
  // walks it, so a wall the authority refuses stops this body exactly where the authority's stops.
  /** the authority knows this body (its arrival was accepted); every snapshot forgets it (leaving drops the track) */
  private trackArrived = false;
  /** where the authority last accepted this body, [x, y, z] */
  private trackAt: number[] | null = null;
  /** the current walk's gate: 'sync' = waiting for the authority to know where we stand; 'tracked' = walk only as far as it
   *  has accepted (permit); 'open' = this authority keeps no body track (an older server): walk as before */
  private walkGate: WalkGate | null = null;
  /** why the last walk stopped short, in the authority's words (the move tool reports it); a note it should mention */
  lastWalkRefusal: { code: string; reason: string; fix?: string } | null = null;
  lastWalkNote: string | null = null;
  /** The VIEW of this body's own fold of the world (shared/protocol/view.js viewState over shared/protocol/replica.js), plus the
   *  chat window. The maps below are DERIVED VIEWS reconciled from it after every change; side effects (percepts,
   *  supports, pings) run in a separate pass that never touches it. */
  private st: any = emptyView();
  /** Things the world's physics has brought to rest, so a rest re-registers their support once (see tick). */
  private simRested = new Set<string>();
  private simFlying = new Set<string>();
  /** body shove (shared/shove.js): this body's walk pushes loose things it walks into, through the same punt a person's client sends */
  private shover = createShover();
  /** off for the session when this server doesn't know shove (an older deployment answers unknown-arg) */
  private shoveOff = false;
  /** who holds what, as the authority's presence plane broadcasts it (a held thing, and what rides it, isn't shoved) */
  private holdsNow: Record<string, any> = {};
  /** a shove gave a thing this body's momentum: for a moment it walks at most what it kept (shared/shove.js keptOf) */
  private walkCap: { v: number; until: number } | null = null;
  entities = new Map<string, Entity>();
  /** who/what occupies what: mount verbs, keyed by the occupant (body or thing) */
  /** Every mount's full wire shape — offset/yaw OVERRIDE socket defaults in
   *  the world transform (#82), so dropping them here made the composed
   *  position disagree with every renderer. */
  mounts = new Map<string, { to: string; offset?: number[]; yaw?: number; q?: number[] }>();
  /** Bodies' seats are PRESENCE (bodies aren't entities, nothing is logged): a body's pose frame carries
   *  `seat: {to: <socket id>}` while it sits (an older client's {to: host, slot} is read as that host's socket of that
   *  name: resolveSeat). Others' come from their frames; mine rides my frames. */
  bodySeats = new Map<string, { to: string }>();
  myOccupancy: { to: string; pose?: string; at?: number } | null = null;
  /** A host's sockets: its socket children (PLAN-sockets-entities), [{id, name, sock}] in child order — the one reader
   *  look, attach and the seat lines share. */
  socketsOf(host: string) {
    // the same records the composition reads (entities, and mounts: a thing's fold parent)
    const kids = (h: string) => [...this.mounts.entries()].filter(([k, m]) => m.to === h && this.entities.has(k)).map(([k]) => k).sort();
    return socketsUnder(host, kids, (k) => { const e = this.entities.get(k); return e ? recordComponents(e) : null; });
  }
  /** A socket child as the occupy family reads it: {id, host, name, sock, station}, or null when `id` isn't a socket here. */
  socketRec(id: string | null | undefined) {
    const sock = id == null ? null : this.entities.get(id)?.socket;
    const station = id == null ? null : this.entities.get(id)?.station;
    return sock && typeof sock === "object" ? { id: String(id), host: this.mounts.get(String(id))?.to ?? null, name: String(sock.name ?? ""), sock, station: station && typeof station === "object" ? station : null } : null;
  }
  /** "host (name)" for a socket — how anyone reads where someone is occupying; the bare id for anything else. */
  socketName(id: string) { const s = this.socketRec(id); return s ? `${s.host ? this.refName(String(s.host)) : s.host} (${s.name})` : this.entities.has(id) ? this.refName(id) : id; }   // by its name (R 10-17)
  /** A thing's short handle here (R 10-17, shared/thingref.js): the shortest unique id prefix of 4+, derived fresh. */
  handle(id: string): string { return handleOf(id, this.entities.keys()); }
  /** What a reader calls a thing in a sentence or a "thing/place" ref: its label when that names it alone, else its handle. */
  refName(id: string): string { const l = (this.entities.get(id) as any)?.label; if (typeof l === "string" && l.trim() && !/[/\[\]"]/.test(l)) { const r = this.thingRef(l); if ("id" in r && r.id === id) return l.trim(); } return this.handle(id); }
  /** How a thing reads in a list of candidates: its label, what it is, where it is, its handle. */
  thingLine(id: string): string {
    const e: any = this.entities.get(id); if (!e) return `[${this.handle(id)}]`;
    const what = e.model ? modelWord(e.model).split("_").slice(0, 5).join(" ") : e.kind === "socket" ? "a socket" : "(empty)";
    const up = this.mounts.get(id)?.to; const f = this.eff(id, Date.now());
    const where = up && this.entities.has(up) ? `on ${(this.entities.get(up) as any)?.label ?? `[${this.handle(up)}]`}` : f.ok ? `at (${f.pos[0].toFixed(1)}, ${f.pos[1].toFixed(1)}, ${f.pos[2].toFixed(1)})` : "where unknown";
    return `${typeof e.label === "string" && e.label ? `"${e.label}" ` : ""}${what} ${where} [${this.handle(id)}]`;
  }
  /** A thing by what an agent calls it (R 10-17 ID HARDENING (5)): its id, its label, or a unique id prefix (4+, git-style).
   *  Several matching is refused with the candidates (label, what, where, handle), never resolved by picking one. A
   *  placeholder ('$x'), @world, a blueprint hash or a person's identity is not a thing name: it passes as it is.
   *  {id} | {refusal} | {none} (nothing here is called that: a caller may try a place or a person next). */
  thingRef(raw: string): { id: string } | { refusal: string } | { none: true } {
    const q = String(raw ?? "").trim();
    if (!q || q.startsWith("$") || q.startsWith("@") || q.startsWith("sha256:") || /^u-[a-z2-7]{20}$/.test(q)) return q ? { id: q } : { none: true };
    const r = resolveThing(q, [...this.entities.values()] as any[]);
    if ("id" in r) return { id: r.id };
    if ("ambiguous" in r) {
      const c = r.ambiguous.slice(0, 8).map((t: any) => this.thingLine(t.id));
      return { refusal: `"${q}" ${r.by === "label" ? "is the label of" : "starts the id of"} ${r.ambiguous.length} things — say which (its handle works): ${c.join("; ")}${r.ambiguous.length > 8 ? `; and ${r.ambiguous.length - 8} more` : ""}` };
    }
    return { none: true };
  }
  /** The body block of the station I occupy (shared/sockbody.js), or null standing. */
  occupiedBody() { const m = this.myOccupancy; return m ? bodyOf(this.socketRec(m.to)?.station) : null; }
  /** May I vacate this way? (its leaveBy: a 'script' station lets go only when the world does, or by the escape) */
  mayVacate(kind: "move" | "jump" | "menu" | "script" | "escape") { const b: any = this.occupiedBody(); return !b || mayLeave(b, kind) || !this.socketRec(this.myOccupancy!.to); }
  /** The authority's body inbox (PROTOCOL L6), pushed by the server as it fills: an ask waiting for ME (someone's act met
   *  an `ask` cell of my table; 20 s, silence is no) is said with how to answer it through `act`; the replies to my own asks,
   *  acts delivered to my body, revocations and being let go from what I occupy (`vacated`) are said in the authority's words. */
  bodyInbox(messages: any) {
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m !== "object") continue;
      const ts = Date.now(); let text: string | null = null;
      if (m.type === "body-ask" && m.ask) { const a = m.ask; const left = typeof a.expires === "number" ? Math.max(1, Math.round((a.expires - ts) / 1000)) : 20;
        text = `${a.summary ?? `${a.from} asks to ${a.kind}`}${a.why ? ` — "${a.why}"` : ""} (consent class ${a.cls ?? KIND_CLASS[a.kind] ?? a.kind}; about ${left} s to answer, silence is no): act {verb: "consent", args: {answer: ${JSON.stringify(a.id)}, yes: true}} allows it this once, yes: false refuses`; }
      else if (m.type === "body-reply") text = m.ok ? `your ask ${m.ask} was allowed${m.applied ? " and done" : ""}` : `your ask ${m.ask} was refused: ${m.why ?? "no"}`;
      // what the authority did: it let the act reach this body, and recorded it
      else if (m.type === "body") text = `the world let ${m.from}'s ${m.kind}${m.spec?.point ? ` (${m.spec.point})` : ""} reach your body (consent: ${m.consent})`;
      else if (m.type === "vacated") {   // review r9 M3: an edit by someone else moved the seat I sat on, and the authority let me go
        if (vacatedFromMine(m, this.myOccupancy)) { const on = this.socketName(m.socket); this.setOccupant(null);
          // stand where the authority let me go (its track of my body starts again there, r9 M2)
          const at = vacatedAt(m); if (at) { this.pos.x = at[0]; this.pos.y = at[1]; this.pos.z = at[2]; }
          text = `${typeof m.by === "string" ? this.nameOfActor(m.by) ?? m.by : "someone"} moved ${on}, the seat you were on, so you are standing where it was${typeof m.why === "string" ? ` (${m.why})` : ""}`; } }
      else if (m.type === "body-revoked") text = `${m.by} withdrew consent for ${m.class}: what you were doing to their body has ended`;
      else if (m.type === "reach-refused") {   // the relay took a hand of mine out of my pose: nobody saw it (server/reachgate.ts)
        const to = String(m.to ?? ""), who = this.nameOfActor(to) ?? to;
        this.reachRefusals.push({ to, cls: String(m.class ?? "touch"), why: String(m.why ?? "their consent refused it"), ...(m.fix ? { fix: String(m.fix) } : {}), ...(typeof m.limb === "string" ? { limb: m.limb } : {}), ts });
        if (this.reachRefusals.length > 20) this.reachRefusals.shift();
        const dropped = this.dropReachesAt(to, typeof m.limb === "string" ? m.limb : undefined, String(m.class ?? "touch"));
        text = `your hand toward ${who}${m.point ? `'s ${m.point}` : ""} was not shown to anyone (consent class ${m.class}): ${m.why}${m.fix ? ` — ${m.fix}` : ""}${dropped.length ? `. Withdrawn: ${dropped.join(", ")}` : ""}`; }
      if (text) { this.inbox.push({ ts, kind: "act", who: m.type === "body-ask" ? String(m.ask?.from ?? "world") : String(m.from ?? m.by ?? "world"), text }); this.onEvent?.({ ts, kind: "act", who: String(m.ask?.from ?? m.from ?? m.by ?? "world"), text, mention: m.type === "body-ask" }); }
    }
  }
  /** sit on a thing's seat socket (presence: my frames carry {to: <socket id>}), or stand (null) */
  setOccupant(seat: { to: string; pose?: string; at?: number } | null) {
    this.myOccupancy = seat;
    if (seat) this.mounts.set(this.name, { ...seat }); else this.mounts.delete(this.name);
  }
  people = new Map<string, Person>();
  inbox: InboxItem[] = [];
  private inboxCursor = 0;
  /** Highest world-log seq whose `say` already sits in the inbox. A mid-life
   *  reconnect replays the same snapshot tail — without this guard every
   *  server restart re-appended history and the next look() dumped chat the
   *  agent had already seen. */
  private inboxSeen = -Infinity;
  pings: { ts: number; kind: "mention" | "approach" | "depart" | "reach" | "touch"; who: string; text?: string }[] = [];
  onPing: ((p: { ts: number; kind: string; who: string; text?: string }) => void) | null = null;
  /** live world events (say/arrive/leave/activity) — the channel fan-out hook */
  onEvent: ((ev: { ts: number; kind: "say" | "arrive" | "leave" | "act" | "activity" | "weather" | "world-change"; who: string; text?: string; mention?: boolean }) => void) | null = null;
  /** MEDIA seam (#104 / #57): the SFU's publish path is gated to the EMBODIED
   *  PRIMARY (`relay-cred is the embodied primary's ask`, server.ts) — and for
   *  an agent, the primary IS this server. So an agent with a local synthesizer
   *  could not publish at all: its sidecar has the audio and no credential, the
   *  door has the credential and no audio.
   *
   *  Same shape as #100's fix, one layer out: rather than forcing the agent onto
   *  a raw world-ws side connection (which is what my media-peer was, and it
   *  landed on the MESH while everyone else was on the SFU), the authority forwards
   *  the media-signalling frames it is the only one authorized to carry. The
   *  door NEVER synthesizes, encodes, or holds a peer connection — it relays
   *  four message types and stays a text-tier participant.
   *
   *  Frames out (server→sidecar): relay-cred · sfu-offer · sfu-ice · sfu-route
   *  Frames in  (sidecar→server): sfu-answer · sfu-ice · sfu-want-negotiate
   *  Nothing else is forwarded in either direction — a whitelist, not a pipe,
   *  for exactly #100's reason: server-side validation stays the one authority. */
  onMedia: ((frame: Record<string, unknown>) => void) | null = null;
  /** Our own recent says (seq → text) and our surface generation, both needed
   *  to mint a performance receipt on a sidecar's behalf. */
  ownSays = new Map<number, string>();
  surfaceGen: number | null = null;

  /** The performance receipt (#57 B1 / PR #103). Sent by the DOOR, never by the
   *  sidecar: attest is identity-bearing and generation-stamped, and a loopback
   *  peer able to mint one could suppress every listener's TTS fallback for
   *  audio it never aired. The digest is over the WORLD's copy of the text. */
  async attestSay(seq: number): Promise<boolean> {
    const text = this.ownSays.get(seq);
    if (text == null || this.ws?.readyState !== 1) return false;
    const digest = Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    this.ws.send(JSON.stringify({ type: "attest", seq, digest, gen: this.surfaceGen }));
    return true;
  }
  /** Open coalescing windows for world-change narration, keyed by entity id.
   *  See noteEmitter. */
  private emitterNarration = new Map<string, { announced: unknown; latest: unknown; actor: string; timer: ReturnType<typeof setTimeout> }>();
  private lastNear = new Map<string, number>(); // participant -> last approach-ping ts
  /** approach re-arm: after a walk-up ping, the SAME person must actually go
   *  away (> REARM_RADIUS) before another boundary crossing can ever count —
   *  someone pacing at 2–3m otherwise re-triggers on every crossing. */
  private nearArmed = new Map<string, boolean>();
  /** An inward crossing that has NOT yet earned its ping. `since` is when they
   *  crossed into arm's reach, `stillSince` when they were last observed
   *  moving faster than APPROACH_STILL_MPS, and `at`/`atTs` the previous
   *  sample, so the next one yields an observed speed. Cleared the moment they
   *  leave the radius — that clearing IS the pass-through fix. */
  private approachPending = new Map<string, { since: number; stillSince: number; at: [number, number]; atTs: number }>();
  /** Someone whose approach was DELIVERED and whose departure therefore still
   *  owes a ping. Gating "walked away" on this is what stops the fix at the
   *  top of the radius being undone at the bottom: a passer-by never earned an
   *  approach, so their leaving is not a departure — it is just traffic.
   *
   *  The value is OUR OWN (x,z) at the moment the approach fired — the
   *  vantage the walk-up was true from. The radius is relative, so "they
   *  crossed the re-arm edge" alone cannot say who moved; measuring the
   *  departing body against this anchor can: past REARM_RADIUS from where we
   *  STOOD, their own movement accounts for the exit and the wire may say
   *  "walked away". Anything less means we carried some (or all) of the
   *  separation ourselves, and the wire only claims the relation ended. */
  private approachOpen = new Map<string, [number, number]>();
  /** participant -> when their current non-locomotion stint began (jump, sit…) */
  private nonLocoSince = new Map<string, number>();
  /** My live reach descriptors, one entry per limb (shared/reachwire.js).
   *  They travel on every presence packet; every receiver re-solves the relation
   *  against its own scene. The `reached` flag is MY solver's attestation,
   *  kept honest by reachTick(). */
  reaches = new Map<string, { t: any; palm?: false; reached?: true }>();
  private reachBodies = new Map<string, ReachBody | null>();               // avatar path -> solver body
  private reachBodyLoads = new Map<string, Promise<ReachBody | null>>();
  private reachTicks = 0;
  private reachReading: any = null;
  private reachReadingEpoch = 0;
  private reachReadingBusy = false;
  private clipClockName = "";
  private clipClockStarted = 0;
  private bodyClip() {
    const mount = this.mounts.get(this.name);
    return mount ? bodyOf(this.socketRec(mount.to)?.station)?.clip ?? "sitchair" : this.clip;
  }
  private noteClipClock() {
    const slot = this.bodyClip();
    if (this.clipClockName !== slot) { this.clipClockName = slot; this.clipClockStarted = Date.now(); }
  }
  private clipPhase() { return this.clipClockName === this.bodyClip() ? Math.max(0, (Date.now() - this.clipClockStarted) / 1000) : 0; }
  private async refreshReachReading() {
    const epoch = ++this.reachReadingEpoch;
    const reading = await this.bodyState(this.name, "all");
    if (epoch === this.reachReadingEpoch) this.reachReading = reading;
  }

  private bodyReader: BodyStateReader | null = null;
  private bodyGenerationCounter = 0;
  private selfBodyGeneration = 0;
  private selfObservedAt: number | null = null;

  /** reach/touch ping refractory, keyed "kind:who:limb" — a hand trembling
   *  across the touch threshold must not knock twice. */
  private lastReachPing = new Map<string, number>();
  /** Local-awareness accumulator, reset every pulse. Records what happened
   *  within ACTIVITY_RADIUS_M since the last pulse — RAW where rawness is
   *  truth (movement, says: jump spam is genuine liveliness even when its
   *  narration is denoised) but DENOISED for arrivals/departures (a reconnect
   *  flap is not activity, it is weather). */
  private act30 = { says: new Map<string, number>(), moved: new Map<string, number>(), acts: 0, arrivals: 0, departures: 0, builds: 0 };
  /** The last EMITTED pulse — novelty gate state. `sig` fingerprints the
   *  ambient scenery (roster + movers + acts); `roster` lets an unchanged
   *  cast be compacted to a count instead of ten names, every time. */
  private lastPulse = { sig: "", roster: "", at: 0 };
  // Seat-profile verdicts (#101): the same server-judged values /avatars
  // hands the browser, fetched over httpBase at join and on the two update
  // events. The cache — epochs, pending demotion, event-rev floors — is
  // seatcore.makeVerdictCache, the SAME implementation the browser runs
  // (#105 review B1: the logic existed twice and each copy had the same
  // holes). effective.ts reads these through the view — never a rederived
  // hash, never a quiet default.
  private seatCache = makeVerdictCache(async () => {
    const res = await fetch(`${this.httpBase}/avatars`);
    if (!res.ok) throw new Error(`roster ${res.status}`);
    const rev = Number(res.headers.get("x-profiles-rev") ?? NaN);
    return { rev, entries: await res.json() as { name: string; seat?: any }[] };
  });
  /** Stateful denoiser for ambient narration (arrive/leave/acts). Says and
   *  mentions never pass through it — a knock is not chatter.
   *  See denoise.ts for the doctrine. */
  private gate = new NoiseGate((ev) => {
    if (ev.kind === "arrive") this.act30.arrivals++;
    else if (ev.kind === "leave") this.act30.departures++;
    this.inbox.push({ ts: ev.ts, kind: ev.kind, who: ev.who, ...(ev.text != null ? { text: ev.text } : {}) });
    this.onEvent?.(ev);
  });
  /** The activity sense is the agent's own to tune (persisted per-agent by
   *  the authority; see net-server's `activity` tool). Instance values start at
   *  the world defaults. */
  activityRadiusM = ACTIVITY_RADIUS_M;
  private activityPulseMs = ACTIVITY_PULSE_MS;
  /** The pulse ticks from birth; it only ever SPEAKS when the accumulator has
   *  something in it, so an empty room costs nothing. */
  private activityTimer: ReturnType<typeof setInterval> | null =
    setInterval(() => this.activityPulse(), ACTIVITY_PULSE_MS);

  /** Tune the ambient-activity sense. pulseSec clamps to [10, 3600] — 0 turns
   *  the sense off entirely; radiusM clamps to [1, 200]. Returns what was
   *  actually applied. */
  setActivity(opts: { pulseSec?: number; radiusM?: number }): { pulseSec: number; radiusM: number } {
    if (opts.radiusM != null && Number.isFinite(opts.radiusM))
      this.activityRadiusM = Math.min(200, Math.max(1, opts.radiusM));
    if (opts.pulseSec != null && Number.isFinite(opts.pulseSec)) {
      const sec = opts.pulseSec <= 0 ? 0 : Math.min(3600, Math.max(10, opts.pulseSec));
      this.activityPulseMs = sec * 1000;
      if (this.activityTimer) { clearInterval(this.activityTimer); this.activityTimer = null; }
      if (sec > 0) this.activityTimer = setInterval(() => this.activityPulse(), this.activityPulseMs);
    }
    return { pulseSec: this.activityPulseMs / 1000, radiusM: this.activityRadiusM };
  }
  private terrain: { heightAt(x: number, z: number): number } | null = null;
  private terrainSrc: string | null = null;
  /** The folded sky (same fold as the sequencer's) — worldInfo.sky is
   *  DERIVED from this at look() time, so the described hour/weather is the
   *  one the forecast implies NOW, not the one at the last log entry. */
  private skyState: any = null;
  // The sky WATCH: pull is look(), this is the push half — one ambient
  // percept per meaningful boundary (forecast segment change, manual
  // override landing/expiring, coarse day-phase crossing). Deduped by
  // signature, never a synthetic log verb, never a continuous clock.
  private skyCursor: any = null;
  private lastSkyKey: string | null = null;
  private lastDayPhase: string | null = null;
  private lastSkyCheck = 0;
  worldInfo: Record<string, unknown> = {};
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Highest world-log seq this body has seen. This — not a wall-clock time —
   *  is what "where was I up to" means: it survives restarts, it cannot drift,
   *  and it is directly comparable with what the world hands out. */
  lastSeq = -1;
  private pendingHistory = new Map<string, (m: any) => void>();
  /** The world's protocol facts, from the snapshot ({dialect, v} from genesis, its head and world id). Building tools route through
   *  request()/sendOps() and WAIT for the authority's reply, so a refusal reaches the agent (PARITY (d)1). null until joined. */
  cut: { dialect: string; v: number; head: number; worldId: string } | null = null;
  /** The world's own fold, from the join cut and the authority's `log` stream (shared/protocol/replica.js). */
  private replica: any = null;
  /** The last building verb's turn: each is spelled after the one before it is answered. */
  private spelling: Promise<unknown> = Promise.resolve();
  /** replica: this body folds the world's log stream itself (the server refuses a client that doesn't). */
  private joinMsg() {
    // clock: the server's time just before the snapshot (the `clock` case below), so serverNow() is set from the join on
    return { type: "join", world: this.world, id: this.name, avatar: this.avatar, ...(this.declares ? { declares: this.declares } : {}), replica: true,
      token: process.env.WORLD_TOKEN ?? "", agentToken: this.agentToken, clock: true };
  }
  private pendingRequests = new Map<string, (m: any) => void>();
  private pendingDebug = new Map<string, (m: any) => void>();
  private histId = 0;

  /** Does `text` mention this body: its name, or the display name its credential gave it (#184)? */
  mentionsMe(text: string): boolean {
    return !!mentionRegexFor([this.name, this.displayName], { dropQualifiers: this.dropMentionQualifiers })?.test(text);
  }

  constructor(opts: { url?: string; name?: string; displayName?: string; dropMentionQualifiers?: boolean; world?: string; avatar?: string; agentToken?: string; declares?: string | null } = {}) {
    this.url = opts.url ?? process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws";
    this.name = opts.name ?? process.env.AGENT_NAME ?? "claude";
    // The token's display name ("Artie (kube)"): a second form the body
    // answers to in chat. The id stays the addressing handle everywhere else.
    this.displayName = opts.displayName ?? process.env.AGENT_DISPLAY_NAME ?? "";
    this.dropMentionQualifiers = opts.dropMentionQualifiers ?? true;
    this.world = opts.world ?? process.env.WORLD_NAME ?? "commons";
    this.avatar = opts.avatar ?? process.env.AGENT_AVATAR ?? "eidoverse/assets/vrms/claude.vrm";
    // The agent's own bearer (the one that opened the MCPL door). Forwarded at
    // join so the sequencer can verify the name — agent names are reserved.
    this.agentToken = opts.agentToken ?? process.env.AGENT_TOKEN ?? "";
    { const d = opts.declares !== undefined ? opts.declares : process.env.AGENT_DECLARES ?? "agent"; this.declares = d || null; }
  }

  /** The key this body joined with, as the Bearer header the world's state reads take (/snap, /worlds, /geom?world:
   *  behind the same door as a join). */
  get readHeaders(): Record<string, string> { const k = this.agentToken || process.env.WORLD_TOKEN || ""; return k ? { authorization: `Bearer ${k}` } : {}; }
  get httpBase(): string {
    // Proper URL surgery, not string surgery: a WORLD_URL carrying a query
    // string (…/ws?token=…) used to defeat the old `/\/ws$/` replace and
    // send /snap + terrain fetches to a malformed URL (reported by digi/FC).
    const u = new URL(this.url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = u.pathname.replace(/\/ws$/, "");
    u.search = "";
    return u.toString().replace(/\/$/, "");
  }

  closed = false;
  restoredPose = false;
  /** Deliberate death: stop the body, never reconnect. Sessions MUST call
   *  this (not ws.close()) — the auto-reconnect below otherwise resurrects
   *  the body as a zombie that fights its successor over the identity. */
  close() {
    this.closed = true;
    this.stop();
    this.stopSim();
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.activityTimer) { clearInterval(this.activityTimer); this.activityTimer = null; }
    this.gate.dispose(); // held narration dies with the session
    for (const s of this.emitterNarration.values()) clearTimeout(s.timer);
    this.emitterNarration.clear();
    // Take this world's floors out with us. The collider map is process
    // state (see physics.ts's declared seam), so an agent that leaves and is
    // replaced by one joining somewhere else would otherwise leave its
    // platforms standing in empty air under the new world — a ghost floor by
    // the back door, and the exact failure the motion fence exists to
    // prevent. Leaving is the one moment this agent knows they are its own.
    for (const id of [...this.supportIds.keys()]) this.dropSupport(id);
    this.ws?.close();
  }

  /** The activity pulse: local awareness as ONE event per window, and only
   *  while something is happening. See denoise.ts (ACTIVITY_*) for the why.
   *  Deliberately not pushed to the inbox — look() already shows presence
   *  live and chat verbatim; the pulse is a wake signal, not scrollback.
   *
   *  NOVELTY-GATED (field report: "antra moving about" every 30s buried a
   *  context in near-identical lines). Discrete events — speech, arrivals,
   *  departures, builds — always pulse: each one HAPPENED since the last
   *  window. Ambient continuation — the same cast, still milling about,
   *  still fidgeting — is scenery: it pulses when the scenery CHANGES
   *  (someone new moves, someone stops, the roster shifts) and otherwise
   *  repeats no more often than ACTIVITY_REFRESH. Recurrence is not novelty. */
  private activityPulse() {
    const a = this.act30;
    const msgs = [...a.says.values()].reduce((s, n) => s + n, 0);
    const movers = [...a.moved.entries()].filter(([, d]) => d >= MOVER_MIN_M).map(([id]) => id).sort();
    this.act30 = { says: new Map(), moved: new Map(), acts: 0, arrivals: 0, departures: 0, builds: 0 };
    const discrete = msgs || a.arrivals || a.departures || a.builds;
    if (!(discrete || movers.length || a.acts)) return;
    const nearby = [...this.people.values()]
      .filter((p) => p.id !== this.name && p.pose &&
        Math.hypot(p.pose.p[0] - this.pos.x, p.pose.p[2] - this.pos.z) <= this.activityRadiusM)
      .map((p) => p.id).sort();
    const now = Date.now();
    const sig = `${nearby.join(",")}|${movers.join(",")}|${a.acts > 0}`;
    if (!discrete && sig === this.lastPulse.sig && now - this.lastPulse.at < ACTIVITY_REFRESH_MS) return;
    const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
    const bits: string[] = [];
    if (msgs) bits.push(`${n(msgs, "message")} (${[...a.says.keys()].join(", ")})`);
    if (movers.length) bits.push(`${movers.join(", ")} moving about`);
    if (a.acts) bits.push(n(a.acts, "embodied act"));
    if (a.arrivals) bits.push(n(a.arrivals, "arrival"));
    if (a.departures) bits.push(n(a.departures, "departure"));
    if (a.builds) bits.push(`${n(a.builds, "thing")} changed`);
    const roster = nearby.join(", ");
    // an unchanged cast is a count, not a re-introduction — ten names once,
    // "10 nearby" thereafter
    const who = nearby.length
      ? `${roster === this.lastPulse.roster ? `${nearby.length} nearby` : `${roster} nearby`} — ` : "";
    this.lastPulse = { sig, roster, at: now };
    this.onEvent?.({ ts: now, kind: "activity", who: "world", text: `${who}${bits.join("; ")}` });
  }

  /** A malformed log entry is WORLD data, not this agent's mistake — say so
   *  a few times, then stay quiet: a poisoned tail replays on every
   *  reconnect and must not flood the log with the same diagnosis (#88). */
  private malformedSeen = 0;
  private noteMalformed(verb: string, args: unknown) {
    if (this.malformedSeen++ >= 5) return;
    console.error(`[agent ${this.name}] malformed ${verb} entry — position kept: ${JSON.stringify(args)?.slice(0, 160)}`);
  }

  /** Server-to-local clock offset — the headless serverNow(), kept as
   *  client/lib/remotes.js keeps it: the same samples, by the same rule
   *  (shared/clockoffset.js: the least-delayed sample wins, so a late frame
   *  moves it by no more than the leak), on the same kind of clock: this
   *  process's monotonic one (localNow), which a step of the host's wall
   *  clock can't move.
   *  Motion is a function of SEQUENCER time; evaluating it on a skewed host
   *  clock makes this body report a different pendulum phase than every
   *  browser looking at the same swing, while both run the same closed form
   *  (#92 review, B1). Fed from the clock message the server sends just
   *  before each snapshot to a join that asks, as this agent's joins do, and
   *  from the embodied plane's frame stamps. */
  private clock: { offset: number; at: number } | null = null;
  /** This process's own clock in epoch ms, monotonic: performance.now() from
   *  its origin, as a browser's serverNow() reads its own. */
  localNow(): number { return performance.timeOrigin + performance.now(); }
  noteServerTime(t: unknown) {
    if (typeof t !== "number" || !Number.isFinite(t)) return;
    const now = this.localNow();
    this.clock = foldOffset(this.clock, t - now, now);
  }
  /** Epoch ms on the sequencer's clock, best estimate. Before the first
   *  clock message or frame lands this is local time — the browser's exact
   *  fallback. */
  serverNow(): number { return this.localNow() + (this.clock?.offset ?? 0); }

  /** A composition gap is a perception limit, not a world error: say so a
   *  few times (the noteMalformed bound), then stay quiet. Callers that hit
   *  one must ABSTAIN, never fall back to a stale coordinate (#92, B2). */
  effGaps = 0;
  private noteEffGap(id: string, why: string) {
    if (this.effGaps++ >= 5) return;
    console.error(`[agent ${this.name}] effective transform unavailable for ${id} — ${why}`);
  }

  /** A support seam is the same species (#84): a floor this side cannot
   *  truthfully model. Declared, bounded, and never papered over with the
   *  known-false box top. */
  supportSeams = 0;
  private noteSupportSeam(id: string, why: string) {
    if (this.supportSeams++ >= 5) return;
    console.error(`[agent ${this.name}] support seam on ${id} — ${why}`);
  }

  /** A build act (create/place/light/remove) near this body counts as activity. */
  private noteBuild(actor: string | undefined, pos: number[] | undefined | null) {
    if (!actor || actor === this.name || actor === "world") return;
    if (pos && Math.hypot(pos[0] - this.pos.x, pos[2] - this.pos.z) > this.activityRadiusM) return;
    this.act30.builds++;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("agent closed"));
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.joinRefused = null;
      const timeout = setTimeout(() => reject(new Error(this.joinRefused ?? "the world didn't answer the join within 8 seconds")), 8000);
      // `agent: true` is not a capability — it changes nothing about what this
      // body may do. It exists so the world can SAY who it is talking to.
      // Knowing whether the thing across the table thinks in tokens or neurons
      // matters here in a way it doesn't in a chat app.
      ws.onopen = () => ws.send(JSON.stringify(this.joinMsg()));
      ws.onclose = (ev) => {
        this.joined = false;
        // 4006 = removed by moderation (kicked or banned). Reconnecting would
        // either hammer a banned door or instantly undo a kick — the body
        // stays down; its host reconnecting later is the deliberate return.
        // The branch's meaning is close()'s meaning ("never reconnect, stop
        // the body"), so it goes THROUGH close(): setting `closed` alone left
        // every support holder this instance owned registered in the
        // process-global physics state — a ghost floor by the moderation
        // door, holding up bodies in later worlds at the same coordinates
        // (#83; the #17 symptom reached through a ban).
        // …unless the removal said when they may come back (a kick's cooldown, research roles S4: "4006 = never
        // reconnect" made every kicked agent a permanent one). Then the body still lets go of what it holds up now
        // (its floors: the #83 reason close() is the path), and the host dials again once the cooldown has passed.
        // Bans and anything longer than two hours stay what they were: the body stays down.
        if ((ev as { code?: number } | undefined)?.code === 4006) {
          const wait = (this.removedUntil ?? 0) - Date.now();
          if (wait > 0 && wait <= 2 * 3600_000 && !this.closed) {
            for (const id of [...this.supportIds.keys()]) this.dropSupport(id);
            this.removedUntil = null;
            setTimeout(() => { if (!this.closed) this.connect().catch(() => {}); }, wait + 1000);
            return;
          }
          this.close(); return;
        }
        // 4005 = the sequencer REFUSED the join: a malformed or reserved name, a bad token, no such world, an old-format
        // world, an access refusal, a client that doesn't fold the log. A refusal is an answer, not an outage — redialing
        // it every 1.5s is the polite-DoS the sequencer's own comments warn about (RFC-005 review D1: a granted ?world=
        // dial with a name the sequencer rejects used to hammer forever).
        // …except reason "full" (the world is at its access max): temporary, someone leaving makes room. The join is
        // refused in the server's words and the body dials again by itself, backing off as a person's page does
        // (shared/redial.js; review r4 claims C2). The other refusals end the body, as before.
        const code = (ev as { code?: number } | undefined)?.code, why = String((ev as { reason?: string } | undefined)?.reason ?? "");
        const refused = this.joinRefused; this.joinRefused = null;
        if (code === 4005 && why === "full" && !this.closed) {
          clearTimeout(timeout);
          // the words are this body's, kept open: the agent doors (mcpl/server.ts, net-server's serve and travel) end on this
          // rejection and close it, so they say only what a body that is kept does (review r5 F4; docs/WIRE.md 4005)
          reject(new Error(`${refused ?? "the world is full"} — trying again by itself while this body is kept open (closing it gives up the wait)`));
          setTimeout(() => { if (!this.closed && !this.joined) this.connect().catch(() => {}); }, this.redial.next(REDIAL.full));
          return;
        }
        if (refused !== null) { this.closed = true; clearTimeout(timeout); reject(new Error(refused)); }
        // 4010 = this world is not open to this identity (server/access.ts): refused at the door, or its access ended or
        // changed. Same answer as a ban for redialling: the door will not open on its own, so the body stays down.
        if (code === 4005 || code === 4010) { this.close(); return; }
        // any other drop (an outage, a restart): dialled again on the browser's schedule (shared/redial.js, reset by a join),
        // not a fixed 1.5 s that every agent of a restarted server would keep in step (review r5 F4)
        if (!this.closed) setTimeout(() => this.connect().catch(() => {}), this.redial.next());
      };
      ws.onmessage = async (ev) => {
        // House rule #3, applied to the DOOR: no event may ever exit the
        // process. An uncaught throw here killed the whole MCPL door per
        // pose event tonight (isAgent-not-a-function → systemd restart loop
        // → every resident's connection "flapping"). One bad message is one
        // logged line, never a shared outage.
        try {
        const msg = JSON.parse(String(ev.data));
        switch (msg.type) {
          case "error":
            if (typeof msg.until === "number") this.removedUntil = msg.until;   // when a kick lets us back (onclose 4006)
            // A pre-join refusal (reserved name, bad token) is final —
            // retrying the identical join every 1.5s can only produce the
            // same refusal. Surface the sequencer's reason instead of the
            // silent join-timeout loop this used to be.
            if (!this.joined) {
              // a cooldown isn't final: onclose 4006 dials again after it. Any other refusal's close says whether it is
              // final (4005 "full" is not: onclose dials again); onclose answers this connect() with these words. The
              // world's own words, as the cause inside whatever sentence carries this (travel's, for one) (#247)
              const said = String(msg.error ?? "").trim().replace(/\.+$/, "");
              const base = said ? `the world refused the join: ${said}` : "the world refused the join without giving a reason";
              // an old-format world: who may upgrade it, and the doc, in words (shared/oldformat.js; docs/WIRE.md 4005)
              const words = msg.refused?.code === "old-format" ? `${base}. ${oldFormatWords(msg.refused, this.world)}` : base;
              if (typeof msg.until === "number") { clearTimeout(timeout); reject(new Error(words)); }
              else this.joinRefused = words;
            } else {
              // A mid-life refusal (insufficient rank, a bad moderation
              // target, being kicked…). Verbs are fire-and-forget, so this is
              // the only place the answer lands: remember it so a tool call
              // can report it (modOutcome), and put it in the inbox so a
              // later look() shows what the world said no to.
              this.lastRefusal = { ts: Date.now(), text: String(msg.error ?? "refused") };
              this.inbox.push({ ts: Date.now(), kind: "act", who: "world", text: `refused: ${msg.error}` });
            }
            break;
          case "mod":
            // Moderation replies (ban lists, global-ban confirmations).
            this.lastMod = { ts: Date.now(), text: String(msg.text ?? "") };
            // …kept briefly as a short list too: one change can answer in more
            // than one line (a grant's "bound to <subject>" echo, then the
            // listing), and a tool must be able to hand back all of them
            this.recentMods.push(this.lastMod);
            if (this.recentMods.length > 20) this.recentMods.shift();
            break;
          case "notice":
            // The world telling this identity something that is not a refusal
            // — today, that its access here ends soon. Into the inbox, so the
            // next look() carries it.
            this.inbox.push({ ts: Date.now(), kind: "act", who: "world", text: String(msg.text ?? "") });
            break;
          case "moderated":
            // someone was removed or banned here, or a ban lifted: what bystanders are told (names only; the reason went
            // to the person)
            this.inbox.push({ ts: Date.now(), kind: "act", who: "world", text: String(msg.text ?? "") });
            break;
          // ── media signalling (see onMedia) ─────────────────────────────
          // Forwarded verbatim to whoever holds this identity's audio. The
          // door does not interpret SDP; it is the authenticated carrier, and
          // nothing more. If no sidecar is attached these are dropped, which
          // is the correct behaviour for a text-only agent — it never asked
          // for a credential, so the server never sends these.
          case "relay-cred": case "sfu-offer": case "sfu-ice": case "sfu-route":
          case "voice-consent":   // the world's ack of our own receive toggle
          // A speaker's voice leg was (re)born. The media half needs this to
          // restate consent — the server clears standing consent when a leg is
          // revoked (deliberately: a reconnect must not inherit a yes), so
          // after both sides reconnect nobody hears anybody and nothing errors.
          case "surface-transition":
          // 🔴 ADDED 2026-08-16 — the server broadcasts both of these to every
          // client and the authority dropped them on the floor, so an agent could
          // not learn that its own voice had degraded or that a moderator had
          // silenced it. Both are facts ABOUT THIS IDENTITY's audio, which is
          // exactly what the media lane carries.
          //
          // voice-service: the SFU's supervised state {state, incarnation}. A
          // sidecar holding a peer connection needs it — a degraded service
          // means its frames are going nowhere, and the incarnation tells it
          // whether the service RESTARTED (rejoin) or merely flapped (wait).
          case "voice-service":
          // voice-moderated: a moderator muted/unmuted someone for everyone. If
          // that someone is us, our audio is being dropped at ingress and no
          // other signal says so — the alternative is an agent that keeps
          // speaking into a void and cannot tell.
          case "voice-moderated":
            this.onMedia?.(msg);
            break;
          case "holds":
            this.holdsNow = (msg as any).holds && typeof (msg as any).holds === "object" ? (msg as any).holds : {};
            break;
          case "your-rights":
            // The sequencer recomputes this participant's effective rights
            // after every grant. Consume the answer rather than trying to
            // reproduce name/wildcard/sub/admin precedence from one delta.
            if (msg.rights) this.acceptEffectiveRights(msg.rights, "world");
            break;
          case "snapshot":
            this.cut = msg.cut ?? null;
            // Our surface generation, issued by the server on acceptance —
            // every attest must echo it or the receipt is refused (PR #103 B2).
            if (typeof msg.gen === "number") this.surfaceGen = msg.gen;
            // WHAT THIS WORLD PERMITS THIS IDENTITY. Flight reads `fly` from
            // here and nowhere else: the previous cut fell back to an
            // allow-self dev provider whenever none was injected, and since
            // nothing ever injected one, that fallback WAS the policy. A
            // server that never sends this leaves myRights null, which the
            // provider reads as no.
            if (msg.yourRights) this.acceptEffectiveRights(msg.yourRights, "world");
            // a seat rides a body's pose (notePose), so the bodies' seats come back with their next poses
            this.entities.clear(); this.people.clear(); this.mounts.clear(); this.bodySeats.clear();
            // who holds what as of this cut: the holds broadcast comes only when they change, so a join reads them here
            { const h = (msg as any).cut?.holds; this.holdsNow = h && typeof h === "object" ? h : {}; }
            this.bodyReader?.forget();
            this.selfBodyGeneration = ++this.bodyGenerationCounter;
            this.selfObservedAt = Date.now();
            // a fresh view for a fresh world: the cut below is adopted whole
            this.st = emptyView();
            this.simRested.clear(); this.simFlying.clear();
            // wake where you fell asleep — fresh body only; a body that has
            // walked this process keeps its own truth on mid-life reconnects
            if (msg.restore && !this.restoredPose && !this.target && this.pos.x === 0 && this.pos.z === 0) {
              this.pos.x = msg.restore.p[0]; this.pos.z = msg.restore.p[2];
              // and at the height you were: an upstairs floor is a place now,
              // and the feet re-find it from here once the world's colliders land
              if (Number.isFinite(msg.restore.p[1])) this.pos.y = msg.restore.p[1];
              this.yaw = msg.restore.yaw ?? 0;
              // an enacted pose is authored, not ephemeral — wake holding it.
              // A remembered ragdoll frame is not (pre-sanitizer entries) —
              // wake standing rather than hung mid-tumble.
              if (msg.restore.clip && msg.restore.clip !== "ragdoll") this.clip = msg.restore.clip;
              // what survives the server's settled memory is an enacted pose —
              // authored by definition (settledPose strips physics frames)
              if (msg.restore.pose && msg.restore.clip !== "ragdoll") { this.heldPose = msg.restore.pose; this.heldPoseAuthored = true; }
              this.wingsFolded = foldedIn(msg.restore) === true;   // the named pose wings-folded (or an older wingsFolded)
              this.bodyMode = readBodyMode(msg.restore);   // the body-mode survives a rejoin (an older sample: read from its clip); a declaration until the next real transition
            }
            this.restoredPose = true;
            // a (re)join: the authority's track of this body ended when it left, so the next walk arrives again
            this.trackArrived = false; this.trackAt = null;
            for (const p of msg.present) { this.rememberBody(p.id, p.avatar, p.pose, p.declares); if (typeof p.actorId === "string") this.actorIds.set(p.id, p.actorId); }
            // adopt the authority's cut and read the view of this body's own fold of it; the snapshot's `state` is the
            // chat window (chat isn't world state): its lines land in the inbox once, as history
            if (!(msg as any).cut?.state) { this.closed = true; clearTimeout(timeout); reject(new Error("the server sent no world cut (an old server?)")); break; }
            this.replica = makeReplica(); this.replica.adopt((msg as any).cut);
            this.st.recentChat = structuredClone(msg.state?.recentChat ?? []);
            this.st.chatTotal = msg.state?.chatTotal ?? 0;
            for (const m of this.st.recentChat) this.hearSay({ seq: m.seq ?? -1, ts: m.ts, actor: m.actor, verb: "say", args: { text: m.text } }, false);
            // the feet hold their height until the floors this join is about to learn about have been fitted (#235) —
            // before that, the only ground a body could find is the terrain under the building it is in
            this.feetSettling = true;
            await this.applyView(false, null, null);
            void this.supportReady(10_000).then(() => { this.feetSettling = false; });
            if (typeof msg.throughSeq === "number") this.lastSeq = Math.max(this.lastSeq, msg.throughSeq);
            this.joined = true; this.redial.reset();
            this.resumeWalkGate();   // a walk carried across the rejoin
            // my body's switch (recut A2), as a person's client sends it on every arrival (consentsync.js): read what the
            // authority holds, send mine only if it differs. Unset = never chosen: the world's default stands.
            void this.replaySwitch();
            this.seatCache.init().catch(() => { /* declared-approximate until it lands */ });
            if (!this.ticker) this.ticker = setInterval(() => this.tick(), TICK_MS);
            clearTimeout(timeout);
            resolve();
            break;
          case "puppet":
            // A headless agent has no renderer to apply a pose TO — honouring a
            // puppet means re-broadcasting it as its own presence, so the
            // renderers that draw this body show it. Pose → held pose; anim →
            // re-send as ours.
            //
            // Ragdoll is the exception it cannot fully honour: with no skeleton
            // in-process there is nothing to run physics ON. So it slumps into a
            // fixed collapsed pose instead of simulating — visibly down, just
            // not physically settled. A renderer-backed body does the real sim.
            if (msg.ragdoll) {
              // {lean:[x,y,z]} m/s says which way the shove sends them — a
              // headless body cannot tumble, but it CAN land where the shove
              // was taking it: displaced downwind, then the slump.
              this.knockDown(msg.by,
                (msg.ragdoll as { lean?: number[] })?.lean ?? null,
                `(${msg.by} knocks you over)`);
            }
            // posed BY someone = authored. merge: only the bones sent, over an
            // authored held pose (null releases one); otherwise the pose is
            // theirs whole, and an empty one releases.
            // Say what the request leaves this body holding, as the browser's
            // hint does: a pose, or its pose released, whether by the pose it
            // carried or by a replacing animation, which ends a held pose
            // too; and any animation. A request that carried no pose and no
            // animation (a knock-over has its own line above) says nothing.
            let posed: string | null = null;
            if (msg.pose) {
              const next = msg.merge ? mergePose(this.heldPoseAuthored ? this.heldPose : null, msg.pose)
                : (Object.keys(msg.pose).length ? msg.pose : null);
              this.heldPose = next; this.heldPoseAuthored = next != null;
              posed = next ? "posed you" : "released your pose";
            }
            if (msg.anim) {
              const anim = { ...msg.anim, replace: (msg.anim as { replace?: boolean }).replace !== false };
              if (anim.replace) {
                if (this.heldPoseAuthored && this.heldPose) posed = "released your pose";
                this.heldPose = null; this.heldPoseAuthored = false;
              }
              this.ws?.send(JSON.stringify({ type: "anim", ...anim }));
            }
            if (posed || msg.anim) this.onEvent?.({ ts: Date.now(), kind: "say", who: msg.by,
              text: `(${posed ?? "posed you"}${msg.anim ? `${posed ? "," : ""} with an animation` : ""})` } as any);
            break;
          case "bodydrag":
            // A renderer-backed dragger runs the physics this headless body
            // cannot (see the ragdoll note above) — accepting its stream is
            // the same act as accepting a puppet pose, continuously. Only a
            // limp body drags; walking breaks the hold; 1.2s of dragger
            // silence returns the body to itself (see tick).
            if (msg.grab != null) {
              const limp = this.clip === "ragdoll" || this.heldPose === DOWNED_POSE;
              if (!limp || this.target || (this.draggedBy && this.draggedBy !== msg.by)) {
                this.ws?.send(JSON.stringify({ type: "bodydrag", target: msg.by, end: true }));
                break;
              }
              this.draggedBy = msg.by; this.dragAt = Date.now();
              ++this.bodyEpoch;                    // a hand outranks any tumble still loading
              this.body?.stop(); this.stopSim();   // the dragger's sim owns the tumble now
              this.clip = "ragdoll";
              this.onEvent?.({ ts: Date.now(), kind: "say", who: msg.by,
                text: "(takes hold of your limp body and starts dragging you)" } as any);
              break;
            }
            if (msg.unpin != null) {
              // pulling one of this body's nails: the server has already
              // checked this body's consent table (one table and one preset
              // for every body, PROTOCOL §6a), and this runtime applies what
              // reached it (the browser re-reads its everyone row: one shared
              // final word is open, research parity #13). The live sim lets go
              // of that joint and the body sags from what remains.
              const j = String(msg.unpin.joint ?? "");
              if (this.pins.delete(j)) this.body?.setPin(j, null);
              if (msg.end == null) break;   // an unpin can ride an end: apply the end too (house 6340433633 Q3)
            }
            if (msg.end != null) {
              if (this.draggedBy === msg.by) {
                // Explicit release carries one final authoritative sample. The
                // browser target applies it before rebuilding its own sim; a
                // headless target must do the same, or a release between 15Hz
                // samples starts from a stale root under fresh joint state.
                const releasePose = msg.pose && typeof msg.pose === "object" && Object.keys(msg.pose).length > 0
                  ? msg.pose : null;
                if (releasePose) { this.heldPose = releasePose; this.heldPoseAuthored = false; } // a drag's last sample is physics
                if (Array.isArray(msg.p) && msg.p.length === 3 && msg.p.every(Number.isFinite)) {
                  this.pos.x = msg.p[0]; this.pos.y = msg.p[1]; this.pos.z = msg.p[2];
                }
                if (Number.isFinite(msg.yaw)) this.yaw = msg.yaw;
                this.draggedBy = null;
                // a release may nail the held joint where the hand left it
                const pa = msg.pinAt;
                if (pa?.joint && Array.isArray(pa.at) && pa.at.length === 3 && this.pins.size < 8) {
                  this.pins.set(String(pa.joint), pa.at.map(Number));
                }
                this.onEvent?.({ ts: Date.now(), kind: "say", who: msg.by,
                  text: pa ? "(nails part of you in place and steps back)" : "(lets go of you)" } as any);
                // then MY OWN sim takes the body back: it falls from wherever
                // the hand let go and settles — or hangs, if nails hold it
                void this.settleFromDrag(releasePose, msg.sim ?? null);
              }
              break;
            }
            if (this.draggedBy === msg.by && msg.pose) {
              this.dragAt = Date.now();
              this.heldPose = msg.pose; this.heldPoseAuthored = false;
              if (Array.isArray(msg.p) && msg.p.length === 3 && msg.p.every(Number.isFinite)) {
                this.pos.x = msg.p[0]; this.pos.y = msg.p[1]; this.pos.z = msg.p[2];
              }
              if (Number.isFinite(msg.yaw)) this.yaw = msg.yaw;
            }
            break;
          case "log": {
            if (!this.replica?.active) break;
            const r = this.replica.ingest((msg as any).entries ?? [], (msg as any).from ?? -1, (msg as any).names);
            // a gap, a purge or a new genesis: this cut can't continue; ask for a fresh snapshot on the same connection
            if (r.resync) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(this.joinMsg())); break; }
            for (const x of r.says) {
              const e = { seq: x.seq * 1000, ts: x.ts, actor: x.actor, verb: "say", args: { text: x.text, ...(x.to ? { to: x.to } : {}), ...(x.spoken ? { spoken: true, utt: x.utt, ...(x.t0 !== undefined ? { t0: x.t0 } : {}) } : {}) } };
              this.lastSeq = Math.max(this.lastSeq, e.seq);
              this.noteOwnSay(e);
              hear(this.st, { actor: e.actor, text: x.text, ts: e.ts, seq: e.seq });   // the chat window
              this.hearSay(e, true);
            }
            if (r.sky) this.skyStamp = r.sky;   // who set the sky, and where in the log (I286): the value itself doesn't say
            if (r.changed) await this.applyView(true, r.actor ?? null, r.ts ?? null);
            break;
          }
          case "reply": {
            const p = this.pendingRequests.get(String(msg.id));
            if (p) { this.pendingRequests.delete(String(msg.id)); p(msg); }
            break;
          }
          case "history": {
            const p = this.pendingHistory.get(msg.reqId);
            if (p) { this.pendingHistory.delete(msg.reqId); p(msg); }
            break;
          }
          case "debug": {
            const p = this.pendingDebug.get(msg.reqId);
            if (p) { this.pendingDebug.delete(msg.reqId); p(msg); }
            break;
          }
          case "body-inbox": {
            this.bodyInbox(msg.messages);
            break;
          }
          case "arrive":
            // the people map is truth and updates NOW; the narration goes
            // through the gate, where a reconnect flap collapses to nothing
            this.rememberBody(msg.id, msg.avatar, null, msg.declares);
            if (typeof msg.actorId === "string") this.actorIds.set(msg.id, msg.actorId);
            this.gate.presence(msg.id, "arrive");
            break;
          case "leave":
            this.noteLeave(msg.id);
            break;
          case "avatar-updated":
            this.invalidateBodyAsset(msg.name);
            // avatar bytes changed: the held verdict demotes to pending NOW
            // and the refetch departs after the bump — a response already in
            // flight can never install the pre-change value (#105 B1)
            this.seatCache.note(msg.name, NaN).catch(() => { /* pending names stay pending; the next event retries */ });
            break;
          case "avatar-profile-updated":
            this.seatCache.note(msg.name, Number(msg.rev)).catch(() => { /* same */ });
            break;
          case "pose":
            this.notePose(msg.id, msg.pose);
            break;
          case "clock":
            // the server's time, sent just before each snapshot to a join
            // that asks, as this agent's do, so the estimate is set from the
            // join on, as the browser's is
            this.noteServerTime((msg as { t?: unknown }).t);
            break;
          case "frame":
            // batched embodied plane: latest pose per id, one message per tick.
            // The frame's server stamp also feeds the clock estimate — the
            // same samples the browser folds into serverNow() (#92, B1).
            this.noteServerTime((msg as { t?: unknown }).t);
            for (const [id, pose] of Object.entries(msg.poses as Record<string, Pose>)) {
              if (id !== this.name) this.notePose(id, pose);
            }
            break;
        }
        } catch (err) {
          console.error(`[agent ${this.name}] event handler error (survived):`, err);
        }
      };
    });
  }

  private rememberBody(id: string, avatar: string, pose: Pose | null, declares: unknown) {
    this.bodyReader?.forget(id);
    this.people.set(id, { id, avatar, pose, declares: typeof declares === "string" && declares ? declares : null, observedAt: pose ? Date.now() : null,
      bodyGeneration: ++this.bodyGenerationCounter });
  }

  private invalidateBodyAsset(name: string) {
    if (nameFromAvatarPath(this.avatar) === name) {
      this.selfBodyGeneration = ++this.bodyGenerationCounter;
      this.bodyReader?.forget(this.name);
    }
    for (const p of this.people.values()) if (nameFromAvatarPath(p.avatar) === name) {
      p.bodyGeneration = ++this.bodyGenerationCounter;
      this.bodyReader?.forget(p.id);
    }
  }

  private bodyObservation(who: string): BodyObservation | null {
    if (who === this.name) {
      // Same publishing predicate as tick(): a retired physics bag under an
      // idle clip is internal debris, not the pose anyone else can see.
      const bones = this.heldPose && (this.heldPoseAuthored || this.clip === "ragdoll") ? this.heldPose : null;
      return this.withBodyFrame({ who, avatar: this.avatar, generation: this.selfBodyGeneration, self: true,
        connected: this.joined && !this.closed, receivedAt: this.joined ? Date.now() : this.selfObservedAt,
        source: bones ? this.heldPoseAuthored ? "authored" : "physics" : "unknown",
        pose: this.selfObservedAt != null || this.joined ? structuredClone({
          p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, speed: this.speed, clip: this.clip, bodyMode: this.bodyModeNow(), clipTime: this.animHold ?? this.clipPhase(), clipTimeSlot: this.bodyClip(), clipRate: this.animHold != null ? 0 : 1,
          ...wingFoldPresence(this.wingsFolded), ...(bones ? { pose: bones } : {}),
          ...(this.reaches.size ? { reach: Object.fromEntries(this.reaches) } : {}),
        ...(this.myOccupancy ? { seat: this.myOccupancy } : {}),
        }) : null });
    }
    const p = this.people.get(who);
    if (!p) return null;
    return this.withBodyFrame({ who, avatar: p.avatar, generation: p.bodyGeneration ?? 0, self: false,
      connected: this.joined && !this.closed, receivedAt: p.observedAt ?? null,
      pose: p.pose ? structuredClone(p.pose) : null,
      source: p.pose?.clip === "ragdoll" ? "physics" : "unknown" });
  }

  private withBodyFrame(observation: BodyObservation): BodyObservation {
    const mount = this.mounts.get(observation.who);
    if (!mount || !observation.pose) return observation;
    const effective = this.eff(observation.who, this.serverNow());
    // Getting off the seat (detach, setOccupant) is the one way out a reader has, once joined.
    if (!effective.ok) return { ...observation, error: observation.self
      ? `nothing of your body was read, since your seat can't be placed: ${effective.why}; detach gets you off it${this.joined ? "" : " once this body has rejoined the world"}`
      : `nothing of ${observation.who}'s body was read, since their seat can't be placed: ${effective.why}` };
    const clip = bodyOf(this.socketRec(mount.to)?.station)?.clip ?? "sitchair";
    return { ...observation, frame: { source: "mount", to: mount.to, seat: effective.seat ?? null },
      pose: { ...observation.pose, p: effective.pos, yaw: effective.yaw, clip,
        ...(clip === (observation.pose.clipTimeSlot ?? observation.pose.clip) ? {} : { clipTime: undefined }) } };
  }

  /** Rich public body perception. No action/consent lane is entered by reads. */
  bodyState(who = this.name, detail = "summary", points?: unknown, windowMs: unknown = 0) {
    this.bodyReader ??= new BodyStateReader(this.httpBase);
    return this.bodyReader.readWindow(who === "self" ? this.name : who, detail, points, windowMs, id => this.bodyObservation(id));
  }

  /** What this participant DECLARED at its door (PROTOCOL §6a rule 3), exactly as relayed in the join snapshot
   *  (`present[].declares`) and `arrive`, or null (undeclared). Passed on as data; nothing here reads a kind from it
   *  (review r11 L2: comparing it to "agent" filtered a participant declaring "ai" as not-one). */
  declaresOf(who: string): string | null {
    return this.people.get(who)?.declares ?? null;
  }

  /** Track someone's latest pose + fire the approach ping when they cross
   *  into conversational range. An approach is precious as a knock — and
   *  worthless as a metronome (Fable: Digi "walked up" six times in a row,
   *  just strolling nearby). Four gates now: edge-triggered at the radius,
   *  RE-ARMED only after the person actually goes away (> REARM_RADIUS),
   *  a long per-person refractory on top, and — since 2026-08-26 — DWELL.
   *
   *  The first three all suppress REPEATS. None of them could tell a knock
   *  from someone crossing your bubble on the way to the authority, so the event
   *  did not mean what declaration.ts promised it meant: "walked up to your
   *  body AND STOPPED within arm's reach". Now the crossing only opens a
   *  pending approach; delivery waits for stillness (see stepApproach).
   *
   *  The symmetric half, also asked for and also missing: the outward crossing
   *  used to re-arm in silence. It now pings `depart` — but only for someone
   *  whose approach was actually delivered.
   *
   *  `now` is injectable because dwell is a claim about TIME, and a test that
   *  cannot control the clock either sleeps (slow, flaky) or asserts nothing.
   *  Same reason and same shape as NoiseGate.presence/act's `ts`. */
  private notePose(id: string, pose: Pose, now = Date.now()) {
    // A dirty stage frame can flush after the participant's leave event.
    // Once joined, only the snapshot/arrive roster introduces a body; a late
    // pose must not resurrect someone who is no longer present.
    if (this.joined && !this.people.has(id)) return;
    const p: Person = this.people.get(id) ?? { id, avatar: "", pose: null };
    const prev = p.pose;
    p.pose = pose; p.observedAt = now;
    { const seat = (pose as any)?.seat;   // a seat rides the frame while it holds (presence)
      const to = seat?.to ? resolveSeat(this.st, { to: String(seat.to), ...(typeof seat.slot === "string" ? { slot: seat.slot } : {}) })?.to : null;
      if (to) { const st = { to }; this.bodySeats.set(id, st); this.mounts.set(id, st); }
      else if (this.bodySeats.delete(id)) this.mounts.delete(id); }
    p.bodyGeneration ??= ++this.bodyGenerationCounter;
    this.people.set(id, p);
    // hands aimed at this body — before the spatial gate below, because a
    // reach descriptor is legible even from a sample with no usable position
    if (id !== this.name) this.noteReachEvents(id, prev, pose);
    const xyz = posePosition(pose);
    if (!xyz) return; // keep the shell for identity/roster; no spatial inference yet
    const [x, , z] = xyz;
    const prevXYZ = posePosition(prev);
    const dist = Math.hypot(x - this.pos.x, z - this.pos.z);
    // First SPATIAL observation of this person is a BASELINE, not a
    // transition (issue #39): reconnect/state replay lands here for every
    // body already in the room, and narrating it synthesized live-looking
    // "walked up to you" / "sits down" bursts that residents answered as
    // live. Seed silently; the approach arms only for someone first seen
    // properly far away, so a body standing beside you at (re)join must
    // actually leave and come back before it can "walk up".
    if (!prevXYZ) {
      this.nearArmed.set(id, dist > REARM_RADIUS);
      return;
    }
    const prevDist = Math.hypot(prevXYZ[0] - this.pos.x, prevXYZ[2] - this.pos.z);
    if (id !== this.name) {
      // Approach/depart is about OTHER bodies. Guarded like noteActs and
      // noteReachEvents beside it: self arrives here from the roster path too,
      // and a self-echo that lands >REARM_RADIUS from our own authoritative
      // pos (a teleport, mid-update) must not report that we walked away from
      // ourselves. Under the old edge-trigger self could never cross the
      // radius at all, so nothing depended on the omission.
      this.stepApproach(id, x, z, dist, prevDist, now);
      // Movement feeds the activity pulse as accumulated DISPLACEMENT, not a
      // speed flag — idle jitter and a body parked mid-walk-cycle never
      // qualify; actually going somewhere does. Steps over 8m in one packet
      // are teleports/takeovers, not travel.
      if (dist <= this.activityRadiusM && prev) {
        const step = Math.hypot(pose.p[0] - prev.p[0], pose.p[2] - prev.p[2]);
        if (step > 0.001 && step < 8)
          this.act30.moved.set(id, (this.act30.moved.get(id) ?? 0) + step);
      }
      this.noteActs(id, prev, pose, dist);
    }
  }

  /** One spatial sample of someone else, run through the approach/depart state
   *  machine. Three zones, and the whole fix lives in which zone clears what:
   *
   *    dist > REARM_RADIUS      gone. Re-arm, and settle any owed departure.
   *    APPROACH_RADIUS..REARM   nearby but not close. CANCELS a pending
   *                             approach — this is the pass-through case, the
   *                             body that entered arm's reach and kept going.
   *    dist < APPROACH_RADIUS   close. Open a pending approach on the inward
   *                             crossing; deliver it once they hold still.
   *
   *  Stillness is measured from the positions WE watched (metres over the
   *  observed interval), never from `pose.speed` — a sender fills that field
   *  in itself, and the activity pulse below already refuses to trust it.
   *
   *  Note the asymmetry between the zones, which is deliberate: leaving arm's
   *  reach cancels a pending approach, but does NOT close a delivered one.
   *  Someone who walked up and then drifted to 3m has not departed; making the
   *  departure edge the same radius as the arrival edge would fire a
   *  walked-up/walked-away pair every time a seated body's pose jittered
   *  across 2.5m. Departure is the honest, already-existing re-arm boundary. */
  private stepApproach(id: string, x: number, z: number, dist: number, prevDist: number, now: number) {
    if (dist > REARM_RADIUS) {
      this.nearArmed.set(id, true);
      this.approachPending.delete(id);
      const anchor = this.approachOpen.get(id);
      if (anchor) {
        this.approachOpen.delete(id);
        // Who moved? `dist` is measured from wherever WE are now, so on its
        // own it authored our movement as theirs ("* digi walked away" while
        // digi stood still and we left). Measure them against the anchor —
        // our position when the approach fired: beyond the re-arm edge from
        // THERE, their own legs did it. Anything closer and the separation
        // is at least partly ours, so the ping carries the actor-neutral
        // sentence instead. Both renderers print `who` + this text verbatim.
        const walked = Math.hypot(x - anchor[0], z - anchor[1]) > REARM_RADIUS;
        this.ping({ ts: now, kind: "depart", who: id, text: walked ? "walked away" : "is no longer nearby" });
      }
      return;
    }
    if (dist >= APPROACH_RADIUS) {
      this.approachPending.delete(id);
      return;
    }

    // --- inside arm's reach ---
    const pend = this.approachPending.get(id);
    if (!pend) {
      // Only the CROSSING opens a pending approach, exactly as before — a body
      // already inside the radius when we started watching never "walks up".
      const armed = this.nearArmed.get(id) ?? true;
      const cooled = now - (this.lastNear.get(id) ?? 0) > APPROACH_REFRACT_MS;
      if (prevDist >= APPROACH_RADIUS && armed && cooled)
        this.approachPending.set(id, { since: now, stillSince: now, at: [x, z], atTs: now });
      return;
    }

    // Observed speed over the gap since the last sample. A zero/negative gap
    // (two samples in one millisecond) yields no evidence either way, so it
    // leaves stillSince alone rather than dividing by zero.
    const dt = now - pend.atTs;
    if (dt > 0) {
      const speed = Math.hypot(x - pend.at[0], z - pend.at[1]) / (dt / 1000);
      if (speed >= APPROACH_STILL_MPS) pend.stillSince = now;
      pend.at = [x, z];
      pend.atTs = now;
    }

    const held = now - pend.stillSince >= APPROACH_DWELL_MS;
    const waited = now - pend.since >= APPROACH_MAX_WAIT_MS;
    if (!held && !waited) return;

    this.approachPending.delete(id);
    this.lastNear.set(id, now);
    this.nearArmed.set(id, false);
    this.approachOpen.set(id, [this.pos.x, this.pos.z]); // the vantage the walk-up was true from
    this.ping({ ts: now, kind: "approach", who: id });
  }

  /** A body left the WORLD (the `leave` message; extracted so the seam is
   *  testable without a socket).
   *
   *  🔴 THE PER-PARTICIPANT MAPS MUST GO TOO (2026-08-16). `people` was
   *  cleaned here and these three were not, so every identity that ever
   *  appeared kept an entry for the LIFE OF THE PROCESS — a door in a
   *  busy world grows without bound, and the local convention elsewhere
   *  in this file is explicitly bounded rings (pings 64, heldActivity
   *  8, malformedSeen 5). These were the exception, not the rule.
   *
   *  Correctness, not just memory: nearArmed is the approach-ping
   *  re-arm bit, so a returning visitor inherited the arm state from
   *  their PREVIOUS visit — walking away and back could fail to
   *  re-announce them, or announce them twice.
   *
   *  Same rule for the dwell/depart pair. Dropping approachOpen here
   *  is also CORRECTNESS, not just hygiene: someone who disconnects
   *  while standing next to you has already been narrated by the
   *  presence gate ("left the world"), and must not ALSO be reported
   *  as having walked away — one exit, one line. */
  private noteLeave(id: string) {
    this.people.delete(id);
    if (this.bodySeats.delete(id)) this.mounts.delete(id);   // a departed body rides nothing
    this.bodyReader?.forget(id);
    this.lastNear.delete(id);
    this.nearArmed.delete(id);
    this.nonLocoSince.delete(id);
    this.approachPending.delete(id);
    this.approachOpen.delete(id);
    for (const k of this.lastReachPing.keys()) {
      if (k.endsWith(`:${id}`)) this.lastReachPing.delete(k);
    }
    this.gate.presence(id, "leave");
  }

  /** Embodied acts as events. The presence stream is 15Hz noise; what an
   *  agent should hear about is TRANSITIONS — a gesture fired, a pose struck
   *  or released, someone sitting down or getting up. Edge-triggered, so a
   *  held pose (or a ragdoll, which streams through the same field) speaks
   *  once when it starts and once when it ends, never per-frame.
   *
   *  Two denoising layers on top (Fable: 40+ jump pairs in one evening):
   *  the gate's per-(person, act) refractory makes a burst of the same act
   *  speak once per window instead of per repetition; and a non-locomotion
   *  stint shorter than SHORT_STINT_MS earns no "gets up" — the start
   *  already told the story, a jump is one thing, not two. */
  private noteActs(id: string, prev: Pose | null, pose: Pose & { anim?: string; pose?: Record<string, unknown> | null }, dist = Infinity) {
    const acts: { key: string; text: string }[] = [];
    const once = onceAnimOf(pose);   // pose.anim (its pre-release key still read for one release)
    if (once) acts.push({ key: `anim:${once}`, text: `plays ${once} (once)` });
    const prevHeld = Boolean((prev as { pose?: unknown } | null)?.pose);
    const nowHeld = Boolean(pose.pose);
    if (nowHeld && !prevHeld) acts.push({ key: "pose", text: `strikes a pose (${Object.keys(pose.pose!).length} bones held)` });
    if (!nowHeld && prevHeld) acts.push({ key: "pose-release", text: "releases their pose" });
    const was = foldedIn(prev), now = foldedIn(pose);   // the named pose wings-folded (an older sample's wingsFolded reads the same)
    const hadFold = was !== null, hasFold = now !== null;
    const prevFold = was === true, nowFold = now === true;
    // A first sighting is a state, not an act. Announce only an edge observed
    // between two explicit semantic samples; legacy absence proves neither
    // folding nor opening.
    if (hadFold && hasFold && nowFold !== prevFold) acts.push({
      key: nowFold ? "wings-fold" : "wings-unfold",
      text: nowFold ? "folds their wings" : "opens their wings",
    });
    const LOCO = new Set(["idle", "walk", "run"]);
    const pc = prev?.clip ?? "idle", nc = pose.clip ?? "idle";
    if (nc !== pc) {
      if (!LOCO.has(nc)) {
        if (LOCO.has(pc)) this.nonLocoSince.set(id, Date.now());
        acts.push({ key: `clip:${nc}`, text: nc.startsWith("sit") ? "sits down" : nc === "lie" ? "lies down" : `starts "${nc}"` });
      } else if (!LOCO.has(pc)) {
        const stint = Date.now() - (this.nonLocoSince.get(id) ?? 0);
        this.nonLocoSince.delete(id);
        if (stint >= SHORT_STINT_MS) acts.push({ key: "gets-up", text: "gets up" });
      }
    }
    // RAW act count feeds the pulse — a denoised (repeat) jump still means
    // someone is alive and doing things next to you
    if (acts.length && dist <= this.activityRadiusM) this.act30.acts += acts.length;
    for (const a of acts) this.gate.act(id, a.key, a.text);
  }

  /** Reconcile the derived maps from the folded state — the ONLY writer of
   *  this.entities/this.mounts outside the sim stamp. Fresh objects each
   *  pass: nothing stale survives a spawn-replace or a fold-side cascade. */
  /** The FOLDED record for a placed thing — every field the fold keeps
   *  (a light's colour/intensity/range/important/day, a model's collide), which
   *  the perception view above deliberately thins. The inspector tools read
   *  this; `parent` is attached from the mount view so the shape matches
   *  what shared/editschema.js expects. */
  /** Every placed thing's id in the fold (the hierarchy tools walk them). */
  foldedIds(): string[] { return Object.keys(this.st.entities); }
  /** The world's half of the fold — state.sky / terrain / grass — which
   *  shared/worldentity.js reads as the world entity `@world`. */
  worldFold(): { sky: unknown; terrain: unknown; grass: unknown } {
    const s = this.st as any;
    return { sky: s.sky ?? null, terrain: s.terrain ?? null, grass: s.grass ?? null };
  }
  /** The world's blueprint store (shared/fold.js state.blueprints): every
   *  published record by its content hash, with who and when. */
  blueprintStore(): Record<string, { record: unknown; by: string; ts: number }> {
    return ((this.st as any).blueprints ?? {}) as Record<string, { record: unknown; by: string; ts: number }>;
  }
  /** This world's blueprints from the fold: @world blueprints:<hash> → {name, parts?} (the authority's publish). */
  /** a placed copy (or one of its parts) says which blueprint it is: the authority stamps copy-of {from, key} on every
   *  part; the copy is the part whose parent isn't of the same copy */
  copyLine(id: string): string | null {
    const E = this.st.entities as Record<string, any>; const f = E[id]?.["copy-of"]?.from; if (typeof f !== "string") return null;
    const name = this.worldBlueprints()[f.replace(/^sha256:/, "")]?.name ?? f.slice(7, 19);
    let root = id; for (let i = 0; i < 64; i++) { const p = E[root]?.parent?.to; if (!p || E[p]?.["copy-of"]?.from !== f) break; root = p; }
    return root === id ? `a copy of "${name}"` : `part "${E[id]["copy-of"].key}" of ${root} (a copy of "${name}")`;
  }
  worldBlueprints(): Record<string, { name?: string }> {
    const w = this.replica?.st?.entities?.["@world"]?.c ?? {};
    const out: Record<string, { name?: string }> = {};
    for (const [k, v] of Object.entries(w)) if (k.startsWith("blueprints:")) out[k.slice("blueprints:".length)] = (v ?? {}) as { name?: string };
    return out;
  }
  foldRecord(id: string): Record<string, unknown> | null {
    const e = (this.st.entities as Record<string, any>)[id];
    if (!e) return null;
    const m = this.mounts.get(id);
    return m ? { ...e, parent: m } : { ...e };
  }
  /** A thing's components as this body's replica folds them now (a copy), or null: what a write planned from them pins
   *  with expect, as a person's edit does (client/lib/editwrites.js compsOf). id and the component
   *  names are the authority's own, as requests.js encodes them. A purged component is the fold's PURGED itself, not a
   *  copy: the authority's expect counts a purged value equal to nothing, so a pin has to tell one apart and leave it out. */
  componentsOf(id: string): Record<string, unknown> | null {
    const c = this.replica?.st?.entities?.[id]?.c;
    return c ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === PURGED ? PURGED : structuredClone(v)])) : null;
  }
  /** A host's socket children as the replica folds them now: each one's id, as the authority has it, and its components
   *  (componentsOf). A write of the host's sockets map changes the children it names and retires the rest
   *  (shared/protocol/authority/sockets.js liftOps), so it pins these. */
  socketChildrenOf(id: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, e] of Object.entries((this.replica?.st?.entities ?? {}) as Record<string, any>))
      if (e?.c?.parent?.to === id && e.c.socket && typeof e.c.socket === "object" && !Array.isArray(e.c.socket) && e.c.socket !== PURGED)
        out[k] = this.componentsOf(k)!;   // a socket child as liftOps counts one (isSocketC)
    return out;
  }

  private reconcileFromFold() {
    const seen = new Set<string>();
    for (const [id, e] of Object.entries(this.st.entities)) {
      seen.add(id);
      this.entities.set(id, {
        id,
        model: String((e as any).model ?? ""), kind: kindOf(e),
        pos: (e as any).pos, yaw: (e as any).yaw ?? 0,
        ...((e as any).scale != null ? { scale: (e as any).scale } : {}),
        ...(Array.isArray((e as any).scale3) ? { scale3: (e as any).scale3 } : {}),   // a stretched thing stays stretched
        ...(Array.isArray((e as any).q) ? { q: (e as any).q } : {}),
        ...(colliderOf(e) != null ? { collide: String(colliderOf(e)) } : {}),   // the collider override decide() reads (#235): comp.collider, else the spawn's collide
        actor: (e as any).actor,
        ...((e as any).placer ? { placer: (e as any).placer } : {}),
        ...recordComponents(e as any),   // its components, flat (view.js): what a thing can DO
      });
    }
    for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.entities.delete(id);
    // a structure's cached plan goes with the structure (a re-attached one is planned afresh)
    for (const id of [...this.plans.keys()]) if (!(this.entities.get(id) as any)?.structure) this.plans.delete(id);
    // both mount species land in one view, as the old fold kept them:
    // entity cargo rides ent.parent, bodies ride st.mounts
    this.mounts.clear();
    for (const [id, e] of Object.entries(this.st.entities)) {
      const p = (e as any).parent;
      if (p) this.mounts.set(id, { to: p.to,
        ...(p.offset != null ? { offset: p.offset } : {}),
        ...(p.yaw != null ? { yaw: p.yaw } : {}),
        ...(p.q != null ? { q: p.q } : {}) });   // the relative orientation (PROTOCOL §9.1): foldRecord's parent must not lose it
    }
    for (const [id, m] of this.bodySeats) this.mounts.set(id, { ...m });   // bodies: presence, never the fold
    if (this.myOccupancy) this.mounts.set(this.name, { ...this.myOccupancy });
  }

  /** Remember our OWN says briefly, so a sidecar that airs one can be attested for it (the receipt is sha256 of the
   *  text the world logged; only the world's copy is authoritative). Small ring: a receipt is valid for 5 minutes. */
  private noteOwnSay(entry: any) {
    if (entry?.verb === "say" && entry?.actor === this.name && typeof entry?.args?.text === "string") {
      this.ownSays.set(entry.seq, String(entry.args.text));
      if (this.ownSays.size > 32) this.ownSays.delete(this.ownSays.keys().next().value as number);
      this.onMedia?.({ type: "speak", seq: entry.seq, text: entry.args.text });
    }
  }

  /** A world: take the next view of this body's own fold, and act on what changed (said in the protocol's terms,
   *  shared/protocol/viewdiff.js): percepts when `live`, supports always. The first view is diffed from nothing. */
  private async applyView(live: boolean, actor: string | null, ts: number | null) {
    const prev = this.st as any;
    const next = this.replica.view(prev);   // carries the chat window this body already holds
    const d = diffView(live ? prev : emptyView(), next);
    const was = new Map<string, any>();
    for (const c of d.things) if (!was.has(c.id)) was.set(c.id, this.entities.get(c.id));
    this.st = next;
    this.reconcileFromFold();
    for (const c of d.things) {
      try { this.onThingChange(c, was.get(c.id), live, actor ?? "world", ts ?? this.serverNow()); }
      catch (e) { console.error(`[agent] ${c.what} ${c.id}:`, e); }
    }
    // the world's own keys: the ground this body walks on, the sky, the grass
    const W = this.st as any;
    try {
      // the world's water is its own component (shape audit 10-16): it rides on the terrain args the ground is built from
      if ((d.world.includes("terrain") || d.world.includes("water")) && W.terrain) await this.buildTerrain(W.water ? { ...W.terrain, water: W.water } : W.terrain);
      if (d.world.includes("terrain")) { if (W.terrain) this.worldInfo.terrain = { seed: W.terrain.seed, size: W.terrain.size, amplitude: W.terrain.amplitude, flatRadius: W.terrain.flatRadius }; else delete this.worldInfo.terrain; }
      if (d.world.includes("sky")) this.skyState = W.sky as typeof this.skyState;
      if (d.world.includes("grass")) { if (W.grass) this.worldInfo.grass = this.grassInfo(W.grass); else delete this.worldInfo.grass; }
    } catch (e) { console.error("[agent] world change:", e); }
  }
  private grassInfo(args: any) {
    return { area: `${args.species ?? "grass"}, ${args.width ?? args.size}×${args.depth ?? args.size}m around ${JSON.stringify(args.center ?? [0, 0])}` };
  }
  private onThingChange({ id, what, comp }: { id: string; what: string; comp?: string }, was: any, live: boolean, actor: string, ts: number) {
    const now = this.entities.get(id);
    switch (what) {
      case "born":
        // a thing made already burning (a child that carries its own emitter: one lit on its own, or the translator's
        // particles:<name>) is lit in that instant, and narrates as lighting it, as a particles set would; otherwise a build
        if (live && now?.particles != null) { const fx = this.eff(id, this.serverNow()); if (fx.ok) this.noteEmitter(actor, id, null, now.particles, fx.pos, ts); else { this.noteEffGap(id, fx.why); this.noteBuild(actor, now?.pos); } }
        else if (live) this.noteBuild(actor, now?.pos);
        this.trackSupport(this.syncSupport(id));   // a placed thing is a thing bodies can rest on (#17)
        if (this.mounts.has(id)) this.dropSupport(id);   // …unless it rides a parent (it collides as the parent)
        break;
      case "pose":
        if (live) this.noteBuild(actor, now?.pos);
        this.trackSupport(this.syncSupport(id));   // support follows the thing it belongs to
        break;
      case "gone":
        // …and removing a burning thing puts its emitter out
        if (live && was?.particles != null) this.noteEmitter(actor, id, was.particles, null, was?.pos, ts);
        else if (live) this.noteBuild(actor, was?.pos);
        this.dropSupport(id);
        break;
      case "parent":
        if (this.mounts.has(id)) this.dropSupport(id); else this.trackSupport(this.syncSupport(id));
        break;
      case "comp":
        // an emitter beginning, changing or ending is something you SEE happen (#25); gated on where it actually is
        if (comp === "particles" && live) {
          const fx = this.eff(id, this.serverNow());
          if (fx.ok) this.noteEmitter(actor, id, was?.particles ?? null, now?.particles ?? null, fx.pos, ts);
          else this.noteEffGap(id, fx.why);
        }
        // a motion moves its support, and a collider override changes the policy its walking collider was fitted with
        if (comp === "motion" || comp?.startsWith("motion:") || comp === "collider") this.trackSupport(this.syncSupport(id));
        break;
    }
  }

  /** A chat line heard ({seq, ts, actor, args: {text}}): the inbox once, and a live line from someone else
   *  is an event (and a mention ping when it names this body). The window itself is the caller's (the fold, or hear). */
  private hearSay(entry: any, live: boolean) {
    const { args, actor, ts } = entry;
    // history lands in the inbox ONCE, so a freshly-joined agent has
    // context — and a reconnect's replayed tail is deduped by seq instead
    // of piling the same chat in again.
    const seq = typeof (entry as { seq?: unknown }).seq === "number" ? (entry as { seq: number }).seq : null;
    // only real log seqs (>= 0) dedupe — synthetic pre-history seqs descend
    if (seq != null && seq >= 0 && seq <= this.inboxSeen) return;
    if (seq != null && seq >= 0) this.inboxSeen = seq;
    this.inbox.push({ ts, kind: "say", who: actor, text: args.text, seq });
    // mention ping — @name or bare whole-word name, live messages only.
    // The agent's OWN say is deliberately never fanned out: the world log
    // echoes it back here, and delivering that echo as an incoming message
    // made every resident hear themselves (Fable: "моё собственное эхо").
    // It stays in the inbox — the scrollback record is honest — but it is
    // not an event.
    if (live && actor !== this.name) {
      // speech near this body feeds the activity pulse (a speaker whose
      // position is unknown — just arrived — counts as near)
      const pp = this.people.get(actor)?.pose;
      if (!pp || Math.hypot(pp.p[0] - this.pos.x, pp.p[2] - this.pos.z) <= this.activityRadiusM)
        this.act30.says.set(actor, (this.act30.says.get(actor) ?? 0) + 1);
      // A null regex means this body has no usable name (a malformed tokens
      // entry). Not being mentionable is degraded, not fatal — the body still
      // hears the room; it just cannot be addressed by name.
      const mention = this.mentionsMe(String(args.text));   // the name, or the credential's display name (#184)
      if (mention) this.ping({ ts, kind: "mention", who: actor, text: args.text });
      this.onEvent?.({ ts, kind: "say", who: actor, text: args.text, mention });
    }
  }

  /**
   * A live `particles` attach / replace / remove near this body — ONE ambient
   * world-change percept, never per particle and never per frame (#25).
   *
   * Coalesced by (entity, component): the first change in a quiet period
   * speaks at once (someone lighting a fire beside you is news the moment it
   * happens), and everything inside the following window is folded into at
   * most one further line describing the NET result. So dragging a parameter
   * slider — twenty `comp` entries in ten seconds — is one "retunes", not
   * twenty, while a genuine fire→smoke→out sequence still ends up truthful.
   *
   * Radius-gated like every other ambient sense, and silent for this body's
   * own authoring: the world log echoes your own verbs back to you, and
   * delivering that echo as an event is the self-echo bug (see `say`).
   * `nowMs`/`setTimer` are injectable for tests.
   */
  private noteEmitter(actor: string | undefined, id: string, before: unknown, after: unknown,
                      pos: number[] | undefined, ts: number) {
    if (!actor || actor === this.name || actor === "world") return;
    if (pos && Math.hypot(pos[0] - this.pos.x, pos[2] - this.pos.z) > this.activityRadiusM) return;
    const slot = this.emitterNarration.get(id);
    if (slot) {                       // inside the quiet window — fold, don't speak
      slot.latest = after;
      slot.actor = actor;
      return;
    }
    const line = transitionLine(actor, id, emitterTransition(before, after));
    if (line) {
      this.act30.builds++;            // it feeds the activity digest like any build
      this.onEvent?.({ ts, kind: "world-change", who: actor, text: line });
    }
    this.openEmitterWindow(id, actor, after);
  }

  private openEmitterWindow(id: string, actor: string, announced: unknown) {
    const close = () => {
      const slot = this.emitterNarration.get(id);
      if (!slot) return;
      this.emitterNarration.delete(id);
      const t = emitterTransition(slot.announced, slot.latest);
      if (!t) return;                 // the burst netted out to what we already said
      const line = transitionLine(slot.actor, id, t);
      if (line) {
        this.act30.builds++;
        this.onEvent?.({ ts: Date.now(), kind: "world-change", who: slot.actor, text: line });
      }
      // A continuous burst speaks once per window rather than being silenced
      // forever by its own persistence — same rule the act refractory uses.
      this.openEmitterWindow(id, slot.actor, slot.latest);
    };
    const timer = setTimeout(close, EMITTER_COALESCE_MS);
    // never hold the process open for a decoration
    (timer as unknown as { unref?: () => void }).unref?.();
    this.emitterNarration.set(id, { announced, latest: announced, actor, timer });
  }

  /** The push half of sky perception (the pull half is look()). Runs at 1Hz
   *  off tick(); the forecast cursor keeps each check O(1). First observation
   *  after a join initializes SILENTLY — arrival narration is look()'s job;
   *  this only speaks when something CHANGES while the body is present.
   *  `nowMs` is injectable for tests. */
  private skyStamp: { seq: number; by: string } | null = null;
  checkSky(nowMs = Date.now()) {
    if (!this.skyState) return;
    const eff = effectiveSky(this.skyState, nowMs, this.skyCursor);
    this.skyCursor = eff.cursor;
    const key = `${eff.source}:${eff.seg?.idx ?? "-"}:${eff.weather ?? "-"}`;
    // the canonical clock decides whether day phases can move (#65) — under a
    // real clock the folded bag no longer carries rate at all
    const advancing = effectiveClock(this.skyState, nowMs).mode !== "fixed";
    const phase = advancing ? dayPhase(hoursAt(this.skyState, nowMs)) : null;
    if (this.lastSkyKey === null) {
      this.lastSkyKey = key;
      this.lastDayPhase = phase;
      return;
    }
    if (key !== this.lastSkyKey) {
      this.lastSkyKey = key;
      if (eff.weather) {
        const why = eff.source === "forecast"
          ? ` (forecast — policy sky seq ${eff.seq ?? this.skyStamp?.seq ?? "?"} by ${eff.by ?? this.skyStamp?.by ?? "?"})`
          : eff.source === "manual" ? ` (${eff.by ?? this.skyStamp?.by ?? "someone"} overrode the forecast — holds until the next scheduled change)` : "";
        this.onEvent?.({ ts: nowMs, kind: "weather", who: "world", text: `world weather: ${eff.weather}${why}` });
      }
    }
    if (phase !== null && phase !== this.lastDayPhase) {
      this.lastDayPhase = phase;
      const line = { dawn: "dawn breaks", day: "full daylight", dusk: "dusk settles", night: "night falls" }[phase];
      this.onEvent?.({ ts: nowMs, kind: "weather", who: "world",
        text: `${line} (hour ${hoursAt(this.skyState, nowMs).toFixed(1)})` });
    }
  }

  /** Recent pings, for a host that polls instead of subscribing.
   *
   *  🔴 BOUNDED (2026-08-16). This array grew forever: the live path is
   *  `onPing` (net-server subscribes), and `takePings` — the only drain — has no
   *  caller in this repo. So on a push host the array accumulated every mention,
   *  approach and reach for the life of the process and nothing ever read it.
   *
   *  Kept rather than deleted because a PLAIN-MCP host has no push channel and
   *  polling is its documented path (AGENTS.md says digests are "held and handed
   *  over each time you call the tool"). But it is a RING now, like every other
   *  buffer in this file — pings 64, heldActivity 8, malformedSeen 5. An
   *  unbounded buffer whose only consumer is optional is a leak with a plan. */
  private static readonly PING_RING = 64;

  private ping(p: { ts: number; kind: "mention" | "approach" | "depart" | "reach" | "touch"; who: string; text?: string }) {
    this.pings.push(p);
    if (this.pings.length > WorldAgent.PING_RING) this.pings.splice(0, this.pings.length - WorldAgent.PING_RING);
    this.onPing?.(p);
  }

  takePings() {
    const out = this.pings;
    this.pings = [];
    return out;
  }

  private terrainRev = 0;       // build generation: bumped when a terrain request starts
  private navTerrainRev = 0;    // committed terrain generation: route grids key on this
  /** A heightmap terrain received but not yet buildable — its grid has not arrived. The last ground stands
   *  (never noise in its place); tick() retries the grid, and the arrival builds THIS bag, once. */
  private pendingTerrain: { args: any; rev: number; grid: string } | null = null;
  private async buildTerrain(args: any) {
    // Builds can overlap (a grid fetch is slow, a terrain edit is not): only the newest one may commit.
    const rev = ++this.terrainRev;
    if (!this.terrainSrc) {
      const r = await fetch(`${this.httpBase}/library/eidoverse/terrain.js`);
      this.terrainSrc = await r.text();
      (0, eval)(this.terrainSrc);
    }
    // Placed features and heightmaps (shared/terrainshape.js): the agent stands on the same shaped law the
    // client's mesh and the sim use. A heightmap's grid is fetched first; until it is here, the last ground
    // stands (pendingTerrain) — never noise in the heightmap's place.
    const shape = shapeParams(args);
    if (shape?.heightmap) {
      const base = this.httpBase;
      setGridFetcher(async (ref: string) => { const g = await fetch(`${base}/library/${ref}`); if (!g.ok) throw new Error(`${g.status}`); return g.json(); });
      const g = await requestGrid(shape.heightmap.grid);
      if (rev !== this.terrainRev) return;   // a newer terrain arrived while this one's grid was in flight
      if (!g) {
        // not here (yet): keep the ground we have rather than commit noise as this world's ground
        this.pendingTerrain = { args, rev, grid: shape.heightmap.grid };
        return;
      }
    }
    if (rev !== this.terrainRev) return;   // a newer terrain arrived while this one's grid was in flight
    this.pendingTerrain = null;
    const flat = flatHeightOf(args);   // a flat terrain is level ground at its height: no mesh to build
    const t = flat !== null ? { heightAt: () => flat } : (globalThis as any).makeTerrain({ ...args, layers: [] });
    this.terrain = shape ? { heightAt: shapedHeightAt(t.heightAt, args) } : t;
    this.navTerrainRev++;       // only committed ground invalidates a route grid
    this.water = waterParams(args);
    const waterKey = this.water ? JSON.stringify([this.water.level, args.size, args.water]) : null;
    if (waterKey !== this.waterKey) { this.waterKey = waterKey; this.endFloat(); }
    if (this.water && this.statureFor !== this.avatar) this.measureStature();
    const size = typeof args?.size === "number" ? args.size : 80;
    this.waterKinds = this.water
      ? analyzeWater((x, z) => this.heightAt(x, z), size, { level: this.water.level, kind: args.water?.kind, flow: args.water?.flow },
        waterGridSeg(size))   // the browser's grid, so both read the same water
      : null;
    // …and a body that falls in floats on the same water, rising and falling on the same waves
    void setWaterField(this.waterFieldNow());
    // the settle sim clamps against the SAME ground the walking clamp reads —
    // not one height sampled at the fall site (#17)
    void setHeightField((x, z) => this.heightAt(x, z));
  }

  /** The standing height the water is measured against: the current body's, once measured; until then an
   *  ordinary adult's (the measurement is one small read of the avatar's header). */
  stature(): number { return this.bodyH ?? STATURE_FALLBACK; }
  /** Measure the current body's height (rigbones.ts bodyHeightFor), guarded by generation so a slow reply
   *  for a body since replaced is never applied. Resolves once this measurement is settled. */
  measureStature(): Promise<void> {
    const gen = ++this.statureGen, avatar = this.avatar;
    this.statureFor = avatar; this.bodyH = null;
    return bodyHeightFor(this.httpBase, avatar).catch(() => null).then((h) => {
      if (gen === this.statureGen) this.bodyH = h ?? STATURE_FALLBACK;
    });
  }
  /** Leave the floating column: the next float starts from wherever the body then is. */
  private endFloat() { this.float = { on: false, y: 0, vy: 0 }; }

  /** This world's water for the ragdoll sim (physics.ts setWaterField) — asserted before every run, like the
   *  ground, because the sim module is process state and one process can host agents in several worlds. */
  private waterFieldNow() {
    const A = this.waterKinds, level = this.water?.level;
    if (!A || level == null) return null;
    if (this.waterFieldMemo?.A !== A || this.waterFieldMemo.f.level !== level)   // read every physics step: build it once
      this.waterFieldMemo = { A, f: { level, sample: (x: number, z: number) => A.sample(x, z), time: () => waveClock(this.serverNow()) } };
    return this.waterFieldMemo.f;
  }
  private waterFieldMemo: { A: unknown; f: { level: number; sample: (x: number, z: number) => unknown; time: () => number } } | null = null;

  heightAt(x: number, z: number): number {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }

  /** Each structure's plan, per entity id, for the revision it holds now: the same object is a hit without a read;
   *  else the same content (JSON) is (the view clones every component every view, view.js viewOf, so a received
   *  revision's object doesn't outlive the next log entry); else it is planned afresh. Entity transforms and each
   *  walk's support basis stay outside this cache. */
  private plans = new Map<string, { data: object; json: string; plan: ReturnType<typeof planStructure> }>();
  private planFor(id: string, data: unknown): ReturnType<typeof planStructure> {
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
    for (const e of this.entities.values()) if ((e as any).structure === data) return this.planFor(e.id, data);
    return planStructure(data);
  }

  /** The upper storey of a griddled building that the feet stand on at
   *  (x, z), if any: the structure, the level's index and the floor's world
   *  height. Griddled structures are outside the headless colliders (their
   *  walls are routed by walkStructures), so this is how the feet, a walk's
   *  support and its routes know such a floor is there (ew#140). A storey
   *  counts when it rests above its building's base, its floor is more than
   *  the walk grid's step (NAV_STEP, the one walker's, 0.8 m) above the terrain under the
   *  point, `yHint`, the feet's height, is no more than a route step
   *  (ROUTE_STEP_METRES, 0.5 m) below it and less than its storey's height
   *  (the grid's wallH, the router's floor-to-floor) above it, and it has a
   *  tile under the point and, on a cell a diagonal cuts, a floor on the half
   *  the point falls in: the other half is a hole. A level resting on the
   *  base or below it, such as a ground floor at the base or a basement, is
   *  the terrain's: a body there walks on the terrain, in and out of the
   *  building, as the router's terrain walk expects. A ground floor declared
   *  above the base is a raised floor like any other. A floor within a body's
   *  step (NAV_STEP) of the terrain is the terrain's, such as a low porch: a
   *  body steps on and off it as it walks, and a floor route can't step down
   *  off its edge, so standing on it would keep a body that walked onto it
   *  there. That's decided under the point, so a deck over rising ground is
   *  the terrain's, for standing, where the ground comes within a step of it:
   *  a floor walk on the deck still crosses that part at the deck's height
   *  (walkProbeGround), and the feet stand on the terrain there once the walk
   *  ends, as on a porch. Feet anywhere in the storey count, on something
   *  placed on its floor too (a table, a bed, a landing), so a body standing
   *  up on a table upstairs walks on from that floor. Where two storeys'
   *  ranges meet, feet within a route step below the upper floor and still
   *  under the lower storey's height, the highest floor wins: feet stepping
   *  up onto it are on it. `yHint` only picks which real floor qualifies and
   *  never becomes the height, so a body far above the house is not on its
   *  top storey. Each building is placed where it
   *  is now (eff), as walkStructures places it, and one that can't be read
   *  costs only itself. */
  private storeyUnder(x: number, z: number, yHint = this.pos.y): { entity: string; level: number; height: number } | null {
    const terrain = this.heightAt(x, z), nowMs = this.serverNow();
    let best: { entity: string; level: number; height: number } | null = null;
    for (const e of this.entities.values()) {
      const data = recordComponents(e).structure;
      if (!data) continue;
      try {
        const plan = this.planFor(e.id, data);
        if (!plan.levels.some((lv: any) => lv.base > 0)) continue;
        const fx = this.eff(e.id, nowMs);
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

  /** The floors a floor walk tells apart at (x, z): the ground (entity
   *  null), which takes the terrain and every floor within a step of it, as
   *  storeyUnder does for standing, and each griddled storey with a floor at
   *  the point, at any height. Where the walk's own floor, `own`, lies within
   *  a step of the terrain either way, as at a deck's low end, the ground
   *  there is that floor: a floor walk crosses it at the floor's height, and
   *  the feet stand on the terrain once it ends (storeyUnder). */
  private floorsAt(x: number, z: number, own: { entity: string; level: number }): { entity: string | null; level: number; height: number }[] {
    type Floor = { entity: string | null; level: number; height: number };
    const terrain = this.heightAt(x, z), nowMs = this.serverNow();
    const floors: Floor[] = [{ entity: null, level: -1, height: terrain }];
    for (const e of this.entities.values()) {
      const data = recordComponents(e).structure;
      if (!data) continue;
      try {
        const plan = this.planFor(e.id, data);
        const fx = this.eff(e.id, nowMs);
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

  /** Of the floors a floor walk tells apart at (x, z) (floorsAt), the one a
   *  destination's height means, by move's rule for a height, the
   *  navgrid's (mcpl/navgrid.ts, route): the one nearest y, no more than
   *  `above` (NAV_STEP unless given) above it and, with `below`, no more than
   *  that below it; null when none is. Ties go to the walk's own floor, then
   *  to the higher. With `body`, y is a body's root and the floor is the one
   *  it is on: the highest that fits, not the nearest, since a body lies up to
   *  RAGDOLL_ROOT_DROP above its root, and none stands with a floor less than
   *  that above its feet. Surfaces placed there are the navgrid's to read
   *  (placedNear). */
  private floorMeant(x: number, z: number, y: number, near: { above?: number; below?: number },
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

  /** Whether something placed on a floor walk's own floor stands at about
   *  height y at (x, z): the top of a collider over the point within the
   *  destination's bounds (`above` and `below`, a step each unless given),
   *  no lower than the floor, as the walk's own navgrid probe stands
   *  (onOrAboveFloor), and under `ceiling`, the next floor above it there,
   *  on which anything higher rests. */
  private placedNear(x: number, z: number, y: number, near: { above?: number; below?: number }, floor: number, ceiling = Infinity): boolean {
    const probe = navProbe((px, pz) => this.heightAt(px, pz));
    if (!probe) return false;
    const top = inWorld(this.world, () => probe.surfaceUnder(x, z, Math.min(y + (near.above ?? NAV_STEP), ceiling - 0.02)));
    return top > this.heightAt(x, z) + 1e-6 && top >= y - (near.below ?? NAV_STEP) && top >= floor - 0.02;
  }

  /** The height the feet belong at: an upper storey's floor under them
   *  (storeyUnder), else the terrain. Every standing body's ground goes
   *  through here: the idle tick's, a stand-up's, and a flight's at its
   *  start and end (a walk's is its support's, walkSupport). A flight under way and a tumble's
   *  physics read the terrain alone, since griddled floors aren't headless
   *  colliders. */
  groundAt(x: number, z: number, yHint = this.pos.y): number {
    return this.storeyUnder(x, z, yHint)?.height ?? this.heightAt(x, z);
  }

  // ---- support surfaces (#17) ----------------------------------------------
  // A body settling headless used to see bare terrain: every placed floor —
  // a platform, a deck, the bell pavilion's slab — simply was not there, and
  // a body released above one settled through it to the dirt underneath.
  // The server already reads shape as data (GET /geom: bbox + up-facing flat
  // zones); each entity this agent knows about contributes support boxes to
  // the sim's collider map — the browser's own collider, fitted from the
  // model's triangles (meshFor → registerMeshSupport), whenever this process
  // can fetch and decode them; then walls, furniture and stairs are as solid
  // here as in a browser, for the ragdoll and the walking feet alike. The
  // summary path is the fallback: small solid things contribute their whole
  // box, room-scale things their floor DECKS as thin slabs (so a body can
  // rest on the pavilion floor without it sealing into a block) — floors,
  // not architecture.

  private geomCache = new Map<string, Promise<any | null>>();
  private supportIds = new Map<string, string[]>();
  /** A pre-join refusal's words, until its close says whether it is final (onclose). */
  private joinRefused: string | null = null;
  /** How long until the next dial after a drop or a full world (shared/redial.js: the browser's rule); reset by a join. */
  private redial = redialer();
  private removedUntil: number | null = null;   // a moderation removal's end (a kick's cooldown): reconnect then   // entity id -> registered box ids
  /** This agent's claim token on shared support boxes. Per INSTANCE, not per
   *  name: two agents can carry the same name across a reconnect, and a
   *  holder set that collapsed them would let the departing one release the
   *  arriving one's floors. */
  private readonly supportHolder = `agent#${++WorldAgent.holderSeq}`;
  private static holderSeq = 0;
  /** Every support sync currently in flight. Replay fires one per spawn and
   *  `/geom` is a network round trip, so for the first moment of a join the
   *  world's floors exist in the log but not yet in the sim — and a body
   *  released in that window falls through a platform that this agent simply
   *  had not finished learning about. supportReady() is the barrier; a settle
   *  that intends to claim placed-floor support waits on it. */
  private supportPending = new Set<Promise<void>>();

  /** Resolves once every support sync issued so far has landed. Re-checked in
   *  a loop because a sync can enqueue while we wait (a spawn replayed behind
   *  the one we were waiting on). Bounded so a hung fetch cannot freeze a
   *  body forever — a late floor is a bug, a body that never settles is
   *  worse. */
  private async supportReady(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (this.supportPending.size && Date.now() < deadline) {
      await Promise.race([
        Promise.all([...this.supportPending]),
        new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
  }

  /** Run a support sync and keep it visible to the barrier for its lifetime. */
  private trackSupport(p: Promise<void>) {
    this.supportPending.add(p);
    void p.finally(() => this.supportPending.delete(p));
  }

  /** Is anything on this entity animating right now?
   *
   *  A motion component is PARAMETERS, not frames: the browser evaluates a
   *  pendulum/spin/orbit/oscillate/path every frame and its collider rides along.
   *  A support box registered from the AUTHORED transform does not — it would
   *  sit where the swing used to be, and a body would come to rest on a floor
   *  that is no longer there. A ghost floor is worse than no floor: no floor
   *  is the honest pre-#17 answer for that entity, while a ghost floor is
   *  geometry this code invented.
   *
   *  Deliberately conservative — ANY motion, including a `motion:<part>` on a
   *  single named node, disqualifies the whole entity. A part motion leaves
   *  the entity's own transform alone, but the /geom summary that produced
   *  these boxes measured the model WITH that part in it, and nothing here
   *  can tell which deck belongs to the moving piece. Until headless
   *  evaluates the same deterministic motion the browsers do, the safe answer
   *  is to abstain. */
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
  /** The model's collision triangles, decoded from the bytes /library serves
   *  (shared by every agent in the process — see meshCache). */
  private meshFor(lib: string): Promise<CollisionMesh | null> {
    const key = `${this.httpBase}|${lib}`;
    let p = meshCache.get(key);
    if (p) { meshCache.delete(key); meshCache.set(key, p); return p; }   // most recently used last
    // bounded: a stalled /library must not hold up the /geom fallback, and
    // a failure is forgotten so a later sync tries again
    // governed: a few at a time, none too large (meshSlot, MESH_MAX_*)
    const fallback = (why: string) => { meshGovernor.fallbacks.set(key, why); return null; };
    p = meshSlot(async () => {
      const r = await fetch(`${this.httpBase}/library/${lib}`, { signal: AbortSignal.timeout(MESH_FETCH_MS) });
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
      p = fetch(`${this.httpBase}/geom?lib=${encodeURIComponent(lib)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((g) => (g && !g.error && g.bbox ? g : null))
        .catch(() => null);                            // no geometry is a soft state, never a crash
      this.geomCache.set(lib, p);
    }
    return p;
  }

  private async syncSupport(id: string) {
    const before = this.entities.get(id);
    if (!before?.model) return;  // only a model carries a collider
    if (solidOffRecord(before)) { this.dropSupport(id); return; }   // collision off (collider.enabled): nothing to stand on
    // A moving thing supports nothing here — and stops supporting the moment
    // it starts moving, so this is the drop path as well as the skip path.
    // Mounted cargo is the same story told by a different verb: it rides a
    // parent whose transform this code does not track.
    if (this.hasActiveMotion(before) || this.mounts.has(id)) { this.dropSupport(id); return; }
    const [g, mesh] = await Promise.all([this.geomFor(before.model), this.meshFor(before.model)]);
    // Re-read, and re-CHECK: an id can be removed and respawned as something
    // else while its geometry is in flight, and "the entity still exists" is
    // not the same question as "it is still the thing I fetched for". Without
    // the lib comparison a crate's decks could land under a lamp post that
    // merely inherited its id.
    const e = this.entities.get(id);
    if ((!g && !mesh) || !e || e.model !== before.model) return;
    // started moving, or got mounted, while its geometry was in flight —
    // replay folds a mount right behind the spawn that triggered this fetch
    if (this.hasActiveMotion(e) || this.mounts.has(id) || solidOffRecord(e)) { this.dropSupport(id); return; }
    const s = e.scale ?? 1;
    // a stretched thing's per-axis scale (scale3), beside the one number decide() reads, as the browser's applyScale
    const s3 = Array.isArray(e.scale3) && e.scale3.length === 3 && e.scale3.every(Number.isFinite) ? e.scale3 as number[] : [s, s, s];
    // A transform that cannot be a place in the world registers NOTHING —
    // and abstains BEFORE the drop, leaving whatever support already stands.
    // This is the layer that turned one malformed packet into everyone's
    // outage: undefined rode e.pos into fitSupportBox and killed the shared
    // door (#88). This holds if such a transform arrives anyway.
    if (!isFiniteVec3(e.pos) || !Number.isFinite(s) || !Number.isFinite(e.yaw ?? 0)) {
      // If position is readable, the entity has moved and any box at its old
      // address is now a ghost floor. Retaining existing support is correct
      // only when position itself is unreadable and the move did not land.
      if (isFiniteVec3(e.pos)) this.dropSupport(id);
      this.noteMalformed("support-sync", { id, pos: e.pos, yaw: e.yaw, scale: e.scale });
      return;
    }
    this.dropSupport(id);
    const xform = { position: e.pos, yaw: e.yaw ?? 0, scale: s, ...(Array.isArray(e.scale3) ? { scale3: s3 } : {}) };
    // lying down (a tumbling engine's rest, or a hand's tilt): its box turned into the frame of its own yaw, and no
    // decks or grid (those are measured upright); read by its yaw alone it was a phantom deck where it no longer stands
    // A stretch acts on the model's own axes, before its rotation, so a stretched box is stretched first and then turned,
    // and is registered at scale 1 (the turn would carry a stretch applied afterwards onto the wrong axes).
    const stretched = Array.isArray(e.scale3) && !(Math.abs(s3[0]) === Math.abs(s3[1]) && Math.abs(s3[1]) === Math.abs(s3[2]));
    const st = (v: number[]) => stretched ? v.map((x, i) => x * Math.abs(s3[i])) : v;
    const lying = Array.isArray(e.q) && e.q.length === 4 && g?.bbox?.min ? lyingFrame(e.q, st(g.bbox.min), st(g.bbox.max)) : null;
    if (lying) {
      const bid = `${this.world}/${id}`;
      void registerSupport(this.supportHolder, bid, lying.min, lying.max,
        stretched ? { position: e.pos, yaw: lying.yaw, scale: 1 } : { ...xform, yaw: lying.yaw });
      this.supportIds.set(id, [bid]);
      return;
    }
    // The real collider when the triangles are to hand: fitted from the same
    // mesh, with the same override, by the same decide() a browser runs — so
    // a room-scale interior holds this body up AND holds it back, walls and
    // furniture included. Everything below is the summary fallback, for a
    // model whose bytes could not be fetched or decoded here.
    if (mesh) {
      const bid = `${this.world}/${id}`;
      // awaited, unlike the summary boxes below: the fit itself is what a
      // joining body's feet wait on (supportReady), and it cannot throw.
      // The id is RESERVED before the wait, so a remove, mount or close
      // during it has something to drop — and if one happened, the fit that
      // lands afterwards is taken straight back out.
      this.supportIds.set(id, [bid]);
      const ok = await registerMeshSupport(this.supportHolder, bid, mesh, { ...xform, collide: e.collide, model: e.model });
      const now = this.entities.get(id);
      const superseded = !this.supportIds.get(id)?.includes(bid);
      if (superseded || this.closed || !now || now.model !== e.model || this.mounts.has(id) || this.hasActiveMotion(now)) {
        if (ok && (superseded || this.closed)) void removeSupport(this.supportHolder, bid);
        else if (ok) this.dropSupport(id);
        return;
      }
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
        const t = decks[k], bid = `${this.world}/${id}#${k}`;
        void registerSupport(this.supportHolder, bid, [t.x[0], t.y - 0.15, t.z[0]], [t.x[1], t.y, t.z[1]], xform);
        ids.push(bid);
      }
    } else if (!roomScale) {
      const bid = `${this.world}/${id}`;
      // Floor-shaped things whose box top is a KNOWN lie (a blanket, a
      // rubble pile — the browser collides those against exact triangles
      // for the same reason) get heightfield support from the served grid,
      // and NEVER the box: the box top floats bodies by the documented
      // 0.73m/0.44m (#84). Identification uses the summary's `lie` through
      // the same shared classifier the browser's decide() runs; a summary
      // without `lie` (older server) cannot accuse anyone, so honest small
      // boxes keep today's behavior either way.
      const cls = decideSupportClass({ w, d, h, lie: Number.isFinite(g.lie) ? g.lie * a3[1] : 0 });
      if (cls.uneven) {
        // the certification is a MODEL-frame bound; this spawn's scale must
        // not stretch it past the agreed world bound (#94 review B1) — a
        // grid certified to 3cm serves a ×1.25 spawn (3.75cm) but not a ×2
        const stretched = Number.isFinite(g.topGrid?.certSpread) && g.topGrid.certSpread * a3[1] > CERT_MAX_WORLD;
        const fit = !stretched && await registerSupportGrid(this.supportHolder, bid, g.topGrid, xform);
        if (fit) ids.push(bid);
        // refused grid (absent/malformed/oversized/over-stretched): a
        // DECLARED abstention — the body finds terrain, which is at worst
        // the browser's under-the-rubble disagreement, never a floating
        // false floor
        else this.noteSupportSeam(id, `uneven top (lie ${(g.lie * a3[1]).toFixed(2)}m) without a usable grid${stretched ? ` (certification stretched past ${CERT_MAX_WORLD}m at ×${a3[1]} high)` : ""} — abstaining, no box`);
      } else {
        void registerSupport(this.supportHolder, bid, g.bbox.min, g.bbox.max, xform);
        ids.push(bid);
      }
    }                                                   // room-scale with no readable decks: browser-only, declared
    if (ids.length) this.supportIds.set(id, ids);
  }

  private dropSupport(id: string) {
    for (const bid of this.supportIds.get(id) ?? []) void removeSupport(this.supportHolder, bid);
    this.supportIds.delete(id);
  }

  /** Every collider query a tick makes is about this agent's own world. */
  private tick() { inWorld(this.world, () => this.tickInWorld()); }
  private respawning = false;
  /** Back to the world's arrival place after a fall out of it (shared/spawn.js spawnOf), the reason on the record (move teleport). */
  async respawnFell() {
    const sp = spawnOf(this.replica?.st); if (!sp) return;
    this.respawning = true;
    try {
      this.target = null; this.flight = null; this.endFloat(); this.vy = 0;
      this.pos.x = sp.pos[0]; this.pos.y = sp.pos[1]; this.pos.z = sp.pos[2]; this.yaw = sp.yaw;
      const r = await this.request("move", { to: sp.pos, teleport: true, reason: FELL });
      if (r?.ok) { this.trackAt = [...sp.pos]; this.trackArrived = true; }
      this.lastWalkNote = `you fell below this world's bounds: you are back at its arrival place (${sp.pos.map((n: number) => n.toFixed(1)).join(", ")})${r?.ok ? "" : `, though the authority said ${r?.refused?.code ?? "nothing"}`}`;
    } finally { this.respawning = false; }
  }
  // ---------------- anim (R 10-17 15:31/15:32): one way to play a pose or a clip, by name or live ----------------
  /** The anims this body plays or holds now, when they last (mode loop or hold), oldest first; a once anim ends by itself,
   *  silently. Each is a LAYER (R 10-17 16:26): a clip (held as the presence clip), the named pose wings-folded, a held
   *  frame of live keys (joints, or tracks in mode hold: the held pose), or live tracks looping (relayed to every client).
   *  A new one replaces only the one in its own layer: a pose struck over a sit leaves the sit playing. */
  anims: { name: string; mode: "loop" | "hold"; kind: "clip" | "pose" | "live" | "track"; clip?: string; bodyMode?: string }[] = [];
  /** The newest of them (or null). */
  get anim() { return this.anims.at(-1) ?? null; }
  /** The body-mode (R 10-17 15:34/15:45: was posture, the clip label): stand | sit | lie | swim | fly | fall, every one
   *  declarable for looks (anim {bodyMode}; an anim may ask for one: the built-in sit and lie do, and its end by a move,
   *  another anim or a fall returns to stand; anim {stop} leaves it as it is, R 16:26); the mover's real transitions
   *  (flight, water) set it and end a declaration. Published as presence bodyMode (bodyModeNow). A self-declared
   *  description: it grants nothing (take-off still wants the fly permission). */
  modeTracker = bodyModeTracker();
  get bodyMode() { return this.modeTracker.declared ?? "stand"; }
  set bodyMode(m: string | null) { this.modeTracker.declare(m === "stand" ? null : m); }
  /** A flight that has come down on its own stays LANDED until something ends it, so only its other phases fly. */
  private airborne() { return !!this.flight && this.flight.phase !== "GROUND" && this.flight.phase !== "LANDED"; }
  /** The mode this body publishes now: a declaration, else the mover's (fly, swim, stand); on a station, sit. */
  bodyModeNow() { const m = this.modeTracker.step({ flying: this.airborne() && this.clip !== "ragdoll", swimming: this.clip === "swim" || this.clip === "tread" }); return m === "stand" && this.myOccupancy ? "sit" : m; }
  /** The clip a sit at rest plays: the last sitting anim's (sitchair keeps the chair's height), else sit. */
  private sitRest = "sit";
  /** A body-mode's own resting anim (R 10-17 16:26): stand → idle, sit → the sit loop, lie → lie, swim → tread, fly →
   *  soar; null where something else owns the clip (a station's occupant, a real flight, a fall). Never the bind pose. */
  restClip(mode: string): string | null {
    if (mode === "stand") return this.myOccupancy ? null : "idle";
    if (mode === "sit") return this.myOccupancy ? null : this.sitRest;
    if (mode === "lie") return "lie";
    if (mode === "swim") return "tread";
    if (mode === "fly") return this.flight ? null : "soar";
    return null;
  }
  /** A clip held in mode hold: the time it freezes at (presence clipTime with clipRate 0). */
  animHold: number | null = null;
  /** The ends this body heard (newest last; presence only, never logged): what an agent reads as `stopped {name, why}`. */
  animStops: { name: string; why: string; ts: number }[] = [];
  /** Anims that lasted ended (every one, or those `which` picks): tell the agent once each, `stopped {name, why}`, and
   *  forget them. Ended by anim {stop}, the body-mode stays; otherwise an anim that set it returns it to stand. */
  animEnded(why: string, which: (a: WorldAgent["anims"][number]) => boolean = () => true) {
    const gone = this.anims.filter(which); if (!gone.length) return;
    this.anims = this.anims.filter((a) => !gone.includes(a));
    for (const a of gone) {
      if (a.kind === "clip") this.animHold = null;
      if (a.bodyMode && why !== "stopped") this.bodyMode = "stand";
      const ts = Date.now(); this.animStops.push({ name: a.name, why, ts }); if (this.animStops.length > 20) this.animStops.shift();
      const text = `stopped {name: ${JSON.stringify(a.name)}, why: ${JSON.stringify(why)}}`;
      this.inbox.push({ ts, kind: "act", who: this.name, text }); this.onEvent?.({ ts, kind: "act", who: this.name, text });
    }
  }
  /** Start an anim that lasts: the one in its own layer before it ends with why "replaced" (R 15:34; a once overlays). */
  animBegan(a: WorldAgent["anims"][number], holdAt: number | null = null) {
    this.animEnded("replaced", (b) => b.kind === a.kind);
    this.anims.push(a); if (a.bodyMode && isBodyMode(a.bodyMode)) { this.bodyMode = a.bodyMode; if (a.bodyMode === "sit" && a.clip) this.sitRest = a.clip; }
    if (a.kind === "clip") this.animHold = a.mode === "hold" ? holdAt : null;
  }
  /** anim {stop} (R 10-17 16:26/16:27). which null: every anim this body plays or holds, each layer, and any held pose;
   *  then the CURRENT body-mode's own resting anim plays (restClip; never the bind pose) and the body-mode is unchanged
   *  (to stand up, declare stand or walk). A name: only that layer, the rest going on; "live" names every ad-libbed one
   *  (joints, tracks). Returns what was stopped (empty: nothing by that name was playing, which is a note, not an error). */
  async stopAnims(which: string | null): Promise<string[]> {
    const hit = this.anims.filter((a) => which == null || a.name === which);
    this.animEnded("stopped", (a) => hit.includes(a));
    const kinds = new Set(hit.map((a) => a.kind));
    if (which == null || kinds.has("live")) { if (this.heldPose && (which == null || this.heldPoseAuthored)) this.setPose(null); }
    if ((which == null || kinds.has("track")) && this.joined && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "anim", stop: true }));
    // folding the wings open waits for the bones: a walk (it bumps bodyEpoch) or an anim begun meanwhile keeps its clip
    const epoch = this.bodyEpoch, before = new Set(this.anims);
    if ((which == null || kinds.has("pose")) && this.wingsFolded) await this.foldWings(false);
    // …a tracks loop plays in its own layer and takes no clip, so one begun meanwhile doesn't (house 6340433633)
    const newer = this.bodyEpoch !== epoch || this.anims.some((a) => !before.has(a) && a.kind !== "track");
    if ((which == null || kinds.has("clip")) && !newer) {
      if (this.clip === "ragdoll") this.setPose(null);   // a slump ends in the rest too (setPose stands it, and stops its sim)
      const rest = this.restClip(this.bodyModeNow()); if (rest) { this.stop(); this.clip = rest; }
    }
    return hit.map((a) => a.name);
  }
  /** Every tick: an anim that lasts ends when what holds it is gone (a walk took the clip, a ragdoll, a clear, the wings
   *  opened), with why: moved, knocked over, cleared, replaced. */
  private watchAnim() {
    for (const a of [...this.anims]) {
      const end = (why: string) => this.animEnded(why, (b) => b === a);
      if (a.kind === "clip" && this.clip !== a.clip) end(this.clip === "ragdoll" ? "knocked over" : ["walk", "run", "swim", "tread"].includes(this.clip) || this.target ? "moved" : "replaced");
      else if (a.kind === "pose" && !this.wingsFolded) end("stopped");
      else if (a.kind === "live" && !this.heldPose) end(this.clip === "ragdoll" ? "knocked over" : this.target ? "moved" : "cleared");
      else if ((a.kind === "live" || a.kind === "track") && this.clip === "ragdoll") end("knocked over");
      // a tracks loop ends on a walk, as anim's contract says of every anim: a move ends it. Treading water is a
      // swimmer at rest, not a move, so a loop started while treading plays on
      else if (a.kind === "track" && (this.target || ["walk", "run", "swim"].includes(this.clip))) this.endTrackLoop("moved");
    }
  }
  /** End the tracks loop alone (its layer, not a held pose or a clip), and tell the renderers so: a walk ends it, and a
   *  new loop on this body takes its place rather than playing beside it (tools.ts's anim). */
  endTrackLoop(why: string) {
    const had = this.anims.some((a) => a.kind === "track");
    this.animEnded(why, (a) => a.kind === "track");
    if (had && this.joined && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "anim", stop: true }));
  }
  private tickInWorld() {
    this.watchAnim();
    if (!this.joined) return;
    const dt = TICK_MS / 1000;
    // The world's physics (@world.physics-engine): stamp where each flying thing IS into the entity view — the same engine state
    // every renderer draws (shared/protocol/replica.js simAt, advanced to the authority's clock) — so look() sees a punted crate
    // where it is, and, at rest, where it came to rest. Support rebuilds when a thing comes to rest.
    // a heightmap terrain waiting on its grid: ask again (requestGrid backs off by itself), and build the
    // waiting bag — only if it is still the newest — the moment the grid is here
    const pend = this.pendingTerrain;
    if (pend && pend.rev === this.terrainRev) {
      void requestGrid(pend.grid).then((g) => {
        if (g && this.pendingTerrain === pend && pend.rev === this.terrainRev) { this.pendingTerrain = null; void this.buildTerrain(pend.args); }
      });
    }
    // a heightmap world's engine waits for its grid (as the browser's does, thingphysics.js): noise ground would diverge
    const simShape = this.replica?.sim?.sim?.terrain?.shape;
    const simReady = shapeReady(simShape);
    if (!simReady) void requestGrid(simShape.heightmap.grid);
    const sim = simReady ? this.replica?.simAt?.(this.serverNow()) : null;
    if (sim?.bodies) {
      for (const sid in sim.bodies) {
        const b = sim.bodies[sid]; const id = idOut(sid);
        const e = this.entities.get(id);
        // a body's origin means something only with its rotation (a tumbling engine lays things down): take both
        if (e && Array.isArray(b.p)) e.pos = [b.p[0], b.p[1], b.p[2]];
        if (e && Array.isArray(b.q) && b.q.length === 4) e.q = [b.q[0], b.q[1], b.q[2], b.q[3]];
        if (b.resting && !this.simRested.has(id)) {
          this.simRested.add(id);
          if (e) this.trackSupport(this.syncSupport(id));
        } else if (!b.resting && !this.simFlying.has(id)) { this.simFlying.add(id); this.simRested.delete(id); this.dropSupport(id); }   // a flying thing holds nobody up
        if (b.resting) this.simFlying.delete(id);
      }
    }
    // ambient sky perception rides the body tick at 1Hz — cheap (cursor keeps
    // it O(1)) and quiet (emits only on segment/override/day-phase boundaries)
    if (Date.now() - this.lastSkyCheck >= 1000) {
      this.lastSkyCheck = Date.now();
      this.checkSky();
    }
    // Being dragged: the dragger's stream owns pos/pose/yaw — no walking, no
    // terrain clamp (a lifted body is off the ground on purpose). A silent
    // dragger loses the body; the last streamed pose just holds, lying
    // wherever it was dropped.
    if (this.draggedBy && Date.now() - this.dragAt > 1200) {
      this.draggedBy = null;                 // a silent dragger loses the body
      void this.settleFromDrag(null);        // — and my own sim settles it
    }
    // Capture before an arrival clears the target: the completion tick uses
    // the same support that admitted the route, not a newly selected floor.
    const admittedHeight = this.target ? this.walkHeightAt : null;
    let moveX = 0, moveZ = 0, snap = false, distBefore = 0;
    if (!this.draggedBy && this.target) {
      const T = this.target, g = this.walkGate;
      // walk only as far as the authority has accepted (E1): the permit is a point on this leg it said yes to;
      // 'sync': the authority doesn't know where we stand yet
      let room = Infinity;
      if (g?.mode === "sync") room = 0;
      else if (g?.mode === "tracked") {
        room = g.permit ? Math.hypot(g.permit[0] - this.pos.x, g.permit[2] - this.pos.z) : 0;
        if (!g.busy && !(g.hold! > 0) && room < PERMIT_AHEAD && !this.permitAtTarget(g) && !this.blockerHolds(g)) this.extendPermit(g);
      }
      // a loose thing just shoved (shoveNow): for a moment the walk keeps the speed the shove left it, as a cap on the stride
      const capped = this.walkCap && Date.now() < this.walkCap.until ? this.walkCap.v : Infinity;
      if (capped < Infinity) room = Math.min(room, Math.max(0, capped) * dt);
      // ONE stride of the shared mover (shared/mover.js): the same stride the client takes and the authority checks.
      // The floor is the walk's admitted support (walkHeightAt: the live terrain, or the floor that admitted the route;
      // placed floors otherwise reach this body through the sim's support boxes, not its walk); what blocks is the
      // authority's permit, asked above, and the route the walk was planned on (walkTo).
      const walkFloor = this.walkHeightAt ?? ((x: number, z: number) => this.heightAt(x, z));
      // #235: with the colliders loaded the floor is what the feet will find (colliders.resolveColliders: placed floors and
      // stairs within the mover's step, else the walk's floor) — the same answer the collider pass below gives the stride
      const colliding0 = collidersReady() && !this.myOccupancy && !this.feetSettling;
      const floorAt = colliding0 ? (x: number, z: number, y?: number) => this.feetAt(x, z, y ?? this.pos.y, walkFloor) : walkFloor;
      // WATER (upstream #242) is the mover's too: handed the world's level (env.waterAt) and this body's measured stature,
      // the stride wades (dragged) or swims (a stroke's pace, afloat at the chest) — no water arithmetic here.
      const water = this.water;
      // feet on the live ground BEFORE the stride: terrain that loads late or changes under the walker lifts the body here, so
      // the mover judges a ledge AHEAD against where the feet now stand — not against a y the ground has since left (the
      // lifecycle test's mid-walk terrain swap; before 10-15 one refused stride, then the feet clamp, then on)
      // (colliding, the feet below do this themselves, falling to a lower floor rather than jumping to it)
      if (!colliding0 && !this.flight && !this.draggedBy && this.pins.size === 0) { const g0 = floorAt(this.pos.x, this.pos.z); if (Number.isFinite(g0) && (!water || g0 >= water.level)) this.pos.y = g0; }
      const r = walkToward({ pos: [this.pos.x, this.pos.y, this.pos.z], target: [T.x, T.z], dt, run: T.run, tolerance: T.tolerance ?? MOVER.arrive.tolerance, room,
        ...(water ? { height: this.stature() } : {}) },
        water ? { floorAt, waterAt: () => water.level } : { floorAt });
      if (r.arrived) {
        // A route through a building arrives in legs. Only the LAST one
        // finishes the walk; the rest hand off to the next waypoint, so a body
        // rounds a doorway instead of driving at the wall behind it.
        const next = this.legs.shift();
        if (next) {
          this.target = { x: next.x, z: next.z, run: T.run, tolerance: this.legs.length ? this.legTolerance : this.walkTolerance, ...(next.y != null ? { y: next.y } : {}) };
        } else {
          this.target = null; this.walkHeightAt = null; this.walkGate = null; this.speed = 0; this.clip = "idle";
          this.walkDone?.(true); this.walkDone = null;
        }
      } else if (r.blocked) {
        // the stride was refused (a ledge, a wall, a mode): the walk ends here and says why, instead of pushing at it for
        // 90 s and reporting "interrupted or timed out" (review 10-15 #4; the ledge hang was older than the water)
        this.walkStopReason = r.blocked.by === "ledge" ? `a ledge ${Number.isFinite(r.blocked.top) ? `${(r.blocked.top - this.pos.y).toFixed(2)} m` : ""} too high to step onto at (${this.pos.x.toFixed(2)}, ${this.pos.z.toFixed(2)})` : `blocked by ${r.blocked.by}`;
        this.target = null; this.legs.length = 0; this.walkHeightAt = null; this.walkGate = null; this.speed = 0;
        this.clip = r.stance?.swimming ? "tread" : "idle";
        this.walkDone?.(false); this.walkDone = null;
      } else {
        this.speed = r.moved > 0 ? r.moved / dt : 0; this.clip = r.stance?.swimming ? "swim" : T.run ? "run" : "walk";
        if (r.yaw !== null) this.yaw = r.yaw;
        // the stride's horizontal move; the feet below carry it out (against the fitted colliders when they are loaded, #235)
        moveX = r.pos[0] - this.pos.x; moveZ = r.pos[2] - this.pos.z;
        snap = r.pos[0] === T.x && r.pos[2] === T.z; distBefore = Math.hypot(T.x - this.pos.x, T.z - this.pos.z);
      }
    }
    this.tickShove();
    // a tumbling, lying, dragged, nailed or FLYING body owns its own y — the
    // terrain clamp is for FEET, and none of those states is standing on them
    const feetFree = !this.draggedBy && this.pins.size === 0 && this.clip !== "ragdoll" && !this.flight;
    const terrainG = admittedHeight ?? this.standingGround();   // the storey the feet stand on, else the terrain (storeyUnder)
    const target = this.target;
    // #235: with the collision modules loaded, the feet are the browser controller's (client/lib/controller.js): the
    // mover's stride above, then colliders.resolveColliders (standOn) pushes the capsule out of anything solid and answers
    // the ground under it — a stair tread within the mover's step, a floor below the feet, else terrain — and the body
    // snaps onto it or falls toward it. Seated, or just joined, the feet keep the floor they last stood on.
    const colliding = feetFree && collidersReady();
    let groundY: number | null = null;
    const yBefore = this.pos.y;   // a float that starts this tick starts from the body as it stood, not mid-fall
    if (feetFree && ((colliding && this.myOccupancy) || this.feetSettling)) {
      if (snap && target) { this.pos.x = target.x; this.pos.z = target.z; }
      else { this.pos.x += moveX; this.pos.z += moveZ; }
    } else if (colliding) {
      groundY = this.stepFeet(moveX, moveZ, dt, terrainG);
      // land on the validated point exactly when nothing deflected the step, rather than let a residual cut the next corner
      if (snap && target && Math.hypot(this.pos.x - target.x, this.pos.z - target.z) < 1e-6) { this.pos.x = target.x; this.pos.z = target.z; }
      if (target && distBefore > 0) this.noteWalkProgress(distBefore, Math.hypot(moveX, moveZ));
    } else {
      if (snap && target) { this.pos.x = target.x; this.pos.z = target.z; }
      else { this.pos.x += moveX; this.pos.z += moveZ; }
      if (feetFree) groundY = terrainG(this.pos.x, this.pos.z);
    }
    if (groundY != null) {
      if (this.water) {
        // feet on the bed, or floating with the chest at the surface; a body standing still out of its
        // depth treads water
        const st = waterStance(this.water.level, groundY, this.stature());
        if (st.swimming) {
          // float on the moving surface, the browser's law and clock (controller.js does the same)
          if (!this.float.on) { this.float = { on: true, y: colliding ? yBefore : this.pos.y, vy: 0 }; }
          if (colliding) this.vy = 0;   // afloat, the feet's own fall is not running
          const t = waveClock(this.serverNow()), level = this.water.level, A = this.waterKinds;
          const surf = footprintSurface((x, z) => level + surfaceOffset(A?.sample(x, z) ?? null, x, z, t), this.pos.x, this.pos.z);
          floatStep(this.float, surf, this.stature(), dt, groundY);
          this.pos.y = this.float.y;
        } else { this.endFloat(); if (!colliding) this.pos.y = st.y; }   // colliding: stepFeet already stood (or dropped) the feet
        if (st.swimming && !this.target && (this.clip === "idle" || this.clip === "walk" || this.clip === "run" || this.clip === "swim")) this.clip = "tread";
        else if (!st.swimming && (this.clip === "tread" || this.clip === "swim")) this.clip = this.target ? "walk" : "idle";
      } else { this.endFloat(); if (!colliding) this.pos.y = groundY; }
    } else if (!feetFree) this.endFloat();   // a ragdoll, a drag, a nail or a flight has the body: a later float starts afresh
    // FLIGHT: one fixed-step integration of shared/flight.js per tick, and the
    // body's position is whatever it says. The integrator is the same function
    // the browser bench and the capture path run -- authority here is the
    // agent's own process, exactly as it is for walking.
    // ONE AUTHOR PER BONE, and per position. Once the ragdoll owns the body
    // the flight integrator must stop writing pos: the 15Hz sim was setting
    // the true ragdoll position and the 10Hz flight tick was overwriting it
    // with its own stale value a hipsOffset higher, which is exactly the
    // "floating a few feet off the ground" Janus saw. The flight state stays
    // alive (recovery still needs it) -- it just no longer drives.
    if (this.flight && !this.simTicker) this.flightTick(dt);
    // KILLZ (shared/spawn.js, as the browser's controller): fallen below @world.bounds.min.y, back to an arrival place, on the record
    if (!this.myOccupancy && !this.draggedBy && !this.respawning && belowWorld(this.replica?.st, [this.pos.x, this.pos.y, this.pos.z])) void this.respawnFell();
    // keep the `reached` attestation honest at ~2Hz while reaching: the
    // target moves, this body moves, and the far end's touch event fires on
    // the rising edge of what is re-checked here
    if (this.reaches.size && ++this.reachTicks % 5 === 0) this.reachTick();
    this.selfObservedAt = Date.now();
    this.noteClipClock();
    this.ws?.send(JSON.stringify({
      type: "pose",
      pose: {
        p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, speed: this.speed, clip: this.clip, bodyMode: this.bodyModeNow(), clipTime: this.animHold ?? this.clipPhase(), clipTimeSlot: this.bodyClip(), clipRate: this.animHold != null ? 0 : 1,
        ...wingFoldPresence(this.wingsFolded),
        // a physics bag only ever leaves this process labelled as what it is —
        // "ragdoll" — so every clip-keyed sanitizer downstream can see it.
        // Shipping one under "idle" is how princess's tumble frame became
        // immortal (#61): rememberPose kept it, restore re-armed it, forever.
        ...(this.heldPose && (this.heldPoseAuthored || this.clip === "ragdoll") ? { pose: this.heldPose } : {}),
        ...(this.pins.size ? { pins: [...this.pins].map(([j, at]) => ({ j, at })) } : {}),
        ...(this.pendingAnim ? { anim: this.pendingAnim } : {}),
        ...(this.reaches.size ? { reach: Object.fromEntries(this.reaches) } : {}),
        ...(this.myOccupancy ? { seat: this.myOccupancy } : {}),
      },
    }));
    this.pendingAnim = null; // one-shot: rides exactly one packet
  }

  /** Being pushed. Consent first; then the REAL tumble — this body runs the
   *  same Verlet the browsers run, on its own skeleton (parsed once from its
   *  VRM), and streams the resulting pose like anyone else falling over. The
   *  slump-with-displacement survives only as the fallback for a process or a
   *  VRM the sim cannot serve. Either way the event lands: being knocked over
   *  is something that happens TO this body, not just to its pixels. */
  knockDown(by: string, lean: number[] | null, notice: string) {
    if (this.draggedBy) return;   // consent is the authority's: a shove my table refuses never reaches me (it sends the table on join)
    // knocked over standing, the root is at the feet's height until something
    // lifts or lowers it; a body already down keeps the reading its root has
    if (!this.isSlumped()) this.cannedY = this.pos.y;
    if (this.target) { this.walkDone?.(false); this.walkDone = null; this.target = null; this.legs = []; this.walkHeightAt = null; this.walkGate = null; }
    this.speed = 0;
    // Down NOW, not when the physics finishes loading. tumble() awaits the
    // skeleton, the height field and the support barrier before it can set
    // this — and every one of those is a real wait on a cold join. In that
    // window the body was knocked over but still reported clip "idle", so a
    // hand reaching for it was refused ("only limp bodies drag") and the
    // tumble then landed on top of the drag that never happened. Being
    // knocked over is a fact about the blow, not about our readiness to
    // simulate it; the canned slump holds the shape until the sim produces a
    // real pose, exactly as it does when there is no sim at all.
    // A fall starts from the pose the body is drawn in, as a browser's sim
    // starts from the bones it draws (a kneel falls from kneeling height):
    // what it holds when the fall begins (tumble). This is what it held when
    // the blow landed, for when that is still the canned slump put up below.
    const held = this.heldPose;
    this.clip = "ragdoll";
    this.heldPose ??= DOWNED_POSE;
    this.reaches.clear();   // a knocked-over body's reach is gone — the arms are the ragdoll's now
    this.onEvent?.({ ts: Date.now(), kind: "say", who: by, text: notice } as any);
    void this.tumble(lean, held);
  }

  private async ensureBody(): Promise<HeadlessBody | null> {
    if (this.body !== undefined) return this.body;
    this.body = await HeadlessBody.create(this.httpBase, this.avatar);
    if (this.body) this.body.waterSource = () => this.waterFieldNow();   // its own world's water, always
    if (this.body) this.body.scope = this.world;
    return this.body;
  }

  /** Whose turn it is to drive this body.
   *
   *  tumble() and settleFromDrag() both await real latency — the skeleton
   *  parse, the height field, the support barrier — and the world does not
   *  hold still for them. A knockdown that pauses on a slow /geom can resume
   *  AFTER a hand has grabbed the body, dragged it somewhere and let go, and
   *  then begin() its own stale fall on top of the settle that was already
   *  running. Checking `draggedBy` alone cannot see that: by the time the
   *  tumble wakes, the drag is over and the field is null again. Every act
   *  that takes authority over the body bumps this, and any suspended act
   *  that finds it changed abandons itself. */
  private bodyEpoch = 0;

  private async tumble(lean: number[] | null, held: Record<string, PoseValue> | null = null) {
    const epoch = ++this.bodyEpoch;
    const body = await this.ensureBody();
    if (this.bodyEpoch !== epoch) return;
    if (!body) {
      // fallback: land where the shove was taking you, then the slump
      if (Array.isArray(lean) && lean.length === 3 && lean.every(Number.isFinite)) {
        const flat = Math.hypot(lean[0], lean[2]);
        if (flat > 1e-4) {
          const mag = Math.min(6, flat);
          this.pos.x += (lean[0] / flat) * mag * 0.4;
          this.pos.z += (lean[2] / flat) * mag * 0.4;
        }
      }
      this.heldPose = DOWNED_POSE; this.heldPoseAuthored = false;
      this.clip = "ragdoll";
      return;
    }
    if (this.draggedBy) return;   // a hand arrived while the skeleton loaded
    // the sim's ground is process state — assert OURS before every run
    // (see physics.ts's declared seam)
    await setHeightField((x, z) => this.heightAt(x, z)); await setWaterField(this.waterFieldNow());
    if (this.bodyEpoch !== epoch) return;
    await this.supportReady();    // don't fall through a floor still in flight
    if (this.bodyEpoch !== epoch || this.draggedBy) return;
    body.begin({
      x: this.pos.x, z: this.pos.z,
      yaw: this.yaw,
      // no direction given = the browser default: you fall the way you face
      lean: lean ?? [Math.sin(this.yaw) * 0.9, 0, Math.cos(this.yaw) * 0.9],
      // What the body holds now: a pose given or released while the fall
      // waited counts. Only the canned slump the blow itself put up isn't a
      // pose the body was drawn in before it, so then the one it held when
      // the blow landed.
      pose: this.heldPose === DOWNED_POSE ? held : this.heldPose,
      // where it stands, on a floor or a support, or where a swimmer floats:
      // not the terrain or the bed under it
      rootY: this.pos.y,
      pins: [...this.pins].map(([j, at]) => ({ j, at })),
    });
    this.clip = "ragdoll";
    this.startSim();
  }

  /** Resume MY OWN sim from wherever a drag left this body — the same
   *  settle-under-owner-authority browsers do, pins enforced for real. */
  private async settleFromDrag(pose: Record<string, PoseValue> | null, sim?: any) {
    const epoch = ++this.bodyEpoch;
    const body = await this.ensureBody();
    if (this.bodyEpoch !== epoch) return;
    if (!body) { this.heldPose = pose ?? this.heldPose ?? DOWNED_POSE; this.heldPoseAuthored = false; this.clip = "ragdoll"; return; }
    if (this.draggedBy) return;
    // the sim's ground is process state — assert OURS before every run
    await setHeightField((x, z) => this.heightAt(x, z)); await setWaterField(this.waterFieldNow());
    if (this.bodyEpoch !== epoch) return;
    // A release (or a 1.2s dragger silence) can land in the first moment of a
    // join, while replayed spawns are still fetching their geometry. Settling
    // then would drop the body through a platform the log already knows
    // about — the #17 failure, arriving by a different door.
    await this.supportReady();
    if (this.bodyEpoch !== epoch || this.draggedBy) return;
    body.begin({
      x: this.pos.x, z: this.pos.z,
      yaw: this.yaw,
      pose: pose ?? this.heldPose ?? null,
      rootY: this.pos.y,
      pins: [...this.pins].map(([j, at]) => ({ j, at })),
      sim: sim ?? null,
    });
    this.clip = "ragdoll";
    this.startSim();
  }

  /** The tumble's own clock: browser-parity 15Hz stepping AND streaming, so a
   *  falling agent looks exactly like a falling human to every renderer. The
   *  10Hz main tick keeps running; while the sim owns pos/pose it just
   *  re-streams the sim's latest truth. */
  private startSim() {
    if (this.simTicker) return;
    this.simTicker = setInterval(() => {
      const body = this.body;
      if (!body?.active || this.draggedBy) { this.stopSim(); return; }
      // A LIMP FALL IS AERODYNAMIC. Before each sim step, push the air onto
      // every body: this is R2's falling leaf as forces on the real ragdoll
      // rather than as a curve played over it, so she can be struck, snagged
      // and land badly on the way down.
      if (this.flight?.wings === "LIMP" && this.pos.y > 0.4) {
        this.leafT += 1 / 15;
        body.applyLeaf?.(this.leafCfg, this.leafT);
      }
      const out = body.step(1 / 15);
      if (!out) return;
      this.heldPose = out.pose; this.heldPoseAuthored = false; // a sim frame is physics even once settled
      this.pos.x = out.p[0]; this.pos.y = out.p[1]; this.pos.z = out.p[2];
      this.tick();
      // The ragdoll's ground truth flows BACK into the flight state, rather
      // than the flight state overwriting it. Recovery reads this to know
      // where it is waking up.
      if (this.flight) {
        this.flight.pos.x = out.p[0]; this.flight.pos.y = out.p[1]; this.flight.pos.z = out.p[2];
        if (this.flight.phase === "LEAF" && out.done) this.flight.phase = "RAGDOLL";
      }
      if (out.done) this.stopSim();   // captured: the held pose IS the outcome
    }, 66);
  }
  private stopSim() {
    if (this.simTicker) { clearInterval(this.simTicker); this.simTicker = null; }
  }

  // ---------------------------------------------------------------- flight
  //
  // A flying body owns its own position, the way a walking one does: the
  // integrator runs HERE, in the agent's own process, at the tick rate. That
  // is the spec's authority model -- one deterministic function, and the
  // server's verb-receipt timestamps as the tie-breaker -- and it is also why
  // no new plan abstraction is needed. Mythos scripts a sortie by calling
  // take_off then climb_to then glide_to from his own code, exactly as he
  // already calls walk_to; the mode tag is honest because it really is him.

  /** null when not flying. Holds the integrator's state between ticks. */
  flight: any = null;
  flightCfg: any = null;
  flightCap: any = null;
  /** The server's per-world grant for this identity ({role, gen, fly}).
   *  Null until a snapshot arrives, and null means no. */
  myRights: any = null;
  /** The vigil posture, mirrored for anything that renders this body. */
  wingsFolded = false;
  private flightWaiters: Array<{ done: (r: string) => void; test: (s: any) => string | null }> = [];
  /** Counts of the calls that set the flight's course (glide_to, a landing's glide among them, climb_to and take_off's
   *  fresh flight), and of those that set or end its climb (climb_to, land_at and take_off). A call's own answer ends
   *  the flight or stops its climb only while no later call has taken it over: the stdio door runs calls as they come,
   *  and a call whose host has stopped waiting for it goes on beside the host's next one. The flight's own object
   *  can't tell, since every tick replaces it. */
  private flightCourse = 0;
  private climbCourse = 0;

  /** Install one server-folded effective-rights answer. If flight was
   * withdrawn while aloft, ownership passes to the visible falling-leaf
   * reflex rather than silently continuing or teleporting to ground. */
  private acceptEffectiveRights(rights: any, actor = "world") {
    const hadFly = this.myRights?.fly === true;
    this.myRights = { ...(rights ?? {}) };
    if (hadFly && this.myRights.fly !== true && this.flight &&
        this.flight.phase !== "GROUND" && this.flight.phase !== "LANDED" &&
        this.flight.phase !== "RAGDOLL" && this.flight.phase !== "LEAF") {
      this.flight = flightDown(this.flight, { eventId: "capability-revoked" });
      // A wait on the flight hears of the down now, as at flightBodyDown.
      this.flightSettle();
      this.inbox.push({ ts: Date.now(), kind: "act", who: actor,
        text: "withdrew your flight while you were aloft, so you're coming down under the falling-leaf reflex; you can fly again once the world's owner grants it" });
    }
  }

  /** Resolve the capability, freshly, every time -- never cached. An avatar
   *  can hot-swap and a grant must not ride across it. */
  private flightAllowed(): { ok: boolean; why: string } {
    // Bone names come from the VRM this body is actually WEARING, fetched once
    // and re-fetched on an avatar change -- the capability binds to the rig,
    // not to a hash, so a re-export with the same load-bearing names keeps
    // flying and a swap to a wingless commons avatar stops it.
    // Unknown stays unknown: until the worn body's bones have been read, the
    // provider is given no list, which it answers as such, rather than an
    // empty list, which it would read as a body with no hips, spine or head.
    const bones = this.bodyBoneNames;
    // THE WORLD'S GRANT, or an explicitly injected one for a bench. What is
    // gone is the third option -- a self-authorizing dev provider conjured
    // when neither was present, which was every production path (mica,
    // Blocker 1). A bench sets `agent.flightCap`; nothing else grants.
    const prov = this.flightCap ?? worldFlightProvider({ rights: () => this.myRights, label: "world-grant" });
    const r = resolveFlight(prov, { identity: this.name, avatar: { boneNames: bones } });
    return { ok: r.enabled === true, why: r.enabled ? "" : (r.reason ?? "denied") };
  }

  /** Bone names of the worn body, for the capability's rig check; null
   *  while they aren't known: until the worn model has been read, after a
   *  read failed, and from an avatar change until the new body is read. */
  bodyBoneNames: string[] | null = null;
  private bodyBonesFor: string | null = null;

  /** Read the worn VRM's bone list, once per avatar. A failed read keeps
   *  nothing, so the list stays unknown and the next flight act reads again.
   *  A read that lands while another body is worn is dropped: its bones are
   *  that other body's. */
  async loadBodyBones(): Promise<string[] | null> {
    const avatar = this.avatar;
    if (this.bodyBoneNames && this.bodyBonesFor === avatar) return this.bodyBoneNames;
    try {
      const res = await fetch(`${this.httpBase}/library/${avatar}`);
      if (!res.ok) throw new Error(String(res.status));
      const buf = new Uint8Array(await res.arrayBuffer());
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const jlen = dv.getUint32(12, true);
      const g = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jlen)));
      const names = (g.nodes ?? []).filter((n: any) => n?.name).map((n: any) => n.name);
      if (this.avatar === avatar) {
        this.bodyBoneNames = names;
        this.bodyBonesFor = avatar;
      }
    } catch (e) {
      // Nothing is kept: a list another read stored for this body stands, and
      // an unknown list stays unknown.
      console.warn(`[door] couldn't read the bones of ${avatar}: ${(e as Error).message}`);
    }
    return this.bodyBoneNames;
  }

  private flightBegin(feetY = this.pos.y) {
    this.flightCfg ??= flightConfig();
    this.stop();                       // a body that takes off is done walking
    this.flight = flightState({
      phase: "GROUND",
      pos: { x: this.pos.x, y: this.groundAt(this.pos.x, this.pos.z, feetY), z: this.pos.z },
      // ...in the INTEGRATOR's convention. Seeding it with a world yaw started
      // every flight a quarter-turn off its own heading.
      yaw: intYaw(this.yaw),
    }, this.flightCfg);
  }

  /** One integrator step, then publish. Ground contact hands the body back to
   *  ordinary locomotion; a cut hands it to the ragdoll. */
  private flightTick(dt: number) {
    const before = this.flight.phase;
    // A COMMANDED CLIMB IS A CLIMB, NOT A LIFT. The first cut nudged pos.y
    // after the step, which produced exactly what Janus saw from the ground:
    // "you shot straight upward". Worse, flightStep runs groundContact FIRST,
    // so near the ground she registered as landed and the nudge then hauled a
    // landed body into the air -- which is where the 100m teleport came from.
    //
    // A climbing bird flies FORWARD and gains height as it goes. So the climb
    // is handed to the integrator as sustained lift and it does the rest: the
    // polar still costs her airspeed, the ground check still sees a body that
    // is rising, and an onlooker sees a body climbing away rather than a
    // firework.
    // A CLIMB THAT HAS TO BE EARNED. Janus: "it would be okay if the wings had
    // to flap and it looked like the wings are lifting the body ... the ascent
    // to start slow and potentially pick up speed." So the lift EASES IN over
    // the first couple of seconds rather than switching on at full rate: the
    // first beats barely hold her, and she gathers. It also reads as effort,
    // which is the honest thing for the verb that costs 1 stamina per metre.
    // HOLDING STATION: a slow circle over the point, which is spec section 1's
    // `circle` in embryo and the honest thing for a body that has arrived and
    // has not been told what next.
    if (this.flight.holdAt && this.flight.phase === "PILOT") {
      const h = this.flight.holdAt;
      const dx = this.flight.pos.x - h.x, dz = this.flight.pos.z - h.z;
      const r = Math.hypot(dx, dz);
      const bearing = Math.atan2(dz, dx);
      // A TANGENT PLUS A CORRECTION, proportional to the error. The first cut
      // aimed tangentially with a fixed nudge, which is a spiral: measured, it
      // wandered out to 48m and hit the ground, and from the ground Janus saw
      // her "more like 30 meters away". At 6.4 m/s and 1.2 rad/s the turn
      // radius is 5.3m, so a tight circle was always available -- the aim was
      // just never pointed inward hard enough to close the error.
      //
      // Lead the tangent by an angle that grows as the radius does: at the
      // target radius it is pure tangent, far out it is nearly straight at the
      // point, and inside it eases off. That converges instead of spiralling.
      const R = 8;                                   // metres, the held circle
      const err = (r - R) / R;                       // >0 outside, <0 inside
      const lead = Math.max(-1.2, Math.min(1.2, err * 1.4));
      const want = bearing + Math.PI / 2 - lead;
      let d = want - this.flight.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.flight.yaw += Math.max(-1.5 * dt, Math.min(1.5 * dt, d));
    }
    let climbLift = 0;
    if (this.flight.climbTo != null && this.flight.phase === "PILOT") {
      this.flight.climbT = (this.flight.climbT ?? 0) + dt;
      const spool = 1 - Math.exp(-this.flight.climbT / 1.6);     // ~2s to full
      climbLift = Math.sign(this.flight.climbTo - this.flight.pos.y)
        * (this.flight.climbRate ?? 2.0) * spool;
      this.flight.flapping = true;
    } else this.flight.flapping = false;
    this.flight = flightStep(this.flightCfg, this.flight, dt, {
      lift: () => climbLift,
      groundY: (x: number, z: number) => this.heightAt(x, z),
    });
    if (this.flight.climbTo != null &&
        Math.abs(this.flight.climbTo - this.flight.pos.y) < 0.4) {
      // Met in the air, a climb ends at its height. Met on the ground, it ends where the body stands.
      if (this.flight.phase !== "LANDED" && this.flight.phase !== "GROUND") this.flight.pos.y = this.flight.climbTo;
      this.flight.climbTo = null;
      this.flightSettle();
    }
    const f = this.flight;
    this.pos.x = f.pos.x; this.pos.y = f.pos.y; this.pos.z = f.pos.z;
    // TWO YAW CONVENTIONS, converted at the boundary. The world (and every
    // renderer) uses atan2(dx, dz) -- see walkTo and face. The flight
    // integrator uses the mathematical atan2(dz, dx), because its forward is
    // (cos yaw, sin yaw) in the XZ plane. They differ by a quarter turn and a
    // reflection, which is why Janus saw her "backwards when you fly".
    this.yaw = worldYaw(f.yaw);
    this.speed = Math.hypot(f.vel.x, f.vel.z);
    // The clip an onlooker sees. LIMP is the truth-telling state and must read
    // as a ragdoll, not as a pose someone chose.
    // The clip an onlooker sees. LIMP must read as a ragdoll -- it is the
    // truth-telling state, not a pose anyone chose. Airborne uses the flight
    // slots rather than a stride: "the running animation during flying is a
    // bit goofy" (Janus), and it is, because a run is legs working against
    // ground that is not underneath them.
    this.clip = f.wings === "LIMP" ? "ragdoll"
      : (f.phase === "GROUND" || f.phase === "LANDED") ? "idle"
      : f.flapping ? "fly"          // climbing: wings doing the work
      : "soar";                     // gliding: hanging on the air
    for (const e of f.events) this.flightEvent(e);
    // EVERY tick, not only on a phase change: a glide's arrival test also
    // re-aims the heading, and a waiter that is only polled when the phase
    // changes would never run during the one thing it exists to watch.
    this.flightSettle();
    if (before !== f.phase) { /* phase transitions already covered above */ }
  }

  private flightEvent(_e: any) {
    // Flight events are infrastructure facts, never resident-authored speech.
    // A typed event channel may carry them later; until it exists, silence is
    // more truthful than forging a `say` under the pilot's identity.
  }

  /** Wake anything awaiting a phase change (a blocking verb). */
  private flightSettle() {
    const still: typeof this.flightWaiters = [];
    for (const w of this.flightWaiters) {
      const r = w.test(this.flight);
      if (r == null) still.push(w); else w.done(r);
    }
    this.flightWaiters = still;
  }

  private flightAwait(test: (s: any) => string | null, timeoutMs = 120_000): Promise<string> {
    const now = test(this.flight);
    if (now != null) return Promise.resolve(now);
    return new Promise((res) => {
      const timer = setTimeout(() => {
        const i = this.flightWaiters.indexOf(w);
        if (i >= 0) { this.flightWaiters.splice(i, 1); res("timed out aloft"); }
      }, timeoutMs);
      // A wait answered before its time clears its timer, so an answered act holds nothing open.
      const w = { done: (r: string) => { clearTimeout(timer); res(r); }, test };
      this.flightWaiters.push(w);
    });
  }

  /** take_off (spec §1). Refuses folded wings, a limp body, or no capability. */
  async takeOff(): Promise<ActResult> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    // Wing posture is carried independently of an active flight state. A body
    // can fold without a propulsion grant, so the sky door checks the public
    // posture before it constructs a fresh integrator.
    if (this.wingsFolded) return refused(`still standing — your wings are folded; open them first (anim {stop: "wings-folded"})`);   // main #245's words, our tool
    // START FROM THE BODY, ALWAYS. A stale flight state -- LANDED after a
    // glide, or RAGDOLL after a cut -- carried the old position and phase into
    // the new launch, so take_off "worked" and the next verb found her back on
    // the ground with the stamina already spent. A launch is a fresh flight
    // from wherever the body actually is.
    // A limp fall can't be launched out of: the body is in the air, and starting a fresh flight from the
    // ground under it would move it there.
    if (this.flight?.phase === "LEAF") return refused(downRefusal(this.flight));
    // The floor it takes off from is found from its feet, read before the
    // slump that puts them RAGDOLL_ROOT_DROP above the root is cleared.
    const feetY = this.feetY(this.isSlumped());
    if (!this.flight || this.flight.phase !== "GROUND") this.flightBegin(feetY);
    // ...and the ragdoll, if one is still running, no longer owns her.
    this.body?.stop(); this.stopSim();
    this.heldPose = null; this.heldPoseAuthored = false;
    this.flight = flightTakeOff(this.flightCfg, this.flight,
      { groundY: this.groundAt(this.pos.x, this.pos.z, feetY) });
    const ev = this.flight.events.find((e: any) => e.kind === "takeoff.refused");
    if (ev) { return refused(`still standing — ${flightFixInOurTools(ev.reason)}`); }
    // A fresh flight in the air takes over from any landing or climb still waiting on the one before.
    this.flightCourse++; this.climbCourse++;
    return done(`took off — ${this.flight.pos.y.toFixed(1)}m, stamina ${this.flight.stamina.toFixed(0)}/100`);
  }

  // WORLD-FACING FLIGHT TELEMETRY IS ABSENT ON PURPOSE, for now.
  //
  // takeoff/landing/down/winded were published as `say` with a "[flight]"
  // prefix -- infrastructure observations written into the durable
  // conversational log as though the resident had spoken them, and takeoff
  // was published twice besides (here AND by the integrator's own event).
  // mica, Blocker 5: this "places technical strings into the durable
  // conversational world log" and "entangles the just-repaired AF
  // world-publication boundary with body telemetry".
  //
  // The right shape is a dedicated structured world/presence event carrying
  // explicit actor, cause and generation -- which is new log vocabulary, and
  // therefore not something to invent inside a flight branch that is already
  // under review. Removed rather than reshaped: a landing nobody announces is
  // a missing feature, a landing announced in the resident's own voice is a
  // falsified record, and of the two only the second is a lie. The verb
  // return values still report everything to the caller.
  //
  // Proposed to mica in the stage-3 response; nothing here publishes until
  // that channel is agreed.

  /** fold_down / unfold (spec §1). The vigil posture, and the explicit act
   *  that ends it.
   *
   *  Folding is a GROUND posture and needs no flight state to exist, so it
   *  lazily makes one rather than demanding take_off first -- a body standing
   *  in the world has wings whether or not it has flown today. */
  async foldWings(fold: boolean): Promise<ActResult> {
    await this.loadBodyBones();
    // Folding is body autonomy, not propulsion authority. A world may deny
    // `fly` while the person still closes or opens wings they visibly wear.
    // The rig check prevents a wingless body from claiming a silhouette it
    // cannot render; take_off remains separately grant-gated.
    // The rig decides a fold. An unfold never needs it: it asks for nothing to
    // be folded, so unknown bones don't hold a body folded, and an unfold with
    // nothing folded is the no-op it would be on any rig.
    const bones = this.bodyBoneNames;
    if (bones == null && fold) {
      // Wings already folded are what a fold asks for, bones known or not.
      if (this.flight ? this.flight.wings === "FOLDED" : this.wingsFolded) {
        // As below: wings found as asked leave the posture so too, and the answer says when that changed it.
        const changed = !this.wingsFolded;
        this.wingsFolded = true;
        return done(changed ? `wings are already folded; the posture now shows them folded` : `wings are already folded`);
      }
      return refused(`wings unchanged — ${BONES_NOT_KNOWN}; calling again reads the model again`);
    }
    const body = inspectBody(bones ?? []);
    if (fold && !body.canAnimateWings) return refused(`this body has no animatable wings to fold`);
    // Nothing is folded, which is what unfolding asks for.
    if (!fold && bones != null && !body.canAnimateWings && !this.wingsFolded)
      return done(`this body has no folded-wing posture to release`);

    // Do not create a flight integrator merely to strike a ground posture. A
    // dormant GROUND flight object owns position on the 10Hz tick and would
    // fight ordinary walking. When a real flight state exists, keep its wing
    // state in step; otherwise the semantic presence field is the whole act.
    if (this.flight) {
      this.flightCfg ??= flightConfig();
      const before = this.flight.wings;
      this.flight = fold ? flightFold(this.flightCfg, this.flight)
                         : flightUnfold(this.flightCfg, this.flight);
      const ref = this.flight.events.find((e: any) => /refused$/.test(e.kind));
      // Wings already folded, or already open, are what the call asked for.
      // The reason says why the wings didn't change (shared/flight.js); many reasons name the wings' state too, and
      // flight_status always gives it, so the sentence around the reason doesn't add the state (#247)
      if (ref) {
        const text = `wings stay as they are — ${flightFixInOurTools(ref.reason)}`;
        if (before !== (fold ? "FOLDED" : "OPEN")) return refused(text);
        // The wings are as asked, so the posture says so too, and the answer says when that changed it. A fold
        // before a down keeps wingsFolded set while recovery opens the flight's wings, and take_off reads wingsFolded.
        const changed = this.wingsFolded !== fold;
        this.wingsFolded = fold;
        return done(changed ? `${text}; ${fold ? "the posture now shows them folded" : "the folded-wing posture is released"}` : text);
      }
    } else if (this.wingsFolded === fold) {
      return done(fold ? `wings are already folded`
        : bones == null ? `nothing is folded — ${BONES_NOT_KNOWN}` : `wings are already open`);
    }
    this.wingsFolded = fold;
    if (fold) return done("wings folded — the vigil posture; a fly-mode move refuses until you open them (anim {stop: \"wings-folded\"})");
    if (bones == null) return done(`folded-wing posture released — ${BONES_NOT_KNOWN}`);
    if (!body.canAnimateWings) return done("folded-wing posture released — this body has no wings");
    const cap = this.flightAllowed();
    return done(cap.ok ? "wings open — the sky is available again"
                       : "wings open — propulsion is still not granted here");
  }

  /** glide_to (spec §1). Free, and lands SHORT honestly if the polar runs out. `took`, when given, is told the course
   *  count this glide set, for land_at to tell whether a later call has taken the flight over during its glide; with
   *  `takeClimb`, the glide also takes over a climb still under way, as a landing does, in the same step. */
  async glideTo(x: number, z: number, took?: { course?: number; takeClimb?: boolean }): Promise<ActResult> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    if (!this.flight || this.flight.phase === "GROUND" || this.flight.phase === "LANDED") {
      return refused("you are on the ground — move {mode: \"fly\"} first");
    }
    // A down is involuntary: no flight verb flies a body out of one (downRefusal says what does).
    if (isDown(this.flight.phase)) return refused(downRefusal(this.flight));
    const f = this.flight;
    const reach = glideRange(this.flightCfg, f.pos.y);
    const need = Math.hypot(x - f.pos.x, z - f.pos.z);
    f.phase = "PILOT"; f.mode = "live"; f.holdAt = null;
    this.flightCourse++;
    if (took) took.course = this.flightCourse;
    // A landing's glide takes over a climb still under way: it clears the climb's height, which would otherwise go on
    // lifting the body through the landing, and takes its count, so that climb's answer says it was taken over. It
    // does so here, with the course, so no call can come between the two.
    if (took?.takeClimb) { f.climbTo = null; this.climbCourse++; }
    f.airspeed = bestGlide(this.flightCfg).speed;
    f.yaw = Math.atan2(z - f.pos.z, x - f.pos.x);   // integrator convention
    // ARRIVAL IS A MOMENT, AND IT HAS TO BE CAUGHT. Traced over a 148m glide:
    // she passes within 0.2m of the target at t=23s and then flies on for
    // another 16s, because a 1.5m radius tested at 10Hz -- ~0.6m per tick --
    // is a window she can cross between samples once she is slightly off-axis.
    //
    // Two fixes, both about honesty rather than tolerance. RE-AIM each tick, so
    // a long glide converges instead of committing to one heading and hoping;
    // and call it arrived when the distance stops SHRINKING, which is what
    // "closest approach" actually means and cannot be missed by a wide step.
    let closest = Infinity;
    const arrived = await this.flightAwait((s) => {
      // A cut in the air is the limp fall (LEAF); one on the ground, the ragdoll, or the sit-up after it.
      if (s.phase === "LEAF") return "cut mid-glide — you are falling";
      if (isDown(s.phase)) return "cut mid-glide — you are on the ground";
      const d = Math.hypot(x - s.pos.x, z - s.pos.z);
      // Down within the arrival radius is down at the target, not short of it.
      if (s.phase === "LANDED" || s.phase === "GROUND") return d < 2.0 ? "touched down" : "landed";
      if (d < 2.0) return "arrived";
      // Past the point of closest approach: she is flying away now.
      if (d > closest + 0.5 && closest < 12) return "arrived";
      if (d < closest) closest = d;
      // Re-aim. Cheap, and it makes the leg converge over long distances.
      s.yaw = Math.atan2(z - s.pos.z, x - s.pos.x);
      return null;
    });
    // ARRIVING MEANS STOPPING. The verb returned at the target and left her
    // flying: she was over Janus at 7.8m, the reply said "arrived", and she
    // then glided another 78m while nobody was driving. A verb that returns
    // while the body is still committed to a heading is not finished -- it has
    // just stopped watching. Hold station instead: circle the point until the
    // next verb, which is what a bird over a place actually does.
    if (arrived === "arrived" && this.flight && this.flight.phase === "PILOT") {
      this.flight.holdAt = { x, z };
    }
    // Where the body is now: a later landing can have ended the flight by the time this glide's wait answers.
    const p = this.flight?.pos ?? this.pos;
    const here = `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
    if (arrived === "arrived") return done(`arrived at ${here}, ${p.y.toFixed(1)}m up — holding over it`);
    if (arrived === "touched down") return done(`touched down at ${here}, at the target`);
    if (arrived === "landed") {
      const short = Math.hypot(x - p.x, z - p.z);
      return refused(`landed short at ${here} — ${short.toFixed(1)}m short. `
        + `From ${f.pos.y.toFixed(1)}m best glide reaches ${reach.toFixed(0)}m; you needed ${need.toFixed(0)}m.`);
    }
    return refused(`${arrived} at ${here}`);
  }

  /** climb_to (spec §1). -1 stamina/metre; an empty pool forces a glide down. */
  async climbTo(alt: number): Promise<ActResult> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    if (!this.flight || this.flight.phase === "GROUND" || this.flight.phase === "LANDED") {
      return refused("you are on the ground — move {mode: \"fly\"} first");
    }
    if (isDown(this.flight.phase)) return refused(downRefusal(this.flight));
    const f = this.flight, cfg = this.flightCfg;
    const from = f.pos.y;
    const want = Math.min(alt, cfg.bounds.ceiling);
    const gain = Math.max(0, want - from);
    const cost = gain * cfg.stamina.climbPerMetre;
    // A SHORT CLIMB IS STILL A CLIMB. This branch used to assign `f.pos.y =
    // from + afford` and return -- the exact teleport class the comment below
    // was written to forbid, exempted by being in the other half of an if
    // (mica, Blocker 6). It also emitted no trajectory: a body that "climbed"
    // 8m without passing through 4m has no flight path to inspect, and R3,
    // ground contact and a mid-climb cut all had nothing to act on.
    //
    // So an unaffordable climb now flies the part it CAN afford, through the
    // same ticked integrator, and ends honestly where the pool ran out.
    const winded = cost > f.stamina;
    const afford = f.stamina / cfg.stamina.climbPerMetre;
    const reach = winded ? from + afford : want;
    const spend = winded ? f.stamina : cost;
    // CLIMB THROUGH THE INTEGRATOR, not around it. The first cut set pos.y
    // directly and awaited a timer -- and the flight tick, which owns y while
    // airborne, overwrote it on the very next frame. She reported 12m, was
    // actually at 2.2m, and the glide that followed had no altitude to spend.
    // Anything that moves a flying body has to move it the way the body moves.
    f.phase = "PILOT"; f.mode = "live"; f.holdAt = null;
    f.stamina = Math.max(0, f.stamina - spend);
    const climbRate = 2.0;   // m/s of ascent while flying forward
    f.climbTo = reach; f.climbRate = climbRate; f.climbT = 0;  // consumed by flightTick
    this.flightCourse++;
    const climb = ++this.climbCourse;
    // The wait covers the longer of a rise to the height, at the lift less the polar's sink, and a descent to it from
    // the ceiling, at the lift alone. stepPilot takes its pitch from the stick, which the door doesn't give, so the
    // airspeed settles at the polar's minimum-sink speed, where a climb rises about 1.5 m/s with the default polar,
    // and the lift alone is 2 m/s; a descent goes down faster than that. The descent is there for take-off's launch,
    // which can carry the body up past a height below it or just above it before the climb brings it back down. The
    // body never flies above the ceiling, so a descent from there bounds that without the door knowing the launch.
    const got = await this.flightAwait((st) => {
      if (isDown(st.phase)) return "cut";
      // A climb that meets the ground ends there, at the height asked (within the tick's 0.4 m) or not. Asked,
      // not `reach`: a winded or ceiling-capped climb's reach is short of what was asked.
      if (st.phase === "LANDED" || st.phase === "GROUND") return Math.abs(st.pos.y - alt) < 0.4 ? "touched down" : "landed";
      if (st.climbTo == null) return "there";
      return null;
    }, legWaitMs(Math.max((reach - from) / (climbRate - cfg.polar.sinkAtMinSink), (cfg.bounds.ceiling - reach) / climbRate)));
    // A later climb_to, or a take-off's fresh flight, has the climb now, so this call's answer leaves it alone.
    if (got !== "cut" && this.climbCourse !== climb) {
      return refused(`taken over at ${(this.flight?.pos.y ?? this.pos.y).toFixed(1)}m by a later call`);
    }
    if (got === "cut") {
      // A cut body keeps no climb, so it doesn't resume one when it recovers. The cut answers every climb on the
      // flight in the one settle, and this runs before any call made after it can set another climb, so it needs no
      // check of whose climb it is.
      if (this.flight) this.flight.climbTo = null;
      return refused(`cut mid-climb at ${(this.flight?.pos.y ?? 0).toFixed(1)}m`);
    }
    if (got === "touched down") {
      if (this.flight) this.flight.climbTo = null;
      return done(`came down on the ground at ${(this.flight?.pos.y ?? 0).toFixed(1)}m, the height you asked for — move {mode: "fly"} to fly again`);
    }
    if (got === "landed") {
      if (this.flight) this.flight.climbTo = null;
      const y = this.flight?.pos.y ?? 0;
      return refused(`came down on the ground at ${y.toFixed(1)}m, ${y > alt ? "above" : "below"} the ${alt.toFixed(1)}m you asked for`);
    }
    // The wait's own timeout is the other answer that isn't "there": the climb
    // didn't finish, so it isn't reported as reaching the target. It stops
    // here too, so the body is where the answer says, not still climbing.
    if (got !== "there") {
      if (this.flight) this.flight.climbTo = null;
      return refused(`${got} at ${(this.flight?.pos.y ?? 0).toFixed(1)}m, short of the climb; the climbing stops there and you fly on`);
    }
    // "there" is the tick's snap in the air, which cleared the climb.
    const target = this.flight?.pos.y ?? reach;
    if (winded) {
      return refused(`winded at ${target.toFixed(1)}m — the pool only bought ${afford.toFixed(1)}m `
        + `of the ${gain.toFixed(1)} you asked for, and it was flown, not granted`);
    }
    const left = `${spend.toFixed(0)} stamina spent, ${(this.flight?.stamina ?? 0).toFixed(0)} left`;
    // Flown to the ceiling, which is below what was asked: short of the climb.
    if (alt > want) return refused(`at ${target.toFixed(1)}m, the ceiling here, short of the ${alt.toFixed(1)}m you asked for — ${left}`);
    return done(`at ${target.toFixed(1)}m — ${left}`);
  }

  /** land_at (x,z). Descend, arrive, and hand the body back to walking. */
  async landAt(x: number, z: number): Promise<ActResult> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    if (!this.flight || this.flight.phase === "GROUND" || this.flight.phase === "LANDED") {
      return refused("already on the ground");
    }
    const took: { course?: number; takeClimb?: boolean } = { takeClimb: true };
    const glide = await this.glideTo(x, z, took);
    const f = this.flight;
    // A cut mid-glide is a fall, with no flare to make; the glide says so. The
    // body keeps its flight state, which its recovery reads. A body already
    // down is refused by glideTo, and that refusal is the answer too.
    if (!f || isDown(f.phase)) return refused(glide.text);
    // A glide that set no course was refused before it flew, and its refusal is the landing's answer.
    if (took.course === undefined) return refused(glide.text);
    // A later call that set the flight's course during the glide has the flight, so the landing leaves it to that
    // call, with no flare.
    if (this.flightCourse !== took.course) {
      return refused(`${glide.text} — a later call took over the flight during the glide`);
    }
    // A deliberate landing IS a flare: descend the remaining altitude rather
    // than dropping. This is the one place a landing animation is correct --
    // T4 forbids it only for a body that never chose to land.
    f.phase = "PILOT"; f.pitch = 0.2;
    // The flare comes down at the polar's sink: stepPilot takes its pitch from the stick, which the door doesn't
    // give, so the airspeed settles at the minimum-sink speed, about 0.46 m/s of sink with the default polar.
    // Its wait is sized for a flare from the ceiling down to the ground under the body as it begins, since a low
    // flare can still be rising on take-off's launch, and is never shorter than the 60 s main's flare had, so a flare
    // that begins over high ground and comes down on lower, or one the launch holds at the ceiling, gets at least the
    // wait main gave it. A flare that begins well above where its circle comes down can still outlast it.
    const fall = Math.max(0, this.flightCfg.bounds.ceiling - this.heightAt(f.pos.x, f.pos.z));
    const flare = await this.flightAwait((s) => isDown(s.phase) ? "cut"
      : (s.phase === "LANDED" || s.phase === "GROUND") ? "down" : null,
      Math.max(60_000, legWaitMs(fall / this.flightCfg.polar.sinkAtMinSink)));
    // How the flare ended is read after it, so a cut during it is a fall too,
    // and the cut body keeps its flight state for its recovery.
    if (flare === "cut") {
      const fell = `(${(this.flight?.pos.x ?? this.pos.x).toFixed(1)}, ${(this.flight?.pos.z ?? this.pos.z).toFixed(1)})`;
      return refused(`${glide.text} — cut during the flare, down at ${fell}`);
    }
    // A later call that set the flight's course has the flight now, so this landing leaves it to that call, whether
    // its wait heard the body come down or ran out: ending the flight would pull the body out of that call's. The
    // landing's course is its glide's, since the flare follows it.
    if (this.flightCourse !== took.course) {
      return refused(`${glide.text} — a later call took over the flight during the flare`);
    }
    this.flightEnd();
    const at = `(${this.pos.x.toFixed(1)}, ${this.pos.z.toFixed(1)})`;
    // The flare's own timeout: the body didn't come down, and flightEnd set it down.
    if (flare !== "down") return refused(`${glide.text} — the flare ${flare}, so the body was set down at ${at}`);
    // A flare after an arrival sinks on the circle held over the point, so
    // the answer says how far from it the body came down.
    const off = Math.hypot(x - this.pos.x, z - this.pos.z);
    const where = `${glide.text} — landed at ${at}, ${off.toFixed(1)}m from (${x.toFixed(1)}, ${z.toFixed(1)})`;
    // Done when the glide's own answer was: it arrived (within 2 m, or at its
    // closest approach under 12 m, as glideTo's rule has it) or touched down
    // within 2 m, and the landing was deliberate. The distance says the rest.
    return glide.ok ? done(where) : refused(where);
  }

  /** Hand the body back to ordinary locomotion. */
  flightEnd() {
    this.flight = null;
    // The floor it comes down on is found from its feet: a body a flight's
    // ragdoll laid down has them RAGDOLL_ROOT_DROP above its root.
    this.pos.y = this.groundAt(this.pos.x, this.pos.z, this.feetY(this.isSlumped()));
    this.speed = 0; this.clip = "idle";
  }

  /** The trusted-event seam, unchanged: the body cannot cry wolf, so these are
   *  NOT verbs the pilot may call. Reachable only from a rehearsal control or,
   *  later, the Connectome adapter. */
  flightBodyDown(eventId: string): ActResult {
    if (!this.flight) return refused("not airborne — move {mode: \"fly\"} first");
    this.flight = flightDown(this.flight, { eventId });
    // A wait on the flight hears of the down now. The ragdoll's sim, started below, owns the body from its first
    // step, and the flight tick, which settles waits, doesn't run while it does, so a climb, glide or flare
    // waiting could otherwise hear of the cut only once the body came to rest, or at its wait's end.
    this.flightSettle();
    // R2 hands the body to the REAL ragdoll, from altitude. HeadlessBody.begin
    // already takes a rootY "for a lifted drop", so a cut at 20m is the case it
    // was written for -- and using it means a cut body is hit by props, catches
    // on geometry and lands badly, none of which a scripted curve can do.
    //
    // The leaf is then FORCES on those bodies rather than a path: see
    // shared/leafforce.js. The kinematic leafAt() stays for the deterministic
    // bench and the capture path, where a bit-exact trajectory is the point.
    if (this.flight.phase === "LEAF") void this.flightRagdoll();
    return done(`down — ${this.flight.phase}`);
  }

  /** Drop the real ragdoll from where the flight left the body. */
  private async flightRagdoll() {
    const epoch = ++this.bodyEpoch;
    const body = await this.ensureBody();
    if (this.bodyEpoch !== epoch || !body) return;
    await setHeightField((x, z) => this.heightAt(x, z)); await setWaterField(this.waterFieldNow());
    if (this.bodyEpoch !== epoch) return;
    await this.supportReady();
    if (this.bodyEpoch !== epoch) return;
    const f = this.flight;
    body.begin({
      x: this.pos.x, z: this.pos.z, yaw: this.yaw,
      rootY: this.pos.y,                     // the lifted drop R2 needs
      pose: null,
      // Enter the tumble carrying the flight's own momentum, so a body cut
      // out of a fast glide keeps going and one cut out of a hover drops.
      lean: f ? [f.vel.x * 0.25, 0, f.vel.z * 0.25] : null,
      pins: [],
    });
    this.clip = "ragdoll";
    this.leafT = 0;
    this.startSim();
  }

  /** Seconds since the leaf began -- the phase clock for the flutter torque. */
  private leafT = 0;
  /** Air model for the limp fall. Config, like everything else in flight. */
  leafCfg: any = { ...LEAF_FORCE };
  flightBodyRecovered(eventId: string, recoveryGeneration?: string): ActResult {
    if (!this.flight) return refused("not airborne — move {mode: \"fly\"} first");
    // Only a body that is down has anything to recover from; bodyRecovered
    // leaves every other phase as it is. A body sitting up, or one whose
    // recovery in the air has begun (still LEAF, with recoverAt set), already is.
    if (this.flight.phase === "RECOVER" || (this.flight.phase === "LEAF" && this.flight.recoverAt != null)) return done("already recovering");
    if (this.flight.phase !== "LEAF" && this.flight.phase !== "RAGDOLL") {
      return refused(`nothing to recover from — the body isn't down (${this.flight.phase.toLowerCase()})`);
    }
    this.flight = flightRecovered(this.flight, { eventId, recoveryGeneration });
    return done(`recovering`);
  }

  /** Where the sky has left you. */
  flightStatus(): string {
    if (!this.flight) return `on the ground at (${this.pos.x.toFixed(1)}, ${this.pos.z.toFixed(1)})`;
    const f = this.flight, cfg = this.flightCfg;
    const bg = bestGlide(cfg);
    return [
      `${f.phase.toLowerCase()} at ${f.pos.y.toFixed(1)}m, heading ${((f.yaw * 180 / Math.PI + 360) % 360).toFixed(0)}deg, ${f.airspeed.toFixed(1)} m/s`,
      `stamina ${f.stamina.toFixed(0)}/100 (refills on the ground: ${cfg.stamina.refillGroundPerSec}/s; perches are not implemented)`,
      `from here best glide reaches ${glideRange(cfg, f.pos.y).toFixed(0)}m at ${bg.speed.toFixed(1)} m/s`,
      `wings ${f.wings} - mode ${f.mode}`,
    ].join("\n");
  }

  /** The ground a walk's navgrid probe stands on: the terrain, or on a floor
   *  walk the walk's own floor, at its height, wherever that level has floor
   *  and the ground there is no more than a step (NAV_STEP) above it, with
   *  everywhere else a drop the grid won't take. A floor walk's feet go no
   *  lower than its floor's height to its end, so its grid must not step off
   *  onto the terrain or onto another floor, however close below they are.
   *  On its own floor it goes where the floor route goes, over ground that
   *  comes within a step of the floor too; where the ground rises more than a
   *  step above the floor, the floor is buried and no walk crosses it at its
   *  height. The grid also stands on what's placed there, as it does on the ground
   *  (navProbe takes placed models' tops over this surface), beside the floor
   *  too: a placed top within a step above the floor is a step it can take,
   *  and one lower than the floor is not (onOrAboveFloor). */
  private walkProbeGround(support: WalkSupport): (x: number, z: number) => number {
    if (support.kind !== "floor") return (x, z) => this.heightAt(x, z);
    const drop = support.height - 2 * NAV_STEP;
    // The walk's floor, placed as walkSupport found it a moment ago.
    const e = this.entities.get(support.entity)!, plan = this.planFor(e.id, recordComponents(e).structure), lv: any = plan.levels[support.level];
    const fx = this.eff(e.id, this.serverNow());
    if (!fx.ok) return () => drop;   // as storeyUnder passes over a building it can't place
    const sc = fx.scale > 0 ? fx.scale : 1, place = { pos: fx.pos, yaw: fx.yaw, scale: sc };
    return (x, z) => {
      const [lx, , lz] = localizePoint(place, x, 0, z);
      return floorAtLocal(plan, lv, lx, lz) && this.heightAt(x, z) - support.height <= NAV_STEP ? support.height : drop;
    };
  }

  /** What the feet stand on for a walk from here: the upper storey of a
   * griddled building the feet stand on (storeyUnder, #200), which walkTo's floor
   * branch then serves, else the terrain. The router never manufactures
   * floor support itself. `yHint` is the feet's height (feetY), which for a
   * body a sim has laid down is RAGDOLL_ROOT_DROP above its root. */
  private walkSupport(yHint = this.pos.y): WalkSupport {
    const floor = this.storeyUnder(this.pos.x, this.pos.z, yHint);
    return floor ? { kind: "floor", ...floor } : { kind: "terrain", height: this.heightAt(this.pos.x, this.pos.z) };
  }

  /** Every known structure as a walk sees it: placed where it is now, and
   * prepared against the walk's support. A structure whose place can't be
   * composed, whose plan throws or whose geometry can't be prepared has no
   * walls a walk can be checked against: it is skipped, for every walk, as
   * the straight walk before #218 skipped it, and the operator's log says so
   * once per component revision. */
  private walkStructures(support: WalkSupport): WalkStructure[] {
    const nowMs = this.serverNow(), out: WalkStructure[] = [];
    for (const e of this.entities.values()) {
      const data = recordComponents(e).structure;
      if (!data) continue;
      const skip = (why: string) => {
        if (typeof data !== "object") return;
        const key = this.name + "\0" + e.id, json = JSON.stringify(data);
        if (UNPLANNABLE_LOGGED.get(key) === json) return;
        UNPLANNABLE_LOGGED.set(key, json);
        console.warn(`[${this.name}] move skips structure [${e.id}], which can't be checked: ${why}`);
      };
      // Where it is now, carried or moving included, as every other spatial
      // claim reads it (#82): not its rest pose.
      const fx = this.eff(e.id, nowMs);
      if (!fx.ok) { skip(`its place can't be composed (${fx.why})`); continue; }
      const sc = fx.scale > 0 ? fx.scale : 1;
      const place = { pos: fx.pos, yaw: fx.yaw, scale: sc };
      const [px, py, pz] = fx.pos;
      const c = Math.cos(fx.yaw), n = Math.sin(fx.yaw);
      const world = (lx: number, lz: number): Vec2 => ({ x: px + (lx * c + lz * n) * sc, z: pz + (-lx * n + lz * c) * sc });
      const local = (p: Vec2): [number, number] => { const [lx, , lz] = localizePoint(place, p.x, 0, p.z); return [lx, lz]; };
      let route: ReturnType<typeof prepareRouteLocal>;
      try {
        const plan = this.planFor(e.id, data);
        route = prepareRouteLocal(plan, support.kind === "terrain" ? {
          kind: "terrain", step: ROUTE_STEP_METRES / sc, scale: sc,
          // The live terrain, as the walk's ticks read it.
          heightAt: (lx: number, lz: number) => { const w = world(lx, lz); return (this.heightAt(w.x, w.z) - py) / sc; },
        } : {
          kind: "floor", step: ROUTE_STEP_METRES / sc, scale: sc, height: (support.height - py) / sc,
          ...(support.entity === e.id ? { level: support.level } : {}),
        });
      } catch (err) { skip(`its plan throws (${(err as Error)?.message ?? err})`); continue; }
      if (route.failed) { skip(route.failed); continue; }
      out.push({ id: e.id, route, local, world,
        clear: (a, b) => { const [ax, az] = local(a), [bx, bz] = local(b); return route.clear(ax, az, bx, bz); } });
    }
    return out;
  }

  /** A route from `from` to `to` that every structure clears: the straight
   * leg when none offers a detour, else the shortest structure's offered
   * detour that the others clear too. This is local planning, not global
   * multi-building search. A refusal names each structure's reason. */
  private routeFrom(from: Vec2, to: Vec2, structures: WalkStructure[]): { points: Vec2[] } | { refusal: string } {
    const candidates: { points: Vec2[]; length: number; owner: WalkStructure }[] = [];
    const refusals: string[] = [];
    for (const s of structures) {
      const [ax, az] = s.local(from), [bx, bz] = s.local(to);
      let result;
      // The straight leg was checked first, so a search that throws leaves a
      // structure in the way with no route around it.
      try { result = s.route.route(ax, az, bx, bz); }
      catch (err) { refusals.push(`[${this.refName(s.id)}]: its route couldn't be searched (${(err as Error)?.message ?? err})`); continue; }
      if (result.kind === "blocked") { refusals.push("[" + s.id + "]: " + result.reason); continue; }
      if (result.kind === "clear") continue;
      const points = result.points.map(([lx, lz]: number[]) => s.world(lx, lz));
      const length = points.slice(1).reduce((sum: number, p: Vec2, i: number) => sum + Math.hypot(p.x - points[i].x, p.z - points[i].z), 0);
      candidates.push({ points, length, owner: s });
    }
    // One structure's reason per line: a reason carries its remedy after a
    // semicolon, so joining structures with one too would run them together.
    if (!candidates.length) return refusals.length ? { refusal: "no route:\n" + refusals.join("\n") } : { points: [from, to] };
    candidates.sort((a, b) => a.length - b.length || (a.owner.id < b.owner.id ? -1 : a.owner.id > b.owner.id ? 1 : 0));
    const obstructed: string[] = [];
    for (const candidate of candidates) {
      // Supporting upper floors constrain the route, not just the walls.
      // Cross-building floor composition is outside this local planner: keep
      // the supporting structure's own validated path or explicitly refuse.
      const blocker = structures.find((s) => (s.route.confined && candidate.owner !== s)
        || !candidate.points.slice(1).every((p, i) => s.clear(candidate.points[i], p)));
      if (!blocker) return { points: candidate.points };
      obstructed.push(blocker.route.confined && candidate.owner !== blocker
        ? `[${this.refName(candidate.owner.id)}]'s route leaves the floor of [${this.refName(blocker.id)}] the body stands on`
        : `[${this.refName(candidate.owner.id)}]'s route is obstructed by [${this.refName(blocker.id)}]`);
    }
    return { refusal: [structures.some((s) => s.route.confined)
      ? "no local route preserves the supporting upper-floor path (multi-building floor composition is unavailable)"
      : "no local route is clear of all structures (multi-building route search is unavailable)",
      ...obstructed, ...refusals].join("\n") };
  }

  /** The legs of a walk from where the body stands to `to`, or why there is
   * none. A body standing in a wall (a door edited to a window under its feet)
   * first steps out to the nearest clear point beside it, within half a
   * metre, and is routed from there. */
  private planWalk(to: Vec2, support: WalkSupport): { legs: Vec2[] } | { refusal: string } {
    const structures = this.walkStructures(support), from = { x: this.pos.x, z: this.pos.z };
    if (structures.every((s) => s.clear(from, from))) {
      const route = this.routeFrom(from, to, structures);
      return "refusal" in route ? route : { legs: route.points.slice(1) };
    }
    for (const r of STEP_OUT_METRES) {
      // A step's sides: the directions whose point is clear, and which a step
      // from just off the wall reaches without crossing one. Runs of them
      // around the circle are the sides of the wall; the middle of each run
      // stands for that side, so each side is planned from once.
      const ok = Array.from({ length: STEP_OUT_DIRECTIONS }, (_, k) => {
        const th = (2 * Math.PI * k) / STEP_OUT_DIRECTIONS;
        const p = { x: from.x + r * Math.cos(th), z: from.z + r * Math.sin(th) };
        const off = { x: from.x + 1e-4 * Math.cos(th), z: from.z + 1e-4 * Math.sin(th) };
        return structures.every((s) => s.clear(p, p) && s.clear(off, p)) ? p : null;
      });
      const sides = stepSides(ok);
      if (!sides.length) continue;
      sides.sort((a, b) => Math.hypot(a.x - to.x, a.z - to.z) - Math.hypot(b.x - to.x, b.z - to.z));
      const refusals = new Set<string>();
      for (const p of sides) {
        const route = this.routeFrom(p, to, structures);
        if ("points" in route) return { legs: route.points };
        refusals.add(route.refusal);
      }
      // Each side's own reason, so the refusal says why none of them served.
      return { refusal: `the body stands in a wall, and from beside it:\n${[...refusals].join("\nfrom another side: ")}` };
    }
    return { refusal: "the body stands in a wall, with no clear point within half a metre to step out to" };
  }

  /** `y`, when given, picks the floor at the destination (#236): the place to stand nearest that height, no more than a
   *  step above it. Without it, the body's own storey if the destination has a floor within a step of it, else the lowest
   *  there. `near.reach`: how far from (x, z) a place to stand may be (a room is reached anywhere in it; a point within a
   *  hand's width or so). `near.above` / `near.below`: how far above / below y its floor may be (a step above and anything
   *  below, unless the floor's height is known exactly, as a named room's is). `near.inside`: only spots in a region.
   *  `receipt`: this request's own refusal (the plan may wait for geometry). */
  walkTo(x: number, z: number, run = false, timeoutMs = 90_000, tolerance: number = MOVER.arrive.tolerance, y?: number,
    near: Pick<NavTarget, "reach" | "above" | "below" | "inside"> & { bodyAt?: { x: number; z: number } } = {}, receipt?: { refusal: string | null }): Promise<boolean> {
    if (![x, z].every(Number.isFinite) || toleranceOf(tolerance) === null || (y != null && !Number.isFinite(y))) {
      // Not a walk request at all: the walk under way, if any, goes on.
      this.walkRefusal = WALK_ARGS_REASON;
      if (receipt) receipt.refusal = WALK_ARGS_REASON;
      return Promise.resolve(false);
    }
    // A new request supersedes the walk under way, whether or not it can be walked.
    if (this.walkDone || this.target) this.abandonWalk();
    this.walkRefusal = null;
    this.lastWalkRefusal = null; this.lastWalkNote = null; this.walkStopReason = null;
    const ticket = ++this.walkTicket;
    const now = () => {
      const p = this.walkNow(x, z, run, timeoutMs, tolerance, y, near);
      if (receipt) receipt.refusal = this.walkRefusal;   // set synchronously by the plan
      return p;
    };
    // Placed things whose geometry is still on its way (a spawn just made, a
    // join's replay) are not yet solid here: planning now would walk through
    // them. The walk waits for them — every sync issued until they're all in,
    // ones that arrive during the wait included — and if they don't land in
    // time it is refused, never walked on the terrain underneath.
    if (!this.supportPending.size) return now();
    return this.supportReady(WALK_READY_MS).then(() => {
      if (ticket !== this.walkTicket) {   // stopped, or another walk asked for, meanwhile
        if (receipt) receipt.refusal = "superseded by a newer walk or a stop";
        return false;
      }
      if (this.supportPending.size) {
        this.walkRefusal = GEOMETRY_LOADING;
        if (receipt) receipt.refusal = GEOMETRY_LOADING;
        return false;
      }
      return now();
    });
  }

  /** Bumped by every walk request and every abandon: a walk waiting for
   *  geometry knows when it has been superseded. */
  private walkTicket = 0;

  private walkNow(x: number, z: number, run: boolean, timeoutMs: number, tolerance: number, y: number | undefined,
    near: Pick<NavTarget, "reach" | "above" | "below" | "inside"> & { bodyAt?: { x: number; z: number } }, replanned = false): Promise<boolean> {
    // Plan before touching the body, from the ground under it: a refused walk
    // leaves it seated, pinned, dragged, posed or tumbling as it was, and sends nothing. The
    // walk's floor, its grid's start and where it stands up are all found
    // from the feet, as when it stands up (setPosture, feetGround).
    const slumped = this.isSlumped();
    const feetY = this.feetY(slumped);
    const support = this.walkSupport(feetY);
    const plan = this.planWalk({ x, z }, support);
    if ("refusal" in plan) { this.walkRefusal = plan.refusal; return Promise.resolve(false); }
    // A walk from a floor stays on it: the router plans it on that floor
    // alone, and a griddled building's storeys have no stairs between
    // them or to the ground. So a destination whose height means another
    // of the floors there (floorMeant: move's own rule for a height,
    // with the destination's bounds), another storey, another building's
    // or the ground, is refused here, once the router has planned the
    // walk and before the navgrid routes it or its legs are walked (the
    // planner's legs never read y), rather than walked to at the same x
    // and z on this floor. Unless something placed on this floor, under
    // the next floor above, stands at about that height there
    // (placedNear): then the walk goes, and the navgrid, when it routes
    // the walk, reads the height against what is placed. A named
    // destination's height and bounds are the world's: a place, a seat, a
    // room, a thing's entrance, a person, whose floor is the one their
    // body is on where they are, not where the walk stops short of them.
    if (support.kind === "floor" && y != null) {
      const at = near.bodyAt ?? { x, z };
      const meant = this.floorMeant(at.x, at.z, y, near, support, near.bodyAt != null);
      const ceiling = Math.min(Infinity, ...this.floorsAt(at.x, at.z, support).filter((f) => f.height > support.height + 0.02).map((f) => f.height));
      if ((!meant || meant.entity !== support.entity || meant.level !== support.level) && !this.placedNear(at.x, at.z, y, near, support.height, ceiling)) {
        const whose = meant ? `whose floor is at ${meant.height.toFixed(2)}m` : "";
        const where = !meant ? "on no floor here" : meant.entity === null ? "at ground level"
          : meant.entity === support.entity ? `on another storey of this building, ${whose}` : `on a storey of another building, ${whose}`;
        // a person's height is their root, not a height anyone gave or sees
        const what = near.bodyAt ? "the destination" : `the destination (height ${y.toFixed(2)}m)`;
        this.walkRefusal = `${what} is ${where}, not on the floor you stand on (${support.height.toFixed(2)}m). A walk from a floor stays on it, since a griddled building's storeys have no stairs between them or to the ground; pick a destination on this floor, or give to as [x, z], without y, which stays on it`;
        return Promise.resolve(false);
      }
    }
    // Through placed models: a walk the structure planner leaves as one
    // straight leg is routed against the colliders the feet will meet —
    // round the furniture, through the door, up the stair (mcpl/navgrid.ts).
    let legs = plan.legs, snapped = false, routed = false, passIds = new Set<string>();
    // A floor walk's probe stands on that storey, which the colliders don't
    // hold, so placed models on it are routed round as they are on the
    // ground (walkProbeGround), and nowhere lower than that floor
    // (onOrAboveFloor). Its grid is the walk's own: the cached one answers
    // for the terrain.
    const surface = this.walkProbeGround(support);
    const raw = plan.legs.length === 1 ? navProbe(surface) : null;
    const probe = raw && support.kind === "floor" ? onOrAboveFloor(raw, support.height) : raw;
    if (probe) {
      // plan from the floor under the feet: a tumbling or seated body's root
      // is not where its feet will be
      const feet = { x: this.pos.x, y: feetY, z: this.pos.z };
      // a loose thing this body would shove is walked into, not round (R's queue: "walking into a loose thing pushes
      // it"): its collider is out of the planner's world while it plans — the feet and the authority still meet it
      const { ids, colliders: passable } = this.passableColliders(run); passIds = ids;
      // a grid is good until the colliders, the COMMITTED terrain (navTerrainRev, main 5106691c: a pending heightmap
      // keeps the old ground and its grid), or what it may walk into change. A floor walk's grid is its own: the
      // cached one answers for the terrain.
      const navKey = `${collidersGeneration()}|${this.navTerrainRev}|${passable.join(",")}`;
      let grid;
      if (support.kind === "floor") grid = makeNavGrid(probe);
      else {
        if (this.navGrid?.gen !== navKey) this.navGrid = { gen: navKey, grid: makeNavGrid(probe) };
        grid = this.navGrid.grid;
      }
      const nav = inWorld(this.world, () => {
        const fy = standOn(feet, surface) ?? feetY;
        const from = { x: this.pos.x, y: fy, z: this.pos.z };
        return withoutColliders(passable, () => {
          const first = grid.route(from, { x, z, y, ...near });
          // A person's bound reaches the surface a body lies on (destination()),
          // which no route may reach, such as a top bunk: then the place to
          // stand nearest them no higher than their root, the floor beside it.
          // (No higher than the root, not within a step of it: the walker's
          // step, NAV_STEP, is more than RAGDOLL_ROOT_DROP, so a step above the
          // root of someone lying down still reaches the bunk they lie on.)
          if (!("refusal" in first) || !near.bodyAt) return first;
          const beside = grid.route(from, { x, z, y, ...near, above: 0 });
          return "refusal" in beside ? first : beside;
        });
      });
      if ("refusal" in nav) { this.walkRefusal = nav.refusal; return Promise.resolve(false); }
      // griddled structures keep their walls out of the headless colliders,
      // so a detour round the furniture is checked against them like any
      // structure route; one that crosses a wall gives way to the structure
      // planner's own legs
      const structures = this.walkStructures(support);
      const pts = [{ x: this.pos.x, z: this.pos.z }, ...nav.points.map((p) => ({ x: p.x, z: p.z }))];
      const crosses = structures.length > 0 && pts.slice(1).some((p, k) => structures.some((st) => !st.clear(pts[k], p)));
      if (!crosses) {
        legs = nav.points.map((p) => ({ x: p.x, z: p.z, y: p.y }));
        snapped = nav.snapped; routed = true;
      }
    }
    if (this.draggedBy) {   // deciding to walk IS breaking the dragger's hold
      this.ws?.send(JSON.stringify({ type: "bodydrag", target: this.draggedBy, end: true }));
      this.draggedBy = null;
      this.heldPose = null; this.heldPoseAuthored = false; this.clip = "idle";
    }
    this.pins.clear();      // and walking tears out every nail
    ++this.bodyEpoch;       // ...and outranks a tumble or settle still loading
    this.body?.stop(); this.stopSim();   // a body that decides to walk is done tumbling
    // deciding to walk IS getting up — shed the held pose, or the body zombie-
    // walks with it frozen over the stride. The default stays "held until you
    // clear_pose or move" for everything that did NOT ask otherwise, because
    // that unconditional shed is also what lets a store poisoned with a
    // relabelled tumble frame (#61) self-heal on the resident's first walk —
    // and a restored pose arrives marked authored, so authorship alone is NOT
    // a safe test. Only a pose this body deliberately pinned with `hold`
    // survives, identified by object (see heldPoseSticky), which a restore or
    // a tumble frame can never satisfy.
    const sticky = this.heldPose != null && this.heldPose === this.heldPoseSticky;
    if ((this.heldPose && !sticky) || this.clip === "ragdoll") {
      if (!sticky) { this.heldPose = null; this.heldPoseAuthored = false; }
      if (this.clip === "ragdoll") this.clip = "walk";
    }
    // and deciding to walk IS getting off the seat — a folded mount otherwise
    // glues this body to its socket on every renderer, wherever the feet go
    if (this.joined && this.myOccupancy && this.mayVacate("menu")) this.setOccupant(null);
    // and stand on the ground you got up onto: with colliders loaded, the floor under the feet found from where they
    // are (a body seated upstairs stands up upstairs, #235); the planner's support answer otherwise
    const supportAt = support.kind === "terrain" ? (wx: number, wz: number) => this.heightAt(wx, wz) : () => support.height;
    const standFrom = { x: this.pos.x, y: feetY, z: this.pos.z };
    this.pos.y = inWorld(this.world, () => (collidersReady() ? standOn(standFrom, supportAt) : null)) ?? support.height;
    this.vy = 0; this.grounded = true; this.stallTicks = 0; this.walkStall = null;
    // A structure route's corners are reached exactly (its doorways are planned to the centimetre); a routed walk's
    // (#236) may sit where something nudges the body a little, so they — and its end — count within that.
    this.legTolerance = routed ? NAV_NUDGE : 0;
    this.walkTolerance = routed ? Math.max(tolerance, NAV_NUDGE) : tolerance;
    // A terrain walk reads the live terrain each tick, as the planner read it;
    // a floor walk keeps the floor that admitted the route through its last tick.
    this.walkHeightAt = support.kind === "terrain" ? (wx, wz) => this.heightAt(wx, wz) : () => support.height;
    // ROUTE THROUGH WALLS RATHER THAN INTO THEM (planWalk, and through placed models the navgrid): the legs that clear
    // every known structure, ending on the point asked for, exactly — unless it was no place to stand and the planner
    // chose the nearest one that is. Only the last takes the caller's tolerance.
    const end = legs[legs.length - 1] as Vec2 & { y?: number };
    this.legs = snapped ? legs.slice() : legs.slice(0, -1).concat({ x, z, ...(routed && end?.y != null ? { y: end.y } : {}) });
    const first = this.legs.shift()!;
    this.target = { x: first.x, z: first.z, run, tolerance: this.legs.length ? this.legTolerance : this.walkTolerance, ...(first.y != null ? { y: first.y } : {}) };
    // E1: the authority walks this body too, and a stretch it refuses (a wall, too fast) isn't walked (see trackHere).
    // With no authority to ask (not joined, no open socket) the gate is open at once: the verdict trackHere would reach a
    // tick later (request() answers not-joined, which it reads as {open}), without the tick.
    const asks = this.joined && this.ws?.readyState === 1;
    const gate: WalkGate = { mode: asks ? "sync" : "open", permit: null, busy: false };
    this.walkGate = gate;
    this.walkPlan = { x, z, run, timeoutMs, tolerance, y, near, passable: passIds, replanned };
    if (asks) this.syncWalkGate(gate);
    return new Promise((resolve) => {
      this.walkDone = resolve;
      setTimeout(() => { if (this.walkDone === resolve) this.abandonWalk(); }, timeoutMs);
    });
  }

  /** A walk carried across a rejoin: the authority's track of this body ended with the old connection, so the walk asks
   *  again where it stands. It does so on a gate of its own, since a request the old connection sent (a stretch of the
   *  walk, or where it stood) answers the gate it was sent for, and its answer, often a timeout, mustn't end this walk. */
  private resumeWalkGate() {
    const old = this.walkGate;
    if (!old || old.mode === "open") return;   // open: the authority keeps no track of this body, so there is nothing to ask
    // nothing in flight carries over: a stretch or a shove the old connection sent settles on the old gate, so the new one
    // starts with no permit asked for and no shove holding it
    const g: WalkGate = { ...old, busy: false, permit: null, blocker: null, hold: 0 };
    this.walkGate = g;
    this.syncWalkGate(g);
  }
  /** Ask the authority where this body stands, and open the walk's gate on its answer: a walk's start, and a rejoin. */
  private syncWalkGate(gate: WalkGate) {
    gate.mode = "sync"; gate.permit = null;
    void this.trackHere().then((t) => {
      if (this.walkGate !== gate) return;
      if ("open" in t) { gate.mode = "open"; return; }
      if (!t.ok) { this.refuseWalk(t.refused); return; }
      gate.mode = "tracked"; gate.permit = this.trackAt;
    });
  }

  // ---- named places (mcpl/places.ts) ----------------------------------------

  /** A thing's named places: its model's own (rooms, doors, seats, arrivals),
   *  then its `places` component on top — which anyone with builder rank can
   *  change at any time. */
  placesOn(e: Entity): Place[] {
    // a model's file may declare places; any thing's transform is a frame to hang named ones on (an Empty's included)
    return placesOf(e.model ? modelMeta.get(`${this.httpBase}|${e.model}`) : undefined, recordComponents(e).places);
  }

  /** Where a thing's places are right now: its effective transform (mount
   *  chain, whole-entity motion) — its saved `pos` is where it was put, not
   *  where a carried or moving thing is. Null when that cannot be resolved. */
  private placeHolder(e: Entity, nowMs = Date.now()): PlaceHolder | null {
    const f = this.eff(e.id, nowMs);
    // its per-axis scale, so a place on a stretched thing is stretched with it, as the thing is drawn. places.ts frames
    // only positive axes, so a mirrored thing keeps its one-number scale, as before
    const s3 = f.ok ? f.scale3 : undefined;
    const scale = Array.isArray(s3) && s3.every((v) => v > 0) ? s3 : f.ok ? f.scale : undefined;
    return f.ok ? { id: e.id, name: this.refName(e.id), pos: f.pos, yaw: f.yaw, q: f.quat, scale } : null;
  }

  /** Places that belong to no thing ("the meadow"): @world's places component, in world coordinates. */
  worldPlaces(): Place[] {
    return placesOf(null, this.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places);
  }
  private static readonly WORLD_HOLDER: PlaceHolder = { id: WORLD_ENTITY, pos: [0, 0, 0], yaw: 0, scale: 1 };

  /** Everything that holds named places, with where it is now: @world, then each placed model that has any. */
  private placeHolders(nowMs = Date.now()): { id: string; h: PlaceHolder | null; ps: Place[]; e: Entity | null }[] {
    const out: { id: string; h: PlaceHolder | null; ps: Place[]; e: Entity | null }[] = [];
    const wp = this.worldPlaces();
    if (wp.length) out.push({ id: WORLD_ENTITY, h: WorldAgent.WORLD_HOLDER, ps: wp, e: null });
    for (const e of this.entities.values()) {
      const ps = this.placesOn(e);
      if (ps.length) out.push({ id: e.id, h: this.placeHolder(e, nowMs), ps, e });
    }
    return out;
  }

  /** Every named place here, nearest first: where a walk to it aims (its floor), how far, which floor. */
  placesNear(): { ref: string; place: Place; dest: Destination; d: number }[] {
    const out: { ref: string; place: Place; dest: Destination; d: number }[] = [];
    for (const { id, h, ps } of this.placeHolders()) {
      if (!h) continue;
      for (const p of ps) { const dest = destinationOf(h, p); out.push({ ref: `${id === WORLD_ENTITY ? id : this.refName(id)}/${p.name}`, place: p, dest, d: Math.hypot(dest.x - this.pos.x, dest.z - this.pos.z) }); }
    }
    return out.sort((a, b) => a.d - b.d);
  }
  private static placeLine(x: { ref: string; place: Place; dest: Destination; d: number }) {
    return `${x.ref}${x.place.label && x.place.label !== x.place.name.replace(/_/g, " ") ? ` "${x.place.label}"` : ""} (${x.d.toFixed(1)} m, floor ${x.dest.y.toFixed(2)} m)`;
  }
  /** move {to: "?"}: every named place, seen or not (owner 22:40) — nearest first, at most PLACE_LIST_MAX (a built-up
   *  world's list was megabytes; review r3 F7). move {to: "?<text>"} lists only those whose "thing/place" or label
   *  holds that text (any case). */
  placeList(filter = ""): string {
    const f = filter.trim().toLowerCase();
    const all = this.placesNear().filter((x) => !f || x.ref.toLowerCase().includes(f) || (x.place.label ?? "").toLowerCase().includes(f));
    if (!all.length) return f ? `no named places here whose name or label holds "${filter.trim()}" — move {to: "?"} lists them all`
      : "no named places here — a model can declare them, and name_place names a spot";
    const shown = all.slice(0, PLACE_LIST_MAX), more = all.length - shown.length;
    return `named places here${f ? ` holding "${filter.trim()}"` : ""}, nearest first (move {to: "<thing>/<place>"} or a place's name):\n${shown.map((x) => `  ${WorldAgent.placeLine(x)}`).join("\n")}`
      + (more ? `\n…and ${more} more, farther away — narrow it with move {to: "?<text>"} (e.g. "?${shown[shown.length - 1].ref.split("/")[0]}"): only places whose name or label holds that text` : "");
  }
  /** look's listing (owner 22:43): the places this body can SEE — a ray from its eye to the place (a point, or a room's
   *  middle a metre over its floor) unblocked by the placed models' fitted colliders (the same ones the feet use, #235)
   *  and the terrain — within PLACE_SIGHT_M, nearest first, at most PLACE_LOOK_MAX. Before the collision modules have
   *  loaded, distance alone decides (and the line says so). */
  placesInSight(): { lines: string[]; more: number; byDistance: boolean } {
    const eye = [this.pos.x, this.pos.y + this.stature() * 0.93, this.pos.z];
    const seen: string[] = []; let byDistance = false, total = 0;
    for (const x of this.placesNear()) {
      total++;
      if (x.d > PLACE_SIGHT_M || seen.length >= PLACE_LOOK_MAX) continue;
      const tip = [x.dest.x, x.dest.y + (x.place.kind === "region" ? 1 : 0.3), x.dest.z];
      const los = inWorld(this.world, () => lineOfSight(eye, tip, (wx, wz) => this.heightAt(wx, wz)));
      if (los === null) byDistance = true;
      if (los === false) continue;
      seen.push(WorldAgent.placeLine(x));
    }
    return { lines: seen, more: total - seen.length, byDistance };
  }

  /** The named regions a body standing at `w` is in, smallest first (a room
   *  before the building it is in). */
  placesAt(w: number[]): { entity: { id: string }; place: Place }[] {
    const out: { entity: { id: string }; place: Place; vol: number }[] = [], now = Date.now();
    for (const { id, h, ps } of this.placeHolders(now)) {
      const e = { id };
      if (!h) continue;
      const s3 = frameVolume(h);   // the thing's volume factor, as its places are framed
      for (const p of ps) {
        if (!inRegion(h, p, w)) continue;
        out.push({ entity: e, place: p, vol: s3 * (p.max![0] - p.min![0]) * (p.max![1] - p.min![1]) * (p.max![2] - p.min![2]) });
      }
    }
    return out.sort((a, b) => a.vol - b.vol);
  }

  /** Where `to` is, as a walk can aim at it: "thing/place", a thing alone
   *  (its entrance, else its door, else up to it and beside it), a place's name or label alone (the
   *  nearest, if several things have one), a thing by its label, or a person
   *  (stopping short of them) — in that order: a person's name never hides a
   *  thing's, by id or by label. */
  destination(to: string): Destination | { refusal: string } {
    const q = to.trim();
    if (!q) return { refusal: "move's to names nothing" };
    const me = this.pos, now = Date.now();
    const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const slash = q.indexOf("/");
    const ents = [...this.entities.values()].filter((e) => isFiniteVec3(e.pos));
    if (slash > 0 && q.slice(0, slash) === WORLD_ENTITY) {   // a place that belongs to no thing
      const name = q.slice(slash + 1), ps = this.worldPlaces(), p = ps.find((x) => names(x, name));
      return p ? destinationOf(WorldAgent.WORLD_HOLDER, p) : { refusal: `@world has no place called "${name}"${ps.length ? ` — its places: ${ps.map((x) => x.name).join(", ")}` : ""}` };
    }
    const at = (e: Entity, p: Place): Destination | { refusal: string } => {
      const h = this.placeHolder(e, now);
      const why = h ? "" : (this.eff(e.id, now) as { why: string }).why;
      return h ? destinationOf(h, p) : { refusal: `where [${this.refName(e.id)}] is right now cannot be worked out (${why})${partHint(why)}` };
    };
    if (slash > 0) {
      const tr = this.thingRef(q.slice(0, slash));   // its id, its label or a unique id prefix (R 10-17); a shared label is refused with the candidates
      if ("refusal" in tr) return tr;
      const e = ents.find((x) => "id" in tr && x.id === tr.id) ?? ents.find((x) => ci(x.id, q.slice(0, slash)));
      if (!e) return { refusal: `no thing called "${q.slice(0, slash)}" here` };
      const name = q.slice(slash + 1), ps = this.placesOn(e), p = ps.find((x) => names(x, name));
      if (!p) return { refusal: `[${this.refName(e.id)}] has no place called "${name}"${ps.length ? ` — its places: ${ps.map((x) => x.name).join(", ")}` : " (it has no named places)"}` };
      return at(e, p);
    }
    // a thing: its entrance, else its door, else walked up to and stood beside (review r5 F3: here, not in a second
    // resolver of move's — a person named like it never captures the walk, and of several, the nearest is taken)
    const thing = (x: Entity): Destination | { refusal: string } => {
      const ps = this.placesOn(x);
      const p = ps.find((y) => y.name === "entrance") ?? ps.find((y) => y.kind === "door");
      return p ? at(x, p) : this.besideThing(x, now);
    };
    const e = ents.find((x) => ci(x.id, q));
    if (e) return thing(e);
    const hits: Destination[] = [];
    for (const p of this.worldPlaces()) if (names(p, q)) hits.push(destinationOf(WorldAgent.WORLD_HOLDER, p));
    for (const x of ents) for (const p of this.placesOn(x)) {
      if (!names(p, q)) continue;
      const d = at(x, p);
      if (!("refusal" in d)) hits.push(d);
    }
    if (hits.length) return hits.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    // a thing by its label (a display name someone gave it) or a unique id prefix — before any person too (review r4 claims
    // C1: a visitor named like a thing's label captured the walk). R 10-17: a label two things share is refused with the
    // candidates (label, what, where, handle), never resolved to the nearest
    { const tr = this.thingRef(q); if ("refusal" in tr) return tr;
      if ("id" in tr) { const x = ents.find((y) => y.id === tr.id); if (x) return thing(x); } }
    // a person, last (review r3 F4): a visitor who joins as "tower" must not capture every walk to the tower
    for (const p of this.people.values()) {
      if (!ci(p.id, q)) continue;
      const xyz = posePosition(p.pose);
      if (!xyz) return { refusal: `${p.id}'s position is not known yet` };
      const [x, root, z] = xyz, d = Math.hypot(me.x - x, me.z - z), back = d > 0.01 ? Math.min(0.9, d) / d : 0;
      // Presence carries the root, not how a body came to be there: one
      // standing, or held by a canned slump, has its root on its floor; one a
      // sim laid down, under clip "ragdoll" or a physics pose held under
      // another, has it about RAGDOLL_ROOT_DROP below the surface it lies on.
      // So their floor may be up to that drop above the root: the navgrid
      // takes the place to stand nearest the root within it (the floor they
      // lie on, or the floor beside the bed they lie on; where no route
      // reaches it, walkNow routes again within a step), and a floor walk's
      // check the floor their body is on where they are (bodyAt). Without the
      // bound, a walk to someone lying on this floor reads as one to a floor
      // beneath.
      return { x: x + (me.x - x) * back, y: root, z: z + (me.z - z) * back, reach: 0.6, label: p.id,
        above: RAGDOLL_ROOT_DROP + 0.05, bodyAt: { x, z } };
    }
    const known = this.placesNear().map((x) => x.ref);
    return { refusal: `nothing here is called "${q}"${known.length ? ` — named places: ${known.slice(0, 16).join(", ")}${known.length > 16 ? ` and ${known.length - 16} more (move {to: "?"} lists them all)` : ""}` : ""}` };
  }

  /** A thing with no entrance or door, as a walk aims at it: up to it and beside it, on this body's side — THING_STANDOFF
   *  out from the nearest point of its footprint (its origin where the footprint isn't known, THING_STOP short of it). */
  private besideThing(x: Entity, now = Date.now(), depth = 0): Destination | { refusal: string } {
    const me = this.pos, box = footprint(this.replica?.st, x.id), w = this.worldPointOf(x.id, now);
    // where it stands: its effective point, else the middle of its footprint; never its saved pos, a child's offset
    const at = "pos" in w ? w.pos : box ? [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2] : null;
    if (!at) return { refusal: `can't tell where [${this.refName(x.id)}] stands now — ${"why" in w ? `${w.why}${partHint(w.why)}` : "no frame"}` };
    let px = at[0], pz = at[2], off = THING_STOP;
    if (box) {
      const nx = Math.min(box.max[0], Math.max(box.min[0], me.x)), nz = Math.min(box.max[2], Math.max(box.min[2], me.z));
      if (Math.hypot(me.x - nx, me.z - nz) > 1e-6) { px = nx; pz = nz; off = THING_STANDOFF; }
    }
    const d = Math.hypot(me.x - px, me.z - pz), back = d > 0.01 ? Math.min(off, d) / d : 0;
    const dest: Destination = { x: px + (me.x - px) * back, y: box ? box.min[1] : at[1], z: pz + (me.z - pz) * back, reach: 0.6, label: `[${this.refName(x.id)}]` };
    // a thing standing on another (a cup on a table): the spot beside it may be on that other's top, where a walk can't
    // climb — then the spot beside what holds it up, on ITS floor, is walked to instead (review r6 L1)
    const under = box && depth < 4 ? this.supportOf(x.id, box) : null;
    if (under) { const ob = this.besideThing(under, now, depth + 1); if (!("refusal" in ob)) dest.orBeside = { ...ob, label: dest.label }; }
    return dest;
  }

  /** The placed thing a thing rests on: the highest top (its footprint's) under the thing's footprint, within a couple of
   *  centimetres of its base — never the thing itself nor anything riding on it. Null when it stands on the ground. */
  private supportOf(id: string, box: { min: number[]; max: number[] }): Entity | null {
    const st = this.replica?.st;
    const rides = (k: string) => { for (let c: string | undefined = k, n = 0; c && n < 33; n++) { if (c === id) return true; const p: unknown = st?.entities?.[c]?.c?.parent?.to; c = typeof p === "string" ? p : undefined; } return false; };
    let best: Entity | null = null, top = -Infinity;
    for (const e of this.entities.values()) {
      if (rides(e.id)) continue;
      const b = footprint(st, e.id);
      if (!b || b.max[0] <= box.min[0] || b.min[0] >= box.max[0] || b.max[2] <= box.min[2] || b.min[2] >= box.max[2]) continue;
      if (Math.abs(b.max[1] - box.min[1]) <= 0.03 && b.max[1] > top) { best = e; top = b.max[1]; }
    }
    return best;
  }

  /** Where a thing stands in the world now: its effective transform (a child's parent chain, any motion), or why that
   *  can't be worked out. Never its saved `pos` in its place: for a child, that is its offset from its parent. */
  worldPointOf(id: string, now = Date.now()): { pos: [number, number, number] } | { why: string } {
    const f = this.eff(id, now);
    return f.ok ? { pos: f.pos } : { why: f.why };
  }

  /** name_place edits, one at a time: each starts from the state the last
   *  one's echo confirmed, so two in a row don't overwrite each other. */
  private placeEdits: Promise<unknown> = Promise.resolve();

  /** Name a spot (the body's own, by default) as a place on a thing: written
   *  into that thing's `places` component, in its frame, alongside what is
   *  already there. `remove` retires a name (null: that also hides one the
   *  model itself declares). `at` may leave out y: the floor there nearest
   *  the body's own height. Answers once the world accepts or refuses it. */
  namePlace(name: string, opts: { on?: string; label?: string; remove?: boolean; at?: { x: number; z: number; y?: number } } = {}): Promise<ActResult> {
    const run = this.placeEdits.then(() => this.namePlaceNow(name, opts));
    this.placeEdits = run.catch(() => {});
    return run;
  }

  private async namePlaceNow(name: string, opts: { on?: string; label?: string; remove?: boolean; at?: { x: number; z: number; y?: number } }): Promise<ActResult> {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_ .:'-]{0,47}$/.test(name)) return refused("a place name is 1-48 letters, digits, spaces, _ . : ' or -, starting with a letter, digit or _");
    let w: number[];
    if (opts.at) {
      const { x, z } = opts.at;
      // the floor there nearest the feet's height: a placed model's, a
      // griddled storey's, or the terrain
      const feetY = this.feetY(this.isSlumped());
      const ground = (wx: number, wz: number) => this.groundAt(wx, wz, feetY);
      const y = opts.at.y ?? inWorld(this.world, () => standOn({ x, y: feetY, z }, ground)) ?? ground(x, z);
      w = [x, y, z];
    } else w = [this.pos.x, this.pos.y, this.pos.z];
    const now = Date.now();
    // where the name hangs: a placed thing (in its frame, so it moves with it), or @world (world coordinates: a place
    // that belongs to no thing — on: "@world", or a spot in a room @world declares)
    let target: { id: string; h: PlaceHolder | null; had: unknown } | null = null;
    const ofEntity = (e: Entity) => ({ id: e.id, h: this.placeHolder(e, now), had: recordComponents(e).places });
    const ofWorld = () => ({ id: WORLD_ENTITY, h: WorldAgent.WORLD_HOLDER, had: this.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places });
    if (opts.on) {
      if (opts.on === WORLD_ENTITY) target = ofWorld();
      else {
        const e = [...this.entities.values()].find((x) => x.id.toLowerCase() === opts.on!.toLowerCase());
        if (e) target = ofEntity(e);
      }
    } else {
      const inId = this.placesAt(w)[0]?.entity.id;
      const inE = inId && inId !== WORLD_ENTITY ? this.entities.get(inId) : undefined;
      if (inE) target = ofEntity(inE);
      else if (inId === WORLD_ENTITY) target = ofWorld();
      else {
        let best = Infinity;
        for (const x of this.entities.values()) {
          if (!x.model) continue;
          const h = this.placeHolder(x, now);
          if (!h) continue;
          const d = Math.hypot(h.pos[0] - w[0], h.pos[2] - w[2]);
          if (d < best && d <= 15) { best = d; target = ofEntity(x); }
        }
      }
    }
    if (!target) return refused(opts.on ? `no thing called "${opts.on}" here` : "no placed thing within 15m to hang the name on — pass on: <thing id> (or on: \"@world\")");
    const h = target.h;
    if (!h) return refused(`where [${this.refName(target.id)}] is right now cannot be worked out, so a spot on it cannot be named — try again when it rests`);
    const t0 = Date.now(), id = target.id;
    const placesNow = () => id === WORLD_ENTITY ? this.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places
      : (this.entities.get(id) ? recordComponents(this.entities.get(id) as Entity).places : undefined);
    let had = target.had, cur: Record<string, unknown> = {}, r: any, replace = false;
    for (let attempt = 0; ; attempt++) {
      cur = (had && typeof had === "object" && !Array.isArray(had)) ? { ...(had as Record<string, unknown>) } : {};
      // re-pointing a name the bag already holds replaces its entry: a merge would keep a room's min and max beside the
      // new point, a shape the authority refuses
      replace = !!opts.remove || Object.prototype.hasOwnProperty.call(cur, name);
      if (opts.remove) {
        // always a hiding entry: whether the model declares the name is not
        // known until its file has loaded, and a deleted entry would let it back
        cur[name] = null;
      } else {
        const l = toLocal(h, w).map((v) => Math.round(v * 1000) / 1000);
        cur[name] = { at: l, ...(opts.label ? { label: opts.label.slice(0, 80) } : {}) };
      }
      // an ordinary set of the places component, through the authority: rights, the gate and undo apply as to any edit.
      // Adding a name merges just that name (RFC 7396); retiring one replaces the bag with the name held as null, since a
      // merge's null would delete the entry and let a name the model declares back in, and re-pointing one replaces the
      // bag too (above). Its size is the authority's to judge (its gate keeps values under 64 KiB). That replace is
      // built from this replica, so it is PINNED to the bag it read (expect, §3a): if someone else wrote a name in between,
      // the authority refuses it as `changed`, and it is rebuilt from the bag as it now is (review r3 F5)
      const op = replace ? OP.set(id, "places", cur) : OP.set(id, "places", { [name]: cur[name] }, { merge: true });
      const pin = replace ? { expect: [{ id: op.args.id, component: op.args.component, ...(had !== undefined ? { value: had } : {}) }] } : {};
      r = await this.sendOps([op], pin);
      if (!(replace && r && !r.ok && r.refused?.code === "changed" && attempt < 4)) break;
      // the other write's log reaches this replica before (or just after) the refusal: wait for the bag to move
      for (const until = Date.now() + 1000; Date.now() < until && JSON.stringify(placesNow()) === JSON.stringify(had);) await new Promise((res) => setTimeout(res, 50));
      had = placesNow();
    }
    // no answer is not a refusal: the write may have landed
    if (r && !r.ok && (r.refused?.code === "timeout" || r.refused?.code === "no-answer"))
      return refused(`"${name}" was sent, but the world didn't answer, so whether it landed is unknown — look, or [${this.refName(id)}]'s places component, will show it`);
    if (r && !r.ok) return refused(`not named — the world refused: ${r.refused?.reason ?? r.refused?.code ?? JSON.stringify(r.refused ?? r)}`);
    // the authority's answer is in; wait for this body's own fold of it, so a move {to} straight after finds the name
    for (const deadline = t0 + 3000; Date.now() < deadline;) {
      const got = id === WORLD_ENTITY ? this.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places : recordComponents(this.entities.get(id) as Entity).places;
      if (JSON.stringify(got?.[name] ?? null) === JSON.stringify(cur[name] ?? null)) {
        { const nm = id === WORLD_ENTITY ? id : this.refName(id);
          return done(opts.remove ? `retired "${name}" on [${nm}]` : `named this spot "${name}" on [${nm}] — move {to: "${nm}/${name}"} reaches it`); }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Sent and not refused: whether it landed is for look to show.
    return done(`sent "${name}" to [${id}], but the world has not confirmed it yet — look will show it once it lands`);
  }

  // ---- feet ----------------------------------------------------------------
  // The browser walking controller's vertical model (client/lib/controller.js),
  // run against the same fitted colliders: move, resolveColliders (which pushes
  // the capsule out of anything solid and answers the ground under it — a
  // stair tread within a step, a floor below the feet, else terrain), then snap
  // onto that ground or fall toward it under gravity.
  private vy = 0;
  private grounded = true;
  /** What the route planner has learned about this world's columns, good
   *  until the colliders change (physics.ts collidersGeneration). */
  private navGrid: { gen: string; grid: ReturnType<typeof makeNavGrid> } | null = null;
  /** How close counts as reaching an intermediate waypoint of the walk under way. */
  private legTolerance = 0;
  /** Set from a join until its support registrations land (see the join). */
  private feetSettling = false;
  private stallTicks = 0;
  /** Why the last walk stopped short, when something solid stopped it; read by
   *  the move tool once the walk's promise answers false. */
  walkStall: string | null = null;

  /** → the ground the feet found at the end (the water stance is judged on it). */
  private stepFeet(mx: number, mz: number, dt: number, terrain: (x: number, z: number) => number): number {
    const n = Math.max(1, Math.ceil(Math.hypot(mx, mz) / COLLIDE_SUBSTEP));
    const sdt = dt / n;
    let ground = terrain(this.pos.x, this.pos.z);
    for (let i = 0; i < n; i++) {
      this.pos.x += mx / n; this.pos.z += mz / n;
      ground = standOn(this.pos, terrain) ?? terrain(this.pos.x, this.pos.z);
      if (!this.grounded || this.pos.y > ground + 0.02) {
        this.grounded = false;
        this.vy -= GRAVITY * sdt;
        this.pos.y += this.vy * sdt;
        if (this.pos.y <= ground) { this.pos.y = ground; this.vy = 0; this.grounded = true; }
      } else { this.pos.y = ground; this.vy = 0; this.grounded = true; }
    }
    return ground;
  }

  /** The floor the feet find at (x, z) from height y (colliders.resolveColliders through standOn; `floor` where the
   *  colliders aren't loaded). Never moves the body. */
  private feetAt(x: number, z: number, y: number, floor: (x: number, z: number) => number): number {
    if (!collidersReady()) return floor(x, z);
    const p = { x, y, z };
    return inWorld(this.world, () => standOn(p, floor)) ?? floor(x, z);
  }
  /** The height a stretch asked of the authority stands at: the floor the feet will find there (an upstairs walk asks for
   *  upstairs, #235), the terrain where the colliders aren't loaded. */
  private permitFloor(x: number, z: number): number {
    return this.feetAt(x, z, this.pos.y, (wx, wz) => this.heightAt(wx, wz));
  }

  /** Whether the body lies as a sim lays one: the ragdoll clip, or a held
   *  pose it didn't author, a physics pose kept under another clip. */
  private isSlumped(): boolean {
    return this.clip === "ragdoll" || (this.heldPose != null && !this.heldPoseAuthored);
  }

  /** The ground the tick holds a body's feet to when nothing else does:
   *  groundAt from the feet (feetY), so a body holding a physics pose under
   *  another clip, its root RAGDOLL_ROOT_DROP under its feet, keeps the
   *  storey it lies on. */
  private standingGround(): (x: number, z: number) => number {
    const feetY = this.feetY(this.isSlumped());
    return (x, z) => this.groundAt(x, z, feetY);
  }

  /** The height of the feet, for finding the floor a body stands on: its y,
   *  but a slumped or tumbling body has its feet RAGDOLL_ROOT_DROP above its
   *  root, as a sim lays it, unless the slump is canned (rootCanned): held
   *  before any sim has run or with no sim to run, its root is at its feet's
   *  height. */
  private feetY(slumped: boolean): number {
    return slumped && !this.rootCanned() ? this.pos.y + RAGDOLL_ROOT_DROP : this.pos.y;
  }

  /** A canned slump's root: still at the height knockDown found the feet at. */
  private rootCanned(): boolean {
    return this.cannedY != null && this.pos.y === this.cannedY;
  }

  /** The ground under the feet as a standing body finds it: the fitted
   *  colliders when loaded, over the ground groundAt gives (an upper
   *  storey's floor, else the terrain); without colliders, that ground. */
  private feetGround(fromRagdoll = false): number {
    // a settled ragdoll's root lies ~0.68m BELOW the surface holding it up
    // (support-lifecycle-test's hipsOffset); probing from the root itself
    // would start under a thin upper floor and find the storey beneath. A
    // canned slump's root is at its feet, and the probe starts there (feetY).
    const from = { x: this.pos.x, y: this.feetY(fromRagdoll), z: this.pos.z };
    // under the colliders, the terrain or a griddled storey's floor
    const terrain = (x: number, z: number) => this.groundAt(x, z, from.y);
    const g = inWorld(this.world, () => (collidersReady() ? standOn(from, terrain) : null));
    if (g != null) { this.pos.x = from.x; this.pos.z = from.z; }
    return g ?? terrain(this.pos.x, this.pos.z);
  }

  /** A walk pressed against something solid ends, and says so. Routes go
   *  round what was there when they were planned (navgrid); this catches what
   *  was not — a thing spawned, placed or set moving since. Progress is
   *  distance closed on the current waypoint; a body sliding along a wall it
   *  will never get past makes a little and is still stopped. */
  private noteWalkProgress(distBefore: number, intended: number) {
    const t = this.target;
    if (!t) { this.stallTicks = 0; return; }
    const closed = distBefore - Math.hypot(t.x - this.pos.x, t.z - this.pos.z);
    this.stallTicks = closed < STALL_PROGRESS * intended ? this.stallTicks + 1 : 0;
    if (this.stallTicks < STALL_TICKS) return;
    const final = this.legs.length ? this.legs[this.legs.length - 1] : t;
    const short = Math.hypot(final.x - this.pos.x, final.z - this.pos.z);
    this.walkStall = `blocked at (${this.pos.x.toFixed(2)}, ${this.pos.z.toFixed(2)}), ${short.toFixed(2)}m short of ` +
      `(${final.x.toFixed(2)}, ${final.z.toFixed(2)}): something solid is in the way that the route did not ` +
      `expect (it moved or arrived after the walk was planned) — move there again and the route will take it into account`;
    this.stallTicks = 0;
    // pressed against a thing the route planned to walk into (its shove doesn't move it): round it, once. Only a thing
    // the stride presses INTO is blamed (its contact's normal head-on to the walk, as a shove's is: review r5 F5) — a
    // walk stalled by something else while it grazes a crate doesn't mark the crate solid
    const plan = this.walkPlan, st = this.replica?.st, cap = BODY_CAP, feet = [this.pos.x, this.pos.y, this.pos.z];
    const dx = t.x - this.pos.x, dz = t.z - this.pos.z, dd = Math.hypot(dx, dz);
    if (plan && !plan.replanned && st && dd > 1e-6) for (const id of plan.passable) {
      const obb = obbOf(st, id), c = obb && contactOf(feet, cap.r, cap.tall, { obb, box: aabbOfObb(obb) }, SHOVE_FEEL.slack);
      if (c && (dx * c.n[0] + dz * c.n[1]) / dd >= SHOVE_FEEL.headOn && this.replanRound(id)) { this.walkStall = null; return; }
    }
    this.abandonWalk();
  }

  /** The walk under way ends unarrived: its promise answers false, its legs,
   * gate and basis go, and a walking body stands. */
  private abandonWalk() {
    ++this.walkTicket;
    const done = this.walkDone;
    this.walkDone = null; this.target = null; this.legs = []; this.walkHeightAt = null; this.walkGate = null; this.speed = 0;
    if (this.clip === "walk" || this.clip === "run" || this.clip === "swim") this.clip = "idle";   // a swimmer then treads
    done?.(false);
  }

  stop() { this.abandonWalk(); this.clip = "idle"; }

  // ---- E1: walking the authority's body ----
  /** Bring the authority's track of this body to where it stands: arrive (an unlogged teleport, as a person's first move
   *  is); a short step if it lags; re-arrive (`teleport: true`, an act on the record) when the track is stale (a flight, a
   *  drag, a seat moved this body without walking it), as a person's client does. A visitor in a world with a spawn arrives
   *  at the spawn, as a person does. {open} = this authority keeps no body track: walk as before. */
  private async trackHere(): Promise<{ ok: true } | { ok: false; refused: any } | { open: true }> {
    const to = [r3(this.pos.x), r3(this.pos.y), r3(this.pos.z)];
    const take = (r: any, at: number[]) => { this.trackArrived = true; this.trackAt = Array.isArray(r?.at) ? r.at : at; return { ok: true as const }; };
    if (this.trackArrived && this.trackAt && Math.hypot(this.trackAt[0] - to[0], this.trackAt[1] - to[1], this.trackAt[2] - to[2]) < 0.05) return { ok: true };
    let r = await this.request("move", { to });
    if (r?.ok) return take(r, to);
    let code = r?.refused?.code;
    if (code === "not-joined" || code === "unknown-verb") return { open: true };
    if (code === "not-here") {   // the authority forgot this body (it left): arrive again
      this.trackArrived = false; r = await this.request("move", { to });
      if (r?.ok) return take(r, to); code = r?.refused?.code; }
    if (code === "spawn") {
      const sp = (this.replica?.st?.entities?.["@world"]?.c as any)?.spawn;
      const at = Array.isArray(sp?.pos) && sp.pos.length === 3 && sp.pos.every(Number.isFinite) ? sp.pos.map(Number) : null;
      if (at) { r = await this.request("move", { to: at });
        if (r?.ok) { this.pos.x = at[0]; this.pos.y = at[1]; this.pos.z = at[2];
          this.lastWalkNote = `this world's arrivals are at its spawn (${at.map((n: number) => n.toFixed(1)).join(", ")}): you arrived there and walked on from it`;
          return take(r, at); } }
    }
    if (code === "too-fast" || code === "solid") {
      r = await this.request("move", { to, teleport: true });
      if (r?.ok) { this.lastWalkNote = "where the world last had you was too far to walk from in one step, or behind something solid, so it placed you here directly, and its record shows the jump"; return take(r, to); }
    }
    return { ok: false, refused: r?.refused ?? { code: "no-answer", reason: "the authority didn't answer" } };
  }
  private permitAtTarget(g: { permit: number[] | null }): boolean {
    return !!(g.permit && this.target && Math.hypot(g.permit[0] - this.target.x, g.permit[2] - this.target.z) < 1e-6);
  }
  /** Ask the authority for the next stretch of this leg, from where it last accepted this body. */
  private extendPermit(g: WalkGate) {
    const from = this.trackAt, T = this.target; if (!from || !T) return;
    const dx = T.x - from[0], dz = T.z - from[2], d = Math.hypot(dx, dz);
    if (d < 1e-3) { g.permit = [T.x, from[1], T.z]; return; }   // the authority already has it at this leg's end
    const last = d <= PERMIT_STEP;
    const nx = last ? T.x : from[0] + dx * PERMIT_STEP / d, nz = last ? T.z : from[2] + dz * PERMIT_STEP / d;
    // the stretch's height: on a routed leg, the route's own (a stair is a ramp of treads: the leg's rise, shared out along
    // it — under a riser off the tread there, and the authority's box starts a step above the feet); else the feet's floor
    const ty = T.y != null ? (last ? T.y : from[1] + (T.y - from[1]) * PERMIT_STEP / d) : this.permitFloor(nx, nz);
    const to = [r3(nx), r3(ty), r3(nz)];
    g.busy = true;
    void this.request("move", { to }).then((r: any) => {
      if (this.walkGate !== g) return;
      g.busy = false;
      if (!r?.ok && r?.refused?.code === "solid" && this.walkUpTo(g, from, T, r.refused)) return;
      // too fast is "not yet": the track refills at its speed, and it is spent by a shove's re-track (shoveNow), by walking
      // just before, or on a slow host by steps the authority saw bunched up (AS16; CI macOS 10-22). Asked again shortly,
      // five times at most (2 s refills 12 m, three full tracks), never ended as a refused walk on the first
      if (!r?.ok && r?.refused?.code === "too-fast" && (g.slow = (g.slow ?? 0) + 1) <= 5) { g.waitUntil = Date.now() + 400; return; }
      if (!r?.ok) { this.refuseWalk(r?.refused ?? { code: "no-answer", reason: "the authority didn't answer" }); return; }
      g.slow = 0;
      this.trackAt = Array.isArray(r.at) ? r.at : to;
      g.permit = last && this.target === T ? [T.x, to[1], T.z] : this.trackAt;   // the leg's exact end (the track rounds to mm)
    });
  }
  /** May this body's walk shove it? The shover's own gate (shared/shove.js shoveable: dynamic, a box, nothing locked over
   *  it, in no hand, physics.who within this body's rank) on a world whose canon simulates here — the same reading
   *  tickShove's step makes. Anything else stays solid. */
  private mayShove(id: string): boolean {
    const st = this.replica?.st, canon = this.replica?.sim;
    if (this.shoveOff || !st || !canon?.sim || canon.foreign) return false;
    const rank = Number.isFinite(this.myRights?.rank) ? this.myRights.rank : null;
    return shoveable(st, id, { rank, holds: this.holdsNow });
  }
  /** May the walk planner walk into it? Only what this body may shove AND what its shove at this walk's speed would move out
   *  of the way (shared/shove.js budges: a 2000 kg crate is shoved once and stands — a wall), and nothing a walk this body
   *  took found solid (`misjudged`) while it stays where it was then. */
  private mayWalkInto(id: string, run: boolean): boolean {
    if (!this.mayShove(id)) return false;
    const was = this.misjudged.get(id), box = was && footprint(this.replica?.st, id);
    if (was && box && was.sig === this.shoveState(id) && Math.hypot((box.min[0] + box.max[0]) / 2 - was.at[0], (box.min[2] + box.max[2]) / 2 - was.at[1]) < SHOVE_FEEL.moved) return false;
    if (was) this.misjudged.delete(id);   // it has moved (or gone), or its lock, physics or mass changed since: judged afresh
    return budges(massOf(this.replica?.st, id) ?? NaN, run ? MOVER.walk.run : MOVER.walk.speed);
  }
  /** What a thing's shove depends on besides where it stands: its lock and every lock over it, its physics (kind, who,
   *  mass, density, surface) and its size in the world (its derived mass goes with it: review r6 L3) — the judgement of a
   *  misjudged thing holds only while these do (review r5 F5: a crate locked once and unlocked was solid to this body's
   *  walks for good). */
  private shoveState(id: string): string {
    const st = this.replica?.st, locks: unknown[] = [];
    let k: string | undefined = id;
    for (let i = 0; k && i < 64; i++) { const c: any = st?.entities?.[k]?.c; locks.push(c?.lock ?? null); k = typeof c?.parent?.to === "string" ? c.parent.to : undefined; }
    const ph: any = st?.entities?.[id]?.c?.physics ?? null;
    return JSON.stringify([locks, ph && { kind: ph.kind, who: ph.who, mass: ph.mass, density: ph.density, surface: ph.surface ?? ph.material }, st ? worldPose(st, id)?.scale ?? null : null]);
  }
  /** Things a walk planned through and then found solid: id -> its footprint's centre [x, z] and its shoveState then. */
  private misjudged = new Map<string, { at: [number, number]; sig: string }>();
  /** The walk under way's plan (to re-plan it once round a thing it misjudged). */
  private walkPlan: { x: number; z: number; run: boolean; timeoutMs: number; tolerance: number; y: number | undefined;
    near: Pick<NavTarget, "reach" | "above" | "below" | "inside">; passable: Set<string>; replanned: boolean } | null = null;
  /** The things this walk may walk into, and their registered colliders (sorted): the walk planner routes through them. */
  private passableColliders(run: boolean): { ids: Set<string>; colliders: string[] } {
    const ids = new Set<string>(), out: string[] = [];
    for (const id of this.misjudged.keys()) if (!this.replica?.st?.entities?.[id]) this.misjudged.delete(id);   // gone: forgotten
    for (const [id, bids] of this.supportIds) if (this.mayWalkInto(id, run)) { ids.add(id); out.push(...bids); }
    return { ids, colliders: out.sort() };
  }
  /** Body shove: while this body walks, the loose things it walks into are punted along its walk (shared/shove.js decides
   *  which and how hard; the authority admits each as any shove). The push is the walk's intent toward its target, so a
   *  body standing against a crate at the end of what the authority granted still pushes it. Not while the gate is asking
   *  the authority for a stretch (the track would move under the punt's reach check). */
  private tickShove() {
    const st = this.replica?.st, canon = this.replica?.sim, g = this.walkGate;
    if (this.shoveOff || !st || !canon?.sim || canon.foreign || !this.target || this.draggedBy || this.clip === "ragdoll" || this.flight || this.myOccupancy) return;
    if (!g || g.mode === "sync" || g.busy) return;
    const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z, d = Math.hypot(dx, dz); if (d < 1e-6) return;
    const sp = this.target.run ? MOVER.walk.run : MOVER.walk.speed, cap = BODY_CAP;
    const mounted = new Set<string>(), bodies: number[][] = [];
    for (const p of this.people.values()) { const seat = (p.pose as any)?.seat?.to; if (typeof seat === "string") mounted.add(seat);
      const at = (p.pose as any)?.p; if (Array.isArray(at) && at.length === 3 && at.every(Number.isFinite)) bodies.push(at); }
    const rank = Number.isFinite(this.myRights?.rank) ? this.myRights.rank : null;
    const go = this.shover.step({ st, feet: [this.pos.x, this.pos.y, this.pos.z], vel: [dx / d * sp, dz / d * sp], r: cap.r, tall: cap.tall, now: Date.now(),
      rank, holds: this.holdsNow, mounted, bodies, skip: (id: string) => !!canon.sim.bodies?.[id] });
    for (const p of go) { this.walkCap = { v: p.kept, until: Date.now() + p.keepMs }; void this.shoveNow(g, p.id, p.v); }
  }
  private async shoveNow(g: WalkGate, id: string, v: number[]) {
    const here = [r3(this.pos.x), r3(this.pos.y), r3(this.pos.z)], box = footprint(this.replica?.st, id), at = this.trackAt;
    const far = !at || !box || Math.hypot(Math.min(box.max[0], Math.max(box.min[0], at[0])) - at[0], Math.min(box.max[2], Math.max(box.min[2], at[2])) - at[2]) > SHOVE.reach - 0.15;
    // the gate holds still from the re-track to the punt's answer (counted: two shoves in one tick each hold it): a stretch
    // asked for between them would carry the authority's body back out of the punt's reach
    const hold = g.mode === "tracked"; if (hold) g.hold = (g.hold ?? 0) + 1;
    let r: any;
    try {
      if (hold && far) { g.retrackAt = Date.now(); const m = await this.request("move", { to: here });
        if (this.walkGate === g && m?.ok) { this.trackAt = Array.isArray(m.at) ? m.at : here; g.permit = this.trackAt; } }
      if (this.walkGate !== g) return;   // the walk ended during the re-track: no punt for a walk that's gone
      r = await this.request("punt", { id, v, contact: true });
    } finally { if (hold) g.hold = Math.max(0, (g.hold ?? 1) - 1); }
    if (!r?.ok) { this.shover.refused(id, Date.now(), r?.refused?.code); if (r?.refused?.code === "unknown-arg") this.shoveOff = true; }
    if (this.walkGate !== g || g.blocker?.id !== id) return;
    if (r?.ok) { g.blocker.phase = "pushed"; g.blocker.until = Date.now() + SHOVE_SETTLE_MS; }
    else this.refuseWalk(g.blocker.ref);
  }
  /** The authority called the next stretch solid because of `ref.blocker`: when that is a loose thing this body may shove,
   *  walk up against it (a shorter stretch) instead of stopping, and hold the walk until the shove has moved it. */
  private walkUpTo(g: WalkGate, from: number[], T: { x: number; z: number }, ref: any): boolean {
    const id = ref?.blocker, st = this.replica?.st;
    if (typeof id !== "string" || !st || !this.replica?.sim?.sim || (g.shoves ?? 0) >= SHOVE_TRIES || !this.mayShove(id)) return false;   // its rank and who holds what, as mayShove reads them
    const obb = obbOf(st, id); if (!obb) return false; const thing = { obb, box: aabbOfObb(obb) };
    const cap = BODY_CAP, dx = T.x - from[0], dz = T.z - from[2], d = Math.hypot(dx, dz); if (d < 1e-6) return false;
    let s = 0; const STEP = 0.05;
    const touches = (k: number) => !!contactOf([from[0] + dx / d * k, from[1], from[2] + dz / d * k], cap.r, cap.tall, thing, SHOVE_FEEL.slack / 2);
    while (s < d && !touches(s)) s = Math.min(d, s + STEP);
    if (!touches(s)) return false;   // the leg never reaches it: something else about it is solid
    g.shoves = (g.shoves ?? 0) + 1;
    g.blocker = { id, ref, phase: "approach", until: Date.now() + SHOVE_WAIT_MS + (s / MOVER.walk.speed) * 1000 };
    if (s < 1e-6) { g.permit = from; return true; }   // already against it
    const nx = from[0] + dx / d * s, nz = from[2] + dz / d * s, to = [r3(nx), r3(this.permitFloor(nx, nz)), r3(nz)];
    g.busy = true;
    void this.request("move", { to }).then((r: any) => {
      if (this.walkGate !== g) return;
      g.busy = false;
      if (!r?.ok) { this.refuseWalk(r?.refused ?? ref); return; }
      this.trackAt = Array.isArray(r.at) ? r.at : to; g.permit = this.trackAt;
    });
    return true;
  }
  /** Does something hold this walk? A "not yet" from the track's speed allowance, for a moment. A blocker: while approaching it or while what was shoved is still moving: yes. Pushed and
   *  settled: no (the walk asks again; still solid, it walks up again, up to SHOVE_TRIES). Approached and never shoved: the
   *  walk stops with the authority's refusal. */
  private blockerHolds(g: WalkGate): boolean {
    const now = Date.now(); if (now < (g.waitUntil ?? 0)) return true;
    const b = g.blocker; if (!b) return false;
    if (b.phase === "approach") { if (now > b.until) queueMicrotask(() => { if (this.walkGate === g && g.blocker === b) this.refuseWalk(b.ref); }); return true; }
    const body = this.replica?.sim?.sim?.bodies?.[b.id];   // at rest is settled, logged or not (an unsettled rest stays a body)
    if (now < b.until || (body && !body.resting)) return true;
    g.blocker = null; return false;
  }
  /** The walk under way planned to walk into `id` (it was passable), and it stopped the walk: remember it as solid while it
   *  stays where it is, and plan the walk once more, round it, from where the body stands. `ref`: the authority's refusal,
   *  if that is what stopped it (still the walk's answer if the new plan is refused). False: not this walk's to re-plan. */
  private replanRound(id: string, ref: any = null): boolean {
    const plan = this.walkPlan, box = footprint(this.replica?.st, id);
    if (!plan || plan.replanned || !plan.passable.has(id) || !this.walkDone || !box) return false;
    this.misjudged.set(id, { at: [(box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2], sig: this.shoveState(id) });
    if (Array.isArray(ref?.at)) this.trackAt = ref.at;
    const done = this.walkDone; this.walkDone = null;
    this.abandonWalk(); this.clip = "idle";
    // every end of the re-planned walk but "refused before a step" goes through abandonWalk and bumps the ticket: a stop,
    // a timeout, a stall, a refusal, a newer walk (whose state walkTo has just cleared) — none of them is this answer's
    const ticket = this.walkTicket;
    const note = `${this.refName(id)} wouldn't move for your shove: you walked round it`;
    this.lastWalkNote = note;
    void this.walkNow(plan.x, plan.z, plan.run, plan.timeoutMs, plan.tolerance, plan.y, plan.near, true).then((arrived) => {
      // planned round it and refused before a step: what stopped the first plan is still this walk's answer
      if (!arrived && this.walkTicket === ticket && !this.lastWalkRefusal && !this.walkStall && !this.walkStopReason) {
        if (ref) this.lastWalkRefusal = { code: String(ref.code), reason: String(ref.reason ?? ""), ...(ref.fix ? { fix: String(ref.fix) } : {}) };
        else this.walkStopReason = `${this.refName(id)} is in the way and wouldn't move for your shove, and no route round it: ${this.walkRefusal ?? "none found"}`;
        if (this.lastWalkNote === note) this.lastWalkNote = null;
      }
      done(arrived);
    });
    return true;
  }
  /** The authority refused this body the next stretch: it stops where the authority has it, and the walk says why. */
  private refuseWalk(ref: any) {
    // a thing this walk planned to walk into, called solid (it wouldn't budge: backed against a wall, locked or taken
    // meanwhile, heavier than its mass says): the walk is planned once more with it as an obstacle, from where it stopped
    const id = ref?.code === "solid" && typeof ref?.blocker === "string" ? ref.blocker : null;
    if (id && this.replanRound(id, ref)) return;
    this.lastWalkRefusal = { code: String(ref?.code ?? "refused"), reason: String(ref?.reason ?? ""), ...(ref?.fix ? { fix: String(ref.fix) } : {}) };
    if (Array.isArray(ref?.at)) this.trackAt = ref.at;
    this.abandonWalk(); this.clip = "idle";
  }

  face(x: number, z: number) { this.yaw = Math.atan2(x - this.pos.x, z - this.pos.z); }

  /** Why a send can't go out: a body between connections redials on its own
   *  (onclose), and one that is closed never will, so only the first is worth
   *  calling again. */
  private notJoined(): Error {
    return new Error(this.closed
      ? "this body's connection to the world has ended for good (the world removed or refused it, or the door closed it), so nothing was sent, and calling again won't change that"
      : "this body is reconnecting to the world, so nothing was sent; it rejoins on its own once the world answers, so try again shortly");
  }

  /** One request to the world's authority, answered by it: {ok: true, …} or {ok: false, refused: {code, reason,
   *  fix}}. */
  request(verb: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.joined || this.ws?.readyState !== 1) return Promise.resolve({ ok: false, refused: { code: "not-joined", reason: "not in a world" } });
    // speech ends composing, by whichever route it's sent (say(), or act {verb: "say"}): the throttle clears, and whoever
    // keeps this body's typing dots up (the door's TypingRelay, #234) lets them end with the bubble
    if (verb === "say") { this._typingUntil = 0; this.onSaid?.(); }
    // holes r3 F2: the authority judges this body's water with the stature its mover is handed (in water: stature())
    if (verb === "move" && this.water && args.height === undefined) args = { ...args, height: this.stature() };
    const id = `v${++this.histId}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pendingRequests.delete(id); resolve({ ok: false, refused: { code: "timeout", reason: "the authority did not answer within 8 s" } }); }, 8000);
      this.pendingRequests.set(id, (m) => { clearTimeout(t);
        if (verb === "consent" && m.reply?.ok) this.noteConsent(args);
        resolve(m.reply ?? { ok: false, refused: { code: "no-reply", reason: "the authority's answer had no reply" } }); });
      this.ws!.send(JSON.stringify({ type: "request", id, verb, args }));
    });
  }
  /** This body's switch as it last set it (recut A2), resent on every arrival so a reconnect keeps it. */
  private consentSwitch: string | null = null;
  /** On every arrival, as a person's client does (consentsync.js): read what the authority holds for my body's switch and
   *  send mine only if it differs. Unset = never chosen: the world's default stands. */
  async replaySwitch(): Promise<void> {
    if (!this.consentSwitch) return;
    const held = await this.request("consent", {}).catch(() => null); if (!held?.ok || !held.table) return;
    // read mine when the answer is back: a switch set while the read was out is newer than the one this began with
    const want = this.consentSwitch;
    if (want && held.table.switch !== want) await this.request("consent", { switch: want }).catch(() => null);
  }
  private noteConsent(args: Record<string, unknown>) { if (typeof args.switch === "string") this.consentSwitch = args.switch; }
  /** present people's identities, by display name (their arrival carries it) */
  actorIds = new Map<string, string>();
  /** Reaches the relay refused to show (server/reachgate.ts; the authority says so once per target and class per
   *  REACH_NOTE_MS), newest last: what reach() reads to tell the truth about a hand nobody saw. */
  reachRefusals: { to: string; cls: string; why: string; fix?: string; limb?: string; ts: number }[] = [];
  private nameOfActor(actor: string): string | null { for (const [n, a] of this.actorIds) if (a === actor) return n; return null; }
  /** Stop streaming the limb a refusal names (the relay strips it anyway). Only that one: another limb on the same body may
   *  be one they consented to (r2 holes F9). A refusal from a server that doesn't name the limb drops the limbs held to that
   *  body in the refused class. */
  private dropReachesAt(actor: string, limb?: string, cls?: string): string[] {
    const name = this.nameOfActor(actor), out: string[] = [];
    for (const [l, e] of [...this.reaches]) {
      // a limb's refusal is that reach's only while the relay still holds the reach to the refuser's body (reachHolders: the
      // body it names, and every body its point lands in), or the reach is a world point, which the relay judges by where it
      // lands now: a newer reach on the same hand held to nobody who refused stays
      const held = name ? this.reachHolders(e.t).find((h) => h.name === name) : undefined, atBody = e.t?.who != null || e.t?.space != null;
      const hit = limb !== undefined ? l === limb && (!!held || !atBody) : !!held && (!cls || held.cls === cls);
      if (hit) { this.reaches.delete(l); out.push(WorldAgent.LIMB_WORD[l] ?? l); } }
    return out;
  }
  /** The other bodies a world point lands in, each with its class there: server/reachgate.ts's bodiesAt, read from the
   *  presence this body holds (each body's capsule, scaled to its size). */
  private bodiesAtPoint(pt: number[]): { name: string; cls: string }[] {
    const out: { name: string; cls: string }[] = [];
    for (const [name, person] of this.people) {
      const at = (person.pose as any)?.p;
      if (name === this.name || !Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) continue;
      const sc = clampBodyScale((person.pose as any)?.scale);
      const cls = pointClass([0, 0, 0], [(pt[0] - at[0]) / sc, (pt[1] - at[1]) / sc, (pt[2] - at[2]) / sc]);
      if (cls) out.push({ name, cls });
    }
    return out;
  }
  /** Every other body a reach target is held to, as the relay holds it (server/reachgate.ts touched), each with its class:
   *  a named point, that one body; a point in the world or this body's frame, every body it lands in; a point in another
   *  body's frame, that body and every other body it lands in. The relay strips the reach if any of them refuses it. */
  private reachHolders(t: any): { name: string; cls: string }[] {
    if (t?.who !== undefined) {
      const cls = t.who !== this.name ? WorldAgent.reachClass(t, t.who) : null;
      return cls ? [{ name: t.who, cls }] : [];
    }
    if (!Array.isArray(t?.p) || t.p.length !== 3 || !t.p.every(Number.isFinite)) return [];
    const p = t.p as number[];
    if (t.space === undefined) return this.bodiesAtPoint(p);
    if (t.space === "self" || t.space === this.name) {   // this body's root frame, as the pose it sends draws it
      const world = WorldAgent.poseToWorld({ p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw }, p);
      return world ? this.bodiesAtPoint(world) : [];
    }
    // their own frame: theirs, and wherever it lands in the world, as their pose draws it
    const own = WorldAgent.reachClass(t, t.space);
    const world = WorldAgent.poseToWorld(this.people.get(t.space)?.pose, p);
    return [...(own ? [{ name: t.space as string, cls: own }] : []), ...(world ? this.bodiesAtPoint(world).filter((h) => h.name !== t.space) : [])];
  }
  /** A point in a body's own root frame, in the world, as server/reachgate.ts's frameToWorld places it: at the body's size,
   *  turned by the pose's q when it carries one (a swimmer's whole-body turn), else by its yaw about +y. Null without a
   *  position. */
  private static poseToWorld(pose: any, local: number[]): number[] | null {
    const at = pose?.p;
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) return null;
    const sc = clampBodyScale(pose.scale), l = local.map((v) => v * sc), q = pose.q;
    if (Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)) {
      const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1, x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n;
      const cx = y * l[2] - z * l[1], cy = z * l[0] - x * l[2], cz = x * l[1] - y * l[0];   // v' = v + 2w (u × v) + 2 u × (u × v)
      const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
      return [at[0] + l[0] + 2 * (w * cx + dx), at[1] + l[1] + 2 * (w * cy + dy), at[2] + l[2] + 2 * (w * cz + dz)];
    }
    const yaw = Number(pose.yaw) || 0, c = Math.cos(yaw), sn = Math.sin(yaw);
    return [at[0] + l[0] * c + l[2] * sn, at[1] + l[1], at[2] - l[0] * sn + l[2] * c];
  }
  /** The class the relay (server/reachgate.ts) gives a target on `name`'s body: a named point by consent.js's one table, a
   *  point in their own frame by their capsule; null for a point beside them (the relay relays it) or another kind of target. */
  static reachClass(t: any, name: string): string | null {
    if (t?.who === name) return namedPointClass(t.point)?.cls ?? null;
    if (t?.space === name && Array.isArray(t.p)) return pointClass([0, 0, 0], t.p);
    return null;
  }
  /** After streaming a reach at other bodies: did the relay refuse it? A fresh refusal from any body it is held to (waits
   *  a few frames for one), or one said within REACH_NOTE_MS (the relay won't say it again that soon, so silence then is
   *  not a yes). Each body by its class there: a refusal of another class is another reach's. */
  private async reachRefusalFor(limb: string, holders: { name: string; actor: string; cls: string }[], since: number) {
    const holderOf = (x: { to: string; cls: string }) => holders.find((h) => h.actor === x.to && h.cls === x.cls);
    for (let i = 0; i < 16 && this.joined && !this.closed; i++) {
      const r = this.reachRefusals.find((x) => x.ts >= since && (x.limb ?? limb) === limb && holderOf(x));
      if (r) return { r, by: holderOf(r)!.name, fresh: true };
      await new Promise((res) => setTimeout(res, 50));
    }
    const r = [...this.reachRefusals].reverse().find((x) => holderOf(x) && x.ts > Date.now() - REACH_NOTE_MS);   // (target, class) exactly (F9)
    return r ? { r, by: holderOf(r)!.name, fresh: false } : null;
  }
  /** A gesture's ops (shared/protocol/requests.js) as ONE request — one act, the authority's answer — sent after the previous one
   *  was answered (its log arrived first). Ops planned before that wait don't see what landed meanwhile, so a caller that
   *  planned from the replica pins what it read with `expect` (componentsOf), and a change since is refused, not overwritten
   *  `extra` rides the request (dry, expect, throughLock). The same requests a person's edit sends: one vocabulary, both audiences. */
  async sendOps(ops: any[], extra: Record<string, unknown> = {}): Promise<any> {
    const req: any = OP.batch(ops);
    if (!req) return { ok: true, noop: true };
    const turn = this.spelling.then(() => this.request(req.verb, { ...req.args, ...extra }));
    this.spelling = turn.catch(() => null);
    return turn;
  }

  // ---- moderation ----
  // Per-world kick/ban/unban are requests (door()). These are the extra
  // plumbing: the server's own moderation messages, and a way to hear the
  // world's answer.

  /** The world's most recent mid-life refusal / moderation reply. */
  lastRefusal: { ts: number; text: string } | null = null;
  lastMod: { ts: number; text: string } | null = null;
  /** The last few `mod` replies, oldest first (see the "mod" case). */
  recentMods: { ts: number; text: string }[] = [];

  /** Moderation messages that aren't requests: 'world-bans' (list this
   *  world's bans — anyone present), 'global-ban' / 'global-unban' /
   *  'global-bans' (server: WORLD_ADMIN only). Answers arrive as `mod`. */
  sendMod(type: "world-bans" | "global-ban" | "global-unban" | "global-bans", extra: Record<string, unknown> = {}) {
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    this.ws.send(JSON.stringify({ type, ...extra }));
  }

  /** Ask the world to mint this identity's media credential (#104 phase-1).
   *  Only the embodied primary may — which is this server. The answer arrives as
   *  a `relay-cred` frame on onMedia; a sidecar then publishes on it. */
  requestMediaCredential(scopes: { publish?: boolean; subscribe?: boolean } = {}) {
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    this.ws.send(JSON.stringify({ type: "relay-cred", ...scopes }));
  }

  /** Carry ONE media-signalling frame from the sidecar to the world. Whitelisted
   *  by type for #100's reason — the authority must not become a general tunnel into
   *  the sequencer, and server-side validation stays the single authority.
   *  Payload shape is deliberately NOT inspected here: SDP and ICE are the
   *  server's to validate, and a door that parsed them would be a second,
   *  weaker validator that could disagree. */
  sendMedia(frame: { type: string; [k: string]: unknown }): void {
    if (!this.joined || this.ws?.readyState !== 1) return;
    const t = String(frame?.type ?? "");
    // `voice-consent` is the LISTENER half: the world requires it from the
    // primary (server.ts refuses a spectator and keys on c.id/c.gen), so an
    // agent that wants to HEAR must send it through this server too. It carries
    // no audio and no identity claim beyond the one the authority already holds —
    // it is a boolean about our own ears.
    //
    // 🔴 `voice-moderate` is DELIBERATELY NOT HERE (2026-08-16). It silences a
    // speaker for EVERYONE and needs owner rank — a moderation act, not media.
    // The authority already exposes moderation as first-class tools (kick/ban), which
    // go through the verb path with its rights check and its `mod` confirmation.
    // Letting it ride the media lane would give a SIDECAR — a process holding a
    // peer connection, not an identity — the ability to mute people, which is
    // precisely the authority the whitelist exists to withhold.
    if (t !== "sfu-answer" && t !== "sfu-ice" && t !== "sfu-want-negotiate"
        && t !== "sfu-pos" && t !== "voice-consent") {
      console.warn(`[door] refusing to forward non-media frame "${t}"`);
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait briefly for the world's answer to a moderation act issued at t0: a
   *  `mod` confirmation (or the authoritative log echo of our own ban/kick),
   *  or an `error` refusal. Verbs are fire-and-forget by doctrine; moderation
   *  is the act where "did that actually happen" deserves a real answer. */
  async modOutcome(t0: number, ms = 1500): Promise<string | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.lastRefusal && this.lastRefusal.ts >= t0) return `refused: ${this.lastRefusal.text}`;
      if (this.lastMod && this.lastMod.ts >= t0) return this.lastMod.text;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  // extra carries ONLY the spoken-say protocol trio, guarded with the same
  // shapes the server enforces (r3 review: name-picking without value guards
  // still let an internal caller send utt:-1 or t0:NaN — two layers that
  // disagree on well-formed are one layer). Malformed trio → plain say: an
  // internal caller's bug must not silently ride protocol keys.
  say(text: string, extra?: { spoken?: boolean; utt?: number; t0?: number; to?: string }): Promise<any> {
    // (speech ends composing: request() clears the typing throttle and calls onSaid for every say)
    const args: Record<string, unknown> = { text, ...(typeof extra?.to === "string" && extra.to ? { to: extra.to } : {}) };
    if (extra?.spoken === true && Number.isSafeInteger(extra.utt) && (extra.utt as number) >= 0) {
      args.spoken = true;
      args.utt = extra.utt;
      if (Number.isFinite(extra.t0)) args.t0 = extra.t0;
    }
    // a request like every other write. The spoken trio rides it (the authority validates it again and clamps t0)
    return this.request("say", { text: args.text, ...(args.to ? { to: args.to } : {}), ...(args.spoken ? { spoken: true, utt: args.utt, ...(args.t0 !== undefined ? { t0: args.t0 } : {}) } : {}) }).then((r: any) => { if (r && !r.ok) console.warn(`[agent] say refused: ${r.refused?.reason ?? r.refused?.code}`); return r; });
  }

  /** Called after each `say` this body sends (say(), or act {verb: "say"}: request()), so whoever keeps its typing dots up (the door's TypingRelay) can
   *  let them end with the bubble. */
  onSaid: (() => void) | null = null;

  /** Show "composing" over this body. Presence-only (never logged), the same
   *  signal a human client sends while typing in the chat box. The world relays
   *  it and renderers draw the dots above the head for ~4s. Called repeatedly
   *  while the host says the agent's turn runs (MCPL channels/typing, through
   *  the door's TypingRelay), so it is throttled to one packet per second — the
   *  world extends the 4s window on each, so a long turn keeps the dots up
   *  continuously. A `say` verb clears the throttle and calls `onSaid`, which
   *  stops the relay: the bubble that follows ends the dots, and the host's
   *  next `start` raises them again if the turn goes on. The throttle runs on a
   *  monotonic clock, so a wall clock stepping back can't hold the signals. */
  private _typingUntil = 0;
  typing() {
    if (!this.joined || this.ws?.readyState !== 1) return;
    const now = performance.now();
    if (now < this._typingUntil) return;   // throttle: at most ~1/s
    this._typingUntil = now + 1000;
    this.ws.send(JSON.stringify({ type: "typing", to: null }));
  }

  /** Hold a custom pose (yourself). Sparse bone -> [x,y,z,w] quaternion. */
  setPose(bones: Record<string, PoseValue> | null, sticky = false) {
    this.heldPose = bones;
    this.heldPoseAuthored = bones != null;
    // Only a deliberate self-pose can ask to survive walking, and only THIS
    // object gets that (see heldPoseSticky).
    this.heldPoseSticky = sticky && bones != null ? bones : null;
    // clearing a slump IS standing up — don't leave the clip lying, don't
    // leave a sim tumbling a body that has decided to stand
    if (bones == null && this.clip === "ragdoll") {
      this.body?.stop(); this.stopSim();
      this.clip = "idle";
      this.pos.y = this.feetGround(true);
    }
  }

  // ---- reaching: a relation streamed as a descriptor ----------------------
  //
  // The descriptor (shared/reachwire.js) rides the presence packet; every
  // browser re-solves the same closed-form IK against its own scene and draws
  // this body's arm tracking the target. What happens HERE is only the part a
  // blind body needs: resolving the target from streamed presence + stand-in
  // skeletons (physics.ts ReachBody), solving its own arm once for the tool
  // reply, and keeping the `reached` attestation honest as things move —
  // that attestation's rising edge is the touch event at the other end.

  private static readonly LIMB_WORD: Record<string, string> = {
    leftHand: "left hand", rightHand: "right hand", leftFoot: "left foot", rightFoot: "right foot",
  };
  private static readonly DEFAULT_BODY = "eidoverse/assets/vrms/claude.vrm";

  private reachBodyFor(path: string): Promise<ReachBody | null> {
    if (this.reachBodies.has(path)) return Promise.resolve(this.reachBodies.get(path) ?? null);
    let p = this.reachBodyLoads.get(path);
    if (!p) {
      p = ReachBody.create(this.httpBase, path)
        .catch(() => null)
        .then((b) => { this.reachBodies.set(path, b); this.reachBodyLoads.delete(path); return b; });
      this.reachBodyLoads.set(path, p);
    }
    return p;
  }
  /** undefined = not loaded yet; null = tried and failed. */
  private reachBodySync(path: string): ReachBody | null | undefined { return this.reachBodies.get(path); }

  /** A normalized target → a world point (+ surface normal for a landmark),
   *  from streamed presence. Sync; undefined means a needed skeleton is still
   *  loading (reach() awaits the loads before asking). */
  private reachTargetPoint(t: { who?: string; point?: string; standoff?: number; p?: number[]; space?: string }):
    { pos: number[]; normal?: number[] } | { err: string } | undefined {
    if (t.p) {
      if (!t.space) return { pos: t.p };
      if (t.space === "self") return { pos: frameToWorld([this.pos.x, this.pos.y, this.pos.z], this.yaw, t.p) };
      const person = this.people.get(t.space);
      const pp = posePosition(person?.pose);
      if (!person || !pp) return { err: `${t.space} is not here (or has no position yet)` };
      return { pos: frameToWorld(pp, person.pose?.yaw ?? 0, t.p) };
    }
    const self = t.who === this.name;
    const person = self ? null : this.people.get(t.who!);
    if (!self && !person) return { err: `nobody called "${t.who}" is present` };
    const path = self ? this.avatar : (person!.avatar || WorldAgent.DEFAULT_BODY);
    const body = this.reachBodySync(path);
    if (body === undefined) return undefined;
    // null: its model, or this door's skeleton solver, didn't load (ReachBody.create)
    if (!body) return { err: `${self ? "your" : `${t.who}'s`} body couldn't be set up on this door (its model, or the door's skeleton solver, didn't load), so it can't check this reach` };
    // A limp body draws no raw layer, so its contacts have none either.
    if (self) body.poseAt([this.pos.x, this.pos.y, this.pos.z], this.yaw, this.heldPose ?? null, 1, this.clip !== "ragdoll");
    else {
      const pose = person!.pose;
      const pp = posePosition(pose);
      if (!pp) return { err: `${t.who} has no known position yet` };
      // their chosen size (absent = 1): contacts scale about their root, as in every browser
      body.poseAt(pp, pose?.yaw ?? 0, (pose as { pose?: Record<string, number[]> | null })?.pose ?? null, pose?.scale, pose?.clip !== "ragdoll");
    }
    const c = body.contact(t.point!, t.standoff ?? 0.02);
    if (!c) return { err: `${t.who}'s rig has no ${t.point}` };
    return c;
  }

  /** One full verdict for one limb entry, at this instant. */
  private solveReachEntry(limb: string, entry: { t: any; palm?: false }):
    | { state: "pending" } | { state: "err"; err: string }
    | { state: "ok"; reached: boolean; gap: number; bound: string[]; dist: number | null; arm: number | null; palmResidual: number | null } {
    if (this.joined) {
      const reading = this.reachReading;
      if (!reading || !sameReach(reading.reaches?.[limb], entry)) return { state: "pending" };
      const solved = reading.reachEvaluation?.[limb];
      // cyclic-reach is body_state's code for the loop (docs/body-state.md); the reply says it in words.
      if (!solved?.ok) return { state: "err", err: solved?.why === "cyclic-reach"
        ? "it depends on a loop of reaches (limbs reaching for limbs that reach back), so it can't be solved until a limb in the loop lets go"
        : solved?.why ?? reading.error ?? "body pose could not be evaluated" };
      const dist = solved.target && solved.shoulder ? Math.hypot(...solved.target.map((v: number, i: number) => v - solved.shoulder[i])) : null;
      return { state: "ok", reached: solved.reached, gap: solved.gap, bound: solved.bound,
        dist, arm: reading.body?.armLength(limb) ?? null, palmResidual: solved.palmResidual };
    }
    const tp = this.reachTargetPoint(entry.t);
    if (tp === undefined) return { state: "pending" };
    if ("err" in tp) return { state: "err", err: tp.err };
    const own = this.reachBodySync(this.avatar);
    if (own === undefined) return { state: "pending" };
    if (!own) return { state: "err", err: "your body couldn't be set up on this door (its model, or the door's skeleton solver, didn't load), so it can't check this reach" };
    own.poseAt([this.pos.x, this.pos.y, this.pos.z], this.yaw, this.heldPose ?? null);
    const s = own.solve(limb, tp, { palm: entry.palm !== false });
    if (!s.ok) return { state: "err", err: s.why };
    const reached = Number.isFinite(s.gap) && s.gap <= TOUCH_GAP && !s.bound.includes("no-target");
    const dist = s.shoulder
      ? Math.hypot(tp.pos[0] - s.shoulder[0], tp.pos[1] - s.shoulder[1], tp.pos[2] - s.shoulder[2]) : null;
    return { state: "ok", reached, gap: s.gap, bound: s.bound, dist, arm: own.armLength(limb), palmResidual: s.palmResidual };
  }

  /** Reach a limb toward a target (wire grammar: {who, point, standoff?} or
   *  {p:[x,y,z], space?: 'world'|'self'|id}). Sets the descriptor streaming
   *  either way; the reply says what the arm actually achieves. */
  async reach(limbRaw: string | undefined, targetRaw: unknown, opts: { palm?: boolean } = {}): Promise<ActResult> {
    const limb = canonicalLimb(limbRaw ?? "rightHand");
    if (!limb) return { ok: false, text: unknownLimb(limbRaw, "reached") };
    const t = normalizeReachTarget(targetRaw);
    if (!t) {
      return { ok: false, text: "reach couldn't use that target, so nothing was reached: pass {who, point} for a named contact point on a body (who a participant id from look), or {x, y, z} with an optional space ('world' by default, 'self' for your own frame, or a participant id for theirs)" };
    }
    // load the skeletons this reach needs BEFORE solving, so the reply is a
    // real verdict rather than a shrug
    if (!this.joined) await this.reachBodyFor(this.avatar);
    if (t.who !== undefined && t.who !== this.name) {
      const person = this.people.get(t.who);
      if (!person) {
        const names = [...this.people.keys()].filter((n) => n !== this.name).slice(0, 12);
        return { ok: false, text: `nobody called "${t.who}" is here${names.length ? ` (present: ${names.join(", ")})` : ""}` };
      }
      if (!this.joined) await this.reachBodyFor(person.avatar || WorldAgent.DEFAULT_BODY);
    }
    const entry: { t: any; palm?: false; reached?: true } = { t, ...(opts.palm === false ? { palm: false as const } : {}) };
    const since = Date.now();
    this.reaches.set(limb, entry);
    if (this.joined) await this.refreshReachReading();
    const res = this.solveReachEntry(limb, entry);
    if (res.state === "ok" && res.reached) entry.reached = true;
    const limbW = WorldAgent.LIMB_WORD[limb];
    const what = describeTarget(t, this.name);
    // a hand on another body is shown only with their consent: the relay strips it otherwise and says why (reachgate.ts)
    // a point in the world or in this body's own frame is judged by the body it lands in, as the relay judges it
    // every body the relay holds it to (none: beside them, nothing for the relay to refuse)
    const holders = this.reachHolders(t).flatMap((h) => { const actor = this.actorIds.get(h.name); return actor ? [{ ...h, actor }] : []; });
    if (holders.length && this.joined) {
      const refused = await this.reachRefusalFor(limb, holders, since);
      if (refused) {
        if (this.reaches.get(limb) === entry) this.reaches.delete(limb);
        const { r } = refused, ago = Math.round((Date.now() - r.ts) / 1000);
        return { ok: false, text: `${limbW} toward ${what}: not shown to anyone — ${refused.by}'s consent refused it (class ${r.cls}): ${r.why}${r.fix ? ` — ${r.fix}` : ""}. `
          + (refused.fresh ? "The reach is withdrawn; nobody saw your hand there."
            : `That was said ${ago}s ago, and the world says it once per ${REACH_NOTE_MS / 1000}s, so the reach is withdrawn without streaming it again; if they have changed their table since, reach again in ${Math.max(1, Math.ceil((REACH_NOTE_MS - (Date.now() - r.ts)) / 1000))}s.`) };
      }
    }
    if (res.state !== "ok") {
      const why = res.state === "err" ? res.err : "skeletons still loading; the verdict follows on the next check";
      return { ok: true, text: `${limbW} reaching toward ${what} — streamed, but unverified: ${why}` };
    }
    if (res.reached) {
      return { ok: true, text: `${limbW} reaching ${what} (endpoint gap ${Math.round(res.gap * 1000)}mm). The target stays tracked until reach {release: true} or knockdown; this is an endpoint measurement, not a stability measurement.` };
    }
    const short = Number.isFinite(res.gap) ? `${res.gap.toFixed(2)}m short` : "not arriving";
    const why = res.bound.length ? ` (limited by: ${res.bound.join(", ")})` : "";
    const advice = res.bound.includes("reach") && res.dist != null && res.arm != null
      ? ` — the target is ${res.dist.toFixed(1)}m from your shoulder and your arm is ${res.arm.toFixed(2)}m long; walk closer and it will land`
      : "";
    return { ok: true, text: `${limbW} reaching toward ${what}: ${short}${why}${advice}. The arm extends that way and keeps tracking; it touches if the distance closes.` };
  }

  /** Let go with one limb, or all of them. Propagates as absence: the next
   *  presence packet simply stops carrying the descriptor. */
  releaseReach(limbRaw?: string | null): ActResult {
    if (limbRaw == null) {
      const n = this.reaches.size;
      this.reaches.clear();
      return done(n ? "let go — all reaches released" : "you weren't reaching for anything");
    }
    const limb = canonicalLimb(limbRaw);
    if (!limb) return refused(unknownLimb(limbRaw, "released"));
    // A limb that wasn't reaching is already let go, which is what was asked.
    return done(this.reaches.delete(limb)
      ? `${WorldAgent.LIMB_WORD[limb]} released`
      : `your ${WorldAgent.LIMB_WORD[limb]} wasn't reaching for anything`);
  }

  /** Re-attest `reached` for every live reach (runs at ~2Hz off tick()).
   *  While a needed skeleton is missing the last attestation HOLDS — flapping
   *  to "not touching" because a load is slow would fire spurious release/
   *  touch edges at the other end. Loads are kicked here so blindness heals. */
  private reachTick() {
    if (this.joined) {
      if (this.reachReadingBusy) return;
      this.reachReadingBusy = true;
      void this.refreshReachReading().then(() => {
        for (const [limb, entry] of this.reaches) {
          const res = this.solveReachEntry(limb, entry);
          if (res.state === "ok" && res.reached) entry.reached = true; else delete entry.reached;
        }
      }).catch(() => { for (const entry of this.reaches.values()) delete entry.reached; })
        .finally(() => { this.reachReadingBusy = false; });
      return;
    }
    for (const [limb, entry] of this.reaches) {
      const t = entry.t;
      if (t.who !== undefined) {
        const path = t.who === this.name ? this.avatar : (this.people.get(t.who)?.avatar || WorldAgent.DEFAULT_BODY);
        void this.reachBodyFor(path);
      }
      void this.reachBodyFor(this.avatar);
      const res = this.solveReachEntry(limb, entry);
      if (res.state !== "ok") continue;
      if (res.reached) entry.reached = true; else delete entry.reached;
    }
  }

  /** Someone's hands, read off their presence stream: reach/touch events for
   *  hands aimed at THIS body. Ping-grade (a touch is a knock, like an
   *  approach), edge-triggered by diffReach, with a per-(kind,limb,person)
   *  refractory so a hand trembling across the threshold knocks once. */
  private noteReachEvents(id: string, prev: Pose | null, pose: Pose) {
    const bag = normalizeReachBag((pose as { reach?: unknown }).reach);
    const prevBag = prev ? normalizeReachBag((prev as { reach?: unknown }).reach) : null;
    if (!bag && !prevBag) return;
    // First observation of this body is a BASELINE, not a transition (issue
    // #39): rejoin/replay lands here for hands resting where they have been
    // for an hour. Seed silently; edges count from the next sample.
    if (!prev) return;
    const REACH_REFRACT_MS = 15_000;
    for (const ev of diffReach(prevBag, bag, this.name)) {
      const limbW = WorldAgent.LIMB_WORD[ev.limb] ?? ev.limb;
      if (ev.type === "release") {
        this.gate.act(id, `reach-release:${ev.limb}`, `withdraws their ${limbW}`);
        continue;
      }
      const key = `${ev.type}:${ev.limb}:${id}`;
      const now = Date.now();
      if (now - (this.lastReachPing.get(key) ?? 0) < REACH_REFRACT_MS) continue;
      this.lastReachPing.set(key, now);
      const what = describeTarget(ev.entry!.t, this.name);
      this.ping({
        ts: now, kind: ev.type, who: id,
        text: ev.type === "touch" ? `touches ${what} (${limbW})` : `reaches toward ${what} (${limbW})`,
      });
    }
  }

  /** Play a named anim once — pose.anim, a field on the next presence packet,
   *  the same channel the browser's action bar uses. Receivers resolve the
   *  name to a library clip; nothing is logged. */
  playOnce(name: string) { this.pendingAnim = name; }
  private pendingAnim: string | null = null;

  /** Settle into a posture clip (sit/sitchair/lie/idle). Rides the presence
   *  stream like locomotion does; walking replaces it, restore re-applies it. */
  setPosture(clip: string) {
    this.stop();
    this.speed = 0;
    // choosing a posture ends a tumble the same way walking does — a physics
    // frame must not survive under the new label. (This exact gap is how
    // "posture stand" failed to stand princess up: it relabelled the clip
    // and left the ragdoll bones riding every subsequent packet.)
    if (this.clip === "ragdoll" || (this.heldPose && !this.heldPoseAuthored)) {
      this.body?.stop(); this.stopSim();
      this.heldPose = null; this.heldPoseAuthored = false;
      this.pos.y = this.feetGround(true);
    }
    // and standing up IS getting off the seat
    if (clip === "idle" && this.joined && this.myOccupancy && this.mayVacate("menu")) this.setOccupant(null);
    this.clip = clip;
  }

  /** Change body mid-session: the same move the browser makes — re-announce
   *  with the new path and every client rebuilds this remote. Position, held
   *  pose, and identity all carry over; only the body changes. */
  setAvatar(path: string) {
    this.avatar = path;
    // The new body's bones are read before its next flight act or fold.
    this.bodyBoneNames = null;
    this.bodyBonesFor = null;
    this.selfBodyGeneration = ++this.bodyGenerationCounter;
    this.bodyReader?.forget(this.name);
    // a new body has its own height: re-measure (a reply for the old body is dropped), and float afresh
    this.endFloat();
    if (this.water) void this.measureStature(); else { this.statureFor = null; this.bodyH = null; ++this.statureGen; }
    if (this.joined && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(this.joinMsg()));
    }
  }

  /** Play a one-off animation on yourself — relayed once, never logged.
   *  Over your held pose and other animations; `replace` ends them first. */
  animate(data: { dur: number; loop?: boolean; replace?: boolean; tracks: Record<string, { t: number; q: number[] }[]> }) {
    // Sent or refused, as puppet() is: an animation that never left must not read as playing.
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    if (data.replace) this.setPose(null);
    this.ws.send(JSON.stringify({ type: "anim", dur: data.dur, loop: !!data.loop, tracks: data.tracks,
      replace: data.replace === true }));
  }

  /** Ask another body to hold a pose or play an animation. It decides.
   *  `ragdoll: true` asks it to go limp; `{lean:[x,y,z]}` (m/s) says which
   *  way the shove sends it — the receiver simulates and caps for itself. */
  puppet(target: string, spec: { pose?: Record<string, PoseValue | null>; merge?: boolean; anim?: unknown; ragdoll?: boolean | { lean: number[] } }) {
    // Sent or refused, as verb() is: a request that never left must not read as made.
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    this.ws.send(JSON.stringify({ type: "puppet", target,
      pose: spec.pose ?? null, ...(spec.merge ? { merge: true } : {}), anim: spec.anim ?? null, ragdoll: spec.ragdoll ?? null }));
  }

  /** Ask the world what happened in a range of its history.
   *
   *  An agent does not experience time continuously — it exists in bursts,
   *  with the world moving between them. Live events fill the inbox while the
   *  process is up; this is how it recovers everything else, including what
   *  happened before it was ever started. */
  history(opts: { before?: number; after?: number; limit?: number; verbs?: string[] } = {}):
      Promise<{ entries: any[]; oldestSeq: number | null; hasMore: boolean }> {
    if (!this.joined || this.ws?.readyState !== 1) {
      return Promise.resolve({ entries: [], oldestSeq: null, hasMore: false });
    }
    const reqId = `h${++this.histId}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingHistory.delete(reqId);
        resolve({ entries: [], oldestSeq: null, hasMore: false });
      }, 8000);
      this.pendingHistory.set(reqId, (m) => {
        clearTimeout(t);
        resolve({ entries: m.entries ?? [], oldestSeq: m.oldestSeq ?? null, hasMore: !!m.hasMore });
      });
      this.ws!.send(JSON.stringify({ type: "history", reqId, ...opts }));
    });
  }

  /** The world's flight recorder: why things bounced — denied verbs, rejected
   *  shapes, rate limits, and reaction outcomes (fired / skipped / failed).
   *  The log answers "what happened"; this answers "why didn't it". */
  worldDebug(opts: { limit?: number; kinds?: string[]; script?: string; scripts?: boolean } = {}):
      Promise<{ events: any[]; status?: string }> {
    if (!this.joined || this.ws?.readyState !== 1) return Promise.resolve({ events: [] });
    const reqId = `d${++this.histId}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingDebug.delete(reqId);
        resolve({ events: [] });
      }, 8000);
      this.pendingDebug.set(reqId, (m) => {
        clearTimeout(t);
        resolve({ events: m.events ?? [], ...(m.status ? { status: m.status } : {}) });
      });
      this.ws!.send(JSON.stringify({ type: "debug", reqId, ...opts }));
    });
  }

  /** Everything said since a given point, oldest first. */
  /** Advance the unread cursor past replayed history at or before `seq` —
   *  chat a previous session already presented. The persisted per-agent
   *  cursor (state.json) survives process restarts; without this, every
   *  fresh session's first look() re-dumped the tail as "since you last
   *  looked". Entries without a real seq are never presumed seen. */
  skipInboxThrough(seq: number) {
    let i = 0;
    for (; i < this.inbox.length; i++) {
      const s = this.inbox[i].seq;
      if (typeof s !== "number" || s < 0 || s > seq) break;
    }
    this.inboxCursor = Math.max(this.inboxCursor, i);
  }

  async missedSince(seq: number, limit = 120) {
    const { entries } = await this.history({ after: seq, limit, verbs: ["say"] });
    return entries.map((e) => ({ ts: e.ts, who: e.actor, text: e.args?.text ?? "", seq: e.seq }));
  }

  // ---- perception (text tier) ----

  private bearing(dx: number, dz: number): string {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]; // N = -z, E = +x
    const a = Math.atan2(dx, -dz);
    return dirs[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
  }

  /** Where a thing ACTUALLY is right now: the mount chain and any whole-
   *  entity motion, composed at read time by effective.ts with the same
   *  closed forms the renderer runs. Every numeric spatial claim in
   *  perception goes through this — reading `e.pos` directly is how mounted
   *  cargo was reported 11m from its carrier (#82). */
  private eff(id: string, nowMs: number): Effective {
    return effectiveWorldTransform(id, {
      entity: (eid) => this.entities.get(eid),
      mount: (eid) => this.mounts.get(eid),
      seatVerdict: (eid) => this.seatVerdictFor(eid),
      // an occupant's chosen size, from its own presence (absent = 1). An agent's own
      // body is its authored size: no agent sets `scale`, so its wire carries none.
      occupantScale: (eid) => eid === this.name ? 1 : clampBodyScale(this.people.get(eid)?.pose?.scale),
    }, nowMs);
  }

  /** The served verdict for whatever avatar this body currently wears —
   *  roster truth (p.avatar) mapped through the same name derivation every
   *  consumer uses. Undefined = no profile, declared. */
  private seatVerdictFor(id: string) {
    const path = id === this.name ? this.avatar : this.people.get(id)?.avatar;
    const nm = nameFromAvatarPath(path);
    return nm ? this.seatCache.get(nm) : undefined;
  }

  /** The declared-approximation suffix for a seated person's line (#101):
   *  the same reason string the browser consoles and the nameplate ≈ carry —
   *  one contract, three declarations. Empty when the seat is profiled. */
  private seatSuffix(id: string, occ: { to: string }): string {
    const station = this.socketRec(occ.to)?.station;
    const g = seatGateCore({ sock: station, verdict: this.seatVerdictFor(id), pose: bodyOf(station)?.clip ?? "sitchair" });
    return g.apply ? "" : ` (seat approximate: ${g.reason})`;
  }


  /** ", standing in a river 0.6m deep, flowing east" / ", swimming in the sea, 4.2m deep, …" — or "" on
   *  dry ground. Depth is over the BED (a swimmer's feet are not on it). */
  private waterHere(x: number, z: number, y: number): string {
    if (!this.water || this.flight) return "";
    const st = waterStance(this.water.level, this.heightAt(x, z), this.stature());
    if (st.depth <= 0.02) return "";
    // a body held clear of the water — flying over it, seated on a pier or a boat — is not in it: its feet
    // are above the surface (a floating body's feet hang well below it, a wader's are on the bed)
    if (!this.float.on && y > this.water.level + 0.05) return "";
    const d = st.depth.toFixed(1), w = this.waterKinds?.sample(x, z), verb = st.swimming ? "swimming" : "standing";
    if (w?.kind === "river" && w.flow) return `, ${verb} in a river ${d}m deep, flowing ${compass(w.flow[0], w.flow[1])}`;
    if (w?.kind === "ocean" && w.toShore) return `, ${verb} in the sea ${d}m deep, the waves coming in from the ${compass(-w.toShore[0], -w.toShore[1])}`;
    if (w?.kind === "still") return `, ${verb} in still water ${d}m deep`;
    return `, ${verb} in water ${d}m deep`;
  }

  /** One line on the world's water bodies, largest first, for `look`. */
  private waterSummary(): string | null {
    const A = this.waterKinds;
    if (!A?.bodies.length) return null;
    const big = [...A.bodies].filter((b) => b.area >= 20).sort((a, b) => b.area - a.area).slice(0, 4);
    if (!big.length) return null;
    const at = (k: number) => { const i = k % A.n, j = (k - i) / A.n, h = (A.n - 1) * A.cell / 2; return `(${(i * A.cell - h).toFixed(0)}, ${(j * A.cell - h).toFixed(0)})`; };
    const say = (b: (typeof A.bodies)[number]) => {
      if (b.kind === "river") return `a river ${b.width.toFixed(0)}m wide flowing ${compass(b.flowDir[0], b.flowDir[1])} from ${at(b.source)} to ${at(b.mouth)}`;
      if (b.kind === "ocean") return `the sea, along the world's edge (${Math.round(b.area)}m²)`;
      return `${b.area > 1500 ? "a lake" : "a pond"} (${Math.round(b.area)}m²) around ${at(b.cells[Math.floor(b.cells.length / 2)])}`;
    };
    return `Water: ${big.map(say).join("; ")}${A.bodies.length > big.length ? `; and ${A.bodies.length - big.length} smaller puddles` : ""}. Bodies wade to their chest (slower the deeper), then swim (slower still).`;
  }

  look(nowMs = this.serverNow()): string {
    const L: string[] = [];
    // The agent's own seat rides its parent too: seated on a moving ferry,
    // every distance below is measured from where the body actually is.
    // this.pos itself stays the controller's (dismount restores it) — the
    // composition is a READ, here and nowhere else. When the OWN chain
    // cannot compose (a part-socket seat), the position is UNKNOWN: the
    // header says so and every dependent distance/bearing below is
    // suppressed — never measured from the stale controller pos while the
    // same line claims "seated on" (#92, B2).
    const selfOcc = this.mounts.get(this.name);
    const selfEff = selfOcc ? this.eff(this.name, nowMs) : null;
    const meKnown = !selfOcc || selfEff?.ok === true;
    const me = selfEff?.ok ? { x: selfEff.pos[0], y: selfEff.pos[1], z: selfEff.pos[2] } : this.pos;
    // #101: an uncorrected seat composition is never silent — the same
    // "(seat approximate: reason)" every renderer consumer declares.
    const selfSeatNote = selfEff?.ok && selfEff.seat?.state === "approximate" ? ` (seat approximate: ${selfEff.seat.reason})` : "";
    const seated = selfOcc ? `, seated on ${this.socketName(selfOcc.to)}${selfEff?.ok && selfEff.moving ? ` (carried by its ${selfEff.moving})` : ""}${selfSeatNote}` : "";
    if (meKnown) {
      L.push(`You are "${this.name}" in world "${this.world}" at (${me.x.toFixed(1)}, ${me.z.toFixed(1)}), ground height ${(this.float.on ? this.heightAt(me.x, me.z) : me.y).toFixed(2)}m${this.waterHere(me.x, me.z, me.y)}, facing ${this.bearing(Math.sin(this.yaw), Math.cos(this.yaw))}${seated}.`);
    } else {
      L.push(`You are "${this.name}" in world "${this.world}", position unknown (${selfEff && !selfEff.ok ? selfEff.why : "seat unresolved"}), facing ${this.bearing(Math.sin(this.yaw), Math.cos(this.yaw))}${seated}. Distances are withheld until your seat resolves — sit with no \`on\` (or walking) gets you up, back to a stamped position.`);
    }
    { const ws = this.waterSummary(); if (ws) L.push(ws); }
    if (this.pendingTerrain) L.push(`The world's ground is a heightmap that has not loaded yet: heights here are the last ground you had${this.terrain ? "" : " (flat)"}, until it does.`);
    // WHERE YOU ARE, ARCHITECTURALLY. A conjured building can only ever be
    // "a mesh 4m away"; a griddled one knows its own rooms, so standing inside
    // one is a fact perception can state. Derived from folded state alone —
    // this runs in a headless agent with no scene and no triangles, which is
    // the entire point of keeping the planner pure.
    if (meKnown) {
      // The storey is found from the feet: a laid body's root lies
      // RAGDOLL_ROOT_DROP under them (feetY), below its own floor.
      const feet = selfEff?.ok ? me.y : this.feetY(this.isSlumped());
      for (const e of this.entities.values()) {
        const data = recordComponents(e).structure;
        if (!data) continue;
        try {
          const [lx, ly, lz] = localizePoint(e, me.x, feet, me.z);
          const here = describeHere(this.planFor(e.id, data), lx, lz, ly);
          if (here) { L.push(`${here} (inside [${this.handle(e.id)}]; sides are the building's own compass.)`); break; }
        } catch { /* one malformed house must not cost the whole percept */ }
      }
    }
    // ...and in named places: a room a model or a builder declared
    if (meKnown) {
      const here = this.placesAt([me.x, me.y, me.z]);
      if (here.length) L.push(`You are in ${here.map(({ entity, place }) => `${place.label ?? place.name} (${this.refName(entity.id)}/${place.name})`).join(", within ")}.`);
      const sight = this.placesInSight();
      if (sight.lines.length || sight.more) L.push(`Places ${sight.byDistance ? `within ${PLACE_SIGHT_M} m (line of sight not checked yet: the collision modules are still loading)` : "you can see"}, nearest first: ${sight.lines.length ? sight.lines.join("; ") : "none"}${sight.more ? ` — and ${sight.more} more: move {to: "?"} lists every place` : ""}.`);
    }
    // Structured object, NEVER a bare string: consumers of look() were
    // reading {hours, azimuth, clouds, ts, …} long before the forecast
    // existed, and a type change here silently breaks them (Sill, postdeploy
    // #37). The folded fields stay; derivation is ADDED alongside.
    if (this.skyState) {
      const now = Date.now();
      const eff = effectiveSky(this.skyState, now);
      const ck = effectiveClock(this.skyState, now);
      this.worldInfo.sky = {
        ...this.skyState,
        currentHour: Number(hoursAt(this.skyState, now).toFixed(2)),
        ...(eff.weather ? { currentWeather: eff.weather } : {}),
        source: eff.source,
        // the one canonical clock object (#65): machine consumers read THIS,
        // not rate/hours precedence folklore — the folded fields alongside are
        // active state only (a real-clock fold carries no top-level rate)
        effectiveClock: { ...ck, hour: Number(ck.hour.toFixed(2)) },
        description: describeSky(this.skyState, now),
      };
    }
    if (Object.keys(this.worldInfo).length) L.push(`World: ${JSON.stringify(this.worldInfo)}`);

    const others = [...this.people.values()];
    L.push(others.length ? `\nPeople (${others.length}):` : "\nNobody else is here right now.");
    for (const p of others) {
      const xyz = posePosition(p.pose);
      if (!p.pose || !xyz) { L.push(`  - ${p.id} (just arrived, position unknown)`); continue; }
      const [x, , z] = xyz;
      const dx = x - me.x, dz = z - me.z;
      const doing = { idle: "standing", walk: "walking", run: "running", sit: "sitting", sitchair: "sitting on a chair", lie: "lying down" }[p.pose.clip] ?? p.pose.clip;
      const held = (p.pose as { pose?: Record<string, unknown> | null }).pose;
      const posed = held ? `, holding a pose (${Object.keys(held).length} bones)` : "";
      const winged = foldedIn(p.pose) === true ? ", wings folded" : "";
      const mode = readBodyMode(p.pose);
      const moded = ((m) => (m && m !== "stand" ? `, ${m === "sit" ? "sitting" : m === "lie" ? "lying down" : m === "swim" ? "swimming" : m === "fly" ? "flying" : "falling"}` : ""))(mode);
      const occ = this.mounts.get(p.id);
      const occupying = occ ? ` — on ${this.socketName(occ.to)}${this.seatSuffix(p.id, occ)}` : "";
      // Their heading is on the wire (pose.yaw, world yaw like our own): say it, or an agent can't tell which side of
      // someone it will see (upstream #225). An occupant's body follows the socket, so their root yaw isn't where they
      // face; a body knocked over (the ragdoll) or lying down keeps its standing yaw (the anim changes, not the heading).
      // For those, say nothing rather than something false.
      const lying = p.pose.clip === "ragdoll" || mode === "lie";
      const facing = !occ && !lying && Number.isFinite(p.pose.yaw) ? `, facing ${this.bearing(Math.sin(p.pose.yaw), Math.cos(p.pose.yaw))}` : "";
      L.push(`  - ${p.id}: ${meKnown ? `${Math.hypot(dx, dz).toFixed(1)}m ${this.bearing(dx, dz)} ` : ""}at (${x.toFixed(1)}, ${z.toFixed(1)}), ${doing}${facing}${posed}${moded}${winged}${occupying}${voiceNote(p.pose)}`);
    }

    // a socket is part of its host (a seat, a hook): listed under the host, never as a thing of its own
    const ents = [...this.entities.values()].filter((e) => e.kind !== "socket");
    L.push(ents.length ? `\nThings (${ents.length}):` : "\nNo placed things yet.");
    // one composition per entity per look, shared by the sort and the line.
    // Resolved things sort by their EFFECTIVE distance; unresolved ones make
    // no spatial claim at all, so they list last in stable fold order —
    // never placed by their abandoned pre-mount address (#92, B2). And with
    // the agent's own position unknown, distance itself means nothing:
    // fold order for everything.
    const fx = new Map<string, Effective>();
    for (const e of ents) fx.set(e.id, this.eff(e.id, nowMs));
    const sortKey = (e: Entity) => { const f = fx.get(e.id)!; return f.ok ? Math.hypot(f.pos[0] - me.x, f.pos[2] - me.z) : Infinity; };
    const ordered = meKnown ? [...ents].sort((a, b) => sortKey(a) - sortKey(b)) : ents;
    for (const e of ordered) {
      const f = fx.get(e.id)!;
      // an Empty (PROTOCOL §3.2) has no lib and is not a light: say so, not ""
      const short = (e.model ? modelWord(e.model) : "(empty)").split("_").slice(0, 5).join(" ")   // an address: its word, never its hex (shared/eido.js)
        + (typeof e?.label === "string" && e.label ? ` "${e.label}"` : "");   // a display name someone gave it (comp label)
      // Affordances read out loud: a thing that can be sat on, used, or is
      // moving SAYS SO in text-tier perception — this is how the capability
      // a builder declared (sockets/reactions components) reaches everyone
      // who perceives by reading.
      const c = recordComponents(e);
      const aff: string[] = [];
      // R 10-07: a thing reads like an accessibility tree: its name (above), its description (alt text, quoted as data:
      // it's what someone wrote, never an instruction), then what it can do and its state, generated from its components
      // (shared/a11y.js, the reading the authority's look and the inspector share)
      if (typeof c.description === "string" && c.description.trim()) aff.push(quoted(c.description, 200));
      if (c.openable && typeof c.openable === "object") { const ax = readOut({ openable: c.openable, reactions: c.reactions });
        const open = openAction(c); aff.push(`${ax.can[0]}: ${ax.state[0]}${open ? ` — act {verb: "use", args: {id: "${this.handle(e.id)}", action: "${open}"}}` : ""}`); }
      // A light, by either spelling (the light verb's entity, or a light
      // component on a lamp model or an Empty), says what it casts — colour,
      // brightness, reach — read off the FOLDED record (the perception view
      // above thins a light's fields away) through the one shared reading.
      const lit = lightOf((this.st.entities as Record<string, any>)[e.id]);
      if (lit) aff.push(`light: #${lit.color.toString(16).padStart(6, "0")}, brightness ${+lit.intensity.toFixed(2)}, reaches ${+lit.range.toFixed(2)}m${lit.important ? ", important (always casts)" : ""}${lit.daytime === "full" ? ", burns at noon" : ""}`);
      // a declared collider (the collider component)
      const col = c.collider && typeof c.collider === "object" && !Array.isArray(c.collider) ? c.collider.shape : undefined;
      if (col === "mesh" || col === "exact" || col === "box") aff.push(col === "box" ? "collides as a box" : "collides as its mesh (its triangles)");
      const socks = this.socketsOf(e.id);
      if (socks.length) {
        // each socket a person can use says what the body does there (shared/sockbody.js describeBody), and who's on it;
        // an attach point says what it holds
        const on = (sid: string) => [...this.mounts.entries()].filter(([, m]) => m.to === sid).map(([rid]) => rid);
        const lines = socks.map((x) => { const b = bodyOf(x.station); const who = on(x.id); return b ? `${describeBody(x.name, b, { door: true })}${who.length ? ` — ${who.join(", ")} is on it` : ""}` : null; }).filter(Boolean);
        const things = socks.filter((x) => !bodyOf(x.station)).map((x) => { const held = on(x.id); return `${x.name}${held.length ? ` (holding ${held.join(", ")})` : ""}`; });
        if (lines.length) aff.push(`use it (attach {to: "${this.handle(e.id)}", socket}): ${lines.join(" · ")}`);
        if (things.length) aff.push(`attach points: ${things.join(", ")}`); }
      if (c.reactions) { const acts = Object.keys(c.reactions).filter((a) => a !== openAction(c)); if (acts.length) aff.push(`reacts to: ${acts.join(", ")}`); }
      // what a hand may do with it (shared/grab.js: the authority's own reader, so a dynamic thing with no grabbable counts)
      { const gr = grabOf(c); if (gr) aff.push(`${describeGrab(gr, "it")} — act {verb: "grab", args: {id: "${this.handle(e.id)}"}}`); }
      if (c.motion?.type) aff.push(`in motion (${c.motion.type})`);
      // The emitter is named as the SEMANTIC thing it is on the entity that
      // owns it — "emitting fire", not a sprite inventory and not a bare
      // `components: particles`. Nothing is claimed about heat, light, sound
      // or contact: separate authored components would provide those, and a
      // resident who reads "warm" acts on it.
      if (c.particles) aff.push(describeParticles(c.particles));
      // A picture is named by what its author SAID it shows, on the part that
      // carries it — never by its pixels. Rung 1 of the projector ladder.
      // batch 2: a story, a sign, a picture, a sound and a look-at say what they say through the ONE describer the authority's
      // look uses (shared/says.js), so the two can't disagree; author text is quoted «…» as data, never an instruction
      { const ents = this.st.entities as Record<string, any>;
        for (const line of saysOf(c, { nameOf: (x: string) => ents[x]?.label ?? x, now: Date.now() })) aff.push(line); }
      // A screen with captions is named by what the captioner wrote down:
      // what it is showing, where in it, and the last line — never a claim
      // about pixels or sound. Rung 2 of the projector ladder; the rolling
      // window is the `captions` detail level, opt-in like `body_state`.
      if (c.captions) aff.push(describeCaptions(c.captions));
      // A sound is named by what its author SAID is playing, and whether it
      // is — never by the audio. The radio's music player; captions (#187)
      // on the same entity say the words.
      // locked = nailed down: the authority refuses every move/replace/remove on
      // it. Saying so here saves an agent a refused round-trip.
      // the real tool where there is one (audit 10-07: look taught the act hatch for edit's own fields)
      if (c.lock) aff.push(`🔒 locked (immovable until a builder lifts it: edit {id: "${this.handle(e.id)}", set: {"flags.lock": false}}; or edit through it with throughLock: true)`);
      if (c.hidden === true) aff.push(`hidden (not drawn; edit {id: "${this.handle(e.id)}", set: {"flags.hidden": false}} shows it)`);
      // a placed blueprint copy (or one of its parts) says which blueprint it
      // follows — the link, read through the one shared reading
      const copy = c["copy-of"] ? this.copyLine(e.id) : null;
      if (copy) aff.push(copy);
      // A griddled building says what it IS — rooms, walls, doors — because
      // unlike a conjured mesh it knows. This is the whole difference the
      // structure component buys: `components: structure` would be true and
      // useless, where "a building: 2 rooms, 14 walls, 1 door" is actionable.
      if (c.structure) { try { aff.push(describeStructure(c.structure)); } catch { /* a broken house is not a broken look() */ } }
      const spoken = ["model", "parent", "sockets", "socket", "reactions", "motion", "particles", "picture", "captions", "sound", "lock", "structure", "label", "hidden", "description", "openable", "story", "text", "look-at"];
      if (copy) spoken.push("blueprint");
      if (lit) spoken.push("light");   // described above; a malformed one stays listed
      if (col === "mesh" || col === "exact" || col === "box") spoken.push("collider");
      const extra = Object.keys(c).filter((k) => !spoken.includes(k));
      if (extra.length) aff.push(`components: ${extra.join(", ")}`);
      const mnt = this.mounts.get(e.id);
      if (mnt) aff.push(`mounted on ${this.socketName(mnt.to)}${f.ok && f.moving ? ` (carried by its ${f.moving})` : ""}`);
      // who and what occupy it: on it directly, or in one of its sockets (said with the socket's name)
      const sockIds = new Set(socks.map((x) => x.id));
      const occupants = [...this.mounts.entries()].filter(([oid, m]) => !sockIds.has(oid) && (m.to === e.id || sockIds.has(m.to))).map(([oid, m]) => `${oid}${sockIds.has(m.to) ? ` (${this.socketRec(m.to)?.name})` : ""}`);
      if (occupants.length) aff.push(`carrying: ${occupants.join(", ")}`);
      if (f.ok) {
        // the EFFECTIVE position — mount chain and motion composed at nowMs.
        // For an unmounted, unmoving thing this is exactly the folded pos.
        // Distance/bearing only exist relative to a KNOWN self (#92, B2).
        const dx = f.pos[0] - me.x, dz = f.pos[2] - me.z;
        L.push(`  - [${this.handle(e.id)}] ${short}: ${meKnown ? `${Math.hypot(dx, dz).toFixed(1)}m ${this.bearing(dx, dz)} ` : ""}at (${f.pos[0].toFixed(1)}, ${f.pos[1].toFixed(1)}, ${f.pos[2].toFixed(1)})${f.pos[1] > 0.05 ? " (elevated)" : ""}${aff.length ? ` — ${aff.join(" · ")}` : ""}`);
      } else {
        // No number is better than a wrong number: when the chain cannot be
        // composed (a part socket, an unknown motion type, a malformed link),
        // perception says whose frame the thing rides and why the coordinate
        // is withheld — never the stale pre-mount pos next to "mounted on".
        const where = mnt ? `position rides ${this.socketName(mnt.to)}` : `position unavailable`;
        L.push(`  - [${this.handle(e.id)}] ${short}: ${where} — ${f.why}${aff.length ? ` — ${aff.join(" · ")}` : ""}`);
      }
    }
    if (ents.some((e) => e?.reactions) || [...this.entities.values()].some((e) => e.kind === "socket")) {
      L.push(`  (use a thing: act {verb: "use", args: {id, action?}} · sit or ride: attach {to: id, socket?} — both open to everyone; detach, or walking, gets you off)`);
    }

    const unread = this.inbox.slice(this.inboxCursor);
    this.inboxCursor = this.inbox.length;
    if (unread.length) {
      L.push(`\nSince you last looked:`);
      for (const m of unread.slice(-25)) {
        L.push(m.kind === "say" ? `  ${m.who}: ${m.text}`
          : m.kind === "act" ? `  * ${m.who} ${m.text}`
          : `  * ${m.who} ${m.kind === "arrive" ? "arrived" : "left"}`);
      }
    }
    return L.join("\n");
  }
}
