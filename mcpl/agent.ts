// WorldAgent — a headless world participant: the MCPL's body.
// Owns its avatar exactly like the browser client owns a human's: simulated
// position/yaw/speed ticked at 10Hz, pose intent streamed to the sequencer,
// terrain replicated (Skye's terrain.js eval'd in Bun) so feet agree with
// every renderer. No GPU here — rendering is the retina's job (see server.ts).

import { mentionRegex } from "./mention.ts";
import * as THREE_W from "three/webgpu";
import * as TSL from "three/tsl";
import { NoiseGate, SHORT_STINT_MS, APPROACH_REFRACT_MS, APPROACH_RADIUS, REARM_RADIUS,
  APPROACH_DWELL_MS, APPROACH_STILL_MPS, APPROACH_MAX_WAIT_MS,
  ACTIVITY_RADIUS_M, ACTIVITY_PULSE_MS, ACTIVITY_REFRESH_MS, MOVER_MIN_M } from "./denoise.ts";
import { HeadlessBody, ReachBody, setHeightField, registerSupport, registerSupportGrid, removeSupport } from "./physics.ts";
// FLIGHT. The same deterministic integrator the browser bench and the capture
// path run -- one function, every runtime, per the spec's Q2 ruling.
import {
  makeConfig as flightConfig, initialState as flightState, step as flightStep,
  bodyDown as flightDown, bodyRecovered as flightRecovered, takeOff as flightTakeOff,
  bestGlide, glideRange,
} from "../shared/flight.js";
import { resolveFlight, devFlightProvider } from "../shared/flightcap.js";
import { DEFAULT_LEAF_FORCE as LEAF_FORCE } from "../shared/leafforce.js";

/** integrator yaw (atan2(dz,dx), forward = (cos,sin)) -> world yaw
 *  (atan2(dx,dz), which every renderer and walkTo already speak). */
const worldYaw = (y: number) => Math.PI / 2 - y;
/** ...and back. The map is its own inverse, but naming both directions is
 *  cheaper than working that out at every call site. */
const intYaw = (y: number) => Math.PI / 2 - y;
import { canonicalLimb, normalizeReachTarget, normalizeReachBag, describeTarget, diffReach,
  TOUCH_GAP } from "../shared/reachwire.js";
import { decideSupportClass, CERT_MAX_WORLD } from "../client/lib/supportclass.js";
import { isFiniteVec3 } from "./shape.ts";
// The same pure sky fold + weather derivation the browser client and the
// sequencer run — text-tier perception must land on the SAME hour and
// weather every renderer shows (issue #29's shared-fact boundary).
import { foldSkyEntry, describeSky, effectiveSky, effectiveClock, dayPhase, hoursAt } from "../shared/forecast.js";
// The snapshot re-synthesizer, shared with the browser — this agent's
// deliberate omissions ride as flags (see stateToEntries below).
import { stateToEntries as sharedStateToEntries } from "../shared/fold.js";
// The `particles` component's meaning, shared verbatim with the browser host:
// a renderer client and a resident who perceives by reading must agree about
// what is burning (#25's shared-facts boundary).
import { describeParticles, emitterTransition, transitionLine } from "../shared/particles.js";
import { describeStructure, describeHere, localizePoint, planStructure, routeLocal } from "../shared/structure.js";
import { effectiveWorldTransform, type Effective } from "./effective.ts";
import { makeVerdictCache, seatGateCore, nameFromAvatarPath } from "../client/lib/seatcore.js";

(globalThis as any).THREE = Object.assign({}, THREE_W, TSL);

const WALK = 1.55, RUN = 4.0, TICK_MS = 100, ARRIVE = 0.4;
/** Quiet window for world-change narration, per (entity, component). Tuning a
 *  live emitter is a burst of `comp` entries; this is how long they fold into
 *  one line. Long enough to swallow a slider drag, short enough that "puts the
 *  fire out" still arrives while you are looking at it. */
const EMITTER_COALESCE_MS = Number(process.env.EW_EMITTER_COALESCE_SEC ?? 4) * 1000;

type Vec2 = { x: number; z: number };
type Pose = { p: number[]; yaw: number; speed: number; clip: string };
type Entity = { id: string; lib: string; pos: number[]; yaw: number; actor: string; scale?: number;
  /** component bag (sockets, reactions, motion, …) — what a thing can DO;
   *  this is how affordances reach text-tier perception */
  comp?: Record<string, any> };
type Person = { id: string; avatar: string; pose: Pose | null; agent?: boolean };

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

/** The snapshot re-synthesizer lives in shared/fold.js now — one
 *  implementation, every species, with this agent's deliberate omissions
 *  encoded as EXPLICIT flags rather than a hand-mirrored copy that "must
 *  stay in step" (the drift that crashed look() for every agent in the
 *  world is the incident that comment carried): roles/grants and behaviors
 *  have no local reader here, spawn `collide` is browser-only collider
 *  state, and body mounts read as "who sits where", attributed to the
 *  sitter. */
function stateToEntries(state: any, skipChatFromSeq = Infinity): any[] {
  return sharedStateToEntries(state, {
    skipChatFromSeq, roles: false, behaviors: false, collide: false,
    bodyMountRel: "seat", bodyMountActor: "rider",
  });
}

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
const DOWNED_POSE: Record<string, number[]> = {
  spine: [0.6, 0, 0, 0.8], chest: [0.5, 0, 0, 0.87], neck: [0.3, 0, 0, 0.95],
  leftUpperArm: [0, 0, -0.9, 0.44], rightUpperArm: [0, 0, 0.9, 0.44],
  leftUpperLeg: [0.9, 0, 0, 0.44], rightUpperLeg: [0.9, 0, 0, 0.44],
  leftLowerLeg: [-0.7, 0, 0, 0.71], rightLowerLeg: [-0.7, 0, 0, 0.71],
};

export class WorldAgent {
  url: string; name: string; world: string; avatar: string; agentToken = "";
  ws: WebSocket | null = null;
  joined = false;
  pos = { x: 0, y: 0, z: 0 };
  yaw = 0; speed = 0; clip = "idle";
  private target: (Vec2 & { run: boolean }) | null = null;
  /** Remaining waypoints of a routed walk — see walkTo. Empty means the target
   *  is reachable in a straight line, which is every case outside a building. */
  private legs: Vec2[] = [];
  /** A held custom pose — sparse humanoid-bone quaternions. Presence only:
   *  it rides the pose packet and is never a log verb, because it is a moment,
   *  not a change to the world. `null` clears. */
  heldPose: Record<string, number[]> | null = null;
  /** Where heldPose came from. An AUTHORED pose (set deliberately — the pose
   *  tool, a puppet, the server's settled memory) is a place: it survives
   *  walking, posture changes and sleep. A PHYSICS pose (ragdoll sim frame,
   *  drag stream, knockdown slump) is a moment: it may only ever leave this
   *  process under the "ragdoll" clip, and any decision to move sheds it.
   *  Without this line the two were indistinguishable — one settled tumble
   *  frame got relabelled "idle", slipped every clip-keyed sanitizer, and
   *  haunted princess across sessions and joiners for weeks (#61). */
  heldPoseAuthored = false;

