// replaybench — the log-replay parity gate (overhaul charter §6, phase 1).
//
//   bun tools/replaybench.ts                 # check every world under WORLDS_DIR
//   bun tools/replaybench.ts commons         # only the named world(s)
//   bun tools/replaybench.ts --write         # record/refresh baseline digests
//   WORLDS_DIR=/path/to/worlds bun tools/replaybench.ts
//
// "Logs replay unchanged" is the rebuild's crown-jewel invariant, and until
// now it was a principle we believed rather than a number we checked. This
// bench turns it into a number: every phase-1 refactor of the sim core runs
// behind it, the way render work runs behind paritybench/lightbench.
//
// Four checks per world, all pure reads — the bench NEVER appends, folds, or
// otherwise touches a world's files (worlds are append-only and forever; a
// bench that could write to one is a bench waiting to become an incident):
//
//  1. DETERMINISM — fold the full log from emptyState() twice, independently
//     parsed, and require identical canonical digests. Catches wall-clock or
//     randomness leaking into shared/fold.js, and cross-replay aliasing.
//  2. SNAPSHOT PARITY — state folded from genesis must equal snapshot.state
//     plus the tail folded after snapshot.bytes: the two boot paths
//     WorldLog's constructor can take. A mismatch means joiners today see a
//     world that differs from the log's truth (house rule 1's drift) —
//     usually a snapshot written before a fold-rule fix. Remedy: delete the
//     world's snapshot.json; the next boot rebuilds the derived cache from
//     the log, which is exactly what fold.js's doctrine promises.
//  3. ROUNDTRIP — stateToEntries(state) folded from empty must reproduce the
//     world-shaping subset of state: entities (comp/parent included),
//     terrain, grass, assets, mounts, behaviors, roles. Documented
//     exclusions, each a deliberate lossiness of stateToEntries, not drift:
//     sky (foldSkyEntry re-derives rate/provenance), recentChat + chatTotal
//     (a window, not the archive), bans (never emitted — enforcement is the
//     sequencer's, not a joiner's), and roles' `sub` (durable ink stays
//     server-side; the grant emitted to joiners is nameplate-only).
//  4. BASELINE — instant and ordered sim digests against .replaybench.json
//     (per-machine, inside the gitignored worlds dir: digests of local data
//     belong beside the local data). Absent baseline is a hint, not a
//     failure for operator data; committed fixtures require sim goldens.
//     --write records. A changed digest with an unchanged log is
//     the alarm this bench exists to ring: the refactor changed what a log
//     means.
//
// Exit 0: every check green on every world. Exit 1: drift somewhere. Exit 2:
// the environment has no worlds to check — never mistaken for parity.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WORLDS_DIR } from "../server/config.ts";
import { foldEntry, emptyState, stateToEntries, type LogEntry, type WorldState } from "../shared/fold.js";
import { emptySim, simEntry, advanceSim, simSnapshot } from "../shared/sim.js";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const only = args.filter((a) => !a.startsWith("--"));

// ---------------------------------------------------------------- canonical

/** JSON with every object's keys sorted, recursively — the digest must not
 *  depend on insertion order, which IS allowed to vary between boot paths
 *  (snapshot state and replayed state build their maps in different orders). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) =>
    JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
const digest = (state: WorldState) =>
  createHash("sha256").update(canonical(state)).digest("hex").slice(0, 16);

// ------------------------------------------------------------------- replay

/** Parse a log's lines tolerantly — the protocol says folding is total and a
 *  malformed line shapes nothing (PROTOCOL.md §1); the bench mirrors that
 *  and counts what it skipped rather than dying on it. */
