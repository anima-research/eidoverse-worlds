// bun test/mcpl/door-admit-revoke-test.ts — the MCPL door's admit() asks for the credential again before it takes over
// the identity's live session: a token revoked while the dial waits on the world's /access answer admits nobody and
// closes nothing. The world is a stub whose /access answers `enter`, held while a flag the test sets is on (not by
// request count: a resume probe would change the count). Control: the same takeover with the token kept closes A.
// The same for an aid1 credential, against a scratch issuer: a token that expires while the dial waits admits nobody.
// The door's probe timeout is set past every hold, so admit() acts on the held answer, never on the timeout fallback.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { until, pause } from "../gate/wait.ts";
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";

const S = suite("door-admit-revoke");
const check = (n: string, ok: unknown, d?: unknown) => S.check(n, ok, d);
const root = mkdtempSync(join(tmpdir(), "admit-revoke-"));
const tokensPath = join(root, "tokens.json");
const TOKEN = "admit-revoke-token", ENROLLED = { [TOKEN]: { id: "admittee", world: "commons" } };
writeFileSync(tokensPath, JSON.stringify(ENROLLED));
// a scratch aid1 issuer (auth-test.ts's mint), so the aid1 leg of admit()'s second look is under test too
const issuer = generateKeyPairSync("ed25519");
const spki = createPublicKey(issuer.privateKey).export({ format: "der", type: "spki" }) as Buffer;
const ISSUER_ID = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
/** `expIn` seconds from now, unrounded (verifyToken compares exp as a number), so a short lifetime is exactly that long. */
function mintAid1(expIn: number): { tok: string; exp: number } {
  const now = Math.floor(Date.now() / 1000), exp = Date.now() / 1000 + expIn;
  const seg = Buffer.from(JSON.stringify({ v: 1, iss: "id.test", aud: "eidoverse", sub: "agent:admittee2@guest", kind: "agent", name: "Admittee2",
    scopes: ["worlds:join"], claims: { world: "commons" }, iat: now, exp })).toString("base64url");
  return { tok: `aid1.${seg}.${cryptoSign(null, Buffer.from(`aid1.${seg}`), issuer.privateKey).toString("base64url")}`, exp };
}

// ---- the stub world: /access only; a held request keeps its bearer and arrival time ----
let hold = false;
type Held = { token: string; at: number; req: Request; release: () => void };
const waiting: Held[] = [];
const stub = Bun.serve({ port: freePort(9700), hostname: "127.0.0.1", async fetch(req) {
  if (new URL(req.url).pathname !== "/access") return new Response("not here", { status: 404 });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, ""), at = Date.now();
  if (hold) await new Promise<void>((release) => waiting.push({ token, at, req, release }));
  return Response.json({ exists: true, you: "enter" });
} });
/** Answer every held /access; true when each was still open (the door's probe hadn't given up on it). */
const releaseAll = () => { hold = false; const open = waiting.every((h) => !h.req.signal.aborted); waiting.splice(0).forEach((h) => h.release()); return open; };
// the door's probe timeout, far past any hold here: the held answer is the one admit() acts on, never the timeout fallback
const PROBE_MS = 60_000;
const MPORT = freePort(9800), NONCE = `ar${process.pid}`;
const door = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${stub.port}/ws`, MCPL_TOKENS: tokensPath,
    MCPL_STATE: join(root, "state.json"), MCPL_INSTANCE_NONCE: NONCE, MCPL_ACCESS_PROBE_MS: String(PROBE_MS), HN_ISSUER_KEY: ISSUER_ID, HN_ISS: "id.test", HN_AUD: "eidoverse" },
  stdout: "ignore", stderr: "ignore",
});

type Dial = { ws: WebSocket; answer: Promise<{ ok: boolean; err: string }>; closed: boolean };
/** Dial and send initialize (never `initialized`: an admitted session then waits in its handshake, with no body to join). */
function dial(token = TOKEN): Dial {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${encodeURIComponent(token)}`);
  const d: Dial = { ws, closed: false, answer: null as any };
  d.answer = new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "admit-revoke", version: "0" } } })));
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.id === 1) resolve({ ok: !!m.result, err: m.error ? `${m.error.code} ${m.error.message}` : "" }); });
    ws.on("close", () => { d.closed = true; resolve({ ok: false, err: "closed" }); });
  });
  return d;
}
/** Whether `d` is still open: a ping after the outcome. A takeover's close frame was sent on d before the successor's
 *  answer, so it arrives before any pong to this ping. */
