/**
 * yaw unit contract — #147. World yaw is radians everywhere the runtime
 * touches it, but the agent-authored surfaces said nothing, and the world now
 * holds `yaw: 30.00` beside `yaw: 1.57`: thirty radians next to a right angle,
 * a degree-looking input taken literally. Labelling the doors fixes the
 * contract; this file is what stops the label from evaporating again.
 *
 * It checks three things and refuses to pass vacuously:
 *   1. the conversion boundary (mcpl/units.ts) is arithmetically right, and
 *      the worked example inside YAW_UNITS agrees with the function;
 *   2. every typed `yaw` property on every agent door carries YAW_UNITS —
 *      scanned out of the real source, with a POSITIVE CONTROL proving the
 *      scanner catches the exact unlabeled shapes the issue quotes;
 *   3. AGENTS.md states the unit, carries a degree-to-radian example whose
 *      arithmetic is verified against the module, and spec/PROTOCOL.md still
 *      holds the normative sentence the rest of this points at.
 *
 * No servers, no world, no network — pure files and pure math.
 * Run: bun run tools/yaw-units-test.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { YAW_UNITS, degreesToRadians, radiansToDegrees, formatYaw } from "../mcpl/units.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) < eps;
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

// ---- 1. the conversion boundary -------------------------------------------

console.log("\nthe one conversion boundary");
check("0deg = 0 rad", near(degreesToRadians(0), 0));
check("90deg = Math.PI/2", near(degreesToRadians(90), Math.PI / 2));
check("180deg = Math.PI", near(degreesToRadians(180), Math.PI));
check("-45deg = -Math.PI/4", near(degreesToRadians(-45), -Math.PI / 4));
check("30deg = 0.5236 rad (the worked example)", near(degreesToRadians(30), 0.5235987755982988));
check("radiansToDegrees inverts it", near(radiansToDegrees(degreesToRadians(137.5)), 137.5, 1e-11));
check("the confusion is real: 30 rad is not 30deg", !near(30, degreesToRadians(30), 1));

console.log("\nyaw reads back with its unit");
check("a right angle names degrees", formatYaw(Math.PI / 2) === "1.571 rad (90.0°)", formatYaw(Math.PI / 2));
check("zero is zero", formatYaw(0) === "0 rad (0.0°)", formatYaw(0));
check("a half turn", formatYaw(Math.PI) === "3.142 rad (180.0°)", formatYaw(Math.PI));
// the specimen from the issue: full turns are NAMED, not folded away, so a
// degree-looking scalar stops reading as a plausible bearing.
check("the 30-radian specimen confesses", formatYaw(30) === "30 rad (278.9° after 4 full turns)", formatYaw(30));
check("negative winding names its turns too", formatYaw(-7) === "-7 rad (318.9° after 1 full turn)", formatYaw(-7));
check("a non-rotation says so", formatYaw(NaN).includes("not a rotation"), formatYaw(NaN));

console.log("\nthe schema's own example cannot drift wrong");
check("YAW_UNITS says RADIANS", /RADIANS/.test(YAW_UNITS));
check("YAW_UNITS carries the conversion", /degrees\s*\*\s*Math\.PI\s*\/\s*180/.test(YAW_UNITS), YAW_UNITS);
{
  const m = YAW_UNITS.match(/so\s+(-?\d+(?:\.\d+)?)\s+degrees\s+is\s+(-?\d+(?:\.\d+)?)/i);
  check("YAW_UNITS states a worked degree-to-radian pair", !!m, YAW_UNITS);
  if (m) {
    const deg = Number(m[1]), rad = Number(m[2]);
    check(`its arithmetic holds (${deg}deg = ${rad})`, near(degreesToRadians(deg), rad, 5e-5),
      `${degreesToRadians(deg)} vs ${rad}`);
  }
  check("YAW_UNITS warns what a bare degree value becomes", /bare 30 .*RADIANS/i.test(YAW_UNITS));
}

// ---- 2. the scanner, and proof it bites -----------------------------------

type Yaw = { decl: string; labelled: boolean };

/** Every zod `yaw` property in a source, with whether it names the unit.
 *  Matches `yaw: z.number()...` — the shape the issue quotes as unlabeled. */
function zodYaws(src: string): Yaw[] {
  return [...src.matchAll(/\byaw\s*:\s*z\.[A-Za-z0-9_().]*/g)]
    .map((m) => ({ decl: m[0], labelled: m[0].includes(".describe(YAW_UNITS)") }));
}
/** Every JSON-Schema `yaw` property in a source, likewise.
 *  Matches `yaw: { type: "number" ... }`. */
function schemaYaws(src: string): Yaw[] {
  return [...src.matchAll(/\byaw\s*:\s*\{[^{}]*\}/g)]
    .map((m) => ({ decl: m[0], labelled: /description\s*:\s*YAW_UNITS/.test(m[0]) }));
}

