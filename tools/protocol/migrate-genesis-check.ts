// tools/protocol/migrate-genesis-check.ts — migrate-genesis.ts is retired (minor 1): the name runs nothing, points at the whole-log
// migration (tools/protocol/migrate-minor-1), and touches no file, with or without --apply.
//   bun tools/protocol/migrate-genesis-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { foundWorlds } from "../harness.ts";

const TOOL = path.join(ENGINE, "tools/protocol/migrate-genesis.ts");
let pass = 0, fail = 0;
const ok = (c: any, what: string, info?: unknown) => { if (c) { pass++; console.log(`ok   ${what}`); } else { fail++; console.log(`FAIL ${what}${info === undefined ? "" : ` — ${JSON.stringify(info).slice(0, 600)}`}`); } };
const root = scratch("mg"), W = path.join(root, "worlds"); foundWorlds(W, ["gen"], "ann");
const dir = path.join(W, "gen"); const before = fs.readFileSync(path.join(dir, "world.jsonl")); const files = fs.readdirSync(dir).sort();
for (const args of [[dir], ["--apply", dir]]) {
  const r = Bun.spawnSync(["bun", TOOL, ...args], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const said = r.stdout.toString() + r.stderr.toString();
  ok(r.exitCode === 2 && /retired/.test(said) && /migrate-minor-1/.test(said) && /Nothing was read or changed/.test(said), `MG1 \`migrate-genesis ${args.join(" ").replace(dir, "<dir>")}\` refuses, naming the whole-log migration that replaced it`, said.slice(0, 300));
  ok(fs.readFileSync(path.join(dir, "world.jsonl")).equals(before) && JSON.stringify(fs.readdirSync(dir).sort()) === JSON.stringify(files), "MG2 …and wrote nothing", fs.readdirSync(dir));
}
console.log(`[migrate-genesis-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
