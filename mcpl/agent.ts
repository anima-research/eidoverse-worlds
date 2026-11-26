// WorldAgent — a headless world participant: the MCPL's body.
// Owns its avatar as the browser client owns a human's: position/yaw/speed ticked at 10Hz, pose intent streamed to
// the sequencer, terrain replicated so feet agree with every renderer. No GPU: pictures come from the world's /snap
// (tools.ts screenshot).

import { bodyOf } from "../shared/components.js";
import { CLASSES } from "../shared/protocol/consent.js";
import { helloOf, refusalWords } from "../shared/protocol/hello.js";
import { mayLeave, socketsUnder, vacatedFromMine, vacatedAt } from "../shared/sockbody.js";
import { r3 } from "../shared/protocol/round.js";
import { BodyStateReader, type BodyObservation } from "./body-state.ts";
import { mentionRegexFor } from "./mention.ts";

import { type ActResult, type Entity, type Pose, bodyStructure, done, refused, RAGDOLL_ROOT_DROP, WORLD_READ_MS, isSocketRec } from "./agent-result.ts";
export { voiceNote } from "./agent-senses.ts";
import { AgentSenses } from "./agent-senses.ts";
export { GLIDE_ARRIVE_M } from "./agent-flight.ts";
import { AgentFlight, type FlightEnd } from "./agent-flight.ts";
import { AgentReach } from "./agent-reach.ts";
export { meshGovernor, forgetMeshCache } from "./agent-ground.ts";
import { AgentGround, floorAtLocal } from "./agent-ground.ts";
import { AgentPlaces } from "./agent-places.ts";
export type { ActResult } from "./agent-result.ts";
import { mergePose } from "../shared/humanoid.js";
import { resolveBriefing } from "../shared/briefing.js";
import { requestGrid, shapeReady, withShaping } from "../shared/terrainshape.js";
import { foldOffset } from "../shared/clockoffset.js";
import { bodyHeightFor, forgetReadings } from "./rigbones.ts";
import { surfaceOffset, waveClock } from "../shared/waves.js";
import { floatStep, footprintSurface } from "../shared/buoyancy.js";
import { analyzeWater } from "../shared/waterkind.js";
import * as THREE_W from "three/webgpu";
import * as TSL from "three/tsl";
import { NoiseGate, ACTIVITY_RADIUS_M } from "./denoise.ts";
import { HeadlessBody, setHeightField, setWaterField, standOn, collidersReady, navProbe, collidersGeneration, inWorld, withoutColliders } from "./physics.ts";
import { makeNavGrid, NAV_SUBSTEP, NAV_NUDGE, NAV_STEP, type NavProbe, type NavTarget } from "../shared/navgrid.js";
import { names } from "../shared/places.js";
import { colliderOf } from "../shared/components.js";
import { MOVER, TRACK, walkToward, toleranceOf, waterStance } from "../shared/mover.js";
import { foldedIn, wingFoldPresence } from "../shared/wingpresence.js";
import { bodyModeTracker, isBodyMode, readBodyMode } from "../shared/bodymode.js";
import { clampBodyScale } from "../shared/presencewire.js";
import { DEFAULT_LEAF_FORCE as LEAF_FORCE } from "../shared/leafforce.js";


// the same sky fold + weather derivation the browser and the sequencer run: perception lands on the hour and weather
// every renderer shows
import { foldSkyEntry } from "../shared/forecast.js";
// the world: this process folds the authority's own stream and reads the VIEW of that fold, like the browser
import { makeReplica } from "../shared/protocol/replica.js";
import { REDACTED } from "../shared/protocol/fold.js";
import { diffView } from "../shared/viewdiff.js";
import { emptyView, idOut } from "../shared/protocol/view.js";
import { hear } from "../shared/chatwindow.js";
import * as OP from "../shared/requests.js";
import { localizePoint, prepareRouteLocal, ROUTE_STEP_METRES } from "../shared/structure.js";
import { effectiveWorldTransform, type Effective } from "./effective.ts";
import { makeVerdictCache, seatGateCore, nameFromAvatarPath } from "../shared/seatcore.js";
import { redialer, REDIAL } from "../shared/redial.js";
import { createShover, shoveable, footprint, obbOf, aabbOfObb, contactOf, massOf, budges, SHOVE_FEEL } from "../shared/shove.js";
import { SHOVE, DRAG_SILENCE_MS } from "../shared/protocol/physconst.js";
import { worldPose } from "../shared/protocol/simlayer.js";
import { physicsVolumesOf, speedFactorAt, foldOfView, zonesOf, waterVolumes, worldLevelAt } from "../shared/zone.js";
import { fallBackOf, belowWorld, FELL } from "../shared/spawn.js";
import { colliderFor } from "../shared/bodyscale.js";

import { recordComponents } from "../shared/protocol/view.js";
import { modelWord } from "../shared/eido.js";
import { handleOf, resolveThing } from "../shared/thingref.js";
import { oldFormatWords } from "../shared/oldformat.js";
import { DEFAULT_BODY } from "../shared/avatardefs.js";
(globalThis as any).THREE = Object.assign({}, THREE_W, TSL);

/** The body's clock: one stride of shared/mover.js (the one walker: the client's and the authority's too) per tick. */
const TICK_MS = 100;
/** The sequencer a body joins when neither its options nor WORLD_URL name one. */
export const DEFAULT_WORLD_URL = "ws://127.0.0.1:8940/ws";
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
/** Longest horizontal move between two collision checks, so a run's 0.4m tick
 *  can't leap a thin wall (navgrid.js NAV_SUBSTEP says why this scale). */
const COLLIDE_SUBSTEP = NAV_SUBSTEP;
/** A walk that has made less than this fraction of its intended progress for
 *  STALL_TICKS consecutive ticks is held by something solid: it ends, saying
 *  so, instead of pressing against the wall until the 90s timeout. */
const STALL_PROGRESS = 0.2, STALL_TICKS = 15;
const GRAVITY = 16;

type Vec2 = { x: number; z: number };
/** How long a walk waits for placed geometry still loading before it is refused (see walkTo); covers a fetch's own
 *  timeout plus some queueing. */
const WALK_READY_MS = 15_000;
/** This body's walking capsule: an agent's body is its authored size (no agent sets a scale: occupantScale answers 1 for
 *  it), so its walk resolves with colliderFor(1) (mcpl/physics.ts WALKING), and its shoves and stalls touch with the same. */
const BODY_CAP = colliderFor(1);
const GEOMETRY_LOADING = "things placed nearby are still loading their shape, so a walk now could pass through them — try again in a moment";
/** A walk waiting out a fall whose body something else took (walkTo; tools.ts reads the "superseded by" as no fallback). */
const FALL_TAKEN = "superseded by something taking the body as it fell (a seat, a hand, a nail or a tumble)";
export type Person = { id: string; avatar: string; pose: Pose | null; declares?: string | null; observedAt?: number | null; bodyGeneration?: number };

// ---- walking through buildings (#218) ----
/** What a walk's feet stand on: the terrain (followed live, tick by tick), or one identified floor of one structure at a
 *  fixed height. */
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

/** A floor walk's navgrid probe, standing nowhere lower than the walk's floor.
 *  The walk's feet never go below that floor (walkHeightAt, stepFeet), so a
 *  lower column is no ground: otherwise the grid could route the walk over air
 *  beside the floor. `GROUNDED` is stepFeet's own nearness. */
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

type InboxItem = { ts: number; kind: "say" | "arrive" | "leave" | "act"; who: string; text?: string; seq?: number | null };

/** One bone of a held pose: a rotation, or {q, t, s} (shared/humanoid.js poseChannels). */
type PoseValue = number[] | { q?: number[]; t?: number[]; s?: number[] | number };

