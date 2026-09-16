// The guard's PLACER PRINCIPAL — durable authorship (Mica, #190 review).
//
//   bun tools/guard-principal-test.ts
//
// Self-contained like authtest.ts: mints a scratch Archipelago issuer, boots a
// scratch sequencer wired to it, and walks the identity legs over real
// HTTP + websockets:
//   1. RENAME: the same subject, joining under a new display name, still
//      authors its guarded thing; a stranger who takes the OLD name gets
//      nothing (a nameplate is not a deed).
//   2. BEHAVIOR FREEZE: a thing a script created belongs to the script's
//      author at creation; removing the script, or rebinding its id under
//      someone else, changes nothing.
//   3. CARGO ONTO A GUARDED CARRIER: refused for a stranger, open for the
//      placer; sitting on it stays open.
//   4. FORCE moves nothing: a stranger's force is accepted and the guarded
//      thing's folded pose is untouched.
//   5. The stamp is the SERVER's: a client-supplied `placer` is stripped.
//   6. A re-light by the owner keeps the first placer.
//   7. CARGO OFF A GUARDED CARRIER (round 2, B1): a stranger may not unload
//      what the placer loaded — dismount is gated on the CARRIER's placer,
//      as mount is; the placer and the owner may; stepping off yourself is
//      still use. Remove the carrier leg from guardRefusal's dismount branch
//      and the stranger's leg goes red.
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8993);
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DOOR = "test-door";

