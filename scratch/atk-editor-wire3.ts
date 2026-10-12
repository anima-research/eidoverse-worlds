// ATTACK (editor & components, wire half 3): reproduce twice — a held child whose parent is switched off; undo through
// the one-place rule; a dynamic thing whose model was deleted. Against the LIVE gym on :8985 as atk-ed-2. @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (k, info) => console.log(k, typeof info === "string" ? info : String(JSON.stringify(info)).slice(0, 500));
const me = await sock(); await me.join("gym", "atk-ed-2");
const R = async (verb, args) => { const r = await me.req(verb, args); await sleep(230); return r; };
const MODEL = (await R("find", { kind: "model" })).models[0].model; const ids = [];
const mk = async (id, args) => { const r = await R("create", { id, ...args }); ids.push(id); if (!r.ok) T(`create ${id}`, show(r)); return r; };
let at = null; const near = async (x, z) => { if (!at) { await R("move", { to: [0, 0, 8] }); at = [0, 8]; }
  const tx = x - 0.85, tz = z + 0.85; for (let n = 0; n < 30; n++) { await sleep(450); const dx = tx - at[0], dz = tz - at[1]; const d = Math.hypot(dx, dz); if (d < 0.05) break; const f = Math.min(1, 1.6 / d); const to = [at[0] + dx * f, 0, at[1] + dz * f]; const r = await R("move", { to }); if (!r.ok) { T("   move", show(r)); break; } at = [to[0], to[2]]; } };
for (const round of [1, 2]) {
  const P = `atk-ew${round}` + Date.now().toString(36).slice(-3);
  T(`== round ${round}: held child under a parent that gets switched off`, "");
  await mk(`${P}-p`, { model: MODEL, place: { at: [4, 14.5] } });
  await mk(`${P}-c`, { model: MODEL, components: { grabbable: { range: 3 }, parent: { to: `${P}-p` }, transform: { pos: [0, 1.2, 0] } } });
  await near(4, 14.5); const g = await R("grab", { id: `${P}-c` }); T("grab child", show(g));
  if (g.ok) {
    let r = await R("set", { id: `${P}-p`, component: "disabled", value: true }); T("P1 disable the parent", show(r) + " notes=" + JSON.stringify(r.notes));
    const holds = (await R("look", {})); T("   still holding? (grab again says)", show(await R("grab", { id: `${P}-c` })));
    T("   use c (held)", show(await R("use", { id: `${P}-c`, args: { held: true } })));
    T("   put c", show(await R("put", { id: `${P}-c` })));
    T("   drop c", show(await R("drop", { id: `${P}-c` })));
    T("   throw c", show(await R("throw", { id: `${P}-c`, v: [0, 2, 1] })));
    T("   put c at a spot", show(await R("put", { id: `${P}-c`, at: [5, 0.5, 14.5] })));
    T("   re-enable parent", show(await R("delete", { id: `${P}-p`, component: "disabled" })));
    T("   put c now", show(await R("put", { id: `${P}-c` })));
    const i = await R("inspect", { id: `${P}-c` }); T("   c", JSON.stringify(i.at) + " parent=" + JSON.stringify(i.components?.parent) + " holds?" + JSON.stringify(holds?.holds));
  }
  if (process.env.HELD_ONLY) { for (const id of ids.splice(0).reverse()) await R("delete", { id }); continue; }
  T(`== round ${round}: undo through one-place`, "");
  await mk(`${P}-m`, { model: MODEL, place: { at: [8, 14.5] } });
  const d = await R("delete", { id: `${P}-m`, component: "model" }); T("delete model", show(d) + " act=" + d.act);
  T("set light", show(await R("set", { id: `${P}-m`, component: "light", value: { color: 0xffd9a0, intensity: 8, range: 6 } })));
  const u = await R("undo", { act: d.act }); T("U1 undo the model delete", show(u) + " fix=" + JSON.stringify(u.refused?.fix));
  const u2 = await R("undo", {}); T("   bare undo (latest = the light set)", show(u2) + " undid=" + JSON.stringify(u2.undid));
  const u3 = await R("undo", { act: d.act }); T("   undo the model delete now", show(u3));
  T("   m comps", Object.keys((await R("inspect", { id: `${P}-m` })).components ?? {}));
  T(`== round ${round}: dynamic thing without a model`, "");
  await mk(`${P}-d`, { model: MODEL, components: { physics: { kind: "dynamic" } }, place: { at: [6, 14.5] } });
  await R("delete", { id: `${P}-d`, component: "model" }); await sleep(2500);
  const i2 = await R("inspect", { id: `${P}-d` }); T("D1 2.5 s after the model went", JSON.stringify(i2.at) + " physics=" + JSON.stringify(i2.components?.physics) + " warn=" + JSON.stringify(i2.warnings ?? i2.lint));
  T("   set it 3 m up (does it fall?)", show(await R("set", { id: `${P}-d`, component: "transform", value: { pos: [6, 3, 14.5] } }))); await sleep(3000);
  T("   at", JSON.stringify((await R("inspect", { id: `${P}-d` })).at));
  T("   punt it", show(await R("punt", { id: `${P}-d`, v: [0, 3, 0] })));
  for (const id of ids.splice(0).reverse()) await R("delete", { id });
}
me.close(); process.exit(0);
