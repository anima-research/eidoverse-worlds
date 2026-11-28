// snapframe-test — optional /snap framing (dist / height / pitch), end to end.
//
//   bun test/server/snapframe-test.ts
//
// Four layers, each of which could break without the others noticing:
//   1. shared/snapframe.js — what survives normalisation (omitted, zero,
//      junk, range limits, HTTP strings vs model arguments).
//   2. client/lib/avatar/fp_view.js — composeFirstPerson's pitch: + looks up,
//      − looks down, omitted keeps the old gaze exactly.
//   3. the wire — a scratch sequencer, a plain-door agent calling the
//      screenshot tool, an HTTP /snap, and ten fake renderer legs recording
//      the view and framing of each `capture` they're asked for. Absent fields
//      must put no `frame` on the wire.
//   4. the broker — donor, ownership, waiting, Retry-After, budget, sweep, and each
//      outcome's status and escaped [snap] line.

import { normalizeSnapFrame, SNAP_DIST, SNAP_HEIGHT, SNAP_PITCH } from "../../shared/snapframe.js";
import * as fp from "../../client/lib/avatar/fp_view.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort, readSequencerLog, ROOT, scratchSequencer } from "../harness/harness.ts";
import { pause, tryUntil, until } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const S = suite("snapframe");
const check = (name: string, cond: unknown, detail?: unknown) => S.check(name, cond, detail);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- 1. normaliser ----------------------------------------------------------
console.log("normaliser");
check("omitted fields → empty frame", same(normalizeSnapFrame({}), {}));
check("null / non-object input → empty frame", same(normalizeSnapFrame(null), {}) && same(normalizeSnapFrame("x"), {}));
check("zero is a value, not an absence", same(normalizeSnapFrame({ height: 0, pitch: 0 }), { height: 0, pitch: 0 }));
check("numeric strings (HTTP query) parse", same(normalizeSnapFrame({ dist: "1.5", pitch: "-40" }), { dist: 1.5, pitch: -40 }));
check("blank / null / undefined strings drop", same(normalizeSnapFrame({ dist: "", height: "  ", pitch: null }), {}));
check("booleans drop (false must not become 0)", same(normalizeSnapFrame({ height: false, dist: true }), {}));
check("arrays and objects drop", same(normalizeSnapFrame({ dist: [3], pitch: { valueOf: () => 5 } }), {}));
let threw = false;
try { normalizeSnapFrame({ pitch: { toString: null } }); } catch { threw = true; }
check("an object with no usable toString drops instead of throwing", !threw);
check("non-numeric strings and NaN/Infinity drop", same(normalizeSnapFrame({ dist: "abc", height: NaN, pitch: Infinity }), {}));
check("clamps at the low ends", same(normalizeSnapFrame({ dist: 0, height: -5, pitch: -200 }), { dist: SNAP_DIST[0], height: SNAP_HEIGHT[0], pitch: SNAP_PITCH[0] }));
check("clamps at the high ends", same(normalizeSnapFrame({ dist: 999, height: 999, pitch: 200 }), { dist: SNAP_DIST[1], height: SNAP_HEIGHT[1], pitch: SNAP_PITCH[1] }));
check("unknown fields are not carried", same(normalizeSnapFrame({ dist: 2, fov: 90 }), { dist: 2 }));

