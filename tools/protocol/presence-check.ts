// tools/protocol/presence-check.ts — presence by identity, not by a typed name (security pass 3, H2; pass 2's H-B,
// the half that wasn't fixed). Against a real sequencer: scratch port, scratch WORLDS_DIR, TRUST_NAMES (a typed name is
// its own account, local:<name>), never 8968/8970. usage: bun tools/protocol/presence-check.ts
//   PN  nobody appears under a name another ACCOUNT has claimed in the directory, present or not: an account-holder
//       arriving as an absent person's name (or one that folds to it) is shown with a disambiguator, as a present
//       collision already was; the claimant themself still arrives as themself
//   BC  body consent at the server (tools audit 10-07 "Body consent"): a puppet (ragdoll → shove, pose/anim → pose) and a
//       bodydrag grab (→ move) are checked against the TARGET's consent table (shared/protocol/consent.js; silence is
//       Normal: strangers' shove/pose/move are nobody) and a sane range BEFORE they're forwarded; 'ask' refuses with how to
//       ask; the authority's body inbox (asks, replies, acts) is pushed to its person's socket
//   PR  puppet / bodydrag / typing reach the IDENTITY the sender named (targetActor / toActor, the opaque u-… id every
//       arrive carries), not whoever wears a name: the actor wins over the name; an actor who isn't here is refused; a
//       sender with no actor id still reaches by name. (whisper did too until it was removed, R 10-18: now it reaches nobody)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { tryUntil, pause } from "./wait.ts";

const root = scratch("presence");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
const r0 = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "glade", "--owner", "Ann"], { cwd: ENGINE, env: env() });
ok(r0.exitCode === 0, "(setup) found glade, Ann owns it", r0.stderr.toString().slice(-300));
let port = 9420; for (; port < 9500; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
const logf = path.join(root, "srv.log");
const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
process.on("exit", () => { try { proc.kill(); } catch {} });
const up = !!(await tryUntil("the server answers /version", async () => (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok, { ms: 76_000, step: 150 }));
ok(up, "(setup) the server is up");

async function sock(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world: "glade", id: name, avatar: "", replica: true }));
  await tryUntil(`${name}'s join is answered`, () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 4000, step: 50 });
  const snap = msgs.find((m) => m.type === "snapshot");
  let rn = 0;
  return { ws, msgs, snap, actor: snap?.cut?.you ?? null, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close(),
    since: (k) => msgs.slice(k),
    at: (x, z) => ws.send(JSON.stringify({ type: "pose", pose: { p: [x, 0, z], yaw: 0, speed: 0, clip: "idle" } })),
    req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      const r = await tryUntil(`the reply to ${verb}`, () => msgs.find((m) => m.type === "reply" && m.id === id), { ms: 4000, step: 50 }); return r ? r.reply : { ok: false, timeout: true }; } };
}
const named = (s) => s.snap?.you;   // the display name the server settled on

// ---- PN: no one appears under a name another account claimed ----
{ const ann = await sock("Ann"); ok(named(ann) === "Ann", "(PN setup) Ann arrives as Ann", named(ann)); ann.close(); await sleep(300);
  const imp = await sock("Ann.");   // folds to "ann"; a different account (local:ann.)
  ok(!!imp.snap && named(imp) !== "Ann." && /^Ann\./.test(named(imp)) && named(imp).length > 4, "PN an account arriving as an absent person's name (folded) is shown with a disambiguator", named(imp));
  imp.close(); await sleep(300);
  const ann2 = await sock("Ann"); ok(named(ann2) === "Ann", "PN …and the claimant still arrives as herself", named(ann2)); ann2.close(); await sleep(300); }

