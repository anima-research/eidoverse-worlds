// @ts-nocheck
// tools/protocol/libfile-check.ts — the ONE resolver from a library path to a file (server/libfile.ts) agrees with what
// /library serves. Port of upstream #213's resolver contract (tools/spawn-lint-unit-test.ts, v1) onto the protocol branch,
// where the authority REFUSES a model the catalogue can't name (authority.js valueCheck: "no model called …") instead of
// v1's advisory lint — so the whole of #213 that survives is: the resolver walks /library's own ladder, in its order,
// and answers exactly what the route would serve. Upstream #220 (ported 2026-10-19): a name is read as the route reads
// it, the lib as a client's URL carries it and each run of escapes decoded back to the disk name (libfile.ts
// libraryRel, which the /library route calls too; tools/library-decode-test.ts holds the route's own cases).
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/libfile-check.ts
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";

const root = scratch("libfile");
const ladder = ["patched", "opt", "library"].map((d) => { const p = path.join(root, d); fs.mkdirSync(p, { recursive: true }); return p; });
// config.ts reads these at import, so they are set before the resolver is loaded
process.env.PATCH_DIR = ladder[0]; process.env.OPT_DIR = ladder[1]; process.env.EIDOVERSE_DIR = ladder[2];
const { resolveLibFile, libraryFile, libraryRel } = await import("../../server/libfile.ts");
const { LADDER } = await import("../../server/config.ts");

let pass = 0, fail = 0;
const ok = (c, name, info) => { if (c) { pass++; console.log("  ✓", name); } else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const at = (i, name) => path.join(ladder[i], name);
const put = (i, name, body = "fixture") => fs.writeFileSync(at(i, name), body);

ok(LADDER.length === 3 && LADDER[0] === ladder[0] && LADDER[2] === ladder[2], "L0 the route's ladder is patched › opt › library (config LADDER)", LADDER);

// precedence: the first rung that holds the name wins, in the route's order
for (const i of [0, 1, 2]) put(i, "shared.glb");
ok(resolveLibFile("shared.glb") === at(0, "shared.glb"), "L1 a patched model wins over everything (as /library serves it)", resolveLibFile("shared.glb"));
fs.rmSync(at(0, "shared.glb"));
ok(resolveLibFile("shared.glb") === at(1, "shared.glb"), "L2 the optimized copy wins over the source library", resolveLibFile("shared.glb"));
fs.rmSync(at(1, "shared.glb"));
ok(resolveLibFile("shared.glb") === at(2, "shared.glb"), "L3 the source library answers when nothing overrides it", resolveLibFile("shared.glb"));

// a version or fragment names the same served file
for (const sfx of ["?v=123", "#mesh", "?v=123#mesh"]) ok(resolveLibFile("shared.glb" + sfx) === at(2, "shared.glb"), `L4 a query/fragment resolves the served file: ${sfx}`, resolveLibFile("shared.glb" + sfx));

// leaving the library is refused; two dots in a NAME are a name
ok(resolveLibFile("../x/secret.glb") === null && resolveLibFile("a/../../x.glb") === null, "L5 a path that leaves /library is refused");
ok(resolveLibFile("%2e%2e/shared.glb") === null, "L6 URL-normalized traversal is refused too", resolveLibFile("%2e%2e/shared.glb"));
put(2, "robot..v2.glb");
ok(resolveLibFile("robot..v2.glb") === at(2, "robot..v2.glb"), "L7 a name with two dots is a name, served and resolved (not traversal)", resolveLibFile("robot..v2.glb"));

// a directory named like a model is no model, and it shadows a lower rung's file (the route stops at the first entry)
fs.mkdirSync(at(2, "folder.glb"));
ok(resolveLibFile("folder.glb") === null, "L8 a directory named like a model is no model", resolveLibFile("folder.glb"));
fs.mkdirSync(at(0, "shadow.glb")); put(2, "shadow.glb");
ok(resolveLibFile("shadow.glb") === null, "L9 a patched directory shadows the library's file of that name (as /library would 404)", resolveLibFile("shadow.glb"));
fs.mkdirSync(at(1, "body.vrm")); put(2, "body.vrm");
ok(resolveLibFile("body.vrm") === null, "L10 an opt directory shadows the library's VRM of that name", resolveLibFile("body.vrm"));

// unservable paths are "no file", never a throw: through a file (ENOTDIR), past the name limit (ENAMETOOLONG)
for (const lib of ["shared.glb/x.glb", "a".repeat(300) + ".glb", "é".repeat(90) + ".glb"]) {
  let r = "threw"; try { r = resolveLibFile(lib); } catch (e) { r = `threw ${e?.code ?? e}`; }
  ok(r === null, `L11 no file, not a throw: ${lib.slice(0, 20)}…`, r);
}
// not a model at all
ok(resolveLibFile("notes.txt") === null && resolveLibFile("") === null, "L12 only .glb/.vrm resolve");

// upstream #220: a disk name with a space or an accent resolves, as the route decodes the URL the client sends for it;
// a disk name that IS the encoded form wins over decoding, on any rung; an encoded lib isn't encoded twice
for (const name of ["space model.glb", "café.glb"]) {
  put(2, name, "literal");
  ok(resolveLibFile(name) === at(2, name), `L13 a literal disk name with a space or accent resolves, as the route decodes it: ${name}`, resolveLibFile(name));
  const encoded = new URL("/library/" + name, "http://library.invalid").pathname.slice("/library/".length);
  put(2, encoded, "encoded");
  ok(resolveLibFile(name) === at(2, encoded), `L14 a disk name that is the encoded form wins over decoding, as in the route: ${name}`, resolveLibFile(name));
  ok(resolveLibFile(encoded) === at(2, encoded), `L15 an already-encoded lib is not encoded twice: ${encoded}`, resolveLibFile(encoded));
}
put(1, "box%43.glb", "opt-literal");
ok(libraryRel("box%43.glb") === "box%43.glb" && resolveLibFile("box%43.glb") === at(1, "box%43.glb"), "L16 a literal %xx name only a higher rung holds is itself, not decoded to a name no rung has");
put(2, "50% off.glb");
ok(resolveLibFile("50% off.glb") === at(2, "50% off.glb"), "L17 a bare % stays, and the rest of the name still decodes", resolveLibFile("50% off.glb"));
// a sibling whose name starts with the library's passes a string-prefix containment check: only the refusal of a
// decoded ".." stops this
fs.mkdirSync(path.join(root, "library-backup"), { recursive: true });
fs.writeFileSync(path.join(root, "library-backup", "secret.glb"), "sibling");
ok(resolveLibFile("..%2flibrary-backup%2fsecret.glb") === null && libraryRel("..%2flibrary-backup%2fsecret.glb") === null,
  "L18 a decoded .. can't reach a sibling directory named like the library");
// a clip (the animation roster's resolver) reads its path the same way
fs.mkdirSync(at(2, "clips"), { recursive: true });
put(2, "clips/space clip.vrma");
ok(libraryFile("clips/space clip.vrma", /\.vrma$/i) === at(2, "clips/space clip.vrma") && libraryFile("clips/space clip.vrma", /\.glb$/i) === null,
  "L19 a clip resolves by the same reading, and only with its own extension");

console.log(`[libfile-check] ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
