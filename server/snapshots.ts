// Ephemeral screenshot broker. No fold, disk, credentials, or camera control.
import { randomUUID } from "node:crypto";
import type { Client, World } from "./world.ts";
import { wildcardRoleIn } from "../shared/rightsfold.js";
import { LIMITS } from "./limits.ts";

export type CaptureCapability = { version: 1; engine: "unreal"; scene: "underwater-prototype" | "world-projection" };
export function captureCapability(value: unknown): CaptureCapability | undefined {
  const v = value as Partial<CaptureCapability> | null;
  return v?.version === 1 && v.engine === "unreal" && (v.scene === "underwater-prototype" || v.scene === "world-projection")
    ? { version: 1, engine: "unreal", scene: v.scene } : undefined;
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

// ROAMING RENDERERS: a renderer that joined with `roam` serves no world in particular. When a snapshot is asked of
// a world no renderer is serving (an agent building alone in its own world — the common case), the broker sends an
// idle roamer there (`renderer-travel`), waits for it to arrive, and dispatches the snapshot to it. It stays until
// another world needs it, so an agent iterating on a build gets fast follow-up shots. `allClients` lists every
// connected client (the server passes its registry; tests pass their own).
export function createSnapshotBroker({ timeoutMs = 12_000, cooldownMs = 2000, maxPending = 16, now = Date.now,
  travelMs = 25_000, arrivalTimeoutMs = 40_000, pollMs = 200, recentMs = 5 * 60_000,
  allClients = (() => []) as () => Iterable<Client>,
  admits = (() => true) as (world: World, c: Client) => boolean,
  log = (line: string) => console.log(line), dropLogMs = 10_000 } = {}) {
  const pending = new Map<string, Pending>();
  // A failed snapshot used to leave no server-side trace: a frame arriving after the timeout, or from a client that
  // was not the renderer asked, looked the same as no reply at all. Every failure after dispatch (the timeout, a failed
  // send, a participant leaving, the renderer's refusal, an invalid image) logs one [snap] line, and so does a reply
  // the broker drops, within the bound below.
  // Ids and error text are client text: bound and escape them, or a peer could print its own "log lines".
  const quote = (v: unknown, n: number = LIMITS.ID_LEN) => typeof v === "string" ? JSON.stringify(v.slice(0, n)) : "(invalid id)";
  const who = (c: Client) => quote(c.id);
  // A reply receive() drops costs its sender nothing, and any joined client can send one: the renderer and capture
  // flags are the client's own claims (join's `renderer`, capture-capabilities), so every drop below is reachable
  // from any connection. Each connection logs a drop at most once per dropLogMs: a drop inside that window is only
  // counted, into the connection's next line, which a connection that goes quiet never writes. So no connection can
  // write the log at its message rate, and a real renderer's late frame logs whenever its connection has logged no drop
  // in the last dropLogMs.
  const dropLogged = new WeakMap<Client, { at: number; unlogged: number }>();
  function logDrop(c: Client, line: string) {
    const t = now(), d = dropLogged.get(c);
    if (d && t - d.at < dropLogMs) { d.unlogged++; return; }
    log(d?.unlogged ? `${line} (and ${d.unlogged} more from this connection dropped unlogged since its last line)` : line);
    dropLogged.set(c, { at: t, unlogged: 0 });
  }
  const last = new WeakMap<Client, number>();
  const travelling = new Map<string, { at: number; arrived: Promise<boolean> }>();   // world name → a summons in flight
  const asked = new Map<string, number>();   // world name → when a snapshot was last asked there (roamer rotation)
  const active = (c: Client, w: World) => c.world === w && w.clients.has(c) && !c.superseded
    && (c.ws.readyState == null || c.ws.readyState === 1);
  function retire(c: Client) {
    for (const [id, p] of pending) if (p.renderer === c || p.target === c) {
      log(`[snap] ${id}: ${p.renderer === c ? "renderer" : "followed body"} ${who(c)} disconnected or changed session — 503`);
      p.finish({ ok: false, err: "screenshot participant disconnected or changed session", status: 503 });
    }
  }
  function configure(c: Client, value: unknown) {
    retire(c);
    c.capture = (c.surface ?? "world") === "world" ? captureCapability(value) : undefined;
  }
  function request(world: World, follow: string, view = "first", engine = "auto",
    frame: { dist?: number; height?: number; pitch?: number } = {}): Promise<Result> {
    const fail = (err: string, status: number) => Promise.resolve<Result>({ ok: false, err, status });
    if (!["auto", "unreal", "browser"].includes(engine)) return fail("renderer must be auto, unreal, or browser", 400);
    const target = [...world.clients].find(c => c.id === follow && !c.spectator && active(c, world));
    if (!target) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    asked.set(world.name, now());
    const candidates = [...world.clients].filter(c => active(c, world) && (c.renderer || c.capture)
      && (engine === "auto" || (c.capture?.engine ?? "browser") === engine))
      .sort((a, b) => Number(!!b.capture) - Number(!!a.capture));
    if (!candidates.length) {
      // a roamer can only be a browser renderer: an Unreal-only request is not summoned
      if (engine === "unreal") return fail(`no unreal renderer is currently serving world "${world.name}"`, 503);
      return summon(world, false).then((arrived) => arrived
        ? dispatch(world, follow, view, engine, frame, target, Math.max(arrivalTimeoutMs, timeoutMs))
        : { ok: false as const, err: wildcardRoleIn(world.state as any) === "none"
            ? `"${world.name}" is members-only and no roaming renderer holding the renderers' credential is free, so no snapshot can be taken there now`
            : `no renderer is currently serving world "${world.name}", and no roaming renderer could come`, status: 503 });
    }
    return dispatch(world, follow, view, engine, frame, target, timeoutMs);
  }
  const candidatesIn = (world: World, engine: string) => [...world.clients].filter(c => active(c, world) && (c.renderer || c.capture)
    && (engine === "auto" || (c.capture?.engine ?? "browser") === engine))
    .sort((a, b) => Number(!!b.capture) - Number(!!a.capture));
  /** How much a roamer's current world still needs it: 0 — no agent there (parked, free); 1 — agents there, but none
   *  has asked for a snapshot recently; 2 — in use. Rotation takes the least needed, then the longest idle. */
  const need = (c: Client) => {
    const w = c.world!;
    if (![...w.clients].some(o => o.agent && !o.spectator && active(o, w))) return 0;
    return now() - (asked.get(w.name) ?? -Infinity) >= recentMs ? 1 : 2;
  };
  /** Send a roaming renderer to `world` and wait for it to join there. One summons per world at a time; a roamer busy
   *  with a snapshot, or on its way somewhere, is not taken. A roamer a world is actively using is taken only for a
   *  snapshot actually asked (never for a pre-warm), and only when no freer one exists. */
  function summon(world: World, prewarming: boolean): Promise<boolean> {
    const inFlight = travelling.get(world.name);
    if (inFlight && now() - inFlight.at < travelMs) return inFlight.arrived;
    const busy = new Set([...pending.values()].map(p => p.renderer));
    const enRoute = new Set([...travelling.keys()]);
    // …and only one the destination will let in. A roamer holding the
    // renderers' credential (RENDERER_TOKEN) goes anywhere — it is the vision
    // of the agents there; one without it is just a client that said
    // "renderer", and a closed world refuses it (server/access.ts). Never send
    // a roamer to be refused: a refused renderer stops rather than retrying,
    // and would sit dead until its watchdog restarted it.
    const roamers = [...allClients()].filter(c => c.roam && c.renderer && c.world && active(c, c.world)
      && c.world !== world && !busy.has(c) && !enRoute.has(c.world.name) && admits(world, c))
      .map(c => ({ c, n: need(c) })).filter(r => !(prewarming && r.n === 2))
      .sort((a, b) => a.n - b.n || (last.get(a.c) ?? 0) - (last.get(b.c) ?? 0))
      .map(r => r.c);
    const roamer = roamers[0];
    if (!roamer) return Promise.resolve(false);
    try { roamer.ws.send(JSON.stringify({ type: "renderer-travel", world: world.name })); }
    catch { return Promise.resolve(false); }
    const at = now();
    const arrived = new Promise<boolean>((resolve) => {
      const tick = () => {
        if (candidatesIn(world, "auto").length) { travelling.delete(world.name); return resolve(true); }
        if (now() - at >= travelMs) { travelling.delete(world.name); return resolve(false); }
        setTimeout(tick, pollMs);
      };
      setTimeout(tick, pollMs);
    });
    travelling.set(world.name, { at, arrived });
    return arrived;
  }
  function dispatch(world: World, follow: string, view: string, engine: string,
    frame: { dist?: number; height?: number; pitch?: number }, target: Client, waitMs: number): Promise<Result> {
    const fail = (err: string, status: number) => Promise.resolve<Result>({ ok: false, err, status });
    if (!active(target, world)) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    const candidates = candidatesIn(world, engine);
    if (!candidates.length) return fail(`no ${engine === "auto" ? "" : engine + " "}renderer is currently serving world "${world.name}"`, 503);
    const renderer = candidates.find(c => now() - (last.get(c) ?? -Infinity) >= cooldownMs
      && ![...pending.values()].some(p => p.renderer === c) && (c.ws.getBufferedAmount?.() ?? 0) < 256_000);
    if (!renderer || pending.size >= maxPending) return fail("renderers busy; retry in a few seconds", 429);
    if (!["first", "third", "selfie"].includes(view)) view = "first";
    const id = `snap-${randomUUID()}`;
    last.set(renderer, now());
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        // say which snap, whose renderer, and how backed-up its socket was
        log(`[snap] ${id} follow=${quote(follow)} view=${view}: no frame from ${who(renderer)} in ${waitMs / 1000}s ` +
          `(renderer ws buffered=${renderer.ws.getBufferedAmount?.() ?? "?"}) — 504`);
        p.finish({ ok: false, err: "renderer timed out", status: 504 });
      }, waitMs);
      const p: Pending = { renderer, target, world, gen: renderer.gen,
        engine: renderer.capture?.engine ?? "browser", scene: renderer.capture?.scene ?? "world-fold",
        finish(r) { if (!pending.delete(id)) return; clearTimeout(timer); resolve(r); } };
      pending.set(id, p);
      // framing (shared/snapframe.js) rides nested, apart from the image size,
      // and only when a field is given
      try { renderer.ws.send(JSON.stringify({ type: "snap", id, follow, view, width: 960, height: 540,
        ...(Object.keys(frame).length ? { frame } : {}) })); }
      catch { log(`[snap] ${id}: send to renderer ${who(renderer)} failed — 503`); p.finish({ ok: false, err: "renderer unavailable", status: 503 }); }
    });
  }
  function receive(c: Client, msg: { id?: unknown; dataUrl?: unknown; error?: unknown }) {
    // Every drop goes through logDrop (above). The 503 and 502 lines below need the pending snap's own renderer, so
    // there is at most one of them per dispatched snap.
    if (!(c.renderer || c.capture)) return logDrop(c, `[snap] ${quote(msg.id)}: reply from ${who(c)}, which is not a renderer — dropped`);
    const p = typeof msg.id === "string" ? pending.get(msg.id) : undefined;
    if (!p) return logDrop(c, `[snap] ${quote(msg.id)}: reply from ${who(c)} for an expired or unknown snap — dropped`);
    const stale = p.renderer !== c ? `it was sent to ${who(p.renderer)}` : p.gen !== c.gen ? "its session changed"
      : !active(c, p.world) ? `it is no longer in "${p.world.name}"` : !active(p.target, p.world) ? "the followed body left" : "";
    if (stale) return logDrop(c, `[snap] ${quote(msg.id)}: reply from ${who(c)} dropped — ${stale}`);
    // a renderer's own refusal (still loading the world, the body not in its scene) reaches the asker in its words,
    // as a retryable 503 — never a generic "invalid image"
    if (typeof msg.error === "string" && msg.error.trim()) {
      const err = msg.error.trim().slice(0, 300);
      log(`[snap] ${msg.id}: renderer ${who(c)} replied without an image: ${quote(err, 200)} — 503`);
      return p.finish({ ok: false, err, status: 503 });
    }
    const png = pngFromDataURL(msg.dataUrl);
    if (!png) log(`[snap] ${msg.id}: renderer ${who(c)} sent no valid PNG (${typeof msg.dataUrl === "string" ? `${msg.dataUrl.length} chars` : typeof msg.dataUrl}) — 502`);
    p.finish(png ? { ok: true, png, engine: p.engine, scene: p.scene }
      : { ok: false, err: "renderer could not supply a valid image", status: 502 });
  }
  /** PRE-WARM: a body that can ask for snapshots (an agent) arrived in `world`. If no renderer serves it, send a roamer
   *  now, so the world is loaded by the time the first snapshot is asked. Fire-and-forget; idempotent per world. */
  function prewarm(world: World) {
    if (!candidatesIn(world, "auto").length) void summon(world, true);
  }
  /** The server's client registry, for finding roaming renderers in other worlds. */
  function setClients(fn: () => Iterable<Client>) { allClients = fn; }
  /** Would `world` let this renderer in? Injected by the server (access.ts canEnter), so this broker never loads
   *  server state itself — its unit test stays independent of a machine's ban list and directories. Until wired,
   *  every world admits (the broker's behaviour before world access existed). */
  function setAdmission(fn: (world: World, c: Client) => boolean) { admits = fn; }
  /** The frame window (config.ts SNAP_TIMEOUT_SEC), injected by the server like the admission check, so this module
   *  never loads server config itself. */
  function setFrameTimeout(ms: number) { timeoutMs = ms; }
  return { request, receive, retire, configure, setClients, setAdmission, setFrameTimeout, prewarm,
    get pendingCount() { return pending.size; },
    /** The longest a request can wait: a roamer's journey, then its first frame. GET /snap sizes its own HTTP
     *  timeout from this. */
    get maxWaitMs() { return travelMs + Math.max(arrivalTimeoutMs, timeoutMs); } };
}
export const snapshots = createSnapshotBroker();
