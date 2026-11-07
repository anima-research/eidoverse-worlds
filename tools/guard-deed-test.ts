// The guard × deed interaction — the leg Mica named owed once #190 and #187
// were both on main: the DEED is the authority for caption; the GUARD
// governs everything else on the same entity. Two rights systems on one
// screen, composed by disjoint verb sets, and this file pins the seam so
// nobody "unifies" it later by accident.
//
//   bun tools/guard-deed-test.ts
//
// Self-booted scratch sequencer + scratch Archipelago issuer (the
// caption-verb-test recipe), real websockets. Own port + worlds dir, per
// the one-sequencer-per-suite rule.
//
//   A. THE DEED CROSSES THE GUARD — a visitor's deed captions a GUARDED
//      screen; a builder without the deed is refused with the DEED line,
//      not the guard line (which authority answered is part of the
//      contract).
//   B. THE GUARD HOLDS EVERYTHING ELSE — gate order is rank, then deed,
//      then guard: the deed-holding visitor hitting `comp` is refused by
//      RANK; a builder hitting `comp`/`place`/`remove` on the guarded
//      screen is refused by the GUARD.
//   C. THE PLACER IS NOT A CAPTIONER — the one who hung and guarded the
//      screen still needs the deed to caption it.
//   D. THE OWNER OVERRIDES BOTH — comps the guarded screen, captions it,
//      no deed held.
//   E. GUARD TOGGLING LEAVES THE DEED ALONE — unguard, reguard, the
//      captioner continues (same born).
//   F. REPLACEMENT REVOKES — only the placer (or owner) may remove/respawn
//      the guarded screen, and doing so invalidates every caption deed on
//      it ("replaced"); a regrant restores.
//   G. THE CAPTIONS COMP DOOR STAYS SHUT FOR EVERYONE — builder gets the
//      guard's refusal, the placer and even the OWNER get the
//      server-written-bag refusal: guard passage is not comp-captions
//      passage.
//   H. LOCK GATES NEITHER — a locked, guarded screen still takes captions.
//   I. THE OWNER MAY DEED A CAPTIONER ONTO SOMEONE ELSE'S GUARDED SCREEN —
//      guard says "mine to author", grant is owner rank, and the owner's
//      override extends to attaching captioners; the new deed works.
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8997);
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DOOR = "test-door";
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- scratch issuer (authtest.ts's recipe, via caption-verb-test) ----
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

type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; snap: any; closed: boolean; verb(v: string, a: any): void; settle(ms?: number): Promise<void>; close(): void };
function open(joinMsg: Record<string, unknown>, cookie = ""): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, cookie ? ({ headers: { cookie } } as any) : undefined);
    const s: Sock = { ws, msgs: [], errors: [], snap: null, closed: false, verb(v, a) { ws.send(JSON.stringify({ type: "verb", verb: v, args: a })); }, settle(ms = 300) { return sleep(ms); }, close() { try { ws.close(); } catch {} } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: DOOR, ...joinMsg }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.msgs.push(m); if (m.type === "error") s.errors.push(m.error); if (m.type === "snapshot") { s.snap = m; resolve(s); } };
    ws.onclose = () => { s.closed = true; };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("no snapshot in 4s")), 4000);
  });
}
async function folded(world: string, id: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const ent = eye.snap.state.entities?.[id]; eye.close(); return ent;
}
const last = (s: Sock) => s.errors.at(-1) ?? "no error";
const S1 = "2026-09-30T21:00:00.000Z-gd01";
const cap = (n: number, text: string, id = "screen") => ({ id, session: S1, n, t0: n, t1: n + 1, text });

const worldsDir = mkdtempSync(join(tmpdir(), "ew-guarddeed-"));
const optDir = mkdtempSync(join(tmpdir(), "ew-guarddeed-opt-"));
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: DOOR, SKIP_OPT_SWEEP: "1", VERB_RATE: "60", HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0" },
  stdout: "ignore", stderr: "inherit",
});
for (let i = 0; ; i++) { try { await fetch(`${HTTP}/authcfg`); break; } catch { if (i > 80) throw new Error("server never came up"); await sleep(150); } }