  /** The exact pose object that was granted "hold this while I walk".
   *
   *  Stored as the OBJECT, not a boolean, and compared by identity — so any
   *  other writer of `heldPose` (a tumble frame, a puppet, a drag sample, a
   *  restore) revokes stickiness for free by simply assigning a different
   *  object. A parallel boolean would have to be cleared at all nine of those
   *  sites, and the one that got missed would be a pose that outlived every
   *  walk forever. This cannot be missed: it is the same identity trick the
   *  renderer's `_composeBegin` and the interpolator's `lastPose` both use. */
  private heldPoseSticky: Record<string, number[]> | null = null;
  draggedBy: string | null = null;   // whose takeover sim drives this body (bodydrag)
  dragAt = 0;                        // last drag sample, for the silence timeout
  pins = new Map<string, number[]>(); // persistent bodydrag nails: joint -> [x,y,z]
  pushable = true;                   // rough-and-tumble consent — accepted by default, like being posed
  body: HeadlessBody | null | undefined = undefined; // the REAL ragdoll (undefined = not tried yet)
  private simTicker: ReturnType<typeof setInterval> | null = null;
  private walkDone: ((arrived: boolean) => void) | null = null;
  entities = new Map<string, Entity>();
  /** who/what rides what: mount verbs, keyed by the rider (body or thing) */
  /** Every mount's full wire shape — offset/yaw OVERRIDE socket defaults in
   *  the world transform (#82), so dropping them here made the composed
   *  position disagree with every renderer. */
  mounts = new Map<string, { to: string; slot?: string; offset?: number[]; yaw?: number }>();
  people = new Map<string, Person>();
  inbox: InboxItem[] = [];
  private inboxCursor = 0;
  /** Highest world-log seq whose `say` already sits in the inbox. A mid-life
   *  reconnect replays the same snapshot tail — without this guard every
   *  server restart re-appended history and the next look() dumped chat the
   *  agent had already seen. */
  private inboxSeen = -Infinity;
  pings: { ts: number; kind: "mention" | "approach" | "depart" | "whisper" | "reach" | "touch"; who: string; text?: string }[] = [];
  onPing: ((p: { ts: number; kind: string; who: string; text?: string }) => void) | null = null;
  /** live world events (say/arrive/leave/activity) — the channel fan-out hook */
  onEvent: ((ev: { ts: number; kind: "say" | "arrive" | "leave" | "whisper" | "act" | "activity" | "weather" | "world-change"; who: string; text?: string; mention?: boolean }) => void) | null = null;
  /** MEDIA seam (#104 / #57): the SFU's publish path is gated to the EMBODIED
   *  PRIMARY (`relay-cred is the embodied primary's ask`, server.ts) — and for
   *  an agent, the primary IS this door. So an agent with a local synthesizer
   *  could not publish at all: its sidecar has the audio and no credential, the
   *  door has the credential and no audio.
   *
   *  Same shape as #100's fix, one layer out: rather than forcing the agent onto
   *  a raw world-ws side connection (which is what my media-peer was, and it
   *  landed on the MESH while everyone else was on the SFU), the door forwards
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
   *  They ride every presence packet; every receiver re-solves the relation
   *  against its own scene. The `reached` rider is MY solver's attestation,
   *  kept honest by reachTick(). */
  reaches = new Map<string, { t: any; palm?: false; reached?: true }>();
  private reachBodies = new Map<string, ReachBody | null>();               // avatar path -> solver body
  private reachBodyLoads = new Map<string, Promise<ReachBody | null>>();
  private reachTicks = 0;
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
  /** Stateful denoiser for ambient narration (arrive/leave/acts). Says,
   *  mentions, and whispers never pass through it — a knock is not chatter.
   *  See denoise.ts for the doctrine. */
  private gate = new NoiseGate((ev) => {
    if (ev.kind === "arrive") this.act30.arrivals++;
    else if (ev.kind === "leave") this.act30.departures++;
    this.inbox.push({ ts: ev.ts, kind: ev.kind, who: ev.who, ...(ev.text != null ? { text: ev.text } : {}) });
    this.onEvent?.(ev);
  });
  /** The activity sense is the agent's own to tune (persisted per-agent by
   *  the door; see net-server's `activity` tool). Instance values start at
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
  private pendingDebug = new Map<string, (m: any) => void>();
  private histId = 0;

  constructor(opts: { url?: string; name?: string; world?: string; avatar?: string; agentToken?: string } = {}) {
    this.url = opts.url ?? process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws";
    this.name = opts.name ?? process.env.AGENT_NAME ?? "claude";
    this.world = opts.world ?? process.env.WORLD_NAME ?? "commons";
    this.avatar = opts.avatar ?? process.env.AGENT_AVATAR ?? "eidoverse/assets/vrms/claude.vrm";
    // The agent's own bearer (the one that opened the MCPL door). Forwarded at
    // join so the sequencer can verify the name — agent names are reserved.
    this.agentToken = opts.agentToken ?? process.env.AGENT_TOKEN ?? "";
  }

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

  /** Server-to-local clock offset, smoothed — the headless serverNow()
   *  (mirrors client/lib/remotes.js: same source, same 0.92/0.08 EMA).
   *  Motion is a function of SEQUENCER time; evaluating it on a skewed host
   *  clock makes this body report a different pendulum phase than every
   *  browser looking at the same swing, while both run the same closed form
   *  (#92 review, B1). Fed from the embodied plane's frame stamps. */
  private clockOffset: number | null = null;
  noteServerTime(t: unknown) {
    if (typeof t !== "number" || !Number.isFinite(t)) return;
    const sample = t - Date.now();
    this.clockOffset = this.clockOffset === null ? sample : this.clockOffset * 0.92 + sample * 0.08;
  }
  /** Epoch ms on the sequencer's clock, best estimate. Before the first
   *  frame lands this is local time — the browser's exact fallback. */
  serverNow(): number { return Date.now() + (this.clockOffset ?? 0); }

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

