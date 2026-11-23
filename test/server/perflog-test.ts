// perflog-test: the load beacon's file (POST /perflog → WORLDS_DIR/.perflogs.jsonl) stays bounded and keeps taking lines:
// past PERFLOG_MB it is rotated to .perflogs.1.jsonl (one older file kept), never left full for good. Real route(), temp dirs.
// `bun test/server/perflog-test.ts`
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";
const S = suite("perflog");
const root = mkdtempSync(join(tmpdir(), "perflog-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const W = join(root, "worlds"); mkdirSync(W, { recursive: true });
Object.assign(process.env, { SKIP_OPT_SWEEP: "1", WORLDS_DIR: W, OPT_DIR: join(root, "opt"), EIDOVERSE_DIR: join(root, "lib"), KTX2_TOKTX: "" });
const { route } = await import("../../server/routes.ts");
const live = join(W, ".perflogs.jsonl"), old = join(W, ".perflogs.1.jsonl");
const beacon = (ms: number) => route(new Request("http://x/perflog", { method: "POST", body: JSON.stringify({ kind: "load", ms }) }), { requestIP: () => ({ address: "192.0.2.5" }) } as any);
const has = (f: string, ms: number) => existsSync(f) && readFileSync(f, "utf8").includes(`"ms":${ms}`);

// a file already past the 5 MB default, as an old server or a flood leaves it
writeFileSync(live, (JSON.stringify({ ts: 1, addr: "x", kind: "filler", pad: "p".repeat(200) }) + "\n").repeat(26_000));
const before = statSync(live).size;
await beacon(4242);
S.check("P1 a beacon arriving at a full file still lands (the file is rotated, not left full for good)", has(live, 4242), { before, after: existsSync(live) ? statSync(live).size : 0 });
S.check("P1b ...the full file is kept as the one older copy", existsSync(old) && statSync(old).size === before, existsSync(old) ? statSync(old).size : null);
await beacon(4343);
S.check("P1c ...and later beacons keep landing", has(live, 4343));
S.done();
