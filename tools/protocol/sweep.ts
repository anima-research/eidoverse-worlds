// tools/protocol/sweep.ts — the translators against real logs, and the pins the core relies on.
//   bun tools/protocol/sweep.ts                  # every distinct log.jsonl under the checkout's parent directory
//   PROTOCOL_WORLDS=<dir>[:<dir>…] bun tools/protocol/sweep.ts
// Required, for every distinct world log found:
//   - translate-v1: 0 divergences (the fold agrees with the projection of the engine's own fold after EVERY
//     entry — the translator checks this itself);
//   - the written log, re-read from text by the strict reader alone: status ok, 0 malformed, and its fold equals
//     the translator's final projection;
//   - the projection loses nothing: an independent inverse (components → old field names), compared with the
//     REAL engine fold, entry by entry (every 250th past 2,000 entries), aligned by act. Only representation is
//     normalised (yaw ↔ q, scalar scale ↔ vector, light spelling) and only translate-v1's DROPPED list may differ.
//     (Kept from the phase-1 test, b05715f9: the lab sweep had no such check. Without it a translator that silently
//     dropped grass passed.)
// Plus: her four dialect-3 fixtures through translate-d3 (her goldens reproduce; 0 world/flight divergences; every
// launch rests where hers rests, re-checked by a carrier; deterministic; strict read-back clean); the sim build pin;
// the hash shim (native = portable = the reference vectors).
import { schemaRefusal } from "../../shared/protocol/authority.js";
import { hexColor } from "./import-v1/translate-v1.js";
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./common.ts";
import { sha256, sha256Portable, utf8Hex } from "../../shared/protocol/hash.js";
import { readLog, fold as replica, opsOf, applyInPlace, emptyState } from "../../shared/protocol/fold.js";
import { translate as translateV1, DROPPED, hasEpoch } from "./import-v1/translate-v1.js";
import { translate as translateD3 } from "./import-v1/translate-d3.js";
import { simFold, EIDOSIM_BUILD, EIDOSIM_FILES } from "../../shared/protocol/simlayer.js";
import { emptyState as v1Empty, foldEntry } from "./import-v1/fold.js";
import * as eidosim from "../../shared/sim.js";
import { localOf } from "../../shared/hierarchy.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); } };
const parse = (raw: string) => raw.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const text = (out: any[]) => out.map((e) => JSON.stringify(e)).join("\n") + "\n";
const c = (o: any) => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

// ---- 1. the hash shim: Bun's native hasher and the portable one agree, with each other and the FIPS vectors ----
const VEC: [string, string][] = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
];
for (const [s, h] of VEC) check(`sha256(${JSON.stringify(s).slice(0, 12)}) native and portable = the vector`, sha256(s) === h && sha256Portable(s) === h);
for (const s of ["é ☃ 𝄞 \u0000 ", "x".repeat(1000), JSON.stringify({ a: [1, 2.5, "ü"] })])
  check(`sha256 native = portable on ${JSON.stringify(s).slice(0, 16)}`, sha256(s) === sha256Portable(s));
check("utf8Hex = Buffer hex", utf8Hex("é☃𝄞a-") === Buffer.from("é☃𝄞a-", "utf8").toString("hex"));
check("the native path is the one in use under bun", typeof (globalThis as any).Bun !== "undefined" && sha256 !== sha256Portable);

// ---- 2. the engine's name is its exact build ----
const build = sha256(EIDOSIM_FILES.map((f: string) => fs.readFileSync(ENGINE + f, "utf8")).join("\0")).slice(0, 16);
check("EIDOSIM_BUILD names the sim files in this checkout (change them → a new engine name)", build === EIDOSIM_BUILD, `${build} vs ${EIDOSIM_BUILD}`);

