// tools/water/preview-check.ts — preview.ts sends the manifest's effect uploads before its batch, as import.ts --apply does
// (the dust effect was never uploaded, so the scratch world's emitters drew nothing). The public #248 manifest
// through import.ts --dry is the bundle (no GLBs: the batch names models the preview copies only when present).
//   bun tools/water/preview-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "../protocol/common.ts";
import { helloOf } from "../../shared/protocol/hello.js";
let fail = 0;
const C = (id, what, good, info) => { console.log(`${good ? "ok  " : "FAIL"} ${id} ${what}`); if (!good) { fail++; if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 600)); } };
const dry = JSON.parse(Bun.spawnSync(["bun", path.join(ENGINE, "tools/water/import.ts"), path.join(ENGINE, "world-data/water/manifest.json"), "--dry"], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }).stdout.toString());
const bundle = scratch("wprev"); fs.mkdirSync(bundle, { recursive: true });
fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ version: 2, files: [], requests: dry.requests, uploads: dry.uploads }));
const name = dry.uploads?.[0]?.args?.effect?.name;
const port = String(19000 + Math.floor(Math.random() * 900));
const pv = Bun.spawn(["bun", path.join(ENGINE, "tools/water/preview.ts"), bundle, port], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
let out = ""; const rd = (async () => { for await (const c of pv.stdout) out += new TextDecoder().decode(c); })();
let err = ""; (async () => { for await (const c of pv.stderr) err += new TextDecoder().decode(c); })();
let effect = null;
try {
  for (let i = 0; i < 300 && !/Preview:/.test(out) && pv.exitCode === null; i++) await Bun.sleep(100);
  C("P0", "the preview comes up with the bundle's scene", /Preview:/.test(out), { out: out.slice(-300), err: err.slice(-400) });
  if (/Preview:/.test(out)) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    effect = await new Promise((res) => { const t = setTimeout(() => res({ timeout: true }), 15000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "water-preview", id: "water-review", avatar: "", replica: true }));
      ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "snapshot") ws.send(JSON.stringify({ type: "request", id: "fx", verb: "effect", args: { name } }));
        if (m.type === "reply" && m.id === "fx") { clearTimeout(t); res(m); } }; });
    ws.close();
  }
  C("P1", `the manifest's effect '${name}' is stored in the preview world (the particles child's emitter can fetch it)`, !!name && effect?.ok === true && (effect?.reply?.effect?.name === name || effect?.effect?.name === name), effect);
} finally { pv.kill("SIGTERM"); await Promise.race([pv.exited, Bun.sleep(5000)]); }
console.log(`[preview-check] ${fail ? `${fail} failed` : "all passed"}`); process.exit(fail ? 1 : 0);
