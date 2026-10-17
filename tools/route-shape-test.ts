// route-shape-test — GET /geom?world&id ships the view record (shared/protocol/view.js viewOf) verbatim (C7a).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/route-shape-test.ts
//
// One real sequencer on a verified-free port with a scratch WORLDS_DIR; the owner joins over the raw ws and makes a
// thing scaled [1,2,1] (a stretched crate). Pins:
//   A. the route's body carries `scale3` (the survey's #1: the hand-rolled projection dropped it, so a stretched thing
//      measured as `scale 2` with nothing saying which axis)
//   B. every field of viewOf(c) — computed here from the client's own fold of the log stream — is in the body, equal:
//      the route is the view, not a sixth shape of the entity
//   C. the whole-scene body (/geom?world) carries the same record per entity, plus `kind`
// Port discipline per the stale-listener incident: nonce file served from THIS tree before any assertion counts.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { foundWorlds } from "./harness.ts";
import { makeReplica } from "../shared/protocol/replica.js";
import { viewOf } from "../shared/protocol/view.js";
import { idAliases } from "./protocol/idalias.ts";
const IDS = idAliases();   // R 10-17: the suite's names ride as placeholders and minted ids

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const J = (v: unknown) => JSON.stringify(v);

const REPO = join(import.meta.dir, "..");
const children: ChildProcess[] = [];
const nonces: string[] = [];
process.on("exit", () => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  for (const n of nonces) { try { rmSync(n); } catch { /* ok */ } }
});

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { return cand; }
  }
  throw new Error("no free port");
}

const worldsDir = mkdtempSync(join(tmpdir(), "route-shape-"));
foundWorlds(worldsDir, ["yard"], "Ann");
mkdirSync(join(worldsDir, ".clientlogs"), { recursive: true });

async function spawnServer(): Promise<{ port: number }> {
  const port = await freePort();
  const nonce = `rs-nonce-${crypto.randomUUID().slice(0, 8)}`;
  const noncePath = join(REPO, "client", `${nonce}.txt`);
  writeFileSync(noncePath, nonce); nonces.push(noncePath);
  const child = spawn(process.execPath, [join(REPO, "server", "server.ts")], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH, PORT: String(port), WORLDS_DIR: worldsDir, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1", JOIN_TOKEN: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdio: "ignore",
  });
  children.push(child);
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const own = await fetch(`http://127.0.0.1:${port}/${nonce}.txt`).then((r) => r.ok && r.text()).catch(() => false);
  if (own !== nonce) throw new Error(`listener on :${port} is not our child — refusing to test it`);
  return { port };
}

/** A client that folds the log it is sent (the page's own replica) and sends requests. */
async function client(port: number, world: string, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: any[] = []; const waiters = new Map<string, (r: any) => void>(); let n = 0;
  const rep = makeReplica();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m);
    if (m.type === "snapshot" && m.cut) rep.adopt(m.cut);
    if (m.type === "log") rep.ingest(m.entries, m.from, m.names);
    if (m.type === "reply") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m.reply); } } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(J({ type: "join", world, id, avatar: "", replica: true }));
  for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await new Promise((r) => setTimeout(r, 50));
  const err = msgs.find((m) => m.type === "error"); if (err) throw new Error(`join ${id}@${world}: ${err.error}`);
  return {
    rep,
    req: (verb: string, args: any = {}) => new Promise<any>((res) => { const rid = `${id}-${++n}`; waiters.set(rid, (r: any) => res(IDS.back(r))); ws.send(J({ type: "request", id: rid, verb, args: IDS.out(verb, args) })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 6000); }),
    close: () => ws.close(),
  };
}

const { port } = await spawnServer();
const ann = await client(port, "yard", "Ann");
const made = await ann.req("create", { id: "crate", model: "test/crate.glb", components: { transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [1, 2, 1] }, label: "tall crate", sockets: { top: { pos: [0, 1, 0] } } } });
check("the owner makes a crate scaled [1,2,1]", made.ok === true, J(made.refused));
await new Promise((r) => setTimeout(r, 300));
const c = ann.rep.st?.entities?.crate?.c;
check("…and this client's own fold has it", !!c && J(c.transform?.scale) === "[1,2,1]", J(c));

console.log("\n— A/B. one thing —");
{
  const r = await fetch(`http://127.0.0.1:${port}/geom?world=yard&id=crate`);
  const body = await r.json();
  check("200 json", r.status === 200 && typeof body === "object", String(r.status));
  check("A the body carries scale3 [1,2,1] (a stretched thing stays stretched over the route)", J(body.scale3) === "[1,2,1]", J({ scale: body.scale, scale3: body.scale3 }));
  const want = viewOf("crate", c);
  const diffs = Object.keys(want).filter((k) => J(want[k]) !== J(body[k]));
  check("B every field of viewOf(c) is in the body, equal (the route IS the view)", diffs.length === 0, J(Object.fromEntries(diffs.map((k) => [k, { view: want[k], route: body[k] }]))));
  check("…id, geometry and the note ride beside it", body.id === "crate" && "geometry" in body && typeof body.note === "string", J(Object.keys(body)));
}

console.log("\n— C. the whole scene —");
{
  const r = await fetch(`http://127.0.0.1:${port}/geom?world=yard&boxes=0`);
  const body = await r.json();
  const row = (body.entities ?? []).find((e: any) => e.id === "crate");
  check("the crate's row", !!row, J(body).slice(0, 200));
  const want = viewOf("crate", c);
  const diffs = row ? Object.keys(want).filter((k) => J(want[k]) !== J(row[k])) : ["(no row)"];
  check("C the row is the same record (scale3 included), plus kind", diffs.length === 0 && row?.kind === "model", J(diffs));
}

ann.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
