// tools/v4-test.ts — protocol v4, Phase 1 (shadow): the translator against every log this checkout can find.
//   bun tools/v4-test.ts            # fixtures + local worlds
//   V4_WORLDS=<glob root> bun tools/v4-test.ts
// Required: 0 divergences at every entry of every log; her dialect-3 fixtures translate with every rest where hers
// rests and every rest re-checked by a carrier; the engine build hash names exactly the sim files in this checkout.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Translator } from "../shared/v4/translate.js";
import { simFold, EIDOSIM_BUILD } from "../shared/v4/simlayer.js";
import { fold as v4fold } from "../shared/v4/fold.js";
import { emptyState, foldEntry } from "../shared/fold.js";
import * as eidosim from "../shared/sim.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } };
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const parse = (raw: string) => raw.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

// 1. the engine's name is its exact build
const files = ["shared/sim.js", "shared/simmath.js", "shared/terrainmath.js"].map((f) => readFileSync(f));
check("EIDOSIM_BUILD names the sim files in this checkout (change them → a new engine name)", sha(files.join("\0")).slice(0, 16) === EIDOSIM_BUILD, EIDOSIM_BUILD);

// 2. her dialect-3 fixtures
const golden = JSON.parse(readFileSync("spec/fixtures/replay/.replaybench.json", "utf8"));
for (const name of Object.keys(golden)) {
  const old = parse(readFileSync(`spec/fixtures/replay/${name}/log.jsonl`, "utf8"));
  const st = emptyState(), sim = eidosim.emptySim();
  for (const e of old) { foldEntry(st, e); eidosim.simEntry(sim, e, st); }
  eidosim.advanceSim(sim, sim.tick + 100_000);
  const { tick: _t, ...norm } = eidosim.simSnapshot(sim) as Record<string, unknown>;
  check(`${name}: her sim golden reproduces`, sha(JSON.stringify(norm)).slice(0, 16) === golden[name].simDigest);
  const t = new Translator(); for (const e of old) t.push(e); const s = t.finish();
  check(`${name}: 0 divergences (world ${s.worldDivergences}, flight ${s.flightDivergences})`, !s.worldDivergences && !s.flightDivergences, JSON.stringify(s.first));
  check(`${name}: every punt a launch, every launch a rest`, s.launches > 0 && s.launches === s.rests, `${s.launches}/${s.rests}`);
  const blind = v4fold(t.out, () => null);
  const where = Object.entries(sim.bodies).every(([id, b]: [string, any]) => JSON.stringify(blind.entities[id]?.c.transform.pos) === JSON.stringify(b.p));
  check(`${name}: with no engine at all, everything rests where hers rests`, where);
  const sf = simFold(t.out, () => null, t.out.at(-1).ts);
  check(`${name}: a carrier re-checks every rest`, sf.checks.agree === s.rests && !sf.checks.disagree.length, JSON.stringify(sf.checks));
  const t2 = new Translator(); for (const e of old) t2.push(e); t2.finish();
  check(`${name}: deterministic`, sha(JSON.stringify(t.out)) === sha(JSON.stringify(t2.out)));
}

