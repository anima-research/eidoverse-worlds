// (ported 10-17: the broker speaks `capture` here, and an agent is a body with an agent's enrolment, tokenVerified — never a declaration)
import { test, expect } from "bun:test";
import { createScreenshotBroker, captureCapability, pngFromDataURL } from "../server/screenshots.ts";
import type { World, Client } from "../server/world.ts";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const cap = { version: 1, engine: "unreal", scene: "underwater-prototype" };
function setup(options = {}) {
  // these renderers have long been serving the world: no arrival window for having just joined (that rule's own tests
  // are below, "a renderer that joined moments ago…")
  const broker = createScreenshotBroker({ cooldownMs: 0, timeoutMs: 100, arrivalTimeoutMs: 0, ...options });
  // a world has a folded state; an open one (no owner) lets every renderer in (server/access.ts)
  const world = { name: "test", clients: new Set<Client>(), state: { roles: {}, bans: {} } } as unknown as World;
  const make = (id: string, opts = {}) => {
    const messages: any[] = [];
    const c = { id, world, spectator: false, gen: 1, surface: "world", ws: { readyState: 1, send: (s: string) => messages.push(JSON.parse(s)) }, ...opts } as Client;
    world.clients.add(c); return { c, messages };
  };
  const target = make("agent"), donor = make("player");
  broker.configure(donor.c, cap);
  return { broker, world, make, target, donor };
}
test("strict capability normalization; donation does not make an embodied player a spectator", () => {
  const { donor } = setup(); expect(donor.c.spectator).toBe(false);
  expect(captureCapability(cap)).toEqual(cap);
  for (const bad of [null, true, {}, { ...cap, version: 2 }, { ...cap, engine: "unknown" }, { ...cap, scene: "anything" }]) expect(captureCapability(bad)).toBeUndefined();
});
test("PNG container bounds, base64, signature, dimensions, truncation", () => {
  expect(pngFromDataURL(png)?.length).toBeGreaterThan(0);
  for (const bad of [null, "", "data:text/html;base64,abcd", png + "!", png.slice(0, -12), "data:image/png;base64," + "A".repeat(6_000_000)]) expect(pngFromDataURL(bad)).toBeNull();
  const bytes = Buffer.from(png.split(",")[1], "base64"); bytes.writeUInt32BE(100_000, 16);
  expect(pngFromDataURL("data:image/png;base64," + bytes.toString("base64"))).toBeNull();
});
test("auto selects Unreal; exact socket/session/world owns response; duplicate is inert", async () => {
  const { broker, world, make, donor } = setup();
  const thief = make("other", { renderer: true, spectator: true });
  const result = broker.request(world, "agent", "selfie");
  const request = donor.messages[0]; expect(request).toMatchObject({ type: "capture", follow: "agent", view: "selfie", width: 960, height: 540 });
  broker.receive(thief.c, { id: request.id, dataUrl: png }); expect(broker.pendingCount).toBe(1);
  donor.c.gen = 2; broker.receive(donor.c, { id: request.id, dataUrl: png }); expect(broker.pendingCount).toBe(1); donor.c.gen = 1;
  donor.c.world = null; broker.receive(donor.c, { id: request.id, dataUrl: png }); expect(broker.pendingCount).toBe(1); donor.c.world = world;
  broker.receive(donor.c, { id: request.id, dataUrl: png });
  expect(await result).toMatchObject({ ok: true, engine: "unreal", scene: "underwater-prototype" });
  broker.receive(donor.c, { id: request.id, dataUrl: png }); expect(broker.pendingCount).toBe(0);
});
test("legacy browser renderer and explicit selection remain compatible", async () => {
  const { broker, world, make, donor } = setup();
  const browser = make("legacy", { renderer: true, spectator: true });
  const result = broker.request(world, "agent", "bad-view", "browser");
  expect(donor.messages.length).toBe(0); expect(browser.messages[0].view).toBe("first");
  broker.receive(browser.c, { id: browser.messages[0].id, dataUrl: png });
  expect(await result).toMatchObject({ ok: true, engine: "browser", scene: "world-fold" });
});
test("no target, invalid selector, no donor, busy, invalid result, backpressure", async () => {
  const { broker, world, donor } = setup({ queueMs: 0 });   // busy answers at once when nothing may wait (queueing: below)
  expect(await broker.request(world, "missing")).toMatchObject({ status: 404 });
  expect(await broker.request(world, "agent", "first", "bad")).toMatchObject({ status: 400 });
  expect(await broker.request(world, "agent", "first", "browser")).toMatchObject({ status: 503 });
  const pending = broker.request(world, "agent");
  expect(await broker.request(world, "agent")).toMatchObject({ status: 429 });
  broker.receive(donor.c, { id: donor.messages[0].id, dataUrl: "invalid" }); expect(await pending).toMatchObject({ status: 502 });
  donor.c.ws.getBufferedAmount = () => 500_000; expect(await broker.request(world, "agent")).toMatchObject({ status: 429 });
});
test("bounded inflight work, cooldown, timeout cleanup", async () => {
  let time = 0;
  const { broker, world, donor } = setup({ cooldownMs: 2000, timeoutMs: 5, now: () => time, queueMs: 0 });
  expect(await broker.request(world, "agent")).toMatchObject({ status: 504 }); expect(broker.pendingCount).toBe(0);
  expect(await broker.request(world, "agent")).toMatchObject({ status: 429 }); time = 2000;
  const result = broker.request(world, "agent"); broker.retire(donor.c); expect(await result).toMatchObject({ status: 503 });
  const blocked = setup({ maxPending: 0, queueMs: 0 }); expect(await blocked.broker.request(blocked.world, "agent")).toMatchObject({ status: 429 });
});
test("opt-out, target disconnect, renderer retirement release pending work", async () => {
  for (const who of ["donor", "target", "opt-out"] as const) {
    const { broker, world, donor, target } = setup(); const result = broker.request(world, "agent");
    if (who === "opt-out") broker.configure(donor.c, null); else broker.retire(who === "donor" ? donor.c : target.c);
    expect(await result).toMatchObject({ status: 503 }); expect(broker.pendingCount).toBe(0);
  }
});
test("transport send exception never escapes broker", async () => {
  const { broker, world, donor } = setup(); donor.c.ws.send = () => { throw Error("closed"); };
  expect(await broker.request(world, "agent")).toMatchObject({ status: 503 }); expect(broker.pendingCount).toBe(0);
});

