// tools/protocol/drive-check.ts — a hull driven from its helm (componentspec drive, station.input; shared/drive.js; the lease in
// shared/protocol/authority/drive.js): the door, one driver, plausibility, the hull's own collision, the lease's commits and end.
//   bun tools/protocol/drive-check.ts                 every case
//   bun tools/protocol/drive-check.ts --only D1,D3    just those
//   bun tools/protocol/drive-check.ts --tree <dir>    against another checkout's shared/ and server/ (a mutant, or the base)
//   bun tools/protocol/drive-check.ts --mutants       remove each rule in turn (a copy of the tree): its cases must go red
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "./clock.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const MUTANTS: [string, string, string, string, string[]][] = [
  ["no speed check", "drive.js", "if (flat > fl) return", "if (false) return", ["D3"]],
  ["no turn check", "drive.js", "if (turn > tl) return", "if (false) return", ["D3"]],
  ["the hull collides with nothing", "protocol/authority/drive.js", "const hit = hullHit(st, a.id, next, L.pose);", "const hit = null;", ["D4"]],
  ["any body may drive", "protocol/authority/drive.js", "if (!helm || occupantOf(w, st, actor)?.to !== helm) refuse(", "if (!helm) refuse(", ["D2"]],
  ["a lost lease never ends", "protocol/authority/drive.js", "if (now - L.beat >= LEASE.heartbeatMs) endLease(", "if (false) endLease(", ["D5"]],
  ["a lost lease keeps the helm", "protocol/authority/drive.js", "if (free && helm && occupantOf(w, st, L.by)?.to === helm) clearOccupant(w, L.by);", "", ["D5", "D6"]],
  ["getting up commits nothing", "protocol/authority/bodyverbs.js", "{ if (occupantOf(w, st, actor)) { endDrivesBy(w, st, actor); st = w.state(); } }", "", ["D7"]],
  ["no periodic commit", "protocol/authority/drive.js", "const recorded = now - L.committed >= LEASE.commitMs && commitLease(", "const recorded = false && commitLease(", ["D8"]],
  ["no periodic commit on the beat", "protocol/authority/drive.js", "else if (now - L.committed >= LEASE.commitMs) commitLease(", "else if (false) commitLease(", ["D8"]],
  ["only the end pose is tested", "protocol/authority/drive.js", "Math.max(1, Math.ceil(sweep / small))", "1", ["D10"]],
  ["what it was in never blocks", "protocol/authority/drive.js", "if (!prev.has(k) || d > prev.get(k) + 1e-4) return k;", "if (!prev.has(k)) return k;", ["D11"]],
  ["commits carry no one", "protocol/authority/drive.js", "carried: carriedBy(w, st, host, L.by),", "carried: [],", ["D12"]],
  ["a passenger's stand-up commits nothing", "protocol/authority/drive.js", "else if (seat && familyOf(st, host).has(seat))", "else if (false)", ["D12"]],
  ["a locked hull drives", "protocol/authority/drive.js", "if (lock) refuse(", "if (false) refuse(", ["D9"]],
  ["two helms taken", "protocol/authority/sockets.js", "if (helms.length > 1) return", "if (false) return", ["D1"]],
  ["a helm on nothing to drive", "protocol/authority/sockets.js", "if (helms.length && !bag(s.entities[h]?.c.drive)) return", "if (false) return", ["D1"]],
  ["input on any station", "sockbody.js", "v.input.move === 'drive' && v.action === 'drive'))", "v.input.move === 'drive'))", ["D1"]],
  ["the slack per message again", "protocol/authority/drive.js", "slack = slackNow(L.slack, dt)", "slack = slackNow(null, dt)", ["D13"]],
  ["a failed commit drops the lease", "protocol/authority/drive.js", "  commitLease(w, st, host, why, free);   // a throw keeps", "  try { commitLease(w, st, host, why, free); } catch { /* dropped */ }   // a throw keeps", ["D14"]],
  ["a drive step's failed commit unseats its driver", "protocol/authority/drive.js", 'commitLease(w, st, a.id, "periodic", false)', 'commitLease(w, st, a.id, "periodic")', ["D19"]],
  ["a failing commit retries forever", "protocol/authority/drive.js", "if (!(x instanceof Refusal) && L.fails < COMMIT_TRIES) throw x;", "throw x;", ["D18"]],
  ["a hull meets no hull-only wall", "protocol/authority/drive.js", "for (const k of hullOnly(st)) if (!fam.has(k))", "for (const k of []) if (!fam.has(k))", ["D15"]],
  ["a hull meets every wall", "protocol/authority/drive.js", "!fam.has(k) && !solidOff(st.entities[k].c, \"hulls\") && hitsIx(", "!fam.has(k) && hitsIx(", ["D16"]],
  ["bodies meet every layer", "protocol/authority/spatial.js", "solidOff(st.entities[id]?.c, \"bodies\");", "solidOff(st.entities[id]?.c);", ["D15"]],
  ["the engine carries every layer", "protocol/simlayer.js", "sphereShape(e.c.physics)) || solidOff(e.c, \"things\")) return null;", "sphereShape(e.c.physics)) || solidOff(e.c)) return null;", ["D15"]],
  ["blocks unchecked at the door", "protocol/authority/checks.js", "if (odd !== undefined || new Set(b).size !== b.length) return", "if (false) return", ["D17"]],
  ["a dynamic thing may skip things", "protocol/authority/checks.js", "if (!b.includes(\"things\") && c.physics?.kind === \"dynamic\") return", "if (false) return", ["D17"]],
  ["a hull's own blocks makes it a ghost", "protocol/authority/drive.js", "if (!e || solidOff(e.c)) return null;", "if (!e || solidOff(e.c, \"hulls\")) return null;", ["D20"]],
  ["CONTROL (no-op: must stay green)", "drive.js", "// shared/drive.js — a hull", "//  shared/drive.js — a hull", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/drive-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = scratch("dmut"); for (const sub of ["shared", "server"]) copyTree(path.join(ENGINE, sub), path.join(d, sub));
    const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the rule moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[drive-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const imp = async (p: string) => { try { return await import(TREE + p); } catch (e) { return { __missing: String(e?.message ?? e).slice(0, 160) }; } };
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const DR = await imp("shared/drive.js");
const SL = await import(TREE + "shared/protocol/simlayer.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("drive");

const diskFails = { on: false };   // D14: the log's writes fail while on
function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries: F.readLog(readLogBytes(logPath)).map(D.posAt), getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => { if (diskFails.on) throw new Error("EIO: injected (the log's disk)"); appendDurable(logPath, line); }, presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const clock = labClock(); let N = 0;
const tf = (pos: number[], q = [0, 0, 0, 1], scale = [1, 1, 1]) => ({ pos, q, scale });
const yawQ = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
// a hull at [0, 1, 0] (a 2 × 1 × 4 box), its helm at its middle, a passenger's seat behind it
const HULL = { transform: tf([0, 1, 0]), mesh: { shape: "box", size: [2, 1, 4] }, drive: { maxSpeed: 4, turnRate: 0.5, climbRate: 1 } };
const helm = (to = "hull", extra = {}) => ({ transform: tf([0, 0.5, 0]), parent: { to }, socket: { name: "helm" }, station: { action: "drive", input: { move: "drive" }, ...extra } });
function session({ hull = HULL, seats = true }: any = {}) {
  const name = `d${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (verb: string, args: any = {}, actor = "olive", ms = 1000) => { clock.advance(ms);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  call("create-world", { title: name });
  for (const who of ["vic", "pat"]) call("set", { id: "@world", component: `roles:${who}`, value: { role: "member" } });
  if (hull) call("create", { id: "hull", components: hull });
  if (seats) { call("create", { id: "helm", components: helm() });
    call("create", { id: "back", components: { transform: tf([0, 0.5, -1.5]), parent: { to: "hull" }, socket: { name: "back" }, station: { action: "sit" } } }); }
  const board = (who: string, action = "drive") => { call("move", { to: [1.5, 0, 0] }, who); return call("use", { id: "hull", action }, who); };
  const sweep = (ms: number) => { clock.advance(ms); return D.drives?.(Wd()); };
  return { call, board, sweep, w: Wd, st: () => Wd().state(), log: () => Wd().entries };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const commits = (s: any) => s.log().filter((e: any) => e.kind === "act" && e.verb === "drive-commit");
const posOf = (s: any, id = "hull") => s.st().entities[id]?.c.transform?.pos;

let pass = 0, fail = 0;
async function C(id: string, what: string, fn: () => any) {
  if (ONLY && !ONLY.includes(id)) return;
  let r: any; try { r = await fn(); } catch (e) { r = [false, `threw: ${e?.stack ?? e}`]; }
  const [good, info] = Array.isArray(r) ? r : [r, undefined];
  if (good) { pass++; console.log(`ok   ${id} ${what}`); } else { fail++; console.log(`FAIL ${id} ${what}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 900)); }
}