// The translator check above proves the v4 log reproduces the PROJECTION. This proves the projection loses nothing:
// an inverse written independently (v4 components → old field names), compared with the REAL old fold. Only
// representation is normalised (yaw ↔ q, scalar scale ↔ vector); only the documented DROPPED fields may differ.
const yq = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const LIGHT_KEYS = ["color", "intensity", "range", "keep", "day"];
function oldNorm(st: any) {
  const ents: any = {};
  for (const [id, e0] of Object.entries<any>(st.entities ?? {})) {
    const { actor: _a, ts: _t, born: _b, yaw, q, scale, pos, ...rest } = e0;
    ents[id] = { ...rest, pos: pos ?? [0, 0, 0], q: Array.isArray(q) ? q : yq(yaw ?? 0),
      scale: typeof scale === "number" ? [scale, scale, scale] : (scale ?? [1, 1, 1]) };
    if (rest.kind === "light") { // one Light, two spellings (DROPPED "light spelling"): compare as the component
      const L: any = {}; for (const f of LIGHT_KEYS) if (rest[f] !== undefined) { L[f] = rest[f]; delete ents[id][f]; }
      delete ents[id].kind; ents[id].comp = { ...(ents[id].comp ?? {}), light: L }; }
    if (ents[id].comp && !Object.keys(ents[id].comp).length) delete ents[id].comp;
  }
  const { entities: _e, mounts: _m, recentChat: _r, chatTotal: _c, epoch, ...w } = st;
  const world: any = {};
  for (const [k, v] of Object.entries<any>(w)) { if (v == null) continue; if (Array.isArray(v) && !v.length) continue; if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue; world[k] = v; }
  if (epoch) world.epoch = { sim: epoch.sim, tickMs: epoch.tickMs };
  return { ents, world };
}
function unproject(v4: any) {
  const ents: any = {}, world: any = {};
  for (const [id, c] of Object.entries<any>(v4)) {
    if (id === "@world") {
      for (const [k, v] of Object.entries<any>(c)) {
        if (["sky", "terrain", "grass"].includes(k)) world[k] = v;
        else if (k.startsWith("palette:")) (world.assets ??= []).push(Object.keys(v).length ? v : k.slice(8));
        else if (k.startsWith("roles:")) (world.roles ??= {})[k.slice(6)] = v;
        else if (k.startsWith("bans:")) (world.bans ??= {})[k.slice(5)] = v;
        else if (k.startsWith("behavior:")) (world.behaviors ??= {})[k.slice(9)] = v;
        else if (k.startsWith("legacy:")) world[k.slice(7)] = v;
        else if (k === "sim") world.epoch = { sim: v.engine, tickMs: v.tickMs };
        else world[`??${k}`] = v;
      }
      continue;
    }
    const e: any = {};
    for (const [k, v] of Object.entries<any>(c)) {
      if (k === "transform") { e.pos = v.pos; e.q = v.q; e.scale = v.scale; }
      else if (k === "model") e.lib = v;
      else if (k === "parent") e.parent = v;
      else if (k === "placer") e.placer = { id: v.who, ...(v.sub ? { sub: v.sub } : {}) };
      else if (k.startsWith("legacy:")) e[k.slice(7)] = v;
      else if (k === "physics") continue; // derived from the sim's stamped boxes, not an old entity field
      else (e.comp ??= {})[k] = v;
    }
    ents[id] = e;
  }
  return { ents, world };
}
function lossless(t: any, oldSt: any) {
  const v4view = Object.fromEntries(Object.entries<any>(t.v4.entities).map(([id, x]) => [id, x.c]));
  const a = oldNorm(oldSt), b = unproject(v4view);
  for (const [id, e] of Object.entries<any>(t.sim?.bodies ?? {})) if (a.ents[id] && t.recorded?.has(id)) a.ents[id].pos = t.recorded.get(id); // logged rests are the v4 word
  const c = (o: any) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
  if (c(a) === c(b)) return null;
  for (const id of new Set([...Object.keys(a.ents), ...Object.keys(b.ents)])) if (c(a.ents[id]) !== c(b.ents[id])) return { id, old: a.ents[id], v4: b.ents[id] };
  for (const k of new Set([...Object.keys(a.world), ...Object.keys(b.world)])) if (c(a.world[k]) !== c(b.world[k])) return { world: k, old: a.world[k], v4: b.world[k] };
  return { other: true };
}

// 3. every distinct world log on this machine
const roots = (process.env.V4_WORLDS ?? "/home/claude/eido").split(":");
const logs: string[] = [];
const walk = (d: string, depth = 0) => { if (depth > 5) return; let ents: string[] = []; try { ents = readdirSync(d); } catch { return; }
  for (const n of ents) { if (n === "node_modules" || n === ".git") continue; const p = join(d, n);
    if (n === "log.jsonl") logs.push(p); else { try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch {} } } };
for (const r of roots) walk(r);
const seen = new Set<string>(); let total = 0, entries = 0; const t0 = performance.now();
for (const p of logs) {
  const raw = readFileSync(p, "utf8"); const h = sha(raw); if (seen.has(h) || !raw.trim()) continue; seen.add(h);
  const t = new Translator(); const L = parse(raw); let loss: any = null, lossAt = -1;
  const every = L.length > 2000 ? 250 : 1;
  L.forEach((e: any, i: number) => { t.push(e); if (!loss && (i % every === 0 || i === L.length - 1)) { loss = lossless(t, t.st); if (loss) lossAt = e.seq; } });
  const s = t.finish(); total++; entries += s.in;
  const name = p.replace("/home/claude/eido/", "");
  check(`${name} (${s.in}): 0 divergences`, !s.worldDivergences && !s.flightDivergences, JSON.stringify(s.first));
  check(`${name}: the projection loses nothing (independent inverse vs the real old fold${every > 1 ? `, every ${every}` : ", every entry"})`, !loss, JSON.stringify({ at: lossAt, ...loss }).slice(0, 400));
}
console.log(`[v4-test] ${total} distinct world logs, ${entries} entries, ${Math.round(performance.now() - t0)} ms`);
console.log(`[v4-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
