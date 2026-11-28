// The agent's named places (shared/places.js): a thing's places, where they are, which ones it sees, `move {to}`'s aim, name_place.
// Its public members are the body's (one-line delegates in agent.ts), and it calls them there (this.a.x), as before.

import type { WorldAgent } from "./agent.ts";
import { type ActResult, type Entity, done, refused, RAGDOLL_ROOT_DROP, PLACE_SIGHT_M, posePosition } from "./agent-result.ts";
import { standOn, inWorld, lineOfSight } from "./physics.ts";
import { placesOf, inRegion, names, destinationOf, toLocal, frameVolume, type Place, type Destination, type PlaceHolder } from "../shared/places.js";
import { shown } from "../shared/shown.js";
import { isFiniteVec3 } from "../shared/protocol/is.js";
import * as OP from "../shared/requests.js";
import { partHint } from "./effective.ts";
import { footprint } from "../shared/shove.js";
import { recordComponents } from "../shared/protocol/view.js";

/** The world entity (places that belong to no thing live on it), and how many places look lists (only
 *  what you can see, nearest first; move {to: "?"} lists them all, nearest 200; "?<text>" narrows). */
const WORLD_ENTITY = "@world", PLACE_LOOK_MAX = 12, PLACE_LIST_MAX = 200;
/** A thing with no entrance is walked up to: stopped this far short of its origin (its footprint unknown) / out from its
 *  footprint's nearest point (metres; the body's own, not the thing's). */
export const THING_STOP = 0.8, THING_STANDOFF = 0.5;

export class AgentPlaces {
  constructor(readonly a: WorldAgent) {}

  // ---- named places (shared/places.js) ----------------------------------------

  /** A thing's named places: its model's own (rooms, doors, seats, arrivals),
   *  then its `places` component on top — which anyone with builder rank can
   *  change at any time. */
  placesOn(e: Entity): Place[] {
    // a model's file may declare places; any thing's transform is a frame to hang named ones on (an Empty's included)
    return placesOf(e.model ? this.a.modelMetaOf(e.model) : undefined, recordComponents(e).places);
  }

  /** Where a thing's places are right now: its effective transform (mount
   *  chain, whole-entity motion) — its saved `pos` is where it was put, not
   *  where a carried or moving thing is. Null when that cannot be resolved. */
  private placeHolder(e: Entity, nowMs = Date.now()): PlaceHolder | null {
    const f = this.a.eff(e.id, nowMs);
    // its per-axis scale, so a place on a stretched thing is stretched with it, as the thing is drawn. places.js frames
    // any non-zero axis, a mirrored one too
    const s3 = f.ok ? f.scale3 : undefined;
    const scale = Array.isArray(s3) && s3.every((v) => Number.isFinite(v) && v !== 0) ? s3 : f.ok ? f.scale : undefined;
    return f.ok ? { id: e.id, name: this.a.refName(e.id), pos: f.pos, yaw: f.yaw, q: f.quat, scale } : null;
  }

  /** Places that belong to no thing ("the meadow"): @world's places component, in world coordinates. */
  worldPlaces(): Place[] {
    return placesOf(null, this.a.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places);
  }
  private static readonly WORLD_HOLDER: PlaceHolder = { id: WORLD_ENTITY, pos: [0, 0, 0], yaw: 0, scale: 1 };

  /** Everything that holds named places, with where it is now: @world, then each placed model that has any. */
  private placeHolders(nowMs = Date.now()): { id: string; h: PlaceHolder | null; ps: Place[]; e: Entity | null }[] {
    const out: { id: string; h: PlaceHolder | null; ps: Place[]; e: Entity | null }[] = [];
    const wp = this.a.worldPlaces();
    if (wp.length) out.push({ id: WORLD_ENTITY, h: AgentPlaces.WORLD_HOLDER, ps: wp, e: null });
    for (const e of this.a.entities.values()) {
      const ps = this.a.placesOn(e);
      if (ps.length) out.push({ id: e.id, h: this.placeHolder(e, nowMs), ps, e });
    }
    return out;
  }