// ---- 3. her dialect-3 fixtures through translate-d3 ----
const golden = JSON.parse(fs.readFileSync(ENGINE + "spec/fixtures/replay/.replaybench.json", "utf8"));
for (const name of Object.keys(golden)) {
  const old = parse(fs.readFileSync(ENGINE + `spec/fixtures/replay/${name}/log.jsonl`, "utf8"));
  const st0 = v1Empty(), s0 = eidosim.emptySim();
  for (const e of old) { foldEntry(st0, e); eidosim.simEntry(s0, e, st0); }
  eidosim.advanceSim(s0, s0.tick + 100_000);
  const { tick: _t, ...norm } = eidosim.simSnapshot(s0) as Record<string, unknown>;
  check(`${name}: her sim golden reproduces`, sha256(JSON.stringify(norm)).slice(0, 16) === golden[name].simDigest);
  const r = translateD3(old), r2 = translateD3(old);
  check(`${name}: 0 divergences (world ${r.stats.worldDivergences}, flight ${r.stats.flightDivergences})`, !r.stats.worldDivergences && !r.stats.flightDivergences, JSON.stringify(r.stats.first));
  check(`${name}: every punt a launch, every launch a rest`, r.stats.launches > 0 && r.stats.launches === r.stats.rests, `${r.stats.launches}/${r.stats.rests}`);
  check(`${name}: deterministic`, sha256(text(r.out)) === sha256(text(r2.out)));
  const back = replica(readLog(text(r.out)));
  check(`${name}: strict read-back ok, 0 malformed`, back.status === "ok" && !back.diagnostics.some(([, k]: any) => k.startsWith("malformed")), JSON.stringify(back.diagnostics.filter(([, k]: any) => k.startsWith("malformed")).slice(0, 3)));
  const where = Object.entries(s0.bodies).every(([id, b]: [string, any]) => c(back.entities?.[id]?.c.transform.pos) === c(b.p));
  check(`${name}: with no engine at all, everything rests where hers rests`, where);
  // re-checked as the live host runs the sim layer (server/livehost.ts, the replica: no catalogue of its own, geometry only
  // through physics.shape): the digest each rest carries covers the engine's boxes table, so it is the live one's
  const sf = simFold(readLog(text(r.out)), Math.max(...r.out.map((e: any) => e.ts ?? 0)), { models: {} });
  check(`${name}: a carrier re-checks every rest`, sf.checks.agree === r.stats.rests && !sf.checks.disagree.length, JSON.stringify(sf.checks).slice(0, 200));
}

