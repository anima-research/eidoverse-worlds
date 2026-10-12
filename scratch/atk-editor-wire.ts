// ATTACK (editor & components, wire half): one-place rule through every path, disabled while held/flying/parent/seat,
// env singletons on the wire, label cap. Against the LIVE gym on :8985. @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (k, info) => console.log(k, typeof info === "string" ? info : JSON.stringify(info).slice(0, 600));
const ME = process.env.ATK_NAME ?? "atk-ed-1";
const me = await sock(); const j = await me.join("gym", ME); T("join", { you: j.snapshot?.you, errors: j.errors });
let who = await me.req("whois", { name: ME }); T("whois", who);
if (who?.people?.[0]?.role !== "builder") {
  const own = await sock(); await own.join("gym", "rab");
  const id = who.people[0].id;
  const g = await own.req("set", { id: "@world", component: `roles:${id}`, value: { role: "builder" } }); T("grant", show(g));
  own.close(); await sleep(300); who = await me.req("whois", { name: ME }); T("role now", who?.people?.[0]?.role);
}
T("move body in", show(await me.req("move", { to: [15, 0, 15] })));
const fm = await me.req("find", { kind: "model" }); const MODEL = fm.models[0].model; T("find model", JSON.stringify(fm).slice(0, 300)); T("MODEL", MODEL);
const P = "atk-ed" + Date.now().toString(36).slice(-4); const ids = [];
const mk = async (id, args) => { const r = await me.req("create", { id, ...args }); ids.push(id); T(`create ${id}`, show(r)); return r; };
const st = () => me.req("inspect", { id: ids[0] });

// ---- (4) one place per thing: model + light through every wire path
T("== (4) one place per thing", "");
T("4a create {model, light} in one create", show(await mk(`${P}-ml1`, { model: MODEL, components: { light: { color: 0xffd9a0, intensity: 8, range: 6 } }, place: { at: [15, 15] } })));
let i1 = await me.req("inspect", { id: `${P}-ml1` }); T("   inspect ml1 comps", Object.keys(i1?.components ?? i1?.entity?.c ?? {}));
await mk(`${P}-m2`, { model: MODEL, place: { at: [16, 15] } });
T("4b set light on a model", show(await me.req("set", { id: `${P}-m2`, component: "light", value: { color: 0xffd9a0, intensity: 8, range: 6 } })));
await mk(`${P}-l3`, { components: { light: { color: 0xffd9a0, intensity: 8, range: 6 }, transform: { pos: [17, 1, 15] } } });
T("4c set model on a light", show(await me.req("set", { id: `${P}-l3`, component: "model", value: "crate" })));
T("4d batch: set model then light on l3 in one batch", show(await me.req("batch", { ops: [{ verb: "set", args: { id: `${P}-l3`, component: "model", value: "crate" } }] })));
// delete model, add light, undo the delete
await mk(`${P}-m4`, { model: MODEL, place: { at: [18, 15] } });
const d = await me.req("delete", { id: `${P}-m4`, component: "model" }); T("4e delete m4.model", show(d));
T("   set light on m4 (now modelless)", show(await me.req("set", { id: `${P}-m4`, component: "light", value: { color: 0xffd9a0, intensity: 8, range: 6 } })));
const u = await me.req("undo", { act: d.act }); T("4f undo the model delete act=" + d.act + " (light present now)", show(u) + " " + JSON.stringify(u).slice(0, 300));
i1 = await me.req("inspect", { id: `${P}-m4` }); T("   m4 comps after undo", Object.keys(i1?.components ?? i1?.entity?.c ?? {}));
// blueprint path: publish a thing then create-from with a light folded in
const pub = await me.req("publish", { ids: [`${P}-m2`], name: "atk-ed-bp" }); T("4g publish m2 as blueprint", show(pub) + " " + JSON.stringify(pub).slice(0, 200));
const h = pub?.hash ?? pub?.blueprint ?? pub?.id ?? pub?.refs?.[0]?.id;
T("   create from blueprint + light", show(await me.req("create", { id: `${P}-bp5`, from: h, components: { light: { color: 0xffd9a0, intensity: 8, range: 6 } }, place: { at: [19, 15] } })));
ids.push(`${P}-bp5`);
T("4g2 duplicate a model thing (from: id) with a light folded in", show(await me.req("create", { id: `${P}-dup6`, from: `${P}-m2`, components: { light: { color: 0xffd9a0, intensity: 8, range: 6 } } }))); ids.push(`${P}-dup6`);
i1 = await me.req("inspect", { id: `${P}-dup6` }); T("   dup6 comps", Object.keys(i1?.components ?? {}));
T("4g3 duplicate the light thing with a model folded in", show(await me.req("create", { id: `${P}-dup7`, from: `${P}-l3`, components: { model: MODEL } }))); ids.push(`${P}-dup7`);
i1 = await me.req("inspect", { id: `${P}-dup7` }); T("   dup7 comps", Object.keys(i1?.components ?? {}));
T("4h set light@2 on a model", show(await me.req("set", { id: `${P}-m2`, component: "light@2", value: { color: 0xffd9a0, intensity: 8, range: 6 } })));
T("4i set hesperus/light on a model (namespaced)", show(await me.req("set", { id: `${P}-m2`, component: "atk/light", value: { intensity: 8 } })));
T("4j update (merge) light onto a model", show(await me.req("update", { id: `${P}-m2`, component: "light", value: { intensity: 8 } })));
T("4k set with merge:true", show(await me.req("set", { id: `${P}-m2`, component: "light", value: { color: 0xffd9a0, intensity: 8, range: 6 }, merge: true })));

