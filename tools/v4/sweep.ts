// tools/v4/sweep.ts — the translators against real logs, and the pins the core relies on.
//   bun tools/v4/sweep.ts                  # every distinct log.jsonl under the checkout's parent directory
//   V4_WORLDS=<dir>[:<dir>…] bun tools/v4/sweep.ts
// Required, for every distinct world log found:
//   - translate-v1: 0 divergences (the v4 fold agrees with the projection of the engine's own fold after EVERY
//     entry — the translator checks this itself);
//   - the written v4 log, re-read from text by the strict reader alone: status ok, 0 malformed, and its fold equals
//     the translator's final projection;
//   - the projection loses nothing: an independent inverse (v4 components → old field names), compared with the
//     REAL engine fold, entry by entry (every 250th past 2,000 entries), aligned by act. Only representation is
//     normalised (yaw ↔ q, scalar scale ↔ vector, light spelling) and only translate-v1's DROPPED list may differ.
//     (Kept from the phase-1 test, b05715f9: the lab sweep had no such check. Without it a translator that silently
//     dropped grass passed.)
// Plus: her four dialect-3 fixtures through translate-d3 (her goldens reproduce; 0 world/flight divergences; every
// launch rests where hers rests, re-checked by a carrier; deterministic; strict read-back clean); the sim build pin;
// the hash shim (native = portable = the reference vectors).
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./common.ts";
import { sha256, sha256Portable, utf8Hex } from "../../shared/v4/hash.js";
import { readLog, fold as v4fold, opsOf, applyInPlace, emptyState as v4Empty } from "../../shared/v4/fold.js";
import { translate as translateV1, DROPPED } from "../../shared/v4/translate-v1.js";
import { translate as translateD3 } from "../../shared/v4/translate-d3.js";
import { simFold, EIDOSIM_BUILD, EIDOSIM_FILES } from "../../shared/v4/simlayer.js";
import { emptyState as v1Empty, foldEntry } from "../../shared/fold.js";
import * as eidosim from "../../shared/sim.js";

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
  const back = v4fold(readLog(text(r.out)));
  check(`${name}: strict read-back ok, 0 malformed`, back.status === "ok" && !back.diagnostics.some(([, k]: any) => k.startsWith("malformed")), JSON.stringify(back.diagnostics.filter(([, k]: any) => k.startsWith("malformed")).slice(0, 3)));
  const where = Object.entries(s0.bodies).every(([id, b]: [string, any]) => c(back.entities?.[id]?.c.transform.pos) === c(b.p));
  check(`${name}: with no engine at all, everything rests where hers rests`, where);
  const sf = simFold(readLog(text(r.out)), Math.max(...r.out.map((e: any) => e.ts ?? 0)));
  check(`${name}: a carrier re-checks every rest`, sf.checks.agree === r.stats.rests && !sf.checks.disagree.length, JSON.stringify(sf.checks).slice(0, 200));
}

// ---- 4. every local world log through translate-v1 ----
// The inverse, written independently of translate-v1's project(): v4 components → the old fold's field names.
const yq = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const LIGHT_KEYS = ["color", "intensity", "range", "keep", "day"];
const dec = (s: string) => (s.startsWith("x--") ? Buffer.from(s.slice(3), "hex").toString("utf8") : s); // h--: a hash, not invertible; a mismatch shows
const DROP_ENTITY = ["actor", "ts", "born", "placer"]; // DROPPED: entity.actor / entity.ts, entity.born, placer
const DROP_WORLD = ["entities", "mounts", "recentChat", "chatTotal"]; // DROPPED: mounts, recentChat / chatTotal
function oldNorm(st: any) {
  const ents: any = {};
  for (const [id, e0] of Object.entries<any>(st.entities ?? {})) {
    const e: any = {};
    for (const [k, v] of Object.entries<any>(e0)) if (!DROP_ENTITY.includes(k)) e[k] = v;
    const { yaw, q, scale, pos, ...rest } = e;
    const n: any = { ...rest, pos: pos ?? [0, 0, 0], q: Array.isArray(q) ? q : yq(yaw ?? 0), scale: typeof scale === "number" ? [scale, scale, scale] : (scale ?? [1, 1, 1]) };
    if (rest.kind === "light") { const L: any = {}; for (const f of LIGHT_KEYS) if (rest[f] !== undefined) { L[f] = rest[f]; delete n[f]; } delete n.kind; n.comp = { ...(n.comp ?? {}), light: L }; }
    if (n.comp && !Object.keys(n.comp).length) delete n.comp;
    ents[id] = n;
  }
  const world: any = {};
  for (const [k, v] of Object.entries<any>(st)) { if (DROP_WORLD.includes(k) || v == null) continue;
    if (Array.isArray(v) && !v.length) continue; if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue; world[k] = v; }
  return { ents, world };
}
function unproject(v4: any) {
  const ents: any = {}, world: any = {};
  for (const [id, comps] of Object.entries<any>(v4)) {
    if (id === "@world") {
      for (const [k, v] of Object.entries<any>(comps)) {
        if (["sky", "terrain", "grass", "epoch"].includes(k)) world[k] = v;
        else if (k.startsWith("palette:")) (world.assets ??= []).push(Object.keys(v).length ? v : dec(k.slice(8)));
        else if (k === "default-role") (world.roles ??= {})["*"] = v; // DROPPED: roles['*']
        else if (k.startsWith("roles:")) (world.roles ??= {})[dec(k.slice(6))] = v;
        else if (k.startsWith("bans:")) (world.bans ??= {})[dec(k.slice(5))] = v;
        else if (k.startsWith("behavior:")) (world.behaviors ??= {})[dec(k.slice(9))] = v;
        else if (k.startsWith("legacy:")) world[dec(k.slice(7))] = v;
        else world[`??${k}`] = v;
      }
      continue;
    }
    const e: any = {};
    for (const [k, v] of Object.entries<any>(comps)) {
      if (k === "transform") { e.pos = v.pos; e.q = v.q; e.scale = v.scale; }
      else if (k === "model") e.lib = v;
      else if (k === "parent") e.parent = typeof v?.to === "string" ? { ...v, to: dec(v.to) } : v;
      else if (k.startsWith("legacy:")) e[dec(k.slice(7))] = v;
      else (e.comp ??= {})[dec(k)] = v;
    }
    ents[dec(id)] = e;
  }
  return { ents, world };
}
function lossAt(oldSt: any, v4st: any) {
  const a = oldNorm(oldSt), b = unproject(Object.fromEntries(Object.keys(v4st.entities).map((id) => [id, v4st.entities[id].c])));
  if (c(a) === c(b)) return null;
  for (const id of new Set([...Object.keys(a.ents), ...Object.keys(b.ents)])) if (c(a.ents[id]) !== c(b.ents[id])) return { id, old: a.ents[id], v4: b.ents[id] };
  for (const k of new Set([...Object.keys(a.world), ...Object.keys(b.world)])) if (c(a.world[k]) !== c(b.world[k])) return { world: k, old: a.world[k], v4: b.world[k] };
  return { other: true };
}

