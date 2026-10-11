// @ts-nocheck
// LAB (not in the suite): R's gym, 10-10 23:23, replayed at the authority with no browser. The log is cut just before her
// grab of pyr-8; the grab and the drop are re-asked as she asked them; then: do any two crates overlap at rest?
//   bun tools/protocol/gym-drag.lab.ts
import fs from "node:fs"; import path from "node:path";
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold, readLog } from "../../shared/protocol/fold.js";
import * as THREE from "three";
const SRC = "/home/claude/eido/scratch-worlds/v4-garden"; const root = fs.mkdtempSync("/home/claude/eido/scratch/gymdrag-");
for (const f of [".custody.json", ".directory.json"]) if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(root, f));
fs.mkdirSync(path.join(root, "worlds"), { recursive: true }); fs.mkdirSync(path.join(root, "keys")); fs.copyFileSync(path.join(SRC, ".custody.json"), path.join(root, "keys/custody.json"));   // filehost's layout: <root>/worlds/<name>.jsonl
const lines = fs.readFileSync(path.join(SRC, "gym/world.jsonl"), "utf8").split("\n").filter(Boolean);
// MODE=batch (default): cut just before the rests at 51.56 and let the authority settle that same instant again (the sim is
// the log's: deterministic). MODE=grab: cut before her grab of pyr-8 and re-ask grab and drop (the timing is not hers).
const MODE = process.env.MODE ?? "batch";
const cut = MODE === "batch" ? lines.findIndex((l) => { const e = JSON.parse(l); return e.kind === "sim" && e.verb === "digest" && e.ts >= Date.parse("2026-10-11T06:23:51.5Z"); })
  : lines.findIndex((l) => { const e = JSON.parse(l); return e.kind === "act" && e.verb === "grab" && e.body?.request?.id === "pyr-8" && e.ts > Date.parse("2026-10-11T06:23:00Z"); });
fs.writeFileSync(path.join(root, "worlds/gym.jsonl"), lines.slice(0, cut).join("\n") + "\n");
const her = lines.map((l) => JSON.parse(l)).find((e) => e.kind === "act" && e.verb === "grab" && e.body?.request?.id === "pyr-8" && e.ts > Date.parse("2026-10-11T06:23:00Z")).actor; let T = JSON.parse(lines[cut]).ts;
const call = (v, a) => { T += 400; process.env.PROTOCOL_NOW = String(T); return request(openWorld(root, "gym"), her, v, a); };
let mv = { ok: "-" }, g = { ok: "-" }, d = { ok: "-" };
if (MODE === "batch") { T = JSON.parse(lines[cut]).ts - 400; mv = call("move", { to: [6.6, 0, 6.9], teleport: true }); }
else {
// her timing, to the millisecond: the rests landed at 51.56, her drop at 51.72
const at = (iso) => { T = Date.parse(iso) - 400; };
const g0 = JSON.parse(lines[cut]).ts; T = g0 - 1200; mv = call("move", { to: [6.6, 0, 6.9], teleport: true });
T = g0 - 400; g = call("grab", { id: "pyr-8" });
at("2026-10-11T06:23:51.560Z"); call("look", {});
const dropE = lines.slice(cut).map((l) => JSON.parse(l)).find((e) => e.kind === "act" && e.verb === "drop");
T = dropE.ts - 400; d = call("drop", { id: "pyr-8", ...(dropE.body.request.pos ? { pos: dropE.body.request.pos } : {}) });
for (let i = 0; i < 8; i++) { T += 1000; call("look", {}); } }
const W0 = openWorld(root, "gym"); const st = W0.state ? W0.state() : fold(W0.entries); console.log("entries", W0.entries?.length, "cut", cut, "move", JSON.stringify(mv).slice(0, 200));
const M = (id) => { const c = st.entities[id].c, t = c.transform; const sc = Array.isArray(t.scale) ? t.scale : [t.scale ?? 1, t.scale ?? 1, t.scale ?? 1];
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...t.pos), new THREE.Quaternion(...(t.q ?? [0, 0, 0, 1])), new THREE.Vector3(...sc)); return c.parent?.to ? M(c.parent.to).multiply(m) : m; };
const ids = Object.keys(st.entities).filter((k) => /^pyr-/.test(k) && !(MODE === "batch" && k === "pyr-8"));
const B = {};   // (in batch mode pyr-8 is in her hand: it stands in the log where she took it)
for (const id of ids) { const s = st.entities[id].c.physics.shape, m = M(id), cs = [];
  for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) cs.push(new THREE.Vector3(s[a][0], s[b][1], s[c][2]).applyMatrix4(m));
  const e = m.elements; B[id] = { cs, ax: [0, 4, 8].map((o) => new THREE.Vector3(e[o], e[o + 1], e[o + 2]).normalize()) }; }
const pr = (cs, a) => { let lo = Infinity, hi = -Infinity; for (const c of cs) { const v = c.dot(a); lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; };
let worst = 0, pair = null;
for (const a of ids) for (const b of ids) { if (a >= b) continue; const axes = [...B[a].ax, ...B[b].ax]; for (const x of B[a].ax) for (const y of B[b].ax) { const c = x.clone().cross(y); if (c.lengthSq() > 1e-6) axes.push(c.normalize()); }
  let pen = Infinity; for (const ax of axes) { const [l1, h1] = pr(B[a].cs, ax), [l2, h2] = pr(B[b].cs, ax); pen = Math.min(pen, Math.min(h1, h2) - Math.max(l1, l2)); }
  if (pen > worst) { worst = pen; pair = [a, b]; } }
console.log(JSON.stringify({ move: mv.ok ?? mv.refused?.code, grab: g.ok ?? g.refused?.code, drop: d.ok ?? d.refused?.code, worstOverlap: +worst.toFixed(3), pair }));
fs.rmSync(root, { recursive: true, force: true });