  /** Every named place here, nearest first: where a walk to it aims (its floor), how far, which floor. */
  placesNear(from: number[] = [this.a.pos.x, this.a.pos.y, this.a.pos.z]): { ref: string; place: Place; dest: Destination; d: number }[] {
    const out: { ref: string; place: Place; dest: Destination; d: number }[] = [];
    for (const { id, h, ps } of this.placeHolders()) {
      if (!h) continue;
      for (const p of ps) { const dest = destinationOf(h, p); out.push({ ref: `${id === WORLD_ENTITY ? id : this.a.refName(id)}/${p.name}`, place: p, dest, d: Math.hypot(dest.x - from[0], dest.z - from[2]) }); }
    }
    return out.sort((a, b) => a.d - b.d);
  }
  private static placeLine(x: { ref: string; place: Place; dest: Destination; d: number }) {
    return `${x.ref}${x.place.label && x.place.label !== x.place.name.replace(/_/g, " ") ? ` "${x.place.label}"` : ""} (${x.d.toFixed(1)} m, floor ${x.dest.y.toFixed(2)} m)`;
  }
  /** move {to: "?"}: every named place, seen or not, nearest first, at most PLACE_LIST_MAX. move {to: "?<text>"}
   *  lists only those whose "thing/place" or label holds that text (any case). */
  placeList(filter = ""): string {
    const f = filter.trim().toLowerCase();
    const at = this.a.myPlace();
    const all = this.a.placesNear(at ? [at.x, at.y, at.z] : undefined).filter((x) => !f || x.ref.toLowerCase().includes(f) || (x.place.label ?? "").toLowerCase().includes(f));
    if (!all.length) return f ? `no named places here whose name or label holds "${filter.trim()}" — move {to: "?"} lists them all`
      : "no named places here — a model can declare them, and name_place names a spot";
    const shown = all.slice(0, PLACE_LIST_MAX), more = all.length - shown.length;
    return `named places here${f ? ` holding "${filter.trim()}"` : ""}, nearest first${at ? "" : " (seat unresolved: distances from where you boarded)"} (move {to: "<thing>/<place>"} or a place's name):\n${shown.map((x) => `  ${AgentPlaces.placeLine(x)}`).join("\n")}`
      + (more ? `\n…and ${more} more, farther away — narrow it with move {to: "?<text>"} (e.g. "?${shown[shown.length - 1].ref.split("/")[0]}"): only places whose name or label holds that text` : "");
  }
  /** look's listing: the places this body can SEE — a ray from its eye to the place (a point, or a room's
   *  middle a metre over its floor) unblocked by the placed models' fitted colliders (the same ones the feet use, #235)
   *  and the terrain — within PLACE_SIGHT_M, nearest first, at most PLACE_LOOK_MAX. Before the collision modules have
   *  loaded, distance alone decides (and the line says so). */
  placesInSight(from: number[] = [this.a.pos.x, this.a.pos.y, this.a.pos.z]): { lines: string[]; more: number; byDistance: boolean } {
    const eye = [from[0], from[1] + this.a.stature() * 0.93, from[2]];   // from where look has the body (a seat's resolution; bot #455)
    const seen: string[] = []; let byDistance = false, total = 0;
    for (const x of this.a.placesNear(from)) {
      total++;
      if (x.d > PLACE_SIGHT_M || seen.length >= PLACE_LOOK_MAX) continue;
      const tip = [x.dest.x, x.dest.y + (x.place.kind === "region" ? 1 : 0.3), x.dest.z];
      const los = inWorld(this.a.world, () => lineOfSight(eye, tip, (wx, wz) => this.a.heightAt(wx, wz)));
      if (los === null) byDistance = true;
      if (los === false) continue;
      seen.push(AgentPlaces.placeLine(x));
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

  /** Where `to` is, as a walk can aim at it, in this order: "thing/place", a
   *  thing alone (its entrance, else its door, else beside it), a place's name
   *  or label alone (the nearest), a thing by its label, or a person (stopping
   *  short of them). A person's name never hides a thing's. */
  destination(to: string): Destination | { refusal: string } {
    const q = to.trim();
    if (!q) return { refusal: "move's to names nothing" };
    const me = this.a.pos, now = Date.now();
    const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const slash = q.indexOf("/");
    const ents = [...this.a.entities.values()].filter((e) => isFiniteVec3(e.pos));
    if (slash > 0 && q.slice(0, slash) === WORLD_ENTITY) {   // a place that belongs to no thing
      const name = q.slice(slash + 1), ps = this.a.worldPlaces(), p = ps.find((x) => names(x, name));
      return p ? destinationOf(AgentPlaces.WORLD_HOLDER, p) : { refusal: `@world has no place called "${name}"${ps.length ? ` — its places: ${ps.map((x) => x.name).join(", ")}` : ""}` };
    }
    const at = (e: Entity, p: Place): Destination | { refusal: string } => {
      const h = this.placeHolder(e, now);
      const why = h ? "" : (this.a.eff(e.id, now) as { why: string }).why;
      return h ? destinationOf(h, p) : { refusal: `where [${this.a.refName(e.id)}] is right now cannot be worked out (${why})${partHint(why)}` };
    };
    if (slash > 0) {
      const tr = this.a.thingRef(q.slice(0, slash));   // its id, its label or a unique id prefix; a shared label is refused with the candidates
      if ("refusal" in tr) return tr;
      const e = ents.find((x) => "id" in tr && x.id === tr.id) ?? ents.find((x) => ci(x.id, q.slice(0, slash)));
      if (!e) return { refusal: `no thing called "${q.slice(0, slash)}" here` };
      const name = q.slice(slash + 1), ps = this.a.placesOn(e), p = ps.find((x) => names(x, name));
      if (!p) return { refusal: `[${this.a.refName(e.id)}] has no place called "${name}"${ps.length ? ` — its places: ${ps.map((x) => x.name).join(", ")}` : " (it has no named places)"}` };
      return at(e, p);
    }
    // a thing: its entrance, else its door, else walked up to and stood beside (one resolver for move: a person
    // named like it never captures the walk, and of several, the nearest is taken)
    const thing = (x: Entity): Destination | { refusal: string } => {
      const ps = this.a.placesOn(x);
      const p = ps.find((y) => y.name === "entrance") ?? ps.find((y) => y.kind === "door");
      return p ? at(x, p) : this.besideThing(x, now);
    };
    const e = ents.find((x) => ci(x.id, q));
    if (e) return thing(e);
    const hits: Destination[] = [];
    for (const p of this.a.worldPlaces()) if (names(p, q)) hits.push(destinationOf(AgentPlaces.WORLD_HOLDER, p));
    for (const x of ents) for (const p of this.a.placesOn(x)) {
      if (!names(p, q)) continue;
      const d = at(x, p);
      if (!("refusal" in d)) hits.push(d);
    }
    if (hits.length) return hits.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    // a thing by its label (a display name someone gave it) or a unique id prefix, before any person; a label two
    // things share is refused with the candidates (label, what, where, handle), never resolved to the nearest
    { const tr = this.a.thingRef(q); if ("refusal" in tr) return tr;
      if ("id" in tr) { const x = ents.find((y) => y.id === tr.id); if (x) return thing(x); } }
    // a person, last: a visitor who joins as "tower" must not capture every walk to the tower
    for (const p of this.a.people.values()) {
      if (!ci(p.id, q)) continue;
      const xyz = posePosition(p.pose);
      if (!xyz) return { refusal: `${p.id}'s position is not known yet` };
      const [x, root, z] = xyz, d = Math.hypot(me.x - x, me.z - z), back = d > 0.01 ? Math.min(0.9, d) / d : 0;
      // Presence carries the root: standing (or a canned slump) has it on its
      // floor; a sim-laid body has it about RAGDOLL_ROOT_DROP below the surface
      // it lies on. So their floor may be up to that drop above the root: the
      // navgrid takes the place to stand nearest the root within it, and a
      // floor walk checks the floor their body is on (bodyAt).
      return { x: x + (me.x - x) * back, y: root, z: z + (me.z - z) * back, reach: 0.6, label: p.id,
        above: RAGDOLL_ROOT_DROP + 0.05, bodyAt: { x, z } };
    }
    const known = this.a.placesNear().map((x) => x.ref);
    return { refusal: `nothing here is called "${q}"${known.length ? ` — named places: ${known.slice(0, 16).join(", ")}${known.length > 16 ? ` and ${known.length - 16} more (move {to: "?"} lists them all, nearest 200; "?<text>" narrows)` : ""}` : ""}` };
  }

  /** A thing with no entrance or door, as a walk aims at it: up to it and beside it, on this body's side — THING_STANDOFF
   *  out from the nearest point of its footprint (its origin where the footprint isn't known, THING_STOP short of it). */
  private besideThing(x: Entity, now = Date.now(), depth = 0): Destination | { refusal: string } {
    const me = this.a.pos, box = footprint(this.a.replica?.st, x.id), w = this.a.worldPointOf(x.id, now);
    // where it stands: its effective point, else the middle of its footprint; never its saved pos, a child's offset
    const at = "pos" in w ? w.pos : box ? [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2] : null;
    if (!at) return { refusal: `can't tell where [${this.a.refName(x.id)}] stands now — ${"why" in w ? `${w.why}${partHint(w.why)}` : "no frame"}` };
    let px = at[0], pz = at[2], off = THING_STOP;
    if (box) {
      const nx = Math.min(box.max[0], Math.max(box.min[0], me.x)), nz = Math.min(box.max[2], Math.max(box.min[2], me.z));
      if (Math.hypot(me.x - nx, me.z - nz) > 1e-6) { px = nx; pz = nz; off = THING_STANDOFF; }
    }
    const d = Math.hypot(me.x - px, me.z - pz), back = d > 0.01 ? Math.min(off, d) / d : 0;
    const dest: Destination = { x: px + (me.x - px) * back, y: box ? box.min[1] : at[1], z: pz + (me.z - pz) * back, reach: 0.6, label: `[${this.a.refName(x.id)}]` };
    // a thing standing on another (a cup on a table): the spot beside it may be on that other's top, where a walk can't
    // climb — then the spot beside what holds it up, on ITS floor, is walked to instead
    const under = box && depth < 4 ? this.supportOf(x.id, box) : null;
    if (under) { const ob = this.besideThing(under, now, depth + 1); if (!("refusal" in ob)) dest.orBeside = { ...ob, label: dest.label }; }
    return dest;
  }

  /** The placed thing a thing rests on: the highest top (its footprint's) under the thing's footprint, within a couple of
   *  centimetres of its base — never the thing itself nor anything riding on it. Null when it stands on the ground. */
  private supportOf(id: string, box: { min: number[]; max: number[] }): Entity | null {
    const st = this.a.replica?.st;
    const rides = (k: string) => { for (let c: string | undefined = k, n = 0; c && n < 33; n++) { if (c === id) return true; const p: unknown = st?.entities?.[c]?.c?.parent?.to; c = typeof p === "string" ? p : undefined; } return false; };
    let best: Entity | null = null, top = -Infinity;
    for (const e of this.a.entities.values()) {
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
    const f = this.a.eff(id, now);
    return f.ok ? { pos: f.pos } : { why: f.why };
  }

  /** name_place edits, one at a time: each starts from the state the last
   *  one's echo confirmed, so two in a row don't overwrite each other. */
  private placeEdits: Promise<unknown> = Promise.resolve();

  /** Name a spot (the body's own by default) as a place on a thing, in its
   *  `places` component and frame. `remove` retires a name (null also hides a
   *  model-declared one). `at` may omit y: the floor there nearest the body's
   *  height. Answers once the world accepts or refuses it. */
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
      const feetY = this.a.feetY(this.a.isSlumped());
      const ground = (wx: number, wz: number) => this.a.groundAt(wx, wz, feetY);
      const y = opts.at.y ?? inWorld(this.a.world, () => standOn({ x, y: feetY, z }, ground)) ?? ground(x, z);
      w = [x, y, z];
    } else w = [this.a.pos.x, this.a.pos.y, this.a.pos.z];
    const now = Date.now();
    // where the name hangs: a placed thing (in its frame, so it moves with it), or @world (world coordinates: a place
    // that belongs to no thing — on: "@world", or a spot in a room @world declares)
    let target: { id: string; h: PlaceHolder | null; had: unknown } | null = null;
    const ofEntity = (e: Entity) => ({ id: e.id, h: this.placeHolder(e, now), had: recordComponents(e).places });
    const ofWorld = () => ({ id: WORLD_ENTITY, h: AgentPlaces.WORLD_HOLDER, had: this.a.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places });
    if (opts.on) {
      if (opts.on === WORLD_ENTITY) target = ofWorld();
      else {
        const e = [...this.a.entities.values()].find((x) => x.id.toLowerCase() === opts.on!.toLowerCase());
        if (e) target = ofEntity(e);
      }
    } else {
      const inId = this.a.placesAt(w)[0]?.entity.id;
      const inE = inId && inId !== WORLD_ENTITY ? this.a.entities.get(inId) : undefined;
      if (inE) target = ofEntity(inE);
      else if (inId === WORLD_ENTITY) target = ofWorld();
      else {
        let best = Infinity;
        for (const x of this.a.entities.values()) {
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
    if (!h) return refused(`where [${this.a.refName(target.id)}] is right now cannot be worked out, so a spot on it cannot be named — try again when it rests`);
    const t0 = Date.now(), id = target.id;
    const placesNow = () => id === WORLD_ENTITY ? this.a.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places
      : (this.a.entities.get(id) ? recordComponents(this.a.entities.get(id) as Entity).places : undefined);
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
      // an ordinary set of the places component, through the authority (rights, the gate and undo apply). Adding a name
      // merges just that name (RFC 7396); retiring one replaces the bag with the name held as null (a merge's null would
      // let a model-declared name back in), as re-pointing does. That replace is PINNED to the bag it read (expect,
      // §3a): if someone wrote a name in between, it is refused as `changed` and rebuilt from the bag as it now is
      const op = replace ? OP.set(id, "places", cur) : OP.set(id, "places", { [name]: cur[name] }, { merge: true });
      const pin = replace ? { expect: [{ id: op.args.id, component: op.args.component, ...(had !== undefined ? { value: had } : {}) }] } : {};
      r = await this.a.sendOps([op], pin);
      if (!(replace && r && !r.ok && r.refused?.code === "changed" && attempt < 4)) break;
      // the other write's log reaches this replica before (or just after) the refusal: wait for the bag to move
      for (const until = Date.now() + 1000; Date.now() < until && JSON.stringify(placesNow()) === JSON.stringify(had);) await new Promise((res) => setTimeout(res, 50));
      had = placesNow();
    }
    // no answer is not a refusal: the write may have landed
    if (r && !r.ok && (r.refused?.code === "timeout" || r.refused?.code === "no-answer"))
      return refused(`"${name}" was sent, but the world didn't answer, so whether it landed is unknown — look, or [${this.a.refName(id)}]'s places component, will show it`);
    if (r && !r.ok) return refused(`not named — the world refused: ${r.refused?.reason ?? r.refused?.code ?? JSON.stringify(r.refused ?? r)}`);
    // the authority's answer is in; wait for this body's own fold of it, so a move {to} straight after finds the name
    for (const deadline = t0 + 3000; Date.now() < deadline;) {
      const got = id === WORLD_ENTITY ? this.a.replica?.st?.entities?.[WORLD_ENTITY]?.c?.places : recordComponents(this.a.entities.get(id) as Entity).places;
      if (JSON.stringify(got?.[name] ?? null) === JSON.stringify(cur[name] ?? null)) {
        { const nm = id === WORLD_ENTITY ? id : this.a.refName(id);
          return done(opts.remove ? `retired "${name}" on [${nm}]` : `named this spot "${name}" on [${nm}] — move {to: "${nm}/${name}"} reaches it`); }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Sent and not refused: whether it landed is for look to show.
    return done(`sent "${name}" to [${id}], but the world has not confirmed it yet — look will show it once it lands`);
  }
}
