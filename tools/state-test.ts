// client/lib/state.js — the world-as-data half of the skeleton (TEL0S_NOTES
// §11.2), tested headless: no server, no DOM, no THREE.
//
//   bun tools/state-test.ts
//
// The load-bearing claims: state.st is a pure function of (snapshot, tail,
// live entries); hydration skips the documented state/tail overlap; live
// folding is seq-guarded; a throwing subscriber cannot break the fold path.
// Conformance of the fold ITSELF is foldfix-test.ts's job — here we test
// the feeding, using the same fixtures so the answers are known-good.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { foldEntry, emptyState } from "../shared/fold.js";
import { state, hydrate, foldLive, reset, onWorldChange } from "../client/lib/state.js";

const FIX = join(import.meta.dir, "..", "spec", "fixtures");
const FIELDS = ["entities", "mounts", "roles", "behaviors"] as const;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const jeq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pick = (st: any) => JSON.parse(JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, st[f] ?? null]))));

console.log(`\nstate.js — folded world as data\n`);

const fixtures = readdirSync(FIX).sort().filter((d) => statSync(join(FIX, d)).isDirectory() && existsSync(join(FIX, d, "folded.json")));

for (const dir of fixtures) {
  const entries = readFileSync(join(FIX, dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const want = JSON.parse(readFileSync(join(FIX, dir, "folded.json"), "utf8"));
  const wantPicked = pick(want);

  // 1. pure live path: every entry through foldLive
  reset();
  let entryEvents = 0;
  const off = onWorldChange((ev) => { if (ev.type === "entry") entryEvents++; });
  state.hydrated = true;                       // live path without a snapshot
  for (const e of entries) foldLive(e);
  off();
  check(`${dir}: live fold matches fixture`, jeq(pick(state.st), wantPicked));
  check(`${dir}: one event per entry`, entryEvents === entries.length, `${entryEvents}/${entries.length}`);
  check(`${dir}: lastSeq tracks`, state.lastSeq === entries[entries.length - 1].seq);

  // 2. hydrate path: snapshot of the first half + tail of the second,
  //    with the state/tail OVERLAP the server documents (tail resends the
  //    last two snapshot entries) — must equal the full fold
  const cut = Math.floor(entries.length / 2);
  const snap = emptyState();
  for (const e of entries.slice(0, cut)) foldEntry(snap, e);
  const overlapTail = entries.slice(Math.max(0, cut - 2));   // 2 duplicates
  reset();
  hydrate(JSON.parse(JSON.stringify(snap)), overlapTail, entries[cut - 1].seq);
  check(`${dir}: hydrate(snapshot + overlapping tail) matches`, jeq(pick(state.st), wantPicked));

  // 3. live entries after hydration land on top
  reset();
  hydrate(JSON.parse(JSON.stringify(snap)), [], entries[cut - 1].seq);
  for (const e of entries.slice(cut)) foldLive(e);
  check(`${dir}: hydrate + live tail matches`, jeq(pick(state.st), wantPicked));
}

// 4. seq guard: a duplicate is dropped silently, state unchanged
{
  reset();
  state.hydrated = true;
  const spawn = { seq: 0, ts: 1, actor: "t", verb: "spawn", args: { id: "a", lib: "x.glb", pos: [1, 2, 3] } };
  foldLive(spawn);
  foldLive({ ...spawn, args: { id: "a", lib: "x.glb", pos: [9, 9, 9] } });   // same seq: must not re-fold
  check("duplicate seq is dropped", (state.st.entities as any).a.pos[0] === 1);
}

// 5. a throwing subscriber breaks nothing
{
  reset();
  const off1 = onWorldChange(() => { throw new Error("subscriber bug"); });
  let heard = false;
  const off2 = onWorldChange(() => { heard = true; });
  foldLive({ seq: 0, ts: 1, actor: "t", verb: "spawn", args: { id: "b", lib: "y.glb" } });
  off1(); off2();
  check("throwing subscriber does not break the fold", Boolean((state.st.entities as any).b));
  check("later subscribers still hear the event", heard);
}

// 6. reset returns to nothing and says so
{
  let resets = 0;
  const off = onWorldChange((ev) => { if (ev.type === "reset") resets++; });
  reset();
  off();
  check("reset empties and emits", resets === 1 && state.lastSeq === -1 && !state.hydrated
    && Object.keys(state.st.entities).length === 0);
}

// 7. lights through the live path: a partial `light` merges instead of
//    re-authoring (§3.1) — the comp bag, parent, and place-written yaw/scale
//    survive it — and a hydrated snapshot carrying a decorated light merges
//    identically when the partial arrives as live tail (live ≡ join, the
//    slice-18a invariant; fixture 05 pins the pure fold shape)
{
  reset();
  state.hydrated = true;
  let n = 100;
  const e = (verb: string, args: unknown) => foldLive({ seq: ++n, ts: 5000 + n, actor: "t", verb, args });
  e("light", { id: "L", pos: [1, 2, 3], color: 0x112233, intensity: 20, range: 8, keep: true, day: false });
  e("comp", { id: "L", type: "halo", data: { r: 2 } });
  e("mount", { id: "L", to: "post", offset: [0, 1, 0] });
  e("place", { id: "L", yaw: 0.5, scale: 2 });
  e("light", { id: "L", intensity: 40 });
  const live = JSON.parse(JSON.stringify((state.st.entities as any).L));
  check("live light merge keeps comp/parent/yaw/scale (+ keep/day pins)",
    live.intensity === 40 && live.keep === true && live.day === false
    && live.comp?.halo?.r === 2 && live.parent?.to === "post" && live.yaw === 0.5 && live.scale === 2,
    JSON.stringify(live));

  // join path: snapshot holds the decorated light; the partial rides the tail
  const snap = emptyState();
  for (let s = 101; s <= 104; s++) foldEntry(snap, { seq: s, ts: 5000 + s, actor: "t", verb: ["light", "comp", "mount", "place"][s - 101],
    args: [{ id: "L", pos: [1, 2, 3], color: 0x112233, intensity: 20, range: 8, keep: true, day: false },
      { id: "L", type: "halo", data: { r: 2 } },
      { id: "L", to: "post", offset: [0, 1, 0] },
      { id: "L", yaw: 0.5, scale: 2 }][s - 101] } as any);
  reset();
  hydrate(JSON.parse(JSON.stringify(snap)), [], 104);
  foldLive({ seq: 105, ts: 5105, actor: "t", verb: "light", args: { id: "L", intensity: 40 } });
  check("hydrate + live partial light equals the pure live fold",
    jeq(JSON.parse(JSON.stringify((state.st.entities as any).L)), live));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
