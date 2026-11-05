// axes-test — the axis letters are one table (shared/axes.js), and the negative letters do what each surface did before
// it was one: motion, its reader, the editor and look-at's reader take all six; look-at's door and turn take x, y, z only.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/axes-test.ts
// @ts-nocheck
import "./protocol/fixture-ids.ts";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AXES, POSITIVE_AXES } from "../shared/axes.js";
import * as D from "../shared/descriptors.js";
import * as ES from "../shared/editschema.js";
import * as LA from "../shared/lookat.js";
import * as ME from "../client/lib/motioneval.js";
import * as SH from "./protocol/import-v1/shapes.js";
import { scratchWorld } from "./protocol/scratchworld.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== "" ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ""}`); };
const ROOT = fileURLToPath(new URL("..", import.meta.url));

check("AX1 every reader's table is shared/axes.js's own object (descriptors, editschema, lookat, motioneval, the v1 importer)",
  D.AXES === AXES && ES.AXES === AXES && LA.AXIS === AXES && ME.AXES === AXES && SH.AXIS_VECTORS === AXES && Object.keys(AXES).join() === "x,y,z,-x,-y,-z" && Object.keys(POSITIVE_AXES).join() === "x,y,z");
const W = fs.readFileSync(ROOT + "shared/protocol/authority/writes.js", "utf8");
check("AX1 …and the door holds no table of its own (motion: AXES; look-at and turn: POSITIVE_AXES)", /MOTION_AXES = AXES;/.test(W) && /AXV = POSITIVE_AXES;/.test(W) && /AX = POSITIVE_AXES;/.test(W) && !/\[-1, 0, 0\]/.test(W));

const S = scratchWorld("axes"); S.call("create", { id: "fan", model: "crate", components: { transform: { pos: [0, 0, 0] } } });
const m = S.call("set", { id: "fan", component: "motion", value: { type: "spin", axis: "-y", degPerSec: 10 } });
check("AX2 a motion takes a negative letter at the door and stores its vector", m.ok && JSON.stringify(S.state().entities.fan.c.motion.axis) === "[0,-1,0]", m.refused ?? S.state().entities.fan.c.motion);
S.call("create", { id: "eye", model: "crate", components: { transform: { pos: [3, 0, 0] } } });
const lp = S.call("set", { id: "eye", component: "look-at", value: { target: "@viewer", forward: "x" } });
const ln = S.call("set", { id: "eye", component: "look-at", value: { target: "@viewer", forward: "-x" } });
check("AX3 look-at's door takes a positive letter as its vector and refuses a negative one (as before the table was one)", lp.ok && JSON.stringify(S.state().entities.eye.c["look-at"].forward) === "[1,0,0]" && !ln.ok, [lp.refused ?? S.state().entities.eye.c["look-at"], ln.refused]);
const tn = S.call("turn", { id: "fan", axis: "-x", deg: 30 }), tp = S.call("turn", { id: "fan", axis: "x", deg: 30 });
check("AX4 turn takes x, y, z and refuses a negative letter (as before)", tp.ok && !tn.ok && tn.refused?.code === "shape", [tp.refused, tn.refused]);
check("AX5 the readers read negative letters: descriptors' axisVector, motioneval's axisOf reading, look-at's reader table",
  JSON.stringify(D.axisVector("-z")) === "[0,0,-1]" && JSON.stringify(ME.AXES["-y"]) === "[0,-1,0]" && JSON.stringify(LA.AXIS["-x"]) === "[-1,0,0]");
check("AX6 the table can't be changed under its readers (frozen, the vectors too)", Object.isFrozen(AXES) && Object.isFrozen(AXES.x) && Object.isFrozen(POSITIVE_AXES));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
