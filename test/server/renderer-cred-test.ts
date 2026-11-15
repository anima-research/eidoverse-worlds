// The renderers' credential and a private world's HTTP reads (#260 house I143, I144): the cases access-test.ts held
// before it was retired, against a scratch server.
//   - every join shape × credential: only the renderer flag with the renderers' credential watches an invite-only world;
//     the door key alone is world-unavailable (a watcher 4011, as for no world; a person 4005), the renderers' credential without the flag (a lite ?renderer page included) is 4003;
//   - a later closing doesn't remove the admitted renderer;
//   - a stranger (the door key, no membership) gets 404 from /snap and /heightmap of an invite-only world, where the
//     same reads of the world while open answer (the control).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/renderer-cred-test.ts
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scratchSequencer, mkCheck } from "../harness/harness.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const W = "closed", DOOR = "door-key", RKEY = "renderer-key";
// an agent registry holding a key from the public example file (mcpl/tokens.example.json) beside a private one
const EXAMPLE_KEY = Object.keys(JSON.parse(readFileSync(new URL("../../mcpl/tokens.example.json", import.meta.url), "utf8")))[0], OWN_KEY = "own-agent-key";
const TOKENS = join(mkdtempSync(join(tmpdir(), "ew-renderercred-tok-")), "tokens.json");
writeFileSync(TOKENS, JSON.stringify({ [EXAMPLE_KEY]: { id: "copied" }, [OWN_KEY]: { id: "resident" } }));
const h = await scratchSequencer("renderercred", { worlds: [W], owner: "keeper",
  serverEnv: { JOIN_TOKEN: DOOR, RENDERER_TOKEN: RKEY, TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1", AGENT_TOKENS_PATH: TOKENS } });
const { check, tally } = mkCheck();
const WS = h.BASE.replace("http", "ws") + "/ws";
type Conn = { ws: WebSocket; msgs: any[]; closedWith: number | null; snap: () => any };
const socks: WebSocket[] = [];
const open = (id: string, extra: Record<string, unknown>) => new Promise<Conn>((res) => {
  const ws = new WebSocket(WS); socks.push(ws);
  const c: Conn = { ws, msgs: [], closedWith: null, snap: () => c.msgs.find((m) => m.type === "snapshot") ?? null };
  const done = () => res(c);
  const t = setTimeout(done, 3000);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); c.msgs.push(m); if (m.type === "snapshot") { clearTimeout(t); done(); } };
  ws.onclose = (e) => { c.closedWith = e.code; clearTimeout(t); done(); };
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id, replica: true, ...extra }));
});
let rq = 0;
const req = (c: Conn, verb: string, args: any) => new Promise<any>((res) => {
  const id = `r${++rq}`; const t = setTimeout(() => res({ ok: false, refused: { code: "timeout" } }), 5000);
  const on = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.type === "reply" && m.id === id) { clearTimeout(t); c.ws.removeEventListener("message", on); res(m.reply ?? m); } };
  c.ws.addEventListener("message", on); c.ws.send(JSON.stringify({ type: "request", id, verb, args }));
});
const KEY = { headers: { authorization: `Bearer ${DOOR}` } };
try {
  const owner = await open("keeper", { token: DOOR });
  check("(setup) the owner is in", !!owner.snap(), `code=${owner.closedWith}`);
  const t = await req(owner, "set", { id: "@world", component: "terrain", value: { seed: 3, size: 60, amplitude: 2 } });
  check("(setup) the owner gives the world a ground", t.ok === true, JSON.stringify(t));
  // the control: open, a stranger's reads are answered (a heightmap; a snapshot that only lacks a renderer)
  const hmOpen = await fetch(`${h.BASE}/heightmap?world=${W}&format=json`, KEY);
  check("while open, a stranger's /heightmap of the world answers", hmOpen.status === 200, String(hmOpen.status));
  const snOpen = await fetch(`${h.BASE}/snap?world=${W}&follow=keeper`, KEY);
  check("while open, a stranger's /snap of the world is not 'unknown world'", snOpen.status !== 404, `${snOpen.status} ${await snOpen.text()}`);
  const a = await req(owner, "set", { id: "@world", component: "access", value: { join: "listed" } });
  check("(setup) the owner makes the world invite-only", a.ok === true, JSON.stringify(a));

  // every join shape × credential on the invite-only world: only the renderer flag WITH the renderers' credential watches.
  // The shapes are what pages send (renderer-join-test): a renderer page, a roaming one, a lite ?renderer page (spectate, no
  // renderer flag), a spectator, a person.
  const SHAPES: [string, Record<string, unknown>][] = [["renderer", { renderer: true, spectate: true }],
    ["roaming renderer", { renderer: true, roam: true, spectate: true }], ["bare renderer flag", { renderer: true }],
    ["spectator (a lite ?renderer page sends this)", { spectate: true }], ["person", {}]];
  const CREDS: [string, string, number | null][] = [["door key", DOOR, 4011], ["renderers' credential", RKEY, 4003], ["a wrong key", "nope", 4003]];
  let real: Conn | null = null, n = 0;
  for (const [shape, flags] of SHAPES) for (const [cred, token, refusal] of CREDS) {
    const c = await open(`j${++n}`, { ...flags, token });
    const watches = cred === "renderers' credential" && flags.renderer === true;
    if (watches) check(`${shape} + ${cred}: watches the invite-only world`, !!c.snap() && c.closedWith == null, `code=${c.closedWith}`);
    else { const want = cred === "door key" && !flags.renderer && !flags.spectate ? 4005 : refusal;   // a person refused by an invite-only door is 4005; a watcher world-unavailable
      check(`${shape} + ${cred}: refused ${want}`, c.closedWith === want && !c.snap(), `code=${c.closedWith}`); }
    if (watches && !real) real = c; else if (c.closedWith == null) c.ws.close();
  }
  if (!real) throw new Error("no renderer was admitted");
  const again = await req(owner, "set", { id: "@world", component: "access", value: { join: "listed", watch: "anyone" } });
  await h.sleep(600);
  const shut = await req(owner, "set", { id: "@world", component: "access", value: { join: "listed" } });
  await h.sleep(800);
  check("…and the trusted renderer is not removed when the world closes again", again.ok && shut.ok && real!.closedWith == null, `code=${real!.closedWith}`);

  const hm = await fetch(`${h.BASE}/heightmap?world=${W}&format=json`, KEY);
  check("a stranger's /heightmap of the invite-only world: 404, nothing about it", hm.status === 404, `${hm.status} ${await hm.text()}`);
  const sn = await fetch(`${h.BASE}/snap?world=${W}&follow=keeper`, KEY);
  check("a stranger's /snap of the invite-only world: 404 'unknown world'", sn.status === 404, `${sn.status} ${await sn.text()}`);
  // the HTTP doors read the agent registry as the MCPL door does: a public example key opens nothing, a private one does
  const asKey = (k: string) => fetch(`${h.BASE}/geom?world=${W}`, { headers: { authorization: `Bearer ${k}` } });
  const ex = await asKey(EXAMPLE_KEY), own = await asKey(OWN_KEY);
  check(`(setup) the example file's key is "${EXAMPLE_KEY}", the registry is the scratch one`, !!EXAMPLE_KEY && EXAMPLE_KEY !== OWN_KEY);
  check("a key copied from the public example file is refused at an HTTP door (401)", ex.status === 401, String(ex.status));
  check("…where a private registry key passes the door (the world then answers as closed to it)", own.status !== 401, String(own.status));
  // the auth scheme is case-insensitive (RFC 7235): `bearer` reads as `Bearer` at the read door and where a caller is named
  const lower = { headers: { authorization: `bearer ${OWN_KEY}` } };
  const gLow = await fetch(`${h.BASE}/geom?world=${W}`, lower), aLow = await fetch(`${h.BASE}/access?world=${W}`, lower);
  check("a lowercase `bearer` key passes the read door as `Bearer` does", gLow.status === own.status, `${gLow.status} vs ${own.status}`);
  check("…and names its caller at /access (not 401)", aLow.status !== 401, String(aLow.status));
} finally {
  for (const s of socks) { try { s.close(); } catch {} }
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
await h.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