await C("D1", "the door: drive needs maxSpeed and turnRate in range; station.input is {move: 'drive'} on a drive station only; a helm needs a host with drive, and one helm per host; a hull with its helm and a passenger's seat taken", () => {
  const s = session({ hull: null, seats: false }); const mk = (id: string, components: any) => s.call("create", { id, components });
  const r: any = { noTurn: mk("a", { transform: tf([5, 0, 0]), drive: { maxSpeed: 4 } }), fast: mk("b", { transform: tf([5, 0, 0]), drive: { maxSpeed: 99, turnRate: 1 } }) };
  mk("plain", { transform: tf([8, 0, 0]), mesh: { shape: "box", size: [1, 1, 1] } });
  r.noDrive = mk("h0", helm("plain"));
  r.hull = mk("hull", HULL); r.helm = mk("helm", helm()); mk("hull2", { ...HULL, transform: tf([20, 1, 0]) });
  r.sitInput = mk("x", { transform: tf([0, 0.5, 1]), parent: { to: "hull2" }, socket: { name: "x" }, station: { action: "sit", input: { move: "drive" } } });
  r.second = mk("helm2", { ...helm(), transform: tf([0, 0.5, 1]), socket: { name: "helm2" } });
  r.back = mk("back", { transform: tf([0, 0.5, -1.5]), parent: { to: "hull" }, socket: { name: "back" }, station: { action: "sit" } });
  return [!r.noTurn.ok && !r.fast.ok && !r.noDrive.ok && /no drive/.test(r.noDrive.refused?.reason ?? "") && r.hull.ok && r.helm.ok && !r.sitInput.ok && !r.second.ok && /helms/.test(r.second.refused?.reason ?? "") && r.back.ok,
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)]))]; });

