// test/gate/merge-receipts.ts — N shard receipts → one gate receipt, or a FAIL naming why they aren't the gate (a shard
// missing or refused, a suite missing, twice or red, mixed heads). The rules are shard.ts merge; shard-check.ts holds the rows.
//   bun test/gate/merge-receipts.ts --of 4 --out gate-receipt-<os>.json <receipt.json | dir>…
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ENGINE } from "./common.ts";
import { merge, type Receipt } from "./shard.ts";

const argv = process.argv.slice(2), val = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] ?? null : null);
const of = Number(val("--of")), out = val("--out");
const inputs = argv.filter((a, i) => !a.startsWith("--") && !["--of", "--out"].includes(argv[i - 1]));
if (!Number.isInteger(of) || of < 1 || !out) { console.log("bun test/gate/merge-receipts.ts --of N --out <merged.json> <receipt.json | dir>…"); process.exit(2); }
const files: string[] = [];
const walk = (p: string) => { if (!fs.existsSync(p)) return; if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); else if (p.endsWith(".json")) files.push(p); };
for (const p of inputs) walk(p);
const read = (f: string): Receipt | null => { try { const r = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(r?.suites) && r.os ? r : null; } catch { return null; } };
const head = spawnSync("git", ["-C", ENGINE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() || null;
const { problems, merged } = merge(files.map((file) => ({ file, receipt: read(file) })), { of, head });
fs.writeFileSync(out, JSON.stringify(merged, null, 1) + "\n");
console.log(`merge-receipts: ${files.length} receipt(s), ${of} shard(s), ${merged.suites.length} suite(s) at ${head?.slice(0, 12) ?? "(no head)"}`);
for (const p of problems) console.log(`  FAIL ${p}`);
console.log(`protocol gate (${of} shards merged): ${problems.length ? `FAILED (${problems.length} problem(s))` : "PASS"}; receipt: ${out}`);
process.exit(problems.length ? 1 : 0);
