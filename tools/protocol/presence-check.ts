// tools/protocol/presence-check.ts — presence by identity, not by a typed name (security pass 3, H2; pass 2's H-B,
// the half that wasn't fixed). Against a real sequencer: scratch port, scratch WORLDS_DIR, TRUST_NAMES (a typed name is
// its own account, local:<name>), never 8968/8970. usage: bun tools/protocol/presence-check.ts
//   PN  nobody appears under a name another ACCOUNT has claimed in the directory, present or not: an account-holder
//       arriving as an absent person's name (or one that folds to it) is shown with a disambiguator, as a present
//       collision already was; the claimant themself still arrives as themself
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
  return { ws, msgs, snap, id: snap?.you ?? snap?.cut?.youName ?? null, actor: snap?.cut?.you ?? null, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close(),
    since: (k) => msgs.slice(k) };
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

try { proc.kill(); } catch {}
console.log(`[presence-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
