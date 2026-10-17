import { test, expect } from "bun:test";
import { createSnapshotBroker, captureCapability, pngFromDataURL } from "../server/snapshots.ts";
import type { World, Client } from "../server/world.ts";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const cap = { version: 1, engine: "unreal", scene: "underwater-prototype" };
function setup(options = {}) {
  const broker = createSnapshotBroker({ cooldownMs: 0, timeoutMs: 100, ...options });
  const world = { name: "test", clients: new Set<Client>() } as World;
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
  const request = donor.messages[0]; expect(request).toMatchObject({ type: "snap", follow: "agent", view: "selfie", width: 960, height: 540 });
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
  const { broker, world, donor } = setup();
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
  const { broker, world, donor } = setup({ cooldownMs: 2000, timeoutMs: 5, now: () => time });
  expect(await broker.request(world, "agent")).toMatchObject({ status: 504 }); expect(broker.pendingCount).toBe(0);
  expect(await broker.request(world, "agent")).toMatchObject({ status: 429 }); time = 2000;
  const result = broker.request(world, "agent"); broker.retire(donor.c); expect(await result).toMatchObject({ status: 503 });
  const blocked = setup({ maxPending: 0 }); expect(await blocked.broker.request(blocked.world, "agent")).toMatchObject({ status: 429 });
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
  const broker = createSnapshotBroker({ cooldownMs: 0, timeoutMs: 200, arrivalTimeoutMs: 400, travelMs: 400, pollMs: 10, allClients: () => all, ...opts });
  const worldOf = (name: string) => ({ name, clients: new Set<Client>() } as World);
  const join = (world: World, id: string, extra = {}) => {
    const messages: any[] = [];
    const c = { id, world, spectator: false, gen: 1, surface: "world", ws: { readyState: 1, send: (s: string) => messages.push(JSON.parse(s)) }, ...extra } as Client;
    world.clients.add(c); all.add(c); return { c, messages };
  };
  const leave = (c: Client) => { c.world?.clients.delete(c); all.delete(c); c.world = null; };
  return { broker, worldOf, join, leave, all };
}
test("an agent alone in a world gets a roaming renderer sent there, and its snapshot", async () => {
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
  const snap = arrived.messages.find((m) => m.type === "snap"); expect(snap).toMatchObject({ follow: "agent", view: "third" });
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
  broker.receive(roamer.c, { id: roamer.messages.find((m) => m.type === "snap").id, dataUrl: png }); await busy;
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
  const snap = r.messages.find((m) => m.type === "snap");
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
  // a roamer an agent is actively using (it asked a snapshot just now) — and one parked where nobody is
  const inUse = join(busyWorld, "roam-a", { renderer: true, roam: true, spectator: true });
  join(busyWorld, "agentBusy", { agent: true });
  const shot = broker.request(busyWorld, "agentBusy");
  broker.receive(inUse.c, { id: inUse.messages.find((m) => m.type === "snap").id, dataUrl: png }); await shot;
  const free = join(parked, "roam-b", { renderer: true, roam: true, spectator: true });
  // a new agent elsewhere: the PARKED roamer is sent, not the one in use
  join(fresh, "agentFresh", { agent: true }); broker.prewarm(fresh);
  expect(free.messages.at(-1)).toEqual({ type: "renderer-travel", world: "fresh" });
  expect(inUse.messages.some((m) => m.type === "renderer-travel")).toBe(false);
  // with only the in-use roamer left: a pre-warm does NOT take it…
  leave(free.c); join(fresh2, "agentFresh2", { agent: true }); broker.prewarm(fresh2);
  expect(inUse.messages.some((m) => m.type === "renderer-travel")).toBe(false);
  // …but a snapshot actually asked does (never refused while a roamer exists)
  await Bun.sleep(450);   // the unanswered pre-warm summons for fresh expires
  void broker.request(fresh2, "agentFresh2"); await Bun.sleep(30);
  expect(inUse.messages.at(-1)).toEqual({ type: "renderer-travel", world: "fresh2" });
  await Bun.sleep(450);
});