console.log("\nthe scanner bites (positive control — these are the drifts)");
{
  const driftedZod = `    yaw: z.number().optional(), id: z.string().optional(),`;
  const driftedSchema = `y: { type: "number" }, yaw: { type: "number" }, id: { type: "string" }`;
  const inlineProse = `yaw: { type: "number", description: "radians, honest" }`;
  const zd = zodYaws(driftedZod), sd = schemaYaws(driftedSchema), ip = schemaYaws(inlineProse);
  check("finds a bare zod yaw", zd.length === 1 && !zd[0].labelled, JSON.stringify(zd));
  check("finds a bare JSON-Schema yaw", sd.length === 1 && !sd[0].labelled, JSON.stringify(sd));
  // one boundary means one string: a hand-written description is a second
  // dialect of the same contract, and drifts on its own schedule.
  check("refuses a hand-inlined description", ip.length === 1 && !ip[0].labelled, JSON.stringify(ip));
  check("ignores non-schema yaw code",
    zodYaws(`yaw: a.yaw ?? 0`).length === 0 && schemaYaws(`{ yaw: a.yaw }`).length === 0);
  // and it accepts the labelled forms, so green means labelled, not blind
  check("accepts the labelled zod form", zodYaws(`yaw: z.number().optional().describe(YAW_UNITS),`)[0]?.labelled === true);
  check("accepts the labelled schema form", schemaYaws(`yaw: { type: "number", description: YAW_UNITS }`)[0]?.labelled === true);
}

console.log("\nevery typed yaw on every agent door");
const DOORS: [string, (s: string) => Yaw[], number][] = [
  ["mcpl/server.ts", zodYaws, 2],          // stdio MCP: spawn, place
  ["mcpl/net-server.ts", schemaYaws, 2],   // MCPL over WS: spawn, place
];
for (const [file, flavor, least] of DOORS) {
  const src = read(file);
  const found = flavor(src);
  check(`${file} still declares yaw (${found.length} found, ${least}+ expected)`, found.length >= least,
    "fewer typed yaws than this door is known to carry — was a property renamed, or has the scanner been outrun?");
  for (const f of found) {
    check(`${file}: ${f.decl.slice(0, 56)}${f.decl.length > 56 ? "..." : ""}`, f.labelled,
      "a typed yaw with no unit — give it .describe(YAW_UNITS) / description: YAW_UNITS from mcpl/units.ts");
  }
  check(`${file} imports the one boundary`, /from ["']\.\/units\.ts["']/.test(src));
}

console.log("\nthe raw verb door and the reader");
{
  const net = read("mcpl/net-server.ts"), stdio = read("mcpl/server.ts");
  const raw = (s: string) => /world_verb[\s\S]{0,3000}?RADIANS about \+Y/.test(s);
  check("world_verb states the unit (net-server)", raw(net));
  check("world_verb states the unit (stdio server)", raw(stdio));
  check("the sockets example in measure states the unit", /socket yaw is RADIANS/.test(net));
  // measure used to print the stored scalar bare — `yaw 30.00` reads like a
  // bearing. It goes through formatYaw now, which names the unit and the turns.
  check("measure prints yaw through formatYaw", /yaw \$\{formatYaw\(d\.yaw\)\}/.test(net));
  check("measure no longer prints a bare scalar", !/yaw \$\{d\.yaw\.toFixed/.test(net));
}

// ---- 3. the documented vocabulary -----------------------------------------

console.log("\nAGENTS.md — the verb table an author reads");
{
  const md = read("AGENTS.md");
  check("the verb block marks the unit", /spawn\s+\{id, lib, pos, yaw, scale\?\}\s+#[^\n]*yaw RADIANS/.test(md));
  check("a Units section exists", /\*\*Units[^*]*\*\*/.test(md));
  check("it names radians about +Y", /\*\*RADIANS\*\* about\s*\n?\s*\+Y/.test(md));
  check("it names the verbs the unit covers", /`spawn`, `place`, `mount`,\s*\n?`dismount`/.test(md));
  check("the sockets example declares its 3.14 is radians", /`yaw: 3\.14` is \*\*radians\*\*/.test(md));
  const ex = md.match(/yaw:\s*(-?\d+(?:\.\d+)?)\s*\*\s*Math\.PI\s*\/\s*180\s*#\s*(-?\d+(?:\.\d+)?) degrees\s*=\s*(-?\d+(?:\.\d+)?) rad/);
  check("it works one degree-to-radian example", !!ex,
    "expected a `yaw: N * Math.PI / 180   # N degrees = R rad` line");
  if (ex) {
    const expr = Number(ex[1]), deg = Number(ex[2]), rad = Number(ex[3]);
    check("the example converts the degrees it claims", expr === deg, `${expr} vs ${deg}`);
    check(`the example's arithmetic holds (${deg}deg = ${rad} rad)`, near(degreesToRadians(deg), rad, 5e-5),
      `${degreesToRadians(deg)} vs ${rad}`);
  }
  check("it warns that a bare degree value is taken literally", /thirty RADIANS/.test(md));
  // #147 is explicit: raw world state is authoritative, a 30-radian
  // orientation may be intentional, nothing gets rewritten.
  check("it promises not to rewrite existing entities", /Existing entities are never rewritten/.test(md));
}

console.log("\nthe behavior SDK, the third place an author types a yaw");
{
  const dts = read("sdk/behavior.d.ts");
  check("behavior.d.ts states the unit for pos and yaw",
    /`pos` is metres[\s\S]{0,80}`yaw`[\s\S]{0,40}is RADIANS about \+Y/.test(dts),
    "a behavior reads entity().yaw and emits place — it needs the unit where its author reads it");
}

console.log("\nthe normative sentence everything points at");
{
  const proto = read("spec/PROTOCOL.md");
  check("spec/PROTOCOL.md still says yaw is radians about +Y", /`yaw` in radians about \+Y/.test(proto),
    "the protocol is the normative statement — AGENTS.md and mcpl/units.ts cite it");
  check("...with forward = +Z", /forward = \+Z/.test(proto));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : `\n\x1b[32mall green — yaw is radians, and says so\x1b[0m\n`);
process.exit(failures ? 1 : 0);