// ---- roaming renderers ----
function roamSetup(opts = {}) {
  const all = new Set<Client>();
  const broker = createScreenshotBroker({ cooldownMs: 0, timeoutMs: 200, arrivalTimeoutMs: 400, travelMs: 400, pollMs: 10, allClients: () => all, ...opts });
  const worldOf = (name: string) => ({ name, clients: new Set<Client>(), state: { roles: {}, bans: {} } } as unknown as World);
  const join = (world: World, id: string, extra = {}) => {
    const messages: any[] = [];
    const c = { id, world, spectator: false, gen: 1, surface: "world", ws: { readyState: 1, send: (s: string) => messages.push(JSON.parse(s)) }, ...extra } as Client;
    world.clients.add(c); all.add(c); return { c, messages };
  };
  const leave = (c: Client) => { c.world?.clients.delete(c); all.delete(c); c.world = null; };
  return { broker, worldOf, join, leave, all };
}
test("an agent alone in a world gets a roaming renderer sent there, and its screenshot", async () => {
  const { broker, worldOf, join, leave } = roamSetup();
  const lobby = worldOf("commons"), build = worldOf("my-build");
  const roamer = join(lobby, "renderer-mac-gpu-roam-commons", { renderer: true, roam: true, spectator: true });
  join(build, "agent");
  const result = broker.request(build, "agent", "third");
  await Bun.sleep(20);
  expect(roamer.messages.at(-1)).toEqual({ type: "renderer-travel", world: "my-build" });
  // the renderer re-joins: a NEW connection in the new world, still roaming
  leave(roamer.c); const arrived = join(build, "renderer-mac-gpu-roam-commons", { renderer: true, roam: true, spectator: true });
  await Bun.sleep(40);
  const snap = arrived.messages.find((m) => m.type === "capture"); expect(snap).toMatchObject({ follow: "agent", view: "third" });
  broker.receive(arrived.c, { id: snap.id, dataUrl: png });
  expect(await result).toMatchObject({ ok: true });
});
test("a world already served is never summoned to; a roamer busy elsewhere is not taken", async () => {
  const { broker, worldOf, join } = roamSetup();
  const a = worldOf("a"), b = worldOf("b");
  const roamer = join(a, "roam1", { renderer: true, roam: true, spectator: true });
  join(a, "agentA"); join(b, "agentB");
  const busy = broker.request(a, "agentA", "first");             // served in place: no travel
  expect(roamer.messages.some((m) => m.type === "renderer-travel")).toBe(false);
  const other = await broker.request(b, "agentB", "first");      // its only roamer is mid-shot in a
  expect(other).toMatchObject({ ok: false, status: 503 });
  expect(String((other as any).err)).toMatch(/no roaming renderer could come/);
  broker.receive(roamer.c, { id: roamer.messages.find((m) => m.type === "capture").id, dataUrl: png }); await busy;
});
test("no roamer: an explicit 503; an Unreal-only request is never summoned", async () => {
  const { broker, worldOf, join } = roamSetup();
  const w = worldOf("alone"); join(w, "agent");
  expect(await broker.request(w, "agent")).toMatchObject({ ok: false, status: 503 });
  const lobby = worldOf("lobby"); const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  expect(await broker.request(w, "agent", "first", "unreal")).toMatchObject({ ok: false, status: 503 });
  expect(roamer.messages.length).toBe(0);
});
test("a renderer still loading says so: its words reach the asker as a retryable 503, never a partial image", async () => {
  const { broker, worldOf, join } = roamSetup();
  const w = worldOf("w"); const r = join(w, "renderer", { renderer: true, spectator: true }); join(w, "agent");
  const result = broker.request(w, "agent");
  const snap = r.messages.find((m) => m.type === "capture");
  broker.receive(r.c, { id: snap.id, error: "the renderer is still loading this world — 3 models still loading (12 in); try again in a few seconds" });
  expect(await result).toMatchObject({ ok: false, status: 503, err: expect.stringMatching(/still loading this world — 3 models/) });
});
test("prewarm: an agent arriving where no renderer serves sends one roamer, once", async () => {
  const { broker, worldOf, join } = roamSetup();
  const lobby = worldOf("lobby"), w = worldOf("fresh");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  broker.prewarm(w); broker.prewarm(w);
  expect(roamer.messages.filter((m) => m.type === "renderer-travel")).toEqual([{ type: "renderer-travel", world: "fresh" }]);
  const served = worldOf("served"); join(served, "renderer", { renderer: true, spectator: true });
  broker.prewarm(served); expect(roamer.messages.length).toBe(1);
  await Bun.sleep(450);   // the unanswered summons expires
});
test("rotation: a parked roamer goes before one an agent is using; pre-warm never takes a world's roamer from it", async () => {
  const { broker, worldOf, join, leave } = roamSetup();
  const busyWorld = worldOf("busy"), parked = worldOf("parked"), fresh = worldOf("fresh"), fresh2 = worldOf("fresh2");
  // a roamer an agent is actively using (it asked a screenshot just now) — and one parked where nobody is
  const inUse = join(busyWorld, "roam-a", { renderer: true, roam: true, spectator: true });
  join(busyWorld, "agentBusy", { tokenVerified: true });
  const shot = broker.request(busyWorld, "agentBusy");
  broker.receive(inUse.c, { id: inUse.messages.find((m) => m.type === "capture").id, dataUrl: png }); await shot;
  const free = join(parked, "roam-b", { renderer: true, roam: true, spectator: true });
  // a new agent elsewhere: the PARKED roamer is sent, not the one in use
  join(fresh, "agentFresh", { tokenVerified: true }); broker.prewarm(fresh);
  expect(free.messages.at(-1)).toEqual({ type: "renderer-travel", world: "fresh" });
  expect(inUse.messages.some((m) => m.type === "renderer-travel")).toBe(false);
  // with only the in-use roamer left: a pre-warm does NOT take it…
  leave(free.c); join(fresh2, "agentFresh2", { tokenVerified: true }); broker.prewarm(fresh2);
  expect(inUse.messages.some((m) => m.type === "renderer-travel")).toBe(false);
  // …but a screenshot actually asked does (never refused while a roamer exists)
  await Bun.sleep(450);   // the unanswered pre-warm summons for fresh expires
  void broker.request(fresh2, "agentFresh2"); await Bun.sleep(30);
  expect(inUse.messages.at(-1)).toEqual({ type: "renderer-travel", world: "fresh2" });
  await Bun.sleep(450);
});
test("maxWaitMs: a roamer's journey, then the larger of its arrival window and the frame window", () => {
  const { broker } = roamSetup();   // travelMs 400, arrivalTimeoutMs 400, timeoutMs 200
  expect(broker.maxWaitMs).toBe(400 + 400);
  broker.setFrameTimeout(900);      // a frame window past the arrival window
  expect(broker.maxWaitMs).toBe(400 + 900);
});
test("at SNAP_TIMEOUT_SEC's cap, GET /snap's per-request timeout still covers the broker's longest wait", () => {
  const broker = createScreenshotBroker();   // the server's defaults: a 25 s journey, a 40 s arrival window
  broker.setFrameTimeout(225_000);         // config.ts's largest accepted window
  // routes.ts sets min(255, ceil(maxWaitMs / 1000) + 5) seconds: at the cap, the 255 must not bind
  expect(Math.ceil(broker.maxWaitMs / 1000) + 5).toBeLessThanOrEqual(255);
});
/** Resolve once `pred` holds, polling, or fail naming `what` after `ms`. */
async function until(pred: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`); await Bun.sleep(5); }
}
test("a summoned roamer gets the frame window when it is longer than the arrival window", async () => {
  // a journey long enough for the test's own steps; the arrival window stays 400 ms
  const { broker, worldOf, join, leave } = roamSetup({ travelMs: 10_000 });
  broker.setFrameTimeout(3000);
  const lobby = worldOf("commons"), build = worldOf("my-build");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  join(build, "agent");
  const result = broker.request(build, "agent", "third");
  await until(() => roamer.messages.some((m) => m.type === "renderer-travel"), "the summons");
  expect(roamer.messages.at(-1)).toEqual({ type: "renderer-travel", world: "my-build" });
  leave(roamer.c); const arrived = join(build, "roam", { renderer: true, roam: true, spectator: true });
  await until(() => arrived.messages.some((m) => m.type === "capture"), "the capture's dispatch");
  const snap = arrived.messages.find((m) => m.type === "capture");
  await Bun.sleep(1000);             // past the 400 ms arrival window, well inside the 3 s frame window
  broker.receive(arrived.c, { id: snap.id, dataUrl: png });
  expect(await result).toMatchObject({ ok: true });
});
test("a connection's dropped replies log one line per dropLogMs (10 s by default), the rest counted into its next line", () => {
  let time = 0; const lines: string[] = [];
  const { broker, worldOf, join } = roamSetup({ now: () => time, log: (l: string) => lines.push(l) });
  const w = worldOf("w");
  const claimant = join(w, "claimant", { renderer: true, spectator: true });   // the renderer flag, claimed with no credential
  const other = join(w, "other", { spectator: true });                         // no renderer flag at all
  for (let i = 0; i < 5; i++) broker.receive(claimant.c, { id: `x${i}`, dataUrl: png });
  expect(lines).toHaveLength(1); expect(lines[0]).toContain('"x0"');
  broker.receive(other.c, { id: "y0", dataUrl: png });   // each connection is bounded on its own
  expect(lines).toHaveLength(2); expect(lines[1]).toContain("not a renderer");
  time = 9_999; broker.receive(claimant.c, { id: "x5", dataUrl: png });
  expect(lines).toHaveLength(2);
  time = 10_000; broker.receive(claimant.c, { id: "x6", dataUrl: png });
  expect(lines).toHaveLength(3); expect(lines[2]).toContain('"x6"'); expect(lines[2]).toContain("and 5 more");
  // the window starts again at the line just written, and so does the count
  time = 10_001; broker.receive(claimant.c, { id: "x7", dataUrl: png });
  expect(lines).toHaveLength(3);
  time = 20_000; broker.receive(claimant.c, { id: "x8", dataUrl: png });
  expect(lines).toHaveLength(4); expect(lines[3]).toContain('"x8"'); expect(lines[3]).toContain("and 1 more");
});
test("a reply for a snap dispatched to another renderer is a drop like any other, bounded per connection", async () => {
  const lines: string[] = [];
  const { broker, world, make, donor } = setup({ log: (l: string) => lines.push(l) });
  const other = make("other", { renderer: true, spectator: true });
  const result = broker.request(world, "agent");
  const request = donor.messages[0];
  for (let i = 0; i < 5; i++) broker.receive(other.c, { id: request.id, dataUrl: png });
  const fromOther = lines.filter((l) => l.includes('from "other"'));
  expect(fromOther).toHaveLength(1); expect(fromOther[0]).toContain('it was sent to "player"');
  expect(broker.pendingCount).toBe(1);
  broker.receive(donor.c, { id: request.id, dataUrl: png });
  expect(await result).toMatchObject({ ok: true });
});

// ---- a first screenshot comes back with a picture (2026-10-24) ----
test("a busy renderer is waited for: two asks at once both come back with a picture", async () => {
  const { broker, world, donor } = setup({ pollMs: 5, queueMs: 2000, timeoutMs: 1000 });
  const first = broker.request(world, "agent"), second = broker.request(world, "agent");
  await Bun.sleep(20);
  expect(donor.messages.filter((m) => m.type === "capture").length).toBe(1);   // one at a time per renderer
  broker.receive(donor.c, { id: donor.messages[0].id, dataUrl: png });
  expect(await first).toMatchObject({ ok: true });
  await Bun.sleep(30);
  const next = donor.messages.filter((m) => m.type === "capture");
  expect(next.length).toBe(2);
  broker.receive(donor.c, { id: next[1].id, dataUrl: png });
  expect(await second).toMatchObject({ ok: true });
});
test("…waiting is bounded: a renderer busy past queueMs is still 'busy', and a body that leaves is 404", async () => {
  const { broker, world, donor, target } = setup({ pollMs: 5, queueMs: 60, timeoutMs: 1000 });
  void broker.request(world, "agent");
  const t0 = Date.now(); const late = await broker.request(world, "agent");
  expect(late).toMatchObject({ ok: false, status: 429 }); expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  const queued = broker.request(world, "agent");
  world.clients.delete(target.c);
  expect(await queued).toMatchObject({ ok: false, status: 404 });
  broker.retire(donor.c);
});
test("the renderer is told how long it may load the world: its frame window less the margin", async () => {
  const { broker, world, donor } = setup({ timeoutMs: 12_000, settleMarginMs: 2_000 });
  const r = broker.request(world, "agent");
  expect(donor.messages[0]).toMatchObject({ type: "capture", wait: 10_000 });
  broker.receive(donor.c, { id: donor.messages[0].id, dataUrl: png }); await r;
});
test("a summoned roamer gets the arrival window to load the world, cut to the request's deadline", async () => {
  const { broker, worldOf, join, leave } = roamSetup({ travelMs: 10_000, arrivalTimeoutMs: 40_000, timeoutMs: 12_000, budgetMs: 55_000, settleMarginMs: 2_000 });
  const lobby = worldOf("lobby"), w = worldOf("w");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true }); join(w, "agent");
  const result = broker.request(w, "agent");
  await Bun.sleep(20); leave(roamer.c);
  const there = join(w, "roam", { renderer: true, roam: true, spectator: true });
  await Bun.sleep(40);
  const snap = there.messages.find((m) => m.type === "capture");
  // the full arrival window (40 s) fits inside the 55 s deadline after a quick journey: 40 s less the 2 s margin
  expect(snap.wait).toBe(38_000);
  broker.receive(there.c, { id: snap.id, dataUrl: png }); expect(await result).toMatchObject({ ok: true });
  // a deadline shorter than the arrival window cuts the renderer's wait to fit it
  const tight = roamSetup({ travelMs: 10_000, arrivalTimeoutMs: 40_000, timeoutMs: 1_000, budgetMs: 5_000, settleMarginMs: 1_000 });
  const l2 = tight.worldOf("lobby"), w2 = tight.worldOf("w2");
  const r2 = tight.join(l2, "roam", { renderer: true, roam: true, spectator: true }); tight.join(w2, "agent");
  const res2 = tight.broker.request(w2, "agent"); await Bun.sleep(20); tight.leave(r2.c);
  const t2 = tight.join(w2, "roam", { renderer: true, roam: true, spectator: true }); await Bun.sleep(40);
  const s2 = t2.messages.find((m) => m.type === "capture");
  expect(s2.wait).toBeLessThanOrEqual(4_000); expect(s2.wait).toBeGreaterThan(3_000);
  tight.broker.receive(t2.c, { id: s2.id, dataUrl: png }); await res2;
});
test("sweep: an agent's world with no renderer gets a PARKED roamer; a served world and a roamer in use are left alone", async () => {
  const { broker, worldOf, join } = roamSetup({ sweepAfterMs: 0 });
  const lobby = worldOf("lobby"), a = worldOf("a"), b = worldOf("b"), served = worldOf("served"), used = worldOf("used");
  const parked = join(lobby, "roam-parked", { renderer: true, roam: true, spectator: true });
  const inUse = join(used, "roam-used", { renderer: true, roam: true, spectator: true });
  join(used, "agentUsed", { tokenVerified: true });
  join(served, "renderer", { renderer: true, spectator: true }); join(served, "agentServed", { tokenVerified: true });
  join(a, "agentA", { tokenVerified: true }); join(b, "agentB", { tokenVerified: true });
  broker.sweep();
  const sentTo = parked.messages.filter((m) => m.type === "renderer-travel").map((m) => m.world);
  expect(sentTo.length).toBe(1);                                   // one parked roamer goes to ONE world, not two
  expect(["a", "b"]).toContain(sentTo[0]);
  expect(inUse.messages.some((m) => m.type === "renderer-travel")).toBe(false);   // never taken from an agent's world
  broker.sweep();                                                  // a second sweep while it travels sends nothing new
  expect(parked.messages.filter((m) => m.type === "renderer-travel").length).toBe(1);
  await Bun.sleep(450);
});
test("sweep: a world with no agent in it is not served, and a roamer restarted into its lobby goes back", async () => {
  const { broker, worldOf, join, leave } = roamSetup({ sweepAfterMs: 0 });
  const lobby = worldOf("lobby"), empty = worldOf("empty"), w = worldOf("w");
  join(empty, "a-person");                                         // people alone don't need a renderer
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  broker.sweep(); expect(roamer.messages.length).toBe(0);
  join(w, "agent", { tokenVerified: true });
  // the roamer served w, then its watchdog restarted it into its lobby: a new connection there
  leave(roamer.c); const back = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  broker.sweep();
  expect(back.messages.filter((m) => m.type === "renderer-travel")).toEqual([{ type: "renderer-travel", world: "w" }]);
  await Bun.sleep(450);
});
test("sweep waits out a start (renderers reconnecting), then serves", async () => {
  let time = 0;
  const { broker, worldOf, join } = roamSetup({ now: () => time, sweepAfterMs: 30_000 });
  const lobby = worldOf("lobby"), w = worldOf("w");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true }); join(w, "agent", { tokenVerified: true });
  time = 29_000; broker.sweep(); expect(roamer.messages.length).toBe(0);
  time = 30_000; broker.sweep(); expect(roamer.messages).toEqual([{ type: "renderer-travel", world: "w" }]);
});
test("sweep leaves a world whose own renderer is restarting; a roamer that came while it was gone is free again", async () => {
  let time = 0;
  const { broker, worldOf, join, leave } = roamSetup({ now: () => time, sweepAfterMs: 0, pinnedGraceMs: 120_000, travelMs: 400 });
  const lobby = worldOf("lobby"), commons = worldOf("commons"), other = worldOf("other");
  const pinned = join(commons, "renderer-mac-gpu-commons", { renderer: true, spectator: true, trustedRenderer: true });
  join(commons, "agentC", { tokenVerified: true });
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  broker.sweep();                                       // commons is served: nothing to do, and its renderer is noted
  leave(pinned.c);                                      // the commons renderer restarts…
  time = 60_000; broker.sweep();
  expect(roamer.messages.length).toBe(0);               // …a minute in, no roamer is sent to load the commons for nothing
  time = 125_000; broker.sweep();                       // past the grace it really is unserved: a roamer goes
  expect(roamer.messages.at(-1)).toEqual({ type: "renderer-travel", world: "commons" });
  // the roamer arrives; then the commons renderer is back: the roamer is not needed there, so it counts as parked
  leave(roamer.c); const inCommons = join(commons, "roam", { renderer: true, roam: true, spectator: true });
  join(commons, "renderer-mac-gpu-commons", { renderer: true, spectator: true, trustedRenderer: true });
  join(other, "agentO", { tokenVerified: true });
  await Bun.sleep(30);                                  // the summons to commons sees its roamer arrive
  time = 200_000; broker.sweep();
  expect(inCommons.messages.at(-1)).toEqual({ type: "renderer-travel", world: "other" });
});
// ---- review of #279: a fair, bounded queue; retryable only when it is; the caller's budget; sweep back-off ----
/** A hand-driven poll for queue tests: each waiter's next look at its renderers waits here until the test lets
 *  it go, in the order the test chooses, so who looks first is decided, not left to timers. */
function manualPolls() {
  const looks: (() => void)[] = [];
  const settle = async () => { for (let i = 0; i < 5; i++) await Bun.sleep(0); };
  return {
    pollSleep: () => new Promise<void>((res) => { looks.push(res); }),
    waiting: () => looks.length,
    /** let the i-th waiting look happen (0 = the one that started waiting earliest) */
    async look(i: number) { const [go] = looks.splice(i, 1); go(); await settle(); },
    settle,
  };
}
test("the queue is first come, first served: an older ask is never passed by a newer one", async () => {
  const polls = manualPolls();
  const { broker, world, donor } = setup({ queueMs: 5000, timeoutMs: 3000, pollSleep: polls.pollSleep });
  const snaps = () => donor.messages.filter((m) => m.type === "capture");
  const holding = broker.request(world, "agent");                    // the renderer is busy
  const order: string[] = [];
  const older = broker.request(world, "agent").then((r) => { order.push("older"); return r; });
  await polls.settle();
  const newer = broker.request(world, "agent").then((r) => { order.push("newer"); return r; });
  await polls.settle();
  expect(polls.waiting()).toBe(2);                                    // [older's look, newer's look]
  broker.receive(donor.c, { id: snaps()[0].id, dataUrl: png }); await holding;   // the renderer is free
  await polls.look(1);                                                // the NEWER looks first…
  expect(snaps().length).toBe(1);                                     // …and leaves the renderer to the older
  await polls.look(0);                                                // the older looks: it takes it
  expect(snaps().length).toBe(2);
  broker.receive(donor.c, { id: snaps()[1].id, dataUrl: png });
  expect((await older).ok).toBe(true); expect(order).toEqual(["older"]);
  await polls.look(0);                                                // now the newer's turn
  broker.receive(donor.c, { id: snaps()[2].id, dataUrl: png });
  expect((await newer).ok).toBe(true); expect(order).toEqual(["older", "newer"]);
});
test("…and a new ask arriving as the renderer comes free does not jump ahead of one already waiting", async () => {
  const { broker, world, donor } = setup({ pollMs: 50, queueMs: 5000, timeoutMs: 2000 });
  const first = broker.request(world, "agent");
  await Bun.sleep(5);
  let waitedServed = false;
  const waited = broker.request(world, "agent").then((r) => { waitedServed = true; return r; });
  await Bun.sleep(5);
  broker.receive(donor.c, { id: donor.messages[0].id, dataUrl: png }); await first;   // the renderer is free…
  let lateServed = false;
  const late = broker.request(world, "agent").then((r) => { lateServed = true; return r; });   // …and a new ask arrives at once
  await Bun.sleep(80);
  const snaps = donor.messages.filter((m) => m.type === "capture");
  expect(snaps.length).toBe(2);                     // the second dispatch went to the ask that was waiting
  broker.receive(donor.c, { id: snaps[1].id, dataUrl: png });
  expect(await waited).toMatchObject({ ok: true }); expect(lateServed).toBe(false);
  await Bun.sleep(80);
  broker.receive(donor.c, { id: donor.messages.filter((m) => m.type === "capture")[2].id, dataUrl: png });
  expect(await late).toMatchObject({ ok: true }); expect(waitedServed).toBe(true);
});
test("at most maxQueued asks wait; past that, busy at once (marked retryable)", async () => {
  const { broker, world, donor } = setup({ pollMs: 5, queueMs: 5000, timeoutMs: 2000, maxQueued: 1 });
  void broker.request(world, "agent"); await Bun.sleep(5);
  void broker.request(world, "agent"); await Bun.sleep(5);   // the one allowed to wait
  const t0 = Date.now(); const third = await broker.request(world, "agent");
  expect(third).toMatchObject({ ok: false, status: 429, retryAfter: 2 }); expect(Date.now() - t0).toBeLessThan(50);
  broker.retire(donor.c);
});
test("retryAfter marks only what asking again soon can fix", async () => {
  // the renderer's own "still loading" refusal, a timeout, a renderer gone mid-shot: retryable
  const { broker, worldOf, join } = roamSetup({ timeoutMs: 30 });
  const w = worldOf("w"); const r = join(w, "renderer", { renderer: true, spectator: true }); join(w, "agent");
  const refused = broker.request(w, "agent");
  broker.receive(r.c, { id: r.messages.find((m) => m.type === "capture").id, error: "the renderer is still loading this world — 1 model still loading (0 in); try again in a few seconds" });
  expect(await refused).toMatchObject({ status: 503, retryAfter: 2 });
  const notInScene = broker.request(w, "agent");
  broker.receive(r.c, { id: r.messages.filter((m) => m.type === "capture")[1].id, error: "agent not in local scene (still loading?)" });
  expect(await notInScene).toMatchObject({ status: 503, retryAfter: 2 });
  // a refusal that would fail the same way again (a capture that throws) is answered without Retry-After
  const broken = broker.request(w, "agent");
  broker.receive(r.c, { id: r.messages.filter((m) => m.type === "capture")[2].id, error: "TypeError: cannot read the canvas" });
  const brokenR = await broken; expect(brokenR).toMatchObject({ status: 503 }); expect((brokenR as any).retryAfter).toBeUndefined();
  expect(await broker.request(w, "agent")).toMatchObject({ status: 504, retryAfter: 2 });
  const gone = broker.request(w, "agent"); broker.retire(r.c);
  expect(await gone).toMatchObject({ status: 503, retryAfter: 2 });
  // no renderer and no roamer to send, members-only, an Unreal-only ask with none: not retryable
  const alone = worldOf("alone"); join(alone, "agent");
  const none = await broker.request(alone, "agent"); expect(none.ok).toBe(false); expect((none as any).retryAfter).toBeUndefined();
  const unreal = await broker.request(alone, "agent", "first", "unreal"); expect((unreal as any).retryAfter).toBeUndefined();
});
test("a caller's budget bounds the request: the renderer's wait is cut to it", async () => {
  const { broker, world, donor } = setup({ timeoutMs: 12_000, settleMarginMs: 2_000 });
  const r = broker.request(world, "agent", "first", "auto", {}, undefined, 6_000);
  // the budget less 0.5 s (answered inside it) less the 2 s margin for the capture and the send
  expect(donor.messages[0].wait).toBeLessThanOrEqual(3_500); expect(donor.messages[0].wait).toBeGreaterThan(3_000);
  broker.receive(donor.c, { id: donor.messages[0].id, dataUrl: png }); await r;
});
test("a roamer that never arrives is backed off itself, so the next sweep sends a healthy one", async () => {
  let time = 0; const lines: string[] = [];
  const { broker, worldOf, join, leave } = roamSetup({ now: () => time, sweepAfterMs: 0, travelMs: 400, pollMs: 10,
    sweepBackoffMs: 15_000, log: (l: string) => lines.push(l) });
  const lobby = worldOf("lobby"), lobby2 = worldOf("lobby2"), w = worldOf("w");
  const broken = join(lobby, "roam-broken", { renderer: true, roam: true, spectator: true });   // ranks first, never travels
  join(w, "agent", { tokenVerified: true });
  broker.sweep(); expect(broken.messages.length).toBe(1);
  time = 500; await Bun.sleep(40);                                  // its journey expires
  expect(lines.some((l) => /roamer "roam-broken" did not arrive in "w" within 0.4s — it is sent nowhere for 15s/.test(l))).toBe(true);
  const healthy = join(lobby2, "roam-healthy", { renderer: true, roam: true, spectator: true });
  time = 1_000; broker.sweep();
  expect(broken.messages.length).toBe(1);                           // the broken roamer is not sent again…
  expect(healthy.messages.at(-1)).toEqual({ type: "renderer-travel", world: "w" });   // …a healthy one goes instead
  // the healthy one arrives; later the world needs a roamer again and only the broken one is free, still backed off
  leave(healthy.c); const there = join(w, "roam-healthy", { renderer: true, roam: true, spectator: true });
  await Bun.sleep(30); leave(there.c);
  time = 10_000; broker.sweep(); expect(broken.messages.length).toBe(1);
  time = 16_000; broker.sweep(); expect(broken.messages.length).toBe(2);   // after its back-off, it may try again
  time = 16_500; await Bun.sleep(40);
  expect(lines.some((l) => /roam-broken.*sent nowhere for 30s/.test(l))).toBe(true);   // and failing again doubles it
});
test("…an asked screenshot still takes a backed-off roamer when it is the only one, and arriving clears its back-off", async () => {
  let time = 0;
  const { broker, worldOf, join } = roamSetup({ now: () => time, sweepAfterMs: 0, travelMs: 400, pollMs: 10, timeoutMs: 200 });
  const lobby = worldOf("lobby"), w = worldOf("w"), v = worldOf("v");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true }); join(w, "agent", { tokenVerified: true });
  // a roamer travels by re-joining on the same connection: the same client, moved to another world
  const travel = (to: World) => { roamer.c.world?.clients.delete(roamer.c); roamer.c.world = to; to.clients.add(roamer.c); };
  broker.sweep(); time = 500; await Bun.sleep(40);                  // a failed journey to w: backed off
  join(v, "agentV", { tokenVerified: true });
  broker.prewarm(v); expect(roamer.messages.length).toBe(1);        // pre-warm skips it
  const asked = broker.request(v, "agentV"); await Bun.sleep(20);   // an asked screenshot takes it: no other roamer can go
  expect(roamer.messages.at(-1)).toEqual({ type: "renderer-travel", world: "v" });
  travel(v); await Bun.sleep(40);                                    // it arrives (in v, which it was sent to)
  const snap = roamer.messages.find((m) => m.type === "capture"); broker.receive(roamer.c, { id: snap.id, dataUrl: png });
  expect(await asked).toMatchObject({ ok: true });
  // arriving cleared its back-off: back in its lobby, the next sweep sends it to w (still unserved) at once
  travel(lobby);
  time = 1_000; broker.sweep();                                      // past its last journey's window, well inside a 15 s back-off
  expect(roamer.messages.at(-1)).toEqual({ type: "renderer-travel", world: "w" });
  await Bun.sleep(450);
});
test("a renderer that goes while a request waits for it: 503 with Retry-After, not the permanent 'no roamer' answer", async () => {
  const { broker, world, donor } = setup({ pollMs: 5, queueMs: 3_000, timeoutMs: 3_000 });
  void broker.request(world, "agent"); await Bun.sleep(5);           // the renderer is busy
  const waiting = broker.request(world, "agent"); await Bun.sleep(10);
  world.clients.delete(donor.c); broker.retire(donor.c);            // and then gone
  expect(await waiting).toMatchObject({ ok: false, status: 503, retryAfter: 2 });
});
test("a pinned renderer leaving starts its grace at once, before any sweep has seen it", async () => {
  let time = 0;
  const { broker, worldOf, join, leave } = roamSetup({ now: () => time, sweepAfterMs: 0, pinnedGraceMs: 120_000 });
  const lobby = worldOf("lobby"), commons = worldOf("commons");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  const pinned = join(commons, "renderer-mac-gpu-commons", { renderer: true, spectator: true, trustedRenderer: true }); join(commons, "agentC", { tokenVerified: true });
  time = 1_000; broker.retire(pinned.c); leave(pinned.c);   // it restarts; no sweep ran while it was there
  time = 20_000; broker.sweep();
  expect(roamer.messages.length).toBe(0);
});
// ---- second review of #279 ----
test("a journey longer than the caller's budget: answered early, retryable, and no snap is sent to the arriving roamer", async () => {
  const { broker, worldOf, join } = roamSetup({ travelMs: 10_000, timeoutMs: 200, pollMs: 10 });
  const lobby = worldOf("lobby"), w = worldOf("far");
  const roamer = join(lobby, "roam", { renderer: true, roam: true, spectator: true }); join(w, "agent");
  const t0 = Date.now(); const r = await broker.request(w, "agent", "first", "auto", {}, undefined, 1_000);
  expect(r).toMatchObject({ ok: false, status: 503, retryAfter: 2, err: expect.stringMatching(/a roaming renderer is on its way/) });
  expect(Date.now() - t0).toBeLessThan(1_200);                       // the 1 s budget, less a frame's minimum
  expect(roamer.messages.filter((m) => m.type === "renderer-travel")).toEqual([{ type: "renderer-travel", world: "far" }]);   // it keeps coming
  expect(roamer.messages.some((m) => m.type === "capture")).toBe(false);
});
test("a capture-donating player leaving is not a pinned renderer restarting, and a roamer beside one is still needed", async () => {
  let time = 0;
  const { broker, worldOf, join, leave } = roamSetup({ now: () => time, sweepAfterMs: 0 });
  const lobby = worldOf("lobby"), w = worldOf("w"), other = worldOf("other");
  const parked = join(lobby, "roam", { renderer: true, roam: true, spectator: true });
  const donor = join(w, "player", { capture: { version: 1, engine: "unreal", scene: "world-projection" } });
  join(w, "agentW", { tokenVerified: true });
  time = 1_000; broker.retire(donor.c); leave(donor.c);               // the donating player leaves
  broker.sweep();
  expect(parked.messages.at(-1)).toEqual({ type: "renderer-travel", world: "w" });   // served at once: no grace
  // a roamer beside a capture donor (not a pinned renderer) is not parked: another world's sweep leaves it alone
  const w2 = worldOf("w2"), beside = join(w2, "roam2", { renderer: true, roam: true, spectator: true });
  join(w2, "player2", { capture: { version: 1, engine: "unreal", scene: "world-projection" } }); join(w2, "agentW2", { tokenVerified: true });
  join(other, "agentO", { tokenVerified: true });
  time = 2_000; broker.sweep();
  expect(beside.messages.some((m) => m.type === "renderer-travel")).toBe(false);
  await Bun.sleep(450);
});
test("first come, first served holds across 'auto' and 'browser' asks for one browser renderer", async () => {
  // only a browser renderer here, so both kinds of ask compete for it; the newer ('auto') ask looks first once it is free
  const polls = manualPolls();
  const { broker, worldOf, join } = roamSetup({ queueMs: 5000, timeoutMs: 3000, travelMs: 10_000, pollSleep: polls.pollSleep });
  const w = worldOf("w"); const legacy = join(w, "legacy", { renderer: true, spectator: true }); join(w, "agent");
  const snaps = () => legacy.messages.filter((m) => m.type === "capture");
  const holding = broker.request(w, "agent", "first", "browser");
  const order: string[] = [];
  const older = broker.request(w, "agent", "first", "browser").then((r) => { order.push("browser"); return r; });
  await polls.settle();
  const newer = broker.request(w, "agent", "first", "auto").then((r) => { order.push("auto"); return r; });
  await polls.settle();
  expect(polls.waiting()).toBe(2);
  broker.receive(legacy.c, { id: snaps()[0].id, dataUrl: png }); await holding;
  await polls.look(1);                                                // the 'auto' ask looks first…
  expect(snaps().length).toBe(1);                                     // …and leaves it to the older 'browser' ask
  await polls.look(0);
  expect(snaps().length).toBe(2);
  broker.receive(legacy.c, { id: snaps()[1].id, dataUrl: png });
  expect((await older).ok).toBe(true); expect(order).toEqual(["browser"]);
  await polls.look(0);
  broker.receive(legacy.c, { id: snaps()[2].id, dataUrl: png });
  expect((await newer).ok).toBe(true); expect(order).toEqual(["browser", "auto"]);
});
test("an Unreal-only waiter does not hold back a browser ask for a renderer it could not use", async () => {
  const { broker, world, donor, make } = setup({ pollMs: 5, queueMs: 3000, timeoutMs: 3000 });
  const legacy = make("legacy", { renderer: true, spectator: true });
  void broker.request(world, "agent", "first", "unreal"); await Bun.sleep(5);   // the donor is now busy
  const unrealWaiter = broker.request(world, "agent", "first", "unreal"); await Bun.sleep(5);   // waits for the donor
  const browser = broker.request(world, "agent", "first", "browser");
  await Bun.sleep(30);
  const snap = legacy.messages.find((m) => m.type === "capture"); expect(snap).toBeDefined();   // served by the free browser renderer
  broker.receive(legacy.c, { id: snap.id, dataUrl: png });
  expect(await browser).toMatchObject({ ok: true });
  broker.retire(donor.c); await unrealWaiter;
});
// ---- third review of #279 ----
test("a roamer that arrived moments ago (swept, pre-warmed) gets the arrival window to load the world; a pinned renderer does not", async () => {
  let time = 100_000;
  const { broker, worldOf, join } = roamSetup({ now: () => time, timeoutMs: 12_000, arrivalTimeoutMs: 40_000, travelMs: 25_000, settleMarginMs: 2_000 });
  const w = worldOf("w"); join(w, "agent");
  const swept = join(w, "roam", { renderer: true, roam: true, spectator: true });
  broker.noteJoin(swept.c);                                 // the server notes every join
  time += 3_000;                                            // the agent asks 3 s after the sweep's roamer arrived
  const r = broker.request(w, "agent");
  expect(swept.messages.find((m) => m.type === "capture").wait).toBe(38_000);   // the arrival window, not the 12 s frame window
  broker.receive(swept.c, { id: swept.messages.find((m) => m.type === "capture").id, dataUrl: png }); await r;
  time += 60_000;                                           // long settled: the frame window again
  const r2 = broker.request(w, "agent");
  expect(swept.messages.filter((m) => m.type === "capture")[1].wait).toBe(10_000);
  broker.receive(swept.c, { id: swept.messages.filter((m) => m.type === "capture")[1].id, dataUrl: png }); await r2;
  // a PINNED renderer that just joined keeps the operator's frame window (SNAP_TIMEOUT_SEC governs it)
  const p = worldOf("p"); join(p, "agentP");
  const pinned = join(p, "renderer-mac-gpu-p", { renderer: true, spectator: true }); broker.noteJoin(pinned.c);
  time += 1_000;
  const r3 = broker.request(p, "agentP");
  expect(pinned.messages.find((m) => m.type === "capture").wait).toBe(10_000);
  broker.receive(pinned.c, { id: pinned.messages.find((m) => m.type === "capture").id, dataUrl: png }); await r3;
});
test("the queue cap is per world: waiters in one world do not turn another world's ask into 'busy'", async () => {
  const { broker, worldOf, join } = roamSetup({ pollMs: 5, queueMs: 3_000, timeoutMs: 3_000, travelMs: 10_000, maxQueued: 1, maxQueuedTotal: 64 });
  const a = worldOf("a"), b = worldOf("b");
  const ra = join(a, "ra", { renderer: true, spectator: true }), rb = join(b, "rb", { renderer: true, spectator: true });
  join(a, "agentA"); join(b, "agentB");
  void broker.request(a, "agentA"); await Bun.sleep(5);                  // a's renderer busy
  void broker.request(a, "agentA"); await Bun.sleep(5);                  // a's one allowed waiter
  const t0 = Date.now(); expect(await broker.request(a, "agentA")).toMatchObject({ status: 429 }); expect(Date.now() - t0).toBeLessThan(50);
  void broker.request(b, "agentB"); await Bun.sleep(5);                  // b's renderer busy
  const waitsInB = broker.request(b, "agentB"); await Bun.sleep(30);     // b still has room to wait
  let settled = false; void waitsInB.then(() => { settled = true; });
  await Bun.sleep(20); expect(settled).toBe(false);
  broker.retire(ra.c); broker.retire(rb.c);
});
test("…and a global ceiling still bounds all waiters", async () => {
  const { broker, worldOf, join } = roamSetup({ pollMs: 5, queueMs: 3_000, timeoutMs: 3_000, travelMs: 10_000, maxQueued: 16, maxQueuedTotal: 1 });
  const a = worldOf("a"), b = worldOf("b");
  const ra = join(a, "ra", { renderer: true, spectator: true }), rb = join(b, "rb", { renderer: true, spectator: true });
  join(a, "agentA"); join(b, "agentB");
  void broker.request(a, "agentA"); void broker.request(b, "agentB"); await Bun.sleep(5);   // both renderers busy
  void broker.request(a, "agentA"); await Bun.sleep(5);                                    // the one waiter allowed in all
  expect(await broker.request(b, "agentB")).toMatchObject({ status: 429 });
  broker.retire(ra.c); broker.retire(rb.c);
});
// ---- fifth review of #279 ----
test("an asker that went away leaves the queue: it is never dispatched, and does not hold back the next ask", async () => {
  const polls = manualPolls();
  const { broker, world, donor } = setup({ queueMs: 5000, timeoutMs: 3000, pollSleep: polls.pollSleep });
  const snaps = () => donor.messages.filter((m) => m.type === "capture");
  const holding = broker.request(world, "agent");
  const asker = new AbortController();
  const abandoned = broker.request(world, "agent", "first", "auto", {}, undefined, undefined, asker.signal);
  await polls.settle();
  const live = broker.request(world, "agent");
  await polls.settle();
  asker.abort();                                                      // the first waiter's HTTP request is gone
  broker.receive(donor.c, { id: snaps()[0].id, dataUrl: png }); await holding;
  await polls.look(0);                                                // the abandoned one looks: it leaves
  expect(await abandoned).toMatchObject({ ok: false, status: 499 });
  await polls.look(0);                                                // the live one looks: it is served
  expect(snaps().length).toBe(2);
  broker.receive(donor.c, { id: snaps()[1].id, dataUrl: png });
  expect((await live).ok).toBe(true);
});
test("a client that only CLAIMS to be a renderer is not taken for the world's pinned one", async () => {
  let time = 0;
  const { broker, worldOf, join, leave } = roamSetup({ now: () => time, sweepAfterMs: 0 });
  const lobby = worldOf("lobby"), w = worldOf("w"), other = worldOf("other");
  join(w, "agentW", { tokenVerified: true });
  const serving = join(w, "roam-serving", { renderer: true, roam: true, spectator: true });   // the roamer serving w
  const claimer = join(w, "says-renderer", { renderer: true, spectator: true });             // no credential, no frame yet
  join(other, "agentO", { tokenVerified: true });
  const spares = [join(lobby, "spare", { renderer: true, roam: true, spectator: true })];
  const sentTo = (world: string) => spares.reduce((n, r) => n + r.messages.filter((m) => m.type === "renderer-travel" && m.world === world).length, 0);
  broker.sweep();
  expect(serving.messages.some((m) => m.type === "renderer-travel")).toBe(false);   // not counted as "parked" beside it
  // and its leaving does not start a pinned renderer's grace: w is swept at once
  time = 1_000; broker.retire(claimer.c); leave(claimer.c); leave(serving.c);
  time = 2_000; spares.push(join(lobby, "spare2", { renderer: true, roam: true, spectator: true })); broker.sweep();
  expect(sentTo("w")).toBe(1);
  // a renderer that delivered a frame, though, is believed: it counts as pinned, and its restart's grace holds
  const proved = join(other, "renderer-other", { renderer: true, spectator: true });
  const ask = broker.request(other, "agentO"); await Bun.sleep(10);
  broker.receive(proved.c, { id: proved.messages.find((m) => m.type === "capture").id, dataUrl: png }); await ask;
  time = 3_000; broker.retire(proved.c); leave(proved.c);
  const toOther = sentTo("other");
  time = 4_000; spares.push(join(lobby, "spare3", { renderer: true, roam: true, spectator: true })); broker.sweep();
  expect(sentTo("other")).toBe(toOther);                              // no roamer sent to load "other" in its grace
  await Bun.sleep(450);
});
