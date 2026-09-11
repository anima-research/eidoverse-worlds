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