// ---- 2. first-person pitch ---------------------------------------------------
console.log("first-person pitch");
function gaze(pitch?: number) {
  const cam = { position: { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
    look: null as null | number[], lookAt(x: number, y: number, z: number) { this.look = [x, y, z]; } };
  fp.composeFirstPerson({ camera: cam, yaw: 0, pitch, head: [0, 1.5, 0], name: "t", setOwnVisible: () => {}, render: () => "frame" });
  const p = cam.position, l = cam.look!;
  return { dx: l[0] - p.x, dy: l[1] - p.y, dz: l[2] - p.z };
}
const def = gaze();
check("omitted pitch keeps the old gaze exactly", near(def.dy, -fp.FP_GAZE_DROP) && near(def.dz, fp.FP_GAZE_AHEAD));
const up = gaze(30), down = gaze(-40), level = gaze(0);
check("+30 looks up at 30°", near(Math.atan2(up.dy, up.dz) * 180 / Math.PI, 30, 1e-6), JSON.stringify(up));
check("−40 looks down at 40°", near(Math.atan2(down.dy, down.dz) * 180 / Math.PI, -40, 1e-6), JSON.stringify(down));
check("0 is level (not the default drop)", near(level.dy, 0));
check("pitch keeps the heading (yaw 0 → +z, no x drift)", near(up.dx, 0) && near(down.dx, 0) && up.dz > 0 && down.dz > 0);

// ---- 3. the wire ------------------------------------------------------------
console.log("wire (scratch sequencer + fake renderer + plain-door agent)");
const PORT = freePort(8000), WORLD = "framing", TOKEN = "snapframe-test";
// the world is founded first (joining never founds one), joins fold the log (replica: true), the broker speaks
// capture / capture-result, the agent's tool is screenshot, and a box with a door key keeps /worlds and /snap behind it
const WORLDS = mkdtempSync(join(tmpdir(), "snapframe-"));
foundWorlds(WORLDS, [WORLD]);
const KEY = { headers: { authorization: `Bearer ${TOKEN}` } };
const seq = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: TOKEN, SKIP_OPT_SWEEP: "1", WORLDS_DIR: WORLDS },
  stdout: "ignore", stderr: "ignore",
});
let mcp: ReturnType<typeof Bun.spawn> | null = null;
process.on("exit", () => { try { mcp?.kill(); } catch {} seq.kill(); });
const up2 = !!(await tryUntil("the scratch sequencer answers", () => fetch(`http://127.0.0.1:${PORT}/worlds`, KEY).then(() => true, () => false), { ms: 12_000, step: 200 }));
if (!up2) { console.error("FATAL: scratch sequencer never came up (bun install in the repo root?)"); process.exit(2); }

// fake renderer legs: each answers every snap with a 1×1 PNG. They record each
// snap's view and frame, and any framing value also copied to the message's top
// level, where it could be read as framing or collide with a field such as an
// image size. Other fields aren't compared, so a sender can add its own.
// There are ten, more than the snapshots this test takes, because the broker
// rests each renderer for 2 s from the request it sends it; with none free a
// new ask waits in the queue (B2–B4), and only a full queue answers 429. Each joins before the next, and
// the test goes on once the sequencer has answered all ten joins.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const asked: Record<string, unknown>[] = [];
const renderers: WebSocket[] = [];
for (let i = 1; i <= 10; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  renderers.push(ws);
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`renderer-fake-${i}'s join had no answer in 10 s`)), 10_000);
    ws.onerror = () => { clearTimeout(timer); rej(new Error(`renderer-fake-${i}'s socket failed`)); };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: WORLD, id: `renderer-fake-${i}`, spectate: true, renderer: true, token: TOKEN, replica: true }));
    ws.onmessage = (ev) => { if (JSON.parse(String(ev.data)).type === "snapshot") { clearTimeout(timer); res(); } };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "capture") {
      const flat = m.frame ? Object.keys(m.frame).filter((k) => m[k] === m.frame[k]) : [];
      asked.push({ view: m.view, ...(m.frame === undefined ? {} : { frame: m.frame }), ...(flat.length ? { flat } : {}) });
      ws.send(JSON.stringify({ type: "capture-result", id: m.id, dataUrl: PNG }));
    }
  };
}
// A 429 means no fake renderer was free, so say why rather than fail on a
// missing picture alone.
const BUSY = "the broker answered 429: no fake renderer was free for this snapshot, though the test joins ten so that each finds one that isn't resting or busy";

// plain-door agent over MCP stdio
mcp = Bun.spawn(["bun", "mcpl/server.ts"], {
  env: { ...process.env, WORLD_URL: `ws://127.0.0.1:${PORT}/ws`, WORLD_NAME: WORLD, AGENT_NAME: "framer", WORLD_TOKEN: TOKEN },
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
});
const pending = new Map<number, (v: any) => void>();
(async () => { const d = new TextDecoder(); let buf = "";
  for await (const c of mcp!.stdout as ReadableStream<Uint8Array>) { buf += d.decode(c); let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(l); if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } } catch {} } } })();