// ---- 4. every local world log through translate-v1 ----
// The inverse, written independently of translate-v1's project(): components → the old fold's field names.
const yq = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const LIGHT_KEYS = ["color", "intensity", "range", "keep", "day"];
const dec = (s: string) => (s.startsWith("x--") ? Buffer.from(s.slice(3), "hex").toString("utf8") : s); // h--: a hash, not invertible; a mismatch shows
const DROP_ENTITY = ["actor", "ts", "born", "placer"]; // DROPPED: entity.actor / entity.ts, entity.born, placer
const DROP_WORLD = ["entities", "mounts", "recentChat", "chatTotal"]; // DROPPED: mounts, recentChat / chatTotal
// translate-v1@2 (slice 3a): a riding thing's pose is where the RENDERER puts it, read here through shared/hierarchy.js
// localOf (the client's own reading, not the translator's rideOf): offset, else its socket's pos; parent.q, else yaw,
// else the socket's yaw. Its own v1 pos/yaw/q while it rides are DROPPED ("a mounted thing's own pos/yaw/q"), and the
// parent keeps {to, slot?} plus anything that isn't pose. A v1 guard is a lock (DROPPED "comp.guard").
const POSE = new Set(["offset", "yaw", "q"]);
// v1's parent.slot is today's parent.socket: shared/hierarchy.js (the renderer's reading) speaks the protocol
const asSocketParent = (e: any) => (e?.parent && "slot" in e.parent ? { ...e, parent: (({ slot, ...p }) => ({ ...p, socket: slot }))(e.parent) } : e);
const v1Shim = (ents: any) => (ents ? Object.fromEntries(Object.entries<any>(ents).map(([k, e]) => [k, asSocketParent(e)])) : ents);   // per call: the v1 fold mutates its state in place
// A physics-epoch log (translate-v1@10): the old world is her instant fold COMPOSED with her sim, so the reference here
// runs her sim beside the v1 fold (independently of the translator's bookkeeping): a body stands where it last came to
// rest in her sim while her sim still holds it (resting, or flying again), and a thing whose lib has a box in her sim's
// stamped table carries that box as physics.shape. Declared: the epoch is @world physics-engine {engine, build, tickMs};
// its ts and seq are where its change entry stands in the new log, and build is the authority's engine stamp.
function oldNorm(st: any, phys: any = null) {
  const ents: any = {}; let shim: any = null;
  for (const [id, e0] of Object.entries<any>(st.entities ?? {})) {
    const e: any = {};
    for (const [k, v] of Object.entries<any>(e0)) if (!DROP_ENTITY.includes(k)) e[k] = v;
    const L = e0.parent ? localOf(asSocketParent(e0), (shim ??= v1Shim(st.entities))) : null;   // hierarchy.js reads parent.socket
    if (L?.mounted) { e.pos = L.pos; e.q = L.q ?? yq(L.yaw); delete e.yaw; }
    if (e.parent && typeof e.parent.to === "string") e.parent = Object.fromEntries(Object.entries<any>(e.parent).filter(([k]) => !POSE.has(k)));
    if (e.comp && "guard" in e.comp) { const { guard, ...cc } = e.comp; e.comp = cc; if (guard && !cc.lock) e.comp.lock = true; }
    const { yaw, q, scale, pos, ...rest } = e;
    const n: any = { ...rest, pos: pos ?? [0, 0, 0], q: Array.isArray(q) ? q : yq(yaw ?? 0), scale: typeof scale === "number" ? [scale, scale, scale] : (scale ?? [1, 1, 1]) };
    if (rest.kind === "light") { const L: any = {}; for (const f of LIGHT_KEYS) if (rest[f] !== undefined) { L[f] = rest[f]; delete n[f]; } delete n.kind; n.comp = { ...(n.comp ?? {}), light: L }; }
    // declared (translate-v1@7): v1's light keep is today's light.important
    if (n.comp?.light && typeof n.comp.light === "object" && "keep" in n.comp.light) { const { keep, ...l } = n.comp.light; n.comp.light = { ...l, important: keep }; }
    // declared: a socket's yaw is its rotation about up, written as q (a zero yaw is no rotation)
    if (n.comp?.sockets && typeof n.comp.sockets === "object") n.comp.sockets = Object.fromEntries(Object.entries<any>(n.comp.sockets).map(([k, s]) => {
      if (!s || typeof s !== "object" || !("yaw" in s)) return [k, s]; const { yaw, ...r } = s;
      return [k, Number.isFinite(yaw) && yaw !== 0 ? { ...r, q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] } : (Number.isFinite(yaw) ? r : s)]; }));
    if (n.comp?.light && "color" in n.comp.light) n.comp.light = { ...n.comp.light, color: hexColor(n.comp.light.color) };   // declared: "#fff" → 0xffffff
    // declared (translate-v1@5 DROPPED motion.rpm): a spin's rpm is degPerSec = rpm × 6 (degPerSec wins when both were written)
    if (n.comp) for (const [k, m] of Object.entries<any>(n.comp)) if ((k === "motion" || k.startsWith("motion:")) && m && typeof m === "object" && "rpm" in m) {
      const { rpm, ...r } = m; n.comp[k] = r.degPerSec !== undefined || typeof rpm !== "number" ? r : { ...r, degPerSec: rpm * 6 }; }
    if (phys?.restAt[id]) n.pos = phys.restAt[id].slice();
    if (phys?.sim.boxes && typeof e0.lib === "string" && phys.sim.boxes[e0.lib]) n.comp = { ...(n.comp ?? {}), physics: { shape: phys.sim.boxes[e0.lib] } };
    if (n.comp && !Object.keys(n.comp).length) delete n.comp;
    ents[id] = n;
  }
  const world: any = {};
  for (const [k, v] of Object.entries<any>(st)) { if (DROP_WORLD.includes(k) || v == null) continue;
    if (Array.isArray(v) && !v.length) continue; if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue; world[k] = v; }
  // dropped on purpose by translate-v1 (round-2 R8): the sky's echo of who set it and when (the log says so itself)
  if (world.sky && typeof world.sky === "object") { const { seq, by, ...sky } = world.sky;
    if (sky.forecast && typeof sky.forecast === "object") { const { seq: _s, by: _b, ...fc } = sky.forecast; sky.forecast = fc; }
    world.sky = sky; }
  if (phys && world.epoch) world.epoch = { sim: world.epoch.sim, tickMs: world.epoch.tickMs };
  return { ents, world };
}
// today's body socket is v1's seat (translate-v1's sockets mapping)
function v1Sockets(S: any, left: any) {
  if (!S || typeof S !== "object") return S; const out: any = {};
  for (const [slot, s] of Object.entries<any>(S)) { if (!s || typeof s !== "object") { out[slot] = s; continue; }
    const { body, ...r } = s; out[slot] = { ...r, ...(body?.pose !== undefined ? { pose: body.pose } : {}), ...(left?.[slot] ?? {}) }; }
  return out;
}
// today's angular impulse is v1's {impulse: x} (translate-v1's reactions mapping)
function v1Reactions(rx: any) {
  if (!rx || typeof rx !== "object") return rx; const out: any = {};
  for (const [k, h] of Object.entries<any>(rx)) out[k] = h?.kind === "impulse" && typeof h.angular === "number" ? (({ kind, angular, ...r }) => ({ ...r, impulse: angular }))(h) : h?.component === "openable" ? { ...h, component: "door" } : h;
  return out;
}
// v1's fly and gen grants are the fly and generate permissions now (translate-v1 toCan, @4/@7): read back as v1 wrote them
function fromCan(v: any) { if (!v || typeof v !== "object" || !v.can || typeof v.can !== "object") return v;
  const { can, ...rest } = v; const { fly, generate, ...left } = can; const out: any = { ...rest };
  if (fly === true) out.fly = true; if (generate === true) out.gen = true; if (Object.keys(left).length) out.can = left; return out; }
