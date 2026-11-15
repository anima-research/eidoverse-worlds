// The agent's flight: shared/flight.js's integrator flown at the tick, its courses, its waits, and every way back to the feet.
// Its public members are the body's (one-line delegates in agent.ts), and it calls them there (this.a.x), as before.

import type { WorldAgent } from "./agent.ts";
import { type ActResult, done, refused, isDown, downRefusal, worldYaw, intYaw } from "./agent-result.ts";
import { setHeightField, setWaterField } from "./physics.ts";
// FLIGHT: the same deterministic integrator the browser runs (shared/flight.js), one function in every runtime.
import {
  makeConfig as flightConfig, initialState as flightState, step as flightStep,
  bodyDown as flightDown, bodyRecovered as flightRecovered, takeOff as flightTakeOff,
  foldDown as flightFold, unfold as flightUnfold,
  bestGlide, glideRange, ceilingOf,
} from "../shared/flight.js";
import { resolveFlight, worldFlightProvider } from "../shared/flightcap.js";
import { inspectBody } from "../shared/flightbody.js";

/** How long a flight wait allows for a leg the flight model flies in `legS` seconds of its own time. The tick that
 *  flies it is a timer and runs late under load, so it allows half again, which covers a tick up to 50% late, and
 *  8 s beside for what the leg's rate leaves out, such as a climb's lift easing in. */
const legWaitMs = (legS: number) => Math.round((legS * 1.5 + 8) * 1000);
/** A glide arrives, in the air or touching down, within this many metres of its target, or at its closest approach
 *  once that came inside 12 m (glideTo). */
export const GLIDE_ARRIVE_M = 2.0;
/** Every way out of flight to the feet (endFlight; #298, #300), and its words (flightWords). A take-off from a down
 *  flight replaces it with a fresh one, flight to flight, with no wait left on it (flightDownNow answered them). */
const FLIGHT_ENDS = {
  landed: "came down", walk: "ended by a walk", knockdown: "knocked down", drag: "taken hold of and dragged", seat: "ended by taking a seat",
  closed: "interrupted: the body was closed", link: "interrupted: the link to the world dropped", respawn: "interrupted: you fell out of the world",
  avatar: "ended by a change of body",
} as const;
export type FlightEnd = keyof typeof FLIGHT_ENDS;
/** A wait ended by endFlight is answered with its end's code, not its words, so rewording an end changes no control flow. */
const endCode = (why: FlightEnd) => `ended:${why}`;
const isFlightEnd = (got: string) => got.startsWith("ended:") && got.slice(6) in FLIGHT_ENDS;
/** A wait's answer as it is said: an end's words, else the answer itself. */
const flightWords = (got: string) => isFlightEnd(got) ? FLIGHT_ENDS[got.slice(6) as FlightEnd] : got;
/** The signed turn from heading a to heading b, in (-π, π]. */
const turnTo = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
/** A land course flares (noses up) this high above the ground under it. */
const FLARE_HEIGHT = 2;
/** Why fold_wings can't judge a body whose bones haven't been read. */
const BONES_NOT_KNOWN = "this body's bones aren't known (its model hasn't loaded, or couldn't be read), so whether it has wings can't be checked";
/** shared/flight.js's refusals name the fix as an act — "unfold them first", "land first" — and the browser
 *  has those acts by those names; here they are other tools' presets, so the reply names the call that does it. */
const flightFixInOurTools = (reason: string) => String(reason)
  .replace(/unfold them first/, 'open them first (anim {stop: "wings-folded"})')
  .replace(/land first/, 'land first (act {verb: "land", args: {to: [x, z]}})');

export class AgentFlight {
  constructor(readonly a: WorldAgent) {}

  private flightWaiters: Array<{ done: (r: string) => void; test: (s: any) => string | null }> = [];
  /** Numbers each command put in `flight.course`, the one course the autopilot flies (setCourse; #290). */
  private courseSeq = 0;

  /** Install one server-folded effective-rights answer. If flight was
   * withdrawn while aloft, ownership passes to the visible falling-leaf
   * reflex rather than silently continuing or teleporting to ground. */
  acceptEffectiveRights(rights: any, actor = "world") {
    const hadFly = this.a.myRights?.fly === true;
    this.a.myRights = { ...(rights ?? {}) };
    if (hadFly && this.a.myRights.fly !== true && this.a.flight &&
        this.a.flight.phase !== "GROUND" && this.a.flight.phase !== "LANDED" &&
        this.a.flight.phase !== "RAGDOLL" && this.a.flight.phase !== "LEAF") {
      this.flightDownNow("capability-revoked");
      this.a.inbox.push({ ts: Date.now(), kind: "act", who: actor,
        text: "withdrew your flight while you were aloft, so you're coming down under the falling-leaf reflex; you can fly again once the world's owner grants it" });
    }
  }

