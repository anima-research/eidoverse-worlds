// bun tools/avatar-perf-test.ts — the avatar loupe rank's server half: POST /thumb?perf=&v= (metadata only, no
// picture) validates the client-written numbers, RECOMPUTES the rank (a client-sent rank is ignored), MERGES into
// thumbs/meta.json (a height stamp and a perf stamp never erase each other), and the roster (/avatars) shows the rank
// only while `v` is the body's current version (a re-export withholds it). Real route(), temp dirs.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };
const root = mkdtempSync(join(tmpdir(), "avperf-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));   // a throw mid-test too
Object.assign(process.env, { SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: join(root, "opt"), EIDOVERSE_DIR: join(root, "lib"), JOIN_TOKEN: "t0k", KTX2_TOKTX: "" });
const vdir = join(root, "lib", "eidoverse/assets/vrms"); mkdirSync(vdir, { recursive: true });
const body = join(vdir, "bee.vrm"); writeFileSync(body, "not really a vrm");
const t0 = new Date(1_700_000_000_000); utimesSync(body, t0, t0);
const { route, avatarPerfParam, avatarRoster } = await import("../server/routes.ts");
const vNow = () => String(Math.round(Bun.file(body).lastModified));
const post = (q: Record<string, string>) => route(new Request(`http://x/thumb?${new URLSearchParams({ name: "bee", ...q })}`, { method: "POST", headers: { authorization: "Bearer t0k" } }), {} as any);
const meta = () => { try { return JSON.parse(readFileSync(join(root, "opt", "thumbs", "meta.json"), "utf8")); } catch { return {}; } };
const good = { tris: 70_000, draws: 40, mats: 12, alpha: 2, bones: 120, texMB: 30.5 };

// 1. validation (pure)
check("valid numbers → a record", !!avatarPerfParam(JSON.stringify(good), "123"));
for (const [why, raw, v] of [["NaN field", { ...good, tris: "lots" }, "1"], ["negative", { ...good, draws: -1 }, "1"], ["absurd", { ...good, tris: 1e12 }, "1"],
  ["missing field", { tris: 5 }, "1"], ["no v", good, null], ["v not digits", good, "1;drop"], ["not JSON", "{", "1"],
  // Number(null) / Number([]) / Number("") are all 0: a field must BE a number, not coerce to one (review 09-30 N4)
  ["null field", { ...good, alpha: null }, "1"], ["array field", { ...good, bones: [] }, "1"], ["empty-string field", { ...good, mats: "" }, "1"],
  ["numeric-string field", { ...good, tris: "70000" }, "1"]] as const)
  check(`rejects: ${why}`, avatarPerfParam(typeof raw === "string" ? raw : JSON.stringify(raw), v as any) === null);
const lie = avatarPerfParam(JSON.stringify({ ...good, tris: 900_000, rank: 0, rankName: "excellent" }), "1");
check("the rank is recomputed: 900k tris with a claimed 'excellent' ranks by its numbers", !!lie && lie.rank > 0 && lie.rankName !== "excellent" && lie.worst === "tris", lie);

// 2. the route: token, perf-only POST (no picture), merge with height both ways
const perfQ = `name=bee&perf=${encodeURIComponent(JSON.stringify(good))}&v=${vNow()}`;
check("no token → 401", (await route(new Request(`http://x/thumb?${perfQ}`, { method: "POST" }), {} as any)).status === 401);
check("wrong Bearer → 401", (await route(new Request(`http://x/thumb?${perfQ}`, { method: "POST", headers: { authorization: "Bearer nope" } }), {} as any)).status === 401);
// the door key never rides in a URL (access logs): the old ?token= shape is refused outright, even with the right key
const rq = await route(new Request(`http://x/thumb?${perfQ}&token=t0k`, { method: "POST" }), {} as any);
check("the key as ?token= → 400, nothing stored", rq.status === 400 && !meta().bee, [rq.status, meta()]);
const r1 = await post({ height: "1.62" });
check("a height-only POST still works as before (no picture → 415, height stored)", r1.status === 415 && meta().bee?.h === 1.62, [r1.status, meta()]);
const r2 = await post({ perf: JSON.stringify(good), v: vNow() });
const j2 = r2.status === 200 ? await r2.json() : null;
check("a perf-only POST (no picture, no portrait yet) → 200 meta, confirming the stamp", j2?.ok === true && j2.meta === true && j2.perf === true, [r2.status, j2]);
check("…merged: the height survived the perf stamp", meta().bee?.h === 1.62 && meta().bee?.perf?.tris === 70_000, meta());
await post({ height: "1.70" });
check("…and the perf survived a later height stamp", meta().bee?.h === 1.7 && meta().bee?.perf?.tris === 70_000, meta());

// 3. the roster shows it for THIS version only
const entry = () => avatarRoster().find((a) => a.name === "bee");
check("roster: the current version's rank is shown", entry()?.perf?.tris === 70_000 && typeof entry()?.perf?.rankName === "string", entry());
const t1 = new Date(1_700_000_500_000); utimesSync(body, t1, t1);   // a re-export
check("roster: after a re-export the old stamp is withheld", entry()?.perf === null, entry()?.perf);
await post({ perf: JSON.stringify({ ...good, tris: 20_000 }), v: vNow() });
check("…and a fresh stamp for the new version shows", entry()?.perf?.tris === 20_000, entry()?.perf);
console.log(`${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0);