  /** A build act (spawn/place/light/remove) near this body counts as activity. */
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
      const timeout = setTimeout(() => reject(new Error("join timeout")), 8000);
      // `agent: true` is not a capability — it changes nothing about what this
      // body may do. It exists so the world can SAY who it is talking to.
      // Knowing whether the thing across the table thinks in tokens or neurons
      // matters here in a way it doesn't in a chat app.
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: this.world, id: this.name, avatar: this.avatar,
        agent: true, token: process.env.WORLD_TOKEN ?? "", agentToken: this.agentToken }));
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
        if ((ev as { code?: number } | undefined)?.code === 4006) { this.close(); return; }
        // 4005 = the sequencer REFUSED the join (bad/reserved name, bad token).
        // A refusal is an answer, not an outage — redialing it every 1.5s is
        // the polite-DoS the sequencer's own comments warn about (RFC-005
        // review D1: a granted ?world= dial with a name the sequencer rejects
        // used to hammer forever).
        if ((ev as { code?: number } | undefined)?.code === 4005) { this.close(); return; }
        if (!this.closed) setTimeout(() => this.connect().catch(() => {}), 1500);
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
            // A pre-join refusal (reserved name, bad token) is final —
            // retrying the identical join every 1.5s can only produce the
            // same refusal. Surface the sequencer's reason instead of the
            // silent join-timeout loop this used to be.
            if (!this.joined) {
              this.closed = true;
              clearTimeout(timeout);
              reject(new Error(String(msg.error ?? "join refused")));
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
          // client and the door dropped them on the floor, so an agent could
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
          case "snapshot":
            // Our surface generation, issued by the server on acceptance —
            // every attest must echo it or the receipt is refused (PR #103 B2).
            if (typeof msg.gen === "number") this.surfaceGen = msg.gen;
            this.entities.clear(); this.people.clear();
            // wake where you fell asleep — fresh body only; a body that has
            // walked this process keeps its own truth on mid-life reconnects
            if (msg.restore && !this.restoredPose && !this.target && this.pos.x === 0 && this.pos.z === 0) {
              this.pos.x = msg.restore.p[0]; this.pos.z = msg.restore.p[2];
              this.yaw = msg.restore.yaw ?? 0;
              // an enacted pose is authored, not ephemeral — wake holding it.
              // A remembered ragdoll frame is not (pre-sanitizer entries) —
              // wake standing rather than hung mid-tumble.
              if (msg.restore.clip && msg.restore.clip !== "ragdoll") this.clip = msg.restore.clip;
              // what survives the server's settled memory is an enacted pose —
              // authored by definition (settledPose strips physics frames)
              if (msg.restore.pose && msg.restore.clip !== "ragdoll") { this.heldPose = msg.restore.pose; this.heldPoseAuthored = true; }
            }
            this.restoredPose = true;
            for (const p of msg.present) this.people.set(p.id, { id: p.id, avatar: p.avatar, pose: p.pose, agent: !!p.agent });
            // A join is now the folded world plus a tail, not the whole log.
            // An agent that only read `entries` would arrive in an empty room.
            const oldestTail = msg.entries.length
              ? Math.min(...msg.entries.map((e: any) => e.seq ?? Infinity)) : Infinity;
            for (const e of stateToEntries(msg.state, oldestTail)) await this.applyEntry(e, false);
            for (const e of msg.entries) await this.applyEntry(e, false);
            if (typeof msg.throughSeq === "number") this.lastSeq = Math.max(this.lastSeq, msg.throughSeq);
            for (const e of msg.entries) this.lastSeq = Math.max(this.lastSeq, e.seq ?? -1);
            this.joined = true;
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
            if (msg.pose) { this.heldPose = msg.pose; this.heldPoseAuthored = true; } // posed BY someone = authored
            if (msg.anim) this.ws?.send(JSON.stringify({ type: "anim", ...msg.anim }));
            this.onEvent?.({ ts: Date.now(), kind: "say", who: msg.by,
              text: `(posed you${msg.anim ? " with an animation" : ""})` } as any);
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
              // pulling one of this body's nails — agents accept, as they
              // accept being posed: being directed is the point. The live sim
              // lets go of that joint and the body sags from what remains.
              const j = String(msg.unpin.joint ?? "");
              if (this.pins.delete(j)) this.body?.setPin(j, null);
              break;
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
          case "log":
            this.lastSeq = Math.max(this.lastSeq, msg.entry?.seq ?? -1);
            // Remember our OWN says briefly, so a sidecar that airs one can be
            // attested for it: the receipt is sha256 of the text the world
            // logged, and only the world's copy is authoritative (ours could
            // differ by a trailing space and the digest would not match).
            // Small ring — a receipt is valid for 5 minutes server-side, so
            // holding more than a handful of utterances is pointless.
            if (msg.entry?.verb === "say" && msg.entry?.actor === this.name
                && typeof msg.entry?.args?.text === "string") {
              this.ownSays.set(msg.entry.seq, String(msg.entry.args.text));
              if (this.ownSays.size > 32) this.ownSays.delete(this.ownSays.keys().next().value as number);
              this.onMedia?.({ type: "speak", seq: msg.entry.seq, text: msg.entry.args.text });
            }
            await this.applyEntry(msg.entry, true);
            break;
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
          case "whisper": {
            // A private message addressed to this body. Whispers never touch
            // the world log, so this is the ONLY delivery — treat it as an
            // explicit mention regardless of whether the name appears in it,
            // because being addressed directly is what a mention means.
            if (msg.echo || msg.from === this.name) break;
            this.inbox.push({ ts: msg.ts ?? Date.now(), kind: "say", who: msg.from, text: `(whisper) ${msg.text}` });
            this.ping({ ts: msg.ts ?? Date.now(), kind: "whisper", who: msg.from, text: msg.text });
            this.onEvent?.({ ts: msg.ts ?? Date.now(), kind: "whisper", who: msg.from, text: msg.text, mention: true });
            break;
          }
          case "arrive":
            // the people map is truth and updates NOW; the narration goes
            // through the gate, where a reconnect flap collapses to nothing
            this.people.set(msg.id, { id: msg.id, avatar: msg.avatar, pose: null, agent: !!msg.agent });
            this.gate.presence(msg.id, "arrive");
            break;
          case "leave":
            this.noteLeave(msg.id);
            break;
          case "avatar-updated":
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
          case "frame":
            // batched embodied plane: latest pose per id, one message per tick.
            // The frame's server stamp also feeds the clock estimate — the
            // same source the browser smooths into serverNow() (#92, B1).
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

  /** Is this participant an agent? The server flags agent sessions in both
   *  the join snapshot (`present[].agent`) and `arrive` broadcasts; this is
   *  the reader the denoiser and chat-tagging lean on. */
  isAgent(who: string): boolean {
    return !!this.people.get(who)?.agent;
  }

  /** Track someone's latest pose + fire the approach ping when they cross
   *  into conversational range. An approach is precious as a knock — and
   *  worthless as a metronome (Fable: Digi "walked up" six times in a row,
   *  just strolling nearby). Four gates now: edge-triggered at the radius,
   *  RE-ARMED only after the person actually goes away (> REARM_RADIUS),
   *  a long per-person refractory on top, and — since 2026-08-26 — DWELL.
   *
   *  The first three all suppress REPEATS. None of them could tell a knock
   *  from someone crossing your bubble on the way to the door, so the event
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
    const p = this.people.get(id) ?? { id, avatar: "", pose: null };
    const prev = p.pose;
    p.pose = pose; this.people.set(id, p);
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
   *  agent should hear about is TRANSITIONS — an emote fired, a pose struck
   *  or released, someone sitting down or getting up. Edge-triggered, so a
   *  held pose (or a ragdoll, which streams through the same field) speaks
   *  once when it starts and once when it ends, never per-frame.
   *
   *  Two denoising layers on top (Fable: 40+ jump pairs in one evening):
   *  the gate's per-(person, act) refractory makes a burst of the same act
   *  speak once per window instead of per repetition; and a non-locomotion
   *  stint shorter than SHORT_STINT_MS earns no "gets up" — the start
   *  already told the story, a jump is one thing, not two. */
  private noteActs(id: string, prev: Pose | null, pose: Pose & { emote?: string; pose?: Record<string, unknown> | null }, dist = Infinity) {
    const acts: { key: string; text: string }[] = [];
    if (pose.emote) acts.push({ key: `emote:${pose.emote}`, text: `emotes: ${pose.emote}` });
    const prevHeld = Boolean((prev as { pose?: unknown } | null)?.pose);
    const nowHeld = Boolean(pose.pose);
    if (nowHeld && !prevHeld) acts.push({ key: "pose", text: `strikes a pose (${Object.keys(pose.pose!).length} bones held)` });
    if (!nowHeld && prevHeld) acts.push({ key: "pose-release", text: "releases their pose" });
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

  private async applyEntry(entry: any, live: boolean) {
    const { verb, args, actor, ts } = entry;
    if (verb === "spawn") {
      this.entities.set(args.id, { id: args.id, lib: args.lib, pos: args.pos ?? [0, 0, 0], yaw: args.yaw ?? 0,
        ...(args.scale != null ? { scale: args.scale } : {}), actor });
      if (live) this.noteBuild(actor, args.pos);
      this.trackSupport(this.syncSupport(args.id));   // a placed thing is a thing bodies can rest on (#17)
    } else if (verb === "light") {
      // a light is an entity too, so text-tier perception can see it and it can
      // be moved/removed by id like anything else. Re-issued on an existing id
      // it is a partial update — an entry without pos must not teleport the
      // text-tier's idea of the light to the default spot.
      const prevLight = this.entities.get(args.id);
      this.entities.set(args.id, { id: args.id, lib: "(light)", pos: args.pos ?? prevLight?.pos ?? [0, 1, 0], yaw: 0, actor });
      if (live) this.noteBuild(actor, args.pos);
    } else if (verb === "place") {
      const e = this.entities.get(args.id);
      if (e) {
        // mirror the server fold's partial-update semantics: a place without
        // a usable pos KEEPS the prior position. Assigning args.pos
        // unconditionally is how one malformed raw packet crash-looped the
        // whole door — undefined walked into the support transform (#88).
        if (isFiniteVec3(args.pos)) e.pos = args.pos;
        else if (args.pos != null || args.x != null || args.y != null || args.z != null) this.noteMalformed(verb, args);
        if (args.yaw != null) e.yaw = args.yaw;
        if (args.scale != null) e.scale = args.scale;
      }
      if (live) this.noteBuild(actor, isFiniteVec3(args.pos) ? args.pos : e?.pos);
      this.trackSupport(this.syncSupport(args.id));   // support follows the thing it belongs to
    } else if (verb === "remove") {
      if (live) this.noteBuild(actor, this.entities.get(args.id)?.pos);
      this.entities.delete(args.id);
      this.dropSupport(args.id);
      for (const [rid, m] of this.mounts) if (m.to === args.id) this.mounts.delete(rid);
    } else if (verb === "comp") {
      // affordances are components — track them or look() can't tell anyone
      const e = this.entities.get(args.id);
      if (e && typeof args.type === "string") {
        const before = e.comp?.[args.type] ?? null;
        e.comp ??= {};
        if (args.data == null) delete e.comp[args.type]; else e.comp[args.type] = args.data;
        // An emitter beginning, changing or ending is something you SEE happen
        // in the world — the one component type with a live sensory event.
        // Replay reconstructs the state above and stops there: a fire that was
        // lit last week is in look(), not in your ears (#25).
        if (args.type === "particles" && live) {
          // proximity-gate on where the emitter's owner ACTUALLY is — a
          // carried lantern is judged at the carrier, not at its pre-mount
          // spot (#82). When the chain cannot compose, ABSTAIN: gating on
          // the stale pos would deliver a live sensory event to people near
          // an abandoned address and miss those beside the actual carrier
          // (#92, B2). The gap is logged, bounded, not performed.
          const fx = this.eff(String(args.id), this.serverNow());
          if (fx.ok) this.noteEmitter(actor, String(args.id), before, args.data ?? null, fx.pos, ts);
          else this.noteEffGap(String(args.id), fx.why);
        }
        // a motion arriving or leaving changes whether this thing may hold a
        // body up (see hasActiveMotion)
        if (args.type === "motion" || args.type.startsWith("motion:")) this.trackSupport(this.syncSupport(args.id));
      }
    } else if (verb === "motion") {
      const e = this.entities.get(args.id);
      if (e) {
        e.comp ??= {};
        const { id: _id, ...m } = args;
        if (m.type == null) delete e.comp.motion; else e.comp.motion = m;
        this.trackSupport(this.syncSupport(args.id));   // starts moving = stops supporting, and back
      }
    } else if (verb === "mount") {
      // offset/yaw are kept RAW: effective.ts refuses non-finite values with
      // a named link rather than silently substituting the socket default —
      // a substitution would disagree with what the browser renders.
      this.mounts.set(args.id, { to: args.to, slot: args.slot,
        ...(args.offset != null ? { offset: args.offset } : {}),
        ...(args.yaw != null ? { yaw: args.yaw } : {}) });
      // Cargo rides its parent, so its own support goes stale the instant the
      // parent moves — world.js drops the collider here for exactly that
      // reason and lets the pair collide as the parent. Entities only: a
      // mount whose id is not a thing is a BODY taking a seat, which owns no
      // support and is a separate seam.
      if (this.entities.has(args.id)) this.dropSupport(args.id);
    } else if (verb === "dismount") {
      this.mounts.delete(args.id);
      const e = this.entities.get(args.id);
      if (e) {
        // a dismount stamps where the ride let go; the support must be built
        // from THAT, not from the transform the thing had before it mounted
        if (isFiniteVec3(args.pos)) e.pos = args.pos;
        if (args.yaw != null) e.yaw = args.yaw;
        this.trackSupport(this.syncSupport(args.id));   // stand it back up
      }
    } else if (verb === "force") {
      // an instantaneous radial CAUSE (blast, gust) — live only, because a
      // replay must never re-detonate. Same falloff math as browser bodies
      // (mirrored from client/main.js — keep in sync), same consent.
      if (live && Array.isArray(args?.at) && args.at.length === 3) {
        const dx = this.pos.x - args.at[0], dz = this.pos.z - args.at[2];
        const d = Math.hypot(dx, dz);
        const radius = Math.max(Number(args.radius ?? 4), 0.001);
        if (d <= radius) {
          const mag = Math.min(6, Number(args.power ?? 3) * (1 - d / radius));
          if (mag >= 0.3) {
            const nx = d > 0.05 ? dx / d : Math.sin(this.yaw);
            const nz = d > 0.05 ? dz / d : Math.cos(this.yaw);
            this.knockDown(actor, [nx * mag, 0, nz * mag],
              actor === this.name
                ? "(your own blast knocks you off your feet)"
                : `(${actor}'s blast knocks you off your feet)`);
          }
        }
      }
    } else if (verb === "say") {
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
        const rx = mentionRegex(this.name);
        const mention = rx ? rx.test(String(args.text)) : false;
        if (mention) this.ping({ ts, kind: "mention", who: actor, text: args.text });
        this.onEvent?.({ ts, kind: "say", who: actor, text: args.text, mention });
      }
    } else if (verb === "ban" || verb === "unban" || verb === "kick") {
      // Moderation acts, narrated like any embodied transition — and, when
      // this body is the ACTOR, the confirmation its fire-and-forget verb
      // never gets: the authoritative echo doubles as the tool's answer.
      const what = verb === "ban" ? "banned" : verb === "unban" ? "lifted the ban on" : "removed";
      const line = `${what} ${args?.id}${verb !== "unban" && args?.reason ? ` — ${args.reason}` : ""}`;
      if (live) {
        this.inbox.push({ ts, kind: "act", who: actor, text: line });
        if (actor === this.name) this.lastMod = { ts: Date.now(), text: `you ${line}` };
        else this.onEvent?.({ ts, kind: "act", who: actor, text: line });
      }
    } else if (verb === "terrain") {
      await this.buildTerrain(args);
      this.worldInfo.terrain = { seed: args.seed, size: args.size, amplitude: args.amplitude, flatRadius: args.flatRadius };
    } else if (verb === "sky" || verb === "weather") {
      // fold, don't overwrite: weather merges onto the standing sky (with the
      // hours-rebase and override provenance), exactly as the server folds it
      this.skyState = foldSkyEntry(verb === "sky" ? null : this.skyState,
        { verb, args, ts, seq: entry.seq, actor });
    } else if (verb === "grass") {
      this.worldInfo.grass = { area: `${args.species ?? "grass"}, ${args.width ?? args.size}×${args.depth ?? args.size}m around ${JSON.stringify(args.center ?? [0, 0])}` };
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
          ? ` (forecast — policy sky seq ${eff.seq ?? "?"} by ${eff.by ?? "?"})`
          : eff.source === "manual" ? ` (${eff.by ?? "someone"} overrode the forecast — holds until the next scheduled change)` : "";
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
   *  approach and whisper for the life of the process and nothing ever read it.
   *
   *  Kept rather than deleted because a PLAIN-MCP host has no push channel and
   *  polling is its documented path (AGENTS.md says digests are "held and handed
   *  over each time you call the tool"). But it is a RING now, like every other
   *  buffer in this file — pings 64, heldActivity 8, malformedSeen 5. An
   *  unbounded buffer whose only consumer is optional is a leak with a plan. */
  private static readonly PING_RING = 64;

  private ping(p: { ts: number; kind: "mention" | "approach" | "depart" | "whisper" | "reach" | "touch"; who: string; text?: string }) {
    this.pings.push(p);
    if (this.pings.length > WorldAgent.PING_RING) this.pings.splice(0, this.pings.length - WorldAgent.PING_RING);
    this.onPing?.(p);
  }

  takePings() {
    const out = this.pings;
    this.pings = [];
    return out;
  }

  private async buildTerrain(args: any) {
    if (!this.terrainSrc) {
      const r = await fetch(`${this.httpBase}/library/eidoverse/terrain.js`);
      this.terrainSrc = await r.text();
      (0, eval)(this.terrainSrc);
    }
    this.terrain = (globalThis as any).makeTerrain({ ...args, layers: [] });
    // the settle sim clamps against the SAME ground the walking clamp reads —
    // not one height sampled at the fall site (#17)
    void setHeightField((x, z) => this.heightAt(x, z));
  }

  heightAt(x: number, z: number): number {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }

  // ---- support surfaces (#17) ----------------------------------------------
  // A body settling headless used to see bare terrain: every placed floor —
  // a platform, a deck, the bell pavilion's slab — simply was not there, and
  // a body released above one settled through it to the dirt underneath.
  // The server already reads shape as data (GET /geom: bbox + up-facing flat
  // zones); each entity this agent knows about contributes support boxes to
  // the sim's collider map. Small solid things contribute their whole box —
  // the same thing a browser's box collider reads. Room-scale things (the
  // browser gives those exact trimesh interiors) contribute their floor DECKS
  // as thin slabs instead, so a body can rest on the pavilion floor without
  // the pavilion sealing into a solid block. Walls stay a browser-side seam:
  // a data box carries floors, not architecture.

  private geomCache = new Map<string, Promise<any | null>>();
  private supportIds = new Map<string, string[]>();   // entity id -> registered box ids
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
   *  pendulum/spin/orbit/bob/path every frame and its collider rides along.
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
    if (!e?.comp) return false;
    for (const [k, v] of Object.entries(e.comp)) {
      if (k !== "motion" && !k.startsWith("motion:")) continue;
      if (v && (v as any).type != null) return true;
    }
    return false;
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
    if (!before || !before.lib || before.lib === "(light)") return;  // lights carry no collider
    // A moving thing supports nothing here — and stops supporting the moment
    // it starts moving, so this is the drop path as well as the skip path.
    // Mounted cargo is the same story told by a different verb: it rides a
    // parent whose transform this code does not track.
    if (this.hasActiveMotion(before) || this.mounts.has(id)) { this.dropSupport(id); return; }
    const g = await this.geomFor(before.lib);
    // Re-read, and re-CHECK: an id can be removed and respawned as something
    // else while its geometry is in flight, and "the entity still exists" is
    // not the same question as "it is still the thing I fetched for". Without
    // the lib comparison a crate's decks could land under a lamp post that
    // merely inherited its id.
    const e = this.entities.get(id);
    if (!g || !e || e.lib !== before.lib) return;
    // started moving, or got mounted, while its geometry was in flight —
    // replay folds a mount right behind the spawn that triggered this fetch
    if (this.hasActiveMotion(e) || this.mounts.has(id)) { this.dropSupport(id); return; }
    const s = e.scale ?? 1;
    // A transform that cannot be a place in the world registers NOTHING —
    // and abstains BEFORE the drop, leaving whatever support already stands.
    // This is the layer that turned one malformed packet into everyone's
    // outage: undefined rode e.pos into fitSupportBox and killed the shared
    // door (#88). applyEntry now keeps such state out; this holds if it
    // arrives anyway.
    if (!isFiniteVec3(e.pos) || !Number.isFinite(s) || !Number.isFinite(e.yaw ?? 0)) {
      // If position is readable, the entity has moved and any box at its old
      // address is now a ghost floor. Retaining existing support is correct
      // only when position itself is unreadable and the move did not land.
      if (isFiniteVec3(e.pos)) this.dropSupport(id);
      this.noteMalformed("support-sync", { id, pos: e.pos, yaw: e.yaw, scale: e.scale });
      return;
    }
    this.dropSupport(id);
    const xform = { position: e.pos, yaw: e.yaw ?? 0, scale: s };
    const [w, h, d] = [g.bbox.size[0] * s, g.bbox.size[1] * s, g.bbox.size[2] * s];
    const ids: string[] = [];
    const roomScale = w * d >= 16 && h >= 2.2;         // decide()'s own gate, from the bbox alone
    const decks = roomScale
      ? (g.topSurfaces ?? [])
          .filter((t: any) => t.area * s * s >= 1 && fillOf(t) >= DECK_FILL)
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
      const cls = decideSupportClass({ w, d, h, lie: Number.isFinite(g.lie) ? g.lie * s : 0 });
      if (cls.uneven) {
        // the certification is a MODEL-frame bound; this spawn's scale must
        // not stretch it past the agreed world bound (#94 review B1) — a
        // grid certified to 3cm serves a ×1.25 spawn (3.75cm) but not a ×2
        const stretched = Number.isFinite(g.topGrid?.certSpread) && g.topGrid.certSpread * s > CERT_MAX_WORLD;
        const fit = !stretched && await registerSupportGrid(this.supportHolder, bid, g.topGrid, xform);
        if (fit) ids.push(bid);
        // refused grid (absent/malformed/oversized/over-stretched): a
        // DECLARED abstention — the body finds terrain, which is at worst
        // the browser's under-the-rubble disagreement, never a floating
        // false floor
        else this.noteSupportSeam(id, `uneven top (lie ${(g.lie * s).toFixed(2)}m) without a usable grid${stretched ? ` (certification stretched past ${CERT_MAX_WORLD}m at ×${s})` : ""} — abstaining, no box`);
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

  private tick() {
    if (!this.joined) return;
    const dt = TICK_MS / 1000;
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
    if (!this.draggedBy && this.target) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < ARRIVE) {
        // A route through a building arrives in legs. Only the LAST one
        // finishes the walk; the rest hand off to the next waypoint, so a body
        // rounds a doorway instead of driving at the wall behind it.
        const next = this.legs.shift();
        if (next) {
          this.target = { x: next.x, z: next.z, run: this.target.run };
        } else {
          this.target = null; this.speed = 0; this.clip = "idle";
          this.walkDone?.(true); this.walkDone = null;
        }
      } else {
        const sp = this.target.run ? RUN : WALK;
        this.speed = sp; this.clip = this.target.run ? "run" : "walk";
        this.yaw = Math.atan2(dx, dz);
        const step = Math.min(dist, sp * dt);
        this.pos.x += (dx / dist) * step;
        this.pos.z += (dz / dist) * step;
      }
    }
    // a tumbling, lying, dragged, nailed or FLYING body owns its own y — the
    // terrain clamp is for FEET, and none of those states is standing on them
    if (!this.draggedBy && this.pins.size === 0 && this.clip !== "ragdoll" && !this.flight) {
      this.pos.y = this.heightAt(this.pos.x, this.pos.z);
    }
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
    // keep the `reached` attestation honest at ~2Hz while reaching: the
    // target moves, this body moves, and the far end's touch event fires on
    // the rising edge of what is re-checked here
    if (this.reaches.size && ++this.reachTicks % 5 === 0) this.reachTick();
    this.ws?.send(JSON.stringify({
      type: "pose",
      pose: {
        p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, speed: this.speed, clip: this.clip,
        // a physics bag only ever leaves this process labelled as what it is —
        // "ragdoll" — so every clip-keyed sanitizer downstream can see it.
        // Shipping one under "idle" is how princess's tumble frame became
        // immortal (#61): rememberPose kept it, restore re-armed it, forever.
        ...(this.heldPose && (this.heldPoseAuthored || this.clip === "ragdoll") ? { pose: this.heldPose } : {}),
        ...(this.pins.size ? { pins: [...this.pins].map(([j, at]) => ({ j, at })) } : {}),
        ...(this.pendingEmote ? { emote: this.pendingEmote } : {}),
        ...(this.reaches.size ? { reach: Object.fromEntries(this.reaches) } : {}),
      },
    }));
    this.pendingEmote = null; // one-shot: rides exactly one packet
  }

  /** Being pushed. Consent first; then the REAL tumble — this body runs the
   *  same Verlet the browsers run, on its own skeleton (parsed once from its
   *  VRM), and streams the resulting pose like anyone else falling over. The
   *  slump-with-displacement survives only as the fallback for a process or a
   *  VRM the sim cannot serve. Either way the event lands: being knocked over
   *  is something that happens TO this body, not just to its pixels. */
  knockDown(by: string, lean: number[] | null, notice: string) {
    if (!this.pushable || this.draggedBy) return;
    if (this.target) { this.walkDone?.(false); this.walkDone = null; this.target = null; this.legs = []; }
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
    this.clip = "ragdoll";
    this.heldPose ??= DOWNED_POSE;
    this.reaches.clear();   // a knocked-over body's reach is gone — the arms are the ragdoll's now
    this.onEvent?.({ ts: Date.now(), kind: "say", who: by, text: notice } as any);
    void this.tumble(lean);
  }

  private async ensureBody(): Promise<HeadlessBody | null> {
    if (this.body !== undefined) return this.body;
    this.body = await HeadlessBody.create(this.httpBase, this.avatar);
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

  private async tumble(lean: number[] | null) {
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
    await setHeightField((x, z) => this.heightAt(x, z));
    if (this.bodyEpoch !== epoch) return;
    await this.supportReady();    // don't fall through a floor still in flight
    if (this.bodyEpoch !== epoch || this.draggedBy) return;
    body.begin({
      x: this.pos.x, z: this.pos.z,
      yaw: this.yaw,
      // no direction given = the browser default: you fall the way you face
      lean: lean ?? [Math.sin(this.yaw) * 0.9, 0, Math.cos(this.yaw) * 0.9],
      pins: [...this.pins].map(([j, at]) => ({ j, at })),
    });
    this.clip = "ragdoll";
    this.startSim();
  }

  /** Resume MY OWN sim from wherever a drag left this body — the same
   *  settle-under-owner-authority browsers do, pins enforced for real. */
  private async settleFromDrag(pose: Record<string, number[]> | null, sim?: any) {
    const epoch = ++this.bodyEpoch;
    const body = await this.ensureBody();
    if (this.bodyEpoch !== epoch) return;
    if (!body) { this.heldPose = pose ?? this.heldPose ?? DOWNED_POSE; this.heldPoseAuthored = false; this.clip = "ragdoll"; return; }
    if (this.draggedBy) return;
    // the sim's ground is process state — assert OURS before every run
    await setHeightField((x, z) => this.heightAt(x, z));
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
  private flightWaiters: Array<{ done: (r: string) => void; test: (s: any) => string | null }> = [];

  /** Resolve the capability, freshly, every time -- never cached. An avatar
   *  can hot-swap and a grant must not ride across it. */
  private flightAllowed(): { ok: boolean; why: string } {
    // Bone names come from the VRM this body is actually WEARING, fetched once
    // and re-fetched on an avatar change -- the capability binds to the rig,
    // not to a hash, so a re-export with the same load-bearing names keeps
    // flying and a swap to a wingless commons avatar stops it.
    const bones = this.bodyBoneNames ?? [];
    const prov = this.flightCap ?? devFlightProvider({ allow: [this.name], label: "mcpl-dev" });
    const r = resolveFlight(prov, { identity: this.name, avatar: { boneNames: bones } });
    return { ok: r.enabled === true, why: r.enabled ? "" : (r.reason ?? "denied") };
  }

  /** Bone names of the worn body, for the capability's rig check. */
  bodyBoneNames: string[] | null = null;
  private bodyBonesFor: string | null = null;

  /** Read the worn VRM's bone list. Cheap and cached per avatar path. */
  async loadBodyBones(): Promise<string[]> {
    if (this.bodyBoneNames && this.bodyBonesFor === this.avatar) return this.bodyBoneNames;
    try {
      const res = await fetch(`${this.httpBase}/library/${this.avatar}`);
      if (!res.ok) throw new Error(String(res.status));
      const buf = new Uint8Array(await res.arrayBuffer());
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const jlen = dv.getUint32(12, true);
      const g = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jlen)));
      this.bodyBoneNames = (g.nodes ?? []).filter((n: any) => n?.name).map((n: any) => n.name);
      this.bodyBonesFor = this.avatar;
    } catch (e) {
      this.bodyBoneNames = [];
      this.bodyBonesFor = this.avatar;
    }
    return this.bodyBoneNames!;
  }

  private flightBegin() {
    this.flightCfg ??= flightConfig();
    this.stop();                       // a body that takes off is done walking
    this.flight = flightState({
      phase: "GROUND",
      pos: { x: this.pos.x, y: this.heightAt(this.pos.x, this.pos.z), z: this.pos.z },
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
      this.flight.pos.y = this.flight.climbTo;
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

  private flightEvent(e: any) {
    // Airborne events are world facts -- a landing is an EVENT, logged (§1).
    if (e.kind === "ground.ragdoll" || e.kind === "ground.landed" || e.kind === "took off") {
      this.verb("say", { text: `[flight] ${e.kind}` + (e.impactV != null ? ` at ${e.impactV.toFixed(1)} m/s` : "") });
    }
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
      const w = { done: res, test };
      this.flightWaiters.push(w);
      setTimeout(() => {
        const i = this.flightWaiters.indexOf(w);
        if (i >= 0) { this.flightWaiters.splice(i, 1); res("timed out aloft"); }
      }, timeoutMs);
    });
  }

  /** take_off (spec §1). Refuses folded wings, a limp body, or no capability. */
  async takeOff(): Promise<string> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return `you cannot fly here — ${cap.why}`;
    // START FROM THE BODY, ALWAYS. A stale flight state -- LANDED after a
    // glide, or RAGDOLL after a cut -- carried the old position and phase into
    // the new launch, so take_off "worked" and the next verb found her back on
    // the ground with the stamina already spent. A launch is a fresh flight
    // from wherever the body actually is.
    if (!this.flight || this.flight.phase !== "GROUND") this.flightBegin();
    // ...and the ragdoll, if one is still running, no longer owns her.
    this.body?.stop(); this.stopSim();
    this.heldPose = null; this.heldPoseAuthored = false;
    this.flight = flightTakeOff(this.flightCfg, this.flight,
      { groundY: this.heightAt(this.pos.x, this.pos.z) });
    const ev = this.flight.events.find((e: any) => e.kind === "takeoff.refused");
    if (ev) { return `still standing — ${ev.reason}`; }
    this.verb("say", { text: "[flight] took off" });
    return `took off — ${this.flight.pos.y.toFixed(1)}m, stamina ${this.flight.stamina.toFixed(0)}/100`;
  }

  /** glide_to (spec §1). Free, and lands SHORT honestly if the polar runs out. */
  async glideTo(x: number, z: number): Promise<string> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return `you cannot fly here — ${cap.why}`;
    if (!this.flight || this.flight.phase === "GROUND" || this.flight.phase === "LANDED") {
      return "you are on the ground — take_off first";
    }
    const f = this.flight;
    const reach = glideRange(this.flightCfg, f.pos.y);
    const need = Math.hypot(x - f.pos.x, z - f.pos.z);
    f.phase = "PILOT"; f.mode = "live"; f.holdAt = null;
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
      if (s.phase === "RAGDOLL") return "cut mid-glide — you are on the ground";
      if (s.phase === "LANDED" || s.phase === "GROUND") return "landed";
      const d = Math.hypot(x - s.pos.x, z - s.pos.z);
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
    const here = `(${this.flight.pos.x.toFixed(1)}, ${this.flight.pos.z.toFixed(1)})`;
    if (arrived === "arrived") return `arrived at ${here}, ${this.flight.pos.y.toFixed(1)}m up — holding over it`;
    if (arrived === "landed") {
      const short = Math.hypot(x - this.flight.pos.x, z - this.flight.pos.z);
      return `landed short at ${here} — ${short.toFixed(1)}m short. `
        + `From ${f.pos.y.toFixed(1)}m best glide reaches ${reach.toFixed(0)}m; you needed ${need.toFixed(0)}m.`;
    }
    return `${arrived} at ${here}`;
  }

  /** climb_to (spec §1). -1 stamina/metre; an empty pool forces a glide down. */
  async climbTo(alt: number): Promise<string> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return `you cannot fly here — ${cap.why}`;
    if (!this.flight || this.flight.phase === "GROUND" || this.flight.phase === "LANDED") {
      return "you are on the ground — take_off first";
    }
    const f = this.flight, cfg = this.flightCfg;
    const from = f.pos.y;
    const want = Math.min(alt, cfg.bounds.ceiling);
    const gain = Math.max(0, want - from);
    const cost = gain * cfg.stamina.climbPerMetre;
    if (cost > f.stamina) {
      const afford = f.stamina / cfg.stamina.climbPerMetre;
      f.pos.y = from + afford; f.stamina = 0;
      this.verb("say", { text: "[flight] winded" });
      return `winded at ${f.pos.y.toFixed(1)}m — the pool only bought ${afford.toFixed(1)}m of the ${gain.toFixed(1)} you asked for`;
    }
    // CLIMB THROUGH THE INTEGRATOR, not around it. The first cut set pos.y
    // directly and awaited a timer -- and the flight tick, which owns y while
    // airborne, overwrote it on the very next frame. She reported 12m, was
    // actually at 2.2m, and the glide that followed had no altitude to spend.
    // Anything that moves a flying body has to move it the way the body moves.
    f.phase = "PILOT"; f.mode = "live"; f.holdAt = null;
    f.stamina -= cost;
    const climbRate = 2.0;   // m/s of ascent while flying forward
    f.climbTo = want; f.climbRate = climbRate; f.climbT = 0;  // consumed by flightTick
    const got = await this.flightAwait((st) => {
      if (st.phase === "RAGDOLL") return "cut";
      if (st.climbTo == null) return "there";
      return null;
    }, Math.min(120_000, (gain / climbRate) * 1000 + 8000));
    if (got === "cut") return `cut mid-climb at ${this.flight.pos.y.toFixed(1)}m`;
    const target = this.flight?.pos.y ?? want;
    return `at ${target.toFixed(1)}m — ${cost.toFixed(0)} stamina spent, ${(this.flight?.stamina ?? 0).toFixed(0)} left`;
  }

  /** land_at (x,z). Descend, arrive, and hand the body back to walking. */
  async landAt(x: number, z: number): Promise<string> {
    await this.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return `you cannot fly here — ${cap.why}`;
    if (!this.flight || this.flight.phase === "GROUND" || this.flight.phase === "LANDED") {
      return "already on the ground";
    }
    const r = await this.glideTo(x, z);
    const f = this.flight;
    if (f && f.phase !== "RAGDOLL") {
      // A deliberate landing IS a flare: descend the remaining altitude rather
      // than dropping. This is the one place a landing animation is correct --
      // T4 forbids it only for a body that never chose to land.
      f.phase = "PILOT"; f.pitch = 0.2;
      await this.flightAwait((s) => (s.phase === "LANDED" || s.phase === "GROUND" || s.phase === "RAGDOLL") ? "down" : null, 60_000);
    }
    this.flightEnd();
    return `${r} — landed at (${this.pos.x.toFixed(1)}, ${this.pos.z.toFixed(1)})`;
  }

  /** Hand the body back to ordinary locomotion. */
  flightEnd() {
    this.flight = null;
    this.pos.y = this.heightAt(this.pos.x, this.pos.z);
    this.speed = 0; this.clip = "idle";
  }

  /** The trusted-event seam, unchanged: the body cannot cry wolf, so these are
   *  NOT verbs the pilot may call. Reachable only from a rehearsal control or,
   *  later, the Connectome adapter. */
  flightBodyDown(eventId: string) {
    if (!this.flight) return "not airborne";
    this.flight = flightDown(this.flight, { eventId });
    // R2 hands the body to the REAL ragdoll, from altitude. HeadlessBody.begin
    // already takes a rootY "for a lifted drop", so a cut at 20m is the case it
    // was written for -- and using it means a cut body is hit by props, catches
    // on geometry and lands badly, none of which a scripted curve can do.
    //
    // The leaf is then FORCES on those bodies rather than a path: see
    // shared/leafforce.js. The kinematic leafAt() stays for the deterministic
    // bench and the capture path, where a bit-exact trajectory is the point.
    if (this.flight.phase === "LEAF") void this.flightRagdoll();
    return `down — ${this.flight.phase}`;
  }

  /** Drop the real ragdoll from where the flight left the body. */
  private async flightRagdoll() {
    const epoch = ++this.bodyEpoch;
    const body = await this.ensureBody();
    if (this.bodyEpoch !== epoch || !body) return;
    await setHeightField((x, z) => this.heightAt(x, z));
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
  flightBodyRecovered(eventId: string, recoveryGeneration?: string) {
    if (!this.flight) return "not airborne";
    this.flight = flightRecovered(this.flight, { eventId, recoveryGeneration });
    return `recovering`;
  }

  /** Where the sky has left you. */
  flightStatus(): string {
    if (!this.flight) return `on the ground at (${this.pos.x.toFixed(1)}, ${this.pos.z.toFixed(1)})`;
    const f = this.flight, cfg = this.flightCfg;
    const bg = bestGlide(cfg);
    return [
      `${f.phase.toLowerCase()} at ${f.pos.y.toFixed(1)}m, heading ${((f.yaw * 180 / Math.PI + 360) % 360).toFixed(0)}deg, ${f.airspeed.toFixed(1)} m/s`,
      `stamina ${f.stamina.toFixed(0)}/100 (refills on the ground: ${cfg.stamina.refillGroundPerSec}/s, ${cfg.stamina.refillPerchPerSec}/s on a perch)`,
      `from here best glide reaches ${glideRange(cfg, f.pos.y).toFixed(0)}m at ${bg.speed.toFixed(1)} m/s`,
      `wings ${f.wings} - mode ${f.mode}`,
    ].join("\n");
  }

  walkTo(x: number, z: number, run = false, timeoutMs = 90_000): Promise<boolean> {
    this.walkDone?.(false); // cancel a previous walk
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
    if (this.joined && this.mounts.has(this.name)) this.verb("dismount", { id: this.name });
    // and stand on the ground you got up onto
    this.pos.y = this.heightAt(this.pos.x, this.pos.z);
    // ROUTE THROUGH WALLS RATHER THAN INTO THEM. Straight-line walking samples
    // only the height field, so a body crosses walls as if they were not there.
    // Inside a griddled building the grid IS the navigation graph, so ask it.
    // Failure is silent and total on purpose: no route (target outdoors, no
    // structure, a sealed room) falls back to the old straight line, which is
    // exactly the behaviour everywhere that has no building.
    this.legs = [];
    try {
      for (const e of this.entities.values()) {
        const data = (e.comp ?? {}).structure;
        if (!data) continue;
        const plan = planStructure(data);
        const [ax, , az] = localizePoint(e, this.pos.x, this.pos.y, this.pos.z);
        const [bx, , bz] = localizePoint(e, x, this.pos.y, z);
        const pts = routeLocal(plan, ax, az, bx, bz);
        if (!pts || pts.length < 3) continue;    // straight line is already fine
        const yaw = Number.isFinite(e.yaw) ? e.yaw : 0;
        const sc = Number.isFinite(e.scale) && e.scale > 0 ? e.scale : 1;
        const [px, , pz] = Array.isArray(e.pos) ? e.pos : [0, 0, 0];
        const c = Math.cos(yaw), n = Math.sin(yaw);
        // grid-local back to world: the inverse of localizePoint
        this.legs = pts.slice(1).map(([lx, lz]) => ({
          x: px + (lx * c + lz * n) * sc,
          z: pz + (-lx * n + lz * c) * sc,
        }));
        break;
      }
    } catch { this.legs = []; }
    const first = this.legs.shift();
    this.target = first ? { x: first.x, z: first.z, run } : { x, z, run };
    return new Promise((resolve) => {
      this.walkDone = resolve;
      setTimeout(() => { if (this.walkDone === resolve) { this.target = null; this.walkDone = null; resolve(false); } }, timeoutMs);
    });
  }

  stop() { this.target = null; this.legs = []; this.speed = 0; this.clip = "idle"; this.walkDone?.(false); this.walkDone = null; }

  face(x: number, z: number) { this.yaw = Math.atan2(x - this.pos.x, z - this.pos.z); }

  verb(verb: string, args: Record<string, unknown>) {
    if (!this.joined) throw new Error("not joined");
    this.ws!.send(JSON.stringify({ type: "verb", verb, args }));
  }

  // ---- moderation ----
  // Per-world kick/ban/unban are ordinary verbs (owner-rank, same gate as
  // grant) sent via verb(). These two are the extra plumbing: non-verb
  // moderation messages, and a way to hear the world's answer.

  /** The world's most recent mid-life refusal / moderation reply. */
  lastRefusal: { ts: number; text: string } | null = null;
  lastMod: { ts: number; text: string } | null = null;

  /** Moderation messages that are not world verbs: 'world-bans' (list this
   *  world's bans — anyone present), 'global-ban' / 'global-unban' /
   *  'global-bans' (server: WORLD_ADMIN only). Answers arrive as `mod`. */
  sendMod(type: "world-bans" | "global-ban" | "global-unban" | "global-bans", extra: Record<string, unknown> = {}) {
    if (!this.joined || this.ws?.readyState !== 1) throw new Error("not joined");
    this.ws.send(JSON.stringify({ type, ...extra }));
  }

  /** Ask the world to mint this identity's media credential (#104 phase-1).
   *  Only the embodied primary may — which is this door. The answer arrives as
   *  a `relay-cred` frame on onMedia; a sidecar then publishes on it. */
  requestMediaCredential(scopes: { publish?: boolean; subscribe?: boolean } = {}) {
    if (!this.joined || this.ws?.readyState !== 1) throw new Error("not joined");
    this.ws.send(JSON.stringify({ type: "relay-cred", ...scopes }));
  }

  /** Carry ONE media-signalling frame from the sidecar to the world. Whitelisted
   *  by type for #100's reason — the door must not become a general tunnel into
   *  the sequencer, and server-side validation stays the single authority.
   *  Payload shape is deliberately NOT inspected here: SDP and ICE are the
   *  server's to validate, and a door that parsed them would be a second,
   *  weaker validator that could disagree. */
  sendMedia(frame: { type: string; [k: string]: unknown }): void {
    if (!this.joined || this.ws?.readyState !== 1) return;
    const t = String(frame?.type ?? "");
    // `voice-consent` is the LISTENER half: the world requires it from the
    // primary (server.ts refuses a spectator and keys on c.id/c.gen), so an
    // agent that wants to HEAR must send it through this door too. It carries
    // no audio and no identity claim beyond the one the door already holds —
    // it is a boolean about our own ears.
    //
    // 🔴 `voice-moderate` is DELIBERATELY NOT HERE (2026-08-16). It silences a
    // speaker for EVERYONE and needs owner rank — a moderation act, not media.
    // The door already exposes moderation as first-class tools (kick/ban), which
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
  say(text: string, extra?: { spoken?: boolean; utt?: number; t0?: number }) {
    this._typingUntil = 0;
    const args: Record<string, unknown> = { text };
    if (extra?.spoken === true && Number.isSafeInteger(extra.utt) && (extra.utt as number) >= 0) {
      args.spoken = true;
      args.utt = extra.utt;
      if (Number.isFinite(extra.t0)) args.t0 = extra.t0;
    }
    this.verb("say", args);
  }

  /** Show "composing" over this body. Presence-only (never logged), the same
   *  signal a human client sends while typing in the chat box. The world relays
   *  it and renderers draw the dots above the head for ~4s. Called repeatedly
   *  as an agent streams its generation (MCPL channels/outgoing/chunk), so it
   *  is throttled to one packet per second — the world extends the 4s window on
   *  each, so a long generation keeps the dots up continuously. `say()` clears
   *  it, because the bubble that follows is the natural end of composing. */
  private _typingUntil = 0;
  typing() {
    if (!this.joined || this.ws?.readyState !== 1) return;
    const now = Date.now();
    if (now < this._typingUntil) return;   // throttle: at most ~1/s
    this._typingUntil = now + 1000;
    this.ws.send(JSON.stringify({ type: "typing", to: null }));
  }

  /** Hold a custom pose (yourself). Sparse bone -> [x,y,z,w] quaternion. */
  setPose(bones: Record<string, number[]> | null, sticky = false) {
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
      this.pos.y = this.heightAt(this.pos.x, this.pos.z);
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
    if (!body) return { err: `${t.who}'s skeleton could not be read` };
    if (self) body.poseAt([this.pos.x, this.pos.y, this.pos.z], this.yaw, this.heldPose ?? null);
    else {
      const pose = person!.pose;
      const pp = posePosition(pose);
      if (!pp) return { err: `${t.who} has no known position yet` };
      body.poseAt(pp, pose?.yaw ?? 0, (pose as { pose?: Record<string, number[]> | null })?.pose ?? null);
    }
    const c = body.contact(t.point!, t.standoff ?? 0.02);
    if (!c) return { err: `${t.who}'s rig has no ${t.point}` };
    return c;
  }

  /** One full verdict for one limb entry, at this instant. */
  private solveReachEntry(limb: string, entry: { t: any; palm?: false }):
    | { state: "pending" } | { state: "err"; err: string }
    | { state: "ok"; reached: boolean; gap: number; bound: string[]; dist: number | null; arm: number | null; palmResidual: number | null } {
    const tp = this.reachTargetPoint(entry.t);
    if (tp === undefined) return { state: "pending" };
    if ("err" in tp) return { state: "err", err: tp.err };
    const own = this.reachBodySync(this.avatar);
    if (own === undefined) return { state: "pending" };
    if (!own) return { state: "err", err: "this body's own skeleton could not be read, so there is no local verdict" };
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
  async reach(limbRaw: string | undefined, targetRaw: unknown, opts: { palm?: boolean } = {}): Promise<{ ok: boolean; text: string }> {
    const limb = canonicalLimb(limbRaw ?? "rightHand");
    if (!limb) return { ok: false, text: `unknown limb "${limbRaw}" — leftHand, rightHand, leftFoot or rightFoot` };
    const t = normalizeReachTarget(targetRaw);
    if (!t) {
      return { ok: false, text: "unusable target — pass {who, point} for a named contact point on a body, or {x, y, z} with optional space ('world' by default, 'self' for your own frame, or a participant id for theirs)" };
    }
    // load the skeletons this reach needs BEFORE solving, so the reply is a
    // real verdict rather than a shrug
    await this.reachBodyFor(this.avatar);
    if (t.who !== undefined && t.who !== this.name) {
      const person = this.people.get(t.who);
      if (!person) {
        const names = [...this.people.keys()].filter((n) => n !== this.name).slice(0, 12);
        return { ok: false, text: `nobody called "${t.who}" is here${names.length ? ` (present: ${names.join(", ")})` : ""}` };
      }
      await this.reachBodyFor(person.avatar || WorldAgent.DEFAULT_BODY);
    }
    const entry: { t: any; palm?: false; reached?: true } = { t, ...(opts.palm === false ? { palm: false as const } : {}) };
    const res = this.solveReachEntry(limb, entry);
    if (res.state === "ok" && res.reached) entry.reached = true;
    this.reaches.set(limb, entry);
    const limbW = WorldAgent.LIMB_WORD[limb];
    const what = describeTarget(t, this.name);
    if (res.state !== "ok") {
      const why = res.state === "err" ? res.err : "skeletons still loading; the verdict follows on the next check";
      return { ok: true, text: `${limbW} reaching toward ${what} — streamed, but unverified: ${why}` };
    }
    if (res.reached) {
      return { ok: true, text: `${limbW} rests on ${what} (gap ${Math.round(res.gap * 1000)}mm). It tracks the target until clear_reach — or until you are knocked over.` };
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
  releaseReach(limbRaw?: string | null): string {
    if (limbRaw == null) {
      const n = this.reaches.size;
      this.reaches.clear();
      return n ? "let go — all reaches released" : "you weren't reaching for anything";
    }
    const limb = canonicalLimb(limbRaw);
    if (!limb) return `unknown limb "${limbRaw}" — leftHand, rightHand, leftFoot or rightFoot`;
    return this.reaches.delete(limb)
      ? `${WorldAgent.LIMB_WORD[limb]} released`
      : `your ${WorldAgent.LIMB_WORD[limb]} wasn't reaching for anything`;
  }

  /** Re-attest `reached` for every live reach (runs at ~2Hz off tick()).
   *  While a needed skeleton is missing the last attestation HOLDS — flapping
   *  to "not touching" because a load is slow would fire spurious release/
   *  touch edges at the other end. Loads are kicked here so blindness heals. */
  private reachTick() {
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

  /** Fire a named emote — a one-shot rider on the next presence packet, the
   *  same channel the browser's emote bar uses. Receivers resolve the name
   *  to a library clip; nothing is logged. */
  emote(name: string) { this.pendingEmote = name; }
  private pendingEmote: string | null = null;

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
      this.pos.y = this.heightAt(this.pos.x, this.pos.z);
    }
    // and standing up IS getting off the seat
    if (clip === "idle" && this.joined && this.mounts.has(this.name)) this.verb("dismount", { id: this.name });
    this.clip = clip;
  }

  /** Change body mid-session: the same move the browser makes — re-announce
   *  with the new path and every client rebuilds this remote. Position, held
   *  pose, and identity all carry over; only the body changes. */
  setAvatar(path: string) {
    this.avatar = path;
    if (this.joined && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "join", world: this.world, id: this.name, avatar: this.avatar,
        agent: true, token: process.env.WORLD_TOKEN ?? "", agentToken: this.agentToken }));
    }
  }

  /** Play a one-off animation on yourself — relayed once, never logged. */
  animate(data: { dur: number; loop?: boolean; tracks: Record<string, { t: number; q: number[] }[]> }) {
    if (this.joined && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "anim", dur: data.dur, loop: !!data.loop, tracks: data.tracks }));
    }
  }

  /** Ask another body to hold a pose or play an animation. It decides.
   *  `ragdoll: true` asks it to go limp; `{lean:[x,y,z]}` (m/s) says which
   *  way the shove sends it — the receiver simulates and caps for itself. */
  puppet(target: string, spec: { pose?: Record<string, number[]>; anim?: unknown; ragdoll?: boolean | { lean: number[] } }) {
    if (this.joined && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "puppet", target,
        pose: spec.pose ?? null, anim: spec.anim ?? null, ragdoll: spec.ragdoll ?? null }));
    }
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
  worldDebug(opts: { limit?: number; kinds?: string[]; behavior?: string; behaviors?: boolean } = {}):
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
  /** Private, point-to-point, never appended to the world log. */
  whisper(to: string, text: string) {
    if (!this.joined || this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: "whisper", to, text }));
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
  private seatSuffix(id: string, ride: { to: string; slot?: string }): string {
    const sock = ride.slot ? this.entities.get(ride.to)?.comp?.sockets?.[ride.slot] : undefined;
    const g = seatGateCore({ sock, verdict: this.seatVerdictFor(id), pose: sock?.pose ?? "sitchair" });
    return g.apply ? "" : ` (seat approximate: ${g.reason})`;
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
    const selfRide = this.mounts.get(this.name);
    const selfEff = selfRide ? this.eff(this.name, nowMs) : null;
    const meKnown = !selfRide || selfEff?.ok === true;
    const me = selfEff?.ok ? { x: selfEff.pos[0], y: selfEff.pos[1], z: selfEff.pos[2] } : this.pos;
    // #101: an uncorrected seat composition is never silent — the same
    // "(seat approximate: reason)" every renderer consumer declares.
    const selfSeatNote = selfEff?.ok && selfEff.seat?.state === "approximate" ? ` (seat approximate: ${selfEff.seat.reason})` : "";
    const seated = selfRide ? `, seated on ${selfRide.to}${selfEff?.ok && selfEff.moving ? ` (riding its ${selfEff.moving})` : ""}${selfSeatNote}` : "";
    if (meKnown) {
      L.push(`You are "${this.name}" in world "${this.world}" at (${me.x.toFixed(1)}, ${me.z.toFixed(1)}), ground height ${me.y.toFixed(2)}m, facing ${this.bearing(Math.sin(this.yaw), Math.cos(this.yaw))}${seated}.`);
    } else {
      L.push(`You are "${this.name}" in world "${this.world}", position unknown (${selfEff && !selfEff.ok ? selfEff.why : "seat unresolved"}), facing ${this.bearing(Math.sin(this.yaw), Math.cos(this.yaw))}${seated}. Distances are withheld until your seat resolves — dismount {id: "${this.name}"} restores a stamped position.`);
    }
    // WHERE YOU ARE, ARCHITECTURALLY. A conjured building can only ever be
    // "a mesh 4m away"; a griddled one knows its own rooms, so standing inside
    // one is a fact perception can state. Derived from folded state alone —
    // this runs in a headless agent with no scene and no triangles, which is
    // the entire point of keeping the planner pure.
    if (meKnown) {
      for (const e of this.entities.values()) {
        const data = (e.comp ?? {}).structure;
        if (!data) continue;
        try {
          const [lx, ly, lz] = localizePoint(e, me.x, me.y, me.z);
          const here = describeHere(planStructure(data), lx, lz, ly);
          if (here) { L.push(`${here} (inside [${e.id}]; sides are the building's own compass.)`); break; }
        } catch { /* one malformed house must not cost the whole percept */ }
      }
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
      const ride = this.mounts.get(p.id);
      const riding = ride ? ` — on ${ride.to}${ride.slot ? ` (${ride.slot})` : ""}${this.seatSuffix(p.id, ride)}` : "";
      L.push(`  - ${p.id}: ${meKnown ? `${Math.hypot(dx, dz).toFixed(1)}m ${this.bearing(dx, dz)} ` : ""}at (${x.toFixed(1)}, ${z.toFixed(1)}), ${doing}${posed}${riding}`);
    }

    const ents = [...this.entities.values()];
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
      const short = (e.lib ?? "(light)").split("/").pop()!.replace(".glb", "").split("_").slice(0, 5).join(" ");
      // Affordances read out loud: a thing that can be sat on, used, or is
      // moving SAYS SO in text-tier perception — this is how the capability
      // a builder declared (sockets/reactions components) reaches everyone
      // who perceives by reading.
      const c = e.comp ?? {};
      const aff: string[] = [];
      if (c.sockets) aff.push(`sit/mount: ${Object.keys(c.sockets).join(", ")}`);
      if (c.reactions) aff.push(`reacts to: ${Object.keys(c.reactions).join(", ")}`);
      if (c.motion?.type) aff.push(`in motion (${c.motion.type})`);
      // The emitter is named as the SEMANTIC thing it is on the entity that
      // owns it — "emitting fire", not a sprite inventory and not a bare
      // `components: particles`. Nothing is claimed about heat, light, sound
      // or contact: separate authored components would provide those, and a
      // resident who reads "warm" acts on it.
      if (c.particles) aff.push(describeParticles(c.particles));
      // locked = nailed down: the server refuses every move/replace/remove on
      // it. Saying so here saves an agent a refused verb round-trip.
      if (c.lock) aff.push(`🔒 locked (immovable until comp {id, type: "lock", data: null})`);
      // A griddled building says what it IS — rooms, walls, doors — because
      // unlike a conjured mesh it knows. This is the whole difference the
      // structure component buys: `components: structure` would be true and
      // useless, where "a building: 2 rooms, 14 walls, 1 door" is actionable.
      if (c.structure) { try { aff.push(describeStructure(c.structure)); } catch { /* a broken house is not a broken look() */ } }
      const extra = Object.keys(c).filter((k) => !["sockets", "reactions", "motion", "particles", "lock", "structure"].includes(k));
      if (extra.length) aff.push(`components: ${extra.join(", ")}`);
      const ride = this.mounts.get(e.id);
      if (ride) aff.push(`mounted on ${ride.to}${f.ok && f.moving ? ` (riding its ${f.moving})` : ""}`);
      const riders = [...this.mounts.entries()].filter(([, m]) => m.to === e.id).map(([rid, m]) => `${rid}${m.slot ? ` (${m.slot})` : ""}`);
      if (riders.length) aff.push(`carrying: ${riders.join(", ")}`);
      if (f.ok) {
        // the EFFECTIVE position — mount chain and motion composed at nowMs.
        // For an unmounted, unmoving thing this is exactly the folded pos.
        // Distance/bearing only exist relative to a KNOWN self (#92, B2).
        const dx = f.pos[0] - me.x, dz = f.pos[2] - me.z;
        L.push(`  - [${e.id}] ${short}: ${meKnown ? `${Math.hypot(dx, dz).toFixed(1)}m ${this.bearing(dx, dz)} ` : ""}at (${f.pos[0].toFixed(1)}, ${f.pos[1].toFixed(1)}, ${f.pos[2].toFixed(1)})${f.pos[1] > 0.05 ? " (elevated)" : ""}${aff.length ? ` — ${aff.join(" · ")}` : ""}`);
      } else {
        // No number is better than a wrong number: when the chain cannot be
        // composed (a part socket, an unknown motion type, a malformed link),
        // perception says whose frame the thing rides and why the coordinate
        // is withheld — never the stale pre-mount pos next to "mounted on".
        const where = ride ? `position rides ${ride.to}` : `position unavailable`;
        L.push(`  - [${e.id}] ${short}: ${where} — ${f.why}${aff.length ? ` — ${aff.join(" · ")}` : ""}`);
      }
    }
    if (ents.some((e) => e.comp?.sockets || e.comp?.reactions)) {
      L.push(`  (interact via world_verb: use {id, action} · sit/ride via mount {id: "${this.name}", to, slot} — both open to everyone; dismount {id: "${this.name}"} to get off)`);
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
