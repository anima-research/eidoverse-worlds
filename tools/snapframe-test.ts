// snapframe-test — optional /snap framing (dist / height / pitch), end to end.
//
//   bun tools/snapframe-test.ts
//
// Three layers, each of which could break without the others noticing:
//   1. shared/snapframe.js — what survives normalisation (omitted, zero,
//      junk, range limits, HTTP strings vs model arguments).
//   2. client/lib/fp_view.js — composeFirstPerson's pitch: + looks up,
//      − looks down, omitted keeps the old gaze exactly.
//   3. the wire — a scratch sequencer, a plain-door agent calling the
//      snapshot tool, an HTTP /snap, and ten fake renderer legs recording
//      the view and framing of each `snap` they're asked for. Absent fields
//      must put no `frame` on the wire.

import { normalizeSnapFrame, SNAP_DIST, SNAP_HEIGHT, SNAP_PITCH } from "../shared/snapframe.js";
import * as fp from "../client/lib/fp_view.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
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
const PORT = 8000 + Math.floor(Math.random() * 900), WORLD = "framing", TOKEN = "snapframe-test";
const seq = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: TOKEN, SKIP_OPT_SWEEP: "1", WORLDS_DIR: mkdtempSync(join(tmpdir(), "snapframe-")) },
  stdout: "ignore", stderr: "ignore",
});
let mcp: ReturnType<typeof Bun.spawn> | null = null;
process.on("exit", () => { try { mcp?.kill(); } catch {} seq.kill(); });
let up2 = false;
for (let i = 0; i < 60 && !up2; i++) { try { await fetch(`http://127.0.0.1:${PORT}/worlds`); up2 = true; } catch { await Bun.sleep(200); } }
if (!up2) { console.error("FATAL: scratch sequencer never came up (bun install in the repo root?)"); process.exit(2); }

// fake renderer legs: each answers every snap with a 1×1 PNG. They record each
// snap's view and frame, and any framing value also copied to the message's top
// level, where it could be read as framing or collide with a field such as an
// image size. Other fields aren't compared, so a sender can add its own.
// There are ten, more than the snapshots this test takes, because the broker
// rests each renderer for 2 s from the request it sends it, and answers 429 at
// once when no renderer it could use is free. Each joins before the next, and
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
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: WORLD, id: `renderer-fake-${i}`, spectate: true, renderer: true, token: TOKEN }));
    ws.onmessage = (ev) => { if (JSON.parse(String(ev.data)).type === "snapshot") { clearTimeout(timer); res(); } };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "snap") {
      const flat = m.frame ? Object.keys(m.frame).filter((k) => m[k] === m.frame[k]) : [];
      asked.push({ view: m.view, ...(m.frame === undefined ? {} : { frame: m.frame }), ...(flat.length ? { flat } : {}) });
      ws.send(JSON.stringify({ type: "snap-result", id: m.id, dataUrl: PNG }));
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
let joined = false;
for (let i = 0; i < 50; i++) { const r = await fetch(`http://127.0.0.1:${PORT}/worlds`).then((r) => r.json()).catch(() => null);
  if (JSON.stringify(r ?? "").includes("framer")) { joined = true; break; } await Bun.sleep(200); }
check("the door's agent joined the world", joined);

const schema = (await rpc("tools/list")).result.tools.find((t: any) => t.name === "snapshot")?.inputSchema?.properties ?? {};
check("snapshot tool advertises pitch, dist and height", ["pitch", "dist", "height"].every((k) => k in schema), Object.keys(schema).join(","));

async function viaTool(args: Record<string, unknown>) {
  const before = asked.length;
  const r = await rpc("tools/call", { name: "snapshot", arguments: args });
  const note = r.result?.content?.find((c: any) => c.type === "text")?.text as string | undefined;
  if (note?.includes("(429)")) check(BUSY, false, note);
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
const h = await fetch(`http://127.0.0.1:${PORT}/snap?world=${WORLD}&follow=framer&view=third&dist=abc&height=-5&pitch=10`);
if (h.status === 429) check(BUSY, false, await h.text());
check("HTTP /snap query → normalised before the wire", h.status === 200 && asked.length > before && same(asked.at(-1), { view: "third", frame: { height: 0, pitch: 10 } }), JSON.stringify(asked.at(-1)));

for (const ws of renderers) ws.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