function parseLog(text: string): { entries: LogEntry[]; malformed: number } {
  const entries: LogEntry[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { entries, malformed };
}

function foldAll(entries: LogEntry[]): WorldState {
  const st = emptyState();
  for (const e of entries) foldEntry(st, e);
  return st;
}

/** The sim fold beside the instant one (dialect 3): fold, then settle far
 *  past the last entry so rest states are reached — the digest below is of
 *  the complete ordered sim state at rest, excluding its idle tick counter. */
function foldSimAll(entries: LogEntry[], settleTicks = 100_000) {
  const st = emptyState();
  const sim = emptySim();
  for (const e of entries) { foldEntry(st, e); simEntry(sim, e, st); }
  if (sim.epoch && !sim.epoch.foreign) advanceSim(sim, sim.tick + settleTicks);
  return sim;
}
// The COMPLETE normative sim state, in its NORMATIVE order: bodies and
// statics are plain objects whose insertion order is physically load-bearing
// (0.3 resolves collisions in it), so this is JSON.stringify — never a
// key-sorting canonical form, which would hide exactly that divergence class
// (PR #160 review, B6). `tick` stays out: it is query-time trivia the settle
// below makes constant anyway.
const simDigest = (sim: ReturnType<typeof emptySim>) => {
  const snap = simSnapshot(sim) as Record<string, unknown>;
  const { tick: _tick, ...normative } = snap;
  return createHash("sha256").update(JSON.stringify(normative)).digest("hex").slice(0, 16);
};

/** The world-shaping subset the stateToEntries roundtrip contract covers —
 *  see the header for what each exclusion means and why it is deliberate. */
function roundtripView(st: WorldState) {
  const roles: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(st.roles ?? {})) {
    const { sub: _sub, ...rest } = r as Record<string, unknown>;
    roles[id] = rest;
  }
  return {
    entities: st.entities, terrain: st.terrain, grass: st.grass,
    assets: st.assets, roles,
    ...(st.mounts ? { mounts: st.mounts } : {}),
    ...(st.behaviors ? { behaviors: st.behaviors } : {}),
  };
}

// --------------------------------------------------------------------- main

if (!existsSync(WORLDS_DIR)) {
  console.error(`[replaybench] no worlds dir at ${WORLDS_DIR}`);
  process.exit(2);
}
// Two roots: the operator's worlds (local, baseline gitignored) and the
// COMMITTED fixtures under spec/fixtures/replay (baseline committed) — so a
// clean checkout has something to replay and a digest to hold it to (PR #160
// review, B6). Each root keeps its own .replaybench.json.
const FIXTURE_ROOT = join(import.meta.dir, "..", "spec", "fixtures", "replay");
const roots = [FIXTURE_ROOT, WORLDS_DIR].filter((r, i, a) => existsSync(r) && a.indexOf(r) === i);
const targets: { root: string; name: string }[] = [];
for (const root of roots) {
  for (const n of readdirSync(root).sort()) {
    if (only.length && !only.includes(n)) continue;
    try {
      if (statSync(join(root, n)).isDirectory() && existsSync(join(root, n, "log.jsonl"))) targets.push({ root, name: n });
    } catch { /* not a world */ }
  }
}
if (!targets.length) {
  console.error(`[replaybench] no worlds with a log.jsonl under ${roots.join(" or ")}`
    + (only.length ? ` matching: ${only.join(", ")}` : ""));
  process.exit(2);
}

type Baseline = { digest: string; simDigest?: string; seq: number };
const baselines = new Map<string, Record<string, Baseline>>();
const baselineOf = (root: string) => {
  if (!baselines.has(root)) {
    let b: Record<string, Baseline> = {};
    const bp = join(root, ".replaybench.json");
    if (existsSync(bp)) {
      try { b = JSON.parse(readFileSync(bp, "utf8")); }
      catch { console.warn(`[replaybench] baseline ${bp} unreadable — treating as absent`); }
    }
    baselines.set(root, b);
  }
  return baselines.get(root)!;
};
const nextBaselines = new Map<string, Record<string, Baseline>>();

let red = 0;

