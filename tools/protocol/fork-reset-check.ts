// tools/protocol/fork-reset-check.ts — world fork and reset, against a real sequencer (scratch port and WORLDS_DIR).
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/fork-reset-check.ts
//   FK  fork: owner-only; a NEW world (its own id) whose founding act names the source {world, name, head}; the copy's
//       things and @world equal the source's; roles travel; chat does not; bad/taken names refused
//   RS  reset: owner-only and name-confirmed; the old log is archived beside it; a fresh genesis whose founding act
//       names the world it replaced; every owner is still an owner; the people present are told
//   FD  found (ship list 10-07): a signed-in person founds a new, empty world they own, through the authority's founding act;
//       a taken or bad name, a guest, and an account past its cap or the server past its hourly limit are refused
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";
import { idAliases } from "./idalias.ts";
const IDS = idAliases();   // R 10-17: the suite's names ride as placeholders and minted ids

const root = scratch("forkreset");
const MODEL = "eidoverse/assets/models/crate_large_red.glb";   // a real catalogue model (the engine measures it)
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", ...extra });
const tool = (args) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE, env: env() }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
async function start(extra = {}) {
  let port = 9410; for (; port < 9500; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
  const logf = path.join(root, `srv-${port}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port), ...extra }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  for (let i = 0; i < 80; i++) { await sleep(150); try { if ((await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(800) })).ok) return { port, proc: p }; } catch {} }
  throw new Error("server didn't start: " + (fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-600) : ""));
}
async function sock(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = []; let n = 0; const waiters = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") waiters.get(m.id)?.(m.reply); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { msgs,
    async join(world, id) { const k = msgs.length; ws.send(JSON.stringify({ type: "join", world, id, avatar: "", replica: true }));
      for (let i = 0; i < 60 && !msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50); await sleep(50);
      return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"), errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; },
    req: (verb, args = {}) => new Promise((res) => { const id = `r${++n}`; waiters.set(id, (r) => res(IDS.back(r))); ws.send(JSON.stringify({ type: "request", id, verb, args: IDS.out(verb, args) })); setTimeout(() => res({ ok: false, timeout: true }), 5000); }),
    async raw(m, wantType, ms = 3000) { const k = msgs.length; ws.send(JSON.stringify(m)); for (let i = 0; i < ms / 50; i++) { const hit = msgs.slice(k).find((x) => x.type === wantType || x.type === "error"); if (hit) return hit; await sleep(50); } return null; },
    close: () => ws.close() };
}
const logOf = (name) => (fs.existsSync(path.join(W, name, "world.jsonl")) ? readLog(fs.readFileSync(path.join(W, name, "world.jsonl"))) : []);
const founding = (name) => logOf(name).find((e) => e.kind === "act" && e.verb === "create-world");
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));   // key order is not content
const thingsOf = (st) => Object.fromEntries(Object.entries(st.entities).map(([id, e]) => [id, e.c]));

ok(tool(["found", "src", "--owner", "Ann"]).code === 0 && tool(["found", "taken", "--owner", "Ann"]).code === 0, "(setup) found src and taken, Ann owns both");
const S = await start({ FOUND_PER_ACCOUNT: "2", FOUND_GAP_MS: "0", FOUND_PER_HOUR: "3" });
const ann = await sock(S.port); const ja0 = await ann.join("src", "Ann"); const annId = ja0.snapshot?.cut?.you;
const bob = await sock(S.port); const jb = await bob.join("src", "Bob");
const bobId = jb.snapshot?.cut?.you;
// a world worth copying: a parent with a locked child, a light, sockets, @world settings and roles, and a chat line
for (const r of [
  await ann.req("set", { id: "@world", component: `roles:${bobId}`, value: { role: "builder" } }),
  await ann.req("set", { id: "@world", component: "default-role", value: { role: "visitor" } }),
  await ann.req("create", { id: "table1", model: MODEL, components: { transform: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }),
  await ann.req("create", { id: "lamp1", components: { label: "lamp1", parent: { to: "table1" }, transform: { pos: [0, 0.75, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { kind: "spot", angle: 0.5, intensity: 12 } } }),
  await ann.req("set", { id: "lamp1", component: "lock", value: true }),
  await ann.req("create", { id: "chair1", model: MODEL, components: { sockets: { seat: { pos: [0, 0.45, 0], body: { action: "sit" } } } } }),
  await ann.req("say", { text: "a private chat line from before the copy" }),
  await ann.req("sky", { hours: 18, rate: 1 }),   // the act stamps sky.ts, which a writer may never set (review of #260, server I36)
]) ok(r.ok, "(setup) the source world takes it", r.refused);
// a scripted bell: scripts travel with a fork (their source blobs too) and keep working there
{ const up = await ann.req("upload", { text: 'world.on("use", () => { world.set("self", "t/bell", { rung: (world.get("self", "t/bell")?.rung ?? 0) + 1 }); });' });
  ok(up.ok && /^sha256:/.test(up.src), "(setup) upload the bell's source", up);
  for (const r of [await ann.req("create", { id: "bell1", model: MODEL, components: { reactions: { ring: { kind: "script", script: "bell" } } } }),
    await ann.req("set", { id: "bell1", component: "script:bell", value: { src: up.src, scope: { ids: "self", comps: ["t/bell"] }, on: ["use"] } })]) ok(r.ok, "(setup) the bell is scripted", r.refused);
  const rung = await bob.req("use", { id: "bell1", action: "ring" });
  ok(rung.ok, "(setup) the bell rings in the source", rung.refused); }
const readSrc = () => fold(logOf("src"));

// ---- FK ----
{ const r = await bob.raw({ type: "world-fork", to: "copy" }, "world-forked");
  ok(r?.type === "error" && /needs its owner/.test(r.error) && !fs.existsSync(path.join(W, "copy")), "FK1 a builder can't copy the world (owner-only), and nothing is written", r); }
{ const r = await ann.raw({ type: "world-fork", to: "bad name!" }, "world-forked"); ok(r?.type === "error" && /bad world name/.test(r.error), "FK2 a bad name is refused", r);
  const r2 = await ann.raw({ type: "world-fork", to: "taken" }, "world-forked"); ok(r2?.type === "error" && /already exists/.test(r2.error), "FK2 a taken name is refused", r2);
  const r3 = await ann.raw({ type: "world-fork", to: "src" }, "world-forked"); ok(r3?.type === "error", "FK2 a world can't be copied onto itself", r3); }
const before = fs.readdirSync(W).filter((d) => d.startsWith("."));
const fk = await ann.raw({ type: "world-fork", to: "copy" }, "world-forked", 8000);
ok(fk?.type === "world-forked" && fk.to === "copy", "FK3 the owner copies it", fk);
{ const src = readSrc(), { fold } = await import("../../shared/protocol/fold.js"); const cp = fold(logOf("copy"));
  const f = founding("copy"); const srcGen = logOf("src")[0];
  ok(cp.worldId && cp.worldId !== fold(logOf("src")).worldId, "FK4 the copy is a NEW world (its own genesis, its own id)", [cp.worldId]);
  ok(f?.body?.request?.from?.world === fold(logOf("src")).worldId && f.body.request.from.name === "src" && /^[0-9a-f]{64}$/.test(f.body.request.from.head), "FK4 its founding act names where it came from {world, name, head}", f?.body);
  const a = thingsOf(src), b = thingsOf(cp); delete a["@world"].about; delete b["@world"].about;
  ok(JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) && ["table1", "lamp1", "chair1"].every((id) => canon(a[id]) === canon(b[id])),
    "FK5 every thing is copied component for component (the parent, the locked child, the spot light, the sockets)", [Object.keys(b)]);
  ok(b["@world"][`roles:${bobId}`]?.role === "builder" && b["@world"]["default-role"]?.role === "visitor", "FK5 roles and the default role travel", b["@world"]);
  ok(Number.isFinite(b["@world"].sky?.ts) && canon(a["@world"].sky) === canon(b["@world"].sky), "FK5b a sky an act stamped travels as it stands, its stamped ts with it", [a["@world"].sky, b["@world"].sky]);
  // FK12 (training consent's per-person keys staying out of a fork) went with training-consent itself (R 10-16 14:16)
  ok(!logOf("copy").some((e) => e.kind === "say"), "FK6 chat does not travel (the source's log stays the record)");
  // review 10-07 H5: the fork's genesis names its parent {world, seq, head} (part of its id: the merge base), and the acts
  // that copied the parent are marked, so a reader tells inherited things from births
  const gp = logOf("copy")[0]?.body?.parent, sl = logOf("src");
  ok(gp && gp.world === fold(sl).worldId && Number.isInteger(gp.seq) && gp.seq < sl.length && /^[0-9a-f]{64}$/.test(gp.head) && (sl[gp.seq]?.head === undefined || sl[gp.seq].head === gp.head)
    && f?.body?.request?.from?.seq === gp.seq, "FK10 the fork's genesis names its parent {world, seq, head}; the head is the parent's chain head at that seq", { gp, at: sl[gp?.seq]?.head });
  const copyActs = logOf("copy").filter((e) => e.kind === "act" && e.verb !== "create-world" && !(e.actor === "system" && e.verb === "repair-shapes"));   // the founding's shape marker (review r8 M3) copies nothing
  ok(copyActs.length > 0 && copyActs.every((e) => e.verb === "fork-copy") && !logOf("src").slice(-1)[0]?.body?.parent, "FK11 every act that copied the parent is a fork-copy (inherited, not born)", copyActs.map((e) => e.verb));
  const after = fs.readdirSync(W).filter((d) => d.startsWith("."));
  ok(after.length === before.length, "FK7 no temporary directory is left behind", after); }
{ const c2 = await sock(S.port); const j0 = await c2.join("copy", "Ann");
  const r = await c2.req("use", { id: "bell1", action: "ring" }); await sleep(200);
  ok(r.ok && fold(logOf("copy")).entities[IDS.of("bell1")]?.c["t/bell"]?.rung === 2, "FK9 the scripted bell rings in the copy (its script and source travelled; its count carried on from 1)", [r.refused, fold(logOf("copy")).entities[IDS.of("bell1")]?.c["t/bell"]]);
  c2.close(); }
{ const c2 = await sock(S.port); const j = await c2.join("copy", "Ann");
  ok(!!j.snapshot && j.snapshot.yourRights?.role === "owner", "FK8 the copy is served, and its owner is its owner", [j.errors, j.snapshot?.yourRights]); c2.close(); }

// ---- RS ----
const oldId = (await import("../../shared/protocol/fold.js")).fold(logOf("src")).worldId;
ok((await ann.req("set", { id: "@world", component: `roles:${bobId}`, value: { role: "owner" } })).ok, "(RS setup) Bob becomes a second owner");
{ const watcher = await sock(S.port); const jw = await watcher.join("src", "Cat");
  const r0 = await watcher.raw({ type: "world-reset", name: "src" }, "world-reset");
  ok(r0?.type === "error" && /needs its owner/.test(r0.error) && !fs.readdirSync(path.join(W, "src")).some((d) => d.startsWith("reset-")), "RS0 a visitor can't reset the world, and nothing moves", r0);
  const r1 = await ann.raw({ type: "world-reset", name: "wrong" }, "world-reset"); ok(r1?.type === "error" && /confirmation mismatch/.test(r1.error), "RS1 the reset must name the world", r1);
  const k = watcher.msgs.length;
  const r = await ann.raw({ type: "world-reset", name: "src" }, "world-reset", 8000);
  await sleep(300);
  ok(r?.type === "world-reset" && watcher.msgs.slice(k).some((m) => m.type === "world-reset" && m.world === "src"), "RS2 the owner resets it, and everyone present is told", r);
  const arch = fs.readdirSync(path.join(W, "src")).filter((d) => d.startsWith("reset-"));
  ok(arch.length === 1 && fs.existsSync(path.join(W, "src", arch[0], "world.jsonl")) && readLog(fs.readFileSync(path.join(W, "src", arch[0], "world.jsonl"))).some((e) => e.kind === "say"),
    "RS3 the old log is archived beside it (chat and all), never deleted", arch);
  const { fold } = await import("../../shared/protocol/fold.js"); const fresh = fold(logOf("src"));
  ok(fresh.worldId !== oldId && Object.keys(fresh.entities).length === 1, "RS4 a fresh world: a new genesis, nothing in it but @world", Object.keys(fresh.entities));
  ok(founding("src")?.body?.request?.from?.world === oldId, "RS4 its founding act names the world it replaced", founding("src")?.body?.request?.from);
  const roles = Object.entries(fresh.entities["@world"].c).filter(([k, v]) => k.startsWith("roles:") && v.role === "owner").length;
  ok(roles === 2, "RS5 both owners are still owners", fresh.entities["@world"].c);
  const again = await sock(S.port); const ja = await again.join("src", "Ann");
  ok(!!ja.snapshot && ja.snapshot.yourRights?.role === "owner" && Object.keys(ja.snapshot.cut?.state ?? { x: 1 }).filter((x) => x !== "@world").length === 0, "RS6 rejoining finds the fresh, empty world, still Ann's", [ja.errors, ja.snapshot?.yourRights]);
  const w2 = await again.req("create", { id: "new-crate", model: MODEL });
  // the fresh world's scripts run (the server's tick and arrivals reach THIS world's script host, not the archived one's)
  const up = await again.req("upload", { text: 'world.on("enter", (e) => { world.set("self", "t/greet", { last: e.by }); });' });
  const inst = await again.req("set", { id: "new-crate", component: "script:greeter", value: { src: up.src, scope: { ids: "self", comps: ["t/greet"] }, on: ["enter"] } });
  const arriving = await sock(S.port); const jr = await arriving.join("src", "Dee"); await sleep(1500);
  const greet = fold(logOf("src")).entities[IDS.of("new-crate")]?.c["t/greet"];
  ok(up.ok && inst.ok && !!jr.snapshot && greet?.last === jr.snapshot.cut?.you, "RS7 scripts run in the fresh world: an arrival reaches its greeter (the script host was rebuilt with the log)", [up.refused, inst.refused, greet]);
  arriving.close();
  ok(w2.ok, "RS6 …and it takes writes (the live world was swapped in place)", w2.refused);
  watcher.close(); again.close(); }

// ---- FD ----
{ const r0 = await bob.raw({ type: "world-found", name: "src" }, "world-founded"); ok(r0?.type === "error" && /already a world called "src"/.test(r0.error), "FD1 an existing world's name is refused (and the world is untouched)", r0);
  const r1 = await bob.raw({ type: "world-found", name: "No Good!" }, "world-founded"); ok(r1?.type === "error" && /can't be a world's name/.test(r1.error), "FD1 a bad name is refused", r1);
  const r = await bob.raw({ type: "world-found", name: "bobs-place", title: "Bob's place" }, "world-founded", 8000);
  ok(r?.type === "world-founded" && r.name === "bobs-place" && fs.existsSync(path.join(W, "bobs-place", "world.jsonl")), "FD2 a signed-in person founds a world", r);
  const f = founding("bobs-place");
  ok(f?.actor === bobId && fold(logOf("bobs-place")).entities["@world"].c[`roles:${bobId}`]?.role === "owner", "FD2 its founding act is the authority's `new` by them, and they own it", [f?.actor, bobId]);
  const there = await sock(S.port); const jt = await there.join("bobs-place", "Bob");
  ok(jt.snapshot?.yourRights?.role === "owner", "FD2 they can go there, as its owner", [jt.errors, jt.snapshot?.yourRights]);
  const made = await there.req("create", { id: "first-thing", model: MODEL });
  ok(made.ok, "FD2 …and build in it", made.refused); there.close();
  const r2 = await bob.raw({ type: "world-found", name: "bobs-second" }, "world-founded", 8000);
  const r3 = await bob.raw({ type: "world-found", name: "bobs-third" }, "world-founded");
  ok(r2?.type === "world-founded" && r3?.type === "error" && /the most one account may \(2\)/.test(r3.error) && !fs.existsSync(path.join(W, "bobs-third")), "FD3 an account founds at most its cap (here 2)", [r2, r3]);
  const cy = await sock(S.port); await cy.join("src", "Cy");   // another account
  const r4 = await cy.raw({ type: "world-found", name: "cys-place" }, "world-founded", 8000);
  const r5 = await cy.raw({ type: "world-found", name: "cys-second" }, "world-founded"); cy.close();
  ok(r4?.type === "world-founded" && r5?.type === "error" && /limit/.test(r5.error), "FD4 the server founds at most its hourly limit (here 3), across every account", [r4, r5]);
  // a guest: a server that trusts no typed name, so a join with no credential is anonymous
  const G = await start({ TRUST_NAMES: "" });
  const guest = await sock(G.port); const jg = await guest.join("src", "Gus");
  const rg = await guest.raw({ type: "world-found", name: "gus-place" }, "world-founded");
  ok(!!jg.snapshot && rg?.type === "error" && /signed-in account/.test(rg.error) && !fs.existsSync(path.join(W, "gus-place")), "FD5 a guest never founds", [jg.errors, rg]);
  guest.close(); G.proc.kill(); }

ann.close(); bob.close(); S.proc.kill();
console.log(`[fork-reset-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
