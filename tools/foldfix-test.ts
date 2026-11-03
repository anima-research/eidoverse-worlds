// Conformance: shared/fold.js vs spec/fixtures (PROTOCOL.md §11).
//
// Folds each fixtures/*/log.jsonl from empty state with the SHARED fold and
// deep-compares the result to folded.json over exactly the conformance
// fields — entities (comp bags and parents included), mounts, roles,
// behaviors — numbers within 1e-6 (orphan-stamping does trigonometry).
// Chat windows, ban lists, and other implementation-defined folds are out
// of scope, per spec/fixtures/README.md.
//
// Needs no server and no network:
//
//   bun tools/foldfix-test.ts
//
// This is also the harness that pins the foldEntry extraction (TEL0S_NOTES
// §8 step 2): the reference fold moved out of server/server.ts verbatim,
// and these fixtures are the proof it stayed itself.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { emptyState, foldEntry, stateToEntries } from "../shared/fold.js";

const FIX = join(import.meta.dir, "..", "spec", "fixtures");
const FIELDS = ["entities", "mounts", "roles", "behaviors"] as const;
const EPS = 1e-6;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Deep equality, JSON semantics, numbers within EPS. Returns a path string
 *  naming the first divergence, or null when equal. */
function diff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= EPS ? null : `${path}: ${a} vs ${b}`;
  }
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join("") !== kb.join("")) {
      const extra = ka.filter((k) => !kb.includes(k));
      const missing = kb.filter((k) => !ka.includes(k));
      return `${path}: keys differ (ours+[${extra}] theirs+[${missing}])`;
    }
    for (const k of ka) {
      const d = diff((a as any)[k], (b as any)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

console.log(`\nfold conformance — spec/fixtures vs shared/fold.js\n`);

for (const dir of readdirSync(FIX).sort()) {
  const base = join(FIX, dir);
  if (!statSync(base).isDirectory() || !existsSync(join(base, "folded.json"))) continue;

  const st = emptyState();
  const lines = readFileSync(join(base, "log.jsonl"), "utf8").split("\n").filter(Boolean);
  for (const line of lines) foldEntry(st, JSON.parse(line));
  // JSON round-trip: the comparison is over JSON semantics (what a snapshot
  // or a join payload would actually carry), not in-memory quirks
  const ours = JSON.parse(JSON.stringify(st));
  const want = JSON.parse(readFileSync(join(base, "folded.json"), "utf8"));

  for (const f of FIELDS) {
    const d = diff(ours[f] ?? null, want[f] ?? null, `$.${f}`);
    check(`${dir}: ${f}`, d === null, d ?? "");
  }
}

// ---- light-on-light merge, beyond what a fixture can pin ---------------------
// Fixture 05 pins the folded SHAPE (comp/parent surviving a partial update,
// keep/day policy). These pin the rest of §3.1's light story: place-written
// yaw/scale surviving the merge, the wholesale replacement across kinds, and
// the snapshot roundtrip (stateToEntries → fold) reproducing the same light —
// a folded world must not shed fields each time it is snapshotted.
{
  const st = emptyState();
  let n = 0;
  const feed = (verb: string, args: unknown) =>
    foldEntry(st, { seq: n++, ts: 1786320001000 + n, actor: "t", verb, args } as any);
  feed("light", { id: "L", pos: [1, 2, 3], color: 0x112233, intensity: 20, range: 8, keep: true, day: false });
  feed("comp", { id: "L", type: "halo", data: { r: 2 } });
  feed("mount", { id: "L", to: "post", offset: [0, 1, 0] });
  feed("place", { id: "L", yaw: 0.5, scale: 2 });
  feed("light", { id: "L", intensity: 40 });   // the partial update under test
  const L = (st.entities as any).L;
  check("light merge: unauthored fields survive (comp/parent/yaw/scale + keep/day)",
    L.intensity === 40 && L.color === 0x112233 && L.range === 8 && L.keep === true && L.day === false
    && L.comp?.halo?.r === 2 && L.parent?.to === "post" && L.yaw === 0.5 && L.scale === 2,
    JSON.stringify(L));
  feed("light", { id: "L", keep: false, day: true });   // defaults CLEAR (fixture 05's pin, here post-merge)
  const L2 = (st.entities as any).L;
  check("light merge: keep:false/day:true clear to absent, annotations still ride",
    L2.keep === undefined && L2.day === undefined && L2.comp?.halo?.r === 2 && L2.parent?.to === "post",
    JSON.stringify(L2));

  feed("spawn", { id: "M", lib: "props/ball.glb", pos: [0, 0, 0], yaw: 1, scale: 2 });
  feed("comp", { id: "M", type: "sparkle", data: { hue: "amber" } });
  feed("light", { id: "M", intensity: 5 });   // across kinds: wholesale, nothing inherited
  const M = (st.entities as any).M;
  check("light on a model id replaces wholesale (no comp/yaw/scale inherited)",
    M.kind === "light" && M.intensity === 5 && M.comp === undefined && M.yaw === undefined && M.scale === undefined,
    JSON.stringify(M));

  // roundtrip: a snapshot re-expressed as entries folds back to the same lights
  const st2 = emptyState();
  for (const e of stateToEntries(st, { now: 1786320002000 })) foldEntry(st2, e as any);
  const d = diff(JSON.parse(JSON.stringify(st2.entities)), JSON.parse(JSON.stringify(st.entities)), "$.entities");
  check("stateToEntries roundtrips every preserved light field", d === null, d ?? "");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
