// shared/protocol/authority/drive.js — the hull's lease (DESIGN.md env-components "Drive"; Roblox network ownership): the helm's
// occupant streams the hull's pose (presence), the authority checks plausibility and the hull's own collision, and commits only
// the last accepted pose, as the system's act, on exit, every LEASE.commitMs and when the stream stops (shared/drive.js).
import { driveOf, helmOf, implausible, LEASE } from "../../drive.js";
import { r3 } from "../round.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { holdsCustody, lockedC, qr3, scratch, setOp } from "./storage.js";
import { ancestors, obbs, worldT } from "./math.js";
import { familyOf, groundOf, hitsIx, near } from "./spatial.js";
import { clearOccupant, occupantOf } from "./occupants.js";
import { withAuthority } from "./scriptrun.js";
const admit = (...a) => UP.admit(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const actEntry = (...a) => UP.actEntry(...a);
const boundsOf = (...a) => UP.boundsOf(...a);
const outsideWorld = (...a) => UP.outsideWorld(...a);

const leases = (w) => (w.presence.drives ??= {});
const paceOf = (w) => (w.pace ? w.pace() : w.now());
const poseOf = (st, id) => { const t = st.entities[id]?.c.transform ?? {}; return { pos: (t.pos ?? [0, 0, 0]).slice(), q: (t.q ?? [0, 0, 0, 1]).slice() }; };

/** What the hull would run into at `pose` (its transform's pos and q): a thing's id, "ground", or null. The hull's own
 *  family, and whatever it already touched at `from`, never block (a hull may back out of what it was in). */
export function hullHit(st, id, pose, from) {
  const e = st.entities[id]; if (!e || e.c.collider?.enabled === false) return null;
  const fam = familyOf(st, id);
  const at = (p) => obbs(scratch(st, [setOp(id, "transform", { ...(e.c.transform ?? {}), pos: p.pos, q: p.q })]), id);
  const ext = (o) => { const h = [0, 1, 2].map((i) => o.ax.reduce((a, axv, j) => a + Math.abs(axv[i]) * o.h[j], 0)); return { min: o.c.map((v, i) => v - h[i]), max: o.c.map((v, i) => v + h[i]) }; };
  const touching = (H) => { const out = new Set(); for (const o of H) { const x = ext(o); for (const k of near(st, x.min, x.max)) if (!fam.has(k) && hitsIx(st, null, k, 0.01, o)) out.add(k); } return out; };
  const H = at(pose); if (!H.length) return null;
  const was = from ? touching(at(from)) : new Set(), now = touching(H);
  for (const k of now) if (!was.has(k)) return k;
  const G = groundOf(st); if (!G.ready) return null;
  const under = (HH) => HH.some((o) => { const x = ext(o); return x.min[1] < G.height(o.c[0], o.c[2]) - 0.01; });
  return under(H) && !(from && under(at(from))) ? "ground" : null;
}

/** The lease on `host`, if its holder still sits at the helm; a stale one (the holder got up or the helm went) is ended. */
function liveLease(w, st, host) {
  const L = leases(w)[host]; if (!L) return null;
  const helm = helmOf(st, host);
  if (st.entities[host] && helm && occupantOf(w, st, L.by)?.to === helm) return L;
  endLease(w, st, host, "exit"); return null;
}

/** Commit the lease's last accepted pose (when it differs from the log's) as the system's act `drive-commit {id, driver, why}`. */
function commitLease(w, st, host, why) {
  const L = leases(w)[host], e = st.entities[host]; if (!L || !e) return false;
  L.committed = paceOf(w);
  const t = { ...(e.c.transform ?? {}), pos: L.pose.pos.map(r3), q: qr3(L.pose.q) };
  if (JSON.stringify(t.pos) === JSON.stringify(e.c.transform?.pos) && JSON.stringify(t.q) === JSON.stringify(e.c.transform?.q)) return false;
  const plan = admit(w, st, { actor: "system", cap: { kind: "system", ids: [host], comps: ["transform"] } }, [setOp(host, "transform", t)]);
  changeEntry(w, plan, w.append(actEntry(w, "system", "drive-commit", { id: host, driver: L.by, why })));
  return true;
}
/** End the lease: commit, then free the helm (its driver let go); passengers keep their seats. */
function endLease(w, st, host, why, free = true) {
  const L = leases(w)[host]; if (!L) return;
  try { commitLease(w, st, host, why); } finally {
    delete leases(w)[host]; w.presenceDirty = true;
    const helm = helmOf(st, host); if (free && helm && occupantOf(w, st, L.by)?.to === helm) clearOccupant(w, L.by); }
}
/** The driver `who` stood up or left: their lease ends and commits; the caller lets them off the seat (bodyverbs' stand-up, leave). */
export function endDrivesBy(w, st, who) { for (const [host, L] of Object.entries(leases(w))) if (L.by === who) endLease(w, st, host, "exit", false); }

/** The beat (server: the physics heartbeat): a lease whose stream stopped ends; a held one commits every LEASE.commitMs. */
export function drives(w) {
  if (!w.exists || w.state().status !== "ok" || !holdsCustody(w) || !Object.keys(w.presence.drives ?? {}).length) return 0;
  return withAuthority(w, () => { const n0 = w.entries.length, now = paceOf(w);
    for (const host of Object.keys(leases(w))) { const st = w.state(), L = liveLease(w, st, host); if (!L) continue;
      if (now - L.beat >= LEASE.heartbeatMs) endLease(w, st, host, "lease-lost");
      else if (now - L.committed >= LEASE.commitMs) commitLease(w, st, host, "periodic"); }
    return w.entries.length - n0; });
}

const DRIVE_VERBS = {
  // drive {id, pos, q}: the helm's occupant's step of the hull (presence; the reply carries the pose that stands)
  drive(w, actor, a) {
    const st = w.state(), e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here");
    const spec = driveOf(e.c); if (!spec) refuse("doesnt-apply", `${a.id} has no drive: it isn't something to drive`, `a builder gives it one: set {id: '${a.id}', component: 'drive', value: {maxSpeed, turnRate}}`);
    const helm = helmOf(st, a.id);
    if (!helm || occupantOf(w, st, actor)?.to !== helm) refuse("rights", helm ? `you aren't at ${a.id}'s helm (${helm})` : `${a.id} has no helm: a socket child with station {action: 'drive', input: {move: 'drive'}}`, helm ? `use {id: '${a.id}', action: 'drive'} first` : "a builder adds one");
    const lock = [a.id, ...ancestors(st, a.id)].find((k) => lockedC(st.entities[k]?.c));
    if (lock) refuse("locked", `${lock === a.id ? a.id : `${a.id} hangs from ${lock}, which`} is locked: it can't be driven`, "someone who may lift the lock lifts it");
    const now = paceOf(w); let L = liveLease(w, st, a.id);
    if (!L) { const sat = occupantOf(w, st, actor).t; L = leases(w)[a.id] = { by: actor, pose: poseOf(st, a.id), at: Number.isFinite(sat) ? sat : now, beat: now, committed: now }; w.presenceDirty = true; }   // paced from taking the helm
    L.beat = now;
    const next = { pos: a.pos, q: a.q }, stands = { pose: L.pose };
    const bad = implausible(L.pose, next, (now - L.at) / 1000, spec);
    if (bad) refuse(bad.what === "shape" ? "shape" : "too-fast", bad.what === "shape" ? `drive's ${bad.said}` : `${a.id} can't have gone there: ${bad.said}`, "drive from the pose that stands (the reply's pose)", stands);
    const B = boundsOf(st); if (B && outsideWorld(B, next.pos)) refuse("out-of-bounds", `[${next.pos.map(r3).join(", ")}] is outside this world`, "drive back inside its bounds", stands);
    const hit = hullHit(st, a.id, next, L.pose);
    if (hit) refuse("solid", `${a.id} would run into ${hit === "ground" ? "the ground" : hit}`, "steer around it", { ...stands, blocker: hit });
    L.pose = { pos: next.pos.slice(), q: next.q.slice() }; L.at = now; w.presenceDirty = true;
    const recorded = now - L.committed >= LEASE.commitMs && commitLease(w, st, a.id, "periodic");
    return { ok: true, recorded, pose: L.pose, driver: said(actor) };
  },
};
export { DRIVE_VERBS };
