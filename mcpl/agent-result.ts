// What every piece of the agent (mcpl/agent.ts and its agent-*.ts) shares: an act's answer, a body down, the yaw map.

import type { PublicPose } from "./body-state.ts";
import { solidOff } from "../shared/protocol/simlayer.js";
import { recordComponents } from "../shared/protocol/view.js";

/** An act's answer for its tool. `ok` is false when the call didn't do what it
 *  asked (a refusal, a cut, a climb or glide that fell short, a refused name);
 *  a call that changed nothing because it already held is ok. */
export interface ActResult { ok: boolean; text: string }
export const done = (text: string): ActResult => ({ ok: true, text });
export const refused = (text: string): ActResult => ({ ok: false, text });
/** A body down: limp wings, in the air (LEAF), on the ground (RAGDOLL) or sitting up (RECOVER). */
export const isDown = (phase: string) => phase === "LEAF" || phase === "RAGDOLL" || phase === "RECOVER";
// In the air the limp fall ends when the body reaches the ground (RAGDOLL) or with a recovery
// (shared/flight.js bodyRecovered, which the door sends only in rehearsal); on the ground, a take-off
// launches afresh from wherever the body lies (takeOff).
/** Why a body that's down can't fly now, and what gets it flying again. A limp fall whose recovery began
 *  in the air (LEAF with recoverAt set) flies on by itself once it's done, unless it meets the ground
 *  first (shared/flight.js). */
export const downRefusal = (f: { phase: string; recoverAt?: number | null }) => f.phase === "LEAF"
  ? f.recoverAt != null
    ? "you're falling limp (leaf) with your recovery under way — you fly again once it's done, unless you reach the ground first"
    : "you're falling limp (leaf) — once you're down on the ground, move {mode: \"fly\"} launches you again"
  : `you're down on the ground (${f.phase.toLowerCase()}) — move {mode: "fly"} to fly again`;
/** integrator yaw (atan2(dz,dx), forward = (cos,sin)) -> world yaw
 *  (atan2(dx,dz), which every renderer and walkTo already speak). */
export const worldYaw = (y: number) => Math.PI / 2 - y;
/** ...and back. The map is its own inverse, but naming both directions is
 *  cheaper than working that out at every call site. */
export const intYaw = (y: number) => Math.PI / 2 - y;
/** A record (components flat, view.js) a body doesn't meet: componentspec collider.enabled or .blocks, the authority's own reading. */
export const solidOffRecord = (e: any) => solidOff(e, "bodies");
/** No collider of its own: collision off for bodies, or a structure's anchor (its planner owns the walls). The browser's
 *  client/lib/realize/models_field.js collisionOwnedElsewhere, minus mounts (the agent handles those on its own). */
export const collisionElsewhere = (e: any) => solidOffRecord(e) || !!recordComponents(e).structure;
/** A structure as a body meets it: its data, unless its collision is off for bodies (the browser then fits it no wall
 *  or floor: client/lib/realize/structure.js `solid`). Every floor and route reader takes its structures from here. */
export const bodyStructure = (e: any): unknown => (solidOffRecord(e) ? undefined : recordComponents(e).structure);
/** How far below its supporting surface a settled ragdoll's root lies. */
export const RAGDOLL_ROOT_DROP = 0.7;
/** A read of the world server (roster, terrain, a grid, geometry, bones) not answered by then has failed, as a host's
 *  tool call would. A read made during the join is cut sooner, by connect()'s 8 s join deadline (agent.ts). */
export const WORLD_READ_MS = 10_000;
export type Pose = PublicPose;
/** A record carrying a socket component (an attachment point, listed under its host); it may carry anything else too. */
export const isSocketRec = (e: any) => !!e?.socket && typeof e.socket === "object" && !Array.isArray(e.socket);
export type Entity = { id: string; model: string; pos: number[]; yaw: number; actor: string; scale?: number;
  /** a stretched thing's per-axis scale, and a tilted one's whole rotation (the fold keeps both beside scale and yaw) */
  scale3?: number[]; q?: number[];
  /** the spawn's collider override ("exact" | "box"); the browser's decide() reads it, and so does ours */
  collide?: string;
  /** component bag (sockets, reactions, motion, …) — what a thing can DO;
   *  this is how affordances reach text-tier perception */
  comp?: Record<string, any> };
/** A just-joining browser can briefly send a pose with null/non-finite
 * coordinates: treat that as "position unknown", never throw. */
export function posePosition(pose: Pose | null | undefined): [number, number, number] | null {
  const p = pose?.p;
  if (!Array.isArray(p) || p.length < 3) return null;
  const [x, y, z] = p;
  return typeof x === "number" && Number.isFinite(x)
    && typeof y === "number" && Number.isFinite(y)
    && typeof z === "number" && Number.isFinite(z) ? [x, y, z] : null;
}
/** How far away look lists the places in sight (agent-places.ts placesInSight; look says the distance). */
export const PLACE_SIGHT_M = 30;