  /** Resolve the capability, freshly, every time -- never cached. An avatar
   *  can hot-swap and a grant must not ride across it. */
  private flightAllowed(): { ok: boolean; why: string } {
    // Bone names come from the VRM this body is actually WEARING (re-fetched on
    // an avatar change): the capability binds to the rig, not a hash. A swap ends
    // any flight under way (setAvatar). Until they are read the provider gets no
    // list (unknown), never an empty one (no bones).
    const bones = this.a.bodyBoneNames;
    // THE WORLD'S GRANT, or one injected for a bench (`agent.flightCap`);
    // nothing else grants flight.
    const prov = this.a.flightCap ?? worldFlightProvider({ rights: () => this.a.myRights, label: "world-grant" });
    const r = resolveFlight(prov, { identity: this.a.name, avatar: { boneNames: bones } });
    return { ok: r.enabled === true, why: r.enabled ? "" : (r.reason ?? "denied") };
  }

  private flightBegin(feetY = this.a.pos.y) {
    this.a.flightCfg ??= flightConfig();
    this.a.stop();                       // a body that takes off is done walking
    this.a.flight = flightState({
      phase: "GROUND",
      pos: { x: this.a.pos.x, y: this.a.groundAt(this.a.pos.x, this.a.pos.z, feetY), z: this.a.pos.z },
      // ...in the INTEGRATOR's convention. Seeding it with a world yaw started
      // every flight a quarter-turn off its own heading.
      yaw: intYaw(this.a.yaw),
    }, this.a.flightCfg);
  }

  /** One integrator step, then publish. Ground contact ends the flight (endFlight); a cut hands it to the ragdoll. */
  flightTick(dt: number) {
    // The autopilot flies through the integrator's input seam, as a human's stick does (shared/flightpilot.js).
    const { input, lift } = this.coursePilot(this.a.flight, dt);
    this.a.flight = flightStep(this.a.flightCfg, this.a.flight, dt, {
      input, lift: () => lift,
      groundY: (x: number, z: number) => this.a.heightAt(x, z),
      box: this.a.worldBox(),   // @world.bounds fences and caps flight; none, no fence (shared/flight.js bounds)
    });
    const f = this.a.flight, c = f.course;
    const landed = f.phase === "LANDED" || f.phase === "GROUND";
    if (c?.kind === "climb" && !c.reached && Math.abs(c.alt - f.pos.y) < 0.4) {
      // Met in the air, a climb ends at its height. Met on the ground, it ends where the body stands.
      if (!landed) f.pos.y = c.alt;
      c.reached = true;
    }
    this.a.pos.x = f.pos.x; this.a.pos.y = f.pos.y; this.a.pos.z = f.pos.z;
    // TWO YAW CONVENTIONS, converted at the boundary: the world's atan2(dx, dz), the integrator's atan2(dz, dx).
    this.a.yaw = worldYaw(f.yaw);
    this.a.speed = Math.hypot(f.vel.x, f.vel.z);
    // LIMP reads as a ragdoll, the truth-telling state; a climb flaps ("fly"); a glide hangs on the air ("soar").
    this.a.clip = f.wings === "LIMP" ? "ragdoll" : landed ? "idle" : lift !== 0 ? "fly" : "soar";
    for (const e of f.events) this.flightEvent(e);
    this.flightSettle();
    if (landed) this.a.endFlight("landed");
  }