const WORLD = `guarddeed-${Math.random().toString(36).slice(2, 8)}`;
console.log(`\nguard × deed — world "${WORLD}"\n`);
try {
  const SUB_RA = "human:discord:9101", SUB_PLACER = "human:discord:9102", SUB_CAP = "human:discord:9103", SUB_BOB = "human:discord:9104";
  const ra = await open({ id: "ra", world: WORLD }, await cookieFor(SUB_RA, "Ra"));            // first joiner owns
  await ra.settle();
  const placer = await open({ id: "hesper", world: WORLD }, await cookieFor(SUB_PLACER, "Hesper")); // builder by default
  const bob = await open({ id: "bob", world: WORLD }, await cookieFor(SUB_BOB, "Bob"));        // builder by default
  let capbot = await open({ id: "capbot", world: WORLD }, await cookieFor(SUB_CAP, "Capbot"));
  await capbot.settle();
  const CAP = capbot.snap.you as string;
  placer.verb("spawn", { id: "screen", lib: "deco/screen.glb", pos: [0, 0, 0], yaw: 0 });
  await placer.settle();
  placer.verb("comp", { id: "screen", type: "guard", data: true });
  ra.verb("grant", { id: CAP, role: "visitor" });
  await ra.settle();
  ra.verb("grant", { id: CAP, caption: "screen" });
  await ra.settle();
  const g0 = await folded(WORLD, "screen");
  check("setup: the screen is guarded by its placer and the visitor holds its deed", !!g0?.comp?.guard && (await (async () => { const eye = await open({ id: "eye0", world: WORLD, spectate: true }); const ok = eye.snap.state.roles?.[CAP]?.caption?.id === "screen"; eye.close(); return ok; })()), JSON.stringify({ guard: g0?.comp?.guard }));

  console.log("— A. the deed crosses the guard —");
  let before = capbot.errors.length;
  capbot.verb("caption", cap(1, "the deed speaks through the guard"));
  await capbot.settle();
  let s = await folded(WORLD, "screen");
  check("the deed-holding visitor captions the GUARDED screen", capbot.errors.length === before && s?.comp?.captions?.n === 1, capbot.errors.slice(before).join("; "));
  before = bob.errors.length;
  bob.verb("caption", cap(2, "no deed, no line"));
  await bob.settle();
  check("a builder without the deed is refused by the DEED, not the guard", bob.errors.length === before + 1 && /caption deed/.test(last(bob)) && !/guarded/.test(last(bob)), last(bob));

  console.log("— B. the guard holds everything else —");
  before = capbot.errors.length;
  capbot.verb("comp", { id: "screen", type: "tint", data: "#ff00ff" });
  await capbot.settle();
  check("the deed-holder hitting comp is refused by RANK (deed grants captioning, nothing else)", capbot.errors.length === before + 1 && /builder rights/.test(last(capbot)) && !/guarded/.test(last(capbot)), last(capbot));
  before = bob.errors.length;
  bob.verb("comp", { id: "screen", type: "tint", data: "#ff00ff" });
  await bob.settle();
  check("a builder's comp on the guarded screen is refused by the GUARD", bob.errors.length === before + 1 && /is guarded/.test(last(bob)), last(bob));
  bob.verb("place", { id: "screen", pos: [5, 0, 5], yaw: 0 });
  await bob.settle();
  check("…and so is moving it", bob.errors.length === before + 2 && /is guarded/.test(last(bob)) && /move/.test(last(bob)), last(bob));
  bob.verb("remove", { id: "screen" });
  await bob.settle();
  check("…and removing it", bob.errors.length === before + 3 && /is guarded/.test(last(bob)) && (await folded(WORLD, "screen")) != null, last(bob));

  console.log("— C. the placer is not a captioner —");
  before = placer.errors.length;
  placer.verb("caption", cap(3, "my screen, surely"));
  await placer.settle();
  check("the placer who hung and guarded the screen still needs the deed", placer.errors.length === before + 1 && /caption deed/.test(last(placer)), last(placer));

  console.log("— D. the owner overrides both —");
  before = ra.errors.length;
  ra.verb("comp", { id: "screen", type: "tint", data: "#003366" });
  ra.verb("caption", cap(4, "the owner needs no deed"));
  await ra.settle();
  s = await folded(WORLD, "screen");
  check("the owner comps and captions the guarded screen, no deed held", ra.errors.length === before && s?.comp?.tint === "#003366" && s?.comp?.captions?.n === 4, ra.errors.slice(before).join("; "));

  console.log("— E. guard toggling leaves the deed alone —");
  placer.verb("comp", { id: "screen", type: "guard", data: null });
  await placer.settle();
  placer.verb("comp", { id: "screen", type: "guard", data: true });
  await placer.settle();
  before = capbot.errors.length;
  capbot.verb("caption", cap(5, "still mine to caption"));
  await capbot.settle();
  check("unguard + reguard: the captioner continues (same born, same deed)", capbot.errors.length === before && (await folded(WORLD, "screen"))?.comp?.captions?.n === 5, capbot.errors.slice(before).join("; "));

  console.log("— F. replacement revokes —");
  placer.verb("remove", { id: "screen" });
  await placer.settle();
  placer.verb("spawn", { id: "screen", lib: "deco/screen.glb", pos: [0, 0, 0], yaw: 0 });
  await placer.settle();
  placer.verb("comp", { id: "screen", type: "guard", data: true });
  await placer.settle();
  before = capbot.errors.length;
  capbot.verb("caption", cap(6, "same name, new thing"));
  await capbot.settle();
  check("the placer's remove+respawn invalidates the deed (\"replaced\")", capbot.errors.length === before + 1 && /replaced since the caption deed/.test(last(capbot)), last(capbot));
  ra.verb("grant", { id: CAP, caption: "screen" });
  await ra.settle();
  before = capbot.errors.length;
  capbot.verb("caption", cap(7, "granted anew"));
  await capbot.settle();
  check("a regrant binds to the new generation and the captioner continues", capbot.errors.length === before && (await folded(WORLD, "screen"))?.comp?.captions?.n === 7, capbot.errors.slice(before).join("; "));

  console.log("— G. the captions comp door stays shut for everyone —");
  before = bob.errors.length;
  bob.verb("comp", { id: "screen", type: "captions", data: { session: "x", n: 99 } });
  await bob.settle();
  check("a builder gets the guard's refusal at the captions comp", bob.errors.length === before + 1 && /is guarded/.test(last(bob)), last(bob));
  before = placer.errors.length;
  placer.verb("comp", { id: "screen", type: "captions", data: { session: "x", n: 99 } });
  await placer.settle();
  check("the PLACER passes the guard and still hits the server-written-bag refusal", placer.errors.length === before + 1 && /caption/.test(last(placer)) && !/is guarded/.test(last(placer)), last(placer));
  before = ra.errors.length;
  ra.verb("comp", { id: "screen", type: "captions", data: { session: "x", n: 99 } });
  await ra.settle();
  check("…and so does the OWNER: the bag is server-written for everyone", ra.errors.length === before + 1 && /caption/.test(last(ra)), last(ra));
  check("and the bag was not disturbed by any of it", (await folded(WORLD, "screen"))?.comp?.captions?.n === 7, JSON.stringify((await folded(WORLD, "screen"))?.comp?.captions));

  console.log("— H. lock gates neither —");
  placer.verb("comp", { id: "screen", type: "lock", data: true });
  await placer.settle();
  before = capbot.errors.length;
  capbot.verb("caption", cap(8, "locked and guarded and still speaking"));
  await capbot.settle();
  check("a locked, guarded screen still takes captions (the deed is the authority)", capbot.errors.length === before && (await folded(WORLD, "screen"))?.comp?.captions?.n === 8, capbot.errors.slice(before).join("; "));

  console.log("— I. the owner may deed a captioner onto someone else's guarded screen —");
  const BOB = bob.snap.you as string;
  before = ra.errors.length;
  ra.verb("grant", { id: BOB, caption: "screen" });
  await ra.settle();
  check("the grant lands despite the guard (grant is owner rank; guard gates authoring, not deeding)", ra.errors.length === before, ra.errors.slice(before).join("; "));
  before = bob.errors.length;
  bob.verb("caption", { ...cap(9, "the second captioner"), session: "2026-09-30T22:00:00.000Z-gd02", n: 1 });
  await bob.settle();
  check("…but an OLDER leg is superseded: two deeds never mean two live captioners (#187's arbitration composes with the guard)", bob.errors.length === before + 1 && /superseded captioner/.test(last(bob)), last(bob));
  bob.close(); await sleep(300);
  const bob2 = await open({ id: "bob", world: WORLD }, await cookieFor(SUB_BOB, "Bob"));
  await bob2.settle();
  before = bob2.errors.length;
  bob2.verb("caption", { ...cap(9, "the second captioner, rejoined"), session: "2026-09-30T22:00:00.000Z-gd02", n: 1 });
  await bob2.settle();
  s = await folded(WORLD, "screen");
  check("…and after rejoining (newest leg) the newly deeded builder captions the guarded screen", bob2.errors.length === before && s?.comp?.captions?.session === "2026-09-30T22:00:00.000Z-gd02", bob2.errors.slice(before).join("; ") + " " + JSON.stringify(s?.comp?.captions?.session));
  bob2.close();
} finally {
  proc.kill();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
