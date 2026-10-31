// tools/protocol/migrate-genesis.ts — move a world's genesis to today's shape, {dialect: "eidoverse-log", v: 4, minor: 0,
// nonce, owners: [[<key>…], …], sequencer} (§2.4 + §3d), from either earlier shape this engine wrote:
//   A. pre-§3d ({version, owners: [<identity>…]}, sometimes translatedFrom). Ported from the protocol lab's
//      migrate-genesis.js (lab 62301b8) for the engine's layout (<world dir>/world.jsonl). Review F1, 2026-10-05.
//   B. §3d with the number in its own field ({version: 4, minor, …}, before the 2026-10-07 names pass): the field becomes
//      {dialect, v}; nothing else in genesis changes. The world id moves with it, so stored chain points (head/sig) no
//      longer verify; the authority reads heads as a view over the log and never needs them (a fresh signature starts
//      with the next write).
//   - owners: each old owner identity -> that identity's custody key; none -> [[], [sequencer]] (the custodial default:
//     tier 0 empty, this server's key in tier 1). Keys come from the custody file every world in that worlds dir shares
//     (<worlds dir>/.custody.json, server/custody.ts), so a running server reads the same keys.
//   - nonce: the first 16 bytes of sha256(the old log's bytes): unique per log, and reproducible.
//   - translatedFrom can't stay in a known minor's genesis (its fields are exact). The old genesis line is kept,
//     verbatim, in <world dir>/world.genesis-before.jsonl with both world ids. (A newly translated world carries it as the
//     `translated` act after genesis instead; an existing log can't gain an entry in the middle.)
//   - every later line's `world` is rewritten from the old id to the new one (a text replace: number spellings kept).
// SAFETY: a log is rewritten only if the state digest is the same before (the previous fold, from git --old-fold, default d4e0677a~1) and after
// (today's fold AND the Python reference reader). Stop the world's server first: it holds the old world id in memory.
// usage: bun tools/protocol/migrate-genesis.ts [--apply] <world dir>…   (dry run without --apply; skips a log already in today's shape)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readLog, fold, digest, worldIdOf, parseLine, DIALECT, VERSION } from "../../shared/protocol/fold.js";
import { custodyAt } from "../../server/custody.ts";
import { custodyFileIn } from "../../server/keyfiles.ts";
import { ENGINE } from "./common.ts";

const apply = process.argv.includes("--apply");
// --old-fold <git ref>: the fold that still reads the OLD genesis (the "before" digest). Default: the tree just before the
// §3d port (d4e0677a~1) for shape A, the last tree before the names pass's genesis change (4d7b81cd) for shape B. HEAD is
// wrong: its fold rightly reads an old genesis as no-world.
const ofi = process.argv.indexOf("--old-fold"); const OLD_REF = ofi > 0 ? process.argv[ofi + 1] : null;
const REF = { A: OLD_REF ?? "d4e0677a~1", B: OLD_REF ?? "4d7b81cd" };
const dirs = process.argv.slice(2).filter((a, i, all) => a !== "--apply" && a !== "--old-fold" && all[i - 1] !== "--old-fold");
const foldPaths: string[] = []; // each beside fold.js so its own imports resolve
const oldFold = async (shape: "A" | "B") => { const p = path.join(ENGINE, `shared/protocol/.baseline-fold-${shape}.mjs`);
  if (!foldPaths.includes(p)) { const shown = Bun.spawnSync(["git", "show", `${REF[shape]}:shared/protocol/fold.js`], { cwd: ENGINE });
    if (shown.exitCode !== 0) throw new Error(`can't read the previous fold from git ${REF[shape]}`); fs.writeFileSync(p, shown.stdout); foldPaths.push(p); }
  return import(p); };
const out: Record<string, unknown>[] = [];
try {
  for (const dir of dirs) {
    const f = path.join(dir, "world.jsonl");
    const raw = fs.readFileSync(f); const text = raw.toString("utf8"); const nl = text.indexOf("\n");
    const gline = text.slice(0, nl); const g = JSON.parse(gline);
    const shape = g.kind !== "genesis" || g.body?.dialect === DIALECT ? null : "minor" in (g.body ?? {}) ? "B" : "A";
    if (!shape) { out.push({ dir, skipped: "already today's shape, or no genesis" }); continue; }
    const old = await oldFold(shape);
    const before = old.fold(old.readLog(raw)); const dBefore = before.status === "ok" ? old.digest(before) : null;
    const cu = custodyAt(custodyFileIn(path.dirname(path.resolve(dir))));
    const oldId = worldIdOf(parseLine(gline));
    const owners = shape === "B" ? g.body.owners : (g.body.owners ?? []).length ? [g.body.owners.map((who: string) => cu.keyOf(who, true))] : [[], [cu.sequencer()]];
    const { version: _number, ...rest } = g.body;
    const body = shape === "B" ? { dialect: DIALECT, v: VERSION, ...rest }
      : { dialect: DIALECT, v: VERSION, minor: 0, nonce: crypto.createHash("sha256").update(raw).digest().subarray(0, 16).toString("base64url"), owners, sequencer: cu.sequencer() };
    const ngLine = JSON.stringify({ ...g, body }); const newId = worldIdOf(parseLine(ngLine));
    const next = ngLine + text.slice(nl).replaceAll(oldId, newId);
    const after = fold(readLog(next)); const dAfter = after.status === "ok" ? digest(after) : null;
    const py = Bun.spawnSync(["python3", path.join(ENGINE, "spec/conformance/reader.py"), "/dev/stdin", "--json"], { stdin: Buffer.from(next) });
    const dPy = (() => { try { return JSON.parse(py.stdout.toString()).digest; } catch { return null; } })();
    const same = dBefore !== null && dBefore === dAfter && dAfter === dPy;
    if (same && apply) {
      fs.appendFileSync(path.join(dir, "world.genesis-before.jsonl"), JSON.stringify({ oldId, newId, genesis: g, at: new Date().toISOString() }) + "\n");
      fs.writeFileSync(f + ".tmp", next); fs.renameSync(f + ".tmp", f);
    }
    out.push({ dir, shape, status: [before.status, after.status], digest: dBefore?.slice(0, 16), same, written: same && apply, owners: owners.map((t) => t.length),
      ...(same ? {} : { dAfter: dAfter?.slice(0, 16), dPy: dPy?.slice(0, 16), py: py.stderr.toString().slice(0, 200) }) });
  }
} finally { for (const p of foldPaths) fs.rmSync(p, { force: true }); }
for (const o of out) console.log(JSON.stringify(o));
process.exit(out.every((o) => o.skipped || o.same) ? 0 : 1);