const alive = (d: Dial) => new Promise<boolean>((resolve) => {
  if (d.closed || d.ws.readyState !== WebSocket.OPEN) return resolve(false);
  d.ws.once("pong", () => resolve(true)); d.ws.once("close", () => resolve(false)); d.ws.ping();
});

const open: Dial[] = [];
try {
  await until("the door answers /healthz with our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`).catch(() => null);
    return r?.ok && (await r.text()).trim() === `ok ${NONCE}`;
  }, { ms: 20_000 });

  const a = dial(); open.push(a);
  const aAns = await a.answer;
  check("setup: session A is admitted (its initialize is answered)", aAns.ok, aAns.err);

  // B dials with the same token and waits on /access; the token is revoked; then /access answers
  hold = true;
  const b = dial(); open.push(b);
  await until("B's dial is waiting on /access", () => waiting.length > 0, { ms: 10_000, step: 10 });
  writeFileSync(tokensPath, "{}");
  releaseAll();
  const bAns = await b.answer;
  check("a token revoked while B waited on /access: B is refused (-32001)", !bAns.ok && /^-32001 .*stopped being valid/.test(bAns.err), JSON.stringify(bAns));
  check("...and session A is still open (not taken over)", await alive(a), `A closed=${a.closed}`);

  // control: the same takeover with the token kept closes A, so the row above can see a takeover
  writeFileSync(tokensPath, JSON.stringify(ENROLLED));
  hold = true;
  const c = dial(); open.push(c);
  await until("C's dial is waiting on /access", () => waiting.length > 0, { ms: 10_000, step: 10 });
  releaseAll();
  const cAns = await c.answer;
  check("control: with the token kept, C is admitted", cAns.ok, JSON.stringify(cAns));
  check("control: ...and takes over A's session (A closed)", !(await alive(a)), `A closed=${a.closed}`);

  // the aid1 leg: an aid1 token that expires while B2 waits on /access is no longer the identity's at admission
  const a2 = dial(mintAid1(600).tok); open.push(a2);
  const a2Ans = await a2.answer;
  check("setup: aid1 session A2 is admitted", a2Ans.ok, a2Ans.err);
  // B2's token lives long enough to reach the held probe, then expires there; a dial too slow to reach it (load) is
  // refused at the first check and retried with twice the lifetime, so the row below always tests the second look
  let b2: Dial | undefined, short = { tok: "", exp: 0 }, heldAt = 0;
  for (let life = 3; !b2 && life <= 48; life *= 2) {
    short = mintAid1(life); hold = true;
    const d = dial(short.tok); open.push(d);
    let settled = false; void d.answer.then(() => { settled = true; });
    await until("B2 waits on /access, or was refused before it", () => settled || waiting.some((h) => h.token === short.tok), { ms: 60_000, step: 10 });
    const h = waiting.find((w) => w.token === short.tok);
    if (h) { b2 = d; heldAt = h.at; } else hold = false;
  }
  check("setup: B2's dial reached the held /access while its aid1 token was valid", !!b2 && heldAt < short.exp * 1000, { heldAt, exp: short.exp });
  await pause("B2's aid1 token expires while its dial waits", Math.max(0, short.exp * 1000 - Date.now()) + 100);
  const expiredAt = Date.now();
  const heldOpen = releaseAll();
  check("setup: B2's token had expired before /access answered", expiredAt > short.exp * 1000, { expiredAt, exp: short.exp });
  check("setup: ...and the held /access was still open when it answered (the probe hadn't timed out)", heldOpen && expiredAt - heldAt < PROBE_MS, { heldOpen, heldMs: expiredAt - heldAt });
  const b2Ans = await b2!.answer;
  check("an aid1 token that expired while B2 waited on /access: B2 is refused (-32001)", !b2Ans.ok && /^-32001 .*stopped being valid/.test(b2Ans.err), JSON.stringify(b2Ans));
  check("...and aid1 session A2 is still open (not taken over)", await alive(a2), `A2 closed=${a2.closed}`);
  // control: a live aid1 token of the same identity takes A2 over, so the rows above can see a takeover
  hold = true;
  const c2 = dial(mintAid1(600).tok); open.push(c2);
  await until("C2's dial is waiting on /access", () => waiting.length > 0, { ms: 10_000, step: 10 });
  releaseAll();
  const c2Ans = await c2.answer;
  check("control: a live aid1 token is admitted (C2) and takes over A2's session", c2Ans.ok && !(await alive(a2)), `${JSON.stringify(c2Ans)} A2 closed=${a2.closed}`);
} finally {
  for (const d of open) { try { d.ws.close(); } catch { /* gone */ } }
  door.kill(); await door.exited;
  stub.stop(true);
  rmSync(root, { recursive: true, force: true });
}
S.done();
