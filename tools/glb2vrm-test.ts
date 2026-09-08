// glb2vrm rig-family gate (#123), run headless.
//
//   bun tools/glb2vrm-test.ts
//
// The gate exists because a Mixamo rig fed to the converter used to die on
// its first missing Tripo bone ("node not found: Hip"), naming a bone the
// user never chose instead of the actual contract. These tests synthesize
// minimal GLBs (a JSON chunk is a valid GLB; no geometry needed to test
// name-based family detection) and drive the real CLI, asserting on the
// message and exit code. Real-rig provenance: the gate was verified by hand
// against three.js's Xbot.glb, a genuine Mixamo export with the colon kept.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

function makeGLB(nodeNames: string[]): Uint8Array {
  const json = { asset: { version: "2.0" }, nodes: nodeNames.map((name) => ({ name })), scenes: [{ nodes: [] }] };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + pad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + pad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length);
  return out;
}

const TRIPO_BONES = [
  "Hip", "Spine01", "Spine02", "NeckTwist01", "Head",
  "L_Clavicle", "L_Upperarm", "L_Forearm", "L_Hand",
  "R_Clavicle", "R_Upperarm", "R_Forearm", "R_Hand",
  "L_Thigh", "L_Calf", "L_Foot", "L_ToeBase",
  "R_Thigh", "R_Calf", "R_Foot", "R_ToeBase",
];

const MIXAMO_BONES = [
  "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2",
  "mixamorig:Neck", "mixamorig:Head",
  "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot", "mixamorig:LeftToeBase",
];

const dir = mkdtempSync(join(tmpdir(), "glb2vrm-test-"));
const write = (name: string, bones: string[]) => {
  const p = join(dir, name);
  writeFileSync(p, makeGLB(bones));
  return p;
};

async function run(file: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "glb2vrm.ts"), file, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

console.log("mixamo family is refused by name, both paths");
{
  const glb = write("mixamo.glb", MIXAMO_BONES);
  const convert = await run(glb, "--name", "t");
  check("convert exits 1", convert.code === 1);
  check("convert names the family", /Mixamo rig detected/.test(convert.err), convert.err.trim());
  check("convert says what to do", /Rerig using Tripo humanoid/.test(convert.err));
  check("convert never says 'node not found'", !/node not found/.test(convert.err), convert.err.trim());
  const measure = await run(glb, "--measure");
  check("--measure exits 1", measure.code === 1);
  check("--measure names the family", /Mixamo rig detected/.test(measure.err), measure.err.trim());
}

console.log("prefix variants still identify as mixamo");
{
  for (const variant of ["mixamorigHips", "mixamorig1:Hips", "MixamoRig:Hips"]) {
    const glb = write(`v-${variant.replace(/[^a-z0-9]/gi, "")}.glb`, [variant, "Spine", "Head"]);
    const r = await run(glb, "--name", "t");
    check(`${variant} detected`, r.code === 1 && /Mixamo rig detected/.test(r.err), r.err.trim());
  }
}

console.log("an unknown rig gets the contract, not one bone");
{
  const glb = write("unknown.glb", ["Root", "Bone01", "Bone02"]);
  const r = await run(glb, "--name", "t");
  check("exits 1", r.code === 1);
  check("asks 'not a Tripo rig?'", /not a Tripo rig\?/.test(r.err), r.err.trim());
  check("lists Hip among the missing", /missing bones .*Hip/.test(r.err));
  check("never says 'node not found'", !/node not found/.test(r.err), r.err.trim());
}

console.log("a tripo-named rig passes the gate");
{
  // Bones alone are not a convertible body (no skin, no mesh), so conversion
  // still fails downstream. The assertion is that it gets PAST the gate:
  // whatever it dies of is not a family rejection.
  const glb = write("tripo.glb", ["Armature", ...TRIPO_BONES]);
  const r = await run(glb, "--name", "t");
  check("not refused as mixamo", !/Mixamo rig detected/.test(r.err), r.err.trim());
  check("not refused as unknown", !/not a Tripo rig\?/.test(r.err), r.err.trim());
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