const roots = (process.env.V4_WORLDS ?? path.resolve(ENGINE, "..")).split(":");
const logs: string[] = [];
const walk = (d: string, depth = 0) => { if (depth > 5) return; let ents: string[] = []; try { ents = fs.readdirSync(d); } catch { return; }
  for (const n of ents) { if (n === "node_modules" || n === ".git") continue; const p = path.join(d, n);
    if (n === "log.jsonl") logs.push(p); else { try { if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } catch {} } } };
for (const r of roots) walk(r);
const seen = new Set<string>(); let total = 0, entries = 0, divergences = 0, malformed = 0, lossy = 0, renamed = 0, clamped = 0; const t0 = performance.now();
for (const p of logs.sort()) {
  const raw = fs.readFileSync(p, "utf8"); const h = sha256(raw); if (seen.has(h) || !raw.trim()) continue; seen.add(h);
  const L = parse(raw); const name = p.replace(path.resolve(ENGINE, "..") + "/", "");
  let r: any; try { r = translateV1(L); } catch (e: any) { check(`${name}: translates without throwing`, false, e.message); continue; }
  total++; entries += L.length; divergences += r.stats.divergences; renamed += r.stats.renamed ?? 0; clamped += r.stats.tsClamped ?? 0;
  check(`${name} (${L.length}): 0 divergences`, !r.stats.divergences, JSON.stringify(r.stats.firstDivergence));
  const back = v4fold(readLog(text(r.out)));
  const m = back.diagnostics.filter(([, k]: any) => k.startsWith("malformed")); malformed += m.length;
  check(`${name}: strict read-back ok, 0 malformed`, back.status === "ok" && !m.length, JSON.stringify(m.slice(0, 3)));
  check(`${name}: the read-back fold equals the translator's final projection`, back.status === "ok" && c(Object.fromEntries(Object.keys(back.entities).map((id) => [id, back.entities[id].c]))) === c(r.final.v1));
  // the inverse, aligned by act: the k-th act/say in the v4 log is the k-th non-genesis old entry
  const body = L.filter((e: any) => e.verb !== "genesis"); const every = body.length > 2000 ? 250 : 1;
  const v1 = v1Empty(); const v4 = v4Empty(); let k = -1, loss: any = null;
  const compareAt = (i: number) => { if (loss || i < 0) return; if (i % every && i !== body.length - 1) return; const x = lossAt(v1, v4); if (x) loss = { oldSeq: body[i].seq, ...x }; };
  for (let s = 1; s < r.out.length && !loss; s++) { const e = r.out[s];
    if (e.kind === "act" || e.kind === "say") { compareAt(k); k++; foldEntry(v1, body[k]); }
    else if (e.kind === "state") applyInPlace(v4, opsOf(e), s); }
  compareAt(k); if (loss) lossy++;
  check(`${name}: the projection loses nothing (independent inverse vs the engine fold${every > 1 ? `, every ${every}` : ", every entry"})`, !loss, JSON.stringify(loss).slice(0, 400));
}
console.log(`[sweep] ${total} distinct world logs, ${entries} entries, divergences ${divergences}, malformed-on-read-back ${malformed}, lossy ${lossy}, renamed actors ${renamed}, ts clamped ${clamped}, ${Math.round(performance.now() - t0)} ms`);
console.log(`[sweep] DROPPED (by design): ${Object.keys(DROPPED).join("; ")}`);
console.log(`[sweep] ${pass} passed, ${fail} failed`);
process.exit(fail || !total ? 1 : 0);
