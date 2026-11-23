// zero-off-test: every rail the DoS settings added takes `0` as "no limit", the same way for each (R 10-29: a limit that
// isn't safety is a sensible default and a setting an operator can turn off). One row per setting: a fresh process with
// only that setting at 0, asked to do what the default would refuse, and no "[config] … is not valid" warning (a setting
// whose 0 is refused falls back to its default). The runbook's one sentence naming these settings must list exactly the
// rows here. `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/zero-off-test.ts`
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { suite } from "../gate/suite.ts";

const S = suite("zero-off");
const R = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "zero-off-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// each probe is the body of an async function in a fresh process (env is read at import); it returns { ok, detail }
const ROWS: [string, string][] = [
  ["GZIP_CACHE_MB", `const g = await import("${R}/server/gzcache.ts"); let n = 0; const rd = () => { n++; return crypto.getRandomValues(new Uint8Array(20000)); };
    g.gzipOf("/z", 1, 20000, rd); g.gzipOf("/z", 1, 20000, rd); return { ok: n === 1, detail: { reads: n, ...g.gzStats() } };`],
  ["GZIP_MAX_MB", `const g = await import("${R}/server/gzcache.ts"); return { ok: g.gzipsAt(1e12), detail: g.gzConfig };`],
  ["ANON_IDS_KEPT", `const { directoryAt } = await import("${R}/server/directory.ts"); const d = directoryAt(process.env.SCR + "/d.json");
    const ids = []; for (let i = 0; i < 50; i++) { const id = d.resolve({ name: "G" + i }); ids.push(id); d.release(id); }
    return { ok: d.nameOf(ids[0]) === "G0" && d.anonStats().held === 50, detail: d.anonStats() };`],
  ["PERFLOG_MB", `const fs = await import("node:fs"); const W = process.env.WORLDS_DIR; fs.mkdirSync(W, { recursive: true });
    const live = W + "/.perflogs.jsonl"; fs.writeFileSync(live, "x".repeat(6_000_000) + "\\n");
    const { route } = await import("${R}/server/routes.ts");
    await route(new Request("http://x/perflog", { method: "POST", body: JSON.stringify({ kind: "load", ms: 777 }) }), { requestIP: () => ({ address: "192.0.2.5" }) });
    return { ok: !fs.existsSync(W + "/.perflogs.1.jsonl") && fs.readFileSync(live, "utf8").includes('"ms":777'), detail: { rotated: fs.existsSync(W + "/.perflogs.1.jsonl") } };`],
  ["GEOM_PER_ADDRESS", `const { geomGate } = await import("${R}/server/routes.ts"); let ok = 0; for (let i = 0; i < 100; i++) if (geomGate.grant("198.51.100.1").ok) ok++;
    return { ok: ok === 100, detail: { granted: ok } };`],
  ["GEOM_PER_MINUTE", `const { geomGate } = await import("${R}/server/routes.ts"); let ok = 0; for (let i = 0; i < 700; i++) if (geomGate.grant("a" + i).ok) ok++;
    return { ok: ok === 700, detail: { granted: ok } };`],
  ["THUMBS_MAX", `const { thumbLimits } = await import("${R}/server/routes.ts"); return { ok: thumbLimits.max === 0, detail: thumbLimits };`],
  ["UPLOAD_MB_PER_DAY", `const { uploadBudget } = await import("${R}/server/upload.ts"); return { ok: uploadBudget.perDayBytes === 0, detail: uploadBudget };`],
  ["UPLOAD_MIN_FREE_MB", `const { diskNearlyFull } = await import("${R}/server/upload.ts"); return { ok: diskNearlyFull(1e18) === false };`],
  ["JOIN_RATE", `const { JOIN_RATE } = await import("${R}/server/config.ts"); return { ok: JOIN_RATE === 0, detail: JOIN_RATE };`],
  ["WS_PER_ADDRESS", `const { WS_PER_ADDRESS } = await import("${R}/server/config.ts"); const { takeSocket } = await import("${R}/server/sockcount.ts");
    let ok = 0; for (let i = 0; i < 1000; i++) if (takeSocket("198.51.100.2", WS_PER_ADDRESS)) ok++; return { ok: WS_PER_ADDRESS === 0 && ok === 1000, detail: { WS_PER_ADDRESS, ok } };`],
];

for (const [knob, body] of ROWS) {
  const dir = join(root, knob); mkdirSync(dir, { recursive: true });
  const file = join(dir, "probe.ts");
  writeFileSync(file, `const r = await (async () => { ${body} })();\nconsole.log("RESULT " + JSON.stringify(r));\nprocess.exit(0);\n`);
  const env: Record<string, string> = { ...process.env as Record<string, string>, SKIP_OPT_SWEEP: "1", KTX2_TOKTX: "", SCR: dir,
    WORLDS_DIR: join(dir, "worlds"), OPT_DIR: join(dir, "opt"), EIDOVERSE_DIR: join(dir, "lib"), [knob]: "0" };
  const p = Bun.spawnSync(["bun", file], { env, cwd: R, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString(), err = p.stderr.toString();
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  const r = line ? JSON.parse(line.slice(7)) : { ok: false, detail: (err || out).slice(-300) };
  const refused = (out + err).split("\n").filter((l) => l.includes(`[config] ${knob}=`));
  S.check(`${knob}=0 means no limit`, r.ok && refused.length === 0, { ...r, ...(refused.length ? { refused } : {}) });
}

// the runbook says it once, and it stays true: the settings its sentence names are exactly the rows above
{ const doc = readFileSync(join(R, "docs/operator/SHOW-RUNBOOK.md"), "utf8");
  const said = doc.split("\n").find((l) => l.includes("`0` means no limit"));
  const named = new Set([...(said ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
  const rows = new Set(ROWS.map(([k]) => k));
  const missing = [...rows].filter((k) => !named.has(k)), extra = [...named].filter((k) => !rows.has(k));
  S.check("the runbook's one sentence on 0 names exactly the settings this suite proves", !!said && !missing.length && !extra.length, { missing, extra }); }
S.done();
