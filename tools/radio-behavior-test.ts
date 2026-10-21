// The radio's toggle, end to end over real websockets: sdk/examples/radio.js
// bound to an entity with a sound comp; a VISITOR's `use {action: "toggle"}`
// flips playing and stamps t0 (the script writes with its binder's standing);
// a second use pauses; an unrelated action does nothing; a use on a thing with
// no sound comp logs and does nothing.
//
// Owns its sequencer: a scratch child on a random port, proved ours by the
// nonce echo (probe-harness ownedWorld) — a fixed default port used to be the
// recipe, and a reviewer's first run judged an unrelated listener on it (Mica,
// #192 review, blocker 3). A scratch OPT_DIR rides along: the behavior store
// is under it, so the script upload lands where the bind looks.
//
//   bun tools/radio-behavior-test.ts
//
// To point it at a door you run yourself instead (identity unchecked):
//   WORLD_URL=ws://host:port/ws JOIN_TOKEN=… bun tools/radio-behavior-test.ts
import { ownedWorld, proveOwned } from "./probe-harness.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const world = process.env.WORLD_URL
  ? await ownedWorld({ live: process.env.WORLD_URL.replace(/^ws/, "http").replace(/\/ws$/, ""), key: process.env.JOIN_TOKEN ?? "test-door" })
  : await ownedWorld({ key: "test-door", env: { OPT_DIR: mkdtempSync(join(tmpdir(), "radio-opt-")), BHV_TIMER_MIN: "1" } });
const HTTP = world.origin;
const URL_ = `${HTTP.replace(/^http/, "ws")}/ws`;
const TOKEN = world.key;
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } }
type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; verb(v: string, a: any): void; settle(ms?: number): Promise<void>; close(): void };
function open(joinMsg: Record<string, unknown>): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const s: Sock = { ws, msgs: [], errors: [], verb(v, a) { ws.send(JSON.stringify({ type: "verb", verb: v, args: a })); }, settle(ms = 300) { return new Promise((r) => setTimeout(r, ms)); }, close() { try { ws.close(); } catch {} } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOKEN, ...joinMsg }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.msgs.push(m); if (m.type === "error") s.errors.push(m.error); if (m.type === "snapshot") resolve(s); };
    ws.onerror = (e) => reject(e);
  });
}
async function foldedBag(world: string, id: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const bag = eye.msgs.find((m) => m.type === "snapshot").state.entities?.[id]?.comp; eye.close(); return bag;
}
try {
const WORLD = `radiotest-${Math.random().toString(36).slice(2, 8)}`;
console.log(`\nradio toggle — world "${WORLD}"\n`);
const src = await Bun.file(new URL("../sdk/examples/radio.js", import.meta.url)).text();
const r = await fetch(`${HTTP}/upload?as=script&token=${TOKEN}&by=radiotest`, { method: "POST", body: src });
if (!r.ok) throw new Error(`script upload ${r.status}: ${await r.text()}`);
const path = (await r.json()).path;

const ra = await open({ id: "ra", world: WORLD });          // first joiner owns
await ra.settle();
ra.verb("spawn", { id: "radio1", lib: "deco/radio.glb", pos: [0, 0, 0], yaw: 0 });
ra.verb("spawn", { id: "crate1", lib: "deco/crate.glb", pos: [2, 0, 0], yaw: 0 });
ra.verb("comp", { id: "radio1", type: "sound", data: { src: "store/audio/0123456789abcdef.mp3", look: "rain on the awning", playing: false, volume: 0.6 } });
ra.verb("comp", { id: "radio1", type: "interaction", data: { action: "toggle", label: "turn the radio on/off" } });
ra.verb("behavior", { id: "radio", src: path, attach: "radio1" });
await ra.settle(800);   // sandbox load is async
check("placer set up radio1 with a paused sound, an interaction, and the radio script — no errors", ra.errors.length === 0, ra.errors.join("; "));

const vis = await open({ id: "visitor", world: WORLD });
const tBefore = Date.now();
vis.verb("use", { id: "radio1", action: "toggle" });
await vis.settle(700);
let bag = await foldedBag(WORLD, "radio1");
check("a visitor's toggle switches it ON", bag?.sound?.playing === true, JSON.stringify(bag?.sound));
check("…with a fresh t0 stamped by the script (epoch ms, now-ish)", typeof bag?.sound?.t0 === "number" && bag.sound.t0 >= tBefore - 5 && bag.sound.t0 <= Date.now() + 5, String(bag?.sound?.t0));
check("…and the rest of the bag intact (src, look, volume)", bag?.sound?.src === "store/audio/0123456789abcdef.mp3" && bag?.sound?.look === "rain on the awning" && bag?.sound?.volume === 0.6, JSON.stringify(bag?.sound));
check("the visitor's own verb was accepted (use is rank 0)", vis.errors.length === 0, vis.errors.join("; "));
const t0First = bag?.sound?.t0;

vis.verb("use", { id: "radio1", action: "toggle" });
await vis.settle(700);
bag = await foldedBag(WORLD, "radio1");
check("a second toggle switches it OFF and drops t0", bag?.sound?.playing === false && bag?.sound?.t0 === undefined, JSON.stringify(bag?.sound));

vis.verb("use", { id: "radio1", action: "kick" });
await vis.settle(500);
bag = await foldedBag(WORLD, "radio1");
check("an unrelated action leaves it alone", bag?.sound?.playing === false, JSON.stringify(bag?.sound));

await new Promise((res) => setTimeout(res, 1200));
vis.verb("use", { id: "radio1", action: "toggle" });
await vis.settle(700);
bag = await foldedBag(WORLD, "radio1");
check("switching on again stamps a NEWER t0 (a restart, not a resume)", bag?.sound?.playing === true && typeof bag?.sound?.t0 === "number" && bag.sound.t0 > (t0First ?? 0) + 1000, `${bag?.sound?.t0} vs ${t0First}`);

// the script is attached to radio1 only (selfOnly): a use on the crate is not its business
ra.verb("behavior", { id: "cratebound", src: path, attach: "crate1" });
await ra.settle(800);
vis.verb("use", { id: "crate1", action: "toggle" });
await vis.settle(600);
check("bound to a thing with no sound comp, the script logs and emits nothing (no error, no comp)", (await foldedBag(WORLD, "crate1"))?.sound === undefined && vis.errors.length === 0, vis.errors.join("; "));

for (const s of [ra, vis]) s.close();

  // the negative control: a responder that does not echo our nonce is refused
  // before any verdict — the identity check the door above passed is the one
  // thing an ambient or stale listener on the same port could not
  {
    const impostor = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === "/version" ? Response.json({ version: "impostor", nonce: "not-ours" }) : new Response("Unsupported method ('POST')", { status: 501 }) });
    const v = await proveOwned(`http://127.0.0.1:${impostor.port}`, "the-nonce-we-actually-gave", { attempts: 3 });
    check("negative control: a responder with the wrong nonce is refused, not judged", v.ours === false && /wrong nonce/.test(v.reason), JSON.stringify(v));
    const mute = Bun.serve({ port: 0, fetch: () => Response.json({ version: "stale" }) });
    const v2 = await proveOwned(`http://127.0.0.1:${mute.port}`, "any", { attempts: 3 });
    check("negative control: a responder with no nonce field is refused as a stale listener", v2.ours === false && /no nonce field/.test(v2.reason), JSON.stringify(v2));
    impostor.stop(true); mute.stop(true);
  }
} finally {
  await world.close();
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
