// Real HTTP + WS integration; --native holds an isolated sequencer for the UE probe.
// (ported 10-17: worlds are founded first — joining never founds one — joins fold the log (replica: true), and the
// broker speaks capture / capture-result here (main: snap / snap-result))
// Then outcomes(): every snap outcome over the door, one status each and one escaped [snap] line per failure cause, on scratch
// sequencers of their own (SNAP_TIMEOUT_SEC=2, =20, and each invalid value).
import { foundWorlds, scratchSequencer, readSequencerLog } from "../harness/harness.ts";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helloOf } from "../../shared/protocol/hello.js";
const scratch = mkdtempSync(join(tmpdir(), "ew-screenshots-"));
mkdirSync(join(scratch, "opt"));
foundWorlds(join(scratch, "worlds"), ["screenshot-test", "other-world", "sweep-lobby", "sweep-build"]);
writeFileSync(join(scratch, "tokens.json"), JSON.stringify({ "sweep-agent-token": { id: "sweep-agent", name: "Sweep agent" } }));   // the sweep's agent: an enrolment
const port = 18998, origin = `http://127.0.0.1:${port}`;
const native = process.argv.includes("--native");
for (const p of native ? [port, 18994] : [port]) {
  try { const probe = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }); probe.stop(true); }
  catch { throw Error(`Port ${p} occupied; refusing to run`); }
}
const child = Bun.spawn([process.execPath, "server/server.ts"], { env: { ...process.env,
  HOST: "127.0.0.1", PORT: String(port), JOIN_TOKEN: "screenshot-test-door", WORLDS_DIR: join(scratch, "worlds"),
  OPT_DIR: join(scratch, "opt"), RELAY_STATE_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0",
  HN_SESSIONS_FILE: join(scratch, "sessions.json"), AGENT_TOKENS_PATH: join(scratch, "tokens.json"),
  HN_ISSUER_KEY: "", HN_REQUIRE_LOGIN: "0", SNAP_SWEEP_GRACE_SEC: "0", SNAP_SWEEP_EVERY_SEC: "600",   // only a roamer joining can sweep in this run
}, stdout: "ignore", stderr: "pipe" });
const sockets: WebSocket[] = [];
let control: ReturnType<typeof Bun.serve> | undefined;
async function wait(fn: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await Bun.sleep(50); } throw Error(`Timeout: ${label}`);
}
async function connect(id: string, extras = {}, world = "screenshot-test", at = { origin, token: "screenshot-test-door" }) {
  const messages: any[] = []; const ws = new WebSocket(at.origin.replace("http:", "ws:") + "/ws"); sockets.push(ws);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id, ...(at.token ? { token: at.token } : {}), replica: true, ...extras }));
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  await wait(() => messages.some(m => m.type === "snapshot"), id + " join");
  return { ws, messages, send: (m: object) => ws.send(JSON.stringify(m)) };
}
// a box with a door key keeps its world reads behind it (identity-check LC): every /snap carries the key
const KEY = { headers: { authorization: "Bearer screenshot-test-door" } };
const ok = (name: string, cond: unknown, detail = "") => { assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ok  ${name}`); };
/** A snap's outcome per cause, on a sequencer whose frame window is 2 s (and one of 20 s for the long frame). */
async function outcomes() {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  // the bystander's (refused) image differs from the renderer's, so a 200 says whose reply answered it
  const PNG_BYSTANDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bytesOf = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1], "base64");
  const env = { SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0" };
  const lines: string[] = [];
  const A = await scratchSequencer("snap-window", { serverEnv: { ...env, SNAP_TIMEOUT_SEC: "2" }, worlds: ["snapt"], onLine: (l) => lines.push(l) });
  const C = await scratchSequencer("snap-long", { serverEnv: { ...env, SNAP_TIMEOUT_SEC: "20" }, worlds: ["snapt"], portFrom: 9050 });
  // [snap] lines are stdout's, read as they are written
  const log = () => lines;
  const logLine = async (from: number, pred: (l: string) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (log().slice(from).some(pred)) return true; await Bun.sleep(20); }
    return false;
  };
  const on = (s: { BASE: string }) => ({ origin: s.BASE, token: "" });
  /** A fake renderer leg: `reply(id)` decides each capture; `next()` resolves on the next capture it receives. */
  const fakeRenderer = async (s: { BASE: string }, id: string) => {
    const { ws } = await connect(id, { spectate: true, renderer: true }, "snapt", on(s));
    const r = { ws, reply: (_id: string) => {}, waiters: [] as ((id: string) => void)[], next: () => new Promise<string>((res) => r.waiters.push(res)) };
    ws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.type !== "capture") return; r.waiters.splice(0).forEach((w) => w(m.id)); r.reply(m.id); });
    return r;
  };
  const reply = (ws: WebSocket, id: unknown, body: object) => ws.send(JSON.stringify({ type: "capture-result", id, ...body }));
  /** Resolves once the server has handled everything `ws` sent before it (a clock ask is answered as it is handled). */
  const handled = (ws: WebSocket) => new Promise<void>((res, rej) => {
    const t0 = Math.random(); const t = setTimeout(() => rej(new Error("no clock answer in 5s")), 5000);
    ws.addEventListener("message", function answered(ev) { const m = JSON.parse(String(ev.data)); if (m.type !== "clock" || m.t0 !== t0) return; ws.removeEventListener("message", answered); clearTimeout(t); res(); });
    ws.send(JSON.stringify({ type: "clock", t0 }));
  });

  // past the default 12 s window: started first, checked last
  await connect("target", {}, "snapt", on(C));
  const slow = await fakeRenderer(C, "renderer-slow");
  slow.reply = (id) => setTimeout(() => reply(slow.ws, id, { dataUrl: PNG }), 13_000);
  const longT0 = performance.now();   // the monotonic clock: a wall-clock step isn't time waited
  const longSnap = fetch(`${C.BASE}/snap?world=snapt&follow=target`).then(async (r) => ({ status: r.status, body: Buffer.from(await r.arrayBuffer()), ms: performance.now() - longT0 }));

  await connect("target", {}, "snapt", on(A));
  const renderer = await fakeRenderer(A, "renderer-fake");
  const bystander = (await connect("retina-bystander", { spectate: true }, "snapt", on(A))).ws;
  // the broker's per-renderer cooldown (2 s), stamped at dispatch: space each snap past it, or it answers 429
  let lastSnap = 0;
  const cooldown = () => Bun.sleep(Math.max(0, lastSnap + 2100 - Date.now()));
  const snap = async () => { await cooldown(); const r = await fetch(`${A.BASE}/snap?world=snapt&follow=target`); lastSnap = Date.now(); return r; };
  // a connection logs one dropped reply per 10 s: a case that needs a line gets a fresh connection
  let freshN = 0;
  const fresh = async (renderer: boolean) => (await connect(`fresh-${renderer ? "renderer" : "bystander"}-${++freshN}`, renderer ? { spectate: true, renderer: true } : { spectate: true }, "snapt", on(A))).ws;

  // the reply table: what the renderer sends → the status, its body, and the one [snap] line it writes
  const later = (ms: number, body: object) => (id: string) => setTimeout(() => reply(renderer.ws, id, body), ms);
  const ROWS: { name: string; send: (id: string) => void; status: number; body?: (r: Response) => Promise<boolean>; line?: (l: string) => boolean; only?: () => boolean }[] = [
    { name: "a reply inside the window → 200 PNG", send: later(300, { dataUrl: PNG }), status: 200, body: async (r) => r.headers.get("content-type") === "image/png" },
    { name: "a renderer's error reply → 503 with its text, logged on one escaped line", send: (id) => reply(renderer.ws, id, { error: "gpu lost\n[perm] forged by a renderer" }), status: 503,
      body: async (r) => (await r.text()).startsWith("gpu lost"), line: (l) => l.includes("[snap]") && l.includes("renderer-fake") && l.includes("\\n[perm] forged") && l.includes("503") },
    { name: "a reply that is not a PNG → 502, logged", send: (id) => reply(renderer.ws, id, { dataUrl: "data:image/png;base64,bm90IGEgcG5n" }), status: 502,
      line: (l) => l.includes("[snap]") && l.includes("renderer-fake") && l.includes("no valid PNG") && l.includes("502") },
  ];
  for (const row of ROWS) {
    renderer.reply = row.send; const mark = log().length;
    const r = await snap();
    ok(row.name, r.status === row.status && (!row.body || await row.body(r)) && (!row.line || await logLine(mark, row.line)) && !log().slice(mark).some((l) => l.startsWith("[perm]")), `${r.status} ${log().slice(mark).join(" | ")}`);
  }
  // after the window: 504 at ~2 s, a timeout line, and the late frame's drop line
  renderer.reply = () => {};
  const lateId = renderer.next();
  let mark = log().length;
  await cooldown();
  const t0 = performance.now(); let r = await snap(); const waited = performance.now() - t0;
  ok("a reply after the window → 504, answered at ~2 s, not 12 s", r.status === 504 && waited >= 1800 && waited < 10_000, `${r.status} after ${waited} ms`);
  ok("…the timeout is logged with the snap, follow and renderer", await logLine(mark, (l) => l.includes("[snap]") && l.includes(`follow="target"`) && l.includes("renderer-fake") && l.includes("in 2s")));
  reply(renderer.ws, await lateId, { dataUrl: PNG });
  ok("…and the late frame's drop is logged as expired/unknown", await logLine(mark, (l) => l.includes("[snap]") && l.includes("expired or unknown") && l.includes("renderer-fake")));

  // a non-renderer's reply is dropped and the pending snap stays pending
  renderer.reply = () => {};
  const seen = renderer.next();
  const pendingSnap = snap();
  const first = await Promise.race([seen.then((id) => ({ id })), pendingSnap.then(async (res) => ({ refused: `${res.status} ${await res.clone().text()}` }))]);
  ok("the held snap reached the renderer", "id" in first, "refused" in first ? `answered ${first.refused} before dispatch` : "");
  if ("id" in first) {
    mark = log().length;
    reply(bystander, first.id, { dataUrl: PNG_BYSTANDER });
    ok("a non-renderer's reply is logged and dropped", await logLine(mark, (l) => l.includes("not a renderer") && l.includes("retina-bystander")));
    reply(renderer.ws, first.id, { dataUrl: PNG });
    const held = await pendingSnap;
    ok("…without consuming the pending snap (the renderer's frame answers it)", held.status === 200 && Buffer.from(await held.arrayBuffer()).equals(bytesOf(PNG)), String(held.status));
  }
  // drops are bounded per connection, a credential or not: after a burst, a fresh connection's line is the ordering marker
  for (const [who, flood, id] of [["retina-bystander", bystander, "spam"], ["renderer-claimed", (await fakeRenderer(A, "renderer-claimed")).ws, "flood"]] as const) {
    mark = log().length;
    for (let i = 0; i < 50; i++) reply(flood, `${id}-${i}`, { dataUrl: PNG_BYSTANDER });
    await handled(flood);
    reply(await fresh(true), `marker-${id}`, { dataUrl: PNG });
    const marked = await logLine(mark, (l) => l.includes(`"marker-${id}"`));
    const lines = log().slice(mark).filter((l) => l.includes(who));
    // the bystander already logged its line above; the claimant logs its first, and only that
    ok(`50 replies from ${who} inside 10 s write ${who === "retina-bystander" ? "no more lines" : "one line"}`, marked && (who === "retina-bystander" ? lines.length === 0 : lines.length === 1 && lines[0].includes(`"${id}-0"`)), `${marked ? "" : "no marker; "}${lines.join(" | ")}`);
  }
  // log hygiene, a security boundary: every drop site × every forged id, each from a connection of its own
  const FORGED: [string, unknown, (lines: string[]) => boolean][] = [
    ["an id with newlines cannot start its own log line", "missing\n[perm] forged by a client\n", (ls) => ls.some((l) => l.includes("\\n[perm] forged"))],
    ["a non-string id logs as (invalid id)", { not: "a string" }, (ls) => ls.some((l) => l.includes("(invalid id)"))],
    ["a huge id is bounded in the log", "x".repeat(5000), (ls) => ls.some((l) => l.includes("xxxx"))],
  ];
  for (const [site, asRenderer] of [["expired or unknown", true], ["not a renderer", false]] as const) for (const [name, id, seenIn] of FORGED) {
    mark = log().length;
    const ws = await fresh(asRenderer);
    reply(ws, id, { dataUrl: PNG });
    await handled(ws);
    await logLine(mark, (l) => l.includes(site));
    const lines = log().slice(mark);
    ok(`${site}: ${name}`, lines.some((l) => l.includes(site)) && seenIn(lines) && !lines.some((l) => l.startsWith("[perm]")) && lines.every((l) => l.length < 400), lines.join(" | ").slice(0, 300));
  }

  const long = await longSnap;
  ok("a 13 s frame answers 200 under SNAP_TIMEOUT_SEC=20, past the default 12 s window, after ~13 s", long.status === 200 && long.body.equals(bytesOf(PNG)) && long.ms >= 12_500, `${long.status} after ${long.ms} ms`);
  await A.cleanup(); await C.cleanup();
  // (the values these fall back to, and the cap's own boundary, are read from config.ts in test/server/config-env-test.ts)
  for (const bad of ["300", "abc", "0", "-5"]) {
    const B = await scratchSequencer("snap-config", { serverEnv: { ...env, SNAP_TIMEOUT_SEC: bad } });
    const warned = await (async () => { for (let i = 0; i < 100; i++) { if (readSequencerLog(B.SCRATCH).includes(`SNAP_TIMEOUT_SEC=${JSON.stringify(bad)} is not valid — using 12`)) return true; await Bun.sleep(30); } return false; })();
    ok(`SNAP_TIMEOUT_SEC=${bad} falls back to 12 with a warning`, warned, readSequencerLog(B.SCRATCH).split("\n").filter((l) => l.includes("config")).join(" | "));
    await B.cleanup();
  }
}
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const forged = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=";
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("Scratch server exited: " + await new Response(child.stderr).text());
    try { ready = (await fetch(origin + "/version")).ok; } catch {} if (ready) break; await Bun.sleep(50);
  } assert.ok(ready);
  const target = await connect("screenshot-agent", { avatar: "eidoverse/assets/vrms/claude.vrm" });
  const pose = (p = [15, -29, 65], q = [0, 0, 0, 1]) => target.send({ type: "pose", pose: { p, q, yaw: 0, clip: "idle", locomotion: { mode: "swim" } } });
  pose();
  if (native) {
    control = Bun.serve({ hostname: "127.0.0.1", port: 18994, async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/pose" && req.method === "POST") { const b = await req.json(); pose(b.p, b.q); return new Response("ok"); }
      return Response.json({ ready: true, endpoint: origin, world: "screenshot-test", scratch });
    } });
    console.log("SCREENSHOT_NATIVE_READY " + scratch);
    await new Promise<void>(resolve => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve); });
  } else {
    const cap = { version: 1, engine: "unreal", scene: "underwater-prototype" };
    const donor = await connect("unreal-player", { capture: cap });
    const observer = await connect("observer", { spectate: true });
    assert.ok(observer.messages[0].present.some((p: any) => p.id === "unreal-player"), "donor stays embodied");
    const url = origin + "/snap?world=screenshot-test&follow=screenshot-agent";
    const response = fetch(url, KEY); await wait(() => donor.messages.some(m => m.type === "capture"), "capture dispatched");
    const request = donor.messages.find(m => m.type === "capture");
    // a renderer watches a world that EXISTS (watching an unfounded name is 4011, retried): other-world is founded above
    const other = await connect("other-renderer", { renderer: true }, "other-world");
    // a distinct image from the wrong renderer: were it taken, the response below would carry it (#260 house I338)
    other.send({ type: "capture-result", id: request.id, dataUrl: forged });
    // The stray reply finished nothing: the donor is still busy with the first ask, so a second one WAITS for it
    // (server/screenshots.ts: a busy renderer is waited for, not refused) instead of being served the stray frame.
    let queuedDone = false;
    const queued = fetch(url, KEY).then((q) => { queuedDone = true; return q; });
    await Bun.sleep(300); assert.equal(queuedDone, false, "a second ask waits while the donor is busy");
    donor.send({ type: "capture-result", id: request.id, dataUrl: png });
    const r = await response; assert.equal(r.status, 200); assert.equal(r.headers.get("x-eidoverse-renderer"), "unreal");
    assert.equal(r.headers.get("x-eidoverse-scene"), "underwater-prototype");
    assert.equal(Buffer.from(await r.arrayBuffer()).toString("base64"), png.split(",")[1]);
    // …and once the donor is free (after its cooldown), the waiting ask goes to it and is served: no "busy" on a first try
    await wait(() => donor.messages.filter(m => m.type === "capture").length === 2, "queued capture dispatched");
    donor.send({ type: "capture-result", id: donor.messages.filter(m => m.type === "capture")[1].id, dataUrl: png });
    assert.equal((await queued).status, 200, "the ask that waited is served");
    const snapsSoFar = () => donor.messages.filter(m => m.type === "capture");
    // Retry-After rides only a failure asking again soon can fix (screenshots.ts retryAfter): the MCPL tool's whole
    // retry policy reads it. A renderer's own "still loading" refusal carries it…
    await Bun.sleep(2100);   // the donor's cooldown
    const refusing = fetch(url, KEY); await wait(() => snapsSoFar().length === 3, "a capture to refuse");
    donor.send({ type: "capture-result", id: snapsSoFar()[2].id, error: "the renderer is still loading this world — 1 model still loading (0 in); try again in a few seconds" });
    const refused = await refusing;
    assert.equal(refused.status, 503); assert.equal(refused.headers.get("retry-after"), "2", "a renderer's refusal is retryable");
    // …a body that isn't there does not
    const nobody = await fetch(origin + "/snap?world=screenshot-test&follow=nobody", KEY);
    assert.equal(nobody.status, 404); assert.equal(nobody.headers.get("retry-after"), null, "a missing body is not retryable");
    // ?budget= bounds the ask: a donor that never answers is given up at ~1 s, not the 12 s frame window
    await Bun.sleep(2100);
    const t0 = Date.now(); const cut = await fetch(url + "&budget=1000", KEY);
    assert.equal(cut.status, 504); assert.equal(cut.headers.get("retry-after"), "2", "a timeout is retryable");
    assert.ok(Date.now() - t0 < 2500, `the caller's budget cut the wait (${Date.now() - t0} ms)`);
    // an out-of-range budget is ignored: the server's own window applies, so a frame at 1.2 s still arrives
    await Bun.sleep(2100);
    const ranged = fetch(url + "&budget=10", KEY); await wait(() => snapsSoFar().length === 5, "a capture under an ignored budget");
    await Bun.sleep(1200); donor.send({ type: "capture-result", id: snapsSoFar()[4].id, dataUrl: png });
    assert.equal((await ranged).status, 200, "a budget under 1 s is ignored, not applied");
    donor.send({ type: "capture-capabilities", capture: null }); await Bun.sleep(50);
    const noRenderer = await fetch(url, KEY);
    assert.equal(noRenderer.status, 503); assert.equal(noRenderer.headers.get("retry-after"), null, "no renderer and no roamer is not retryable");
    const legacy = await connect("legacy", { renderer: true });
    const oldResponse = fetch(url + "&renderer=browser", KEY); await wait(() => legacy.messages.some(m => m.type === "capture"), "browser capture");
    legacy.send({ type: "capture-result", id: legacy.messages.find(m => m.type === "capture").id, dataUrl: png }); assert.equal((await oldResponse).status, 200);
    donor.send({ type: "capture-capabilities", capture: cap }); await Bun.sleep(2100);
    const before = donor.messages.filter(m => m.type === "capture").length;
    const pending = fetch(url + "&renderer=unreal", KEY); await wait(() => donor.messages.filter(m => m.type === "capture").length === before + 1, "the next capture");
    donor.ws.close(); assert.equal((await pending).status, 503);
    // THE SWEEP, as the server wires it: an agent alone in a world with no roamer anywhere gets none (pre-warm finds
    // none to send); a roamer that then joins its lobby is sent there at once, with no screenshot asked
    // an agent is a body with an agent's enrolment (its credential: tokenVerified, never a declaration, §6a)
    await connect("sweep-agent", { agentToken: "sweep-agent-token" }, "sweep-build");
    const roamer = await connect("sweep-roamer", { renderer: true, roam: true }, "sweep-lobby");
    // the timer sweep is 10 min away in this run (SNAP_SWEEP_EVERY_SEC), so only the join can have sent it, ~1 s after
    for (let i = 0; i < 60 && !roamer.messages.some(m => m.type === "renderer-travel" && m.world === "sweep-build"); i++) await Bun.sleep(50);
    assert.ok(roamer.messages.some(m => m.type === "renderer-travel" && m.world === "sweep-build"), "a roamer joining was swept to the agent's world within 3 s");
    const log = readFileSync(join(scratch, "worlds", "screenshot-test", "world.jsonl"), "utf8");
    assert.ok(!log.includes("capture-result") && !log.includes("capture-capabilities"), "capture is ephemeral");
    console.log("SNAPSHOTS_WIRE_PASS: embodied donor, PNG route, ownership, a busy renderer waited for, Retry-After only when retryable, ?budget= bounds an ask, opt-out, legacy browser, disconnect cleanup, a joining roamer swept to an agent, no log writes");
    await outcomes();
    console.log("SNAPSHOTS_OUTCOMES_PASS: one status and one escaped line per cause, drops bounded per connection, SNAP_TIMEOUT_SEC honoured and validated");
  }
} finally { control?.stop(true); for (const ws of sockets) ws.close(); child.kill(); await child.exited; }