const IMP = "imported:", BANS = "imported-bans:", BEHAVIOR = "imported-behavior:";   // what translate-v1 carries (@7)
const NSP = "imported/";   // @8: a v1 world's own (unregistered) component comes across as imported/<name> (PROTOCOL §4)
function unproject(ents0: any) {
  const ents: any = {}, world: any = {};
  for (const [id, comps] of Object.entries<any>(ents0)) {
    if (id === "@world") {
      for (const [k, v] of Object.entries<any>(comps)) {
        if (["sky", "terrain", "grass"].includes(k)) world[k] = v;
        else if (k === "imported-epoch") world.epoch = v;
        else if (k === "physics-engine") world.epoch = { sim: v.engine, tickMs: v.tickMs };   // translate-v1@10: a dialect-3 epoch
        else if (k.startsWith("assets:")) (world.assets ??= []).push(Object.keys(v).length ? v : dec(k.slice("assets:".length)));
        else if (k === "default-role") (world.roles ??= {})["*"] = fromCan(v); // DROPPED: roles['*']
        else if (k.startsWith("roles:")) (world.roles ??= {})[dec(k.slice(6))] = fromCan(v);
        else if (k.startsWith(BANS)) (world.bans ??= {})[dec(k.slice(BANS.length))] = v;
        else if (k.startsWith(BEHAVIOR)) (world.behaviors ??= {})[dec(k.slice(BEHAVIOR.length))] = v;
        else if (k.startsWith(IMP) && ["sky", "terrain", "grass", "epoch"].includes(dec(k.slice(IMP.length)))) {}   // folded back below
        else if (k.startsWith(IMP)) world[dec(k.slice(IMP.length))] = v;
        else world[`??${k}`] = v;
      }
      // a closed component's v1 leftovers ride beside it as imported:<component> {key: value}: they fold back in
      for (const c of ["sky", "terrain", "grass", "epoch"]) if (comps[`${IMP}${c}`] && world[c] && typeof world[c] === "object") world[c] = { ...world[c], ...comps[`${IMP}${c}`] };
      continue;
    }
    const e: any = {};
    for (const [k, v] of Object.entries<any>(comps)) {
      if (k === "transform") { e.pos = v.pos; e.q = v.q; e.scale = v.scale; }
      else if (k === "model") e.lib = v;
      else if (k === "parent") e.parent = typeof v?.to === "string" ? (({ order, socket, ...p }) => ({ ...p, to: dec(v.to), ...(socket !== undefined ? { slot: socket } : {}) }))(v) : v; // order: today's sibling order, no v1 field; today's socket is v1's slot
      else if (k.startsWith(IMP) && comps[dec(k.slice(IMP.length))] !== undefined && dec(k.slice(IMP.length)) !== "parent") {}   // folded back below
      else if (k.startsWith(IMP)) e[dec(k.slice(IMP.length))] = v;
      else (e.comp ??= {})[k === "openable" ? "door" : dec(k.startsWith(NSP) ? k.slice(NSP.length) : k)] = k === "reactions" ? v1Reactions(v) : k === "sockets" ? v1Sockets(v, comps[`${IMP}sockets`]) : v;   // declared (DROPPED comp.door): today's openable is v1's door
    }
    for (const [k, v] of Object.entries<any>(comps)) { const c = k.startsWith(IMP) ? dec(k.slice(IMP.length)) : null;
      if (c && comps[c] !== undefined && c !== "parent" && c !== "sockets") e.comp[c] = { ...e.comp[c], ...v }; }
    // translate-v1@9: a v1 particles bag became {effect, seed?, at?, params?}: read back in v1's spelling (preset, origin, and
    // each param at the top, as v1 held them)
    const pt = e.comp?.particles; if (pt && typeof pt === "object" && !Array.isArray(pt) && "effect" in pt) {
      const { effect, at, params, ...r } = pt; e.comp.particles = { ...r, preset: effect, ...(at !== undefined ? { origin: at } : {}), ...(params ?? {}) }; }
    // translate-v1@5: a v1 story's practice became a paragraph of its text and its markedEntity its marks (both also in
    // imported:story, folded back above): undone here, so the comparison is with what v1 held
    const sty = e.comp?.story; if (sty && typeof sty === "object" && !Array.isArray(sty)) {
      if (typeof sty.practice === "string" && typeof sty.text === "string") { const p = sty.practice.trim(); if (sty.text === p) delete sty.text; else if (sty.text.endsWith(`\n\n${p}`)) sty.text = sty.text.slice(0, -(p.length + 2)); }
      if (typeof sty.markedEntity === "string" && Array.isArray(sty.marks)) delete sty.marks; }
    ents[dec(id)] = e;
  }
  return { ents, world };
}
function lossAt(oldSt: any, st: any, phys: any = null) {
  const a = oldNorm(oldSt, phys), b = unproject(Object.fromEntries(Object.keys(st.entities).map((id) => [id, st.entities[id].c])));
  if (c(a) === c(b)) return null;
  for (const id of new Set([...Object.keys(a.ents), ...Object.keys(b.ents)])) if (c(a.ents[id]) !== c(b.ents[id])) return { id, old: a.ents[id], now: b.ents[id] };
  for (const k of new Set([...Object.keys(a.world), ...Object.keys(b.world)])) if (c(a.world[k]) !== c(b.world[k])) return { world: k, old: a.world[k], now: b.world[k] };
  return { other: true };
}

