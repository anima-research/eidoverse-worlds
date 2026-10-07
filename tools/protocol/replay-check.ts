// Fold a world from its log using ONLY shared/protocol/fold.js: no door, no catalogue, no blob store (L1: the fold reads
// only entries). Ported from the protocol lab's replay-check.js @ 11db981, which printed; this one asserts. The fixture is
// the lab's cottage world, built through the lab authority; its digest there (node:crypto) is pinned here, so it also
// checks the engine's hash shim against the lab's hash.
// usage: bun tools/protocol/replay-check.ts
import fs from "node:fs";
import { readLog, fold, digest } from "../../shared/protocol/fold.js";
import { ENGINE } from "./common.ts";

// The lab's own digest was 22a27ab0…7f663b (bun replay-check.js in the lab @ 11db981; unchanged by the §3d genesis
// migration, lab 62301b8). The names pass (2026-10-07) rewrote two things in the fixture: genesis states {dialect, v}
// (so the world id moved; the digest leaves it out), and @world.about's text no longer names the protocol's number,
// which IS state. The new pin is that state's digest, confirmed independently by the Python reference reader (hashlib):
// python3 spec/conformance/reader.py spec/conformance/lab-cottage.jsonl --json → the same digest.
const LAB_DIGEST = "b17bf98f909347df1024b39ad4cc044b5f08a713f2d4765fb0d3c767253971b8";
const raw = fs.readFileSync(ENGINE + "spec/conformance/lab-cottage.jsonl");
const entries = readLog(raw);
const st = fold(entries), st2 = fold(readLog(raw)); // self-agreement: read and fold twice
const s = (id: string) => st.entities?.[id]?.c;
const out = { status: st.status, entries: entries.length, entities: st.entities ? Object.keys(st.entities).length : 0,
  digest: st.status === "ok" ? digest(st) : null, selfAgree: st.status === "ok" && digest(st) === digest(st2),
  malformed: st.diagnostics.filter(([, c]: any) => c.startsWith("malformed")).length,
  sample: { "wall-back": s("wall-back")?.transform.pos, "cottage-b-shelf-1": s("cottage-b-shelf-1")?.parent, "door-1": { locked: s("door-1")?.locked } } };
console.log(JSON.stringify(out));
const fails = [
  out.status !== "ok" && "status",
  !out.selfAgree && "selfAgree",
  out.malformed !== 0 && "malformed",
  out.digest !== LAB_DIGEST && `digest ${out.digest} != lab ${LAB_DIGEST}`,
  out.entities !== 51 && `entities ${out.entities} != 51`,
].filter(Boolean);
console.log(fails.length ? `FAIL ${fails.join("; ")}` : "replay: ok (status ok, self-agrees, 0 malformed, digest pinned)");
process.exit(fails.length ? 1 : 0);
