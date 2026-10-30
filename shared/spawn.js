// shared/spawn.js — where a body arrives (@world.spawn and spawn-point things, OMI_spawn_point) and where it falls out of the
// world (below @world.bounds.min.y: Unreal's KillZ). Pure; the authority, the browser and the agent ask the same questions.
import { worldPose, offChain } from "./protocol/simlayer.js";
import { qHeading } from "./rot.js";
import { MOVER } from "./mover.js";

const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

/** Every arrival place: @world's spawn first (when declared), then each spawn-point thing in id order (switched-off ones
 *  left out): [{id, pos, yaw, radius, title?, team?, group?}]. A spawn-point faces its world rotation and takes MOVER's 2 m. */
export function spawnsOf(st) {
  const out = [], sp = st?.entities?.["@world"]?.c.spawn;
  if (sp && v3(sp.pos)) out.push({ id: "@world", pos: [...sp.pos], yaw: Number.isFinite(sp.yaw) ? sp.yaw : 0, radius: Number.isFinite(sp.radius) ? sp.radius : MOVER.track.spawnR });
  for (const id of Object.keys(st?.entities ?? {}).sort()) {
    const p = st.entities[id].c["spawn-point"]; if (id === "@world" || !p || typeof p !== "object" || offChain(st, id)) continue;
    const t = worldPose(st, id); if (!t || !v3(t.pos)) continue;
    out.push({ id, pos: [...t.pos], yaw: qHeading(t.q ?? [0, 0, 0, 1]), radius: MOVER.track.spawnR, ...Object.fromEntries(["title", "team", "group"].filter((k) => typeof p[k] === "string").map((k) => [k, p[k]])) });
  }
  return out;
}

/** The arrival a body takes: {id, pos, yaw, radius}, or null when the world declares none. The rule: among the places that fit
 *  what is asked ({team?, group?}: a spawn-point of that team or group; @world's spawn fits only an ask of neither), @world's
 *  spawn when it is one of them, else the first by id. */
export function spawnOf(st, { team, group } = {}) {
  const fits = (s) => (team === undefined || s.team === team) && (group === undefined || s.group === group) && (s.id !== "@world" || (team === undefined && group === undefined));
  return spawnsOf(st).find(fits) ?? null;
}

/** Is `p` within an arrival place's radius (any of them)? True when the world declares none. */
export function atASpawn(st, p) {
  const all = spawnsOf(st); return !all.length || all.some((s) => Math.hypot(s.pos[0] - p[0], s.pos[1] - p[1], s.pos[2] - p[2]) <= s.radius);
}

/** How far below the bounds' floor the kill line sits (Unreal's KillZ, Roblox's FallenPartsDestroyHeight: well below anything
 *  playable), so water, cellars and a body laid flat under the floor aren't "fallen". A world setting later (WISHLIST 🕳️). */
export const KILL_MARGIN = 50;
/** Has a body at `p` fallen out of the world (more than KILL_MARGIN below @world.bounds.min.y)? False with no bounds. A seated
 *  or climbing body is exempt: the caller says so (`riding`). */
export function belowWorld(st, p, { riding = false } = {}) {
  const B = st?.entities?.["@world"]?.c.bounds;
  return !riding && !!B && v3(B.min) && v3(p) && p[1] < B.min[1] - KILL_MARGIN;
}
/** The act's reason for a KillZ respawn (move {teleport: true, reason}). */
export const FELL = "below-bounds";
