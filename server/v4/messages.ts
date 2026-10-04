// server/v4/messages.ts — the ws messages a v4 world answers differently (slice 2). server.ts consults this table
// first, and ONLY when the client's world is a v4 world (World.v4); every v1 world dispatches exactly as before.
//
//   v4      {type: "v4", id, tool, args} → {type: "v4-result", id, tool, ok, reply}, reply = the door's own answer
//           (kept whole under `reply`: a door reply has fields of its own, such as inspect's `id`). Any door request
//           (create, set, delete, place, batch, use, say, undo, publish, update, grab/put/throw/move/drop/wait, and the
//           reads look/inspect/measure/find/check/history/schema/help). The asker is stamped from the connection
//           (L4), never read from the payload. Spectators may only read.
//   verb    the old UI's v1 verbs, mapped onto the door's requests where a v4 spelling exists (toV4 below). A refusal
//           goes back as {type: "error"}, which today's client already shows (and rolls back on). A verb with no v4
//           spelling yet is refused by name.
//   lease, world-fork, world-reset
//           refused: a lease's settlement skipped every gate in v1 (PARITY (c)2), and fork/reset act on v1 files.
//
// Requests from one client run in order: an async warm-up (measuring a model) never lets a later request overtake an
// earlier one (the same per-client queue the v1 verb path uses).
import type { Client, World } from "../world.ts";
import { enc } from "../../shared/v4/names.js";
import { toV4 as toV4At } from "../../shared/v4/fromv1.js";
import { refusalText } from "../../shared/v4/refusal.js";

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

/** A v1 verb as a door request (shared/v4/fromv1.js), against this world's current fold. */
export const toV4 = (w: World, verb: string, a: Any) => toV4At(w.v4!.live.state(), verb, a) as { tool: string; args: Any } | { refuse: string } | { noop: true };


export const V4_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "v4": ({ c, ws }, msg) => {
    // {tool, args}: a door request. {verb, args}: a v1 verb, mapped by toV4 (the same mapping the old UI's `verb`
    // takes), for an agent's building tools that must WAIT for the door's answer (PARITY (d)1).
    const w = c.world; if (!w?.v4) return;
    const rid = msg.id ?? null;
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const verb = typeof msg.verb === "string" ? msg.verb : null;
    const tool = verb ? `verb:${verb}` : String(msg.tool ?? "");
    const reply = (r: Any) => ws.send(JSON.stringify({ type: "v4-result", id: rid, tool, ok: r.ok === true, reply: r }));
    if (c.spectator && (verb || !READS.has(tool))) { reply({ ok: false, refused: { code: "spectator", reason: "spectators may read, not write", teach: "join embodied" } }); return; }
    inOrder(c, ws, async () => {
      if (c.world !== w) return;
      let t = tool, a = args;
      if (verb) {
        const m = toV4(w, verb, args);
        if ("noop" in m) { reply({ ok: true, noop: true }); return; }
        if ("refuse" in m) { reply({ ok: false, refused: { code: "no-v4-spelling", reason: m.refuse, teach: "the door tool takes the v4 request itself" } }); return; }
        t = m.tool; a = m.args;
      }
      reply({ ...(await w.v4!.request(actorOf(c), t, a)), ...(verb ? { as: t } : {}) });
    });
  },
  "verb": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4 || c.spectator) return;
    const verb = String(msg.verb ?? ""), a = msg.args && typeof msg.args === "object" ? msg.args : {};
    inOrder(c, ws, async () => {
      if (c.world !== w) return;
      const m = toV4(w, verb, a);
      if ("noop" in m) return;
      if ("refuse" in m) { w.debug("v4-verb-refused", { who: c.id, verb, why: m.refuse }); ws.send(JSON.stringify({ type: "error", error: m.refuse })); return; }
      const r = await w.v4!.request(actorOf(c), m.tool, m.args);
      if (!r.ok) { w.debug("v4-refused", { who: c.id, verb, tool: m.tool, refused: r.refused }); ws.send(JSON.stringify({ type: "error", error: refusalText(verb, r) })); }
    });
  },
  "lease": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "leases aren't part of v4 worlds: carrying is grab/put/throw through the door (L6)" })); },
  "world-fork": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "copying a v4 world isn't supported yet (slice 2)" })); },
  "world-reset": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "erasing a v4 world isn't supported yet (slice 2)" })); },
};
export const v4Handler = (type: unknown) => (typeof type === "string" && Object.hasOwn(V4_MESSAGES, type) ? V4_MESSAGES[type] : undefined);
