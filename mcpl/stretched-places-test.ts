/**
 * A named place on a stretched thing is stretched with it, as the thing is drawn.
 *
 * Run: bun mcpl/stretched-places-test.ts
 *
 * A thing's places are in its own frame, and its per-axis scale (scale3)
 * stretches that frame along each axis. So the place a walk goes to, and the
 * coordinates name_place stores, follow the stretch on every axis, and the
 * hand's width a region allows below its floor stays a hand's width in metres.
 */
import { WorldAgent } from "./agent.ts";
import { toWorld, toLocal, inRegion } from "./places.ts";

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

ag.entities.set("hall", { id: "hall", model: "zz/hall.glb", kind: "thing", pos: [0, 0, 0], yaw: 0, actor: "x", scale: 1, scale3: [1, 2, 1] });
const hall = ag.placeHolder(ag.entities.get("hall"));
const room = { name: "hall", kind: "region", min: [-1, 0, -1], max: [1, 2, 1] } as any;
check("a region on a thing stretched ×2 in height reaches its drawn top", inRegion(hall, room, [0, 3.9, 0]) && !inRegion(hall, room, [0, 4.1, 0]));
check("...and allows a hand's width (0.1 m) below its floor, not twice that",
  inRegion(hall, room, [0, -0.05, 0]) && !inRegion(hall, room, [0, -0.15, 0]));

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
