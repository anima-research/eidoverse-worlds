// shared/spawn.js — where a body arrives (@world.spawn and spawn-point things, OMI_spawn_point) and where it falls out of the
// world (below the kill line, KILL_MARGIN under @world.bounds.min.y: Unreal's KillZ). Pure; the authority, the browser and
// the agent ask the same questions.
import { worldPose, offChain } from "./protocol/simlayer.js";
import { qHeading } from "./rot.js";
import { MOVER } from "./mover.js";
import { KILL_MARGIN } from "./protocol/physconst.js";
export { KILL_MARGIN };

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

/** Where a body that fell out of the world goes back to: spawnOf's place, else the origin facing +z. Null where a body
 *  sent there would read as fallen at once (belowWorld) or the authority refuses the place (outsideWorld). */
export function fallBackOf(st) {
  const sp = spawnOf(st) ?? { id: null, pos: [0, 0, 0], yaw: 0, radius: MOVER.track.spawnR };
  const B = st?.entities?.["@world"]?.c.bounds;
  return belowWorld(st, sp.pos) || (B && v3(B.min) && v3(B.max) && outsideWorld(B, sp.pos)) ? null : sp;
}

// x, z and the sky; the floor is the terrain's (bounds.min[1] sits above the default heightfield)
export const outsideWorld = (B, p) => p[0] < B.min[0] || p[0] > B.max[0] || p[2] < B.min[2] || p[2] > B.max[2] || p[1] > B.max[1];

/** Is `p` within an arrival place's radius (any of them)? True when the world declares none. */
export function atASpawn(st, p) {
  const all = spawnsOf(st); return !all.length || all.some((s) => Math.hypot(s.pos[0] - p[0], s.pos[1] - p[1], s.pos[2] - p[2]) <= s.radius);
}

/** Has a body at `p` fallen out of the world (more than KILL_MARGIN below @world.bounds.min.y)? False with no bounds. A seated
 *  or climbing body is exempt: the caller says so (`riding`). */
export function belowWorld(st, p, { riding = false } = {}) {
  const B = st?.entities?.["@world"]?.c.bounds;
  return !riding && !!B && v3(B.min) && v3(p) && p[1] < B.min[1] - KILL_MARGIN;
}
/** The act's reason for a KillZ respawn (move {teleport: true, reason}). */
export const FELL = "below-bounds";