await C("D2", "one driver: vic takes the helm (use … drive); pat's use of it is refused as occupied, and pat's drive step (not at the helm) is refused; vic's step is taken", () => {
  const s = session(); const took = s.board("vic"); const other = s.board("pat");
  const theirs = s.call("drive", { id: "hull", pos: [0, 1, 1], q: [0, 0, 0, 1] }, "pat"), mine = s.call("drive", { id: "hull", pos: [0, 1, 1], q: [0, 0, 0, 1] }, "vic");
  return [took.ok && took.attach?.to === "helm" && other.refused?.code === "occupied" && theirs.refused?.code === "rights" && mine.ok, { took: show(took), other: show(other), theirs: show(theirs), mine: show(mine) }]; });

await C("D3", "plausibility (per step, with slack): maxSpeed's 4 m in 1 s taken; 20 m refused too-fast with the pose that stands; a 2 rad turn refused; a climb past climbRate refused; the client's own steps (stepDrive at 15 Hz, full throttle and steer) all pass", () => {
  if (DR.__missing) return [false, DR.__missing];
  const s = session(); s.board("vic");
  const ok4 = s.call("drive", { id: "hull", pos: [0, 1, 4], q: [0, 0, 0, 1] }, "vic");
  const far = s.call("drive", { id: "hull", pos: [0, 1, 24], q: [0, 0, 0, 1] }, "vic");
  const spin = s.call("drive", { id: "hull", pos: [0, 1, 4], q: yawQ(2) }, "vic");
  const up = s.call("drive", { id: "hull", pos: [0, 4, 4], q: [0, 0, 0, 1] }, "vic");
  const spec = DR.driveOf(HULL); let pose = { pos: [0, 1, 0], q: [0, 0, 0, 1] }, vel = [0, 0, 0], worst = null;
  for (let i = 0; i < 150; i++) { const n = DR.stepDrive(pose, vel, { throttle: 1, steer: i < 75 ? 1 : 0, rise: 1 }, spec, 1 / 15); worst ??= DR.implausible(pose, n, 1 / 15, spec); pose = n; vel = n.vel; }
  const speed = Math.hypot(vel[0], vel[2]);   // the second half straight: at maxSpeed
  return [ok4.ok && far.refused?.code === "too-fast" && JSON.stringify(far.refused.pose?.pos) === "[0,1,4]" && spin.refused?.code === "too-fast" && /turn/.test(spin.refused.reason) && up.refused?.code === "too-fast" && /climb/.test(up.refused.reason)
    && worst === null && Math.abs(speed - 4) < 0.05, { ok4: show(ok4), far: [show(far), far.refused?.pose], spin: show(spin), up: show(up), worst, speed }]; });

