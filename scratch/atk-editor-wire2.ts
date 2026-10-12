// ATTACK (editor & components, wire half 2): disabled while held / flying / sat, blueprint path, label edge cases.
// Paced under the 60-entries/10 s rate. Against the LIVE gym on :8985. @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (k, info) => console.log(k, typeof info === "string" ? info : JSON.stringify(info).slice(0, 700));
const ME = process.env.ATK_NAME ?? "atk-ed-2";
const me = await sock(); await me.join("gym", ME);
{ let who = await me.req("whois", { name: ME }); if (who?.people?.[0]?.role !== "builder") { const own = await sock(); await own.join("gym", "rab"); T("grant " + ME, show(await own.req("set", { id: "@world", component: `roles:${who.people[0].id}`, value: { role: "builder", can: { editWorld: true } } }))); own.close(); } }
const P = "atk-ee" + Date.now().toString(36).slice(-4); const ids = [];
const R = async (verb, args) => { const r = await me.req(verb, args); await sleep(220); return r; };
const mk = async (id, args) => { const r = await R("create", { id, ...args }); ids.push(id); T(`create ${id}`, show(r)); return r; };
const MODEL = (await R("find", { kind: "model" })).models[0].model;
let at = null;
const near = async (x, z) => { if (!at) { const r0 = await R("move", { to: [0, 0, 8] }); if (!r0.ok) T("   move spawn", show(r0)); at = [0, 8]; }
  const tx = x - 0.85, tz = z + 0.85; for (let n = 0; n < 30; n++) { await sleep(450); const dx = tx - at[0], dz = tz - at[1]; const d = Math.hypot(dx, dz); if (d < 0.05) break; const f = Math.min(1, 1.6 / d); const to = [at[0] + dx * f, 0, at[1] + dz * f]; const r = await R("move", { to }); if (!r.ok) { T("   move", show(r) + " closed=" + me.closed); break; } at = [to[0], to[2]]; } };
const meIn = async () => { const l = await R("look", {}); return String(JSON.stringify(l.bodies)).slice(0, 500); };
{ const l = await R("look", {}); T("look keys", Object.keys(l)); for (const t of l.things ?? []) if (/^atk-e[de]/.test(t.id)) { await R("delete", { id: t.id }); T("   swept", t.id); } }

