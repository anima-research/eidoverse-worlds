// tools/v4/migrate-genesis.ts — move an engine v4 world from the pre-§3d genesis ({version, owners: [<identity>…]},
// sometimes translatedFrom) to §2.4 + §3d ({version, minor: 0, nonce, owners: [[<key>…], …], sequencer}). Ported from
// code/v4-lab/migrate-genesis.js (lab 62301b8) for the engine's layout (<world dir>/v4.jsonl). Review F1, 2026-10-05.
//   - owners: each old owner identity -> that identity's custody key; none -> [[], [sequencer]] (the custodial default:
//     tier 0 empty, this server's key in tier 1). Keys come from the custody file every world in that worlds dir shares
//     (<worlds dir>/.v4-custody.json, server/v4/custody.ts), so a running server reads the same keys.
//   - nonce: the first 16 bytes of sha256(the old log's bytes): unique per log, and reproducible.
//   - translatedFrom can't stay in a known minor's genesis (its fields are exact). The old genesis line is kept,
//     verbatim, in <world dir>/v4.genesis-before.jsonl with both world ids. (A newly translated world carries it as the
//     `translated` act after genesis instead; an existing log can't gain an entry in the middle.)
//   - every later line's `world` is rewritten from the old id to the new one (a text replace: number spellings kept).
// SAFETY: a log is rewritten only if the state digest is the same before (the previous fold, from git --old-fold, default d4e0677a~1) and after
// (today's fold AND the Python reference reader). Stop the world's server first: it holds the old world id in memory.
// usage: bun tools/v4/migrate-genesis.ts [--apply] <world dir>…   (dry run without --apply; skips a log already on §3d)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readLog, fold, digest, worldIdOf, parseLine } from "../../shared/v4/fold.js";
import { custodyAt } from "../../server/v4/custody.ts";
import { ENGINE } from "./common.ts";

const apply = process.argv.includes("--apply");
// --old-fold <git ref>: the fold that still reads the OLD genesis (the "before" digest). Default: the tree just before the
// §3d port (d4e0677a~1). HEAD is wrong once the port is committed: its fold rightly reads an old genesis as no-world.
const ofi = process.argv.indexOf("--old-fold"); const OLD_REF = ofi > 0 ? process.argv[ofi + 1] : "d4e0677a~1";
const dirs = process.argv.slice(2).filter((a, i, all) => a !== "--apply" && a !== "--old-fold" && all[i - 1] !== "--old-fold");
const oldFoldPath = path.join(ENGINE, "shared/v4/.baseline-fold-HEAD.mjs"); // beside fold.js so its own imports resolve
const shown = Bun.spawnSync(["git", "show", `${OLD_REF}:shared/v4/fold.js`], { cwd: ENGINE });
if (shown.exitCode !== 0) throw new Error(`can't read the previous fold from git ${OLD_REF}`);
fs.writeFileSync(oldFoldPath, shown.stdout);
const out: Record<string, unknown>[] = [];
try {
  const old = await import(oldFoldPath);
  for (const dir of dirs) {
    const f = path.join(dir, "v4.jsonl");
    const raw = fs.readFileSync(f); const text = raw.toString("utf8"); const nl = text.indexOf("\n");
    const gline = text.slice(0, nl); const g = JSON.parse(gline);
    if (g.kind !== "genesis" || "minor" in (g.body ?? {})) { out.push({ dir, skipped: "already §3d, or no genesis" }); continue; }
    const before = old.fold(old.readLog(raw)); const dBefore = before.status === "ok" ? old.digest(before) : null;
    const cu = custodyAt(path.join(path.dirname(path.resolve(dir)), ".v4-custody.json"));
    const oldId = worldIdOf(parseLine(gline));
    const owners = (g.body.owners ?? []).length ? [g.body.owners.map((who: string) => cu.keyOf(who, true))] : [[], [cu.sequencer()]];
    const body = { version: 4, minor: 0, nonce: crypto.createHash("sha256").update(raw).digest().subarray(0, 16).toString("base64url"), owners, sequencer: cu.sequencer() };
    const ngLine = JSON.stringify({ ...g, body }); const newId = worldIdOf(parseLine(ngLine));
    const next = ngLine + text.slice(nl).replaceAll(oldId, newId);
    const after = fold(readLog(next)); const dAfter = after.status === "ok" ? digest(after) : null;
    const py = Bun.spawnSync(["python3", path.join(ENGINE, "spec/v4/conformance/v4read.py"), "/dev/stdin", "--json"], { stdin: Buffer.from(next) });
    const dPy = (() => { try { return JSON.parse(py.stdout.toString()).digest; } catch { return null; } })();
    const same = dBefore !== null && dBefore === dAfter && dAfter === dPy;
    if (same && apply) {
      fs.appendFileSync(path.join(dir, "v4.genesis-before.jsonl"), JSON.stringify({ oldId, newId, genesis: g, at: new Date().toISOString() }) + "\n");
      fs.writeFileSync(f + ".tmp", next); fs.renameSync(f + ".tmp", f);
    }
    out.push({ dir, status: [before.status, after.status], digest: dBefore?.slice(0, 16), same, written: same && apply, owners: owners.map((t) => t.length),
      ...(same ? {} : { dAfter: dAfter?.slice(0, 16), dPy: dPy?.slice(0, 16), py: py.stderr.toString().slice(0, 200) }) });
  }
} finally { fs.rmSync(oldFoldPath, { force: true }); }
for (const o of out) console.log(JSON.stringify(o));
process.exit(out.every((o) => o.skipped || o.same) ? 0 : 1);
