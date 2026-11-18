// bun test/mcpl/door-admit-revoke-test.ts — the MCPL door's admit() asks for the credential again before it takes over
// the identity's live session: a token revoked while the dial waits on the world's /access answer admits nobody and
// closes nothing. The world is a stub whose /access answers `enter`, held while a flag the test sets is on (not by
// request count: a resume probe would change the count). Control: the same takeover with the token kept closes A.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { until } from "../gate/wait.ts";

const S = suite("door-admit-revoke");
const check = (n: string, ok: unknown, d?: unknown) => S.check(n, ok, d);
const root = mkdtempSync(join(tmpdir(), "admit-revoke-"));
const tokensPath = join(root, "tokens.json");
const TOKEN = "admit-revoke-token", ENROLLED = { [TOKEN]: { id: "admittee", world: "commons" } };
writeFileSync(tokensPath, JSON.stringify(ENROLLED));

// ---- the stub world: /access only ----
let hold = false;
const waiting: (() => void)[] = [];
const stub = Bun.serve({ port: freePort(9700), hostname: "127.0.0.1", async fetch(req) {
  if (new URL(req.url).pathname !== "/access") return new Response("not here", { status: 404 });
  if (hold) await new Promise<void>((release) => waiting.push(release));
  return Response.json({ exists: true, you: "enter" });
} });
const MPORT = freePort(9800), NONCE = `ar${process.pid}`;
const door = Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${stub.port}/ws`, MCPL_TOKENS: tokensPath,
    MCPL_STATE: join(root, "state.json"), MCPL_INSTANCE_NONCE: NONCE, HN_ISSUER_KEY: "" },
  stdout: "ignore", stderr: "ignore",
});

type Dial = { ws: WebSocket; answer: Promise<{ ok: boolean; err: string }>; closed: boolean };
/** Dial and send initialize (never `initialized`: an admitted session then waits in its handshake, with no body to join). */
function dial(): Dial {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${TOKEN}`);
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
  hold = false; waiting.splice(0).forEach((release) => release());
  const bAns = await b.answer;
  check("a token revoked while B waited on /access: B is refused (-32001)", !bAns.ok && /^-32001 .*stopped being valid/.test(bAns.err), JSON.stringify(bAns));
  check("...and session A is still open (not taken over)", await alive(a), `A closed=${a.closed}`);

  // control: the same takeover with the token kept closes A, so the row above can see a takeover
  writeFileSync(tokensPath, JSON.stringify(ENROLLED));
  hold = true;
  const c = dial(); open.push(c);
  await until("C's dial is waiting on /access", () => waiting.length > 0, { ms: 10_000, step: 10 });
  hold = false; waiting.splice(0).forEach((release) => release());
  const cAns = await c.answer;
  check("control: with the token kept, C is admitted", cAns.ok, JSON.stringify(cAns));
  check("control: ...and takes over A's session (A closed)", !(await alive(a)), `A closed=${a.closed}`);
} finally {
  for (const d of open) { try { d.ws.close(); } catch { /* gone */ } }
  door.kill(); await door.exited;
  stub.stop(true);
  rmSync(root, { recursive: true, force: true });
}
S.done();
