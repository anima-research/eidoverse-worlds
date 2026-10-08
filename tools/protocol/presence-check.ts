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
//   PR  puppet / bodydrag / typing / whisper reach the IDENTITY the sender named (targetActor / toActor, the opaque
//       u-… id every arrive carries), not whoever wears a name: the actor wins over the name; an actor who isn't here is
//       refused (or, for a whisper, held for exactly that identity); a sender with no actor id still reaches by name
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

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
let up = false; for (let i = 0; i < 80 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok; } catch {} }
ok(up, "(setup) the server is up");

async function sock(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world: "glade", id: name, avatar: "", replica: true }));
  for (let i = 0; i < 80 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  const snap = msgs.find((m) => m.type === "snapshot");
  let rn = 0;
  return { ws, msgs, snap, actor: snap?.cut?.you ?? null, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close(),
    since: (k) => msgs.slice(k),
    at: (x, z) => ws.send(JSON.stringify({ type: "pose", pose: { p: [x, 0, z], yaw: 0, speed: 0, clip: "idle" } })),
    req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      for (let i = 0; i < 80; i++) { const r = msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r.reply; await sleep(50); } return { ok: false, timeout: true }; } };
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
  for (const s2 of [bob, carol]) for (const cls of ["pose", "move"]) await s2.req("consent", { set: { class: cls, tier: "strangers", mode: "everyone" } });
  await sleep(300);
  ok(/^u-/.test(bob.actor ?? "") && /^u-/.test(carol.actor ?? ""), "(PR setup) every joiner knows its own actor id", [bob.actor, carol.actor]);
  const arrive = mal.msgs.find((m) => m.type === "arrive" && m.id === "Carol") ?? null;
  const carolActor = arrive?.actorId ?? carol.actor;
  // the actor wins over the name
  let kb = bob.msgs.length, kc = carol.msgs.length;
  mal.send({ type: "puppet", target: "Bob", targetActor: carolActor, pose: { head: [0, 0, 0, 1] } }); await sleep(400);
  ok(carol.since(kc).some((m) => m.type === "puppet") && !bob.since(kb).some((m) => m.type === "puppet"), "PR a puppet goes to the identity named (targetActor), not whoever wears the typed name",
    { carol: carol.since(kc).map((m) => m.type), bob: bob.since(kb).map((m) => m.type) });
  kb = bob.msgs.length; kc = carol.msgs.length;
  mal.send({ type: "bodydrag", target: "Bob", targetActor: carolActor, grab: { joint: "hips" } }); await sleep(400);
  ok(carol.since(kc).some((m) => m.type === "bodydrag") && !bob.since(kb).some((m) => m.type === "bodydrag"), "PR a bodydrag likewise", { carol: carol.since(kc).map((m) => m.type), bob: bob.since(kb).map((m) => m.type) });
  kb = bob.msgs.length; kc = carol.msgs.length;
  mal.send({ type: "typing", to: "Bob", toActor: carolActor }); await sleep(400);
  // typing is a broadcast; its `to` says who it's for — the identity named, by name and actor, not the typed name
  const ty = bob.since(kb).find((m) => m.type === "typing" && m.id === "Mallory");
  ok(ty && ty.to === "Carol" && ty.toActor === carolActor, "PR a typing-to names the identity (toActor), not whoever wears the typed name", { bob: bob.since(kb).filter((m) => m.type === "typing"), carol: carol.since(kc).filter((m) => m.type === "typing") });
  kb = bob.msgs.length; kc = carol.msgs.length;
  mal.send({ type: "whisper", to: "Bob", toActor: carolActor, text: "for carol" }); await sleep(400);
  ok(carol.since(kc).some((m) => m.type === "whisper" && m.text === "for carol") && !bob.since(kb).some((m) => m.type === "whisper"), "PR a whisper likewise", { carol: carol.since(kc).filter((m) => m.type === "whisper"), bob: bob.since(kb).filter((m) => m.type === "whisper") });
  // an actor who isn't here: refused, never re-routed by the name beside it
  kb = bob.msgs.length; const km = mal.msgs.length;
  mal.send({ type: "puppet", target: "Bob", targetActor: "u-aaaaaaaaaaaaaaaaaaaa", ragdoll: true }); await sleep(400);
  ok(!bob.since(kb).some((m) => m.type === "puppet") && mal.since(km).some((m) => m.type === "error" && /isn't here/.test(m.error)), "PR an actor who isn't here is refused (the name beside it is not a fallback)", mal.since(km));
  // a whisper to an absent identity is held for exactly that identity
  const carolId = carolActor; carol.close(); await sleep(300);
  mal.send({ type: "whisper", to: "Carol", toActor: carolId, text: "held for carol" }); await sleep(300);
  const carol2 = await sock("Carol"); await sleep(400);
  ok(carol2.msgs.some((m) => m.type === "whisper" && m.text === "held for carol"), "PR a whisper to an absent identity is held for that identity, and handed over when it arrives", carol2.msgs.filter((m) => m.type === "whisper"));
  // the old wire (an agent, an older client): a name alone still reaches its person
  kb = bob.msgs.length;
  mal.send({ type: "puppet", target: "Bob", pose: { head: [0, 0, 0, 1] } }); await sleep(400);
  ok(bob.since(kb).some((m) => m.type === "puppet" && m.by === "Mallory"), "PR a name alone (no actor id) still reaches its person", bob.since(kb).map((m) => m.type));
  ok(bob.since(kb).find((m) => m.type === "puppet")?.byActor === mal.actor, "PR the receiver is told the sender's identity too (byActor), not only a name", bob.since(kb).find((m) => m.type === "puppet"));
  bob.close(); carol2.close(); mal.close(); }

// ---- BC: body consent and range at the server, before anything is forwarded ----
{ const vic = await sock("Vic"), sly = await sock("Sly");
  vic.at(0, 0); sly.at(1, 0); await sleep(300);
  const got = (k, t) => vic.since(k).filter((m) => m.type === t);
  let k = vic.msgs.length, ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await sleep(300);
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /shove/.test(m.error) && /consent|isn't taking/.test(m.error)),
    "BC1 a stranger's knock-over of a body that never set a table (Normal: shove nobody) is refused at the server, never forwarded", { vic: got(k, "puppet"), sly: sly.since(ks).filter((m) => m.type === "error") });
  k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, pose: { head: [0, 0, 0, 1] } }); await sleep(300);
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /pose/.test(m.error)), "BC1 …and a pose likewise (pose nobody)", sly.since(ks));
  k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "bodydrag", target: "Vic", targetActor: vic.actor, grab: { joint: "hips" } }); await sleep(300);
  ok(got(k, "bodydrag").length === 0, "BC1 …and a drag's grab likewise (move nobody)", got(k, "bodydrag"));
  // Vic opens shove and move to everyone: now it's forwarded, within reach
  const r1 = await vic.req("consent", { set: { class: "shove", tier: "strangers", mode: "everyone" } });
  const r2 = await vic.req("consent", { set: { class: "move", tier: "strangers", mode: "everyone" } });
  ok(r1?.ok && r2?.ok, "(BC setup) Vic opens shove and move to strangers through the authority's consent verb", [r1, r2]);
  k = vic.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await sleep(300);
  ok(got(k, "puppet").length === 1, "BC2 with Vic's table saying everyone, the knock-over is forwarded", vic.since(k).map((m) => m.type));
  k = vic.msgs.length;
  sly.send({ type: "bodydrag", target: "Vic", targetActor: vic.actor, grab: { joint: "hips" } }); await sleep(300);
  ok(got(k, "bodydrag").length === 1, "BC2 …and the grab", vic.since(k).map((m) => m.type));
  // range: from 20 m, no
  sly.at(20, 0); await sleep(300); k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await sleep(300);
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /away/.test(m.error)), "BC3 a knock-over from 20 m is refused (out of reach), whatever the table says", sly.since(ks));
  // ask: refused, saying how to ask
  sly.at(1, 0); await vic.req("consent", { set: { class: "pose", tier: "strangers", mode: "ask" } }); await sleep(300);
  k = vic.msgs.length; ks = sly.msgs.length;
  sly.send({ type: "puppet", target: "Vic", targetActor: vic.actor, pose: { head: [0, 0, 0, 1] } }); await sleep(300);
  ok(got(k, "puppet").length === 0 && sly.since(ks).some((m) => m.type === "error" && /ask/.test(m.error) && /body/.test(m.error)), "BC4 'ask' is refused with how to ask (body {to, kind}), not forwarded", sly.since(ks));
  // the ask path delivers: the authority's inbox reaches Vic's socket
  const mv = [await vic.req("move", { to: [0, 0, 0] }), await sly.req("move", { to: [1, 0, 0] })];   // the authority's body track (a client's first move is its arrival)
  ok(mv.every((r) => r?.ok), "(BC5 setup) both bodies are on the authority's track", mv);
  k = vic.msgs.length;
  const asked = await sly.req("body", { to: vic.actor, kind: "pose", spec: { head: [0, 0, 0, 1] } });
  await sleep(300);
  ok(asked?.outcome === "asked" && vic.since(k).some((m) => m.type === "body-inbox" && m.messages?.some((x) => x.type === "body-ask")), "BC5 an ask through the authority (body {to, kind}) reaches the asked person's socket (the inbox is forwarded)",
    { asked, vic: vic.since(k).filter((m) => m.type === "body-inbox") });
  // yourself: always
  k = vic.msgs.length;
  vic.send({ type: "puppet", target: "Vic", targetActor: vic.actor, ragdoll: true }); await sleep(300);
  ok(got(k, "puppet").length === 1, "BC6 your own body is always yours to knock over", vic.since(k).map((m) => m.type));
  vic.close(); sly.close(); }

try { proc.kill(); } catch {}
console.log(`[presence-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
