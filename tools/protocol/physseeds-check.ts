// tools/protocol/physseeds-check.ts — the seeds future online physics needs, planted before the Commons translation
// freezes them (RESEARCH-physics-hands-and-online-seeds-2026-10-07 Part 2; spec/PHYSICS.md §4, §9, §10). Every case was
// red before its change. usage: bun tools/protocol/physseeds-check.ts [--only SH1,CK2]
//   SH  physics.shape has a grammar: a bare [[min],[max]] is a box forever; every other shape is a tagged object
//       ({type: sphere|capsule|cylinder|box|convex|mesh|compound}); convex, mesh and compound name a content address.
//       The authority refuses anything else; the sim layer gives eidosim only boxes
//   PH  physical properties are registered with units and a stated meaning of absence (mass, density, material,
//       friction, restitution, damping, centre of mass, ccd, collision layers/mask, combine modes), a world's surfaces, kinematic, and a
//       reserved joint:<name> the authority refuses until an engine carries joints
//   TH  a throw or drop carries spin (w, rad/s, world frame) and its capture time (t); the act and the launch keep them
//   ST  the state-sync lane's sample shape {id, by, aseq, oseq, t, p, q, v, w, sleep}: absolute, self-contained
//   CK  one time base: a round-trip clock, a sample's own capture time and sequence, sanitized at the server's fence
//   SV  against a real server whose world log runs AHEAD of wall time: frames and the clock reply carry the authority's
//       clock (the one that stamps entries' ts), poses keep t/seq, a state sample is validated and refused as reserved
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { tryUntil } from "./wait.ts";
import { pin, LAB_EPOCH } from "./clock.ts";