await C("D4", "a hull driven into a wall is stopped by the authority, whatever the client claims: plausible steps toward it are taken until the hull's own box would enter the wall, then refused solid naming it, the pose standing short of it; backing off is taken", () => {
  const s = session(); s.call("create", { id: "wall", components: { transform: tf([0, 1, 6]), mesh: { shape: "box", size: [6, 3, 0.2] } } }); s.board("vic");
  const steps = [1.5, 3, 3.5].map((z) => s.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic"));
  const into = s.call("drive", { id: "hull", pos: [0, 1, 4.5], q: [0, 0, 0, 1] }, "vic");
  const back = s.call("drive", { id: "hull", pos: [0, 1, 2], q: [0, 0, 0, 1] }, "vic");
  return [steps.every((x) => x.ok) && into.refused?.code === "solid" && into.refused.blocker === "wall" && JSON.stringify(into.refused.pose?.pos) === "[0,1,3.5]" && back.ok,
    { steps: steps.map(show), into: [show(into), into.refused?.pose], back: show(back) }]; });

await C("D5", "the lease ends when the driver's steps stop (heartbeat lost): the last accepted pose commits as the system's drive-commit (why lease-lost), the helm frees, the passenger stays seated", () => {
  const s = session(); s.board("vic"); s.board("pat", "sit");
  s.call("drive", { id: "hull", pos: [0, 1, 3], q: [0, 0, 0, 1] }, "vic"); s.call("drive", { id: "hull", pos: [0, 1, 6], q: yawQ(0.4) }, "vic", 1000);
  const early = s.sweep(1000), was = commits(s).length;
  s.sweep(3000); const c = commits(s), occ = s.w().presence.occupants ?? {};
  return [early === 0 && was === 0 && c.length === 1 && c[0].actor === "system" && c[0].body?.why === "lease-lost" && c[0].body?.id === "hull" && JSON.stringify(posOf(s)) === "[0,1,6]" && !occ.vic && occ.pat?.to === "back",
    { early, was, commits: c.map((e: any) => e.body), pos: posOf(s), occ }]; });

await C("D6", "a passenger can't take the helm while it's held, and can once the lease has ended", () => {
  const s = session(); s.board("vic"); s.board("pat", "sit"); s.call("drive", { id: "hull", pos: [0, 1, 1], q: [0, 0, 0, 1] }, "vic");
  const held = s.call("use", { id: "hull", action: "drive" }, "pat");
  s.sweep(4000); const free = s.call("use", { id: "hull", action: "drive" }, "pat");
  return [held.refused?.code === "occupied" && free.ok && free.attach?.to === "helm", { held: show(held), free: show(free) }]; });

await C("D7", "getting up from the helm commits the last accepted pose (why exit) before the stand-up, so the driver's first step from the helm where it is now is taken", () => {
  const s = session(); s.board("vic");
  for (const z of [3, 6, 9]) s.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic");
  const step = s.call("move", { to: [1.8, 1.5, 9] }, "vic"); const c = commits(s);
  return [step.ok && c.length === 1 && c[0].body?.why === "exit" && JSON.stringify(posOf(s)) === "[0,1,9]" && !s.w().presence.drives?.hull, { step: show(step), commits: c.map((e: any) => e.body), pos: posOf(s) }]; });

await C("D8", "a held lease commits every few seconds (why periodic): a long drive is on the record as it goes, never only at its end", () => {
  const s = session(); s.board("vic");
  for (let z = 1; z <= 7; z++) s.call("drive", { id: "hull", pos: [0, 1, z * 2], q: [0, 0, 0, 1] }, "vic");
  const c = commits(s);
  // …and on the beat, when the steps still come but are refused (into a wall): the last accepted one is committed all the same
  const t = session(); t.call("create", { id: "wall", components: { transform: tf([0, 1, 4]), mesh: { shape: "box", size: [6, 3, 0.2] } } }); t.board("vic");
  t.call("drive", { id: "hull", pos: [0, 1, 1.5], q: [0, 0, 0, 1] }, "vic");
  for (let k = 0; k < 6; k++) { t.call("drive", { id: "hull", pos: [0, 1, 2.5], q: [0, 0, 0, 1] }, "vic"); t.sweep(10); }
  const c2 = commits(t);
  return [c.length >= 1 && c.every((e: any) => e.body?.why === "periodic") && posOf(s)[2] > 0 && c2.length === 1 && c2[0].body?.why === "periodic" && JSON.stringify(posOf(t)) === "[0,1,1.5]",
    { commits: c.map((e: any) => e.body), pos: posOf(s), c2: c2.map((e: any) => e.body), pos2: posOf(t) }]; });

await C("D9", "the lock and station.who gate who may drive: a locked hull's steps are refused locked; a helm for builders refuses a member's use", () => {
  const s = session(); s.board("vic"); s.call("set", { id: "hull", component: "lock", value: true });
  const locked = s.call("drive", { id: "hull", pos: [0, 1, 1], q: [0, 0, 0, 1] }, "vic");
  const t = session({ seats: false }); t.call("create", { id: "helm", components: helm("hull", { who: "builder" }) });
  const who = t.board("vic");
  return [locked.refused?.code === "locked" && who.refused?.code === "rights", { locked: show(locked), who: show(who) }]; });

await C("D10", "the step is swept, not only its end: a 50 m/s hull's 18 m step clean through a 0.2 m wall is refused solid naming the wall (the end pose is clear of it); the same step with no wall is taken", () => {
  const fast = { ...HULL, drive: { maxSpeed: 50, turnRate: 0.5 } };
  const s = session({ hull: fast }); s.call("create", { id: "wall", components: { transform: tf([0, 1, 9]), mesh: { shape: "box", size: [6, 3, 0.2] } } }); s.board("vic");
  const through = s.call("drive", { id: "hull", pos: [0, 1, 18], q: [0, 0, 0, 1] }, "vic");
  const t = session({ hull: fast }); t.board("vic"); const clear = t.call("drive", { id: "hull", pos: [0, 1, 18], q: [0, 0, 0, 1] }, "vic");
  return [through.refused?.code === "solid" && through.refused.blocker === "wall" && clear.ok, { through: show(through), clear: show(clear) }]; });

await C("D11", "a hull already inside a slab may only move out: a step deeper is refused solid naming the slab; a step that lessens the overlap is taken", () => {
  const s = session(); s.call("create", { id: "slab", components: { transform: tf([0, -2, 1.5]), mesh: { shape: "box", size: [10, 6, 1] } } }); s.board("vic");
  const deeper = s.call("drive", { id: "hull", pos: [0, 1, 1], q: [0, 0, 0, 1] }, "vic");
  const out = s.call("drive", { id: "hull", pos: [0, 1, -1], q: [0, 0, 0, 1] }, "vic");
  return [deeper.refused?.code === "solid" && deeper.refused.blocker === "slab" && out.ok, { deeper: show(deeper), out: show(out)}]; });

await C("D12", "sitting is consent to ride, on the record: every drive-commit names its driver and the passengers it carried (body.carried); a passenger's own stand-up mid-drive is taken (the hull commits first, why alight, so the step is measured from the seat where it is), as is their leave", () => {
  const s = session(); s.board("vic"); s.board("pat", "sit");
  for (const z of [3, 6, 9]) s.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic");
  s.sweep(1000); s.sweep(3000); const lost = commits(s).at(-1)?.body;
  const t = session(); t.board("vic"); t.board("pat", "sit");
  for (const z of [3, 6]) t.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic");
  const up = t.call("move", { to: [1.8, 1.5, 4.5] }, "pat"), alight = commits(t).at(-1)?.body;
  t.call("drive", { id: "hull", pos: [0, 1, 9], q: [0, 0, 0, 1] }, "vic"); t.call("move", { to: [1.8, 1.5, 9] }, "vic"); const exit = commits(t).at(-1)?.body;
  const u = session(); u.board("vic"); u.board("pat", "sit");
  for (const z of [3, 6]) u.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic");
  const gone = u.call("leave", {}, "pat");
  return [lost?.driver === "vic" && JSON.stringify(lost?.carried) === '["pat"]' && up.ok && alight?.why === "alight" && JSON.stringify(alight?.carried) === '["pat"]'
    && exit?.why === "exit" && JSON.stringify(exit?.carried) === "[]" && gone.ok, { lost, up: show(up), alight, exit, gone: show(gone) }]; });

await C("D13", "the fixed slack is a budget, not per message (review L26): a 60 Hz stream each 0.2 m past maxSpeed gains under 9.5 m/s over 1 s (5 + 15 × 0.25 m: per message it was ~17); an honest 15 Hz stream arriving jittered (20 / 112 ms) is taken whole", () => {
  const s = session(); s.board("vic"); let z = 0, took = 0; const why: any = {};
  for (let i = 0; i < 60; i++) { const want = z + 4 * 1.25 / 60 + 0.2, r = s.call("drive", { id: "hull", pos: [0, 1, want], q: [0, 0, 0, 1] }, "vic", 1000 / 60); if (r.ok) { z = want; took++; } else why[r.refused?.code] = (why[r.refused?.code] ?? 0) + 1; }
  const h = session(); h.board("vic"); let hz = 0, refused = 0;
  for (let i = 0; i < 30; i++) { hz += 4 / 15; const r = h.call("drive", { id: "hull", pos: [0, 1, hz], q: [0, 0, 0, 1] }, "vic", i % 2 ? 112 : 20); if (!r.ok) refused++; }
  return [z < 9.5 && took > 0 && refused === 0, { speed: z, took, why, refused }]; });

await C("D14", "a commit that throws (the log's disk fails as the driver gets up) keeps the lease (review L27): the getting-up fails, the driver is still at the helm, the lease holds the hull where it is, and the next step drives on from there (no snap back to the logged pose)", () => {
  const s = session(); s.board("vic");
  for (const z of [3, 6]) s.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic");
  diskFails.on = true; const up = s.call("move", { to: [1.8, 1.5, 6] }, "vic"); diskFails.on = false;
  const L = s.w().presence.drives?.hull, held = JSON.stringify(L?.pose?.pos), next = s.call("drive", { id: "hull", pos: [0, 1, 7], q: [0, 0, 0, 1] }, "vic");
  return [!!up.crashed && L?.by === "vic" && held === "[0,1,6]" && next.ok, { up: show(up), held, next: show(next), stands: next.refused?.pose }]; });

// collision layers (componentspec collider.blocks, R 10-28 item 50): a wall only hulls meet, a wall only bodies meet
const slab = (blocks: any, z = 6) => ({ transform: tf([0, 0, z]), mesh: { shape: "box", size: [6, 3, 0.2] }, hidden: true, collider: { blocks } });
await C("D15", "a hull-only wall (collider {blocks: ['hulls']}) stops the hull, refused solid naming it; a body walks clean through it; it is not in the physics engine's view", () => {
  const s = session(); const made = s.call("create", { id: "wall", components: slab(["hulls"]) }); s.board("vic");
  const ok = s.call("drive", { id: "hull", pos: [0, 1, 3.5], q: [0, 0, 0, 1] }, "vic"), into = s.call("drive", { id: "hull", pos: [0, 1, 4.5], q: [0, 0, 0, 1] }, "vic");
  const t = session({ hull: null, seats: false }); t.call("create", { id: "wall", components: slab(["hulls"], 3) });
  const walks = [1, 2, 3, 4, 5].map((z) => t.call("move", { to: [0, 0, z] }, "vic"));
  const S = SL.engineViewM({ entities: { crateH: { c: { transform: tf([8, 0, 8]), model: "crate", collider: { blocks: ["hulls"] } } }, crateA: { c: { transform: tf([-8, 0, 8]), model: "crate" } } } }, { crate: { size: [1, 1, 1] } });
  return [made.ok && ok.ok && into.refused?.code === "solid" && into.refused.blocker === "wall" && walks.every((w) => w.ok) && !S.entities.crateH && !!S.entities.crateA,
    { made: show(made), ok: show(ok), into: show(into), walks: walks.map(show), engine: Object.keys(S.entities) }]; });
await C("D16", "a bodies-only wall (blocks: ['bodies']) lets the hull through and stops a walking body", () => {
  const s = session(); s.call("create", { id: "wall", components: slab(["bodies"]) }); s.board("vic");
  const steps = [3, 6, 9].map((z) => s.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic"));
  const t = session({ hull: null, seats: false }); t.call("create", { id: "wall", components: slab(["bodies"], 3) });
  const walks = [1, 2, 3, 4].map((z) => t.call("move", { to: [0, 0, z] }, "vic"));
  return [steps.every((x) => x.ok) && walks.some((w) => w.refused?.code === "solid"), { steps: steps.map(show), walks: walks.map(show) }]; });
await C("D17", "the door: blocks is a list of layers (bodies, hulls, things), each once; a dynamic thing must block things; absent blocks still stops everything (D4)", () => {
  const s = session({ hull: null, seats: false }); const mk = (id: string, components: any) => s.call("create", { id, components });
  const r: any = { odd: mk("a", slab(["boats"])), twice: mk("b", slab(["hulls", "hulls"])), str: mk("c", slab("hulls")),
    dyn: mk("d", { transform: tf([9, 2, 0]), mesh: { shape: "box", size: [1, 1, 1] }, physics: { kind: "dynamic" }, collider: { blocks: ["bodies"] } }),
    good: mk("e", slab(["hulls", "things"])), empty: mk("f", slab([])) };
  return [!r.odd.ok && /isn't a layer/.test(r.odd.refused?.reason ?? "") && !r.twice.ok && !r.str.ok && !r.dyn.ok && /things/.test(r.dyn.refused?.reason ?? "") && r.good.ok && r.empty.ok,
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)]))]; });

