// Ephemeral screenshot broker. No fold, disk, credentials, or camera control.
import { randomUUID } from "node:crypto";
import type { Client, World } from "./world.ts";
import { doorOf } from "./access.ts";
import { LIMITS } from "./limits.ts";

export type CaptureCapability = { version: 1; engine: "unreal"; scene: "underwater-prototype" | "world-projection" };
export function captureCapability(value: unknown): CaptureCapability | undefined {
  const v = value as Partial<CaptureCapability> | null;
  return v?.version === 1 && v.engine === "unreal" && (v.scene === "underwater-prototype" || v.scene === "world-projection")
    ? { version: 1, engine: "unreal", scene: v.scene } : undefined;
}
// `retryAfter` (seconds) marks a failure that asking again soon can fix: the renderer still loading, busy, slow,
// or gone mid-shot. GET /snap sends it as Retry-After, and the MCPL snapshot tool asks again only when it is there,
// so a refusal that will not change in seconds (no renderer and no roamer to send, members-only) is answered at once.
type Result = { ok: true; png: Uint8Array; engine: string; scene: string }
  | { ok: false; err: string; status: number; retryAfter?: number };
type Pending = { renderer: Client; target: Client; world: World; gen?: number;
  finish: (r: Result) => void; engine: string; scene: string };