const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf("--only"); return i >= 0 ? argv[i + 1].split(",") : null; })();
let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => { if (only && !only.includes(id)) return;
  if (cond) { pass++; console.log(`  ok ${id} ${what}`); } else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const imp = async (p: string) => await import(path.join(ENGINE, p)).catch((e) => ({ __missing: String(e) }));
const H64 = "a".repeat(64);

// ---- SH: the shape grammar ----
const SH = await imp("shared/protocol/shapes.js");
const AU = await imp("shared/protocol/authority.js");
const err = (s) => (typeof SH.shapeError === "function" ? SH.shapeError(s) : "no shapeError");
ok("SH1", err([[-0.5, 0, -0.5], [0.5, 1, 0.5]]) === null && err([[0, 0], [1, 1, 1]]) && err([[1, 0, 0], [0, 1, 1]]) && err([[0, 0, 0], [1, NaN, 1]]) && err([[0, 0, 0], [1, 1, 1], [2, 2, 2]]),
  "a bare [[min],[max]] is a box (min ≤ max, finite); anything else bare is refused",
  [err([[0, 0], [1, 1, 1]]), err([[1, 0, 0], [0, 1, 1]])]);
ok("SH2", err({ type: "sphere", radius: 0.5 }) === null && err({ type: "capsule", radius: 0.2, halfHeight: 0.6 }) === null && err({ type: "cylinder", radius: 0.3, halfHeight: 0.5, pos: [0, 0.5, 0] }) === null
  && err({ type: "box", half: [0.5, 0.25, 1], q: [0, 0, 0, 1] }) === null
  && err({ type: "sphere" }) && err({ type: "sphere", radius: -1 }) && err({ type: "sphere", radius: 0.5, r: 1 }) && err({ type: "blob" }) && err({ type: "box", half: [1, 1, 1], q: [0, 0, 0, 2] }),
  "tagged primitives in the thing's own frame, metres (sphere, capsule, cylinder, box {half}); a missing size, a stray key, an unknown type or a non-unit q is refused",
  [err({ type: "sphere" }), err({ type: "sphere", radius: 0.5, r: 1 }), err({ type: "blob" }), err({ type: "box", half: [1, 1, 1], q: [0, 0, 0, 2] })]);
ok("SH3", err({ type: "convex", blob: `sha256:${H64}` }) === null && err({ type: "mesh", blob: `sha256:${H64}` }) === null && err({ type: "compound", blob: `sha256:${H64}` }) === null
  && err({ type: "convex", blob: "hull.json" }) && err({ type: "mesh" }) && err({ type: "compound", children: [] }),
  "convex, mesh and compound geometry is a content address (sha256:<64 hex>), never inline", [err({ type: "convex", blob: "hull.json" }), err({ type: "compound", children: [] })]);
const sr = (v) => (typeof AU.schemaRefusal === "function" ? AU.schemaRefusal("physics", v) : "no schemaRefusal");
ok("SH4", sr({ kind: "static", shape: "banana" }) && sr({ kind: "static", shape: { type: "sphere" } }) && sr({ kind: "static", shape: [[0, 0, 0], [1, 1, 1]] }) === null && sr({ kind: "static", shape: { type: "sphere", radius: 1 } }) === null,
  "the authority's schema check refuses a malformed physics.shape (it was `any`: anything was admitted)", [sr({ kind: "static", shape: "banana" }), sr({ kind: "static", shape: { type: "sphere" } })]);
const SL = await imp("shared/protocol/simlayer.js");
ok("SH5", typeof SL.engineBox === "function" && JSON.stringify(SL.engineBox({ shape: [[0, 0, 0], [1, 1, 1]] })) === "[[0,0,0],[1,1,1]]" && SL.engineBox({ shape: { type: "sphere", radius: 1 } }) === null && SL.engineBox({ shape: [[0, 0], [1, 1, 1]] }) === null,
  "the boxes table holds bare boxes only: a tagged shape is never misread as a box (eidosim reads a sphere through the entity view's shape)");
ok("SH6", typeof SH.shapeVolume === "function" && Math.abs(SH.shapeVolume([[0, 0, 0], [1, 2, 3]]) - 6) < 1e-12 && Math.abs(SH.shapeVolume({ type: "sphere", radius: 1 }) - 4 / 3 * Math.PI) < 1e-12
  && Math.abs(SH.shapeVolume({ type: "capsule", radius: 1, halfHeight: 1 }) - (2 * Math.PI + 4 / 3 * Math.PI)) < 1e-12 && SH.shapeVolume({ type: "convex", blob: `sha256:${H64}` }) === null,
  "a primitive's volume is defined (mass absent = density × volume); a blob shape's is its baked geometry's");

// ---- PH: physical properties ----
const CS = await imp("shared/protocol/componentspec.js");
const ph = CS.COMPONENTS?.physics ?? {};
// shape audit 10-16 (physics-motion §5): the ten physical properties are RESERVED fields (named, unit-ed, their absence
// written down, refused until an engine reads them); material is renamed surface; ccd, layers, mask are cut
// (mass and density stay open fields: the body shove reads them, shared/shove.js massOf)
const NEW = ["surface", "friction", "restitution", "frictionCombine", "restitutionCombine", "linearDamping", "angularDamping", "centerOfMass"];
ok("PH1", ph.fields?.mass === "number" && ph.fields?.density === "number" && NEW.every((f) => (ph.reservedFields ?? []).includes(f) && !ph.fields?.[f]) && NEW.every((f) => typeof ph.absentMeans?.[f] === "string" && ph.absentMeans[f].length > 10) && typeof ph.absentMeans?.shape === "string"
  && ["ccd", "layers", "mask", "material"].every((f) => !ph.fields?.[f] && !(ph.reservedFields ?? []).includes(f)),
  "physics keeps mass and density (the shove reads them) and holds surface, friction, restitution, damping, centerOfMass, friction/restitution combine modes as reserved fields, each with its meaning of absence (ccd, layers, mask cut; material renamed surface)", { fields: ph.fields, reserved: ph.reservedFields, absentMeans: ph.absentMeans && Object.keys(ph.absentMeans) });
ok("PH2", [...NEW, "mass", "density"].every((f) => !(f in (CS.defaultsOf?.("physics") ?? {}))) && /kg\/m³/.test(ph.absentMeans?.density ?? "") && /density/.test(ph.absentMeans?.mass ?? "") && /volume/.test(ph.absentMeans?.mass ?? ""),
  "none of them is a materialized constant (a pinned mass: 1 would be wrong for every crate); mass absent = density × volume", ph.absentMeans);
const held = NEW.map((f) => ({ [f]: f === "surface" || f.endsWith("Combine") ? "min" : f === "centerOfMass" ? [0, 0.1, 0] : 0.5 }));
const cut = [{ ccd: true }, { layers: 1 }, { mask: 1 }, { material: "wood" }];
ok("PH3", sr({ kind: "dynamic" }) === null && sr({ kind: "dynamic", mass: 2.5, density: 700 }) === null && !!sr({ kind: "dynamic", mass: 0 }) && !!sr({ kind: "dynamic", density: -1 }) && held.every((b) => /reserved/.test(sr({ kind: "dynamic", ...b }) ?? "")) && cut.every((b) => /gone/.test(sr({ kind: "dynamic", ...b }) ?? "")) && /needs kind/.test(sr({}) ?? ""),
  "the authority takes a mass and a density in range, refuses a reserved property as reserved, a cut one as gone, and a physics with no kind", { held: held.map((b) => sr({ kind: "dynamic", ...b })), cut: cut.map((b) => sr({ kind: "dynamic", ...b })), none: sr({}) });
const sf = CS.COMPONENTS?.surface;
const physPin = (CS.pinOf?.() ?? {}).physics;
ok("PH4", sf?.status === "reserved" && sf?.on === "world" && sf?.keyed && !sf.fields && !(physPin?.reservedShape) && /friction/.test(fs.readFileSync(new URL("../../docs/RESERVED-SHAPES.md", import.meta.url), "utf8")),
  "a world's surfaces: @world surface:<name> is reserved by name, with no shape pinned (nor physics' reserved fields' shapes) until a world needs one; the sketch is docs/RESERVED-SHAPES.md", sf);
ok("PH5", (ph.enums?.kind ?? []).includes("kinematic") && ["dynamic", "static", "none"].every((k) => ph.enums.kind.includes(k)), "physics.kind adds kinematic (moved by authority or motion, never by the engine)", ph.enums);
ok("PH6", CS.statusOf("physics-joint") === "reserved" && CS.COMPONENTS["physics-joint"].keyed && !CS.COMPONENTS["physics-joint"].fields && CS.statusOf("joint") === "reserved" && /skeleton/.test(CS.COMPONENTS.joint.help),
  "physics-joint:<name> is the reserved constraint (no fields pinned: one anchor can't carry two frames; PHYSICS §3.3 sketches the shape); joint is the reserved skeleton node", [CS.COMPONENTS["physics-joint"], CS.COMPONENTS.joint]);

// a live world (server/livehost.ts) with a pinned clock, as physlive-check opens one
const { request } = AU;
const { openLive } = await imp("server/livehost.ts");
const { readLog } = await imp("shared/protocol/fold.js");
const root = scratch("physseeds"); let N = 0;
function live() {
  const dir = `${root}w${++N}/`; fs.mkdirSync(dir, { recursive: true }); let now = 1800000000000;
  const w = openLive(dir, `w${N}`, { now: () => now, custodyFile: `${root}custody.json`, nameOf: () => null, kindOf: () => "human" });
  const call = (actor, verb, args = {}, step = 100) => { now += step; return request(w, actor, verb, args); };
  return { w, call, L: () => readLog(fs.readFileSync(dir + "world.jsonl")) };
}
function playground() {
  const x = live(); const { call } = x;
  call("rowan", "create-world", { title: "pg" });
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
  call("rowan", "move", { to: [0, 0, -0.5] });
  return x;
}
{ const { call, w } = playground();
  const j = call("rowan", "set", { id: "ball", component: "physics-joint:hinge", value: { to: "@world" } });
  ok("PH7", !j.ok && j.refused?.code === "reserved" && /physics-joint/.test(j.refused?.reason ?? "") && /parent \{to\}/.test(j.refused?.fix ?? ""), "the authority refuses a physics-joint: a reserved name (one refusal for every reserved name; its fix says what to use meanwhile), rather than storing a dead value", j.refused ?? j);
  const k = call("rowan", "create", { id: "lift", model: "crate", components: { physics: { kind: "kinematic" } }, place: { at: [3, 3] } });
  const kp = w.state().entities.lift?.c.physics;
  ok("PH8", k.ok && kp?.kind === "kinematic" && Array.isArray(kp.shape) && call("rowan", "punt", { id: "lift" }).refused?.code === "not-dynamic",
    "a kinematic thing is admitted, gets its measured shape (a collider), and is never launched", [k.refused, kp]);
  // shape audit 10-16: surfaces and the properties are reserved until an engine reads them (writes closed, names held)
  const s = call("rowan", "set", { id: "@world", component: "surface:oak", value: { friction: 0.6, restitution: 0.1, density: 700 } });
  const m = call("rowan", "set", { id: "ball", component: "physics", value: { kind: "dynamic", surface: "oak" } });
  const ms = call("rowan", "set", { id: "ball", component: "physics", value: { kind: "dynamic", mass: 0.4 } });
  ok("PH9", s.refused?.code === "reserved" && m.refused?.code === "reserved" && !w.state().entities["@world"].c["surface:oak"] && ms.ok && w.state().entities.ball.c.physics.mass === 0.4, "a surface on @world and a thing naming it are refused as reserved (nothing reads them yet); a mass is admitted (the shove reads it)", [s.refused, m.refused, ms.refused]);
  const mm = call("rowan", "set", { id: "ball", component: "physics", value: { kind: "dynamic", material: "teak" } });
  ok("PH10", !mm.ok && mm.refused?.code === "schema" && (mm.refused?.didYouMean ?? []).includes("surface"), "physics.material is refused with where it went (renamed surface)", mm.refused ?? mm);
}

// ---- TH: throws keep spin and capture time ----
{ const { call, L, w } = playground();
  call("rowan", "grab", { id: "ball" });
  const r = call("rowan", "throw", { id: "ball", v: [0, 2, 3], w: [0, 0, 6.28], t: 1800000000123 });
  const act = L().filter((e) => e?.kind === "act" && e.verb === "throw").at(-1); const la = L().filter((e) => e?.kind === "sim" && e.verb === "launch").at(-1);
  ok("TH1", r.ok && JSON.stringify(act?.body?.request?.w) === "[0,0,6.28]" && act?.body?.request?.t === 1800000000123 && JSON.stringify(la?.body?.w) === "[0,0,6.28]",
    "throw {w (rad/s, world), t (capture, authority clock)}: the act records the request, the launch carries w (eidosim ignores it, as it ignores roll)", [r.refused, act?.body, la?.body]);
  call("rowan", "wait", {}, 8000); { const p = w.state().entities.ball.c.transform.pos; call("rowan", "move", { to: [p[0], 0, p[2] - 0.5] }, 2000); }
  ok("TH2", call("rowan", "grab", { id: "ball" }).ok && call("rowan", "throw", { id: "ball", v: [0, 1, 1], w: [0, "x", 0] }).refused?.code === "shape", "a malformed w is refused");
  const d = call("rowan", "drop", { id: "ball", w: [1, 0, 0] });
  const la2 = L().filter((e) => e?.kind === "sim" && e.verb === "launch").at(-1);
  ok("TH3", d.ok && JSON.stringify(la2?.body?.w) === "[1,0,0]", "a drop with spin carries it too", [d.refused, la2?.body]);
}

// ---- ST: the state sample ----
const PW = await imp("shared/presencewire.js");
const se = (x) => (typeof PW.stateSampleError === "function" ? PW.stateSampleError(x) : "no stateSampleError");
const S0 = { id: "crate-1", by: "u-abcdefghijklmnopqrst", aseq: 3, oseq: 1, t: 1800000000000, p: [0, 1, 2], q: [0, 0, 0, 1], v: [0, 0, 1], w: [0, 0.5, 0], sleep: false };
ok("ST1", se(S0) === null && se({ ...S0, q: [0, 0, 0, 2] }) && se({ ...S0, aseq: -1 }) && se({ ...S0, oseq: 1.5 }) && se({ ...S0, extra: 1 }) && se({ ...S0, p: [0, 1] }) && se({ ...S0, sleep: 1 }) && se((({ w, ...r }) => r)(S0)),
  "a state sample is {id, by, aseq, oseq, t, p, q, v, w, sleep}: every field, absolute, finite, nothing else", [se({ ...S0, q: [0, 0, 0, 2] }), se({ ...S0, extra: 1 })]);

// ---- CK: one time base ----
const CLK = await imp("client/lib/serverclock.js");
{ const ahead = 60_000; const l0 = typeof CLK.localNow === "function" ? CLK.localNow() : 0;
  // the server's clock runs 60 s ahead; a round trip of 40 ms, symmetric
  if (typeof CLK.noteRoundTrip === "function") { CLK.noteRoundTrip(l0, l0 + 20 + ahead, l0 + 40); for (let i = 0; i < 20; i++) CLK.noteServerTime(CLK.localNow() + ahead - 150); }
  const off = CLK.serverNow() - CLK.localNow?.();
  ok("CK1", typeof CLK.noteRoundTrip === "function" && Math.abs(off - ahead) < 5, "a round trip sets the offset (t − midpoint); one-way frame stamps, late by their delay, don't drag it", off - ahead);
  const st = (p, f) => (typeof PW.sampleTime === "function" ? PW.sampleTime(p, f) : null);
  ok("CK2", st({ t: 1000 }, 1040) === 1000 && st({ t: 5000 }, 1040) === 1040 && st({ t: -1e9 }, 1040) === 1040 && st({}, 1040) === 1040 && st({ t: "x" }, 1040) === 1040,
    "a receiver draws a sample at its own capture time when it's sane against the frame's, else at the frame's", [st({ t: 1000 }, 1040), st({ t: 5000 }, 1040)]);
  const PC = await imp("server/posecheck.ts");
  const a = PC.sanePose?.({ p: [0, 0, 0], t: 1800000000000, seq: 7 }), b = PC.sanePose?.({ p: [0, 0, 0], t: "soon", seq: 1.5 }), c2 = PC.sanePose?.({ p: [0, 0, 0], seq: -2 });
  ok("CK3", a?.t === 1800000000000 && a?.seq === 7 && b && !("t" in b) && !("seq" in b) && c2 && !("seq" in c2), "the server's fence keeps a finite t and a whole seq ≥ 0, and drops bad ones without dropping the pose", [a, b, c2]);
}

// ---- SV: a real server whose world log is ahead of wall time ----
if (!only || only.some((x) => x.startsWith("SV"))) {
  const SKEW = 3_600_000;
  const W = path.join(root, "worlds-sv"); fs.mkdirSync(W, { recursive: true });
  const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
  // found the world with the authority's clock an hour ahead (an imported world, or a host whose clock was ahead): its log
  // ends at a ts the wall clock hasn't reached
  const f = Bun.spawnSync(["bun", "-e", `process.env.WORLDS_DIR=${JSON.stringify(W)}; const { foundWorld } = await import(${JSON.stringify(path.join(ENGINE, "server/worldlog.ts"))});
    foundWorld(${JSON.stringify(path.join(W, "glade"))}, "glade", "Ann", "glade", () => Date.now() + ${SKEW}); process.exit(0);`], { cwd: ENGINE, env: env() });
  const lastTs = (() => { try { return readLog(fs.readFileSync(path.join(W, "glade", "world.jsonl"))).filter((e) => Number.isInteger(e?.ts)).at(-1)?.ts ?? 0; } catch { return 0; } })();
  ok("SV0", f.exitCode === 0 && lastTs > Date.now() + SKEW / 2, "(setup) the world's log ends an hour ahead of wall time", [f.stderr.toString().slice(-300), lastTs - Date.now()]);
  let port = 9520; for (; port < 9600; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
  const logf = path.join(root, "srv.log");
  const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  process.on("exit", () => { try { proc.kill(); } catch {} });
  const up = !!(await tryUntil("the server answers /version", async () => (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok, { ms: 76_000, step: 150 }));
  ok("SV0b", up, "(setup) the server is up");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (m) => ws.send(JSON.stringify(m));
  send({ type: "join", world: "glade", id: "Ann", avatar: "", replica: true });
  await tryUntil("Ann's join is answered", () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 4000, step: 50 });
  send({ type: "pose", pose: { p: [0, 0, 0], yaw: 0, speed: 0, t: lastTs + 5, seq: 42 } });
  await tryUntil("a frame arrives", () => msgs.some((m) => m.type === "frame"), { ms: 3000, step: 50 });
  const fr = msgs.find((m) => m.type === "frame");
  ok("SV1", fr && fr.t >= lastTs, "a frame's t is the authority's clock, never behind the log (it was raw Date.now(): flights were drawn an hour early)", [fr?.t - lastTs, msgs.map((m) => m.type)]);
  const mine = fr && Object.values(fr.poses ?? {})[0];
  ok("SV2", mine?.t === lastTs + 5 && mine?.seq === 42, "a pose's capture time and sequence ride the frame", mine);
  send({ type: "clock", t0: 12345.5 });
  await tryUntil("the clock message is answered", () => msgs.some((m) => m.type === "clock"), { ms: 2000, step: 50 });
  const ck = msgs.find((m) => m.type === "clock");
  ok("SV3", ck && ck.t0 === 12345.5 && ck.t >= lastTs, "clock {t0} is answered with {t0, t}: t on the authority's clock (a round trip, not a one-way guess)", ck ?? msgs.filter((m) => m.type === "error"));
  const k0 = msgs.length;
  send({ type: "state", s: [{ ...S0, q: [0, 0, 0, 2] }] }); await tryUntil("the malformed state is refused", () => msgs.slice(k0).some((m) => m.type === "error"), { ms: 2000 });
  const e1 = msgs.slice(k0).find((m) => m.type === "error");
  const k1 = msgs.length;
  send({ type: "state", s: [S0] }); await tryUntil("the well-formed state is refused as reserved", () => msgs.slice(k1).some((m) => m.type === "error"), { ms: 2000 });
  const e2 = msgs.slice(k1).find((m) => m.type === "error");
  ok("SV4", /q/.test(e1?.error ?? "") && /reserved/.test(e2?.error ?? "") && /PHYSICS/.test(e2?.error ?? ""), "a state message is checked against the sample shape, then refused as reserved (no live authority yet), and says where it's specified", [e1, e2]);
  ws.close(); proc.kill();
}

// ---- RS: reservations of research 10-11 C (PHYSICS §4.1): names the door refuses until built ----
{
  const FH = await imp("server/filehost.ts"); const root = scratch("physseeds-rs"); fs.mkdirSync(root + "worlds", { recursive: true });
  for (const f of ["rs.jsonl", "rs.presence.json"]) fs.rmSync(`${root}worlds/${f}`, { force: true });
  pin(LAB_EPOCH);
  const rq = (verb, args = {}) => AU.request(FH.openWorld(root, "rs"), "rowan", verb, args);
  const made = rq("create-world", { title: "rs" }); const rs = ["cohold", "deflect", "carry"].map((v) => rq(v, { id: "x" }));
  ok("RS1", made.ok && rs.every((r) => r.ok === false && /verb/.test(r.refused?.code ?? "")), "cohold, deflect and carry are reserved verbs: the authority refuses each as a verb it doesn't have", rs.map((r) => r.refused?.code));
  const pe = (v) => (typeof AU.schemaRefusal === "function" ? AU.schemaRefusal("physics-engine", v) : "no schemaRefusal");
  ok("RS2", pe({ engine: "eidosim@1.0.0" }) === null && pe({ engine: "eidosim@1.0.0", claimDebounceMs: 200 }) && pe({ engine: "eidosim@1.0.0", liveAuthorityExpiryMs: 5000 }),
    "claimDebounceMs and liveAuthorityExpiryMs on @world.physics-engine are reserved: refused until an authority reads them", [pe({ engine: "eidosim@1.0.0", claimDebounceMs: 200 })]);
  const CS2 = await imp("shared/protocol/componentspec.js");
  ok("RS3", CS2.COMPONENTS?.grabbable?.defaults?.steal === true && typeof CS2.COMPONENTS?.grabbable?.defaults?.steal === "boolean", "grabbable.steal is the holder's switch, a boolean defaulting to true (the latest grab wins); 'ask' is reserved", CS2.COMPONENTS?.grabbable?.defaults?.steal);
}

// review of #260: a shape's type is read as an own name of the grammar, and only as a string
{ const thrown = (s) => { try { return err(s); } catch (x) { return `THREW ${x?.constructor?.name}`; } };
  const a = thrown({ type: "constructor" }), b = thrown({ type: ["box"], half: [1, 1, 1] });
  // the refusal is the no-type one (house 6340433633: any string passed, the missing-function fallback "no shapeError" too)
  ok("SG9", /^no shape type /.test(a) && /^no shape type /.test(b), "a shape type that is an inherited name (constructor) or not a string (['box']) is no shape type: refused in words, never thrown and never read as box", { a, b }); }

console.log(`\nphysseeds: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