// ---- (3) disabled
T("== (3) disabled", "");
await mk(`${P}-g6`, { model: MODEL, components: { grabbable: {} , physics: { kind: "dynamic" } }, place: { at: [15, 17] } });
await sleep(300);
T("3a grab g6", show(await me.req("grab", { id: `${P}-g6` })));
const off = await me.req("set", { id: `${P}-g6`, component: "disabled", value: true }); T("3b disable while held", show(off) + " " + JSON.stringify(off.notes ?? off).slice(0, 300));
T("   put g6 (should say not holding)", show(await me.req("put", { id: `${P}-g6` })));
T("   grab g6 while off", show(await me.req("grab", { id: `${P}-g6` })));
T("   re-enable", show(await me.req("delete", { id: `${P}-g6`, component: "disabled" })));
i1 = await me.req("inspect", { id: `${P}-g6` }); T("   g6 after", JSON.stringify(i1).slice(0, 400));
// flying: throw a dynamic then disable mid-air
await mk(`${P}-f7`, { model: MODEL, components: { grabbable: {}, physics: { kind: "dynamic" } }, place: { at: [16, 17] } });
await sleep(300); T("3c grab f7", show(await me.req("grab", { id: `${P}-f7` })));
const th = await me.req("throw", { id: `${P}-f7`, v: [0, 6, 2] }); T("   throw f7", show(th) + " " + JSON.stringify(th).slice(0, 200));
await sleep(150);
const off2 = await me.req("set", { id: `${P}-f7`, component: "disabled", value: true }); T("3d disable mid-flight", show(off2) + " " + JSON.stringify(off2).slice(0, 300));
await sleep(1500);
i1 = await me.req("inspect", { id: `${P}-f7` }); T("   f7 1.5s later (where is it? sim?)", JSON.stringify(i1).slice(0, 500));
T("   re-enable f7", show(await me.req("delete", { id: `${P}-f7`, component: "disabled" })));
await sleep(1500); i1 = await me.req("inspect", { id: `${P}-f7` }); T("   f7 after re-enable", JSON.stringify(i1?.components?.transform ?? i1).slice(0, 300));
// parent: disable a parent, then edit/grab the child, then delete the parent's disabled
await mk(`${P}-p8`, { model: MODEL, place: { at: [17, 17] } });
await mk(`${P}-c9`, { model: MODEL, components: { grabbable: {}, parent: { to: `${P}-p8` }, transform: { pos: [0, 1, 0] } } });
T("3e disable parent p8", show(await me.req("set", { id: `${P}-p8`, component: "disabled", value: true })));
T("   grab child c9 (under off parent)", show(await me.req("grab", { id: `${P}-c9` })));
T("   set label on child (edit stays open?)", show(await me.req("set", { id: `${P}-c9`, component: "label", value: "kid" })));
T("   reparent child out of the off parent", show(await me.req("delete", { id: `${P}-c9`, component: "parent" })));
T("   grab c9 now", show(await me.req("grab", { id: `${P}-c9` })));
T("   put c9", show(await me.req("put", { id: `${P}-c9` })));
T("   child of an off parent: create under it", show(await me.req("create", { id: `${P}-c10`, model: MODEL, components: { parent: { to: `${P}-p8` }, transform: { pos: [0, 2, 0] } } }))); ids.push(`${P}-c10`);
T("   disable on @world?", show(await me.req("set", { id: "@world", component: "disabled", value: true })));
T("   disabled: false (is false a value?)", show(await me.req("set", { id: `${P}-p8`, component: "disabled", value: false })));
i1 = await me.req("inspect", { id: `${P}-p8` }); T("   p8 comps", Object.keys(i1?.components ?? {}));
T("   disabled: 'yes'", show(await me.req("set", { id: `${P}-p8`, component: "disabled", value: "yes" })));
// seat: a thing with a seat socket, someone sits, then it's switched off
await mk(`${P}-s11`, { model: MODEL, components: { sockets: { seat: { pos: [0, 0.6, 0], body: { action: "sit" } } } }, place: { at: [18, 17] } });
await me.req("move", { to: [18, 0, 16.5] }); const sit = await me.req("use", { id: `${P}-s11`, action: "sit" }); T("3f sit on s11", show(sit) + " " + JSON.stringify(sit).slice(0, 300));
const sit2 = sit.ok ? sit : await me.req("body", { to: `${P}-s11`, kind: "seat" }); if (!sit.ok) T("   body seat", show(sit2) + " " + JSON.stringify(sit2).slice(0, 300));
const off3 = await me.req("set", { id: `${P}-s11`, component: "disabled", value: true }); T("3g disable the seat while sat", show(off3) + " " + JSON.stringify(off3).slice(0, 300));
const lk = await me.req("look", {}); T("   look: me", JSON.stringify(lk?.you ?? lk?.me ?? lk).slice(0, 300));
T("   delete the seat while sat", show(await me.req("delete", { id: `${P}-s11` })));