let rid = 1;
const stdin = mcp.stdin as import("bun").FileSink;
const rpc = (method: string, params?: unknown) => new Promise<any>((res, rej) => { const i = rid++; pending.set(i, res);
  setTimeout(() => { if (pending.delete(i)) rej(new Error(`timeout: ${method}`)); }, 20000);
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, ...(params !== undefined ? { params } : {}) }) + "\n"); stdin.flush(); });
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "snapframe-test", version: "0" } });
stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); stdin.flush();
const joined = !!(await tryUntil("the door's agent shows in /worlds", async () => JSON.stringify(await fetch(`http://127.0.0.1:${PORT}/worlds`, KEY).then((r) => r.json()).catch(() => null) ?? "").includes("framer"), { ms: 10_000, step: 200 }));
check("the door's agent joined the world", joined);

const schema = (await rpc("tools/list")).result.tools.find((t: any) => t.name === "screenshot")?.inputSchema?.properties ?? {};
check("screenshot tool advertises pitch, dist and height", ["pitch", "dist", "height"].every((k) => k in schema), Object.keys(schema).join(","));

async function viaTool(args: Record<string, unknown>) {
  const before = asked.length;
  const r = await rpc("tools/call", { name: "screenshot", arguments: args });
  const note = r.result?.content?.find((c: any) => c.type === "text")?.text as string | undefined;
  if (/answered 429\b/.test(note ?? "")) check(BUSY, false, note);
  return { img: r.result?.content?.[0]?.type === "image", note, got: asked.length > before ? asked.at(-1) : undefined };
}
let t = await viaTool({});
check("tool, no framing → no frame on the wire", t.img && same(t.got, { view: "first" }), JSON.stringify(t.got));
t = await viaTool({ view: "first", pitch: -40 });
check("tool, pitch → forwarded, nested as frame", t.img && same(t.got, { view: "first", frame: { pitch: -40 } }), JSON.stringify(t.got));
t = await viaTool({ view: "selfie", dist: 1.2, height: 0.8 });
check("tool, dist+height → forwarded, nested as frame", t.img && same(t.got, { view: "selfie", frame: { dist: 1.2, height: 0.8 } }), JSON.stringify(t.got));
t = await viaTool({ view: "third", dist: 500, pitch: "junk", height: false });
check("tool, out-of-range / junk / boolean → clamped or dropped", t.img && same(t.got, { view: "third", frame: { dist: 30 } }), JSON.stringify(t.got));
check("tool, fields the view uses → no note", t.note === undefined, String(t.note));
t = await viaTool({ view: "selfie", pitch: 20 });
check("tool, pitch with selfie → image plus an ignored note", t.img && t.note === "pitch applies only to view first; ignored", String(t.note));
t = await viaTool({ view: "first", dist: 2, height: 1 });
check("tool, dist+height with first → named as ignored", t.img && t.note === "dist and height apply only to views third and selfie; ignored", String(t.note));
t = await viaTool({ height: 1 });
check("tool, height with the default view → named as ignored", t.img && t.note === "height applies only to views third and selfie; ignored", String(t.note));

const before = asked.length;
const h = await fetch(`http://127.0.0.1:${PORT}/snap?world=${WORLD}&follow=framer&view=third&dist=abc&height=-5&pitch=10`, KEY);
if (h.status === 429) check(BUSY, false, await h.text());
check("HTTP /snap query → normalised before the wire", h.status === 200 && asked.length > before && same(asked.at(-1), { view: "third", frame: { height: 0, pitch: 10 } }), JSON.stringify(asked.at(-1)));

// the door key guards both reads this suite makes (#260 house I575): without it, refused, and no capture dispatched
const nAsked = asked.length;
const bare = await fetch(`http://127.0.0.1:${PORT}/worlds`);
check("an unkeyed /worlds is refused", bare.status === 401 || bare.status === 403, String(bare.status));
const bareSnap = await fetch(`http://127.0.0.1:${PORT}/snap?world=${WORLD}&follow=framer&view=third`);
check("an unkeyed /snap is refused, and dispatches no capture", (bareSnap.status === 401 || bareSnap.status === 403) && asked.length === nAsked, `${bareSnap.status}, ${asked.length - nAsked} dispatched`);
for (const ws of renderers) ws.close();

