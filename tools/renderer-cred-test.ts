// The renderers' credential and a private world's HTTP reads (#260 house I143, I144): the cases access-test.ts held
// before it was retired, against a scratch server.
//   - a client merely SAYING renderer (with the door key) may not watch a members-only world (4010);
//   - the renderers' credential WITHOUT the renderer flag opens no door (4003);
//   - a renderer holding the renderers' credential watches it, and a later closing doesn't remove it;
//   - a stranger (the door key, no membership) gets 404 from /snap and /heightmap of a members-only world, where the
//     same reads of the world while open answer (the control).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/renderer-cred-test.ts
import { scratchSequencer, mkCheck } from "./harness.ts";

const W = "closed", DOOR = "door-key", RKEY = "renderer-key";
const h = await scratchSequencer("renderercred", { worlds: [W], owner: "keeper",
  serverEnv: { JOIN_TOKEN: DOOR, RENDERER_TOKEN: RKEY, TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1" } });
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
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: W, id, replica: true, ...extra }));
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
  check("(setup) the owner makes the world members-only", a.ok === true, JSON.stringify(a));

  const fake = await open("fake-renderer", { renderer: true, token: DOOR });
  check("a client merely SAYING renderer (door key) may not watch the members-only world", fake.closedWith === 4010 && !fake.snap(), `code=${fake.closedWith}`);
  const sneaky = await open("sneaky", { token: RKEY });
  check("the renderers' credential without the renderer flag opens no door", sneaky.closedWith === 4003 && !sneaky.snap(), `code=${sneaky.closedWith}`);
  const real = await open("mac-renderer", { renderer: true, token: RKEY });
  check("a renderer holding the renderers' credential watches the members-only world", !!real.snap(), `code=${real.closedWith}`);
  const again = await req(owner, "set", { id: "@world", component: "access", value: { join: "listed", watch: "anyone" } });
  await h.sleep(600);
  const shut = await req(owner, "set", { id: "@world", component: "access", value: { join: "listed" } });
  await h.sleep(800);
  check("…and the trusted renderer is not removed when the world closes again", again.ok && shut.ok && real.closedWith == null, `code=${real.closedWith}`);

  const hm = await fetch(`${h.BASE}/heightmap?world=${W}&format=json`, KEY);
  check("a stranger's /heightmap of the members-only world: 404, nothing about it", hm.status === 404, `${hm.status} ${await hm.text()}`);
  const sn = await fetch(`${h.BASE}/snap?world=${W}&follow=keeper`, KEY);
  check("a stranger's /snap of the members-only world: 404 'unknown world'", sn.status === 404, `${sn.status} ${await sn.text()}`);
} finally {
  for (const s of socks) { try { s.close(); } catch {} }
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
await h.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