  /** The current course as the integrator's input, plus a climb's lift (env.lift). Only a PILOT flight is steered. */
  private coursePilot(f: any, dt: number) {
    const input = { bank: 0, pitch: 0, yawRate: 0, flap: false, spoil: false };
    const c = f.course;
    if (!c || f.phase !== "PILOT" || !(dt > 0)) return { input, lift: 0 };
    if (c.kind === "glide") {
      // Re-aimed every tick, so a long leg converges rather than committing to one heading.
      input.yawRate = turnTo(f.yaw, Math.atan2(c.z - f.pos.z, c.x - f.pos.x)) / dt;
    } else if (c.kind === "hold" || c.kind === "land") {
      // HOLDING STATION: an 8 m circle over the point, the tangent led inward by the radius error, so it converges.
      const dx = f.pos.x - c.x, dz = f.pos.z - c.z, R = 8;
      const lead = Math.max(-1.2, Math.min(1.2, (Math.hypot(dx, dz) - R) / R * 1.4));
      input.yawRate = Math.max(-1.5, Math.min(1.5, turnTo(f.yaw, Math.atan2(dz, dx) + Math.PI / 2 - lead) / dt));
    }
    if (c.kind === "land") {
      // A landing comes down on the spoilers and flares its last metres with them in, as main's flare did (#293).
      if (f.pos.y - this.a.heightAt(f.pos.x, f.pos.z) < FLARE_HEIGHT) input.pitch = 0.2; else input.spoil = true;
    }
    let lift = 0;
    if (c.kind === "climb" && !c.reached) {
      // A CLIMB THAT HAS TO BE EARNED: lift, eased in over ~2 s, so the integrator flies it forward and up.
      c.t += dt;
      lift = Math.sign(c.alt - f.pos.y) * c.rate * (1 - Math.exp(-c.t / 1.6));
    }
    return { input, lift };
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
      const r = w.test(this.a.flight);
      if (r == null) still.push(w); else w.done(r);
    }
    this.flightWaiters = still;
  }

  private flightAwait(test: (s: any) => string | null, timeoutMs = 120_000): Promise<string> {
    const now = test(this.a.flight);
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

  /** Put a command in the flight's one course slot (#290): the one it replaces is answered "taken over" now. */
  private setCourse(c: Record<string, unknown>): number {
    const id = ++this.courseSeq;
    this.a.flight.course = { ...c, id };
    this.flightSettle();
    return id;
  }

  /** A wait for course `id`, answered "taken over" once a later command holds the course; a down answers as a down. */
  private courseAwait(id: number, test: (s: any) => string | null, timeoutMs?: number): Promise<string> {
    return this.flightAwait((s) => !isDown(s.phase) && s.course?.id !== id ? "taken over" : test(s), timeoutMs);
  }

  /** The one way out of flight (#298, #300): every wait on it is answered with `why`; a landing stands the feet. */
  endFlight(why: FlightEnd) {
    const waits = this.flightWaiters, vy = this.a.flight?.vel?.y;
    if (this.a.flight && isDown(this.a.flight.phase)) ++this.a.bodyEpoch;   // its ragdoll, still loading (flightRagdoll), never begins
    // A limp flight's slump no sim laid is a canned one: its root is the flight's, at its feet (rootCanned).
    if (this.a.clip === "ragdoll" && !this.a.simTicker && this.a.heldPose == null) this.a.cannedY = this.a.pos.y;
    this.a.flight = null; this.flightWaiters = [];
    for (const w of waits) w.done(endCode(why));
    this.a.speed = 0;
    if (this.a.clip === "fly" || this.a.clip === "soar") this.a.clip = "idle";
    if (why !== "landed") {
      // Ended in the air, the feet are where the flight left them, keeping its vertical speed: they fall (aloft).
      this.a.grounded = !this.a.feetOffGround();
      this.a.vy = !this.a.grounded && Number.isFinite(vy) ? vy : 0;
      return;
    }
    // The floor it comes down on is found from its feet: a body a flight's
    // ragdoll laid down has them RAGDOLL_ROOT_DROP above its root.
    this.a.pos.y = this.a.groundAt(this.a.pos.x, this.a.pos.z, this.a.feetY(this.a.isSlumped()));
    this.a.clip = "idle"; this.a.grounded = true; this.a.vy = 0;
  }

  /** A down (a cut, a withdrawn grant): the flight stays for its recovery, its course goes, and every wait hears now. */
  private flightDownNow(eventId: string) {
    this.a.flight = { ...flightDown(this.a.flight, { eventId }), course: null };
    this.flightSettle();
  }

  /** take_off (spec §1). Refuses folded wings, a limp body, or no capability. */
  async takeOff(): Promise<ActResult> {
    await this.a.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    // Wing posture is carried independently of an active flight state. A body
    // can fold without a propulsion grant, so the sky door checks the public
    // posture before it constructs a fresh integrator.
    if (this.a.wingsFolded) return refused(`still standing — your wings are folded; open them first (anim {stop: "wings-folded"})`);   // shared/flight.js's words, our tool
    // START FROM THE BODY, ALWAYS: a launch is a fresh flight from wherever the
    // body is, never a stale LANDED/RAGDOLL state's position and phase.
    // A limp fall can't be launched out of: the body is in the air, and starting a fresh flight from the
    // ground under it would move it there.
    if (this.a.flight?.phase === "LEAF") return refused(downRefusal(this.a.flight));
    // A body already flying is told so in the integrator's words (shared/flight.js), and flies on as it was (#287).
    if (this.a.airborne() && !isDown(this.a.flight.phase)) return refused(`already airborne (${this.a.flight.phase.toLowerCase()})`);
    // So is one falling, or tumbling in the air, out of a flight: as from a limp fall, no launch from the ground under it.
    if (!this.a.flight && !this.a.grounded && !this.a.myOccupancy && !this.a.draggedBy && this.a.feetOffGround()) return refused('already airborne (falling) — move {mode: "fly"} once you are on the ground');
    // The floor it takes off from is found from its feet, read before the
    // slump that puts them RAGDOLL_ROOT_DROP above the root is cleared.
    const feetY = this.a.feetY(this.a.isSlumped());
    if (!this.a.flight || this.a.flight.phase !== "GROUND") this.flightBegin(feetY);
    // ...and the ragdoll, if one is still running, no longer owns her.
    this.a.body?.stop(); this.a.stopSim();
    this.a.heldPose = null; this.a.heldPoseAuthored = false;
    this.a.flight = flightTakeOff(this.a.flightCfg, this.a.flight,
      { groundY: this.a.groundAt(this.a.pos.x, this.a.pos.z, feetY) });
    const ev = this.a.flight.events.find((e: any) => e.kind === "takeoff.refused");
    if (ev) { return refused(`still standing — ${flightFixInOurTools(ev.reason)}`); }
    return done(`took off — ${this.a.flight.pos.y.toFixed(1)}m, stamina ${this.a.flight.stamina.toFixed(0)}/100`);
  }

  // WORLD-FACING FLIGHT TELEMETRY IS ABSENT ON PURPOSE: it must never be
  // published as the resident's `say` (a falsified record in the durable log).
  // The right shape is a dedicated structured event with actor, cause and
  // generation, not yet agreed; the verbs' return values report everything.

  /** fold_down / unfold (spec §1): the vigil posture and the act that ends it.
   *  A GROUND posture: it needs no flight state and doesn't make one. */
  async foldWings(fold: boolean): Promise<ActResult> {
    await this.a.loadBodyBones();
    // Folding is body autonomy, not propulsion authority: no `fly` grant needed.
    // The rig decides a fold (a wingless body can't claim the silhouette); an
    // unfold never needs it, and unfolding nothing is the no-op it is on any rig.
    const bones = this.a.bodyBoneNames;
    if (bones == null && fold) {
      // Wings already folded are what a fold asks for, bones known or not.
      if (this.a.flight ? this.a.flight.wings === "FOLDED" : this.a.wingsFolded) {
        // As below: wings found as asked leave the posture so too, and the answer says when that changed it.
        const changed = !this.a.wingsFolded;
        this.a.wingsFolded = true;
        return done(changed ? `wings are already folded; the posture now shows them folded` : `wings are already folded`);
      }
      return refused(`wings unchanged — ${BONES_NOT_KNOWN}; calling again reads the model again`);
    }
    const body = inspectBody(bones ?? []);
    if (fold && !body.canAnimateWings) return refused(`this body has no animatable wings to fold`);
    // Nothing is folded, which is what unfolding asks for.
    if (!fold && bones != null && !body.canAnimateWings && !this.a.wingsFolded)
      return done(`this body has no folded-wing posture to release`);

    // Never create a flight integrator just for a ground posture (a dormant one
    // would own position on the tick and fight walking); keep an existing one in step.
    if (this.a.flight) {
      this.a.flightCfg ??= flightConfig();
      const before = this.a.flight.wings;
      this.a.flight = fold ? flightFold(this.a.flightCfg, this.a.flight)
                         : flightUnfold(this.a.flightCfg, this.a.flight);
      const ref = this.a.flight.events.find((e: any) => /refused$/.test(e.kind));
      // Wings already folded, or already open, are what the call asked for.
      // The reason says why the wings didn't change (shared/flight.js); many reasons name the wings' state too, and
      // flight_status always gives it, so the sentence around the reason doesn't add the state
      if (ref) {
        const text = `wings stay as they are — ${flightFixInOurTools(ref.reason)}`;
        if (before !== (fold ? "FOLDED" : "OPEN")) return refused(text);
        // The wings are as asked, so the posture says so too, and the answer says when that changed it. A fold
        // before a down keeps wingsFolded set while recovery opens the flight's wings, and take_off reads wingsFolded.
        const changed = this.a.wingsFolded !== fold;
        this.a.wingsFolded = fold;
        return done(changed ? `${text}; ${fold ? "the posture now shows them folded" : "the folded-wing posture is released"}` : text);
      }
    } else if (this.a.wingsFolded === fold) {
      return done(fold ? `wings are already folded`
        : bones == null ? `nothing is folded — ${BONES_NOT_KNOWN}` : `wings are already open`);
    }
    this.a.wingsFolded = fold;
    if (fold) return done("wings folded — the vigil posture; a fly-mode move refuses until you open them (anim {stop: \"wings-folded\"})");
    if (bones == null) return done(`folded-wing posture released — ${BONES_NOT_KNOWN}`);
    if (!body.canAnimateWings) return done("folded-wing posture released — this body has no wings");
    const cap = this.flightAllowed();
    return done(cap.ok ? "wings open — the sky is available again"
                       : "wings open — propulsion is still not granted here");
  }

  /** glide_to (spec §1). Free, and lands SHORT honestly if the polar runs out. `took`, when given, is told the course
   *  this glide set and how its wait ended, for land_at to tell whether a later call has taken the flight over. */
  async glideTo(x: number, z: number, took?: { course?: number; got?: string }): Promise<ActResult> {
    await this.a.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    if (!this.a.flight || this.a.flight.phase === "GROUND" || this.a.flight.phase === "LANDED") {
      return refused("you are on the ground — move {mode: \"fly\"} first");
    }
    // A down is involuntary: no flight verb flies a body out of one (downRefusal says what does).
    if (isDown(this.a.flight.phase)) return refused(downRefusal(this.a.flight));
    const f = this.a.flight;
    const reach = glideRange(this.a.flightCfg, f.pos.y);
    const need = Math.hypot(x - f.pos.x, z - f.pos.z);
    f.phase = "PILOT"; f.mode = "live";
    f.airspeed = bestGlide(this.a.flightCfg).speed;
    const id = this.setCourse({ kind: "glide", x, z });   // the tick steers it (coursePilot)
    if (took) took.course = id;
    // arrival is closest approach as well as GLIDE_ARRIVE_M: a radius alone, tested at 10 Hz, can be stepped over, so it
    // is also arrived when the distance stops shrinking
    let closest = Infinity;
    let arrived = await this.courseAwait(id, (s) => {
      // A cut in the air is the limp fall (LEAF); one on the ground, the ragdoll, or the sit-up after it.
      if (s.phase === "LEAF") return "cut mid-glide — you are falling";
      if (isDown(s.phase)) return "cut mid-glide — you are on the ground";
      const d = Math.hypot(x - s.pos.x, z - s.pos.z);
      // down within the arrival radius is down at the target, not short of it
      if (s.phase === "LANDED" || s.phase === "GROUND") return d < GLIDE_ARRIVE_M ? "touched down" : "landed";
      if (d < GLIDE_ARRIVE_M) return "arrived";
      // past the point of closest approach: flying away now
      if (d > closest + 0.5 && closest < 12) return "arrived";
      if (d < closest) closest = d;
      return null;
    });
    // ARRIVING MEANS STOPPING: the course becomes a hold over the point, until the next command replaces it.
    if (took) took.got = arrived;
    if (arrived === "arrived" && this.a.flight?.course?.id === id) this.a.flight.course = { kind: "hold", x, z, id };
    else if (arrived === "arrived" && this.a.flight) arrived = "taken over";   // a later command took it on the way
    // Where the body is now: a later landing or walk can have ended the flight by the time this glide's wait answers.
    const p = this.a.flight?.pos ?? this.a.pos;
    const here = `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
    if (arrived === "arrived") return done(`arrived at ${here}, ${p.y.toFixed(1)}m up — holding over it`);
    if (arrived === "touched down") return done(`touched down at ${here}, at the target`);
    if (arrived === "landed") {
      const short = Math.hypot(x - p.x, z - p.z);
      return refused(`landed short at ${here} — ${short.toFixed(1)}m short. `
        + `From ${f.pos.y.toFixed(1)}m best glide reaches ${reach.toFixed(0)}m; you needed ${need.toFixed(0)}m.`);
    }
    if (arrived === "taken over") return refused(`taken over at ${here} by a later call`);
    // Out of time, the glide stops steering, as a climb does: the body flies on.
    if (arrived === "timed out aloft" && this.a.flight?.course?.id === id) {
      this.a.flight.course = null;
      return refused(`timed out aloft at ${here}; the glide stops steering there and you fly on`);
    }
    return refused(`${flightWords(arrived)} at ${here}`);
  }

  /** climb_to (spec §1). -1 stamina/metre; an empty pool forces a glide down. */
  async climbTo(alt: number): Promise<ActResult> {
    await this.a.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    if (!this.a.flight || this.a.flight.phase === "GROUND" || this.a.flight.phase === "LANDED") {
      return refused("you are on the ground — move {mode: \"fly\"} first");
    }
    if (isDown(this.a.flight.phase)) return refused(downRefusal(this.a.flight));
    const f = this.a.flight, cfg = this.a.flightCfg;
    const from = f.pos.y;
    const ceiling = ceilingOf(this.a.worldBox()), want = Math.min(alt, ceiling);
    const gain = Math.max(0, want - from);
    const cost = gain * cfg.stamina.climbPerMetre;
    // A SHORT CLIMB IS STILL A CLIMB: an unaffordable climb flies the part it
    // CAN afford through the same ticked integrator (never a pos.y assignment,
    // which would teleport with no trajectory) and ends where the pool ran out.
    const winded = cost > f.stamina;
    const afford = f.stamina / cfg.stamina.climbPerMetre;
    const reach = winded ? from + afford : want;
    const spend = winded ? f.stamina : cost;
    // CLIMB THROUGH THE INTEGRATOR, not around it: the flight tick owns y while
    // airborne and would overwrite a direct write on the next frame.
    f.phase = "PILOT"; f.mode = "live";
    f.stamina = Math.max(0, f.stamina - spend);
    const climbRate = 2.0;   // m/s of ascent while flying forward
    const id = this.setCourse({ kind: "climb", alt: reach, rate: climbRate, t: 0 });   // flown by the tick (coursePilot)
    // The wait covers the longer of a rise to the height (lift less the polar's sink: ~1.5 m/s at the default polar's
    // minimum-sink speed, since the door gives no stick) and a descent to it from the ceiling (lift alone, 2 m/s): the
    // descent covers take-off's launch carrying the body past the height. The ceiling bounds it.
    const got = await this.courseAwait(id, (st) => {
      if (isDown(st.phase)) return "cut";
      // A climb that meets the ground ends there, at the height asked (within the tick's 0.4 m) or not. Asked,
      // not `reach`: a winded or ceiling-capped climb's reach is short of what was asked.
      if (st.phase === "LANDED" || st.phase === "GROUND") return Math.abs(st.pos.y - alt) < 0.4 ? "touched down" : "landed";
      if (st.course.reached) return "there";
      return null;
    }, legWaitMs(Math.max((reach - from) / (climbRate - cfg.polar.sinkAtMinSink), ((Number.isFinite(ceiling) ? ceiling : Math.max(from, reach)) - reach) / climbRate)));   // no bounds: no ceiling, a descent from here
    const y = this.a.flight?.pos.y ?? this.a.pos.y;
    // A later command holds the course now, so this call's answer leaves it alone (a stood-in wait never saw it).
    if (got === "taken over" || (got !== "cut" && this.a.flight && this.a.flight.course?.id !== id)) {
      return refused(`taken over at ${y.toFixed(1)}m by a later call`);
    }
    // A cut body keeps no course (flightDownNow), so it doesn't resume a climb when it recovers.
    if (got === "cut") return refused(`cut mid-climb at ${y.toFixed(1)}m`);
    if (isFlightEnd(got)) return refused(`${flightWords(got)} — the climb stopped at ${y.toFixed(1)}m`);
    if (got === "touched down") {
      return done(`came down on the ground at ${y.toFixed(1)}m, the height you asked for — move {mode: "fly"} to fly again`);
    }
    if (got === "landed") {
      return refused(`came down on the ground at ${y.toFixed(1)}m, ${y > alt ? "above" : "below"} the ${alt.toFixed(1)}m you asked for`);
    }
    // The wait's own timeout is the other answer that isn't "there": the climb
    // didn't finish, so it isn't reported as reaching the target. It stops
    // here too, so the body is where the answer says, not still climbing.
    if (got !== "there") {
      if (this.a.flight) this.a.flight.course = null;
      return refused(`${got} at ${y.toFixed(1)}m, short of the climb; the climbing stops there and you fly on`);
    }
    // "there" is the tick's snap in the air, which marked the climb reached.
    const target = this.a.flight?.pos.y ?? reach;
    if (winded) {
      return refused(`winded at ${target.toFixed(1)}m — the pool only bought ${afford.toFixed(1)}m `
        + `of the ${gain.toFixed(1)} you asked for, and it was flown, not granted`);
    }
    const left = `${spend.toFixed(0)} stamina spent, ${(this.a.flight?.stamina ?? 0).toFixed(0)} left`;
    // Flown to the ceiling, which is below what was asked: short of the climb.
    if (alt > want) return refused(`at ${target.toFixed(1)}m, the ceiling here, short of the ${alt.toFixed(1)}m you asked for — ${left}`);
    return done(`at ${target.toFixed(1)}m — ${left}`);
  }

  /** land_at (x,z). Descend, arrive, and hand the body back to walking. */
  async landAt(x: number, z: number): Promise<ActResult> {
    await this.a.loadBodyBones();
    const cap = this.flightAllowed();
    if (!cap.ok) return refused(`you cannot fly here — ${cap.why}`);
    if (!this.a.flight || this.a.flight.phase === "GROUND" || this.a.flight.phase === "LANDED") {
      return refused("already on the ground");
    }
    const took: { course?: number; got?: string } = {};
    const glide = await this.a.glideTo(x, z, took);
    // A glide that set no course was refused before it flew, and its refusal is the landing's answer.
    if (took.course === undefined) return refused(glide.text);
    const f = this.a.flight;
    // A cut mid-glide is a fall, with no flare to make; the glide says so. The
    // body keeps its flight state, which its recovery reads.
    if (f && isDown(f.phase)) return refused(glide.text);
    // A flight that ended in the glide other than by coming down (a walk, a knockdown, a close) is that end's.
    if (!f && took.got !== "touched down" && took.got !== "landed") return refused(glide.text);
    // A later call that set the flight's course during the glide has the flight, so the landing leaves it to that
    // call, with no flare.
    // A glide that timed out cleared its own course (glideTo), and the landing flies on to its flare.
    if (f && f.course?.id !== took.course && !(took.got === "timed out aloft" && f.course == null)) return refused(`${glide.text} — a later call took over the flight during the glide`);
    let flare = "down";
    if (f && f.phase !== "LANDED" && f.phase !== "GROUND") {
      // A deliberate landing IS a flare: the land course comes down on the spoilers, on the circle held over the point,
      // and noses up its last FLARE_HEIGHT (coursePilot). T4 forbids a landing animation only for a body that never
      // chose to land. Its wait is sized for a descent from the ceiling to the ground under the body as it begins, as
      // a low flare can still be rising on take-off's launch, and is never shorter than the 60 s main's flare had.
      const id = this.setCourse({ kind: "land", x, z });
      const top = ceilingOf(this.a.worldBox()), fall = Math.max(0, (Number.isFinite(top) ? top : f.pos.y) - this.a.heightAt(f.pos.x, f.pos.z));
      const sink = this.a.flightCfg.polar.sinkAtMinSink + (this.a.flightCfg.pilot?.spoilSink ?? 2.5);
      flare = await this.courseAwait(id, (s) => isDown(s.phase) ? "cut"
        : (s.phase === "LANDED" || s.phase === "GROUND") ? "down" : null,
        Math.max(60_000, legWaitMs(fall / sink)));
      // How the flare ended is read after it, so a cut during it is a fall too,
      // and the cut body keeps its flight state for its recovery.
      if (flare === "cut") {
        const fell = `(${(this.a.flight?.pos.x ?? this.a.pos.x).toFixed(1)}, ${(this.a.flight?.pos.z ?? this.a.pos.z).toFixed(1)})`;
        return refused(`${glide.text} — cut during the flare, down at ${fell}`);
      }
      // A later command holds the course now, whether this wait heard the body come down or ran out: ending the
      // flight would pull the body out of that command's.
      if (flare === "taken over" || (this.a.flight && this.a.flight.course?.id !== id)) {
        return refused(`${glide.text} — a later call took over the flight during the flare`);
      }
      if (isFlightEnd(flare)) return refused(`${glide.text} — ${flightWords(flare)} during the flare`);
    }
    // Come down (the tick has ended the flight) or not (the flare's own timeout): the body stands where it is.
    if (this.a.flight) this.a.endFlight("landed");
    const at = `(${this.a.pos.x.toFixed(1)}, ${this.a.pos.z.toFixed(1)})`;
    if (flare !== "down") return refused(`${glide.text} — the flare ${flare}, so the body was set down at ${at}`);
    // A flare after an arrival sinks on the circle held over the point, so
    // the answer says how far from it the body came down.
    const off = Math.hypot(x - this.a.pos.x, z - this.a.pos.z);
    const where = `${glide.text} — landed at ${at}, ${off.toFixed(1)}m from (${x.toFixed(1)}, ${z.toFixed(1)})`;
    // done when the glide's own answer was (within GLIDE_ARRIVE_M, or closest approach under 12 m, glideTo's rule) or it
    // touched down within it, and the landing was deliberate; the distance says the rest
    return glide.ok ? done(where) : refused(where);
  }

  /** The trusted-event seam, unchanged: the body cannot cry wolf, so these are
   *  NOT verbs the pilot may call. Reachable only from a rehearsal control or,
   *  later, the Connectome adapter. */
  flightBodyDown(eventId: string): ActResult {
    if (!this.a.flight) return refused("not airborne — move {mode: \"fly\"} first");
    // A wait on the flight hears of the down now. The ragdoll's sim, started below, owns the body from its first
    // step, and the flight tick, which settles waits, doesn't run while it does, so a climb, glide or flare
    // waiting could otherwise hear of the cut only once the body came to rest, or at its wait's end.
    this.flightDownNow(eventId);
    // R2 hands the body to the REAL ragdoll, from altitude (HeadlessBody.begin
    // takes a rootY for a lifted drop), so a cut body is hit by props and lands
    // badly. The leaf is FORCES on those bodies (shared/leafforce.js); the
    // kinematic leafAt() stays for the bit-exact bench and capture path.
    if (this.a.flight.phase === "LEAF") void this.flightRagdoll();
    return done(`down — ${this.a.flight.phase}`);
  }

  /** Drop the real ragdoll from where the flight left the body. */
  private async flightRagdoll() {
    const epoch = ++this.a.bodyEpoch;
    const body = await this.a.ensureBody();
    if (this.a.bodyEpoch !== epoch || !body) return;
    await setHeightField((x, z) => this.a.heightAt(x, z)); await setWaterField(this.a.waterFieldNow());
    if (this.a.bodyEpoch !== epoch) return;
    await this.a.ground.supportReady();
    if (this.a.bodyEpoch !== epoch) return;
    const f = this.a.flight;
    body.begin({
      x: this.a.pos.x, z: this.a.pos.z, yaw: this.a.yaw,
      rootY: this.a.pos.y,                     // the lifted drop R2 needs
      pose: null,
      // Enter the tumble carrying the flight's own momentum, so a body cut
      // out of a fast glide keeps going and one cut out of a hover drops.
      lean: f ? [f.vel.x * 0.25, 0, f.vel.z * 0.25] : null,
      pins: [],
    });
    this.a.clip = "ragdoll";
    this.a.leafT = 0;
    this.a.startSim();
  }
  flightBodyRecovered(eventId: string, recoveryGeneration?: string): ActResult {
    if (!this.a.flight) return refused("not airborne — move {mode: \"fly\"} first");
    // Only a body that is down has anything to recover from; bodyRecovered
    // leaves every other phase as it is. A body sitting up, or one whose
    // recovery in the air has begun (still LEAF, with recoverAt set), already is.
    if (this.a.flight.phase === "RECOVER" || (this.a.flight.phase === "LEAF" && this.a.flight.recoverAt != null)) return done("already recovering");
    if (this.a.flight.phase !== "LEAF" && this.a.flight.phase !== "RAGDOLL") {
      return refused(`nothing to recover from — the body isn't down (${this.a.flight.phase.toLowerCase()})`);
    }
    this.a.flight = flightRecovered(this.a.flight, { eventId, recoveryGeneration });
    return done(`recovering`);
  }

  /** Where the sky has left you. */
  flightStatus(): string {
    const at = `(${this.a.pos.x.toFixed(1)}, ${this.a.pos.z.toFixed(1)})`;
    if (!this.a.flight) return this.a.aloft() ? `falling at ${at}, ${this.a.pos.y.toFixed(1)}m` : `on the ground at ${at}`;
    const f = this.a.flight, cfg = this.a.flightCfg;
    const bg = bestGlide(cfg);
    return [
      `${f.phase.toLowerCase()} at ${f.pos.y.toFixed(1)}m, heading ${((f.yaw * 180 / Math.PI + 360) % 360).toFixed(0)}deg, ${f.airspeed.toFixed(1)} m/s`,
      `stamina ${f.stamina.toFixed(0)}/100 (refills on the ground: ${cfg.stamina.refillGroundPerSec}/s; perches are not implemented)`,
      `from here best glide reaches ${glideRange(cfg, f.pos.y).toFixed(0)}m at ${bg.speed.toFixed(1)} m/s`,
      `wings ${f.wings} - mode ${f.mode}`,
    ].join("\n");
  }
}
