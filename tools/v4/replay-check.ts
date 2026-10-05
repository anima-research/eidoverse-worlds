// Fold a world from its log using ONLY shared/v4/fold.js: no door, no catalogue, no blob store (L1: the fold reads
// only entries). Ported from code/v4-lab/replay-check.js @ 11db981, which printed; this one asserts. The fixture is
// the lab's cottage world, built through the lab door; its digest there (node:crypto) is pinned here, so it also
// checks the engine's hash shim against the lab's hash.
// usage: bun tools/v4/replay-check.ts
import fs from "node:fs";
import { readLog, fold, digest } from "../../shared/v4/fold.js";
import { ENGINE } from "./common.ts";

const LAB_DIGEST = "22a27ab081644ca125718b3ad3e376e6b300f8c07930bd9868e01014577f663b"; // bun replay-check.js in the lab @ 11db981; unchanged by the §3d genesis migration (lab 62301b8, digests equal by construction)
const raw = fs.readFileSync(ENGINE + "spec/v4/fixtures/lab-cottage.jsonl");
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
console.log(fails.length ? `FAIL ${fails.join("; ")}` : "replay: ok (status ok, self-agrees, 0 malformed, digest = the lab's)");
process.exit(fails.length ? 1 : 0);