// ---- 4. the broker -------------------------------------------------------------------------------------------------
// The /snap broker over real HTTP + WS: an embodied capture donor, ownership of a reply, a busy renderer waited for,
// Retry-After only when asking again can help, ?budget=, opt-out, a legacy browser renderer, disconnect, the roamer sweep,
// no log writes; then every snap outcome's status and its one escaped [snap] line, and SNAP_TIMEOUT_SEC honoured/validated.
console.log("broker (a scratch server with a capture donor, then scratch sequencers per SNAP_TIMEOUT_SEC)");
{
  const scratch = mkdtempSync(join(tmpdir(), "ew-screenshots-"));
  mkdirSync(join(scratch, "opt"));
  foundWorlds(join(scratch, "worlds"), ["screenshot-test", "other-world", "sweep-lobby", "sweep-build"]);
  writeFileSync(join(scratch, "tokens.json"), JSON.stringify({ "sweep-agent-token": { id: "sweep-agent", name: "Sweep agent" } }));   // the sweep's agent: an enrolment
  const port = freePort(18000), origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, join(ROOT, "server/server.ts")], { env: { ...process.env,
    HOST: "127.0.0.1", PORT: String(port), JOIN_TOKEN: "screenshot-test-door", WORLDS_DIR: join(scratch, "worlds"),
    OPT_DIR: join(scratch, "opt"), RELAY_STATE_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0",
    HN_SESSIONS_FILE: join(scratch, "sessions.json"), AGENT_TOKENS_PATH: join(scratch, "tokens.json"),
    HN_ISSUER_KEY: "", HN_REQUIRE_LOGIN: "0", SNAP_SWEEP_GRACE_SEC: "0", SNAP_SWEEP_EVERY_SEC: "600",   // only a roamer joining can sweep in this run
  }, stdout: "ignore", stderr: "pipe" });
  const sockets: WebSocket[] = [];
  async function connect(id: string, extras = {}, world = "screenshot-test", at = { origin, token: "screenshot-test-door" }) {
    const messages: any[] = []; const ws = new WebSocket(at.origin.replace("http:", "ws:") + "/ws"); sockets.push(ws);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id, ...(at.token ? { token: at.token } : {}), replica: true, ...extras }));
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await until(`${id}'s join`, () => messages.some((m) => m.type === "snapshot"));
    return { ws, messages, send: (m: object) => ws.send(JSON.stringify(m)) };
  }
  /** Resolves once the server has handled everything `ws` sent before it (a clock ask is answered as it is handled). */
  const handled = (ws: WebSocket) => new Promise<void>((res, rej) => {
    const t0 = Math.random(); const t = setTimeout(() => rej(new Error("no clock answer in 5s")), 5000);
    ws.addEventListener("message", function answered(ev) { const m = JSON.parse(String(ev.data)); if (m.type !== "clock" || m.t0 !== t0) return; ws.removeEventListener("message", answered); clearTimeout(t); res(); });
    ws.send(JSON.stringify({ type: "clock", t0 }));
  });
  const COOLDOWN = "the broker rests a renderer 2 s from each capture it sends it";
  // a box with a door key keeps its world reads behind it (identity-check LC): every /snap carries the key
  const KEY = { headers: { authorization: "Bearer screenshot-test-door" } };
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
  const forged = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=";

  /** A snap's outcome per cause, on a sequencer whose frame window is 2 s (and one of 20 s for the long frame). */
  async function outcomes() {
    const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    // the bystander's (refused) image differs from the renderer's, so a 200 says whose reply answered it
    const PNG_BYSTANDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const bytesOf = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1], "base64");
    const env = { SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0" };
    const lines: string[] = [];
    const A = await scratchSequencer("snap-window", { serverEnv: { ...env, SNAP_TIMEOUT_SEC: "2" }, worlds: ["snapt"], onLine: (l) => lines.push(l) });
    const C = await scratchSequencer("snap-long", { serverEnv: { ...env, SNAP_TIMEOUT_SEC: "20" }, worlds: ["snapt"], portFrom: 9050 });
    // [snap] lines are stdout's, read as they are written
    const log = () => lines;
    const logLine = async (from: number, pred: (l: string) => boolean, ms = 3000) => !!(await tryUntil("a [snap] line", () => log().slice(from).some(pred), { ms, step: 20 }));
    const on = (s: { BASE: string }) => ({ origin: s.BASE, token: "" });
    /** A fake renderer leg: `reply(id)` decides each capture; `next()` resolves on the next capture it receives. */
    const fakeRenderer = async (s: { BASE: string }, id: string) => {
      const { ws } = await connect(id, { spectate: true, renderer: true }, "snapt", on(s));
      const r = { ws, reply: (_id: string) => {}, waiters: [] as ((id: string) => void)[], next: () => new Promise<string>((res) => r.waiters.push(res)) };
      ws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.type !== "capture") return; r.waiters.splice(0).forEach((w) => w(m.id)); r.reply(m.id); });
      return r;
    };
    const reply = (ws: WebSocket, id: unknown, body: object) => ws.send(JSON.stringify({ type: "capture-result", id, ...body }));

    // past the default 12 s window: started first, checked last
    await connect("target", {}, "snapt", on(C));
    const slow = await fakeRenderer(C, "renderer-slow");
    slow.reply = (id) => setTimeout(() => reply(slow.ws, id, { dataUrl: PNG1 }), 13_000);
    const longT0 = performance.now();   // the monotonic clock: a wall-clock step isn't time waited
    const longSnap = fetch(`${C.BASE}/snap?world=snapt&follow=target`).then(async (r) => ({ status: r.status, body: Buffer.from(await r.arrayBuffer()), ms: performance.now() - longT0 }));

    await connect("target", {}, "snapt", on(A));
    const renderer = await fakeRenderer(A, "renderer-fake");
    const bystander = (await connect("retina-bystander", { spectate: true }, "snapt", on(A))).ws;
    // the broker's per-renderer cooldown (2 s), stamped at dispatch: space each snap past it, or it waits (429 once the
    // queue is full)
    let lastSnap = 0;
    const cooldown = () => pause(COOLDOWN, Math.max(0, lastSnap + 2100 - Date.now()));
    const snap = async () => { await cooldown(); const r = await fetch(`${A.BASE}/snap?world=snapt&follow=target`); lastSnap = Date.now(); return r; };
    // a connection logs one dropped reply per 10 s: a case that needs a line gets a fresh connection
    let freshN = 0;
    const fresh = async (asRenderer: boolean) => (await connect(`fresh-${asRenderer ? "renderer" : "bystander"}-${++freshN}`, asRenderer ? { spectate: true, renderer: true } : { spectate: true }, "snapt", on(A))).ws;

    // the reply table: what the renderer sends → the status, its body, and the one [snap] line it writes
    const later = (ms: number, body: object) => (id: string) => setTimeout(() => reply(renderer.ws, id, body), ms);
    const ROWS: { name: string; send: (id: string) => void; status: number; body?: (r: Response) => Promise<boolean>; line?: (l: string) => boolean }[] = [
      { name: "a reply inside the window → 200 PNG", send: later(300, { dataUrl: PNG1 }), status: 200, body: async (r) => r.headers.get("content-type") === "image/png" },
      { name: "a renderer's error reply → 503 with its text, logged on one escaped line", send: (id) => reply(renderer.ws, id, { error: "gpu lost\n[perm] forged by a renderer" }), status: 503,
        body: async (r) => (await r.text()).startsWith("gpu lost"), line: (l) => l.includes("[snap]") && l.includes("renderer-fake") && l.includes("\\n[perm] forged") && l.includes("503") },
      { name: "a reply that is not a PNG → 502, logged", send: (id) => reply(renderer.ws, id, { dataUrl: "data:image/png;base64,bm90IGEgcG5n" }), status: 502,
        line: (l) => l.includes("[snap]") && l.includes("renderer-fake") && l.includes("no valid PNG") && l.includes("502") },
    ];
    for (const row of ROWS) {
      renderer.reply = row.send; const mark = log().length;
      const r = await snap();
      check(row.name, r.status === row.status && (!row.body || await row.body(r)) && (!row.line || await logLine(mark, row.line)) && !log().slice(mark).some((l) => l.startsWith("[perm]")), `${r.status} ${log().slice(mark).join(" | ")}`);
    }
    // after the window: 504 at ~2 s, a timeout line, and the late frame's drop line
    renderer.reply = () => {};
    const lateId = renderer.next();
    let mark = log().length;
    await cooldown();
    const t0 = performance.now(); const r = await snap(); const waited = performance.now() - t0;
    check("a reply after the window → 504, answered at ~2 s, not 12 s", r.status === 504 && waited >= 1800 && waited < 10_000, `${r.status} after ${waited} ms`);
    check("…the timeout is logged with the snap, follow and renderer", await logLine(mark, (l) => l.includes("[snap]") && l.includes(`follow="target"`) && l.includes("renderer-fake") && l.includes("in 2s")));
    reply(renderer.ws, await lateId, { dataUrl: PNG1 });
    check("…and the late frame's drop is logged as expired/unknown", await logLine(mark, (l) => l.includes("[snap]") && l.includes("expired or unknown") && l.includes("renderer-fake")));

    // a non-renderer's reply is dropped and the pending snap stays pending
    renderer.reply = () => {};
    const seen = renderer.next();
    const pendingSnap = snap();
    const first = await Promise.race([seen.then((id) => ({ id })), pendingSnap.then(async (res) => ({ refused: `${res.status} ${await res.clone().text()}` }))]);
    check("the held snap reached the renderer", "id" in first, "refused" in first ? `answered ${first.refused} before dispatch` : "");
    if ("id" in first) {
      mark = log().length;
      reply(bystander, first.id, { dataUrl: PNG_BYSTANDER });
      check("a non-renderer's reply is logged and dropped", await logLine(mark, (l) => l.includes("not a renderer") && l.includes("retina-bystander")));
      reply(renderer.ws, first.id, { dataUrl: PNG1 });
      const held = await pendingSnap;
      check("…without consuming the pending snap (the renderer's frame answers it)", held.status === 200 && Buffer.from(await held.arrayBuffer()).equals(bytesOf(PNG1)), String(held.status));
    }
    // drops are bounded per connection, a credential or not: after a burst, a fresh connection's line is the ordering marker
    for (const [who, flood, id] of [["retina-bystander", bystander, "spam"], ["renderer-claimed", (await fakeRenderer(A, "renderer-claimed")).ws, "flood"]] as const) {
      mark = log().length;
      for (let i = 0; i < 50; i++) reply(flood, `${id}-${i}`, { dataUrl: PNG_BYSTANDER });
      await handled(flood);
      reply(await fresh(true), `marker-${id}`, { dataUrl: PNG1 });
      const marked = await logLine(mark, (l) => l.includes(`"marker-${id}"`));
      const mine = log().slice(mark).filter((l) => l.includes(who));
      // the bystander already logged its line above; the claimant logs its first, and only that
      check(`50 replies from ${who} inside 10 s write ${who === "retina-bystander" ? "no more lines" : "one line"}`, marked && (who === "retina-bystander" ? mine.length === 0 : mine.length === 1 && mine[0].includes(`"${id}-0"`)), `${marked ? "" : "no marker; "}${mine.join(" | ")}`);
    }
    // log hygiene, a security boundary: every drop site × every forged id, each from a connection of its own
    const FORGED: [string, unknown, (ls: string[]) => boolean][] = [
      ["an id with newlines cannot start its own log line", "missing\n[perm] forged by a client\n", (ls) => ls.some((l) => l.includes("\\n[perm] forged"))],
      ["a non-string id logs as (invalid id)", { not: "a string" }, (ls) => ls.some((l) => l.includes("(invalid id)"))],
      ["a huge id is bounded in the log", "x".repeat(5000), (ls) => ls.some((l) => l.includes("xxxx"))],
    ];
    for (const [site, asRenderer] of [["expired or unknown", true], ["not a renderer", false]] as const) for (const [name, id, seenIn] of FORGED) {
      mark = log().length;
      const ws = await fresh(asRenderer);
      reply(ws, id, { dataUrl: PNG1 });
      await handled(ws);
      await logLine(mark, (l) => l.includes(site));
      const got = log().slice(mark);
      check(`${site}: ${name}`, got.some((l) => l.includes(site)) && seenIn(got) && !got.some((l) => l.startsWith("[perm]")) && got.every((l) => l.length < 400), got.join(" | ").slice(0, 300));
    }

    const long = await longSnap;
    check("a 13 s frame answers 200 under SNAP_TIMEOUT_SEC=20, past the default 12 s window, after ~13 s", long.status === 200 && long.body.equals(bytesOf(PNG1)) && long.ms >= 12_500, `${long.status} after ${long.ms} ms`);
    await A.cleanup(); await C.cleanup();
    // (the values these fall back to, and the cap's own boundary, are read from config.ts in test/server/config-env-test.ts)
    for (const bad of ["300", "abc", "0", "-5"]) {
      const B = await scratchSequencer("snap-config", { serverEnv: { ...env, SNAP_TIMEOUT_SEC: bad } });
      const warned = !!(await tryUntil(`the SNAP_TIMEOUT_SEC=${bad} warning`, () => readSequencerLog(B.SCRATCH).includes(`SNAP_TIMEOUT_SEC=${JSON.stringify(bad)} is not valid — using 12`), { ms: 3000, step: 30 }));
      check(`SNAP_TIMEOUT_SEC=${bad} falls back to 12 with a warning`, warned, readSequencerLog(B.SCRATCH).split("\n").filter((l) => l.includes("config")).join(" | "));
      await B.cleanup();
    }
  }

  try {
    await until("the scratch server answers /version", async () => {
      if (child.exitCode !== null) throw new Error("scratch server exited: " + await new Response(child.stderr).text());
      return (await fetch(origin + "/version")).ok;
    });
    const target = await connect("screenshot-agent", { avatar: "eidoverse/assets/vrms/claude.vrm" });
    target.send({ type: "pose", pose: { p: [15, -29, 65], q: [0, 0, 0, 1], yaw: 0, clip: "idle", locomotion: { mode: "swim" } } });
    const cap = { version: 1, engine: "unreal", scene: "underwater-prototype" };
    const donor = await connect("unreal-player", { capture: cap });
    const observer = await connect("observer", { spectate: true });
    check("B1 a capture donor stays embodied", observer.messages[0].present.some((p: any) => p.id === "unreal-player"));
    const url = origin + "/snap?world=screenshot-test&follow=screenshot-agent";
    const captures = () => donor.messages.filter((m) => m.type === "capture");
    const response = fetch(url, KEY); await until("a capture dispatched to the donor", () => captures().length === 1);
    const request = captures()[0];
    // a renderer watches a world that EXISTS (watching an unfounded name is 4011, retried): other-world is founded above
    const other = await connect("other-renderer", { renderer: true }, "other-world");
    // a distinct image from the wrong renderer: were it taken, the response below would carry it (#260 house I338)
    other.send({ type: "capture-result", id: request.id, dataUrl: forged }); await handled(other.ws);   // the stray reply is handled before the donor's
    // the stray reply finished nothing: the donor is still busy, so a second ask WAITS for it (server/screenshots.ts)
    let queuedDone = false;
    const queued = fetch(url, KEY).then((q) => { queuedDone = true; return q; });
    await pause("a second ask must not be answered within 300 ms while the donor is busy", 300);
    check("B2 a second ask waits while the donor is busy", queuedDone === false);
    donor.send({ type: "capture-result", id: request.id, dataUrl: png });
    const r = await response;
    check("B3 the donor's own frame answers, with its engine and scene; another world's renderer's reply is not taken", r.status === 200 && r.headers.get("x-eidoverse-renderer") === "unreal"
      && r.headers.get("x-eidoverse-scene") === "underwater-prototype" && Buffer.from(await r.arrayBuffer()).toString("base64") === png.split(",")[1], r.status);
    // …and once the donor is free (after its cooldown), the waiting ask goes to it and is served: no "busy" on a first try
    await until("the queued capture dispatched", () => captures().length === 2);
    donor.send({ type: "capture-result", id: captures()[1].id, dataUrl: png });
    check("B4 the ask that waited is served", (await queued).status === 200);
    // Retry-After rides only a failure asking again soon can fix (screenshots.ts retryAfter): a renderer's "still loading" carries it…
    await pause(COOLDOWN, 2100);
    const refusing = fetch(url, KEY); await until("a capture to refuse", () => captures().length === 3);
    donor.send({ type: "capture-result", id: captures()[2].id, error: "the renderer is still loading this world — 1 model still loading (0 in); try again in a few seconds" });
    const refused = await refusing;
    check("B5 a renderer's refusal is 503 and retryable (Retry-After: 2)", refused.status === 503 && refused.headers.get("retry-after") === "2", `${refused.status} ${refused.headers.get("retry-after")}`);
    const nobody = await fetch(origin + "/snap?world=screenshot-test&follow=nobody", KEY);
    check("B6 a missing body is 404 and not retryable", nobody.status === 404 && nobody.headers.get("retry-after") === null, `${nobody.status} ${nobody.headers.get("retry-after")}`);
    // ?budget= bounds the ask: a donor that never answers is given up at ~1 s, not the 12 s frame window
    await pause(COOLDOWN, 2100);
    const t0 = performance.now(); const cut = await fetch(url + "&budget=1000", KEY); const took = performance.now() - t0;
    check("B7 ?budget=1000 cuts the wait: 504, retryable, under 2.5 s", cut.status === 504 && cut.headers.get("retry-after") === "2" && took < 2500, `${cut.status} ${cut.headers.get("retry-after")} after ${took.toFixed(0)} ms`);
    // an out-of-range budget is ignored: the server's own window applies, so a frame at 1.2 s still arrives
    await pause(COOLDOWN, 2100);
    const ranged = fetch(url + "&budget=10", KEY); await until("a capture under an ignored budget", () => captures().length === 5);
    await pause("the frame must arrive after the 10 ms budget would have cut it", 1200);
    donor.send({ type: "capture-result", id: captures()[4].id, dataUrl: png });
    check("B8 a budget under 1 s is ignored, not applied", (await ranged).status === 200);
    donor.send({ type: "capture-capabilities", capture: null }); await handled(donor.ws);
    const noRenderer = await fetch(url, KEY);
    check("B9 opted out, with no renderer and no roamer: 503, not retryable", noRenderer.status === 503 && noRenderer.headers.get("retry-after") === null, `${noRenderer.status} ${noRenderer.headers.get("retry-after")}`);
    const legacy = await connect("legacy", { renderer: true });
    const oldResponse = fetch(url + "&renderer=browser", KEY); await until("a browser capture", () => legacy.messages.some((m) => m.type === "capture"));
    legacy.send({ type: "capture-result", id: legacy.messages.find((m) => m.type === "capture").id, dataUrl: png });
    check("B10 &renderer=browser goes to a browser renderer and is served", (await oldResponse).status === 200);
    donor.send({ type: "capture-capabilities", capture: cap }); await handled(donor.ws); await pause(COOLDOWN, 2100);
    const before = captures().length;
    const pending = fetch(url + "&renderer=unreal", KEY); await until("the next capture", () => captures().length === before + 1);
    donor.ws.close();
    check("B11 a donor that disconnects mid-capture answers 503", (await pending).status === 503);
    // THE SWEEP: a roamer that joins its lobby is sent at once to an agent's world with no roamer (an agent: an enrolment, §6a)
    await connect("sweep-agent", { agentToken: "sweep-agent-token" }, "sweep-build");
    const roamer = await connect("sweep-roamer", { renderer: true, roam: true }, "sweep-lobby");
    // the timer sweep is 10 min away in this run (SNAP_SWEEP_EVERY_SEC), so only the join can have sent it
    const swept = !!(await tryUntil("the roamer is swept to sweep-build", () => roamer.messages.some((m) => m.type === "renderer-travel" && m.world === "sweep-build"), { ms: 3000, step: 50 }));
    check("B12 a roamer joining is swept to the agent's world within 3 s", swept);
    const wlog = readFileSync(join(scratch, "worlds", "screenshot-test", "world.jsonl"), "utf8");
    check("B13 capture is ephemeral: nothing of it in the world's log", !wlog.includes("capture-result") && !wlog.includes("capture-capabilities"));
    await outcomes();
  } finally { for (const ws of sockets) ws.close(); child.kill(); await child.exited; }
}

S.done();