// A canned "knocked over" pose, for when the ragdoll sim (physics.ts) is unavailable.
const DOWNED_POSE: Record<string, number[]> = {
  spine: [0.6, 0, 0, 0.8], chest: [0.5, 0, 0, 0.87], neck: [0.3, 0, 0, 0.95],
  leftUpperArm: [0, 0, -0.9, 0.44], rightUpperArm: [0, 0, 0.9, 0.44],
  leftUpperLeg: [0.9, 0, 0, 0.44], rightUpperLeg: [0.9, 0, 0, 0.44],
  leftLowerLeg: [-0.7, 0, 0, 0.71], rightLowerLeg: [-0.7, 0, 0, 0.71],
};

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
  /** Remaining validated centerline waypoints (walkTo). Only the destination uses the caller's tolerance; intermediate
   *  waypoints are reached exactly, or within NAV_NUDGE on a navgrid route. Each carries the floor height the route stands
   *  on there, when the navgrid planned it (the authority is asked for stretches at that height: up a stair, the stretch's
   *  end is on the stair, not the floor beneath it). */
  private legs: (Vec2 & { y?: number })[] = [];
  private walkTolerance: number = MOVER.arrive.tolerance;
  /** The height the walk under way stands at, wherever it is: the live terrain for a terrain walk, the admitted floor
   *  for a floor walk. Null when no walk is under way. */
  private walkHeightAt: ((x: number, z: number) => number) | null = null;
  /** Why the last walk planned was refused (its arguments, or no route), or null when accepted. A plan can wait for
   *  placed geometry (walkTo), so a caller that needs its own request's refusal passes walkTo a `receipt`. */
  walkRefusal: string | null = null;
  /** This body's standing height (rigbones.ts bodyHeightFor) — what water depth is measured against. */
  bodyH: number | null = null;
  /** Which avatar `bodyH` is (being) measured for, and the measurement's generation: a body swap starts a
   *  new one, and a reply for an older body is dropped — the stature always belongs to the CURRENT body. */
  statureFor: string | null = null;
  private statureGen = 0;
  /** What `water` was when the float state last made sense: a change of water (drained, refilled, a new
   *  level) ends the float, so no position or velocity crosses from one water to the next. */
  waterKey: string | null = null;
  /** A swimming body's buoyant column (shared/buoyancy.js) — on the same swell everyone's water draws. */
  float = { on: false, y: 0, vy: 0 };
  /** Why the last walk stopped short, when something stopped it mid-way. */
  walkStopReason: string | null = null;
  /** The world's water (shared/terrainshape.js), from the terrain bag; null when it has none. */
  water: { level: number } | null = null;
  /** What kind of water lies where (shared/waterkind.js) — the same reading the renderers draw from. */
  waterKinds: ReturnType<typeof analyzeWater> | null = null;
  /** A held custom pose — sparse humanoid-bone quaternions. Presence only:
   *  it rides the pose packet and is never a log verb, because it is a moment,
   *  not a change to the world. `null` clears. */
  heldPose: Record<string, PoseValue> | null = null;
  /** Where heldPose came from. An AUTHORED pose (the anim tool, a puppet, the
   *  server's settled memory) is a place: it survives posture changes and sleep,
   *  and walking only when pinned with `hold` (heldPoseSticky). A PHYSICS pose (sim frame, drag stream, knockdown slump) is a
   *  moment: it only ever leaves this process under the "ragdoll" clip, and any
   *  decision to move sheds it. */
  heldPoseAuthored = false;

  /** Feet height when this body was last knocked over standing (knockDown). A
   *  canned slump keeps its root at this height until a sim frame or a dragging
   *  hand moves it, so a slumped root still here is canned (rootCanned); any
   *  other has its feet RAGDOLL_ROOT_DROP above its root (feetY). */
  cannedY: number | null = null;
  private hipsAboveRoot: number | null = null;

  /** The exact pose object granted "hold this while I walk", compared by
   *  identity: any other writer of `heldPose` revokes it just by assigning a
   *  different object, so no call site can forget to clear a flag. */
  private heldPoseSticky: Record<string, PoseValue> | null = null;
  draggedBy: string | null = null;   // whose takeover sim drives this body (bodydrag)
  dragAt = 0;                        // last drag sample, for the silence timeout
  pins = new Map<string, number[]>(); // persistent bodydrag nails: joint -> [x,y,z]
  body: HeadlessBody | null | undefined = undefined; // the REAL ragdoll (undefined = not tried yet)
  simTicker: ReturnType<typeof setInterval> | null = null;
  private walkDone: ((arrived: boolean) => void) | null = null;
  // ---- the authority's track of this body (E1) ----
  // The authority keeps its own body per actor (authority.js EMBODIED_VERBS.move) and every hand verb measures from it.
  // This body asks for each stretch BEFORE walking it, so a wall the authority refuses stops both at the same place.
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
  st: any = emptyView();
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
  /** Who or what occupies what, keyed by the occupant (a body or a thing), in the mount's full wire shape: its
   *  offset/yaw/q OVERRIDE the socket's defaults in the world transform (#82), as every renderer composes it. */
  mounts = new Map<string, { to: string; offset?: number[]; yaw?: number; q?: number[] }>();
  /** Bodies' seats are PRESENCE (bodies aren't entities, nothing is logged): a body's pose frame carries
   *  `seat: {to: <socket id>}` while it sits (an older client's {to: host, slot} is read as that host's socket of that
   *  name: resolveSeat). Others' come from their frames; mine rides my frames. */
  bodySeats = new Map<string, { to: string }>();
  myOccupancy: { to: string; pose?: string; at?: number } | null = null;
  /** A host's sockets: its socket children, [{id, name, sock}] in child order — the one reader
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
  socketName(id: string) { const s = this.socketRec(id); return s ? `${s.host ? this.refName(String(s.host)) : s.host} (${s.name})` : this.entities.has(id) ? this.refName(id) : id; }   // by its name
  /** A thing's short handle here (shared/thingref.js): the shortest unique id prefix of 4+, derived fresh. */
  handle(id: string): string { return handleOf(id, this.entities.keys()); }
  /** What a reader calls a thing in a sentence or a "thing/place" ref: its label when that names it alone, else its handle. */
  refName(id: string): string { const l = (this.entities.get(id) as any)?.label; if (typeof l === "string" && l.trim() && !/[/\[\]"]/.test(l)) { const r = this.thingRef(l); if ("id" in r && r.id === id) return l.trim(); } return this.handle(id); }
  /** How a thing reads in a list of candidates: its label, what it is, where it is, its handle. */
  thingLine(id: string): string {
    const e: any = this.entities.get(id); if (!e) return `[${this.handle(id)}]`;
    const what = e.model ? modelWord(e.model).split("_").slice(0, 5).join(" ") : isSocketRec(e) ? "a socket" : "(empty)";
    const up = this.mounts.get(id)?.to; const f = this.eff(id, Date.now());
    const where = up && this.entities.has(up) ? `on ${(this.entities.get(up) as any)?.label ?? `[${this.handle(up)}]`}` : f.ok ? `at (${f.pos[0].toFixed(1)}, ${f.pos[1].toFixed(1)}, ${f.pos[2].toFixed(1)})` : "where unknown";
    return `${typeof e.label === "string" && e.label ? `"${e.label}" ` : ""}${what} ${where} [${this.handle(id)}]`;
  }
  /** A thing by what an agent calls it: its id, its label, or a unique id prefix (4+, git-style).
   *  Several matching is refused with the candidates (label, what, where, handle), never resolved by picking one. A
   *  placeholder ('$x'), @world, a blueprint hash or a person's identity is not a thing name: it passes as it is.
   *  {id} | {refusal} | {none} (nothing here is called that: a caller may try a place or a person next). */
  thingRef(raw: string): { id: string } | { refusal: string } | { none: true } {
    const q = String(raw ?? "").trim();
    if (!q || q.startsWith("$") || q.startsWith("@") || q.startsWith("sha256:") || /^u-[a-z2-7]{20}(?:[a-z2-7]{4})?$/.test(q)) return q ? { id: q } : { none: true };
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
  /** The authority's body inbox (PROTOCOL §5), pushed by the server as it fills: acts delivered to my body, revocations,
   *  my refused reaches, someone's refused act on me (`body-refused`) and being let go from what I occupy (`vacated`) are said. */
  bodyInbox(messages: any) {
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m !== "object") continue;
      const ts = Date.now(); let text: string | null = null;
      // a row reads `* <who> <text>` (look, net-server): who is the actor's name (its id when none is known), text the rest
      const actor = m.from ?? m.by, subj = typeof actor === "string" ? this.nameOfActor(actor) ?? actor : "world";
      // what the authority did: it let the act reach this body, and recorded it
      if (m.type === "body" && m.kind === "shove") {   // a shove the authority delivered (a blast's): applied as the relay's is
        const lean = Array.isArray(m.spec?.lean) && m.spec.lean.length === 3 && m.spec.lean.every(Number.isFinite) ? m.spec.lean : null;
        const by = this.nameOfActor(String(m.from ?? "")) ?? String(m.from ?? "someone"); this.knockDown(by, lean, "knocks you over"); }
      else if (m.type === "body") text = `reached your body (${m.kind}${m.spec?.point ? `, ${m.spec.point}` : ""}): the world let it (consent: ${m.consent})`;
      else if (m.type === "vacated") {   // an edit by someone else moved the seat I sat on, and the authority let me go
        if (vacatedFromMine(m, this.myOccupancy)) { const on = this.socketName(m.socket); this.setOccupant(null);
          // stand where the authority let me go (its track of my body starts again there)
          const at = vacatedAt(m); if (at) { this.pos.x = at[0]; this.pos.y = at[1]; this.pos.z = at[2]; }
          text = `moved ${on}, the seat you were on, so you are standing where it was${typeof m.why === "string" ? ` (${m.why})` : ""}`; } }
      else if (m.type === "body-revoked") text = `withdrew consent for ${m.class}: what you were doing to their body has ended`;
      // someone's act on MY body was refused (said once per asker per minute): who, and what of mine turned it away
      else if (m.type === "body-refused") {
        text = `tried to ${m.class === "shove" || m.class === "displace" ? "move" : "touch"} you (${m.class}); it was refused: ${m.gate ? `your ${m.gate} gate is off` : "they are on your block list"}`; }
      else if (m.type === "reach-refused") {   // the relay took a hand of mine out of my pose: nobody saw it (server/reachgate.ts)
        const to = String(m.to ?? ""), who = this.nameOfActor(to) ?? to;
        this.reachRefusals.push({ to, cls: String(m.class ?? "touch"), why: String(m.why ?? "their consent refused it"), ...(m.fix ? { fix: String(m.fix) } : {}), ...(typeof m.limb === "string" ? { limb: m.limb } : {}), ts });
        if (this.reachRefusals.length > 20) this.reachRefusals.shift();
        const dropped = this.reaching.dropReachesAt(to, typeof m.limb === "string" ? m.limb : undefined, String(m.class ?? "touch"));
        text = `your hand toward ${who}${m.point ? `'s ${m.point}` : ""} was not shown to anyone (consent class ${m.class}): ${m.why}${m.fix ? ` — ${m.fix}` : ""}${dropped.length ? `. Withdrawn: ${dropped.join(", ")}` : ""}`; }
      if (text) { const who = subj; this.inbox.push({ ts, kind: "act", who, text }); this.onEvent?.({ ts, kind: "act", who, text }); }
    }
  }
  /** sit on a thing's seat socket (presence: my frames carry {to: <socket id>}), or stand (null) */
  setOccupant(seat: { to: string; pose?: string; at?: number } | null) {
    if (seat && this.flight) this.endFlight("seat");
    this.myOccupancy = seat;
    if (seat) this.mounts.set(this.name, { ...seat }); else this.mounts.delete(this.name);
  }
  people = new Map<string, Person>();
  inbox: InboxItem[] = [];
  pings: { ts: number; kind: "mention" | "approach" | "depart" | "reach" | "touch"; who: string; text?: string }[] = [];
  onPing: ((p: { ts: number; kind: string; who: string; text?: string }) => void) | null = null;
  /** live world events (say, act, arrive, leave, activity, weather, world-change) — the channel fan-out hook */
  onEvent: ((ev: { ts: number; kind: "say" | "arrive" | "leave" | "act" | "activity" | "weather" | "world-change"; who: string; text?: string; mention?: boolean; part?: "ground" }) => void) | null = null;
  /** MEDIA seam. The SFU's publish path is gated to the embodied primary, which
   *  for an agent is this server, so the door relays the media-signalling frames
   *  between the world and a local voice sidecar. The door never synthesizes,
   *  encodes or holds a peer connection; it stays a text-tier participant.
   *
   *  Frames out (server→sidecar): relay-cred · sfu-offer · sfu-ice · sfu-route · voice-consent ·
   *    surface-transition · voice-service · voice-moderated
   *  Frames in  (sidecar→server): sfu-answer · sfu-ice · sfu-want-negotiate · sfu-pos · voice-consent
   *  Nothing else is forwarded: a whitelist, not a pipe, so server-side
   *  validation stays the one authority (test/mcpl/door-media-whitelist-test.mjs). */
  onMedia: ((frame: Record<string, unknown>) => void) | null = null;
  /** Our own recent says (seq → text) and our surface generation, both needed
   *  to mint a performance receipt on a sidecar's behalf. */
  ownSays = new Map<number, string>();
  surfaceGen: number | null = null;

  /** The performance receipt. Sent by the DOOR, never the sidecar: attest is
   *  identity-bearing, and a sidecar able to mint one could suppress listeners'
   *  TTS fallback for audio never aired. The digest is over the WORLD's copy of the text. */
  async attestSay(seq: number): Promise<boolean> {
    const text = this.ownSays.get(seq);
    if (text == null || this.ws?.readyState !== 1) return false;
    const digest = Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    this.ws.send(JSON.stringify({ type: "attest", seq, digest, gen: this.surfaceGen }));
    return true;
  }
  /** My live reach descriptors, one per limb (shared/reachwire.js), sent on
   *  every presence packet; `reached` is my solver's attestation (reachTick). */
  reaches = new Map<string, { t: any; palm?: false; reached?: true }>();
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

  bodyReader: BodyStateReader | null = null;
  bodyGenerationCounter = 0;
  private selfBodyGeneration = 0;
  private selfObservedAt: number | null = null;
  // Seat-profile verdicts: the server-judged values /avatars hands the browser,
  // fetched at join and on the two update events, cached by seatcore's
  // makeVerdictCache (the browser's own implementation). effective.ts reads
  // these through the view, never a rederived hash or a quiet default.
  private seatCache = makeVerdictCache(async () => {
    const res = await fetch(`${this.httpBase}/avatars`, { signal: AbortSignal.timeout(WORLD_READ_MS) });
    if (!res.ok) throw new Error(`roster ${res.status}`);
    const rev = Number(res.headers.get("x-profiles-rev") ?? NaN);
    return { rev, entries: await res.json() as { name: string; seat?: any }[] };
  });
  /** Stateful denoiser for ambient narration (arrive/leave/acts). Says and
   *  mentions never pass through it — a knock is not chatter.
   *  See denoise.ts for the doctrine. */
  gate = new NoiseGate((ev) => {
    if (ev.kind === "arrive") this.senses.act30.arrivals++;
    else if (ev.kind === "leave") this.senses.act30.departures++;
    this.inbox.push({ ts: ev.ts, kind: ev.kind, who: ev.who, ...(ev.text != null ? { text: ev.text } : {}) });
    this.onEvent?.(ev);
  });
  /** The activity sense is the agent's own to tune (persisted per-agent by
   *  net-server's state file, `rememberActivity`; see its `activity` tool). Instance values start at
   *  the world defaults. */
  activityRadiusM = ACTIVITY_RADIUS_M;
  worldInfo: Record<string, unknown> = {};
  briefing: ReturnType<typeof resolveBriefing> = null;
  private resolveRelative: boolean;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Wall time between ticks; each tick still steps TICK_MS of the body. Tests only, to walk faster than real time. */
  private readonly tickEveryMs: number;
  /** Highest world-log seq this body has seen: what "where was I up to" means. Not a wall-clock time: it survives
   *  restarts, cannot drift, and compares directly with what the world hands out. */
  lastSeq = -1;
  private pendingHistory = new Map<string, (m: any) => void>();
  /** The join snapshot's protocol line: {dialect, v, world: the id, name: the directory, seq}; null until joined. Building
   *  tools go through request()/sendOps() and WAIT for the authority's reply, so a refusal reaches the agent. */
  snapshot: { dialect: string; v: number; world: string; name: string; seq: number } | null = null;
  /** The world's own fold, from the join cut and the authority's `log` stream (shared/protocol/replica.js). */
  replica: any = null;
  /** The last building verb's turn: each is spelled after the one before it is answered. */
  private spelling: Promise<unknown> = Promise.resolve();
  /** replica: this body folds the world's log stream itself (the server refuses a client that doesn't). */
  private joinMsg() {
    // clock: the server's time just before the snapshot (the `clock` case below), so serverNow() is set from the join on
    return { type: "join", world: this.world, id: this.name, avatar: this.avatar, ...(this.declares ? { declares: this.declares } : {}), replica: true,
      token: process.env.WORLD_TOKEN ?? "", agentToken: this.agentToken, clock: true, hello: helloOf() };
  }
  private pendingRequests = new Map<string, (m: any) => void>();
  private pendingDebug = new Map<string, (m: any) => void>();
  private histId = 0;

  /** Is `who` this body: its name here, or its own actor id (a say's `to` arrives as the name, or the id the replica can't name)? */
  isMe(who: unknown): boolean { return typeof who === "string" && !!who && (who === this.name || who === this.actorIds.get(this.name)); }
  /** Does `text` mention this body: its name, or the display name its credential gave it (#184)? */
  mentionsMe(text: string): boolean {
    return !!mentionRegexFor([this.name, this.displayName], { dropQualifiers: this.dropMentionQualifiers })?.test(text);
  }

  constructor(opts: { url?: string; name?: string; displayName?: string; dropMentionQualifiers?: boolean; world?: string; avatar?: string; agentToken?: string; declares?: string | null; tickEveryMs?: number; resolveRelative?: boolean } = {}) {
    this.tickEveryMs = opts.tickEveryMs ?? TICK_MS;
    this.resolveRelative = opts.resolveRelative ?? true;
    this.url = opts.url ?? process.env.WORLD_URL ?? DEFAULT_WORLD_URL;
    this.name = opts.name ?? process.env.AGENT_NAME ?? "claude";
    // The token's display name ("Artie (kube)"): a second form the body
    // answers to in chat. The id stays the addressing handle everywhere else.
    this.displayName = opts.displayName ?? process.env.AGENT_DISPLAY_NAME ?? "";
    this.dropMentionQualifiers = opts.dropMentionQualifiers ?? true;
    this.world = opts.world ?? process.env.WORLD_NAME ?? "commons";
    this.avatar = opts.avatar ?? process.env.AGENT_AVATAR ?? DEFAULT_BODY;
    // The agent's own bearer (the one that opened the MCPL door). Forwarded at
    // join so the sequencer can verify the name — agent names are reserved.
    this.agentToken = opts.agentToken ?? process.env.AGENT_TOKEN ?? "";
    { const d = opts.declares !== undefined ? opts.declares : process.env.AGENT_DECLARES ?? "agent"; this.declares = d || null; }
  }

  /** The key this body joined with, as the Bearer header the world's state reads take (/snap, /worlds, /geom?world:
   *  behind the same door as a join). */
  get readHeaders(): Record<string, string> { const k = this.agentToken || process.env.WORLD_TOKEN || ""; return k ? { authorization: `Bearer ${k}` } : {}; }
  get httpBase(): string {
    // URL surgery, not string surgery: a WORLD_URL carrying a query string (…/ws?token=…) defeats a regex replace
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
    ++this.bodyEpoch;    // a knockdown or settle still loading abandons itself
    if (this.flight) this.endFlight("closed");
    this.briefing = null;
    this.stop();
    this.stopSim();
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.senses.activityTimer) { clearInterval(this.senses.activityTimer); this.senses.activityTimer = null; }
    this.gate.dispose(); // held narration dies with the session
    for (const s of this.senses.emitterNarration.values()) clearTimeout(s.timer);
    this.senses.emitterNarration.clear();
    this.senses.forgetGround();
    // Take this world's floors out with us: the collider map is process state
    // (physics.ts), so a successor agent elsewhere would otherwise stand on them.
    for (const id of [...this.ground.supportIds.keys()]) this.ground.dropSupport(id);
    this.ws?.close();
  }

  /** A malformed log entry is WORLD data, not this agent's mistake — say so
   *  a few times, then stay quiet: a poisoned tail replays on every
   *  reconnect and must not flood the log with the same diagnosis. */
  private malformedSeen = 0;
  noteMalformed(verb: string, args: unknown) {
    if (this.malformedSeen++ >= 5) return;
    console.error(`[agent ${this.name}] malformed ${verb} entry — position kept: ${JSON.stringify(args)?.slice(0, 160)}`);
  }

  /** Server-to-local clock offset, the headless serverNow(): the same samples
   *  and rule as client/lib/player/remotes.js (shared/clockoffset.js, least-delayed
   *  sample wins), on this process's monotonic clock (localNow). Motion is a
   *  function of SEQUENCER time, so a skewed host clock would show a different
   *  pendulum phase than every browser. Fed from the server's pre-snapshot
   *  clock message and the embodied plane's frame stamps. */
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
   *  one must ABSTAIN, never fall back to a stale coordinate. */
  effGaps = 0;
  private noteEffGap(id: string, why: string) {
    if (this.effGaps++ >= 5) return;
    console.error(`[agent ${this.name}] effective transform unavailable for ${id} — ${why}`);
  }

  /** A support seam is the same species: a floor this side cannot
   *  truthfully model. Declared, bounded, and never papered over with the
   *  known-false box top. */
  supportSeams = 0;
  noteSupportSeam(id: string, why: string) {
    if (this.supportSeams++ >= 5) return;
    console.error(`[agent ${this.name}] support seam on ${id} — ${why}`);
  }

  /** A build act (a thing made, moved or removed) near this body counts as activity. */
  private noteBuild(actor: string | undefined, pos: number[] | undefined | null) {
    if (!actor || actor === this.name || actor === "world") return;
    if (pos && Math.hypot(pos[0] - this.pos.x, pos[2] - this.pos.z) > this.activityRadiusM) return;
    this.senses.act30.builds++;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("agent closed"));
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.joinRefused = null;
      const timeout = setTimeout(() => reject(new Error(this.joinRefused ?? "the world didn't answer the join within 8 seconds")), 8000);
      // The join declares what this body is (joinMsg); it grants no capability.
      ws.onopen = () => ws.send(JSON.stringify(this.joinMsg()));
      ws.onclose = (ev) => {
        this.joined = false;
        if (this.flight) this.endFlight("link");   // nothing ticks it while the link is down (#300)
        this.briefing = null;
        // 4006 = removed by moderation (kicked or banned): the body stays down,
        // and goes THROUGH close() so it also drops the floors it holds up in
        // the process-global physics state.
        // …unless the removal said when they may come back (a timed ban's until): the body still lets go of what it holds
        // up now, and the host dials again once it has passed. A kick (no until), an untimed ban and anything over two
        // hours stay down.
        if ((ev as { code?: number } | undefined)?.code === 4006) {
          const wait = (this.removedUntil ?? 0) - Date.now();
          if (wait > 0 && wait <= 2 * 3600_000 && !this.closed) {
            for (const id of [...this.ground.supportIds.keys()]) this.ground.dropSupport(id);
            this.removedUntil = null;
            setTimeout(() => { if (!this.closed) this.connect().catch(() => {}); }, wait + 1000);
            return;
          }
          this.close(); return;
        }
        // 4005 = the sequencer REFUSED the join (bad or reserved name, bad token, no such world, access refused…). A
        // refusal is an answer, not an outage: redialing it would hammer the sequencer.
        // …except reason "full": temporary, so the body dials again by itself, backing off as a person's page does
        // (shared/redial.js). The other refusals end the body.
        const code = (ev as { code?: number } | undefined)?.code, why = String((ev as { reason?: string } | undefined)?.reason ?? "");
        const refused = this.joinRefused; this.joinRefused = null;
        if (code === 4005 && why === "full" && !this.closed) {
          clearTimeout(timeout);
          // the words are this body's, kept open: the agent doors (mcpl/server.ts, net-server's serve and travel) end on this
          // rejection and close it, so they say only what a body that is kept does (docs/reference/WIRE.md 4005)
          reject(new Error(`${refused ?? "the world is full"} — trying again by itself while this body is kept open (closing it gives up the wait)`));
          setTimeout(() => { if (!this.closed && !this.joined) this.connect().catch(() => {}); }, this.redial.next(REDIAL.full));
          return;
        }
        if (refused !== null) { this.closed = true; clearTimeout(timeout); reject(new Error(refused)); }
        // 4010 = this world is not open to this identity (server/access.ts): refused at the door, or its access ended or
        // changed. Same answer as a ban for redialling: the door will not open on its own, so the body stays down.
        if (code === 4005 || code === 4010) { this.close(); return; }
        // 4002 = a newer session of this identity took over: dialling again would take that one over in turn, back and forth
        // for ever (client/lib/net.js yields too)
        if (code === 4002) {
          console.warn(`[agent] ${this.name}: taken over by another session of this identity (4002); not dialling again`);
          this.close(); return;
        }
        // any other drop (an outage, a restart): dialled again on the browser's schedule (shared/redial.js, reset by a join),
        // not a fixed 1.5 s that every agent of a restarted server would keep in step
        if (!this.closed) setTimeout(() => this.connect().catch(() => {}), this.redial.next());
      };
      ws.onmessage = async (ev) => {
        // No event may ever exit the process: one bad message is one logged line,
        // never an outage for every resident on this door.
        try {
        const msg = JSON.parse(String(ev.data));
        switch (msg.type) {
          case "error":
            if (typeof msg.until === "number") this.removedUntil = msg.until;   // when a timed ban lets us back (onclose 4006)
            // A pre-join refusal is final: surface the sequencer's reason
            // instead of retrying the identical join.
            if (!this.joined) {
              // a cooldown isn't final: onclose 4006 dials again after it. Any other refusal's close says whether it is
              // final (4005 "full" is not: onclose dials again); onclose answers this connect() with these words (after a 4006
              // close only the 8 s timer does). The world's own words, as the cause inside whatever sentence carries this
              // (travel's, for one)
              const said = String(msg.error ?? "").trim().replace(/\.+$/, "");
              const base = said ? `the world refused the join: ${said}` : "the world refused the join without giving a reason";
              // an old-format world: who may upgrade it, and the doc, in words (shared/oldformat.js; docs/reference/WIRE.md 4005)
              const words = msg.refused?.code === "old-format" ? `${base}. ${oldFormatWords(msg.refused, this.world)}` : base;
              if (typeof msg.until === "number") { clearTimeout(timeout); reject(new Error(words)); }
              else this.joinRefused = words;
            } else {
              // A mid-life refusal of a message with no reply of its own (a puppet, a moderation message; a request
              // answers on its reply): the only place the answer lands, kept for a tool call (tools.ts
              // presenceRefusal, modOutcome) and in the inbox for a later look().
              this.lastRefusal = { ts: Date.now(), text: String(msg.error ?? "refused") };
              this.inbox.push({ ts: Date.now(), kind: "act", who: "world", text: `refused: ${msg.error}` });
            }
            break;
          case "refused":
            // the hello refused (update-required, unsupported-feature): final, said in words when the close comes (onclose 4005)
            this.joinRefused = `the world refused the join: ${refusalWords(msg)}`;
            break;
          case "mod":
            // Moderation replies (ban lists, server-ban confirmations).
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
          // Forwarded verbatim to whoever holds this identity's audio; the door
          // doesn't interpret SDP. With no sidecar attached they are dropped.
          case "relay-cred": case "sfu-offer": case "sfu-ice": case "sfu-route":
          case "voice-consent":   // the world's ack of our own receive toggle
          // A speaker's voice leg was (re)born: the media half must restate
          // consent, since the server clears it when a leg is revoked.
          case "surface-transition":
          // Both are facts ABOUT THIS IDENTITY's audio, which the media lane carries.
          // voice-service: the SFU's supervised state {state, incarnation}; the
          // incarnation says whether it RESTARTED (rejoin) or merely flapped (wait).
          case "voice-service":
          // voice-moderated: a moderator muted/unmuted someone for everyone; if
          // it's us, our audio is dropped at ingress and nothing else says so.
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
            if (msg.rights) this.flying.acceptEffectiveRights(msg.rights, "world");
            break;
          case "snapshot":
            this.briefing = null;
            this.snapshot = msg.state ? { dialect: msg.dialect, v: msg.v, world: msg.world, name: msg.name, seq: msg.seq } : null;
            // Our surface generation, issued by the server on acceptance —
            // every attest must echo it or the receipt is refused.
            if (typeof msg.gen === "number") this.surfaceGen = msg.gen;
            // WHAT THIS WORLD PERMITS THIS IDENTITY: flight reads `fly` from here
            // and nowhere else. No message leaves myRights null, which reads as no.
            if (msg.yourRights) this.flying.acceptEffectiveRights(msg.yourRights, "world");
            // a seat rides a body's pose (notePose), so the bodies' seats come back with their next poses
            this.entities.clear(); this.people.clear(); this.mounts.clear(); this.bodySeats.clear();
            // who holds what as of this cut: the holds broadcast comes only when they change, so a join reads them here
            { const h = (msg as any).holds; this.holdsNow = h && typeof h === "object" ? h : {}; }
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
            if (!(msg as any).state) { this.closed = true; clearTimeout(timeout); reject(new Error("the server sent no world snapshot (an old server?)")); break; }
            this.replica = makeReplica();
            if (!this.replica.adopt(msg)) { this.closed = true; clearTimeout(timeout); reject(new Error(`unknown-version: the world speaks ${msg.dialect} v${msg.v}; this agent reads another (D5)`)); break; }
            this.briefing = resolveBriefing(msg.briefing, this.resolveRelative ? this.httpBase + "/" : null);
            this.st.recentChat = structuredClone(msg.chat?.recentChat ?? []);
            this.st.chatTotal = msg.chat?.chatTotal ?? 0;
            for (const m of this.st.recentChat) this.senses.hearSay({ seq: m.seq ?? -1, ts: m.ts, actor: m.actor, verb: "say", args: { text: m.text } }, false);
            // the feet hold their height until the floors this join is about to learn about have been fitted —
            // before that, the only ground a body could find is the terrain under the building it is in
            this.feetSettling = true;
            await this.applyView(false, null, null);
            if (this.closed) { clearTimeout(timeout); reject(new Error("agent closed while it joined")); break; }   // bot #333 13
            void this.ground.supportReady(10_000).then(() => { this.feetSettling = false; });
            if (typeof msg.throughSeq === "number") this.lastSeq = Math.max(this.lastSeq, msg.throughSeq);
            this.joined = true; this.redial.reset();
            this.resumeWalkGate();   // a walk carried across the rejoin
            // my body's consent (two gates, two lists), as a person's client sends it on every arrival (consentsync.js):
            // read what the authority holds, send what I chose only where it differs. Never chosen: the world's default stands.
            void this.replayConsent();
            this.seatCache.init().catch(() => { /* declared-approximate until it lands */ });
            if (!this.ticker) this.ticker = setInterval(() => this.tick(), this.tickEveryMs);
            clearTimeout(timeout);
            resolve();
            break;
          case "puppet":
            // A headless agent has no renderer, so honouring a puppet means re-broadcasting it as its own presence
            // (pose → held pose; anim → re-sent as ours; ragdoll → knockDown: the real tumble, or the canned slump).
            if (msg.ragdoll) {
              // {lean:[x,y,z]} m/s says which way the shove sends them
              this.knockDown(msg.by,
                (msg.ragdoll as { lean?: number[] })?.lean ?? null,
                "knocks you over");
            }
            // posed BY someone = authored. merge: only the bones sent, over an
            // authored held pose (null releases one); otherwise the pose is theirs
            // whole, and an empty one releases. Say what the request leaves this
            // body holding, as the browser's hint does; a request with neither pose
            // nor animation says nothing.
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
            if (posed || msg.anim) this.bodyNotice(msg.by, `${posed ?? "posed you"}${msg.anim ? `${posed ? "," : ""} with an animation` : ""}`);
            break;
          case "bodydrag":
            // A renderer-backed dragger runs the physics this body can't: its stream
            // is a continuous puppet pose. Only a limp body drags; walking breaks
            // the hold; 1.2s of dragger silence returns the body to itself (tick).
            if (msg.grab != null) {
              const limp = this.clip === "ragdoll" || this.heldPose === DOWNED_POSE;
              if (!limp || this.target || (this.draggedBy && this.draggedBy !== msg.by)) {
                this.ws?.send(JSON.stringify({ type: "bodydrag", target: msg.by, end: true }));
                break;
              }
              if (this.flight) this.endFlight("drag");   // a down flight's body is the dragger's now
              this.draggedBy = msg.by; this.dragAt = Date.now();
              ++this.bodyEpoch;                    // a hand outranks any tumble still loading
              this.body?.stop(); this.stopSim();   // the dragger's sim owns the tumble now
              this.clip = "ragdoll";
              this.bodyNotice(msg.by, "takes hold of your limp body and starts dragging you");
              break;
            }
            if (msg.unpin != null) {
              // pulling one of this body's nails: the server already checked the
              // consent table (PROTOCOL §6a); the live sim lets go of that joint.
              const j = String(msg.unpin.joint ?? "");
              if (this.pins.delete(j)) this.body?.setPin(j, null);
              if (msg.end == null) break;   // an unpin can ride an end: apply the end too
            }
            if (msg.end != null) {
              if (this.draggedBy === msg.by) {
                // Explicit release carries one final authoritative sample: apply it
                // before rebuilding the sim, or it starts from a stale root.
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
                this.bodyNotice(msg.by, pa ? "nails part of you in place and steps back" : msg.reason === "out-of-reach" ? "loses hold of you: you're out of reach" : "lets go of you");
                // then MY OWN sim takes the body back: it falls from where the hand let go and settles, or hangs if nails hold it
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
              this.senses.noteOwnSay(e);
              hear(this.st, { actor: e.actor, text: x.text, ts: e.ts, seq: e.seq });   // the chat window
              this.senses.hearSay(e, true);
            }
            if (r.sky) this.senses.skyStamp = r.sky;   // who set the sky, and where in the log (I286): the value itself doesn't say
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
            this.senses.noteLeave(msg.id);
            break;
          case "avatar-updated":
            this.invalidateBodyAsset(msg.name);
            // avatar bytes changed: the held verdict demotes to pending NOW
            // and the refetch departs after the bump — a response already in
            // flight can never install the pre-change value
            this.seatCache.note(msg.name, NaN).catch(() => { /* pending names stay pending; the next event retries */ });
            break;
          case "avatar-profile-updated":
            this.seatCache.note(msg.name, Number(msg.rev)).catch(() => { /* same */ });
            break;
          case "pose":
            this.senses.notePose(msg.id, msg.pose);
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
            // same samples the browser folds into serverNow().
            this.noteServerTime((msg as { t?: unknown }).t);
            for (const [id, pose] of Object.entries(msg.poses as Record<string, Pose>)) {
              if (id !== this.name) this.senses.notePose(id, pose);
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
    forgetReadings(this.httpBase, name);
    if (nameFromAvatarPath(this.avatar) === name) {
      this.selfBodyGeneration = ++this.bodyGenerationCounter;
      this.bodyReader?.forget(this.name);
      if (this.statureFor === this.avatar) this.measureStature();
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
      ? `nothing of your body was read, since your seat can't be placed: ${effective.why}; detach gets you off it (detach {escape: true} if the seat holds you)${this.joined ? "" : " once this body has rejoined the world"}`
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
   *  (`present[].declares`) and `arrive`, or null (undeclared). Passed on as data; no kind is read from it. */
  declaresOf(who: string): string | null {
    return this.people.get(who)?.declares ?? null;
  }

  /** Every placed thing's id in the fold (the hierarchy tools walk them). */
  foldedIds(): string[] { return Object.keys(this.st.entities); }
  /** × my speed at p: a physics-volume {kind: speed} (shared/zone.js, the client's and the authority's reading), once per view */
  private physics: { st: unknown; a: any[] } | null = null;
  speedAt = (p: number[], mode?: string): number => { if (this.physics?.st !== this.st) this.physics = { st: this.st, a: physicsVolumesOf(foldOfView(this.st)) }; return speedFactorAt(this.physics.a, p, mode); };
  /** The world's level where my feet are: none in a dry pocket below it (zone.js worldLevelAt, the client's levelHere) */
  private pockets: { st: unknown; z: any; v: any } | null = null;
  levelHere(): number | null { return this.levelAt(this.pos.x, this.pos.z); }
  /** The world's level at (x, z), at my feet's height: none in a dry pocket there */
  levelAt(x: number, z: number): number | null {
    const level = this.water?.level; if (level == null) return null;
    if (this.pockets?.st !== this.st) { const zs = zonesOf(foldOfView(this.st)); this.pockets = { st: this.st, z: zs, v: waterVolumes(zs) }; }
    return worldLevelAt([x, this.pos.y, z], this.pockets.z, level, { volumes: this.pockets.v });
  }
  /** The world's half of the view (shared/protocol/view.js: sky / terrain / grass), which
   *  shared/worldentity.js reads as the world entity `@world`. */
  worldFold(): { sky: unknown; terrain: unknown; grass: unknown } {
    const s = this.st as any;
    return { sky: s.sky ?? null, terrain: s.terrain ?? null, grass: s.grass ?? null };
  }
  /** a placed copy (or one of its parts) says which blueprint it is: the authority stamps copy-of {from, key} on every
   *  part; the copy is the part whose parent isn't of the same copy */
  copyLine(id: string): string | null {
    const E = this.st.entities as Record<string, any>; const f = E[id]?.["copy-of"]?.from; if (typeof f !== "string") return null;
    const name = this.worldBlueprints()[f.replace(/^sha256:/, "")]?.name ?? f.slice(7, 19);
    let root = id; for (let i = 0; i < 64; i++) { const p = E[root]?.parent?.to; if (!p || E[p]?.["copy-of"]?.from !== f) break; root = p; }
    return root === id ? `a copy of "${name}"` : `part "${E[id]["copy-of"].key}" of ${root} (a copy of "${name}")`;
  }
  /** This world's blueprints from the fold: @world blueprints:<hash> → {name, parts?} (the authority's publish). */
  worldBlueprints(): Record<string, { name?: string }> {
    const w = this.replica?.st?.entities?.["@world"]?.c ?? {};
    const out: Record<string, { name?: string }> = {};
    for (const [k, v] of Object.entries(w)) if (k.startsWith("blueprints:")) out[k.slice("blueprints:".length)] = (v ?? {}) as { name?: string };
    return out;
  }
  /** The FOLDED record for a placed thing: every field the fold keeps (the
   *  perception view thins them), for the inspector tools; `parent` comes from
   *  the mount view, the shape shared/editschema.js expects. */
  foldRecord(id: string): Record<string, unknown> | null {
    const e = (this.st.entities as Record<string, any>)[id];
    if (!e) return null;
    const m = this.mounts.get(id);
    return m ? { ...e, parent: m } : { ...e };
  }
  /** A thing's components as this body's replica folds them now (a copy), or null: what a write planned from them pins
   *  with expect (client/lib/edit/writes.js compsOf). A purged component is the fold's REDACTED itself, not a copy: the
   *  authority's expect counts a purged value equal to nothing, so a pin has to tell one apart and leave it out. */
  componentsOf(id: string): Record<string, unknown> | null {
    const c = this.replica?.st?.entities?.[id]?.c;
    return c ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === REDACTED ? REDACTED : structuredClone(v)])) : null;
  }

  /** Reconcile the derived maps from the folded state — the ONLY writer of
   *  this.entities outside the sim stamp, and of this.mounts' logged rows (a
   *  body's seat is presence: setOccupant and AgentSenses write those). Fresh objects each
   *  pass: nothing stale survives a spawn-replace or a fold-side cascade. */
  private reconcileFromFold() {
    const seen = new Set<string>();
    for (const [id, e] of Object.entries(this.st.entities)) {
      seen.add(id);
      this.entities.set(id, {
        id,
        model: String((e as any).model ?? ""),
        pos: (e as any).pos, yaw: (e as any).yaw ?? 0,
        ...((e as any).scale != null ? { scale: (e as any).scale } : {}),
        ...(Array.isArray((e as any).scale3) ? { scale3: (e as any).scale3 } : {}),   // a stretched thing stays stretched
        ...(Array.isArray((e as any).q) ? { q: (e as any).q } : {}),
        ...(colliderOf(e) != null ? { collide: String(colliderOf(e)) } : {}),   // the collider override decide() reads: comp.collider, else the spawn's collide
        actor: (e as any).actor,
        ...((e as any).placer ? { placer: (e as any).placer } : {}),
        ...recordComponents(e as any),   // its components, flat (view.js): what a thing can DO
      });
    }
    for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.entities.delete(id);
    // a structure's cached plan goes with the structure (a re-attached one is planned afresh)
    for (const id of [...this.ground.plans.keys()]) if (!(this.entities.get(id) as any)?.structure) this.ground.plans.delete(id);
    // both mount species land in one view: entity cargo rides ent.parent (the fold),
    // bodies ride their seats (bodySeats: presence)
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

  /** A world: take the next view of this body's own fold, and act on what changed (said in the protocol's terms,
   *  shared/viewdiff.js): percepts when `live`, supports always. The first view is diffed from nothing. */
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
      // the world's water is its own component: it rides on the terrain args the ground is built from, and so do the
      // ground's named features and sculpted tiles (shared/terrainshape.js withShaping)
      const reground = ["terrain", "water", "terrainFeatures", "terrainTiles"].some((k) => d.world.includes(k));
      const feet = reground ? this.ground.heightAt(this.pos.x, this.pos.z) : 0;
      if (reground && W.terrain) { const g = withShaping(W.terrain, W.terrainFeatures, W.terrainTiles);
        await this.ground.buildTerrain(W.water ? { ...g, water: W.water } : g); }
      else if (d.world.includes("terrain")) this.ground.dropTerrain();   // the terrain is gone: the level floor, as the authority and a browser stand on it
      // someone else reshaped the ground: this body is told (its feet follow the ground without a word otherwise)
      if (live && reground) this.senses.noteGround(actor ?? "world", prev, W, this.ground.heightAt(this.pos.x, this.pos.z) - feet, ts ?? this.serverNow());
      if (d.world.includes("terrain")) { if (W.terrain) this.worldInfo.terrain = { seed: W.terrain.seed, size: W.terrain.size, amplitude: W.terrain.amplitude, flatRadius: W.terrain.flatRadius }; else delete this.worldInfo.terrain; }
      if (d.world.includes("sky")) this.senses.skyState = W.sky as typeof this.senses.skyState;
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
        if (live && now?.particles != null) { const fx = this.eff(id, this.serverNow()); if (fx.ok) this.senses.noteEmitter(actor, id, null, now.particles, fx.pos, ts); else { this.noteEffGap(id, fx.why); this.noteBuild(actor, now?.pos); } }
        else if (live) this.noteBuild(actor, now?.pos);
        this.ground.trackSupport(this.ground.syncSupport(id));   // a placed thing is a thing bodies can rest on
        if (this.mounts.has(id)) this.ground.dropSupport(id);   // …unless it rides a parent (it collides as the parent)
        break;
      case "pose":
        if (live) this.noteBuild(actor, now?.pos);
        this.ground.trackSupport(this.ground.syncSupport(id));   // support follows the thing it belongs to
        break;
      case "gone":
        // …and removing a burning thing puts its emitter out
        if (live && was?.particles != null) this.senses.noteEmitter(actor, id, was.particles, null, was?.pos, ts);
        else if (live) this.noteBuild(actor, was?.pos);
        this.ground.dropSupport(id);
        break;
      case "parent":
        if (this.mounts.has(id)) this.ground.dropSupport(id); else this.ground.trackSupport(this.ground.syncSupport(id));
        break;
      case "comp":
        // an emitter beginning, changing or ending is something you SEE happen; gated on where it actually is
        if (comp === "particles" && live) {
          const fx = this.eff(id, this.serverNow());
          if (fx.ok) this.senses.noteEmitter(actor, id, was?.particles ?? null, now?.particles ?? null, fx.pos, ts);
          else this.noteEffGap(id, fx.why);
        }
        // a motion moves its support, a collider override changes its policy, and a structure set or removed decides whether it is only an anchor
        if (comp === "motion" || comp?.startsWith("motion:") || comp === "collider" || comp === "structure") this.ground.trackSupport(this.ground.syncSupport(id));
        break;
    }
  }

  /** The standing height the water is measured against: the current body's, once measured; until then an
   *  ordinary adult's (the measurement is one small read of the avatar's header). */
  stature(): number { return this.bodyH ?? STATURE_FALLBACK; }
  /** Measure the current body's height (rigbones.ts bodyHeightFor), guarded by generation so a slow reply
   *  for a body since replaced is never applied; a known height stands meanwhile (setAvatar clears it). A failed
   *  download is tried again when the terrain next settles. Resolves once this measurement is settled. */
  measureStature(): Promise<void> {
    const gen = ++this.statureGen, avatar = this.avatar;
    this.statureFor = avatar;
    return bodyHeightFor(this.httpBase, avatar).then((h) => {
      if (gen === this.statureGen) this.bodyH = h ?? STATURE_FALLBACK;
    }, () => {
      if (gen === this.statureGen) { this.bodyH ??= STATURE_FALLBACK; this.statureFor = null; }
    });
  }
  /** Leave the floating column: the next float starts from wherever the body then is. */
  endFloat() { this.float = { on: false, y: 0, vy: 0 }; }

  /** This world's water for the ragdoll sim (physics.ts setWaterField) — asserted before every run, like the
   *  ground, because the sim module is process state and one process can host agents in several worlds. */
  waterFieldNow() {
    const A = this.waterKinds, level = this.water?.level;
    if (!A || level == null) return null;
    if (this.waterFieldMemo?.A !== A || this.waterFieldMemo.f.level !== level)   // read every physics step: build it once
      this.waterFieldMemo = { A, f: { level, sample: (x: number, z: number) => A.sample(x, z), time: () => waveClock(this.serverNow()) } };
    return this.waterFieldMemo.f;
  }
  private waterFieldMemo: { A: unknown; f: { level: number; sample: (x: number, z: number) => unknown; time: () => number } } | null = null;
  // the ground: terrain, floors, and the collision meshes a body stands on: mcpl/agent-ground.ts
  readonly ground = new AgentGround(this);
  heightAt(x: number, z: number) { return this.ground.heightAt(x, z); }
  worldBox() { return this.ground.worldBox(); }
  groundAt(...a: Parameters<AgentGround["groundAt"]>) { return this.ground.groundAt(...a); }
  modelBox(lib: string) { return this.ground.modelBox(lib); }
  modelMetaOf(lib: string) { return this.ground.modelMetaOf(lib); }
  /** A pre-join refusal's words, until its close says whether it is final (onclose). */
  private joinRefused: string | null = null;
  /** How long until the next dial after a drop or a full world (shared/redial.js: the browser's rule); reset by a join. */
  private redial = redialer();
  private removedUntil: number | null = null;   // a moderation removal's end (a timed ban's until): reconnect then

  /** Every collider query a tick makes is about this agent's own world. */
  private tick() { inWorld(this.world, () => this.tickInWorld()); }
  private respawning = false;
  /** Back to fallBackOf's place, if any, after a fall out of the world (shared/spawn.js), the reason on the record (move teleport). */
  async respawnFell() {
    const sp = this.replica?.st ? fallBackOf(this.replica.st) : null; if (!sp) return;
    this.respawning = true;
    try {
      this.abandonWalk(); if (this.flight) this.endFlight("respawn"); this.endFloat(); this.vy = 0; this.grounded = true;   // the walk's promise ends now, not at its timeout
      if (this.clip === "ragdoll" || (this.heldPose && !this.heldPoseAuthored)) {
        ++this.bodyEpoch; this.body?.stop(); this.stopSim(); this.pins.clear();
        if (!this.heldPoseAuthored) this.heldPose = null;
        this.clip = "idle";
      }
      this.pos.x = sp.pos[0]; this.pos.y = sp.pos[1]; this.pos.z = sp.pos[2]; this.yaw = sp.yaw;
      const r = await this.request("move", { to: sp.pos, teleport: true, reason: FELL });
      if (r?.ok) { this.trackAt = [...sp.pos]; this.trackArrived = true; }
      this.lastWalkNote = `you fell below this world's bounds: you are back at its arrival place (${sp.pos.map((n: number) => n.toFixed(1)).join(", ")})${r?.ok ? "" : `, though the authority said ${r?.refused?.code ?? "nothing"}`}`;
    } finally { this.respawning = false; }
  }
  // ---------------- anim: one way to play a pose or a clip, by name or live ----------------
  /** The anims this body plays or holds now, when they last (mode loop or hold), oldest first; a once anim ends by itself,
   *  silently. Each is a LAYER: a clip (held as the presence clip), the named pose wings-folded, a held frame of live
   *  keys (joints, or tracks in mode hold: the held pose), or live tracks looping (relayed to every client). A new one
   *  replaces only the one in its own layer: a pose struck over a sit leaves the sit playing. */
  anims: { name: string; mode: "loop" | "hold"; kind: "clip" | "pose" | "live" | "track"; clip?: string; bodyMode?: string }[] = [];
  /** The newest of them (or null). */
  get anim() { return this.anims.at(-1) ?? null; }
  /** The body-mode: stand | sit | lie | swim | fly | fall, every one declarable for looks (anim {bodyMode}; an anim may
   *  ask for one, as the built-in sit and lie do, and its end by a move, another anim or a fall returns to stand; anim
   *  {stop} leaves it as it is); the mover's real transitions (flight, water) set it and end a declaration. Published as
   *  presence bodyMode (bodyModeNow). A self-declared description: it grants nothing (take-off still wants fly). */
  modeTracker = bodyModeTracker();
  get bodyMode() { return this.modeTracker.declared ?? "stand"; }
  set bodyMode(m: string | null) { this.modeTracker.declare(m === "stand" ? null : m); }
  /** A flight in the air: one LANDED or on the GROUND is ended by the tick that sees it (endFlight). */
  airborne() { return !!this.flight && this.flight.phase !== "GROUND" && this.flight.phase !== "LANDED"; }
  /** The mode this body publishes now: a declaration, else the mover's (fly, swim, stand); on a station, sit. */
  bodyModeNow() { const m = this.modeTracker.step({ flying: this.airborne() && this.clip !== "ragdoll", swimming: this.clip === "swim" || this.clip === "tread", falling: this.aloft() }); return m === "stand" && this.myOccupancy ? "sit" : m; }
  /** The clip a sit at rest plays: the last sitting anim's (sitchair keeps the chair's height), else sit. */
  private sitRest = "sit";
  /** A body-mode's own resting anim: stand → idle, sit → the sit loop, lie → lie, swim → tread, fly →
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
  /** Start an anim that lasts: the one in its own layer before it ends with why "replaced" (a once overlays). */
  animBegan(a: WorldAgent["anims"][number], holdAt: number | null = null) {
    this.animEnded("replaced", (b) => b.kind === a.kind);
    this.anims.push(a); if (a.bodyMode && isBodyMode(a.bodyMode)) { this.bodyMode = a.bodyMode; if (a.bodyMode === "sit" && a.clip) this.sitRest = a.clip; }
    if (a.kind === "clip") this.animHold = a.mode === "hold" ? holdAt : null;
  }
  /** anim {stop}. which null: every anim this body plays or holds, each layer, and any held pose; then the CURRENT
   *  body-mode's own resting anim plays (restClip; never the bind pose) and the body-mode is unchanged (to stand up,
   *  declare stand or walk). A name: only that layer; "live" names every ad-libbed one (joints, tracks). Returns what
   *  was stopped (empty: nothing by that name was playing, which is a note, not an error). */
  async stopAnims(which: string | null): Promise<string[]> {
    const hit = this.anims.filter((a) => which == null || a.name === which);
    this.animEnded("stopped", (a) => hit.includes(a));
    const kinds = new Set(hit.map((a) => a.kind));
    if (which == null || kinds.has("live")) { if (this.heldPose && (which == null || this.heldPoseAuthored)) this.setPose(null); }
    if ((which == null || kinds.has("track")) && this.joined && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "anim", stop: true }));
    // folding the wings open waits for the bones: a walk (it bumps bodyEpoch) or an anim begun meanwhile keeps its clip
    const epoch = this.bodyEpoch, before = new Set(this.anims);
    if ((which == null || kinds.has("pose")) && this.wingsFolded) await this.foldWings(false);
    // …a tracks loop plays in its own layer and takes no clip, so one begun meanwhile doesn't
    const newer = this.bodyEpoch !== epoch || this.anims.some((a) => !before.has(a) && a.kind !== "track");
    if ((which == null || kinds.has("clip")) && !newer) {
      if (this.clip === "ragdoll") this.setPose(null);   // a slump ends in the rest too (setPose stands it, and stops its sim)
      const rest = this.restClip(this.bodyModeNow()); if (rest) { this.stop(); this.clip = rest; }
    }
    return hit.map((a) => a.name);
  }
  /** Every tick: an anim that lasts ends when what holds it is gone (a walk took the clip, a ragdoll, a clear, the wings
   *  opened), with why: moved, knocked over, cleared, replaced, stopped. */
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
    // a heightmap terrain waiting on its grid: ask again (requestGrid backs off by itself), and build the
    // waiting bag — only if it is still the newest — the moment the grid is here
    const pend = this.ground.pendingTerrain;
    if (pend && pend.rev === this.ground.terrainRev) {
      void requestGrid(pend.grid).then((g) => {
        if (g && this.ground.pendingTerrain === pend && pend.rev === this.ground.terrainRev) { this.ground.pendingTerrain = null; void this.ground.buildTerrain(pend.args); }
      });
    }
    // a heightmap world's engine waits for its grid (as the browser's does, thingphysics.js): noise ground would diverge
    const simShape = this.replica?.sim?.sim?.terrain?.shape;
    const simReady = shapeReady(simShape);
    if (!simReady && simShape.heightmap) void requestGrid(simShape.heightmap.grid);   // (a sculpted layer not held yet is named when this body's own ground is built)
    // The world's physics (@world.physics-engine): stamp where each flying thing IS into the entity view (replica.js
    // simAt, the state every renderer draws), so look() sees a punted crate where it is. Support rebuilds at rest.
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
          if (e) this.ground.trackSupport(this.ground.syncSupport(id));
        } else if (!b.resting && !this.simFlying.has(id)) { this.simFlying.add(id); this.simRested.delete(id); this.ground.dropSupport(id); }   // a flying thing holds nobody up
        if (b.resting) this.simFlying.delete(id);
      }
    }
    // ambient sky perception rides the body tick at 1Hz — cheap (cursor keeps
    // it O(1)) and quiet (emits only on segment/override/day-phase boundaries)
    if (Date.now() - this.senses.lastSkyCheck >= 1000) {
      this.senses.lastSkyCheck = Date.now();
      this.checkSky();
    }
    // Being dragged: the dragger's stream owns pos/pose/yaw (no walking, no
    // terrain clamp). A silent dragger loses the body, which my own sim settles from its last pose (settleFromDrag;
    // with no sim it holds that pose).
    if (this.draggedBy && Date.now() - this.dragAt > DRAG_SILENCE_MS) {
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
      // ONE stride of the shared mover (shared/mover.js), the same stride the client takes and the authority checks.
      // The floor is the walk's admitted support (walkHeightAt, else the live terrain); what blocks is the authority's
      // permit, asked above, and the route the walk was planned on (walkTo).
      const walkFloor = this.walkHeightAt ?? ((x: number, z: number) => this.heightAt(x, z));
      // with the colliders loaded the floor is what the feet will find (colliders.resolveColliders: placed floors and
      // stairs within the mover's step, else the walk's floor) — the same answer the collider pass below gives the stride
      const colliding0 = collidersReady() && !this.myOccupancy && !this.feetSettling;
      const floorAt = colliding0 ? (x: number, z: number, y?: number) => this.feetAt(x, z, y ?? this.pos.y, walkFloor) : walkFloor;
      // WATER (upstream #242) is the mover's too: handed the world's level (env.waterAt, asked per point: a dry pocket's
      // edge) and this body's measured stature, the stride wades (dragged) or swims (afloat at the chest) — no water arithmetic here.
      const wl = this.levelHere(), wet = this.water?.level != null;
      // feet on the live ground BEFORE the stride: terrain that loads late or changes under the walker lifts the body here,
      // so the mover judges a ledge AHEAD against where the feet now stand (colliding, the feet below do this themselves)
      if (!colliding0 && !this.flight && !this.draggedBy && this.pins.size === 0) { const g0 = floorAt(this.pos.x, this.pos.z); if (Number.isFinite(g0) && (wl == null || g0 >= wl)) this.pos.y = g0; }
      const r = walkToward({ pos: [this.pos.x, this.pos.y, this.pos.z], target: [T.x, T.z], dt, run: T.run, tolerance: T.tolerance ?? MOVER.arrive.tolerance, room,
        ...(wet ? { height: this.stature() } : {}) },
        wet ? { floorAt, waterAt: (x: number, z: number) => this.levelAt(x, z), speedAt: this.speedAt } : { floorAt, speedAt: this.speedAt });
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
        // 90 s and reporting "interrupted or timed out"
        this.walkStopReason = r.blocked.by === "ledge" ? `a ledge ${Number.isFinite(r.blocked.top) ? `${(r.blocked.top - this.pos.y).toFixed(2)} m` : ""} too high to step onto at (${this.pos.x.toFixed(2)}, ${this.pos.z.toFixed(2)})` : `blocked by ${r.blocked.by}`;
        this.target = null; this.legs.length = 0; this.walkHeightAt = null; this.walkGate = null; this.speed = 0;
        this.clip = r.stance?.swimming ? "tread" : "idle";
        this.walkDone?.(false); this.walkDone = null;
      } else {
        this.speed = r.moved > 0 ? r.moved / dt : 0; this.clip = r.stance?.swimming ? "swim" : T.run ? "run" : "walk";
        if (r.yaw !== null) this.yaw = r.yaw;
        // the stride's horizontal move; the feet below carry it out (against the fitted colliders when they are loaded)
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
    // with the collision modules loaded, the feet are the browser controller's (client/lib/player/controller.js): the mover's
    // stride above, then colliders.resolveColliders (standOn) pushes the capsule out of anything solid and answers the
    // ground under it (a stair tread within the mover's step, a floor below, else terrain); the body snaps onto it or
    // falls toward it. Seated, or just joined, the feet keep the floor they last stood on.
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
    if (!colliding && this.aloft()) {
      // Falling (aloft): stepFeet's gravity, by hand where it doesn't run (no colliders loaded, or a slump with no sim).
      const lift = this.feetY(this.isSlumped()) - this.pos.y, canned = this.rootCanned();
      const g = this.feetAt(this.pos.x, this.pos.z, this.pos.y + lift, terrainG), wl = this.levelHere();
      this.vy -= GRAVITY * dt; this.pos.y += this.vy * dt;
      if (this.pos.y + lift <= g) this.pos.y = g - lift;
      if (this.pos.y + lift <= g || (wl != null && this.pos.y + lift <= wl)) { this.vy = 0; this.grounded = true; }
      if (canned) this.cannedY = this.pos.y;   // a canned slump keeps its root at its feet as it falls
      if (!this.grounded) groundY = null;   // aloft: no stance yet
    }
    // A walk waiting out the fall goes on once the feet are down; something else taking the body ends it.
    if (this.landWaits.length && !this.aloft()) { if (this.held()) this.abandonWalk(FALL_TAKEN); else this.landed(); }
    if (groundY != null) {
      const wl = this.levelHere();
      if (wl != null) {
        // feet on the bed, or floating with the chest at the surface; a body standing still out of its
        // depth treads water
        const st = waterStance(wl, groundY, this.stature());
        if (st.swimming) {
          // float on the moving surface, the browser's law and clock (controller.js does the same)
          if (!this.float.on) { this.float = { on: true, y: colliding ? yBefore : this.pos.y, vy: 0 }; }
          if (colliding) this.vy = 0;   // afloat, the feet's own fall is not running
          const t = waveClock(this.serverNow()), level = wl, A = this.waterKinds;
          const surf = footprintSurface((x, z) => level + surfaceOffset(A?.sample(x, z) ?? null, x, z, t), this.pos.x, this.pos.z);
          floatStep(this.float, surf, this.stature(), dt, groundY);
          this.pos.y = this.float.y;
        } else { this.endFloat(); if (!colliding) this.pos.y = st.y; }   // colliding: stepFeet already stood (or dropped) the feet
        if (st.swimming && !this.target && (this.clip === "idle" || this.clip === "walk" || this.clip === "run" || this.clip === "swim")) this.clip = "tread";
        else if (!st.swimming && (this.clip === "tread" || this.clip === "swim")) this.clip = this.target ? "walk" : "idle";
      } else { this.endFloat(); if (!colliding) this.pos.y = groundY; }
    } else if (!feetFree) this.endFloat();   // a ragdoll, a drag, a nail or a flight has the body: a later float starts afresh
    // FLIGHT: one fixed-step integration of shared/flight.js per tick (the same
    // function the browser bench runs); the body's position is whatever it says.
    // ONE AUTHOR PER POSITION: once the ragdoll owns the body (simTicker), the
    // flight integrator stops writing pos. The flight state stays alive for recovery.
    if (this.flight && !this.simTicker) this.flying.flightTick(dt);
    // KILLZ (shared/spawn.js): fallen below the kill line under @world.bounds.min.y, back to an arrival place, on the record
    if (!this.myOccupancy && !this.draggedBy && !this.respawning && belowWorld(this.replica?.st, [this.pos.x, this.killzY(), this.pos.z])) void this.respawnFell();
    // keep the `reached` attestation honest at ~2Hz while reaching: the
    // target moves, this body moves, and the far end's touch event fires on
    // the rising edge of what is re-checked here
    if (this.reaches.size && ++this.reaching.reachTicks % 5 === 0) this.reaching.reachTick();
    this.selfObservedAt = Date.now();
    this.noteClipClock();
    this.ws?.send(JSON.stringify({
      type: "pose",
      pose: {
        p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, speed: this.speed, clip: this.clip, bodyMode: this.bodyModeNow(), clipTime: this.animHold ?? this.clipPhase(), clipTimeSlot: this.bodyClip(), clipRate: this.animHold != null ? 0 : 1,
        ...wingFoldPresence(this.wingsFolded),
        // a physics bag only ever leaves this process labelled "ragdoll", so every
        // clip-keyed sanitizer downstream can see it (see heldPoseAuthored).
        ...(this.heldPose && (this.heldPoseAuthored || this.clip === "ragdoll") ? { pose: this.heldPose } : {}),
        ...(this.pins.size ? { pins: [...this.pins].map(([j, at]) => ({ j, at })) } : {}),
        // a canned slump's root is at its feet, so it lies on that floor; server.ts settledPose would raise any other root
        ...(this.clip === "ragdoll" && this.rootCanned() ? { floor: this.pos.y } : {}),
        ...(this.pendingAnim ? { anim: this.pendingAnim } : {}),
        ...(this.reaches.size ? { reach: Object.fromEntries(this.reaches) } : {}),
        ...(this.myOccupancy ? { seat: this.myOccupancy } : {}),
      },
    }));
    this.pendingAnim = null; // one-shot: rides exactly one packet
  }

  /** Another body did something to mine: an act from them, in the inbox and to the host (`* who text`), never their speech. */
  private bodyNotice(who: string, text: string) {
    const ts = Date.now(); this.inbox.push({ ts, kind: "act", who, text }); this.onEvent?.({ ts, kind: "act", who, text });
  }
  /** The real tumble (physics.ts HeadlessBody), the canned slump only when the sim can't serve. Consent was judged before
   *  this is called: by the authority, or the server's relay. */
  knockDown(by: string, lean: number[] | null, notice: string) {
    if (this.draggedBy) return;   // consent is the authority's: a shove my table refuses never reaches me (it sends the table on join)
    if (this.flight) this.endFlight("knockdown");   // the tumble owns the body from here, aloft or not (#298)
    // knocked over standing, the root is at the feet's height until something
    // lifts or lowers it; a body already down keeps the reading its root has
    if (!this.isSlumped()) this.cannedY = this.pos.y;
    if (this.target) { this.walkDone?.(false); this.walkDone = null; this.target = null; this.legs = []; this.walkHeightAt = null; this.walkGate = null; }
    if (this.landWaits.length) this.abandonWalk(FALL_TAKEN);   // and one waiting out a fall
    this.speed = 0;
    // Down NOW, not when the physics finishes loading: tumble() awaits the
    // skeleton, height field and support barrier, and a body still reporting
    // "idle" meanwhile would refuse a drag. The canned slump holds the shape
    // until the sim produces a real pose.
    // A fall starts from the pose the body is drawn in (a kneel falls from
    // kneeling height): this is what it held when the blow landed.
    const held = this.heldPose;
    this.clip = "ragdoll";
    this.heldPose ??= DOWNED_POSE;
    this.reaches.clear();   // a knocked-over body's reach is gone: the arms are the ragdoll's now
    this.bodyNotice(by, notice);
    void this.tumble(lean, held);
  }

  async ensureBody(): Promise<HeadlessBody | null> {
    if (this.body !== undefined) return this.body;
    this.body = await HeadlessBody.create(this.httpBase, this.avatar);
    if (this.body) this.body.waterSource = () => this.waterFieldNow();   // its own world's water, always
    if (this.body) this.body.scope = this.world;
    return this.body;
  }

  /** Whose turn it is to drive this body. tumble() and settleFromDrag() await
   *  real latency, and the world moves meanwhile (a drag can start and end
   *  while a knockdown waits on /geom). Every act that takes authority over the
   *  body bumps this; a suspended act that finds it changed abandons itself. */
  bodyEpoch = 0;

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
    await this.ground.supportReady();    // don't fall through a floor still in flight
    if (this.bodyEpoch !== epoch || this.draggedBy) return;
    body.begin({
      x: this.pos.x, z: this.pos.z,
      yaw: this.yaw,
      // no direction given = the browser default: you fall the way you face
      lean: lean ?? [Math.sin(this.yaw) * 0.9, 0, Math.cos(this.yaw) * 0.9],
      // What the body holds now (a pose given or released while the fall waited
      // counts); the blow's own canned slump defers to what it held before.
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
    // A release can land while a join's replayed spawns are still fetching
    // geometry: wait, or the body settles through a platform the log knows.
    await this.ground.supportReady();
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

  /** The tumble's own clock: browser-parity 15Hz stepping and streaming. The
   *  10Hz main tick keeps running and just re-streams the sim's latest truth. */
  startSim() {
    if (this.simTicker) return;
    this.simTicker = setInterval(() => {
      const body = this.body;
      if (!body?.active || this.draggedBy) { this.stopSim(); return; }
      // A LIMP FALL IS AERODYNAMIC: push the air onto every body before each sim
      // step (the falling leaf as forces on the real ragdoll, not a curve).
      if (this.flight?.wings === "LIMP" && this.pos.y > 0.4) {
        this.leafT += 1 / 15;
        body.applyLeaf?.(this.leafCfg, this.leafT);
      }
      const out = body.step(1 / 15);
      if (!out) return;
      this.heldPose = out.pose; this.heldPoseAuthored = false; // a sim frame is physics even once settled
      this.pos.x = out.p[0]; this.pos.y = out.p[1]; this.pos.z = out.p[2];
      if (Number.isFinite(out.hipsY)) this.hipsAboveRoot = out.hipsY - out.p[1];
      this.tick();
      // The ragdoll's ground truth flows BACK into the flight state, rather
      // than the flight state overwriting it. Recovery reads this to know
      // where it is waking up.
      if (this.flight) {
        this.flight.pos.x = out.p[0]; this.flight.pos.y = out.p[1]; this.flight.pos.z = out.p[2];
        if (this.flight.phase === "LEAF" && out.done) this.flight.phase = "RAGDOLL";
      }
      if (out.done) { this.stopSim(); this.grounded = true; this.vy = 0; }   // captured: the held pose IS the outcome, on what holds it
    }, 66);
  }
  stopSim() {
    if (this.simTicker) { clearInterval(this.simTicker); this.simTicker = null; }
  }

  // ---------------------------------------------------------------- flight
  //
  // A flying body owns its own position, as a walking one does: the integrator
  // runs HERE, at the tick rate (the spec's authority model: one deterministic
  // function, the server's verb-receipt timestamps as tie-breaker). A sortie is
  // just takeOff, climbTo, glideTo called in turn.

  /** null when not flying. Holds the integrator's state between ticks. */
  flight: any = null;
  flightCfg: any = null;
  flightCap: any = null;
  /** The server's per-world grant for this identity ({role, gen, fly}).
   *  Null until a snapshot arrives, and null means no. */
  myRights: any = null;
  /** The vigil posture, mirrored for anything that renders this body. */
  wingsFolded = false;

  /** Bone names of the worn body, for the capability's rig check; null
   *  while they aren't known: until the worn model has been read, after a
   *  read failed, and from an avatar change until the new body is read. */
  bodyBoneNames: string[] | null = null;
  private bodyBonesFor: string | null = null;

  /** Read the worn VRM's bone list, once per avatar. A failed read keeps
   *  nothing (still unknown); a read landing after an avatar change is dropped. */
  async loadBodyBones(): Promise<string[] | null> {
    const avatar = this.avatar;
    if (this.bodyBoneNames && this.bodyBonesFor === avatar) return this.bodyBoneNames;
    try {
      const res = await fetch(`${this.httpBase}/library/${avatar}`, { signal: AbortSignal.timeout(WORLD_READ_MS) });
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

  /** Seconds since the leaf began -- the phase clock for the flutter torque. */
  leafT = 0;
  /** Air model for the limp fall. Config, like everything else in flight. */
  leafCfg: any = { ...LEAF_FORCE };
  // flight: take-off, the autopilot's courses, landing, and every way down: mcpl/agent-flight.ts
  readonly flying = new AgentFlight(this);
  endFlight(why: FlightEnd) { return this.flying.endFlight(why); }
  takeOff() { return this.flying.takeOff(); }
  foldWings(fold: boolean) { return this.flying.foldWings(fold); }
  glideTo(x: number, z: number, took?: { course?: number; got?: string }) { return this.flying.glideTo(x, z, took); }
  climbTo(alt: number) { return this.flying.climbTo(alt); }
  landAt(x: number, z: number) { return this.flying.landAt(x, z); }
  flightBodyDown(eventId: string) { return this.flying.flightBodyDown(eventId); }
  flightBodyRecovered(eventId: string, recoveryGeneration?: string) { return this.flying.flightBodyRecovered(eventId, recoveryGeneration); }
  flightStatus() { return this.flying.flightStatus(); }

  /** The ground a walk's navgrid probe stands on: the terrain, or on a floor
   *  walk the walk's own floor at its height, wherever that level has floor and
   *  the ground is no more than NAV_STEP above it; everywhere else is a drop the
   *  grid won't take (a floor walk's feet never go below its floor). Where the
   *  ground rises more than a step above the floor, the floor is buried. Placed
   *  tops count as on the ground (navProbe), but none lower than the floor
   *  (onOrAboveFloor). */
  private walkProbeGround(support: WalkSupport): (x: number, z: number) => number {
    if (support.kind !== "floor") return (x, z) => this.heightAt(x, z);
    const drop = support.height - 2 * NAV_STEP;
    // The walk's floor, placed as walkSupport found it a moment ago.
    const e = this.entities.get(support.entity)!, plan = this.ground.planFor(e.id, recordComponents(e).structure), lv: any = plan.levels[support.level];
    const fx = this.eff(e.id, this.serverNow());
    if (!fx.ok) return () => drop;   // as storeyUnder passes over a building it can't place
    const sc = fx.scale > 0 ? fx.scale : 1, place = { pos: fx.pos, yaw: fx.yaw, scale: sc };
    return (x, z) => {
      const [lx, , lz] = localizePoint(place, x, 0, z);
      return floorAtLocal(plan, lv, lx, lz) && this.heightAt(x, z) - support.height <= NAV_STEP ? support.height : drop;
    };
  }

  /** What the feet stand on for a walk from here: the upper storey of a
   * griddled building under them (storeyUnder), which walkTo's floor branch
   * serves, else the terrain. `yHint` is the feet's height (feetY), which for a
   * body a sim has laid down is RAGDOLL_ROOT_DROP above its root. */
  private walkSupport(yHint = this.pos.y): WalkSupport {
    const floor = this.ground.storeyUnder(this.pos.x, this.pos.z, yHint);
    return floor ? { kind: "floor", ...floor } : { kind: "terrain", height: this.heightAt(this.pos.x, this.pos.z) };
  }

  /** Every known structure as a walk sees it: placed where it is now, and
   * prepared against the walk's support. One whose place, plan or geometry
   * can't be read has no walls to check against: it is skipped for every walk,
   * and the operator's log says so once per component revision. */
  private walkStructures(support: WalkSupport): WalkStructure[] {
    const nowMs = this.serverNow(), out: WalkStructure[] = [];
    for (const e of this.entities.values()) {
      const data = bodyStructure(e);   // one whose collision is off for bodies has no wall to route around (storeyUnder's rule)
      if (!data) continue;
      const skip = (why: string) => {
        if (typeof data !== "object") return;
        const key = this.name + "\0" + e.id, json = JSON.stringify(data);
        if (UNPLANNABLE_LOGGED.get(key) === json) return;
        UNPLANNABLE_LOGGED.set(key, json);
        console.warn(`[${this.name}] move skips structure [${e.id}], which can't be checked: ${why}`);
      };
      // Where it is now, carried or moving included, as every other spatial
      // claim reads it: not its rest pose.
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
        const plan = this.ground.planFor(e.id, data);
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
   * leg when none offers a detour, else the shortest offered detour the others
   * clear too (local planning, not a multi-building search). A refusal names
   * each structure's reason. */
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
   * none. A body standing in a wall first steps out to the nearest clear point
   * within half a metre and is routed from there. */
  private planWalk(to: Vec2, support: WalkSupport): { legs: Vec2[] } | { refusal: string } {
    const structures = this.walkStructures(support), from = { x: this.pos.x, z: this.pos.z };
    if (structures.every((s) => s.clear(from, from))) {
      const route = this.routeFrom(from, to, structures);
      return "refusal" in route ? route : { legs: route.points.slice(1) };
    }
    for (const r of STEP_OUT_METRES) {
      // A step's sides: the clear directions a step from just off the wall reaches
      // without crossing it; each run of them is one side, planned from its middle.
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

  /** `y`, when given, picks the floor at the destination: the place to stand nearest that height, no more than a step
   *  above it. Without it, the body's own storey if the destination has a floor within a step of it, else the lowest
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
    if (this.walkDone || this.target || this.landWaits.length) this.abandonWalk();
    this.walkRefusal = null;
    this.lastWalkRefusal = null; this.lastWalkNote = null; this.walkStopReason = null;
    const ticket = ++this.walkTicket;
    let left = () => timeoutMs;   // the walk's time; asked aloft, the fall spends from it (one deadline, below)
    const now = () => {
      const p = this.walkNow(x, z, run, left(), tolerance, y, near);
      if (receipt) receipt.refusal = this.walkRefusal;   // set synchronously by the plan
      return p;
    };
    // Placed things whose geometry is still on its way aren't solid here yet:
    // the walk waits for every pending sync (new ones included), and is refused
    // if they don't land in time, never walked on the terrain underneath.
    const ready = () => {
      if (!this.ground.supportPending.size) return now();
      return this.ground.supportReady(WALK_READY_MS).then(() => {
        if (ticket !== this.walkTicket) {   // stopped, or another walk asked for, meanwhile
          if (receipt) receipt.refusal = "superseded by a newer walk or a stop";
          return false;
        }
        if (this.ground.supportPending.size) {
          this.walkRefusal = GEOMETRY_LOADING;
          if (receipt) receipt.refusal = GEOMETRY_LOADING;
          return false;
        }
        return now();
      });
    };
    // No walking in mid-air (R 11-10): asked with the feet off the ground, the walk takes the body from the flight (or
    // the tumble) holding it there now, refused later or not; the body falls (aloft), and the walk is planned from where
    // it lands.
    if ((this.flight ? this.airborne() : !this.grounded) && this.feetOffGround()) {
      if (this.flight) this.endFlight("walk");
      if (this.simTicker) { ++this.bodyEpoch; this.body?.stop(); this.stopSim(); }
    }
    if (!this.aloft()) return ready();
    let timedOut = false;
    const asked = Date.now(); left = () => timeoutMs - (Date.now() - asked);
    const giveUp = setTimeout(() => { if (ticket === this.walkTicket) { timedOut = true; this.abandonWalk(); } }, timeoutMs);
    return new Promise<string | undefined>((res) => this.landWaits.push(res)).then(async (why) => {
      clearTimeout(giveUp);
      if (timedOut) { this.walkStopReason = "timed out falling: the body hadn't come down within the walk's time"; return false; }
      if (ticket !== this.walkTicket) {
        if (receipt) receipt.refusal = why ?? "superseded by a newer walk or a stop";
        return false;
      }
      const ok = await ready();
      if (!ok && receipt?.refusal) receipt.refusal += " (asked in the air, the body fell to the ground first)";
      return ok;
    });
  }

  /** The walks waiting out a fall (aloft), told when it ends, and why when it isn't by landing. */
  private landWaits: Array<(why?: string) => void> = [];
  /** Something other than the feet has the body: a flight, a seat, a drag, a nail, a sim, or a join's settling. */
  private held() {
    return !!this.flight || !!this.myOccupancy || !!this.draggedBy || this.pins.size > 0 || !!this.simTicker || this.feetSettling;
  }
  /** Feet off the ground with nothing holding them: falling under GRAVITY (tickInWorld; stepFeet with the colliders
   *  loaded). A walk asked waits for the ground; a take-off is refused. */
  aloft() { return !this.grounded && !this.held() && this.feetOffGround(); }
  /** The feet above what holds them up: the colliders' floor where loaded (feetAt), else the storey or terrain, or the
   *  water's surface, where a body floats. */
  feetOffGround() {
    const feet = this.flight && !this.simTicker ? this.pos.y : this.feetY(this.isSlumped());   // a flight's position is its feet
    const wl = this.levelHere();
    return feet > Math.max(this.feetAt(this.pos.x, this.pos.z, feet, this.standingGround()), wl ?? -Infinity) + 0.02;
  }
  /** The fall is over: the walks waiting on it go on. */
  private landed() {
    const waits = this.landWaits; this.landWaits = [];
    for (const w of waits) w();
  }

  /** Bumped by every walk request and every abandon: a walk waiting for
   *  geometry knows when it has been superseded. */
  private walkTicket = 0;

  private walkNow(x: number, z: number, run: boolean, timeoutMs: number, tolerance: number, y: number | undefined,
    near: Pick<NavTarget, "reach" | "above" | "below" | "inside"> & { bodyAt?: { x: number; z: number } }, replanned = false): Promise<boolean> {
    // Plan before touching the body, from the ground under it (as setPosture's
    // feetGround): a walk refused here leaves the body as it was and sends nothing (walkTo has already taken a
    // mid-air body out of its flight; a refusal from the first track comes after the flight, drag and nails are let go).
    const slumped = this.isSlumped();
    const feetY = this.feetY(slumped);
    const support = this.walkSupport(feetY);
    const plan = this.planWalk({ x, z }, support);
    if ("refusal" in plan) { this.walkRefusal = plan.refusal; return Promise.resolve(false); }
    // A walk from a floor stays on it: griddled storeys have no stairs between
    // them or to the ground. So a destination whose height means another floor
    // there (floorMeant, with the destination's bounds) is refused here, after
    // the router plans and before the navgrid routes, rather than walked to at
    // the same x, z on this floor. Unless something placed on this floor (under
    // the next one up) stands at about that height (placedNear): then the walk
    // goes. A named destination's height and bounds are the world's (a person's
    // floor is the one their body is on).
    if (support.kind === "floor" && y != null) {
      const at = near.bodyAt ?? { x, z };
      const meant = this.ground.floorMeant(at.x, at.z, y, near, support, near.bodyAt != null);
      const ceiling = Math.min(Infinity, ...this.ground.floorsAt(at.x, at.z, support).filter((f) => f.height > support.height + 0.02).map((f) => f.height));
      if ((!meant || meant.entity !== support.entity || meant.level !== support.level) && !this.ground.placedNear(at.x, at.z, y, near, support.height, ceiling)) {
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
    // round the furniture, through the door, up the stair (shared/navgrid.js).
    let legs = plan.legs, snapped = false, routed = false, passIds = new Set<string>();
    // A floor walk's probe stands on that storey (not in the colliders), routes
    // round placed models as on the ground (walkProbeGround), never lower than
    // the floor (onOrAboveFloor). Its grid is the walk's own.
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
      const navKey = `${collidersGeneration()}|${this.ground.navTerrainRev}|${passable.join(",")}`;
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
          // which no route may reach (a top bunk): then the place to stand
          // nearest them no higher than their root, the floor beside it.
          // (Not "within a step": NAV_STEP > RAGDOLL_ROOT_DROP would reach the bunk.)
          if (!("refusal" in first) || !near.bodyAt) return first;
          const beside = grid.route(from, { x, z, y, ...near, above: 0 });
          return "refusal" in beside ? first : beside;
        });
      });
      if ("refusal" in nav) { this.walkRefusal = nav.refusal; return Promise.resolve(false); }
      // griddled structures' walls aren't in the headless colliders, so a detour
      // round the furniture is checked against them; one that crosses a wall
      // gives way to the structure planner's own legs
      const structures = this.walkStructures(support);
      const pts = [{ x: this.pos.x, z: this.pos.z }, ...nav.points.map((p) => ({ x: p.x, z: p.z }))];
      const crosses = structures.length > 0 && pts.slice(1).some((p, k) => structures.some((st) => !st.clear(pts[k], p)));
      if (!crosses) {
        legs = nav.points.map((p) => ({ x: p.x, z: p.z, y: p.y }));
        snapped = nav.snapped; routed = true;
      }
    }
    if (this.flight) this.endFlight("walk");   // deciding to walk IS ending a flight (#298)
    if (this.draggedBy) {   // deciding to walk IS breaking the dragger's hold
      this.ws?.send(JSON.stringify({ type: "bodydrag", target: this.draggedBy, end: true }));
      this.draggedBy = null;
      this.heldPose = null; this.heldPoseAuthored = false; this.clip = "idle";
    }
    this.pins.clear();      // and walking tears out every nail
    ++this.bodyEpoch;       // ...and outranks a tumble or settle still loading
    this.body?.stop(); this.stopSim();   // a body that decides to walk is done tumbling
    // deciding to walk IS getting up: shed the held pose, or the body walks
    // with it frozen over the stride. Authorship alone is not a safe test (a
    // restored pose arrives authored); only a pose pinned with `hold` survives,
    // identified by object (heldPoseSticky), which a restore or tumble frame can't satisfy.
    const sticky = this.heldPose != null && this.heldPose === this.heldPoseSticky;
    if ((this.heldPose && !sticky) || this.clip === "ragdoll") {
      if (!sticky) { this.heldPose = null; this.heldPoseAuthored = false; }
      if (this.clip === "ragdoll") this.clip = "walk";
    }
    // and deciding to walk IS getting off the seat — a folded mount otherwise
    // glues this body to its socket on every renderer, wherever the feet go
    if (this.joined && this.myOccupancy && this.mayVacate("menu")) this.setOccupant(null);
    // and stand on the ground you got up onto: with colliders loaded, the floor under the feet found from where they
    // are (a body seated upstairs stands up upstairs); the planner's support answer otherwise
    const supportAt = support.kind === "terrain" ? (wx: number, wz: number) => this.heightAt(wx, wz) : () => support.height;
    const standFrom = { x: this.pos.x, y: feetY, z: this.pos.z };
    this.pos.y = inWorld(this.world, () => (collidersReady() ? standOn(standFrom, supportAt) : null)) ?? support.height;
    this.vy = 0; this.grounded = true; this.stallTicks = 0; this.walkStall = null;
    // A structure route's corners are reached exactly (its doorways are planned to the centimetre); a routed walk's
    // may sit where something nudges the body a little, so they — and its end — count within that.
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
    const from = { x: this.pos.x, z: this.pos.z };
    void this.trackHere().then((t) => {
      if (this.walkGate !== gate) return;
      if ("open" in t) { gate.mode = "open"; return; }
      if (!t.ok) { this.refuseWalk(t.refused); return; }
      // the track moved the body (a visitor arrives at the spawn): the legs were planned from where it stood, so plan again from here
      const plan = this.walkPlan;
      if (plan && this.walkDone && Math.hypot(this.pos.x - from.x, this.pos.z - from.z) > 1) {
        const done = this.walkDone; this.walkDone = null; this.abandonWalk(); this.clip = "idle";
        void this.walkNow(plan.x, plan.z, plan.run, plan.timeoutMs, plan.tolerance, plan.y, plan.near, plan.replanned).then((arrived) => {
          if (!arrived && this.walkRefusal && !this.lastWalkRefusal && !this.walkStopReason) this.walkStopReason = `you arrived at the spawn, and from there: ${this.walkRefusal}`;
          done(arrived); });
        return;
      }
      gate.mode = "tracked"; gate.permit = this.trackAt;
    });
  }

  // named places (shared/places.js): mcpl/agent-places.ts
  readonly places = new AgentPlaces(this);
  placesOn(e: Entity) { return this.places.placesOn(e); }
  worldPlaces() { return this.places.worldPlaces(); }
  placesNear(...a: Parameters<AgentPlaces["placesNear"]>) { return this.places.placesNear(...a); }
  placeList(...a: Parameters<AgentPlaces["placeList"]>) { return this.places.placeList(...a); }
  placesInSight(...a: Parameters<AgentPlaces["placesInSight"]>) { return this.places.placesInSight(...a); }
  placesAt(w: number[]) { return this.places.placesAt(w); }
  destination(to: string) { return this.places.destination(to); }
  worldPointOf(...a: Parameters<AgentPlaces["worldPointOf"]>) { return this.places.worldPointOf(...a); }
  namePlace(...a: Parameters<AgentPlaces["namePlace"]>) { return this.places.namePlace(...a); }

  // ---- feet ----------------------------------------------------------------
  // The browser walking controller's vertical model (client/lib/player/controller.js)
  // against the same fitted colliders: move, resolveColliders (push the capsule
  // out of anything solid, answer the ground under it), then snap onto that
  // ground or fall toward it under gravity.
  vy = 0;
  grounded = true;
  /** What the route planner has learned about this world's columns, good until its key changes (walkNow's navKey: the
   *  colliders, the committed terrain, what the walk may walk into). */
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
   *  upstairs), the terrain where the colliders aren't loaded. */
  private permitFloor(x: number, z: number): number {
    return this.feetAt(x, z, this.pos.y, (wx, wz) => this.heightAt(wx, wz));
  }

  /** Whether the body lies as a sim lays one: the ragdoll clip, or a held
   *  pose it didn't author, a physics pose kept under another clip. */
  isSlumped(): boolean {
    return this.clip === "ragdoll" || (this.heldPose != null && !this.heldPoseAuthored);
  }

  /** The ground the tick holds a body's feet to when nothing else does:
   *  groundAt from the feet (feetY), so a body lying under another clip keeps
   *  the storey it lies on. */
  private standingGround(): (x: number, z: number) => number {
    const feetY = this.feetY(this.isSlumped());
    return (x, z) => this.groundAt(x, z, feetY);
  }

  /** The height of the feet, for finding the floor a body stands on: its y,
   *  but a slumped or tumbling body's feet are RAGDOLL_ROOT_DROP above its root,
   *  unless the slump is canned (rootCanned), whose root is at its feet. */
  feetY(slumped: boolean): number {
    return slumped && !this.rootCanned() ? this.pos.y + RAGDOLL_ROOT_DROP : this.pos.y;
  }

  private killzY(): number {
    return this.clip === "ragdoll" && !this.rootCanned() ? this.pos.y + (this.hipsAboveRoot ?? RAGDOLL_ROOT_DROP) : this.pos.y;
  }

  /** A canned slump's root: still at the height knockDown found the feet at. */
  private rootCanned(): boolean {
    return this.cannedY != null && this.pos.y === this.cannedY;
  }

  /** The ground under the feet as a standing body finds it: the fitted
   *  colliders when loaded, over the ground groundAt gives (an upper
   *  storey's floor, else the terrain); without colliders, that ground. */
  private feetGround(fromRagdoll = false): number {
    // a settled ragdoll's root lies ~0.68m BELOW its support, so probe from the
    // feet (feetY), or a thin upper floor would find the storey beneath.
    const from = { x: this.pos.x, y: this.feetY(fromRagdoll), z: this.pos.z };
    // under the colliders, the terrain or a griddled storey's floor
    const terrain = (x: number, z: number) => this.groundAt(x, z, from.y);
    const g = inWorld(this.world, () => (collidersReady() ? standOn(from, terrain) : null));
    if (g != null) { this.pos.x = from.x; this.pos.z = from.z; }
    return g ?? terrain(this.pos.x, this.pos.z);
  }

  /** A walk pressed against something solid ends, and says so: this catches
   *  what the route didn't plan round (spawned, placed or set moving since).
   *  Progress is distance closed on the current waypoint, so sliding along a
   *  wall it will never pass still stops. */
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
    // the stride presses INTO is blamed (its contact's normal head-on to the walk, as a shove's is) — a
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
  private abandonWalk(why?: string) {
    ++this.walkTicket;
    const done = this.walkDone;
    this.walkDone = null; this.target = null; this.legs = []; this.walkHeightAt = null; this.walkGate = null; this.speed = 0;
    if (this.clip === "walk" || this.clip === "run" || this.clip === "swim") this.clip = "idle";   // a swimmer then treads
    done?.(false);
    const waits = this.landWaits; this.landWaits = [];   // a walk waiting out a fall hears its new ticket
    for (const w of waits) w(why);
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
      // just before, or on a slow host by steps the authority saw bunched up (AS16). Asked again shortly,
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
   *  mass, density, surface) and its size in the world (its derived mass goes with it). A misjudged thing's judgement
   *  holds only while these do. */
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
    for (const [id, bids] of this.ground.supportIds) if (this.mayWalkInto(id, run)) { ids.add(id); out.push(...bids); }
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

  /** How long request() waits for the authority's answer (as net.js); a test shortens it (tool-replies-test #53). */
  requestTimeoutMs = 8000;
  /** One request to the world's authority, answered by it: {ok: true, …} or {ok: false, refused: {code, reason,
   *  fix}}. */
  request(verb: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.joined || this.ws?.readyState !== 1) return Promise.resolve({ ok: false, refused: { code: "not-joined", reason: "not in a world" } });
    // speech ends composing, by whichever route it's sent (say(), or act {verb: "say"}): the throttle clears, and whoever
    // keeps this body's typing dots up (the door's TypingRelay) lets them end with the bubble
    if (verb === "say") { this._typingUntil = 0; this.onSaid?.(); }
    // the authority judges this body's water with the stature its mover is handed (in water: stature())
    if (verb === "move" && this.water && args.height === undefined) args = { ...args, height: this.stature() };
    const id = `v${++this.histId}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pendingRequests.delete(id); resolve({ ok: false, refused: { code: "timeout", reason: "the authority did not answer within 8 s", fix: "it may still land: look before trying again", mayHaveLanded: true } }); }, this.requestTimeoutMs);
      this.pendingRequests.set(id, (m) => { clearTimeout(t);
        if (verb === "consent" && m.reply?.ok) this.noteConsent(args);
        resolve(m.reply ?? { ok: false, refused: { code: "no-reply", reason: "the authority's answer had no reply" } }); });
      this.ws!.send(JSON.stringify({ type: "request", id, verb, args }));
    });
  }
  /** What this body chose with `consent` (each gate, and each person it listed or unlisted), resent on every arrival so a
   *  reconnect keeps it. Only what it chose: never chosen is the world's default, and an unlist is said again too. */
  private consentWant: { move?: boolean; touch?: boolean; people: Map<string, "allow" | "block" | null> } = { people: new Map() };
  /** On every arrival, as a person's client does (consentsync.js): read what the authority holds for my body and send what
   *  I chose only where it differs. */
  async replayConsent(): Promise<void> {
    const w0 = this.consentWant; if (w0.move === undefined && w0.touch === undefined && !w0.people.size) return;
    const held = await this.request("consent", {}).catch(() => null); if (!held?.ok || !held.table) return;
    // read what I chose when the answer is back: a change made while the read was out is newer than the one this began with
    const want = this.consentWant, t = held.table, gates: Record<string, boolean> = {};
    for (const g of ["move", "touch"] as const) if (want[g] !== undefined && t[g] !== want[g]) gates[g] = want[g]!;
    if (Object.keys(gates).length) await this.request("consent", gates).catch(() => null);
    for (const [who, list] of want.people) {
      const now = Array.isArray(t.block) && t.block.includes(who) ? "block" : Array.isArray(t.allow) && t.allow.includes(who) ? "allow" : null;
      if (now !== list) await this.request("consent", { [list ?? "unlist"]: who }).catch(() => null); }
  }
  private noteConsent(args: Record<string, unknown>) {
    for (const g of ["move", "touch"] as const) if (typeof args[g] === "boolean") this.consentWant[g] = args[g] as boolean;
    for (const op of ["allow", "block", "unlist"] as const) if (typeof args[op] === "string") this.consentWant.people.set(args[op] as string, op === "unlist" ? null : op);
  }
  /** present people's identities, by display name (their arrival carries it) */
  actorIds = new Map<string, string>();
  /** Reaches the relay refused to show (server/reachgate.ts; the authority says so once per target and class per
   *  REACH_NOTE_MS), newest last: what reach() reads to tell the truth about a hand nobody saw. */
  reachRefusals: { to: string; cls: string; why: string; fix?: string; limb?: string; ts: number }[] = [];
  nameOfActor(actor: string): string | null { for (const [n, a] of this.actorIds) if (a === actor) return n; return null; }
  /** A gesture's ops (shared/requests.js) as ONE request, sent after the previous one was answered or timed out (8 s;
   *  it may still land). Ops planned
   *  before that wait don't see what landed meanwhile, so a caller that planned from the replica pins what it read with
   *  `expect` (componentsOf): a change since is refused, not overwritten. `extra` rides the request (dry, expect,
   *  throughLock). The same requests a person's edit sends. */
  async sendOps(ops: any[], extra: Record<string, unknown> = {}): Promise<any> {
    const req: any = OP.batch(ops);
    if (!req) return { ok: true, noop: true };
    const turn = this.spelling.then(() => this.request(req.verb, { ...req.args, ...extra }));
    this.spelling = turn.catch(() => null);
    return turn;
  }

  // ---- moderation ----
  // Per-world kick/ban/unban are requests (request()); this is the server's own
  // moderation messages and a way to hear the world's answer.

  /** The world's most recent mid-life refusal / moderation reply. */
  lastRefusal: { ts: number; text: string } | null = null;
  lastMod: { ts: number; text: string } | null = null;
  /** The last few `mod` replies, oldest first (see the "mod" case). */
  recentMods: { ts: number; text: string }[] = [];

  /** Moderation messages that aren't requests: 'world-bans' (list this
   *  world's bans — anyone present), 'server-ban' / 'server-unban' /
   *  'server-bans' (server: server operators only). Answers arrive as `mod`. */
  sendMod(type: "world-bans" | "server-ban" | "server-unban" | "server-bans", extra: Record<string, unknown> = {}) {
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    this.ws.send(JSON.stringify({ type, ...extra }));
  }

  /** Ask the world to mint this identity's media credential (#104).
   *  Only the embodied primary may — which is this server. The answer arrives as
   *  a `relay-cred` frame on onMedia; a sidecar then publishes on it. */
  requestMediaCredential(scopes: { publish?: boolean; subscribe?: boolean } = {}) {
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    this.ws.send(JSON.stringify({ type: "relay-cred", ...scopes }));
  }

  /** Carry ONE media-signalling frame from the sidecar to the world,
   *  whitelisted by type so the door is never a general tunnel into the
   *  sequencer. Payload (SDP, ICE) is deliberately NOT inspected: the server is
   *  the one validator. */
  sendMedia(frame: { type: string; [k: string]: unknown }): void {
    if (!this.joined || this.ws?.readyState !== 1) return;
    const t = String(frame?.type ?? "");
    // `voice-consent` is the LISTENER half: the world requires it from the
    // primary, so an agent that wants to HEAR sends it through here. It's a
    // boolean about our own ears.
    // `voice-moderate` is DELIBERATELY NOT HERE: muting someone for everyone is
    // a moderation act (the moderation verbs, with their rights check), and a sidecar
    // is a process, not an identity.
    if (t !== "sfu-answer" && t !== "sfu-ice" && t !== "sfu-want-negotiate"
        && t !== "sfu-pos" && t !== "voice-consent") {
      console.warn(`[door] refusing to forward non-media frame "${t}"`);
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait briefly for the world's answer to a moderation act issued at t0: a
   *  `mod` confirmation or an `error` refusal (a log echo isn't read; a world
   *  ban answers on its request's reply, tools.ts). These messages have no reply
   *  of their own, so this is how a tool hears the answer. */
  async modOutcome(t0: number, ms = 1500): Promise<string | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.lastRefusal && this.lastRefusal.ts >= t0) return `refused: ${this.lastRefusal.text}`;
      if (this.lastMod && this.lastMod.ts >= t0) return this.lastMod.text;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  // extra carries only `to` and the spoken-say trio, the trio guarded with the same
  // shapes the server enforces. A malformed trio → plain say.
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

  /** Show "composing" over this body: presence-only, the signal a human client
   *  sends while typing; renderers draw the dots for ~4s. Called repeatedly
   *  while the host's turn runs (MCPL channels/typing, the door's TypingRelay),
   *  throttled to one packet per second on a monotonic clock. A `say` clears the
   *  throttle and calls `onSaid`, which stops the relay. */
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
      ++this.bodyEpoch;   // a fall still loading abandons itself, as for a walk, a grab or close (#295)
      this.body?.stop(); this.stopSim();
      this.clip = "idle";
      this.pos.y = this.feetGround(true);
    }
  }

  // reaching: hands and feet reaching, and its consent: mcpl/agent-reach.ts
  readonly reaching = new AgentReach(this);
  static reachClass(...a: Parameters<typeof AgentReach.reachClass>) { return AgentReach.reachClass(...a); }
  reach(...a: Parameters<AgentReach["reach"]>) { return this.reaching.reach(...a); }
  releaseReach(limbRaw?: string | null) { return this.reaching.releaseReach(limbRaw); }

  /** Play a named anim once — pose.anim, a field on the next presence packet,
   *  the same channel the browser's action bar uses. Receivers resolve the
   *  name to a library clip; nothing is logged. */
  playOnce(name: string) { this.pendingAnim = name; }
  private pendingAnim: string | null = null;

  /** Settle into a posture clip (sit/sitchair/lie/idle). Rides the presence
   *  stream like locomotion does; walking replaces it, restore re-applies it. */
  setPosture(clip: string) {
    ++this.bodyEpoch;   // a posture takes authority over the body: a fall still loading abandons itself (#295)
    const down = this.clip === "ragdoll" && !this.flight;   // read before stop() sets "idle"; a limp flight's "ragdoll" is the flight's fall
    this.stop();
    this.speed = 0;
    // choosing a posture ends a tumble the same way walking does: a physics
    // frame must not survive under the new label.
    if (down || (this.heldPose && !this.heldPoseAuthored)) {
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
    if (this.flight) this.endFlight("avatar");   // the new body's rig isn't read yet: it falls, and its next flight act checks it
    this.avatar = path;
    // The new body's bones are read before its next flight act or fold.
    this.bodyBoneNames = null;
    this.bodyBonesFor = null;
    this.selfBodyGeneration = ++this.bodyGenerationCounter;
    this.bodyReader?.forget(this.name);
    // a new body has its own height: re-measure (a reply for the old body is dropped), and float afresh
    this.endFloat();
    this.bodyH = null;
    if (this.water) void this.measureStature(); else { this.statureFor = null; ++this.statureGen; }
    if (this.joined && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(this.joinMsg()));
    }
  }

  /** Play live tracks on yourself, once or looping (`loop`) — relayed, never logged.
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
    // Sent or refused, as sendMod() is: a request that never left must not read as made.
    if (!this.joined || this.ws?.readyState !== 1) throw this.notJoined();
    this.ws.send(JSON.stringify({ type: "puppet", target,
      pose: spec.pose ?? null, ...(spec.merge ? { merge: true } : {}), anim: spec.anim ?? null, ragdoll: spec.ragdoll ?? null }));
  }

  /** Ask the world what happened in a range of its history: how an agent that
   *  exists in bursts recovers what happened while it wasn't running. */
  history(opts: { before?: number; after?: number; limit?: number; verbs?: string[] } = {}):
      Promise<{ entries: any[]; oldestSeq: number | null; hasMore: boolean; failed?: boolean }> {
    // no answer (offline, a timeout) is `failed`, never an empty final page: a reader must not advance past it
    if (!this.joined || this.ws?.readyState !== 1) {
      return Promise.resolve({ entries: [], oldestSeq: null, hasMore: false, failed: true });
    }
    const reqId = `h${++this.histId}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingHistory.delete(reqId);
        resolve({ entries: [], oldestSeq: null, hasMore: false, failed: true });
      }, 8000);
      this.pendingHistory.set(reqId, (m) => {
        clearTimeout(t);
        resolve({ entries: m.entries ?? [], oldestSeq: m.oldestSeq ?? null, hasMore: !!m.hasMore });
      });
      this.ws!.send(JSON.stringify({ type: "history", reqId, ...opts }));
    });
  }

  /** The world's flight recorder: why things bounced — the refusals the authority recorded (rights, locks, shapes,
   *  rate limits, bans; at most 20 per connection per 10 s, 300 events kept), and with `script` / `scripts`, what the world's scripts did.
   *  The log answers "what happened"; this answers "why didn't it". */
  worldDebug(opts: { limit?: number; kinds?: string[]; script?: string; scripts?: boolean } = {}):
      Promise<{ events: any[]; status?: string; failed?: boolean }> {
    // no answer (offline, a timeout) is `failed`, as history()'s: never an empty recorder
    if (!this.joined || this.ws?.readyState !== 1) return Promise.resolve({ events: [], failed: true });
    const reqId = `d${++this.histId}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingDebug.delete(reqId);
        resolve({ events: [], failed: true });
      }, 8000);
      this.pendingDebug.set(reqId, (m) => {
        clearTimeout(t);
        resolve({ events: m.events ?? [], ...(m.status ? { status: m.status } : {}) });
      });
      this.ws!.send(JSON.stringify({ type: "debug", reqId, ...opts }));
    });
  }

  /** Where a thing ACTUALLY is right now: the mount chain and any whole-entity
   *  motion, composed by effective.ts with the renderer's closed forms. Numeric
   *  spatial claims in perception go through this, never `e.pos` (one exception:
   *  look's room-of, agent-senses localizePoint, still reads the saved pose). */
  eff(id: string, nowMs: number): Effective {
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

  /** The declared-approximation suffix for a seated person's line:
   *  the same reason string the browser consoles and the nameplate ≈ carry —
   *  one contract, three declarations. Empty when the seat is profiled. */
  seatSuffix(id: string, occ: { to: string }): string {
    const station = this.socketRec(occ.to)?.station;
    const g = seatGateCore({ sock: station, verdict: this.seatVerdictFor(id), pose: bodyOf(station)?.clip ?? "sitchair" });
    return g.apply ? "" : ` (seat approximate: ${g.reason})`;
  }
  // the senses: what the body notices and how it tells the world (inbox, pings, approach, emitters, sky, look): mcpl/agent-senses.ts
  readonly senses = new AgentSenses(this);
  setActivity(opts: { pulseSec?: number; radiusM?: number }) { return this.senses.setActivity(opts); }
  private notePose(...a: Parameters<AgentSenses["notePose"]>) { return this.senses.notePose(...a); }   // tests call it
  private hearSay(...a: Parameters<AgentSenses["hearSay"]>) { return this.senses.hearSay(...a); }   // tests call it
  checkSky(...a: Parameters<AgentSenses["checkSky"]>) { return this.senses.checkSky(...a); }
  ping(p: { ts: number; kind: "mention" | "approach" | "depart" | "reach" | "touch"; who: string; text?: string }) { return this.senses.ping(p); }
  takePings() { return this.senses.takePings(); }
  skipInboxThrough(seq: number) { return this.senses.skipInboxThrough(seq); }
  missedSince(...a: Parameters<AgentSenses["missedSince"]>) { return this.senses.missedSince(...a); }
  firstSaidSince(seq: number, limit: number) { return this.senses.firstSaidSince(seq, limit); }
  myPlace(...a: Parameters<AgentSenses["myPlace"]>) { return this.senses.myPlace(...a); }
  look(...a: Parameters<AgentSenses["look"]>) { return this.senses.look(...a); }
}
