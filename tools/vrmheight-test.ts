// vrmheight-test — a body's stature read from its VRM file (server/vrmheight.ts,
// through shared/rig.js's stature()), the door's bodyHeightFor reading the same
// rule, and the roster's height ladder (server/routes.ts avatarRoster).
//
//   bun tools/vrmheight-test.ts
//
// The VRMs are synthesized: hips at 0.9 m under an armature node, the head
// joint 0.47 m above them, and a mesh whose box reaches 2.2 m, as the default
// claude.vrm's crown of tentacles does. Stature is the head joint plus 0.13 m,
// the browser's portrait rule, so the mesh doesn't count and these bodies read
// 1.50 m. Temp dirs and a local HTTP server; no sequencer.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
};
const near = (got: number | null | undefined, want: number) => got != null && Math.abs(got - want) < 1e-6;

const root = mkdtempSync(join(tmpdir(), "vrmheight-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));   // a throw mid-test too
Object.assign(process.env, { SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: join(root, "opt"),
  EIDOVERSE_DIR: join(root, "lib"), DEFS_DIR: join(root, "defs"), JOIN_TOKEN: "t0k", KTX2_TOKTX: "" });

// ---- synthesized bodies ------------------------------------------------------
/** A GLB holding just a JSON chunk: stature reads nodes and the humanoid
 *  extension, never vertex data. */
function glb(json: unknown, extra = 0): Uint8Array {
  const je = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (je.length % 4)) % 4 + extra, total = 20 + je.length + pad;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, je.length + pad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(je, 20); out.fill(0x20, 20 + je.length);
  return out;
}
const V1 = { VRMC_vrm: { specVersion: "1.0", humanoid: { humanBones: { hips: { node: 1 }, head: { node: 2 } } } } };
const V0 = { VRM: { humanoid: { humanBones: [{ bone: "hips", node: 1 }, { bone: "head", node: 2 }] } } };
function body(humanoid: object | null, { headY = 0.47, scale = 1, extra = 0 } = {}): Uint8Array {
  return glb({
    asset: { version: "2.0" },
    scenes: [{ nodes: [0, 3] }],
    nodes: [
      { name: "Armature", scale: [scale, scale, scale], children: [1] },
      { name: "hips", translation: [0, 0.9, 0], children: [2] },
      { name: "head", translation: [0, headY, 0] },
      { name: "crown", mesh: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [0.2, 2.2, 0] }],
    ...(humanoid ? { extensions: humanoid } : {}),
  }, extra);
}

const vdir = join(root, "lib", "eidoverse/assets/vrms");
mkdirSync(vdir, { recursive: true });
const put = (name: string, bytes: Uint8Array | string, at = 1_700_000_000_000) => {
  const f = join(vdir, `${name}.vrm`);
  writeFileSync(f, bytes);
  utimesSync(f, new Date(at), new Date(at));
  return f;
};

// ---- 1. the file's stature ---------------------------------------------------
console.log("the file's stature (server/vrmheight.ts)");
const { vrmHeightFor } = await import("../server/vrmheight.ts");
// stature for a target height: the head joint sits 1.37 m up, times the armature's scale
const sized = (m: number) => body(V1, { scale: (m - 0.13) / 1.37 });
const notGlb = body(V1);
new DataView(notGlb.buffer).setUint32(0, 0x12345678, true);   // a whole file, but not glTF's magic
const cases: [string, Uint8Array][] = [
  ["plain", body(V1)], ["worn", body(V0)], ["declared", body(V1)], ["scaled", body(V1, { scale: 1.651 })],
  ["headless", body(null)], ["nothing", body(null)], ["giant", body(V1, { headY: 9 })], ["notglb", notGlb],
  ["small", sized(0.55)], ["tiny", sized(0.45)], ["tall", sized(3.95)], ["toolong", sized(4.05)],
  ["my body", body(null)],
];
for (const [name, bytes] of cases) put(name, bytes);
const files = Object.fromEntries(cases.map(([n]) => [n, join(vdir, `${n}.vrm`)]));
check("a VRM 1.0 body reads its head joint plus 0.13 m, not its mesh's 2.2 m box", near(vrmHeightFor(files.plain, "1"), 1.5), vrmHeightFor(files.plain, "1"));
check("a VRM 0.x body reads the same", near(vrmHeightFor(files.worn, "1"), 1.5), vrmHeightFor(files.worn, "1"));
check("a scale on the armature scales the stature", near(vrmHeightFor(files.scaled, "1"), 1.37 * 1.651 + 0.13), vrmHeightFor(files.scaled, "1"));
check("a file with no humanoid head has none", vrmHeightFor(files.headless, "1") === null);
check("a head joint far out of range has none", vrmHeightFor(files.giant, "1") === null, vrmHeightFor(files.giant, "1"));
check("the range is 0.5 to 4 m: 0.55 and 3.95 are kept, 0.45 and 4.05 have none",
  near(vrmHeightFor(files.small, "1"), 0.55) && near(vrmHeightFor(files.tall, "1"), 3.95)
    && vrmHeightFor(files.tiny, "1") === null && vrmHeightFor(files.toolong, "1") === null,
  [files.small, files.tall, files.tiny, files.toolong].map((f) => vrmHeightFor(f, "1")));
check("a file whose header isn't glTF's has none, though its JSON would read", vrmHeightFor(files.notglb, "1") === null, vrmHeightFor(files.notglb, "1"));
{
  // a JSON chunk that claims 2 GB in a file of a few hundred bytes: read at its
  // claimed length, it would be decoded as 2 GB of text before failing to parse
  const lying = body(V1), dv = new DataView(lying.buffer);
  dv.setUint32(12, 0x7fffffff, true);
  const f = put("lying", lying);
  const before = process.memoryUsage().rss;
  const h = vrmHeightFor(f, "1");
  const grew = process.memoryUsage().rss - before;
  check("a header that claims a 2 GB JSON chunk gives none, without decoding it", h === null && grew < 500e6,
    { h, grewMB: Math.round(grew / 1e6) });
}
{
  // a humanoid whose JSON chunk, padded with JSON's own whitespace, runs past
  // 16 MiB: no real VRM's does, and it isn't decoded
  const f = put("padded", body(V1, { extra: 16 * 1024 * 1024 }));
  check("a JSON chunk past 16 MiB isn't read, though it would parse", vrmHeightFor(f, "1") === null, vrmHeightFor(f, "1"));
}
{
  // a read that fails (here the path is a directory: EISDIR) isn't remembered,
  // so once the file is readable at the same version, it reads
  const f = join(vdir, "flaky.vrm");
  mkdirSync(f);
  const first = vrmHeightFor(f, "1");
  rmSync(f, { recursive: true });
  writeFileSync(f, body(V1));
  check("a failed read isn't remembered: the same version reads once it can", first === null && near(vrmHeightFor(f, "1"), 1.5),
    { first, then: vrmHeightFor(f, "1") });
}
{
  const f = put("changing", body(V1));
  const first = vrmHeightFor(f, "1");
  writeFileSync(f, body(V1, { headY: 0.6 }));
  check("the same version answers from memory, without reading the file again", near(vrmHeightFor(f, "1"), 1.5) && near(first, 1.5), vrmHeightFor(f, "1"));
  check("a new version reads the file again", near(vrmHeightFor(f, "2"), 1.63), vrmHeightFor(f, "2"));
}

// ---- 2. the door reads the same rule ---------------------------------------
console.log("the door's bodyHeightFor (mcpl/rigbones.ts)");
const { bodyHeightFor } = await import("../mcpl/rigbones.ts");
const srv = Bun.serve({ port: 0, fetch: (req) => {
  const path = decodeURIComponent(new URL(req.url).pathname).replace(/^\/library\//, "");
  return new Response(Bun.file(join(root, "lib", path)));
} });
try {
  const base = `http://localhost:${srv.port}`;
  for (const name of ["plain", "worn", "scaled", "headless", "giant"]) {
    const door = await bodyHeightFor(base, `eidoverse/assets/vrms/${name}.vrm?v=1`);
    const file = vrmHeightFor(files[name], "1");
    check(`${name}: the door reads the stature the roster's vrmHeightFor reads (${file?.toFixed(3) ?? "none"})`, door === file, { door, file });
  }
} finally { srv.stop(true); }

// ---- 3. the roster's ladder ---------------------------------------------------
console.log("the roster's height (server/routes.ts avatarRoster)");
mkdirSync(join(root, "defs", "avatars"), { recursive: true });
writeFileSync(join(root, "defs", "avatars", "declared.json"), JSON.stringify({ height: 1.8 }));
mkdirSync(join(root, "opt", "thumbs"), { recursive: true });
// what wearers' browsers posted (POST /thumb): the portrait's framing height
writeFileSync(join(root, "opt", "thumbs", "meta.json"), JSON.stringify({ worn: { h: 2.21 }, headless: { h: 1.62 }, giant: { h: 4 }, my_body: { h: 1.7 } }));
const { avatarRoster } = await import("../server/routes.ts");
const height = (name: string) => avatarRoster().find((a) => a.name === name)?.height;
check("a body nobody has worn has its file's stature", near(height("plain"), 1.5), height("plain"));
check("a worn body keeps its file's stature, not the posted framing height", near(height("worn"), 1.5), height("worn"));
check("a def's declared height comes first", height("declared") === 1.8, height("declared"));
check("a posted height stands in for a file with no humanoid head", height("headless") === 1.62, height("headless"));
check("…and for a head out of range", height("giant") === 4, height("giant"));
check("a posted height is found under the name's safe form (my body → my_body)", height("my body") === 1.7, height("my body"));
check("with none of them, no height", height("nothing") === null, height("nothing"));
put("plain", body(V1, { headY: 0.6 }), 1_700_000_500_000);   // a re-export
check("a re-export's stature shows at once", near(height("plain"), 1.63), height("plain"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