// ---- PR: presence targets resolve by identity ----
{ const bob = await sock("Bob"), carol = await sock("Carol"), mal = await sock("Mallory");
  // within reach, and both open pose and move to strangers (BC: the server checks a body's consent before forwarding)
  bob.at(0, 0); carol.at(1, 0); mal.at(0.5, 0.5);
  for (const s2 of [bob, carol]) await s2.req("consent", { switch: "accept" });
  await sleep(300);
  ok(/^u-/.test(bob.actor ?? "") && /^u-/.test(carol.actor ?? ""), "(PR setup) every joiner knows its own actor id", [bob.actor, carol.actor]);
  const arrive = mal.msgs.find((m) => m.type === "arrive" && m.id === "Carol") ?? null;
  const carolActor = arrive?.actorId ?? carol.actor;
  // the actor wins over the name
  let kb = bob.msgs.length, kc = carol.msgs.length;
  mal.send({ type: "puppet", target: "Bob", targetActor: carolActor, pose: { head: [0, 0, 0, 1] } }); await tryUntil("Carol is sent the puppet", () => carol.since(kc).some((m) => m.type === "puppet"), { ms: 2000 });
  ok(carol.since(kc).some((m) => m.type === "puppet") && !bob.since(kb).some((m) => m.type === "puppet"), "PR a puppet goes to the identity named (targetActor), not whoever wears the typed name",
    { carol: carol.since(kc).map((m) => m.type), bob: bob.since(kb).map((m) => m.type) });
  kb = bob.msgs.length; kc = carol.msgs.length;
  mal.send({ type: "bodydrag", target: "Bob", targetActor: carolActor, grab: { joint: "hips" } }); await tryUntil("Carol is sent the bodydrag", () => carol.since(kc).some((m) => m.type === "bodydrag"), { ms: 2000 });
  ok(carol.since(kc).some((m) => m.type === "bodydrag") && !bob.since(kb).some((m) => m.type === "bodydrag"), "PR a bodydrag likewise", { carol: carol.since(kc).map((m) => m.type), bob: bob.since(kb).map((m) => m.type) });
  kb = bob.msgs.length; kc = carol.msgs.length;
  mal.send({ type: "typing", to: "Bob", toActor: carolActor }); await tryUntil("Bob is sent Mallory's typing", () => bob.since(kb).some((m) => m.type === "typing" && m.id === "Mallory"), { ms: 2000 });
  // typing is a broadcast; its `to` says who it's for — the identity named, by name and actor, not the typed name
  const ty = bob.since(kb).find((m) => m.type === "typing" && m.id === "Mallory");
  ok(ty && ty.to === "Carol" && ty.toActor === carolActor, "PR a typing-to names the identity (toActor), not whoever wears the typed name", { bob: bob.since(kb).filter((m) => m.type === "typing"), carol: carol.since(kc).filter((m) => m.type === "typing") });
  kb = bob.msgs.length; kc = carol.msgs.length;
  { const km0 = mal.msgs.length; mal.send({ type: "whisper", to: "Bob", toActor: carolActor, text: "for carol" }); await tryUntil("Mallory is told the whisper was removed", () => mal.since(km0).some((m) => m.type === "error" && m.refused?.code === "removed"), { ms: 2000 });
    const leaked = [...carol.since(kc), ...bob.since(kb)].some((m) => m.type === "whisper" || JSON.stringify(m).includes("for carol"));
    ok(!leaked && mal.since(km0).some((m) => m.type === "error" && m.refused?.code === "removed"), "PR a whisper (removed, R 10-18) reaches neither the identity named nor the name: the sender is told it was removed", { mal: mal.since(km0), leaked }); }
  // an actor who isn't here: refused, never re-routed by the name beside it
  kb = bob.msgs.length; const km = mal.msgs.length;
  mal.send({ type: "puppet", target: "Bob", targetActor: "u-aaaaaaaaaaaaaaaaaaaa", ragdoll: true }); await tryUntil("Mallory is told the actor isn't here", () => mal.since(km).some((m) => m.type === "error" && /isn't here/.test(m.error)), { ms: 2000 });
  ok(!bob.since(kb).some((m) => m.type === "puppet") && mal.since(km).some((m) => m.type === "error" && /isn't here/.test(m.error)), "PR an actor who isn't here is refused (the name beside it is not a fallback)", mal.since(km));
  // a whisper to an absent identity is held for nobody now (it was held for exactly that identity, until whisper was removed)
  const carolId = carolActor; carol.close(); await sleep(300);
  mal.send({ type: "whisper", to: "Carol", toActor: carolId, text: "held for carol" }); await sleep(300);
  const carol2 = await sock("Carol"); await pause("anything held for Carol has had its chance to arrive (nothing must)", 400);
  ok(!carol2.msgs.some((m) => m.type === "whisper" || JSON.stringify(m).includes("held for carol")), "PR a whisper to an absent identity is held for nobody: nothing is handed over when they arrive", carol2.msgs.filter((m) => m.type === "whisper"));
  // the old wire (an agent, an older client): a name alone still reaches its person
  kb = bob.msgs.length;
  mal.send({ type: "puppet", target: "Bob", pose: { head: [0, 0, 0, 1] } }); await tryUntil("Bob is sent Mallory's puppet", () => bob.since(kb).some((m) => m.type === "puppet" && m.by === "Mallory"), { ms: 2000 });
  ok(bob.since(kb).some((m) => m.type === "puppet" && m.by === "Mallory"), "PR a name alone (no actor id) still reaches its person", bob.since(kb).map((m) => m.type));
  ok(bob.since(kb).find((m) => m.type === "puppet")?.byActor === mal.actor, "PR the receiver is told the sender's identity too (byActor), not only a name", bob.since(kb).find((m) => m.type === "puppet"));
  bob.close(); carol2.close(); mal.close(); }

// ---- BC: body consent and range at the server, before anything is forwarded ----
{ const vic = await sock("Vic"), sly = await sock("Sly");
  vic.at(0, 0); sly.at(1, 0); await sleep(300);
  const got = (k, t) => vic.since(k).filter((m) => m.type === t);
  // recut A2 (R 10-20): an untouched body ACCEPTS (permissive default); the gate is exercised by Vic choosing refuse
  const r0 = await vic.req("consent", { switch: "refuse" }); ok(r0?.ok, "(BC1 setup) Vic sets her body to refuse", r0);
  let k = vic.msgs.length, ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await tryUntil("Sly is told the knock-over is refused", () => sly.since(ks).some((m) => m.type === "error" && /shove/.test(m.error)), { ms: 2000 });
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /shove/.test(m.error) && /consent|isn't taking/.test(m.error)),
    "BC1 a stranger's knock-over of a body set to refuse is refused at the server, never forwarded", { vic: got(k, "puppet"), sly: sly.since(ks).filter((m) => m.type === "error") });
  k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, pose: { head: [0, 0, 0, 1] } }); await tryUntil("Sly is told the pose is refused", () => sly.since(ks).some((m) => m.type === "error" && /pose/.test(m.error)), { ms: 2000 });
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /pose/.test(m.error)), "BC1 …and a pose likewise", sly.since(ks));
  k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "bodydrag", target: "Vic", targetActor: vic.actor, grab: { joint: "hips" } }); await pause("a refused grab has had its chance to be forwarded (it must not)", 300);
  ok(got(k, "bodydrag").length === 0, "BC1 …and a drag's grab likewise", got(k, "bodydrag"));
  // Vic opens shove and move to everyone: now it's forwarded, within reach
  const r1 = await vic.req("consent", { switch: "accept" }), r2 = r1;
  ok(r1?.ok, "(BC setup) Vic sets her body back to accept through the authority's consent verb", r1);
  k = vic.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await tryUntil("Vic is sent the knock-over", () => got(k, "puppet").length, { ms: 2000 }); await pause("a second copy would arrive within the old window", 300);
  ok(got(k, "puppet").length === 1, "BC2 with Vic's table saying everyone, the knock-over is forwarded", vic.since(k).map((m) => m.type));
  k = vic.msgs.length;
  sly.send({ type: "bodydrag", target: "Vic", targetActor: vic.actor, grab: { joint: "hips" } }); await tryUntil("Vic is sent the grab", () => got(k, "bodydrag").length, { ms: 2000 }); await pause("a second copy would arrive within the old window", 300);
  ok(got(k, "bodydrag").length === 1, "BC2 …and the grab", vic.since(k).map((m) => m.type));
  // range: from 20 m, no
  sly.at(20, 0); await sleep(300); k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await tryUntil("Sly is told he is too far away", () => sly.since(ks).some((m) => m.type === "error" && /away/.test(m.error)), { ms: 2000 });
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /away/.test(m.error)), "BC3 a knock-over from 20 m is refused (out of reach), whatever the table says", sly.since(ks));
  // ask: refused, saying how to ask
  sly.at(1, 0); await vic.req("consent", { switch: "ask" }); await sleep(300);
  k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, pose: { head: [0, 0, 0, 1] } }); await tryUntil("Sly is told how to ask", () => sly.since(ks).some((m) => m.type === "error" && /ask/.test(m.error)), { ms: 2000 });
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /ask/.test(m.error) && /body/.test(m.error)), "BC4 'ask' is refused with how to ask (body {to, kind}), not forwarded", sly.since(ks));
  // the ask path delivers: the authority's inbox reaches Vic's socket
  const mv = [await vic.req("move", { to: [0, 0, 0] }), await sly.req("move", { to: [1, 0, 0] })];   // the authority's body track (a client's first move is its arrival)
  ok(mv.every((r) => r?.ok), "(BC5 setup) both bodies are on the authority's track", mv);
  k = vic.msgs.length;
  const asked = await sly.req("body", { to: vic.actor, kind: "pose", spec: { head: [0, 0, 0, 1] } });
  await tryUntil("the ask reaches Vic's socket", () => vic.since(k).some((m) => m.type === "body-inbox" && m.messages?.some((x) => x.type === "body-ask")), { ms: 2000 });
  ok(asked?.outcome === "asked" && vic.since(k).some((m) => m.type === "body-inbox" && m.messages?.some((x) => x.type === "body-ask")), "BC5 an ask through the authority (body {to, kind}) reaches the asked person's socket (the inbox is forwarded)",
    { asked, vic: vic.since(k).filter((m) => m.type === "body-inbox") });
  // yourself: always
  k = vic.msgs.length;
  vic.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await tryUntil("Vic is sent her own knock-over", () => got(k, "puppet").length, { ms: 2000 }); await pause("a second copy would arrive within the old window", 300);
  ok(got(k, "puppet").length === 1, "BC6 your own body is always yours to knock over", vic.since(k).map((m) => m.type));
  vic.close(); sly.close(); }

try { proc.kill(); } catch {}
console.log(`[presence-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
