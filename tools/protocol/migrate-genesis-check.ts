// tools/protocol/migrate-genesis-check.ts — migrate-genesis.ts on a world whose genesis is in an earlier shape (B: §3d with the
// number in `version`, before the 10-07 names pass), made from a world founded today and turned back.
//   bun tools/protocol/migrate-genesis-check.ts
// Rows:
//   MG1  --apply keeps the whole old log, byte for byte, as world.pre-genesis-migration.jsonl before replacing it, and the
//        new log is today's shape (bot review #260 10: the "before" file held only the genesis line)
//   MG2  the dry run writes nothing
// GENESIS_TOOL=<path> runs another copy of the tool (a base, for the rows' red).
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { worldIdOf, parseLine, DIALECT } from "../../shared/protocol/fold.js";

const TOOL = process.env.GENESIS_TOOL ?? path.join(ENGINE, "tools/protocol/migrate-genesis.ts");
let pass = 0, fail = 0;
const ok = (c: any, what: string, info?: unknown) => { if (c) { pass++; console.log(`ok   ${what}`); } else { fail++; console.log(`FAIL ${what}${info === undefined ? "" : ` — ${JSON.stringify(info).slice(0, 600)}`}`); } };
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const env = (W: string) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(path.dirname(W), "opt"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });

/** A world founded today, its genesis turned back to shape B ({version: 4, minor, …}) and every later line's id with it. */
function shapeB(tag: string) {
  const root = scratch(tag), W = path.join(root, "worlds"); fs.mkdirSync(path.join(root, "opt"), { recursive: true });
  const f0 = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/world.ts"), "found", "gen", "--owner", "ann"], { cwd: ENGINE, env: env(W) });
  if (f0.exitCode !== 0) throw new Error(`found: ${f0.stderr.toString().slice(-300)}`);
  const f = path.join(W, "gen", "world.jsonl"), lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const g = JSON.parse(lines[0]), newId = worldIdOf(parseLine(lines[0])); const { dialect: _d, v: _v, ...rest } = g.body;
  const gl = JSON.stringify({ ...g, body: { version: 4, ...rest } }), oldId = worldIdOf(parseLine(gl));
  fs.writeFileSync(f, [gl, ...lines.slice(1).map((l) => l.replaceAll(newId, oldId))].join("\n") + "\n");
  return { W, dir: path.join(W, "gen"), f };
}
const run = (W: string, args: string[]) => { const r = Bun.spawnSync(["bun", TOOL, ...args], { cwd: ENGINE, env: env(W), timeout: 60_000 }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };

{ const { W, dir, f } = shapeB("mg1"); const before = fs.readFileSync(f), kept = path.join(dir, "world.pre-genesis-migration.jsonl");
  const r = run(W, ["--apply", dir]); const res = (() => { try { return JSON.parse(r.out.trim().split("\n").at(-1)!); } catch { return null; } })();
  const now = fs.readFileSync(f), g = JSON.parse(now.toString("utf8").split("\n")[0]);
  ok(r.code === 0 && res?.shape === "B" && res?.written === true && g.body?.dialect === DIALECT && !now.equals(before) && fs.existsSync(kept) && sha(fs.readFileSync(kept)) === sha(before),
    "MG1 --apply keeps the whole old log, byte for byte, beside the migrated one (world.pre-genesis-migration.jsonl); the new log is today's shape",
    { code: r.code, res, dialect: g.body?.dialect, kept: fs.existsSync(kept), out: r.out.slice(-400) }); }
{ const { W, dir, f } = shapeB("mg2"); const before = fs.readFileSync(f), files = fs.readdirSync(dir).sort();
  const r = run(W, [dir]);
  ok(r.code === 0 && fs.readFileSync(f).equals(before) && JSON.stringify(fs.readdirSync(dir).sort()) === JSON.stringify(files) && /"written":false/.test(r.out),
    "MG2 the dry run (no --apply) writes nothing", { code: r.code, files: fs.readdirSync(dir), out: r.out.slice(-300) }); }

console.log(`[migrate-genesis-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
