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
import { enc, encName } from "../../shared/v4/names.js";
import { qNorm } from "../../shared/rot.js";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: unknown };
type Any = any;
const READS = new Set(["look", "inspect", "measure", "find", "check", "history", "schema", "help", "wait"]);
const yawQ = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const s3 = (s: unknown) => (typeof s === "number" && Number.isFinite(s) ? [s, s, s] : Array.isArray(s) && s.length === 3 ? s : undefined);
const qOf = (a: Any) => qNorm(a?.q) ?? (Number.isFinite(a?.yaw) ? yawQ(a.yaw) : undefined);

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

/** A v1 verb as a door request, or a refusal reason. Ids and component names go through names.js. */
export function toV4(w: World, verb: string, a: Any): { tool: string; args: Any } | { refuse: string } | { noop: true } {
  const st = w.v4!.live.state();
  const id = (s: unknown) => enc(String(s ?? ""));
  const has = (x: string) => !!st.entities[x];
  const tf = (x: Any, cur?: Any) => ({ ...(cur ?? {}), ...(Array.isArray(x.pos) ? { pos: x.pos } : {}), ...(qOf(x) ? { q: qOf(x) } : {}), ...(s3(x.scale) ? { scale: s3(x.scale) } : {}) });
  switch (verb) {
    case "spawn":
      return { tool: "create", args: { id: id(a.id), ...(typeof a.lib === "string" && a.lib ? { model: a.lib } : {}), components: { transform: tf(a) } } };
    case "place": {
      const e = st.entities[id(a.id)];
      if (e?.c.parent) return { refuse: `${a.id} rides ${e.c.parent.to}: move it relative to it (mount with an offset), or detach it first` };
      return { tool: "set", args: { id: id(a.id), component: "transform", value: tf(a, e?.c.transform) } };
    }
    case "remove": return { tool: "delete", args: { id: id(a.id) } };
    case "comp": {
      if (typeof a.type !== "string") return { refuse: "comp needs a type" };
      const comp = a.type === "lock" ? "pinned" : encName(a.type);
      if (a.data == null) return has(id(a.id)) && comp in (st.entities[id(a.id)].c) ? { tool: "delete", args: { id: id(a.id), component: comp } } : { noop: true };
      return { tool: "set", args: { id: id(a.id), component: comp, value: a.type === "lock" ? true : a.data } };
    }
    case "motion": {
      const { id: _i, ...m } = a ?? {};
      if (m.type == null) return has(id(a.id)) && "motion" in st.entities[id(a.id)].c ? { tool: "delete", args: { id: id(a.id), component: "motion" } } : { noop: true };
      return { tool: "set", args: { id: id(a.id), component: "motion", value: m } };
    }
    case "mount": {
      if (!a?.to) return { refuse: "mount needs to" };
      const cur = st.entities[id(a.id)]?.c.transform;
      return { tool: "batch", args: { ops: [
        { tool: "set", args: { id: id(a.id), component: "parent", value: { to: id(a.to) } } },
        { tool: "set", args: { id: id(a.id), component: "transform", value: { ...(cur ?? {}), pos: Array.isArray(a.offset) ? a.offset : [0, 0, 0], q: qOf(a) ?? [0, 0, 0, 1] } } }] } };
    }
    case "dismount": {
      const ops: Any[] = [{ tool: "delete", args: { id: id(a.id), component: "parent" } }];
      if (Array.isArray(a.pos)) ops.push({ tool: "set", args: { id: id(a.id), component: "transform", value: tf(a, st.entities[id(a.id)]?.c.transform) } });
      return { tool: "batch", args: { ops } };
    }
    case "light": {
      const L = Object.fromEntries(["color", "intensity", "range", "keep", "day"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      if (has(id(a.id))) return { tool: "batch", args: { ops: [
        { tool: "set", args: { id: id(a.id), component: "light", value: L, merge: true } },
        ...(Array.isArray(a.pos) ? [{ tool: "set", args: { id: id(a.id), component: "transform", value: { pos: a.pos } } }] : [])] } };
      return { tool: "create", args: { id: id(a.id), components: { transform: { pos: Array.isArray(a.pos) ? a.pos : [0, 1, 0] }, light: L } } };
    }
    case "say": return { tool: "say", args: { text: String(a?.text ?? ""), ...(a?.to ? { to: id(a.to) } : {}) } };
    case "use": return { tool: "use", args: { id: id(a.id), ...(a.action ? { action: String(a.action) } : {}), ...(a.args ? { args: a.args } : {}) } };
    case "grant":
      if (!a?.role) return { refuse: "in a v4 world a grant sets a role (gen, fly and caption deeds aren't v4 components yet)" };
      return { tool: "set", args: { id: "@world", component: `roles:${id(a.id)}`, value: { role: String(a.role) } } };
    default:
      return { refuse: `'${verb}' has no v4 request yet in this world (slice 2 maps spawn, place, remove, comp, motion, mount, dismount, light, say, use, grant)` };
  }
}

const refusalText = (r: Any) => `${r.refused?.reason ?? "refused"}${r.refused?.teach ? ` — ${r.refused.teach}` : ""}`;

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
      if (!r.ok) { w.debug("v4-refused", { who: c.id, verb, tool: m.tool, refused: r.refused }); ws.send(JSON.stringify({ type: "error", error: refusalText(r) })); }
    });
  },
  "lease": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "leases aren't part of v4 worlds: carrying is grab/put/throw through the door (L6)" })); },
  "world-fork": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "copying a v4 world isn't supported yet (slice 2)" })); },
  "world-reset": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "erasing a v4 world isn't supported yet (slice 2)" })); },
};
export const v4Handler = (type: unknown) => (typeof type === "string" && Object.hasOwn(V4_MESSAGES, type) ? V4_MESSAGES[type] : undefined);
