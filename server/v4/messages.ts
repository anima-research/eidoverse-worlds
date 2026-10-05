// server/v4/messages.ts — the ws messages a v4 world answers differently (slice 2). server.ts consults this table
// first, and ONLY when the client's world is a v4 world (World.v4); every v1 world dispatches exactly as before.
//
//   v4      {type: "v4", id, tool, args} → {type: "v4-result", id, tool, ok, reply}, reply = the door's own answer
//           (kept whole under `reply`: a door reply has fields of its own, such as inspect's `id`). Any door request
//           (create, set, delete, place, batch, use, say, undo, publish, update, grab/put/throw/move/drop/wait, and the
//           reads look/inspect/measure/find/check/history/schema/help). The asker is stamped from the connection
//           (L4), never read from the payload. Spectators may only read.
//   verb    refused (slice 3c): a v4 world takes door requests only. Every client spells its UI's verbs as requests at
//           its own edge (shared/v4/fromv1.js: the page's net.js, the agent's sendVerb), so no v1 verb reaches here.
//   lease, world-fork, world-reset
//           refused: a lease's settlement skipped every gate in v1 (PARITY (c)2), and fork/reset act on v1 files.
//
// Requests from one client run in order: an async warm-up (measuring a model) never lets a later request overtake an
// earlier one (the same per-client queue the v1 verb path uses).
import type { Client, World } from "../world.ts";
import { enc } from "../../shared/v4/names.js";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: unknown };
type Any = any;
const READS = new Set(["look", "inspect", "measure", "find", "check", "history", "schema", "help", "wait"]);
/** The identity the door stamps for this connection (names.js: the same encoding the translator gives old logs). */
export const actorOf = (c: Client) => enc(c.id);

/** Run fn after this client's earlier requests (their warm-ups are async); never let a throw break the queue. */
function inOrder(c: Client, ws: Ctx["ws"], fn: () => Promise<void>) {
  const tail = (c.verbQueue ?? Promise.resolve()).then(fn).catch((err) => {
    console.error(`[ws] v4 request from ${c.id} failed server-side:`, err);
    try { ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* gone */ }
  });
  c.verbQueue = tail;
  void tail.then(() => { if (c.verbQueue === tail) c.verbQueue = undefined; });
}

const V1_VERB = { code: "v1-verb", reason: "a v4 world takes door requests, not v1 verbs", teach: "send {type: 'v4', id, tool, args}; help lists the tools" };


export const V4_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "v4": ({ c, ws }, msg) => {
    // {tool, args}: a door request (a v1 `verb` in it is refused: clients spell at their own edge, 3c)
    const w = c.world; if (!w?.v4) return;
    const rid = msg.id ?? null;
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const tool = String(msg.tool ?? "");
    const reply = (r: Any) => ws.send(JSON.stringify({ type: "v4-result", id: rid, tool, ok: r.ok === true, reply: r }));
    if (typeof msg.verb === "string") { w.debug("v4-v1-verb", { who: c.id, verb: msg.verb }); reply({ ok: false, refused: V1_VERB }); return; }
    if (c.spectator && !READS.has(tool)) { reply({ ok: false, refused: { code: "spectator", reason: "spectators may read, not write", teach: "join embodied" } }); return; }
    inOrder(c, ws, async () => {
      if (c.world !== w) return;
      reply(await w.v4!.request(actorOf(c), tool, args));
    });
  },
  "verb": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    w.debug("v4-v1-verb", { who: c.id, verb: String(msg.verb ?? "") });
    ws.send(JSON.stringify({ type: "error", error: `${V1_VERB.reason} (this '${String(msg.verb ?? "")}' wasn't written) — reload the page for the current client` }));
  },
  "lease": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "leases aren't part of v4 worlds: carrying is grab/put/throw through the door (L6)" })); },
  "world-fork": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "copying a v4 world isn't supported yet (slice 2)" })); },
  "world-reset": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "erasing a v4 world isn't supported yet (slice 2)" })); },
};
export const v4Handler = (type: unknown) => (typeof type === "string" && Object.hasOwn(V4_MESSAGES, type) ? V4_MESSAGES[type] : undefined);