const PREFIX = "data:image/png;base64,";
// the PNG travels base64 inside one websocket message, and the socket closes past LIMITS.WS_MESSAGE_BYTES: the largest PNG
// is what fits in it with room for the envelope (review of #260, server I50: 4 MiB here was 5.6 MB on the wire)
const MAX_PNG = Math.floor((LIMITS.WS_MESSAGE_BYTES - 64 * 1024) / 4) * 3;

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
//
// A FIRST SNAPSHOT SHOULD COME BACK WITH A PICTURE (owner, 2026-10-24: "failing on first try is bad"). Three things
// below serve that. Every request has ONE deadline (`budgetMs`, under a Connectome host's 60 s per-call deadline), and
// a roamer's journey, a wait for a busy renderer and the frame all come out of it. A busy renderer is waited for, not
// refused. The renderer is told how long it may spend loading the world (the snap's `wait`), so it does not give up
// while the asker would still wait. And worlds an agent is in are kept served (sweep), so the first snapshot there
// rarely needs a roamer to travel and load at all.
export function createSnapshotBroker({ timeoutMs = 12_000, cooldownMs = 2000, maxPending = 16, now = Date.now,
  travelMs = 25_000, arrivalTimeoutMs = 40_000, pollMs = 200, recentMs = 5 * 60_000,
  queueMs = 20_000, maxQueued = 16, maxQueuedTotal = 64, budgetMs = 55_000, settleMarginMs = 2_000, pinnedGraceMs = 120_000, sweepAfterMs = 30_000,
  sweepBackoffMs = 15_000, sweepBackoffMaxMs = 10 * 60_000,
  /** How a queued request waits between looks at its renderers. Tests inject their own to decide who looks first. */
  pollSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
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
  const sent = new WeakMap<Client, { at: number; to: string }>();   // roamer → where it was last sent, and when
  const pinnedSeen = new Map<string, number>();   // world name → when a renderer of its own (not a roamer) was last seen there
  // A roamer that was sent somewhere and never arrived (a frozen page, a client that claims to roam and ignores travel)
  // is backed off: sweeps and pre-warms skip it, and an asked snapshot takes it only when no other roamer can go.
  // It clears the moment the roamer arrives anywhere.
  const roamerFailed = new WeakMap<Client, { until: number; count: number }>();
  const backedOff = (c: Client) => (roamerFailed.get(c)?.until ?? -Infinity) > now();
  // The queue of requests waiting for a busy renderer: first come, first served per world and renderer kind, and
  // bounded, so waiting can neither starve an early ask nor pile up without limit (each waiter holds an HTTP request).
  const waiting: { world: World; engine: string; seq: number }[] = [];
  /** Could a renderer serve an ask of this kind? (auto takes any; browser and unreal take their own.) The one
   *  place this is decided: candidatesIn and the queue both use it. */
  const eligible = (c: Client, engine: string) => engine === "auto" || (c.capture?.engine ?? "browser") === engine;
  // When each client last (re)joined a world (noteJoin, which the server calls at every join and travel). A ROAMER that
  // arrived within the arrival window may still be loading the world it was sent to, whoever sent it (this request, a
  // pre-warm, a sweep), so it gets the arrival window to settle.
  const joinedAt = new WeakMap<Client, number>();
  // A renderer counts as the world's own (pinned) one only when the server can believe it: it holds the renderers'
  // credential, or it has delivered a valid frame. The renderer flag alone is any client's claim at join.
  const proven = new WeakSet<Client>();
  const pinned = (c: Client) => !!c.renderer && !c.roam && (!!c.trustedRenderer || proven.has(c));
  const noRenderer = (world: World, engine: string) =>
    `no ${engine === "auto" ? "" : engine + " "}renderer is currently serving world "${world.name}"`;
  let waitSeq = 0;
  const startedAt = now();
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  /** The longest a request can wait: a roamer's journey, then its first frame. */
  const maxWait = () => travelMs + Math.max(arrivalTimeoutMs, timeoutMs);
  const asked = new Map<string, number>();   // world name → when a snapshot was last asked there (roamer rotation)
  const active = (c: Client, w: World) => c.world === w && w.clients.has(c) && !c.superseded
    && (c.ws.readyState == null || c.ws.readyState === 1);
  function retire(c: Client, leaving = true) {
    // a world's own renderer leaving (a restart, every few hours for the commons') starts its grace now, not at the
    // next sweep: the sweep must not send a roamer to load the world while it comes back
    if (leaving && pinned(c) && c.world) pinnedSeen.set(c.world.name, now());
    for (const [id, p] of pending) if (p.renderer === c || p.target === c) {
      log(`[snap] ${id}: ${p.renderer === c ? "renderer" : "followed body"} ${who(c)} disconnected or changed session — 503`);
      p.finish({ ok: false, err: "screenshot participant disconnected or changed session", status: 503,
        ...(p.renderer === c ? { retryAfter: 2 } : {}) });
    }
  }
  function configure(c: Client, value: unknown) {
    retire(c, false);   // a change of capability ends its pending shots; it is not a renderer leaving its world
    c.capture = (c.surface ?? "world") === "world" ? captureCapability(value) : undefined;
  }
  function request(world: World, follow: string, view = "first", engine = "auto",
    frame: { dist?: number; height?: number; pitch?: number } = {}, at?: string, callerBudgetMs?: number, signal?: AbortSignal): Promise<Result> {
    const fail = (err: string, status: number) => Promise.resolve<Result>({ ok: false, err, status });
    if (!["auto", "unreal", "browser"].includes(engine)) return fail("renderer must be auto, unreal, or browser", 400);
    const target = [...world.clients].find(c => c.id === follow && !c.spectator && active(c, world));
    if (!target) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    asked.set(world.name, now());
    // The request's one deadline. An operator's longer frame window (SNAP_TIMEOUT_SEC, for a software renderer) still
    // gets all of its window; GET /snap's own HTTP timeout (maxWaitMs) is never shorter than this.
    // A caller that says how long it will wait (GET /snap ?budget=, the MCPL tool's remaining budget) is not kept
    // longer than that, so a retry never outlasts the call that made it.
    const ownDeadline = now() + Math.min(maxWait(), Math.max(budgetMs, timeoutMs + 2 * settleMarginMs));
    const deadline = typeof callerBudgetMs === "number" && Number.isFinite(callerBudgetMs) && callerBudgetMs > 0
      ? Math.min(ownDeadline, now() + callerBudgetMs - 500) : ownDeadline;   // answered half a second inside it
    if (!candidatesIn(world, engine).length) {
      // a roamer can only be a browser renderer: an Unreal-only request is not summoned
      if (engine === "unreal") return fail(noRenderer(world, "unreal"), 503);
      // The journey comes out of the deadline too: a caller with less time than a journey and a frame is not held
      // for the whole journey and then sent a snap it cannot get. It hears that a roamer is on its way, and when to
      // ask again; the roamer keeps travelling, so the next ask finds it there.
      const late = Symbol("late");
      const journey = Math.max(0, deadline - now() - Math.min(timeoutMs, 3_000));
      let lateTimer: ReturnType<typeof setTimeout> | undefined;
      const tooLate = new Promise<typeof late>((res) => { lateTimer = setTimeout(() => res(late), journey); });
      return Promise.race([summon(world, "ask"), tooLate]).finally(() => clearTimeout(lateTimer)).then((arrived): Promise<Result> | Result => arrived === late
        ? { ok: false, err: `no renderer is serving world "${world.name}" yet; a roaming renderer is on its way, so ask again in a few seconds`, status: 503, retryAfter: 2 }
        : arrived
        ? dispatch(world, follow, view, engine, frame, target, Math.max(arrivalTimeoutMs, timeoutMs), at, deadline, signal)
        : { ok: false as const, err: doorOf(world) === "invite-only"
            ? `"${world.name}" is members-only and no roaming renderer holding the renderers' credential is free, so no snapshot can be taken there now`
            : `${noRenderer(world, "auto")}, and no roaming renderer could come`, status: 503 });
    }
    return dispatch(world, follow, view, engine, frame, target, timeoutMs, at, deadline, signal);
  }
  const candidatesIn = (world: World, engine: string) => [...world.clients].filter(c => active(c, world) && (c.renderer || c.capture)
    && eligible(c, engine))
    .sort((a, b) => Number(!!b.capture) - Number(!!a.capture));
  /** How much a roamer's current world still needs it: 0 — no agent there (parked, free); 1 — agents there, but none
   *  has asked for a snapshot recently; 2 — in use. Rotation takes the least needed, then the longest idle. An agent
   *  here is a body that joined with an agent's enrolment (tokenVerified: its credential, never a declaration, §6a). */
  const need = (c: Client) => {
    const w = c.world!;
    if (![...w.clients].some(o => o.tokenVerified && !o.spectator && active(o, w))) return 0;
    // a world with a renderer of its own (a pinned one, like the commons') does not need a roamer too: one there
    // arrived while that renderer restarted, and counts as parked, free to go where it is needed
    if ([...w.clients].some(o => o !== c && pinned(o) && active(o, w))) return 0;
    return now() - (asked.get(w.name) ?? -Infinity) >= recentMs ? 1 : 2;
  };
  /** Send a roaming renderer to `world` and wait for it to join there. One summons per world at a time; a roamer busy
   *  with a snapshot, or on its way somewhere, is not taken. A roamer a world is actively using is taken only for a
   *  snapshot actually asked (never for a pre-warm), and only when no freer one exists. A sweep takes only a PARKED
   *  roamer (no agent where it is), so keeping worlds served never takes a roamer from another world. */
  function summon(world: World, mode: "ask" | "prewarm" | "sweep"): Promise<boolean> { return startSummon(world, mode).arrived; }
  /** summon(), saying which roamer it sent (none: one was already on its way, or none could go). */
  function startSummon(world: World, mode: "ask" | "prewarm" | "sweep"): { sent: Client | null; arrived: Promise<boolean> } {
    const nothing = { sent: null, arrived: Promise.resolve(false) };
    const inFlight = travelling.get(world.name);
    if (inFlight && now() - inFlight.at < travelMs) return { sent: null, arrived: inFlight.arrived };
    const busy = new Set([...pending.values()].map(p => p.renderer));
    const enRoute = new Set([...travelling.keys()]);
    // …and only one the destination will let in. A roamer holding the
    // renderers' credential (RENDERER_TOKEN) goes anywhere — it is the vision
    // of the agents there; one without it is just a client that said
    // "renderer", and a closed world refuses it (server/access.ts). Never send
    // a roamer to be refused: a refused renderer stops rather than retrying,
    // and would sit dead until its watchdog restarted it.
    // a roamer already sent somewhere that has not arrived yet is on its way, whatever world it still shows
    const onItsWay = (c: Client) => { const s = sent.get(c); return !!s && now() - s.at < travelMs && c.world?.name !== s.to; };
    const roamers = [...allClients()].filter(c => c.roam && c.renderer && c.world && active(c, c.world)
      && c.world !== world && !busy.has(c) && !enRoute.has(c.world.name) && !onItsWay(c) && admits(world, c))
      .map(c => ({ c, n: need(c), off: backedOff(c) }))
      .filter(r => mode === "ask" || (!r.off && (mode === "prewarm" ? r.n !== 2 : r.n === 0)))
      .sort((a, b) => Number(a.off) - Number(b.off) || a.n - b.n || (last.get(a.c) ?? 0) - (last.get(b.c) ?? 0))
      .map(r => r.c);
    const roamer = roamers[0];
    if (!roamer) return nothing;
    try { roamer.ws.send(JSON.stringify({ type: "renderer-travel", world: world.name })); }
    catch { return nothing; }
    const at = now();
    sent.set(roamer, { at, to: world.name });
    const arrived = new Promise<boolean>((resolve) => {
      const tick = () => {
        if (candidatesIn(world, "auto").length) {
          travelling.delete(world.name);
          if (roamer.world === world) roamerFailed.delete(roamer);   // it came: whatever went wrong before is over
          return resolve(true);
        }
        if (now() - at >= travelMs) {
          travelling.delete(world.name);
          if (roamer.world !== world) {                              // it never came: back IT off, not the world
            const count = (roamerFailed.get(roamer)?.count ?? 0) + 1;
            const wait = Math.min(sweepBackoffMs * 2 ** (count - 1), sweepBackoffMaxMs);
            roamerFailed.set(roamer, { until: now() + wait, count });
            log(`[snap] roamer ${who(roamer)} did not arrive in "${world.name}" within ${travelMs / 1000}s — it is sent nowhere for ${Math.round(wait / 1000)}s unless no other roamer can go`);
          }
          return resolve(false);
        }
        setTimeout(tick, pollMs);
      };
      setTimeout(tick, pollMs);
    });
    travelling.set(world.name, { at, arrived });
    return { sent: roamer, arrived };
  }
  async function dispatch(world: World, follow: string, view: string, engine: string,
    frame: { dist?: number; height?: number; pitch?: number }, target: Client, waitMs: number, at?: string,
    deadline = now() + waitMs, signal?: AbortSignal): Promise<Result> {
    // An asker that has gone (its HTTP request aborted: a closed page, a proxy or host deadline) is not served: it
    // leaves the queue, so it neither holds back younger asks nor ties a renderer up making a frame nobody receives.
    const goneAway = (): Result => ({ ok: false, err: "the asker went away", status: 499 });
    if (signal?.aborted) return goneAway();
    const fail = (err: string, status: number): Result => ({ ok: false, err, status });
    // A free renderer for this ask, leaving any an OLDER waiter in this world could use to that waiter: first come,
    // first served, per renderer, so "auto" and "browser" asks competing for one browser renderer keep their order,
    // and an Unreal-only waiter never blocks a browser ask for a renderer it could not use.
    const free = (olderThan: number) => pending.size >= maxPending ? undefined : candidatesIn(world, engine).find(c => now() - (last.get(c) ?? -Infinity) >= cooldownMs
      && ![...pending.values()].some(p => p.renderer === c) && (c.ws.getBufferedAmount?.() ?? 0) < 256_000
      && !waiting.some(t => t.world === world && t.seq < olderThan && eligible(c, t.engine)));
    // A BUSY RENDERER IS WAITED FOR, not refused. Two agents asking at once in one world, or a second ask while the
    // first is still loading the world, used to get "renderers busy" back on the first try. Now the request waits
    // for a renderer to come free, up to `queueMs`, and never so long that the frame would not fit before its deadline.
    // At most `maxQueued` wait in a world (and `maxQueuedTotal` in all); beyond that the answer is "busy" at once.
    const busy = (): Result => ({ ok: false, err: "renderers busy; retry in a few seconds", status: 429, retryAfter: 2 });
    if (!active(target, world)) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    // A renderer that was here (or a roamer that just arrived) and is gone again: another world's ask took the roamer,
    // or a pinned renderer restarted. Retryable, unlike "no renderer and no roamer to send" (request).
    const gone = (): Result => ({ ok: false, err: noRenderer(world, engine), status: 503, retryAfter: 2 });
    if (!candidatesIn(world, engine).length) return gone();
    // a new ask is younger than every waiter: it takes no renderer one of them could use
    let renderer = free(Infinity);
    if (!renderer) {
      // capped per world, so a burst in one world never turns another world's first ask into "busy"; and in all
      if (waiting.filter((t) => t.world === world).length >= maxQueued || waiting.length >= maxQueuedTotal) return busy();
      const ticket = { world, engine, seq: ++waitSeq };
      waiting.push(ticket);
      const queueUntil = Math.min(now() + queueMs, deadline - Math.min(timeoutMs, 3_000));
      try {
        for (;;) {
          if (now() >= queueUntil) return busy();
          await pollSleep(pollMs);
          if (signal?.aborted) return goneAway();
          if (!active(target, world)) return fail(`"${follow}" is not present in "${world.name}"`, 404);
          if (!candidatesIn(world, engine).length) return gone();
          if ((renderer = free(ticket.seq))) break;
        }
      } finally { waiting.splice(waiting.indexOf(ticket), 1); }
    }
    const chosen = renderer!;
    // A roamer that arrived within the arrival window may still be loading the world (a pre-warm or a sweep sent it
    // moments ago): it gets the arrival window, not the frame window. A pinned renderer keeps the operator's frame
    // window (SNAP_TIMEOUT_SEC) even just after a restart; caught mid-load, its own "still loading" is retryable.
    if (chosen.roam && now() - (joinedAt.get(chosen) ?? -Infinity) < arrivalTimeoutMs) waitMs = Math.max(waitMs, arrivalTimeoutMs);
    // the frame gets its window, cut to what is left of the request's deadline
    waitMs = Math.max(1, Math.min(waitMs, deadline - now()));
    if (!["first", "third", "selfie"].includes(view)) view = "first";
    const id = `capture-${randomUUID()}`;
    last.set(chosen, now());
    return new Promise(resolve => {
      const renderer = chosen;
      const timer = setTimeout(() => {
        // say which snap, whose renderer, and how backed-up its socket was
        log(`[snap] ${id} follow=${quote(follow)} view=${view}: no frame from ${who(renderer)} in ${waitMs / 1000}s ` +
          `(renderer ws buffered=${renderer.ws.getBufferedAmount?.() ?? "?"}) — 504`);
        p.finish({ ok: false, err: "renderer timed out", status: 504, retryAfter: 2 });
      }, waitMs);
      const p: Pending = { renderer, target, world, gen: renderer.gen,
        engine: renderer.capture?.engine ?? "browser", scene: renderer.capture?.scene ?? "world-fold",
        finish(r) { if (!pending.delete(id)) return; clearTimeout(timer); resolve(r); } };
      pending.set(id, p);
      // framing (shared/snapframe.js) rides nested, apart from the image size,
      // and only when a field is given; `at` frames a placed thing instead (an agent checks what it built). The request
      // is `capture` and its answer `capture-result` (docs/WIRE.md; main's wire said snap / snap-result). `wait` is how
      // long the renderer may spend loading the world before it must answer (net_capture.js settle): this frame's
      // window, less a margin for the capture and the send (a fixed 20 s failed a world that loaded at 22 s, 2026-10-24).
      try { renderer.ws.send(JSON.stringify({ type: "capture", id, follow, view, width: 960, height: 540,
        wait: Math.max(0, waitMs - settleMarginMs),
        ...(Object.keys(frame).length ? { frame } : {}), ...(at ? { at } : {}) })); }
      catch { log(`[snap] ${id}: send to renderer ${who(renderer)} failed — 503`); p.finish({ ok: false, err: "renderer unavailable", status: 503, retryAfter: 2 }); }
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
      // Retryable only when the renderer says it is still loading (client/lib/net_capture.js: "still loading this world",
      // "not in local scene (still loading?)"): that passes in seconds. Any other refusal (a capture that throws, a
      // frame that will not compose) would fail the same way again, so the asker hears it at once.
      return p.finish({ ok: false, err, status: 503, ...(/still loading/i.test(err) ? { retryAfter: 2 } : {}) });
    }
    const png = pngFromDataURL(msg.dataUrl);
    if (!png) log(`[snap] ${msg.id}: renderer ${who(c)} sent no valid PNG (${typeof msg.dataUrl === "string" ? `${msg.dataUrl.length} chars` : typeof msg.dataUrl}) — 502`);
    if (png) proven.add(c);
    p.finish(png ? { ok: true, png, engine: p.engine, scene: p.scene }
      : { ok: false, err: "renderer could not supply a valid image", status: 502 });
  }
  /** PRE-WARM: a body that can ask for snapshots (an agent) arrived in `world`. If no renderer serves it, send a roamer
   *  now, so the world is loaded by the time the first snapshot is asked. Fire-and-forget; idempotent per world. */
  function prewarm(world: World) {
    if (!candidatesIn(world, "auto").length) void summon(world, "prewarm");
  }
  /** SWEEP: every world with an agent in it and no renderer gets a PARKED roamer (one with no agent where it is), so
   *  the first snapshot there finds the world loaded. Pre-warm covers an agent arriving. The sweep covers everything
   *  else that leaves an agent's world unserved: a roamer's watchdog restarting it into its lobby (every few hours,
   *  and on every client deploy), a renderer leaving, an agent that arrived while every roamer was busy. The server
   *  runs it when a roamer joins and on a timer. Parked roamers only, so it never takes a roamer a world is using;
   *  with more such worlds than roamers, the rest wait for a snapshot to be asked. */
  function sweep() {
    const worlds = new Set<World>();
    for (const c of allClients()) {
      if (!c.world || !active(c, c.world)) continue;
      if (c.tokenVerified && !c.spectator) worlds.add(c.world);   // an agent: its enrolment, never a declaration (§6a)
      if (pinned(c)) pinnedSeen.set(c.world.name, now());
    }
    // Just after a start, renderers are still reconnecting (a roamer rejoins the world it was in): give them that.
    if (now() - startedAt < sweepAfterMs) return;
    // A world whose own renderer was here moments ago is only waiting for it to restart (the commons renderer does,
    // every few hours): a roamer sent there would load the whole world for nothing. A snapshot asked meanwhile is
    // still served on demand.
    for (const w of worlds) {
      if (candidatesIn(w, "auto").length) continue;
      if (now() - (pinnedSeen.get(w.name) ?? -Infinity) < pinnedGraceMs) continue;
      // A roamer that never arrives is backed off itself (startSummon), so the next sweep sends a healthy one, and a
      // broken roamer cannot make every agent's world wait in turn.
      void startSummon(w, "sweep");
    }
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
  /** A client has (re)joined a world: the server calls this at every join, travel included. A roamer that joined
   *  within the arrival window may still be loading that world (dispatch). */
  function noteJoin(c: Client) { joinedAt.set(c, now()); }
  /** The sweep's grace after a start (config.ts SNAP_SWEEP_GRACE_SEC), injected the same way. */
  function setSweepGrace(ms: number) { sweepAfterMs = ms; }
  return { request, receive, retire, configure, noteJoin, setClients, setAdmission, setFrameTimeout, setSweepGrace, prewarm, sweep,
    get pendingCount() { return pending.size; },
    /** The longest a request can wait: a roamer's journey, then its first frame. GET /snap sizes its own HTTP
     *  timeout from this. A request's own deadline is never later than this. */
    get maxWaitMs() { return maxWait(); } };
}
export const snapshots = createSnapshotBroker();
