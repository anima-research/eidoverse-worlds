// route-shape-test — GET /geom?world&id ships the view record (shared/protocol/view.js viewOf) verbatim (C7a).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/route-shape-test.ts
//
// One real sequencer on a verified-free port with a scratch WORLDS_DIR; the owner joins over the raw ws and makes a
// thing scaled [1,2,1] (a stretched crate). Pins:
//   A. the route's body carries `scale3` (the survey's #1: the hand-rolled projection dropped it, so a stretched thing
//      measured as `scale 2` with nothing saying which axis)
//   B. every field of viewOf(c) — computed here from the client's own fold of the log stream — is in the body, equal:
//      the route is the view, not a sixth shape of the entity
//   C. the whole-scene body (/geom?world) carries the same record per entity, and no `kind`
// harness.scratchSequencer: a scratch WORLDS_DIR, the child proven ours by its nonce before any assertion counts.
import { mkCheck, scratchSequencer } from "../harness/harness.ts";
import { makeReplica } from "../../shared/protocol/replica.js";
import { viewOf } from "../../shared/protocol/view.js";
import { idAliases } from "../harness/idalias.ts";
import { tryUntil } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";
const IDS = idAliases();   // R 10-17: the suite's names ride as placeholders and minted ids

const { check, tally } = mkCheck();
const J = (v: unknown) => JSON.stringify(v);

/** A client that folds the log it is sent (the page's own replica) and sends requests. */
async function client(port: number, world: string, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: any[] = []; const waiters = new Map<string, (r: any) => void>(); let n = 0;
  const rep = makeReplica();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m);
    if (m.type === "snapshot" && m.state) rep.adopt(m);
    if (m.type === "log") rep.ingest(m.entries, m.from, m.names);
    if (m.type === "reply") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m.reply); } } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(J({ type: "join", hello: helloOf(), world, id, avatar: "", replica: true }));
  await tryUntil("a snapshot or an error", () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 3000, step: 50 });
  const err = msgs.find((m) => m.type === "error"); if (err) throw new Error(`join ${id}@${world}: ${err.error}`);
  return {
    rep,
    req: (verb: string, args: any = {}) => new Promise<any>((res) => { const rid = `${id}-${++n}`; waiters.set(rid, (r: any) => res(IDS.back(r))); ws.send(J({ type: "request", id: rid, verb, args: IDS.out(verb, args) })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 6000); }),
    close: () => ws.close(),
  };
}

const seq = await scratchSequencer("route-shape", { worlds: ["yard"], owner: "Ann", serverEnv: { SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1" } });
const port = seq.PORT;
const ann = await client(port, "yard", "Ann");
const made = await ann.req("create", { id: "crate", model: "test/crate.glb", components: { transform: { pos: [1, 0, 2], q: [0, 0, 0, 1], scale: [1, 2, 1] }, label: "tall crate" } });
check("the owner makes a crate scaled [1,2,1]", made.ok === true, J(made.refused));
await tryUntil("the crate reaches Ann's replica", () => ann.rep.st?.entities?.[IDS.of("crate")], { ms: 3000 });
const cid = IDS.of("crate");   // the authority mints the id; "crate" rode as a placeholder
const c = ann.rep.st?.entities?.[cid]?.c;
check("…and this client's own fold has it", !!c && J(c.transform?.scale) === "[1,2,1]", J(c));

console.log("\n— A/B. one thing —");
{
  const r = await fetch(`http://127.0.0.1:${port}/geom?world=yard&id=${encodeURIComponent(cid)}`);
  const body = await r.json();
  check("200 json", r.status === 200 && typeof body === "object", String(r.status));
  check("A the body carries scale3 [1,2,1] (a stretched thing stays stretched over the route)", J(body.scale3) === "[1,2,1]", J({ scale: body.scale, scale3: body.scale3 }));
  const want = viewOf(cid, c);
  const diffs = Object.keys(want).filter((k) => J(want[k]) !== J(body[k]));
  check("B every field of viewOf(c) is in the body, equal (the route IS the view)", diffs.length === 0, J(Object.fromEntries(diffs.map((k) => [k, { view: want[k], route: body[k] }]))));
  check("…id, geometry and the note ride beside it", body.id === cid && "geometry" in body && typeof body.note === "string", J(Object.keys(body)));
}

console.log("\n— C. the whole scene —");
{
  const r = await fetch(`http://127.0.0.1:${port}/geom?world=yard&boxes=0`);
  const body = await r.json();
  const row = (body.entities ?? []).find((e: any) => e.id === cid);
  check("the crate's row", !!row, J(body).slice(0, 200));
  const want = viewOf(cid, c);
  const diffs = row ? Object.keys(want).filter((k) => J(want[k]) !== J(row[k])) : ["(no row)"];
  check("C the row is the same record (scale3 included), and carries no kind (one word per thing is gone: read its components)", diffs.length === 0 && !!row && !("kind" in row), J(diffs));
}

ann.close();
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
await seq.cleanup();
process.exit(tally.failed ? 1 : 0);