// held
await mk(`${P}-g6`, { model: MODEL, components: { grabbable: {}, physics: { kind: "dynamic" } }, place: { at: [4, 12] } });
await near(4, 12); T("grab g6", show(await R("grab", { id: `${P}-g6` })));
let r = await R("set", { id: `${P}-g6`, component: "disabled", value: true }); T("H1 disable while held", show(r) + " notes=" + JSON.stringify(r.notes) + " closed=" + me.closed);
T("   me after", await meIn());
T("   put g6", show(await R("put", { id: `${P}-g6` })));
let i = await R("inspect", { id: `${P}-g6` }); T("   g6 at", JSON.stringify(i.at) + " comps " + Object.keys(i.components ?? {}));
T("   hidden while held?", show(await R("set", { id: `${P}-g6`, component: "disabled", value: false })));
T("   re-enable", show(await R("delete", { id: `${P}-g6`, component: "disabled" })));
T("   grab again", show(await R("grab", { id: `${P}-g6` })));
r = await R("set", { id: `${P}-g6`, component: "hidden", value: true }); T("H2 hidden while held (stays in hand?)", show(r) + " notes=" + JSON.stringify(r.notes));
T("   put", show(await R("put", { id: `${P}-g6` })));
// flying
await mk(`${P}-f7`, { model: MODEL, components: { grabbable: {}, physics: { kind: "dynamic" } }, place: { at: [6, 12] } });
await near(6, 12); T("grab f7", show(await R("grab", { id: `${P}-f7` })));
r = await me.req("throw", { id: `${P}-f7`, v: [0, 7, 1] }); T("throw f7", show(r) + " " + JSON.stringify(r).slice(0, 200));
await sleep(200); r = await me.req("set", { id: `${P}-f7`, component: "disabled", value: true }); T("F1 disable mid-flight", show(r) + " " + JSON.stringify(r).slice(0, 250));
for (const ms of [300, 800, 1500]) { await sleep(ms); i = await me.req("inspect", { id: `${P}-f7` }); T(`   f7 +${ms}ms at`, JSON.stringify(i.at) + " sim=" + String(JSON.stringify(i.sim ?? i.motion ?? i.resting)).slice(0, 120)); }
T("   re-enable", show(await R("delete", { id: `${P}-f7`, component: "disabled" })));
for (const ms of [300, 1500]) { await sleep(ms); i = await me.req("inspect", { id: `${P}-f7` }); T(`   f7 re-enabled +${ms}ms at`, JSON.stringify(i.at) + " " + JSON.stringify(i.components?.transform?.pos)); }
// seat
await mk(`${P}-s11`, { model: MODEL, components: { sockets: { seat: { pos: [0, 0.6, 0], body: { action: "sit" } } } }, place: { at: [8, 12] } });
await near(8, 12); r = await R("use", { id: `${P}-s11`, action: "sit" }); T("sit", show(r) + " attach=" + JSON.stringify(r.attach?.to));
T("   me seated", await meIn());
r = await R("set", { id: `${P}-s11`, component: "disabled", value: true }); T("S1 disable the seat while sat", show(r) + " notes=" + JSON.stringify(r.notes));
T("   me after", await meIn());
T("   stand (body kind?)", show(await R("use", { id: `${P}-s11`, action: "stand" })));
T("   re-enable", show(await R("delete", { id: `${P}-s11`, component: "disabled" })));
r = await R("use", { id: `${P}-s11`, action: "sit" }); T("   sit again", show(r));
r = await R("delete", { id: `${P}-s11` }); T("S2 delete the seat while sat", show(r) + " notes=" + JSON.stringify(r.notes));
T("   me after", await meIn());
// parent: hold a child, disable the parent
await mk(`${P}-p8`, { model: MODEL, place: { at: [4, 14.5] } });
await mk(`${P}-c9`, { model: MODEL, components: { grabbable: {}, parent: { to: `${P}-p8` }, transform: { pos: [0, 1.2, 0] } } });
await near(4, 14.5); T("grab child c9", show(await R("grab", { id: `${P}-c9` })));
r = await R("set", { id: `${P}-p8`, component: "disabled", value: true }); T("P1 disable the parent while its child is in my hand", show(r) + " notes=" + JSON.stringify(r.notes));
T("   me after", await meIn());
T("   put c9", show(await R("put", { id: `${P}-c9` })));
T("   throw c9", show(await R("throw", { id: `${P}-c9`, v: [0, 3, 0] })));
i = await R("inspect", { id: `${P}-c9` }); T("   c9", JSON.stringify(i.at) + " parent=" + JSON.stringify(i.components?.parent));
// blueprint
T("help publish", JSON.stringify(await R("help", { verb: "publish" })).slice(0, 400));
const pub = await R("publish", { from: `${P}-p8`, name: "atk-ed-bp" }); T("publish p8", show(pub) + " " + JSON.stringify(pub).slice(0, 250));
const h = (Object.keys(pub.after?.["@world"] ?? {}).find((k) => k.startsWith("blueprints:")) ?? "").replace("blueprints:", "sha256:") || Object.keys((await R("inspect", { id: "@world" })).components ?? {}).filter((k) => k.startsWith("blueprints:")).map((k) => "sha256:" + k.slice(11)).at(-1);
r = await R("create", { id: `${P}-bp5`, from: h, components: { light: { color: 0xffd9a0, intensity: 8, range: 6 } }, place: { at: [6, 14.5] } }); ids.push(`${P}-bp5`); T("B1 create from blueprint + light", show(r) + " " + JSON.stringify(r).slice(0, 200));
i = await R("inspect", { id: `${P}-bp5` }); T("   bp5 comps", Object.keys(i.components ?? {}));
// model delete leaves physics shape
await mk(`${P}-m4`, { model: MODEL, components: { physics: { kind: "dynamic" } }, place: { at: [8, 14.5] } });
r = await R("delete", { id: `${P}-m4`, component: "model" }); T("M1 delete model off a dynamic thing", show(r) + " " + String(JSON.stringify(r.notes)).slice(0, 300));
i = await R("inspect", { id: `${P}-m4` }); T("   m4 physics now", JSON.stringify(i.components?.physics).slice(0, 200));
// labels / numbers
T("L1 label with newline+NUL", show(await R("set", { id: `${P}-m4`, component: "label", value: "a\nb\u0000c" })));
i = await R("inspect", { id: `${P}-m4` }); T("   label stored", JSON.stringify(i.components?.label));
T("L2 label of 80 emoji (graphemes vs UTF-16)", show(await R("set", { id: `${P}-m4`, component: "label", value: "👩‍👩‍👧‍👦".repeat(80) })));
T("L3 label zero-width only", show(await R("set", { id: `${P}-m4`, component: "label", value: "​​" })));
T("N1 pos -0 / 1e5+1", show(await R("set", { id: `${P}-m4`, component: "transform", value: { pos: [-0, 0, 1e5 + 1] } })));
T("N2 pos 1e5 (inside the number cap, outside the world)", show(await R("set", { id: `${P}-m4`, component: "transform", value: { pos: [1e5, 0, 0] } })));
i = await R("inspect", { id: `${P}-m4` }); T("   m4 at", JSON.stringify(i.at));
T("N3 scale 0", show(await R("set", { id: `${P}-m4`, component: "transform", value: { pos: [19, 0, 17], scale: [0, 0, 0] } })));
T("N4 scale -1", show(await R("set", { id: `${P}-m4`, component: "transform", value: { pos: [19, 0, 17], scale: [-1, 1, 1] } })));
T("N5 q not unit", show(await R("set", { id: `${P}-m4`, component: "transform", value: { pos: [19, 0, 17], q: [0, 0, 0, 0] } })));
if (!process.env.KEEP) { for (const id of ids.reverse()) await R("delete", { id }); T("cleanup", ids.length + " deleted"); }
me.close(); process.exit(0);
