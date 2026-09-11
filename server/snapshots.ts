// Ephemeral screenshot broker. No fold, disk, credentials, or camera control.
import { randomUUID } from "node:crypto";
import type { Client, World } from "./world.ts";

export type CaptureCapability = { version: 1; engine: "unreal"; scene: "underwater-prototype" };
export function captureCapability(value: unknown): CaptureCapability | undefined {
  const v = value as Partial<CaptureCapability> | null;
  return v?.version === 1 && v.engine === "unreal" && v.scene === "underwater-prototype"
    ? { version: 1, engine: "unreal", scene: "underwater-prototype" } : undefined;
}
type Result = { ok: true; png: Uint8Array; engine: string; scene: string }
  | { ok: false; err: string; status: number };
type Pending = { renderer: Client; target: Client; world: World; gen?: number;
  finish: (r: Result) => void; engine: string; scene: string };
const PREFIX = "data:image/png;base64,";
const MAX_PNG = 4 * 1024 * 1024;

// Validate the bounded container before returning untrusted client bytes as PNG.
// This is not a decoder or a proof that a renderer depicted the right scene.
export function pngFromDataURL(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > PREFIX.length + Math.ceil(MAX_PNG / 3) * 4) return null;
  const b64 = value.slice(PREFIX.length);
  if (!b64.length || b64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const png = Buffer.from(b64, "base64");
  if (png.length > MAX_PNG || png.length < 45 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
  let at = 8, data = false;
  while (at + 12 <= png.length) {
    const len = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8);
    if (len > png.length - at - 12) return null;
    if (at === 8) {
      if (type !== "IHDR" || len !== 13) return null;
      const w = png.readUInt32BE(at + 8), h = png.readUInt32BE(at + 12);
      if (!w || !h || w > 4096 || h > 4096 || w * h > 8_388_608) return null;
    } else if (type === "IHDR") return null;
    if (type === "IDAT") data = true;
    at += len + 12;
    if (type === "IEND") return len === 0 && data && at === png.length ? png : null;
  }
  return null;
}

export function createSnapshotBroker({ timeoutMs = 12_000, cooldownMs = 2000, maxPending = 16, now = Date.now } = {}) {
  const pending = new Map<string, Pending>();
  const last = new WeakMap<Client, number>();
  const active = (c: Client, w: World) => c.world === w && w.clients.has(c) && !c.superseded
    && (c.ws.readyState == null || c.ws.readyState === 1);
  function retire(c: Client) {
    for (const p of pending.values()) if (p.renderer === c || p.target === c)
      p.finish({ ok: false, err: "screenshot participant disconnected or changed session", status: 503 });
  }
  function configure(c: Client, value: unknown) {
    retire(c);
    c.capture = (c.surface ?? "world") === "world" ? captureCapability(value) : undefined;
  }
  function request(world: World, follow: string, view = "first", engine = "auto"): Promise<Result> {
    const fail = (err: string, status: number) => Promise.resolve<Result>({ ok: false, err, status });
    if (!["auto", "unreal", "browser"].includes(engine)) return fail("renderer must be auto, unreal, or browser", 400);
    const target = [...world.clients].find(c => c.id === follow && !c.spectator && active(c, world));
    if (!target) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    const candidates = [...world.clients].filter(c => active(c, world) && (c.renderer || c.capture)
      && (engine === "auto" || (c.capture?.engine ?? "browser") === engine))
      .sort((a, b) => Number(!!b.capture) - Number(!!a.capture));
    if (!candidates.length) return fail(`no ${engine === "auto" ? "" : engine + " "}renderer is currently serving world "${world.name}"`, 503);
    const renderer = candidates.find(c => now() - (last.get(c) ?? -Infinity) >= cooldownMs
      && ![...pending.values()].some(p => p.renderer === c) && (c.ws.getBufferedAmount?.() ?? 0) < 256_000);
    if (!renderer || pending.size >= maxPending) return fail("renderers busy; retry in a few seconds", 429);
    if (!["first", "third", "selfie"].includes(view)) view = "first";
    const id = `snap-${randomUUID()}`;
    last.set(renderer, now());
    return new Promise(resolve => {
      const timer = setTimeout(() => p.finish({ ok: false, err: "renderer timed out", status: 504 }), timeoutMs);
      const p: Pending = { renderer, target, world, gen: renderer.gen,
        engine: renderer.capture?.engine ?? "browser", scene: renderer.capture?.scene ?? "world-fold",
        finish(r) { if (!pending.delete(id)) return; clearTimeout(timer); resolve(r); } };
      pending.set(id, p);
      try { renderer.ws.send(JSON.stringify({ type: "snap", id, follow, view, width: 960, height: 540 })); }
      catch { p.finish({ ok: false, err: "renderer unavailable", status: 503 }); }
    });
  }
  function receive(c: Client, msg: { id?: unknown; dataUrl?: unknown; error?: unknown }) {
    if (typeof msg.id !== "string") return;
    const p = pending.get(msg.id);
    if (!p || p.renderer !== c || p.gen !== c.gen || !active(c, p.world) || !active(p.target, p.world) || !(c.renderer || c.capture)) return;
    const png = pngFromDataURL(msg.dataUrl);
    p.finish(png ? { ok: true, png, engine: p.engine, scene: p.scene }
      : { ok: false, err: "renderer could not supply a valid image", status: 502 });
  }
  return { request, receive, retire, configure, get pendingCount() { return pending.size; } };
}
export const snapshots = createSnapshotBroker();
