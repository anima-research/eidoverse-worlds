// Diving in the world's water LEVEL (lakes, rivers, the sea), as a player in a real browser.
//   bun tools/water/level-dive-check.ts   (its own scratch server and world; ENGINE_LIB=<dir> serves upstream's real modules)
// A terrain with a deep lake is built (the ground from this repo's height law); the body is put afloat in the lake;
// holding C dives it under (the 3D swim takes over from the float), looking down with W held dives too (R 10-28), and
// letting go brings it back up to the surface, where the float takes it again. Holding a thing afloat, C sinks and Q throws.
// With no @world.bounds there is no edge (LD11).
import { readFileSync, existsSync } from "node:fs";
import { scratchBench, mkCheck } from "../harness.ts";
import { until, pause } from "../protocol/wait.ts";

const WORLD = "level-dive";
const engine = process.env.ENGINE_LIB;
const bench = await scratchBench("level-dive", { worlds: [WORLD], owner: "diver", serverEnv: { TRUST_NAMES: "1" } });   // the diver owns it (TRUST_NAMES: the typed name is that account): LD9 places a crate
const { cdp, evalJson, BASE } = bench;
const { check, tally } = mkCheck();
const errors: string[] = [];
bench.cws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 300));
  if (m.method === "Fetch.requestPaused") {   // the terrain module: this repo's height law, or upstream's real one
    const f = engine ? `${engine}/${new URL(m.params.request.url).pathname.split("/").pop()}` : "";
    const body = engine ? (existsSync(f) ? readFileSync(f, "utf8") : null) : "// stand-in";
    if (body == null) cdp.send("Fetch.continueRequest", { requestId: m.params.requestId });
    else cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/javascript" }], body: Buffer.from(body).toString("base64") });
  }
});
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: engine ? "*/library/eidoverse/*.js" : "*/library/eidoverse/terrain.js" }] });
const C = "(await import('/lib/controller.js'))";
const js = (body: string) => evalJson(`(async () => { ${body} })()`);
const y = () => js(`return +${C}.myState.pos.y.toFixed(2);`);
const diving = () => js(`return ${C}.isLevelDiving();`);
const key = (op: "add" | "delete", k: string) => js(`${C}.keys.${op}(${JSON.stringify(k)}); return true;`);
const put = (yy: number) => js(`${C}.myState.pos.set(0, ${yy}, 30); return true;`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?world=${WORLD}&name=diver` });
  await until("the water debug hook", () => evalJson("!!globalThis.__waterDebug").catch(() => false), { ms: 60000 });
  await js(`const { THREE } = await import('/lib/core.js'), tm = await import('/shared/terrainmath.js');
    globalThis.makeTerrain = (args) => {
      const p = tm.terrainParams(args), h = tm.makeHeightField(p), geo = new THREE.PlaneGeometry(p.size, p.size, 96, 96).rotateX(-Math.PI / 2);
      const pos = geo.attributes.position; for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals(); return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: 0x7a8a5a })), heightAt: h };
    }; return true;`);
  await until("the world hydrated", () => js("return (await import('/lib/state.js')).state.hydrated;"), { ms: 15000 });
  await js("(await import('/lib/world.js')).applyTerrainState({ seed: 7, size: 120, amplitude: 0, features: [{ type: 'hill', x: 0, z: 30, radius: 18, height: -8 }], water: { level: 0 } }); return true;");
  await until("the lake's level is 0", () => js("return (await import('/lib/water.js')).waterLevel() === 0;"), { ms: 15000 });

  await js("globalThis.__hints = []; const h = document.getElementById('hintbar'); new MutationObserver(() => __hints.push(h.textContent)).observe(h, { childList: true, subtree: true, characterData: true }); return true;");
  // falling over the lake with C held, before the body has ever floated: no swim starts in mid-air (review #254)
  await put(8); await key("add", "KeyC"); await pause("C held through the start of the fall", 200);
  const fallingWithC = { diving: await diving(), y: await y() }; await key("delete", "KeyC");
  // afloat after the fall's dunk: near the float line AND at rest (falling through -1.1 on the way down isn't afloat)
  await until("afloat after the fall's dunk", async () => { const a = await y(); await pause("two reads apart", 300); const b = await y();
    if (Math.abs(b + 1.1) <= 0.25 && Math.abs(b - a) < 0.05) return true; throw new Error(`y ${a?.toFixed?.(3)} → ${b?.toFixed?.(3)} (want ≈ -1.1 ± 0.25, still)`); }, { ms: 30000 });   // a slow GL runner settles later (macOS CI 10-29); the throw is the evidence
  await put(-1.1); await pause("the float settles", 1500);
  const floating = { y: await y(), diving: await diving() };
  const hintAfloat = await js("return __hints.some((t) => /look down to dive/.test(t));");
  // the clip while afloat holds steady (tread idle, swim moving), not flipping frame to frame: sampled every frame for 1.5 s
  const clips = () => js(`const c = ${C}, seen = [], t0 = performance.now();
    while (performance.now() - t0 < 1500) { seen.push(c.myState.clip); await new Promise((r) => requestAnimationFrame(r)); }
    let flips = 0; for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) flips++; return { flips, frames: seen.length, clips: [...new Set(seen)] };`);
  const idleClips = await clips();
  await key("add", "KeyW"); await pause("W held: swimming at the surface", 400); const swimClips = await clips(); await key("delete", "KeyW");
  await put(-1.1); await pause("the float settles", 1200);
  await key("add", "KeyC"); await until("a metre under, C held", async () => (await y()) < floating.y - 1, { ms: 10000 }).catch(() => {});   // the depth, not a fixed 1.5 s (macOS CI 10-29: -1.63 at 1.5 s); a miss is LD3's evidence
  const dive = await js(`const c = ${C}; return { y: +c.myState.pos.y.toFixed(2), diving: c.isLevelDiving(), medium: c.myState.locomotion?.medium ?? null };`);
  await key("delete", "KeyC"); await key("add", "Space"); await pause("Space held: rising", 3500); await key("delete", "Space");
  await until("back at the surface", async () => !(await diving()) && Math.abs((await y()) - floating.y) < 0.6, { ms: 8000 }).catch(() => {});
  const surfaced = { y: await y(), diving: await diving() };
  // look down and push forward: a desk dives the way a headset does, no dive key (R 10-28: "Minecraft rules")
  await put(-1.1); await pause("the float settles", 1200);
  await js(`${C}.setCamPitch(1.1); return true;`); await key("add", "KeyW"); await pause("W held, looking down", 1500);
  const lookDive = { y: await y(), diving: await diving() };
  await key("delete", "KeyW"); await js(`${C}.setCamPitch(0.32); return true;`);
  // a thing held afloat: C sinks the swimmer and never throws it; Q throws it (LEGACY-PINS item 1: C was throw/punt too)
  await put(-1.1); await pause("the float settles", 1200);
  const TP = "(await import('/lib/thingphysics.js'))";
  const made = await js(`const m = await import('/lib/net.js'), p = ${C}.myState.pos; return await m.sendRequest('create', { model: 'eidoverse/assets/models/crate_large_blue.glb', components: { label: 'Float crate', grabbable: { enabled: true }, transform: { pos: [p.x + 0.7, p.y + 0.6, p.z], scale: 0.2 } } });`);
  const crateId = () => js("const st = (await import('/lib/net.js')).replica.st; return Object.keys(st?.entities ?? {}).find((k) => st.entities[k]?.c?.label === 'Float crate') ?? null;");
  await until("the crate is drawn", async () => { const k = await crateId(); return !!k && await js(`return !!(await import('/lib/world.js')).entities.get(${JSON.stringify(k)});`); }, { ms: 45000 }).catch(() => {});
  const crate = await crateId();
  await js(`await ${TP}.physicsApi.grab(${JSON.stringify(crate)}); return true;`); await pause("the grab lands", 800);
  const holding = () => js(`return ${TP}.physicsApi.mine().includes(${JSON.stringify(crate)});`);
  const press = async (code: string, k: string, vk: number, ms: number) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key: k, windowsVirtualKeyCode: vk });
    await pause(`${code} held`, ms); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, windowsVirtualKeyCode: vk }); };
  const heldAfloat = await holding(); const y0 = await y();
  await press("KeyC", "c", 67, 1500); await pause("anything thrown leaves the hand", 800);
  const afterC = { held: await holding(), y0, y: await y() };
  await put(-1.1); await pause("afloat again, still holding it", 1500);
  await js("const b = (await import('/lib/base.js')).bus; window.__seenKeys = []; b.on('key', (e) => window.__seenKeys.push(e.code)); return true;");
  await press("KeyQ", "q", 81, 80); await until("Q let go of it", async () => !(await holding()), { ms: 15000 }).catch(() => {});
  const afterQ = { held: await holding(), y: await y(), keys: await js("return window.__seenKeys;"), pending: await js(`return ${TP}.physicsApi.pending?.() ?? null;`), said: await js("return (await import('/lib/chat.js')).recentChat().filter((l) => l.who === '*').slice(-3).map((l) => l.text);") };   // a still-held crate says why (macOS 40976310724)
  // no @world.bounds: walking 84 m out is not pulled back to main's 78 m stage island (LEGACY-PINS item 2)
  const unbound = await js("return await (await import('/lib/net.js')).sendRequest('delete', { id: '@world', component: 'bounds' });");   // founding wrote ±20 m
  await until("the bounds are gone", () => js(`return ${C}.worldBounds() === null;`), { ms: 8000 }).catch(() => {});
  await js(`${C}.myState.pos.set(0, 0.5, 84); return true;`); await key("add", "KeyW"); await pause("W held, 84 m out", 800); await key("delete", "KeyW");
  const far = await js(`const p = ${C}.myState.pos; return { r: +Math.hypot(p.x, p.z).toFixed(2), bounds: ${C}.worldBounds() };`), unboundOk = !!unbound?.ok;

  check("LD1 afloat at the surface is not diving", floating.diving === false, JSON.stringify(floating));
  check("LD2 falling over the water with C held does not start a swim in the air", fallingWithC.diving === false, JSON.stringify(fallingWithC));
  check("LD3 holding C in deep level water dives a metre and more under, in the water medium", dive.diving === true && dive.y < floating.y - 1 && dive.medium === "water", JSON.stringify({ floating, dive }));
  check("LD4 back at the surface the float takes the body again, at the floating depth", surfaced.diving === false && Math.abs(surfaced.y - floating.y) < 0.6, JSON.stringify({ floating, surfaced }));
  check("LD5 looking down with W held dives, no key (R 10-28)", lookDive.diving === true && lookDive.y < floating.y - 1, JSON.stringify({ floating, lookDive }));
  check("LD6 the floating clip holds steady, idle and swimming (at most one change in 1.5 s)", idleClips.flips <= 1 && swimClips.flips <= 1 && idleClips.frames > 10, JSON.stringify({ idleClips, swimClips }));
  check("LD9 holding a thing afloat, holding C sinks me and keeps it in my hand (C is down, never throw)", made?.ok && heldAfloat === true && afterC.held === true && afterC.y < y0 - 0.3, JSON.stringify({ made: made?.ok ? true : made, crate, heldAfloat, afterC }));
  check("LD10 …and Q throws it (the throw/punt key)", afterC.held === true && afterQ.held === false, JSON.stringify({ afterC, afterQ }));
  check("LD11 a world with no bounds has no edge: walking 84 m from the origin stays out there (no 78 m stage island)", unboundOk && far.bounds === null && far.r > 80, JSON.stringify({ unbound: unboundOk || unbound, far }));
  check("LD8 afloat on a lake, before any dive, the swim keys are said (look down to dive) (R 10-28)", hintAfloat === true, "");
  // headless Chrome has no working GPU: WebGPU's error scopes complain on every boot (colour-picker-bench, same filter)
  const real = errors.filter((e) => !/popErrorScope|sky finish/.test(e));
  check("LD7 no page errors (beyond headless GPU noise)", real.length === 0, JSON.stringify(real.slice(0, 4)));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[level-dive-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
