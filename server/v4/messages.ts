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
import { forkV4 } from "./world.ts";
import type { Client, World } from "../world.ts";
import { globalBans, saveGlobalBans, banKey, ADDR_BAN_MS } from "../moderation.ts";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: (w: World, target: Client, why: string) => void };
type Any = any;
const READS = new Set(["look", "inspect", "measure", "find", "check", "history", "schema", "help", "wait"]);
/** The identity the door stamps for this connection: its opaque directory id, set at join (server.ts admitJoin). A
 *  connection without one (it never joined a v4 world) has no identity here: a request from it is a server bug. */
export const actorOf = (c: Client) => { if (!c.v4id) throw new Error(`v4 request from ${c.id} with no directory id (join didn't resolve one)`); return c.v4id; };

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
  "v4": ({ c, ws, expel }, msg) => {
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
      const r = await w.v4!.request(actorOf(c), tool, args);
      reply(r);
      // a ban or kick the door accepted takes the person out NOW (H4b: a ban used to leave the banned person present,
      // talking and whispering until they chose to leave). A guest has no account to ban, so their ban also names their
      // connection's address in this world for a day (moderation.ts) — or they'd simply reconnect as a fresh guest.
      if (r?.ok && (tool === "ban" || tool === "kick")) {
        const who = String(args.who);
        for (const t of [...w.clients]) if (t.v4id === who) {
          if (tool === "ban" && t.anonymous && t.addr) {
            globalBans[banKey(null, t.addr, w.name)] = { by: c.id, ts: Date.now(), name: t.id, addr: t.addr, until: Date.now() + ADDR_BAN_MS, world: w.name, ...(args.reason ? { reason: String(args.reason) } : {}) };
            saveGlobalBans();
          }
          expel(w, t, `you were ${tool === "ban" ? "banned from" : "removed from"} "${w.name}"${args.reason ? ` — ${String(args.reason)}` : ""}`);
        }
      }
    });
  },
  "verb": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    w.debug("v4-v1-verb", { who: c.id, verb: String(msg.verb ?? "") });
    ws.send(JSON.stringify({ type: "error", error: `${V1_VERB.reason} (this '${String(msg.verb ?? "")}' wasn't written) — reload the page for the current client` }));
  },
  "lease": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "leases aren't part of v4 worlds: carrying is grab/put/throw through the door (L6)" })); },
  // Copy the world you're standing in to a new name: a new world (its own identity) whose founding act names this one,
  // holding a copy of its current state. Owner-only (it copies everything here; the owner's call).
  "world-fork": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't copy worlds — join embodied");
    const role = w.v4.roleOf(actorOf(c)); if (role !== "owner") return err(`copying a world needs its owner — you are a ${role} here`);
    const to = String(msg.to ?? "").slice(0, 64);
    const r = forkV4(w.v4, to, actorOf(c));
    if (!r.ok) return err(r.err);
    console.log(`[world:${w.name}] copied → "${to}" by ${c.id} (${r.things} things, ${r.acts} acts)`);
    ws.send(JSON.stringify({ type: "world-forked", from: w.name, to }));
  },
  // Erase the world you're standing in to zero. Owner-only, and the request must carry the world's own name (the
  // client makes you type it). History is archived beside it, never destroyed; the same owners hold the fresh world.
  "world-reset": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't erase worlds — join embodied");
    const role = w.v4.roleOf(actorOf(c)); if (role !== "owner") return err(`erasing a world needs its owner — you are a ${role} here`);
    if (String(msg.name ?? "") !== w.name) return err(`confirmation mismatch — reset must name "${w.name}"`);
    let arch: string; try { arch = w.resetV4(); } catch (e: Any) { return err(`the reset failed and nothing changed: ${String(e?.message ?? e)}`); }
    console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
    w.broadcast({ type: "world-reset", world: w.name, by: c.id });
  },
};
export const v4Handler = (type: unknown) => (typeof type === "string" && Object.hasOwn(V4_MESSAGES, type) ? V4_MESSAGES[type] : undefined);
