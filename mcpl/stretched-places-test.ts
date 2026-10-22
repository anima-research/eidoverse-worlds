/**
 * A named place on a stretched thing is stretched with it, as the thing is drawn.
 *
 * Run: bun mcpl/stretched-places-test.ts
 *
 * A thing's places are in its own frame, and its per-axis scale (scale3)
 * stretches that frame along each axis. So the place a walk goes to, and the
 * coordinates name_place stores, follow the stretch on every axis, and the
 * hand's width a region allows below its floor stays a hand's width in metres.
 * Every thing's frame carries its per-axis scale (a uniform one is three of
 * itself), so where a walk goes to reach a room or a seat, and which room a
 * body stands in first, read the scale per axis too.
 */
import { WorldAgent } from "./agent.ts";
import { toWorld, toLocal, inRegion, destinationOf } from "./places.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

const ag: any = new WorldAgent({ name: "walker", world: "w" });
ag.entities.set("shed", { id: "shed", model: "zz/shed.glb", kind: "thing", pos: [10, 0, 0], yaw: 0, actor: "x", scale: 1, scale3: [2, 1, 4] });
const h = ag.placeHolder(ag.entities.get("shed"));
check("a stretched thing's places are framed at its per-axis scale", h && same(toWorld(h, [1, 0, 1]), [12, 0, 4]), JSON.stringify(h && toWorld(h, [1, 0, 1])));
check("...and a point named on it is stored in its own frame", h && same(toLocal(h, [12, 0, 4]), [1, 0, 1]), JSON.stringify(h && toLocal(h, [12, 0, 4])));

ag.entities.set("mirror", { id: "mirror", model: "zz/mirror.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 2, scale3: [-2, 2, 2] });
const mh = ag.placeHolder(ag.entities.get("mirror"));
check("a mirrored thing's places keep its one-number scale, as places.ts frames only positive axes", mh && same(toWorld(mh, [1, 0, 1]), [2, 0, 2]), JSON.stringify(mh && toWorld(mh, [1, 0, 1])));

ag.entities.set("hall", { id: "hall", model: "zz/hall.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 2, scale3: [1, 2, 1] });
const hall = ag.placeHolder(ag.entities.get("hall"));
const room = { name: "hall", kind: "region", min: [-1, 0, -1], max: [1, 2, 1] } as any;
check("a region on a thing stretched ×2 in height reaches its drawn top", inRegion(hall, room, [0, 3.9, 0]) && !inRegion(hall, room, [0, 4.1, 0]));
check("...and allows a hand's width (0.1 m) below its floor, not twice that",
  inRegion(hall, room, [0, -0.05, 0]) && !inRegion(hall, room, [0, -0.15, 0]));

console.log("where a walk goes");
{
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const box = { name: "room", kind: "region", min: [-1, 0, -1], max: [1, 2, 1] } as any;
  const seat = { name: "chair", kind: "seat", at: [0, 0.5, 0] } as any;
  ag.entities.set("big", { id: "big", model: "zz/big.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 2 });
  const big = ag.placeHolder(ag.entities.get("big"));
  const r = destinationOf(big, box), c = destinationOf(big, seat);
  check("a room on a thing scaled ×2 is reached anywhere on its doubled floor", near(r.reach!, Math.hypot(4, 4) / 2), String(r.reach));
  check("...and its seat from its doubled half-width, with a doubled margin below it", near(c.reach!, 0.7 + 0.3 * 2) && near(c.y, 1 - 0.05 * 2), JSON.stringify(c));
  const rs = destinationOf(h, box), cs = destinationOf(h, seat);   // the shed, stretched [2, 1, 4]
  check("a room on a stretched thing is reached across its stretched floor", near(rs.reach!, Math.hypot(4, 8) / 2), String(rs.reach));
  check("...and its seat from the wider of its stretched half-widths", near(cs.reach!, 0.7 + 0.3 * 4), String(cs.reach));
  // a seat stretched in height alone: its margin below is by its height, its standoff its own half-width
  ag.entities.set("tall-chair", { id: "tall-chair", model: "zz/chair.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 2, scale3: [1, 2, 1] });
  const ct = destinationOf(ag.placeHolder(ag.entities.get("tall-chair")), seat);
  check("a seat stretched ×2 in height has a doubled margin below it and its own standoff", near(ct.y, 1 - 0.05 * 2) && near(ct.reach!, 0.7 + 0.3), JSON.stringify(ct));
  // widest along x: its standoff by that, its margin by its height (×1)
  ag.entities.set("bench", { id: "bench", model: "zz/bench.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 1, scale3: [4, 1, 2] });
  const cb = destinationOf(ag.placeHolder(ag.entities.get("bench")), seat);
  check("...and one stretched widest along x is reached from that width, with the margin of its height", near(cb.reach!, 0.7 + 0.3 * 4) && near(cb.y, 0.5 - 0.05), JSON.stringify(cb));
}
console.log("which room a body is in first");
{
  // The rooms a body stands in come smallest first, each by its size in the world: its own size times the scale its
  // places are framed at. Each row is two rooms around the origin whose own sizes would order them the other way.
  const order = (a: { scale: number; scale3?: number[]; box: number }, b: { scale: number; scale3?: number[]; box: number }) => {
    const ag2: any = new WorldAgent({ name: "walker", world: "w" });
    const room = (id: string, x: { scale: number; scale3?: number[]; box: number }) => ag2.entities.set(id, {
      id, model: `zz/${id}.glb`, kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: x.scale, ...(x.scale3 ? { scale3: x.scale3 } : {}),
      places: { [id]: { min: [-x.box / 2, 0, -x.box / 2], max: [x.box / 2, x.box, x.box / 2] } } });
    room("a", a); room("b", b);
    return ag2.placesAt([0, 0.05, 0]).map((x: any) => x.place.name).join();
  };
  // a: 2 m on a side (8 m³), stretched ×2 in x and y, so 32 m³; b: 16 m³ (2.52 m on a side), unscaled
  const stretched = order({ scale: 2, scale3: [2, 2, 1], box: 2 }, { scale: 1, box: Math.cbrt(16) });
  check("a stretched room is sized per axis: 8 m³ stretched to 32 comes after 16", stretched === "b,a", stretched);
  // a: 10 m on a side (1000 m³) at ×0.1, so 1 m³; b: 2 m on a side (8 m³), unscaled
  const shrunk = order({ scale: 0.1, box: 10 }, { scale: 1, box: 2 });
  check("...and a scaled one by its scale cubed: 1000 m³ at ×0.1 comes before 8", shrunk === "a,b", shrunk);
  // a: mirrored, its places framed at 1 (places.ts frames only positive axes), so 1000 m³; b: 8 m³
  const mirrored = order({ scale: -2, box: 10 }, { scale: 1, box: 2 });
  check("...and a mirrored one as its places are framed, never by a negative volume", mirrored === "b,a", mirrored);
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
