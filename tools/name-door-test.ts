// Names at the door: a display name may not carry < > or " (server/names.ts, wired in server.ts admitJoin).
// A self-booted scratch sequencer on a free port with a scratch identity issuer (caption-verb-test's recipe), real
// websockets:
//
//   bun tools/name-door-test.ts
//
//   1. a TYPED name with < > or " is refused at join, in words, and never reaches anyone's roster
//   2. & and ' are fine (Tom & Jerry, O'Brien) — and so is an ordinary name
//   3. a name the identity service vouched for is never refused: it comes in with each of those characters swapped for a look-alike (‹ › ″)
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { createServer } from "node:net";
import { nameAtDoor } from "../server/names.ts";

const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const PORT = await freePort();
const HTTP = `http://localhost:${PORT}`, WS_URL = `ws://localhost:${PORT}/ws`, DOOR = "test-door";
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- scratch issuer (authtest.ts / caption-verb-test.ts) ----
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

type Joined = { snap: any; errors: string[]; closeCode: number | null; ws: WebSocket };
function enter(joinMsg: Record<string, unknown>, cookie = ""): Promise<Joined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, cookie ? ({ headers: { cookie } } as any) : undefined);
    const j: Joined = { snap: null, errors: [], closeCode: null, ws };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: DOOR, ...joinMsg }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "error") j.errors.push(m.error); if (m.type === "snapshot") { j.snap = m; resolve(j); } };
    ws.onclose = (ev) => { j.closeCode = ev.code; resolve(j); };
    setTimeout(() => resolve(j), 4000);
  });
}

const worldsDir = mkdtempSync(pathJoin(tmpdir(), "ew-names-"));
const optDir = mkdtempSync(pathJoin(tmpdir(), "ew-names-opt-"));
const proc = Bun.spawn([process.execPath, "run", pathJoin(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: DOOR, SKIP_OPT_SWEEP: "1", HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0" },
  stdout: "ignore", stderr: "inherit",
});
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${HTTP}/authcfg`); up = true; } catch { await sleep(150); } }
if (!up) { proc.kill(); throw new Error("server never came up"); }

const WORLD = `names-${Math.random().toString(36).slice(2, 8)}`;
try {
  console.log("names at the door — the rule (server/names.ts)");
  check("typed with < is refused", !!nameAtDoor("a<b", { typed: true }).refused);
  check("typed with > is refused", !!nameAtDoor("a>b", { typed: true }).refused);
  check('typed with " is refused', !!nameAtDoor('a"b', { typed: true }).refused);
  check("& and ' pass untouched", nameAtDoor("Tom & Jerry O'Brien", { typed: true }).name === "Tom & Jerry O'Brien" && !nameAtDoor("Tom & Jerry O'Brien", { typed: true }).refused);
  check("vouched-for: look-alikes, never refused", nameAtDoor('<b>"Ra"</b>', { typed: false }).name === "\u2039b\u203a\u2033Ra\u2033\u2039/b\u203a" && !nameAtDoor('<b>"Ra"</b>', { typed: false }).refused);
  check("vouched-for: never emptied or made reserved", ["<>", "<world>", '"*"'].every((n) => { const r = nameAtDoor(n, { typed: false }).name; return r.length > 0 && !/^(world|\*)$/i.test(r); }));

  console.log(`\nnames at the door — a live sequencer, world "${WORLD}"`);
  const host = await enter({ id: "host", world: WORLD });
  check("an ordinary name joins", !!host.snap, host.errors.join("; "));

  const HOSTILE = '<img src=x onerror="alert(1)">';
  const bad = await enter({ id: HOSTILE, world: WORLD });
  check("a typed name carrying a tag is refused at join", !bad.snap, `joined as ${bad.snap?.you}`);
  check("…in words that say why", bad.errors.some((e) => /< > or "/.test(e)), bad.errors.join("; "));
  check("…and the socket is closed", bad.closeCode !== null, String(bad.closeCode));
  for (const ch of ["<", ">", '"']) {
    const j = await enter({ id: `x${ch}y`, world: WORLD });
    check(`…${ch} alone is enough to refuse`, !j.snap, `joined as ${j.snap?.you}`);
    j.ws.close();
  }

  const tj = await enter({ id: "Tom & Jerry", world: WORLD });
  check("Tom & Jerry joins as itself", tj.snap?.you === "Tom & Jerry", `${tj.snap?.you} ${tj.errors.join("; ")}`);
  const ob = await enter({ id: "O'Brien", world: WORLD });
  check("O'Brien joins as itself", ob.snap?.you === "O'Brien", `${ob.snap?.you} ${ob.errors.join("; ")}`);

  const vouched = await enter({ id: "ignored", world: WORLD }, await cookieFor("human:discord:7001", '<i>"Ra"</i>'));
  check("a vouched-for name is not refused", !!vouched.snap, vouched.errors.join("; "));
  check("…it arrives with < > \" as look-alikes", vouched.snap?.you === "\u2039i\u203a\u2033Ra\u2033\u2039/i\u203a", String(vouched.snap?.you));

  await sleep(200);
  const eye = await enter({ id: "eye", world: WORLD, spectate: true });
  const roster = JSON.stringify(eye.snap ?? {});
  check("no one in the world's snapshot carries a tag", !roster.includes("<img"), roster.slice(0, 200));
  for (const s of [host, tj, ob, vouched, eye]) s.ws.close();
} finally {
  proc.kill();
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