const roots = (process.env.PROTOCOL_WORLDS ?? path.resolve(ENGINE, "..")).split(":");
const logs: string[] = [];
const walk = (d: string, depth = 0) => { if (depth > 5) return; let ents: string[] = []; try { ents = fs.readdirSync(d); } catch { return; }
  for (const n of ents) { if (n === "node_modules" || n === ".git") continue; const p = path.join(d, n);
    if (n === "log.jsonl") logs.push(p); else { try { if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } catch {} } } };
for (const r of roots) walk(r);
const seen = new Set<string>(); let total = 0, entries = 0, divergences = 0, malformed = 0, lossy = 0, renamed = 0, clamped = 0, guards = 0, guardWorlds = 0, mounted = 0, mountVerbs = 0; const t0 = performance.now();
for (const p of logs.sort()) {
  const raw = fs.readFileSync(p, "utf8"); const h = sha256(raw); if (seen.has(h) || !raw.trim()) continue; seen.add(h);
  const L = parse(raw); const name = p.replace(path.resolve(ENGINE, "..") + "/", "");
  let r: any; try { r = translateV1(L); } catch (e: any) { check(`${name}: translates without throwing`, false, e.message); continue; }
  total++; entries += L.length; divergences += r.stats.divergences; renamed += r.stats.renamed ?? 0; clamped += r.stats.tsClamped ?? 0;
  guards += r.stats.guards; if (r.stats.guards) guardWorlds++; mounted += Object.values<any>(r.final.translated).filter((c) => c.parent).length; mountVerbs += r.stats.verbs.mount ?? 0;
  check(`${name} (${L.length}): 0 divergences`, !r.stats.divergences, JSON.stringify(r.stats.firstDivergence));
  const back = replica(readLog(text(r.out)));
  const m = back.diagnostics.filter(([, k]: any) => k.startsWith("malformed")); malformed += m.length;
  check(`${name}: strict read-back ok, 0 malformed`, back.status === "ok" && !m.length, JSON.stringify(m.slice(0, 3)));
  check(`${name}: the read-back fold equals the translator's final projection`, back.status === "ok" && c(Object.fromEntries(Object.keys(back.entities).map((id) => [id, back.entities[id].c]))) === c(r.final.v1));
  // the inverse, aligned by act: the k-th act/say in the log is the k-th non-genesis old entry
  const body = L.filter((e: any) => e.verb !== "genesis"); const every = body.length > 2000 ? 250 : 1;
  const v1 = v1Empty(); const now = emptyState(); let k = -1, loss: any = null;
  const phys: any = hasEpoch(L) ? { sim: eidosim.emptySim(), restAt: {} } : null;
  const settle = (tick: number) => { if (!phys?.sim.epoch) return; eidosim.advanceSim(phys.sim, tick);   // schedule-independent: one jump is exact
    for (const [id, b] of Object.entries<any>(phys.sim.bodies)) if (b.resting) phys.restAt[id] = b.p.slice();
    for (const id of Object.keys(phys.restAt)) if (!phys.sim.bodies[id]) delete phys.restAt[id]; };
  const compareAt = (i: number) => { if (loss || i < 0) return; if (i % every && i !== body.length - 1) return; const x = lossAt(v1, now, phys); if (x) loss = { oldSeq: body[i].seq, ...x }; };
  for (let s = 1; s < r.out.length && !loss; s++) { const e = r.out[s];
    if ((e.kind === "act" && e.verb !== "translated") || e.kind === "say") { // `translated` (genesis's companion, translate-v1@3) has no old entry
      if (phys && Number.isInteger(body[k + 1]?.ts)) settle(eidosim.tickOf(phys.sim, body[k + 1].ts));   // her rests up to the next act are logged before it
      compareAt(k); k++; foldEntry(v1, body[k]); if (phys) { eidosim.simEntry(phys.sim, body[k], v1); settle(phys.sim.tick); } }
    else if (e.kind === "change") applyInPlace(now, opsOf(e), s); }
  if (phys?.sim.epoch && !phys.sim.epoch.foreign) settle(phys.sim.tick + 100_000);   // the translator settles at the end, as her replaybench does
  compareAt(k); if (loss) lossy++;
  // the authority takes the translated world as it is: every component of every thing passes the catalogue (a v1 key a
  // closed component doesn't define rides beside it as imported:<component>, so nothing is refused at the first edit)
  { const bad: string[] = []; for (const [id, comps] of Object.entries<any>(r.final.translated)) for (const [k, v] of Object.entries<any>(comps)) {
      const why = schemaRefusal(k, v); if (why) bad.push(`${id}.${k}: ${why}`); }
    check(`${name}: the authority's catalogue takes every translated component as it is`, !bad.length, bad.slice(0, 4)); }
  check(`${name}: the projection loses nothing (independent inverse vs the engine fold${every > 1 ? `, every ${every}` : ", every entry"})`, !loss, JSON.stringify(loss).slice(0, 400));
}
console.log(`[sweep] ${total} distinct world logs, ${entries} entries, divergences ${divergences}, malformed-on-read-back ${malformed}, lossy ${lossy}, renamed actors ${renamed}, ts clamped ${clamped}, ${Math.round(performance.now() - t0)} ms`);
console.log(`[sweep] translate-v1@2: ${mountVerbs} v1 mounts translated; ${mounted} things ride a parent at the end (door-shaped: transform local, parent {to, order, socket?}); ${guards} guards became locks in ${guardWorlds} world(s)`);
console.log(`[sweep] DROPPED (by design): ${Object.keys(DROPPED).join("; ")}`);
console.log(`[sweep] ${pass} passed, ${fail} failed`);
process.exit(fail || !total ? 1 : 0);