const LEASE_BEAT = 3100;   // just past LEASE.heartbeatMs
await C("D20", "a hull's own blocks says what it stops, not what stops it (review 1.8): a boat with blocks ['bodies'] is stopped by a wall; only collider.enabled false drives through", () => {
  const run = (collider: any) => { const s = session({ hull: { ...HULL, collider } }); s.call("create", { id: "wall", components: { transform: tf([0, 0, 6]), mesh: { shape: "box", size: [6, 3, 0.2] }, hidden: true } }); s.board("vic");
    return [3, 6, 9].map((z) => s.call("drive", { id: "hull", pos: [0, 1, z], q: [0, 0, 0, 1] }, "vic")); };
  const boat = run({ blocks: ["bodies"] }), ghost = run({ enabled: false });
  return [boat.some((r) => r.refused?.code === "solid" && r.refused.blocker === "wall") && ghost.every((r) => r.ok), { boat: boat.map(show), ghost: ghost.map(show) }]; });
await C("D18", "a commit that keeps throwing is bounded (review delta-260 L-A): the stream stops, the disk keeps failing, and after a few beats the lease is dropped, the helm freed, and it is said once, not every beat", () => {
  const s = session(); s.board("vic"); s.call("drive", { id: "hull", pos: [0, 1, 3], q: [0, 0, 0, 1] }, "vic");
  const warns: string[] = [], warn = console.warn; console.warn = (m: any) => { warns.push(String(m)); };
  diskFails.on = true; const beats: string[] = [];
  try { for (let i = 0; i < 12; i++) { try { s.sweep(LEASE_BEAT); beats.push("ok"); } catch (e) { beats.push("threw"); } } } finally { diskFails.on = false; console.warn = warn; }
  const occ = s.w().presence.occupants ?? {}, said = warns.filter((m) => /drive-commit|commit/.test(m));
  return [!s.w().presence.drives?.hull && occ.vic?.to !== "helm" && beats.includes("threw") && beats.slice(-3).every((b) => b === "ok") && said.length === 1, { beats, said, occ, lease: s.w().presence.drives?.hull }]; });
await C("D19", "a drive step whose inline commit keeps failing keeps its driver at the helm and says the lease went (review delta2 L2-A)", () => {
  const s = session(); s.board("vic"); const warn = console.warn; console.warn = () => {};
  diskFails.on = true; const rs: any[] = [];
  try { for (let i = 1; i <= 40; i++) { try { rs.push(s.call("drive", { id: "hull", pos: [0, 1, 3 + i * 0.1], q: [0, 0, 0, 1] }, "vic")); } catch (e) { rs.push({ threw: true }); } } } finally { diskFails.on = false; console.warn = warn; }
  const occ = s.w().presence.occupants ?? {};
  return [rs.some((r) => r.dropped === true) && occ.vic?.to === "helm", { rs: rs.map((r) => r.threw ? "threw" : r.dropped ? "dropped" : r.ok ? "ok" : (r.refused?.code ?? JSON.stringify(r).slice(0, 80))), occ }]; });
console.log(`[drive-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