// ---- scratch issuer (authtest.ts's recipe) ----
const pair = generateKeyPairSync("ed25519");
const spki = createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }) as Buffer;
const ISSUER_ID = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
const ISS = "id.test";
let jtiN = 0;
function mint(sub: string, name: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, iss: ISS, sub, kind: "human", name, aud: "eidoverse", scopes: ["worlds:join", "worlds:spectate"], iat: now, exp: now + 600, jti: `t${jtiN++}` };
  const seg = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey);
  return `aid1.${seg}.${sig.toString("base64url")}`;
}
async function cookieFor(sub: string, name: string): Promise<string> {
  const r = await fetch(`${HTTP}/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: mint(sub, name) }) });
  const cookie = /ew_sess=[a-f0-9]{64}/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
  if (!cookie) throw new Error(`auth ${r.status}: ${await r.text()}`);
  return cookie;
}

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } }

type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; snap: any; verb(v: string, a: any): void; settle(ms?: number): Promise<void>; close(): void };
function open(joinMsg: Record<string, unknown>, cookie = ""): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, cookie ? ({ headers: { cookie } } as any) : undefined);
    const s: Sock = { ws, msgs: [], errors: [], snap: null, verb(v, a) { ws.send(JSON.stringify({ type: "verb", verb: v, args: a })); }, settle(ms = 350) { return new Promise((r) => setTimeout(r, ms)); }, close() { try { ws.close(); } catch {} } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: DOOR, ...joinMsg }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.msgs.push(m); if (m.type === "error") s.errors.push(m.error); if (m.type === "snapshot") { s.snap = m; resolve(s); } };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("no snapshot in 4s")), 4000);
  });
}
async function folded(world: string, id: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const ent = eye.snap.state.entities?.[id]; eye.close(); return ent;
}
const last = (s: Sock) => s.errors.at(-1) ?? "no error";
const WINDOW = 4200;   // the verb rate window (12/4s) — refusals count too

// ---- boot scratch sequencer ----
const worldsDir = mkdtempSync(join(tmpdir(), "ew-guardprincipal-"));
const optDir = mkdtempSync(join(tmpdir(), "ew-guardprincipal-opt-"));
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: DOOR, SKIP_OPT_SWEEP: "1", HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0" },
  stdout: "ignore", stderr: "inherit",
});
for (let i = 0; i < 80; i++) { try { await fetch(`${HTTP}/authcfg`); break; } catch { await Bun.sleep(150); } }

const WORLD = `principal-${Math.random().toString(36).slice(2, 8)}`;
console.log(`\nguard principal — world "${WORLD}"\n`);
try {
  const SUB_RA = "human:discord:9001", SUB_BOB = "human:discord:9002", SUB_CAROL = "human:discord:9003";
  const ra = await open({ id: "ra", world: WORLD }, await cookieFor(SUB_RA, "Ra"));   // first joiner owns
  await ra.settle();
  check("the snapshot tells a vouched-for joiner its subject (yourSub)", ra.snap.yourSub === SUB_RA, JSON.stringify(ra.snap.yourSub));
  let bob = await open({ id: "bob", world: WORLD }, await cookieFor(SUB_BOB, "Bob"));
  const carol = await open({ id: "carol", world: WORLD }, await cookieFor(SUB_CAROL, "Carol"));
  await bob.settle();

  // ---- the stamp ----
  bob.verb("spawn", { id: "frame1", lib: "deco/frame.glb", pos: [0, 0, 0], yaw: 0, placer: { id: "ra", sub: SUB_RA } });   // a forged placer
  bob.verb("spawn", { id: "truck1", lib: "deco/truck.glb", pos: [5, 0, 5], yaw: 0 });
  bob.verb("comp", { id: "frame1", type: "guard", data: true });
  bob.verb("comp", { id: "truck1", type: "guard", data: true });
  await bob.settle();
  let f = await folded(WORLD, "frame1");
  // the door names a vouched-for joiner after the token (authtest: "impostor-name" → the token's name), so read names from the snapshot
  const BOB = bob.snap.you as string;
  check("5. spawn folds a SERVER-stamped placer {id, sub}; the client's forged one is stripped", f?.placer?.id === BOB && f?.placer?.sub === SUB_BOB && BOB !== "ra", JSON.stringify(f?.placer));
  check("…and the guard went on (the stamp is what the guard matched)", f?.comp?.guard === true && bob.errors.length === 0, bob.errors.join("; "));

  // ---- 1. rename ----
  bob.close(); await ra.settle(500);
  const bobbie = await open({ id: "bobbie", world: WORLD }, await cookieFor(SUB_BOB, "Bobbie"));   // same subject, new name
  const impostor = await open({ id: "bob", world: WORLD }, await cookieFor("human:discord:9009", "Bob"));   // the OLD name, another subject
  await bobbie.settle();
  bobbie.verb("comp", { id: "frame1", type: "picture", data: { src: "eidoverse/assets/a.png", part: "picture" } });
  impostor.verb("comp", { id: "frame1", type: "picture", data: { src: "eidoverse/assets/trollface.png", part: "picture" } });
  await bobbie.settle(500);
  f = await folded(WORLD, "frame1");
  check("1. the same subject under a NEW display name still authors its guarded thing", bobbie.errors.length === 0 && f?.comp?.picture?.src === "eidoverse/assets/a.png", bobbie.errors.join("; ") + " " + JSON.stringify(f?.comp?.picture));
  check("1. a stranger wearing the placer's OLD name is refused (nameplate, not deed)", impostor.errors.length === 1 && /guarded/.test(last(impostor)), last(impostor));
  impostor.close();
  bob = bobbie;
  const BOBBIE = bobbie.snap.you as string;
  check("1. …and the renamed placer really wears a different display name", BOBBIE !== BOB, `${BOB} → ${BOBBIE}`);

  // ---- 3. cargo onto a guarded carrier; sitting stays open ----
  carol.verb("spawn", { id: "crate1", lib: "deco/crate.glb", pos: [6, 0, 6], yaw: 0 });
  await carol.settle();
  let before = carol.errors.length;
  carol.verb("mount", { id: "crate1", to: "truck1", slot: "bed" });
  await carol.settle();
  check("3. a stranger may not load cargo onto a guarded carrier", carol.errors.length === before + 1 && /guarded/.test(last(carol)) && /cargo/.test(last(carol)), last(carol));
  before = carol.errors.length;
  carol.verb("mount", { id: "carol", to: "truck1", slot: "seat" });
  await carol.settle();
  check("3. …but may sit on it (self-mount is use, not authorship)", carol.errors.length === before, carol.errors.slice(before).join("; "));
  carol.verb("dismount", { id: "carol" }); await carol.settle();
  check("3. …and steps off again (self-dismount is use too)", carol.errors.length === before, carol.errors.slice(before).join("; "));
  before = bob.errors.length;
  bob.verb("spawn", { id: "crate2", lib: "deco/crate.glb", pos: [6, 0, 7], yaw: 0 });
  bob.verb("mount", { id: "crate2", to: "truck1", slot: "bed" });
  await bob.settle();
  check("3. the placer loads cargo onto their own guarded carrier", bob.errors.length === before, bob.errors.slice(before).join("; "));

  // ---- 7. cargo OFF a guarded carrier ----
  before = carol.errors.length;
  carol.verb("dismount", { id: "crate2", pos: [6, 0, 7], yaw: 0 });
  await carol.settle();
  let crate2 = await folded(WORLD, "crate2");
  check("7. a stranger may not unload cargo from a guarded carrier (dismount is gated on the carrier's placer, like mount)", carol.errors.length === before + 1 && /guarded/.test(last(carol)) && /cargo/.test(last(carol)), last(carol));
  check("7. …and the cargo still rides it", crate2?.parent?.to === "truck1", JSON.stringify(crate2?.parent));
  before = bob.errors.length;
  bob.verb("dismount", { id: "crate2", pos: [6, 0, 7], yaw: 0 });
  await bob.settle();
  crate2 = await folded(WORLD, "crate2");
  check("7. the carrier's placer unloads it", bob.errors.length === before && crate2?.parent === undefined, bob.errors.slice(before).join("; ") + " " + JSON.stringify(crate2?.parent));
  bob.verb("mount", { id: "crate2", to: "truck1", slot: "bed" });
  await bob.settle();
  before = ra.errors.length;
  ra.verb("dismount", { id: "crate2", pos: [6, 0, 7], yaw: 0 });
  await ra.settle();
  crate2 = await folded(WORLD, "crate2");
  check("7. the world's owner overrides and unloads it", ra.errors.length === before && crate2?.parent === undefined, ra.errors.slice(before).join("; ") + " " + JSON.stringify(crate2?.parent));

  // ---- 4. force moves nothing ----
  await carol.settle(WINDOW);
  before = carol.errors.length;
  const pose0 = (await folded(WORLD, "frame1"))?.pos;
  carol.verb("force", { at: [0, 0, 0], radius: 6, power: 12 });
  await carol.settle(600);
  const pose1 = (await folded(WORLD, "frame1"))?.pos;
  check("4. a stranger's force at the guarded thing is accepted (force is a builder verb) and moves it not at all", carol.errors.length === before && JSON.stringify(pose0) === JSON.stringify(pose1), `${carol.errors.slice(before).join("; ")} ${JSON.stringify([pose0, pose1])}`);

  // ---- 2. behavior freeze ----
  // bob binds a world-level script that, on use "make", creates a light and guards it
  const src = `world.on('use', (e) => { if (e.action !== 'make') return; world.emit('light', { id: 'lamp1', pos: [1, 1, 1] }); world.emit('comp', { id: 'lamp1', type: 'guard', data: true }); });`;
  const up = await fetch(`${HTTP}/upload?as=script&token=${DOOR}`, { method: "POST", body: src });
  const path = (await up.json()).path;
  await bob.settle(WINDOW);
  bob.verb("behavior", { id: "maker", src: path });
  await bob.settle(900);
  carol.verb("use", { id: "truck1", action: "make" });   // any use; the script is world-level
  await carol.settle(800);
  let lamp = await folded(WORLD, "lamp1");
  check("2. a script's creation carries its AUTHOR's principal, frozen at creation", lamp?.placer?.id === BOBBIE && lamp?.placer?.sub === SUB_BOB && lamp?.comp?.guard === true, JSON.stringify({ placer: lamp?.placer, actor: lamp?.actor, guard: lamp?.comp?.guard, bindErrors: bob.errors }));
  bob.verb("behavior", { id: "maker", remove: true });
  await bob.settle(500);
  before = carol.errors.length;
  carol.verb("comp", { id: "lamp1", type: "look", data: { note: "mine now?" } });
  await carol.settle();
  check("2. …removing the script changes nothing: a stranger is still refused", carol.errors.length === before + 1 && /guarded/.test(last(carol)), last(carol));
  await carol.settle(WINDOW);
  carol.verb("behavior", { id: "maker", src: path });   // the same behavior id, rebound by carol
  await carol.settle(900);
  before = carol.errors.length;
  carol.verb("comp", { id: "lamp1", type: "look", data: { note: "mine now??" } });
  await carol.settle();
  check("2. …rebinding the same behavior id under a stranger transfers nothing", carol.errors.length === before + 1 && /guarded/.test(last(carol)), last(carol));
  before = bob.errors.length;
  bob.verb("comp", { id: "lamp1", type: "look", data: { note: "still mine" } });
  await bob.settle();
  check("2. …and the author (renamed, same subject) still authors it", bob.errors.length === before && (await folded(WORLD, "lamp1"))?.comp?.look?.note === "still mine", bob.errors.slice(before).join("; "));
  carol.verb("behavior", { id: "maker", remove: true });

  // ---- 6. an owner's re-light keeps the first placer ----
  ra.verb("light", { id: "lamp1", intensity: 40 });
  await ra.settle();
  lamp = await folded(WORLD, "lamp1");
  check("6. the owner brightening the guarded lamp keeps the first placer (re-light is a partial update, not re-authoring)", lamp?.placer?.id === BOBBIE && lamp?.placer?.sub === SUB_BOB && lamp?.intensity === 40 && lamp?.comp?.guard === true && ra.errors.length === 0, JSON.stringify({ placer: lamp?.placer, actor: lamp?.actor, i: lamp?.intensity }) + " " + ra.errors.join("; "));

  // ---- the old leg still holds: no subject → display id ----
  const anon = await open({ id: "dana", world: WORLD });   // no cookie: self-asserted
  await anon.settle();
  anon.verb("spawn", { id: "stool1", lib: "deco/stool.glb", pos: [2, 0, 2], yaw: 0 });
  anon.verb("comp", { id: "stool1", type: "guard", data: true });
  await anon.settle();
  const stool = await folded(WORLD, "stool1");
  check("a self-asserted joiner's thing carries {id} only and is guarded by display id (the pre-Archipelago leg)", stool?.placer?.id === anon.snap.you && stool?.placer?.sub === undefined && stool?.comp?.guard === true, JSON.stringify(stool?.placer));
  before = carol.errors.length;
  carol.verb("comp", { id: "stool1", type: "look", data: { x: 1 } });
  await carol.settle();
  check("…and a stranger is refused on it too", carol.errors.length === before + 1 && /guarded/.test(last(carol)), last(carol));

  for (const s of [ra, bob, carol, anon]) s.close();
} finally {
  proc.kill();
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
