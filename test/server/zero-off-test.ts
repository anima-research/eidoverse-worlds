// zero-off-test: every rail the DoS settings added takes `0` as "no limit", the same way for each (R 10-29: a limit that
// isn't safety is a sensible default and a setting an operator can turn off). One row per setting: a fresh process with
// only that setting at 0, asked to do what the default would refuse (or, where that would take gigabytes or thousands of
// asks, what the 0 would refuse if its "0 = off" guard were missing), and no "[config] … is not valid" warning (a setting
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
  // a new name's portrait is taken (the route's guard: at 0, "names held >= max" must not refuse every name)
  ["THUMBS_MAX", `const { route } = await import("${R}/server/routes.ts");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]); const st = [];
    for (const n of ["z-one", "z-two", "z-three"]) st.push((await route(new Request("http://x/thumb?name=" + n, { method: "POST", body: png }), {})).status);
    return { ok: st.every((x) => x === 200), detail: st };`],
  // uploads are taken, the day's bytes counting toward nothing (the uploader's guard: at 0, "bytes > budget" must not refuse all)
  ["UPLOAD_MB_PER_DAY", `const { handleUpload } = await import("${R}/server/upload.ts"); const { PNG } = require("pngjs"); const st = [];
    for (let i = 0; i < 3; i++) { const p = new PNG({ width: 2, height: 2, colorType: 0, inputColorType: 0, inputHasAlpha: false }); p.data = Buffer.from([i, 85, 170, 255]);
      const body = new Uint8Array(PNG.sync.write(p, { colorType: 0, inputColorType: 0, inputHasAlpha: false })); const url = new URL("http://x/upload?as=image&name=z.png");
      st.push((await handleUpload(new Request(url, { method: "POST", body }), url, { requestIP: () => ({ address: "192.0.2.7" }) })).status); }
    return { ok: st.every((x) => x === 200), detail: st };`],
  ["UPLOAD_MIN_FREE_MB", `const { diskNearlyFull } = await import("${R}/server/upload.ts"); return { ok: diskNearlyFull(1e18) === false };`],
  // ten travels at once on one socket, past JOIN_BURST (5): none refused (the join handler's guard: at 0 the bucket would never refill)
  ["JOIN_RATE", `const { scratchSequencer } = await import("${R}/test/harness/harness.ts"); const { helloOf } = await import("${R}/shared/protocol/hello.js");
    const { until } = await import("${R}/test/gate/wait.ts");
    const h = await scratchSequencer("zero-off-join", { worlds: ["zoa", "zob"], owner: "keeper", serverEnv: { SKIP_OPT_SWEEP: "1", JOIN_RATE: "0" } });
    try { const ws = new WebSocket(h.BASE.replace("http", "ws") + "/ws"); const msgs = []; ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
      await new Promise((r) => (ws.onopen = r));
      for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: i % 2 ? "zob" : "zoa", id: "hop", replica: true }));
      const n = (t) => msgs.filter((m) => t === "snap" ? m.type === "snapshot" : m.type === "error" && m.about === "join").length;
      await until("every join is answered", () => n("snap") + n("refused") >= 10, { ms: 15000, step: 50 }).catch(() => {});
      ws.close(); return { ok: n("snap") === 10 && n("refused") === 0, detail: { snapshots: n("snap"), refused: n("refused") } };
    } finally { await h.cleanup(0); }`],
  ["WS_PER_ADDRESS", `const { WS_PER_ADDRESS } = await import("${R}/server/config.ts"); const { takeSocket } = await import("${R}/server/sockcount.ts");
    let ok = 0; for (let i = 0; i < 1000; i++) if (takeSocket("198.51.100.2", WS_PER_ADDRESS)) ok++; return { ok: WS_PER_ADDRESS === 0 && ok === 1000, detail: { WS_PER_ADDRESS, ok } };`],
];

for (const [knob, body] of ROWS) {
  const dir = join(root, knob); mkdirSync(dir, { recursive: true });
  const file = join(dir, "probe.ts");
  writeFileSync(file, `const r = await (async () => { ${body} })();\nconsole.log("RESULT " + JSON.stringify(r));\nprocess.exit(0);\n`);
  const env: Record<string, string> = { ...process.env as Record<string, string>, SKIP_OPT_SWEEP: "1", KTX2_TOKTX: "", JOIN_TOKEN: "", SCR: dir,
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
  const said = doc.split("\n").find((l) => l.includes("and only these, read `0` as no limit"));
  const named = new Set([...(said ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
  const rows = new Set(ROWS.map(([k]) => k));
  const missing = [...rows].filter((k) => !named.has(k)), extra = [...named].filter((k) => !rows.has(k));
  S.check("the runbook's one sentence on 0 names exactly the settings this suite proves", !!said && !missing.length && !extra.length, { missing, extra }); }
S.done();
