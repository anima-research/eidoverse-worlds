// tools/protocol/particles-shots.ts — every Essentials particle effect, photographed in a real browser, one at a time,
// against a night sky, so a change to the particle system can be A/B'd by eye (R 10-07: "keep existing worlds looking the
// same"). Not a pass/fail suite: it writes PNGs and says which effects drew nothing (a blank frame is a FAIL line).
//
//   SHOTS=<dir> MODE=before|after bun tools/protocol/particles-shots.ts      (under the house guards: flock + perf-guard)
//
// MODE=before writes the first protocol's spelling ({preset, seed}); after writes {effect, seed}. Same seed, same place,
// same camera, same clock offset, so the two photographs differ only by the renderer.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "fxbot", WORLD = "fx";
const MODE = process.env.MODE ?? "after", OUT = process.env.SHOTS ?? path.join(ENGINE, "notes", "particle-shots", MODE);
const PRESETS = (process.env.ONLY ?? "fire,sparks,embers,smoke,dust,snow,magic,stars,muzzle").split(",");
const WARM = process.env.WARM !== "0";   // a first, unphotographed effect: the night sky settles while it burns
fs.mkdirSync(OUT, { recursive: true });
process.env.TRUST_NAMES = "1";
let worldsDir = "";
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench("fxshots", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "particle shots"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const { check: check0, tally } = mkCheck();
const check = (n: string, ok: any, d?: any) => check0(n, !!ok, ok ? "" : JSON.stringify(d ?? "").slice(0, 300));
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
const shot = async (name: string) => { const r = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 290, y: 100, width: 700, height: 600, scale: 1 } });
  const f = path.join(OUT, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, "base64")); return f; };

try {
  // the owner acts over its own socket; the browser is a spectator (no body, a camera we place), so nothing stands in frame
  const own = new WebSocket(BASE.replace("http", "ws") + "/ws"); const replies = new Map(); let rn = 0;
  own.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply") replies.get(m.id)?.(m.reply); };
  await new Promise((r, j) => { own.onopen = r; own.onerror = j; });
  own.send(JSON.stringify({ type: "join", world: WORLD, id: ME, avatar: "", replica: true })); await sleep(800);
  const req = (verb: string, args: any) => new Promise<any>((res) => { const id = `o${++rn}`; replies.set(id, res); own.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, refused: { code: "timeout" } }), 6000); });
  const sky = await req("sky", { hours: 0, rate: 0 }); check("night sky", sky?.ok, sky);
  await cdp.send("Page.navigate", { url: `${BASE}/?name=shots&world=${WORLD}&webgl=1&spectate` });
  check("world", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`, 60000));
  await evalJson(`(() => { const st = document.createElement('style'); st.textContent = 'body > *:not(canvas) { display: none !important; }'; document.head.append(st); return true; })()`);
  await sleep(6000);   // the night sky settles
  const backend = await page(`return (await import('/lib/core.js')).backendName();`);
  console.log(`  backend: ${backend}`);
  const aim = () => page(`const { camera } = await import('/lib/core.js'); camera.position.set(4, 1.4, 1.2); camera.lookAt(4, 1.25, -3.2); camera.updateMatrixWorld(); return true;`);
  for (const p of PRESETS) {
    const value = MODE === "before" ? { preset: p, seed: 7 } : { effect: p, seed: 7 };
    const r = await req("create", { id: `fx-${p}`, components: { transform: { pos: [4, 0.6, -3.2] }, particles: value } });
    check(`${p}: created`, r?.ok, r); if (!r?.ok) console.log(`  ${p}: refused ${JSON.stringify(r)}`);
    await waitFor(`import('/lib/world.js').then((m) => m.entities.has('fx-${p}'))`);
    await aim(); await sleep(3500); await aim();   // past every effect's warm-up
    if (process.env.PRE) { console.log('  pre:', JSON.stringify(await page(process.env.PRE.replaceAll('$ID', `fx-${p}`)).catch((e) => String(e)))); await sleep(1500); await aim(); }
    const f = await shot(p);
    const st = await page(`const process = { env: { DBG: ${JSON.stringify(process.env.DBG ?? '')} } }; const m = await import('/lib/emitters.js'), w = await import('/lib/world.js'); const h = m._registry.get('fx-${p}');
      return { live: m.emitterCount(), comp: JSON.stringify(w.bagOf('fx-${p}')?.particles ?? null), drawn: h ? h.parts.map((x) => x.mesh.count) : null, alive: h ? h.parts.map((x) => x.sim.liveCount()) : null, vis: h ? h.parts.map((x) => x.mesh.visible) : null, dbg: process.env.DBG ? (() => { const m = h.parts[0].mesh; const g = m.geometry; return { pos: [...g.attributes.iPos.array.slice(0, 6)], col: [...g.attributes.iCol.array.slice(0, 8)], sa: [...g.attributes.iSa.array.slice(0, 6)], mw: [...m.matrixWorld.elements.slice(12, 15)], parent: m.parent?.name, gp: m.parent?.parent?.type, inScene: (() => { let o = m; while (o.parent) o = o.parent; return o.type; })(), layers: m.layers.mask, ro: m.renderOrder }; })() : null };`).catch((e) => String(e));
    console.log(`  ${p}: ${JSON.stringify(st)}`);
    console.log(`  ${p}: ${f} (${fs.statSync(f).size} bytes)`);
    await req("delete", { id: `fx-${p}` });
    await sleep(600);
  }
  await aim(); const empty = await shot("_empty"); console.log(`  empty frame: ${empty} (${fs.statSync(empty).size} bytes)`);
  own.close();
} catch (e) { console.error(e); process.exitCode = 1; }
await cleanup(tally.failed ? 1 : 0);
console.log(`${tally.passed} ok, ${tally.failed} failed`); process.exit(tally.failed ? 1 : 0);
