// /library/ percent-decoding (routes.ts): spaces resolve, a literal "%xx" file
// name is served as itself, malformed escapes don't throw, and a decoded ".."
// can't reach a sibling directory that shares the library's name prefix.
// The raw-first guard covers the whole ladder, patched included.
//   bun tools/library-decode-test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "libdecode-"));
const lib = join(root, "library"), models = join(lib, "eidoverse/assets/models");
mkdirSync(models, { recursive: true }); mkdirSync(join(root, "library-backup")); mkdirSync(join(root, "opt"));
mkdirSync(join(root, "patched"));
writeFileSync(join(models, "a b.glb"), "space");
writeFileSync(join(models, "box%41.glb"), "literal");
writeFileSync(join(models, "boxA.glb"), "A");
writeFileSync(join(root, "library-backup", "secret.json"), "SECRET");
// A literal "%42" name only the patched rung holds must win over decoding to
// the library's boxB.glb: the route consults patched first.
writeFileSync(join(root, "patched", "box%42.glb"), "patched-literal");
writeFileSync(join(lib, "boxB.glb"), "B");

const PORT = 8000 + Math.floor(Math.random() * 900);
const seq = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: mkdtempSync(join(tmpdir(), "libdecode-w-")), EIDOVERSE_DIR: lib, OPT_DIR: join(root, "opt"), PATCH_DIR: join(root, "patched"), SKIP_OPT_SWEEP: "1" },
  stdout: "ignore", stderr: "ignore",
});
process.on("exit", () => seq.kill());
const base = `http://127.0.0.1:${PORT}/library/`;
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/worlds`); up = true; } catch { await Bun.sleep(200); } }
if (!up) { console.error("FATAL: scratch sequencer never came up (run bun install in the repo root?)"); process.exit(2); }

let pass = 0, fail = 0;
async function expect(path: string, status: number, body?: string) {
  const r = await fetch(base + path); const t = await r.text();
  const ok = r.status === status && (body === undefined || t === body);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok " : "FAIL "} ${path} → ${r.status}${body !== undefined ? ` "${t.slice(0, 20)}"` : ""}`);
}
await expect("eidoverse/assets/models/a%20b.glb", 200, "space");
await expect("eidoverse/assets/models/box%41.glb", 200, "literal");
await expect("eidoverse/assets/models/boxA.glb", 200, "A");
await expect("box%42.glb", 200, "patched-literal");
await expect("..%2flibrary-backup%2fsecret.json", 403);
await expect("eidoverse%2f..%2f..%2flibrary-backup%2fsecret.json", 403);
await expect("eidoverse/assets/models/bad%E0%A4.glb", 404);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