// ---- (2) env on the wire
T("== (2) environment", "");
T("2a set sky on a thing", show(await me.req("set", { id: `${P}-m2`, component: "sky", value: { preset: "x" } })));
T("2b set terrain on a thing", show(await me.req("set", { id: `${P}-m2`, component: "terrain", value: {} })));
const wi = await me.req("inspect", { id: "@world" }); T("2c @world comps", Object.keys(wi?.components ?? {}).filter((k) => !k.startsWith("roles:")));
T("2d sky verb #1", show(await me.req("sky", { hours: 12 })) + " " + JSON.stringify(await me.req("help", { verb: "sky" })).slice(0, 300));
T("2e sky verb #2 (second create)", show(await me.req("sky", { hours: 18 })));
let w2 = await me.req("inspect", { id: "@world" }); T("   @world.sky", String(JSON.stringify(w2?.components?.sky)).slice(0, 300));
T("2f set @world.sky directly", show(await me.req("set", { id: "@world", component: "sky", value: { hours: 6 } })));
T("2g set @world.terrain", show(await me.req("set", { id: "@world", component: "terrain", value: {} })) + " " + JSON.stringify((await me.req("schema", { component: "terrain" })).components?.terrain).slice(0, 400));
T("2h set @world.grass", show(await me.req("set", { id: "@world", component: "grass", value: {} })));
T("2i weather", show(await me.req("weather", { weather: "rain" })));
w2 = await me.req("inspect", { id: "@world" }); T("   @world comps", Object.keys(w2?.components ?? {}).filter((k) => !k.startsWith("roles:")));
T("2j delete sky", show(await me.req("delete", { id: "@world", component: "sky" })));
T("2k delete terrain", show(await me.req("delete", { id: "@world", component: "terrain" })));
T("2l delete grass", show(await me.req("delete", { id: "@world", component: "grass" })));
T("2m weather with no sky", show(await me.req("weather", { weather: "rain" })));
w2 = await me.req("inspect", { id: "@world" }); T("   @world comps", Object.keys(w2?.components ?? {}).filter((k) => !k.startsWith("roles:")));
T("2n delete weather-only sky", show(await me.req("delete", { id: "@world", component: "sky" })));

// ---- (5) label
T("== (5) labels", "");
T("5a 5000-char label", show(await me.req("set", { id: `${P}-m2`, component: "label", value: "x".repeat(5000) })));
T("5b 81-char label", show(await me.req("set", { id: `${P}-m2`, component: "label", value: "y".repeat(81) })));
T("5c 80-char label", show(await me.req("set", { id: `${P}-m2`, component: "label", value: "z".repeat(80) })));
T("5d label with newlines", show(await me.req("set", { id: `${P}-m2`, component: "label", value: "a\nb\u0000c" })));
T("5e transform -0 / 1e309-ish", show(await me.req("set", { id: `${P}-m2`, component: "transform", value: { pos: [-0, 0, 1e5 + 1] } })));
T("5f transform NaN via string", show(await me.req("set", { id: `${P}-m2`, component: "transform", value: { pos: ["abc", 0, 0] } })));

if (!process.env.KEEP) { for (const id of ids.reverse()) await me.req("delete", { id }); T("cleanup", ids.length + " deleted"); }
me.close(); process.exit(0);