for (const { root, name } of targets) {
  const baseline = baselineOf(root);
  const nextBaseline = nextBaselines.get(root) ?? (nextBaselines.set(root, {}), nextBaselines.get(root)!);
  const dir = join(root, name);
  const raw = readFileSync(join(dir, "log.jsonl"));
  const { entries, malformed } = parseLog(raw.toString("utf8"));
  const lastSeq = entries.length ? entries[entries.length - 1].seq : -1;
  const notes: string[] = [];
  const fails: string[] = [];
  if (malformed) notes.push(`${malformed} malformed line${malformed === 1 ? "" : "s"} skipped`);

  // 1. determinism — two independent parses, two independent folds
  const full = foldAll(entries);
  const d1 = digest(full);
  const d2 = digest(foldAll(parseLog(raw.toString("utf8")).entries));
  if (d1 !== d2) fails.push(`NONDETERMINISTIC fold (${d1} vs ${d2}) — impurity in shared/fold.js`);

  // 1b. the sim fold (dialect 3), where an epoch exists: same double-fold
  // self-agreement, settled far past the last entry so rest is reached
  const fullSim = foldSimAll(entries);
  const s1 = simDigest(fullSim);
  if (fullSim.epoch) {
    const s2 = simDigest(foldSimAll(parseLog(raw.toString("utf8")).entries));
    if (s1 !== s2) fails.push(`NONDETERMINISTIC sim fold (${s1} vs ${s2}) — impurity in shared/sim.js`);
    notes.push(`sim ${fullSim.epoch.sim}${fullSim.epoch.foreign ? " (FOREIGN — refused, barrier truth)" : ` digest ${s1}, ${Object.keys(fullSim.bodies).length} body/ies`}`);
  }

  // 2. snapshot parity — the two boot paths must agree
  const snapPath = join(dir, "snapshot.json");
  if (existsSync(snapPath)) {
    try {
      const snap = JSON.parse(readFileSync(snapPath, "utf8"));
      const usable = snap?.state && typeof snap.seq === "number"
        && typeof snap.bytes === "number" && snap.bytes > 0 && snap.bytes <= raw.length;
      if (!usable) {
        notes.push("snapshot offset not credible — boot would full-replay (as WorldLog does)");
      } else {
        const st = structuredClone(snap.state) as WorldState;
        const snapSim = snap.sim?.bodies ? structuredClone(snap.sim) : emptySim();
        const { entries: tail } = parseLog(raw.toString("utf8", snap.bytes));
        for (const e of tail) { foldEntry(st, e); simEntry(snapSim, e, st); }
        const ds = digest(st);
        if (ds !== d1) fails.push(`SNAPSHOT DIVERGES from genesis replay (${ds} vs ${d1})`
          + ` — stale derived cache; delete ${name}/snapshot.json to rebuild`);
        // the sim's two boot paths must agree too (adoption is exact —
        // advancement is schedule-independent, PROTOCOL_v2 §1/§3)
        if (fullSim.epoch && !fullSim.epoch.foreign) {
          if (snapSim.epoch && !snapSim.epoch.foreign) advanceSim(snapSim, snapSim.tick + 100_000);
          const dss = simDigest(snapSim);
          if (dss !== simDigest(fullSim)) {
            fails.push(`SIM SNAPSHOT DIVERGES from genesis recompute (${dss})`
              + ` — delete ${name}/snapshot.json to rebuild`);
          }
        }
      }
    } catch { notes.push("snapshot unparseable — boot would full-replay"); }
  } else notes.push("no snapshot (young world)");

  // 3. roundtrip — the snapshot-rehydration path joiners actually run
  const rt = foldAll(stateToEntries(full, { now: 0 }) as LogEntry[]);
  const want = canonical(roundtripView(full));
  const got = canonical(roundtripView(rt));
  if (want !== got) fails.push("ROUNDTRIP drift — stateToEntries + fold loses world shape"
    + " (run with a debugger on roundtripView to see which key)");

  // 4. baseline
  const base = baseline[name];
  if (base && base.digest !== d1 && !WRITE) {
    fails.push(`BASELINE mismatch (${base.digest}@seq${base.seq} → ${d1}@seq${lastSeq})`
      + (base.seq === lastSeq ? " with an UNCHANGED log — the refactor changed what a log means"
                              : " — log grew; re-record with --write if the growth is yours"));
  } else if (!base && !WRITE) notes.push("no baseline yet — record one with --write");
  if (!WRITE) {
    if (base?.simDigest && base.simDigest !== s1) {
      fails.push(`SIM BASELINE mismatch (${base.simDigest} → ${s1}) — physical state or its normative order changed`);
    } else if (!base?.simDigest) {
      const missing = "no sim baseline — record the complete ordered sim state with --write";
      if (root === FIXTURE_ROOT) fails.push(missing);
      else notes.push(missing);   // older operator baselines migrate explicitly
    }
  }
  nextBaseline[name] = { digest: d1, simDigest: s1, seq: lastSeq };

  const ok = fails.length === 0;
  if (!ok) red++;
  console.log(`[replaybench] ${ok ? "OK " : "RED"} ${name} — ${entries.length} entries`
    + ` through seq ${lastSeq}, digest ${d1}`
    + (notes.length ? ` (${notes.join("; ")})` : ""));
  for (const f of fails) console.log(`               ✗ ${f}`);
}

if (WRITE) {
  for (const [root, nb] of nextBaselines) {
    const bp = join(root, ".replaybench.json");
    writeFileSync(bp, JSON.stringify({ ...baselineOf(root), ...nb }, null, 2) + "\n");
    const n = Object.keys(nb).length;
    console.log(`[replaybench] baseline recorded for ${n} world${n === 1 ? "" : "s"} → ${bp}`);
  }
}
console.log(`[replaybench] ${targets.length - red}/${targets.length} worlds green`);
process.exit(red ? 1 : 0);
