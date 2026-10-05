// shared/v4/fromv1.js — a v1 verb (today's UI and agent tools still PLAN in them) as a v4 door request. One mapping for
// every caller, applied at the caller's own edge (slice 3c): the page (net.js sendVerb, v4edit.js), and the agent's
// building tools (mcpl/agent.ts sendVerb) spell their verbs here and send only door requests, so a human's edit and an
// agent's are the same request by construction, and no v1 verb reaches a v4 world. Pure; browser-safe.
import { enc, encName } from "./names.js";
import { qNorm } from "../rot.js";

const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const s3 = (s) => (typeof s === "number" && Number.isFinite(s) ? [s, s, s] : Array.isArray(s) && s.length === 3 ? s : undefined);
const qOf = (a) => qNorm(a?.q) ?? (Number.isFinite(a?.yaw) ? yawQ(a.yaw) : undefined);

/** A v1 verb as a door request against the v4 state `st` (the fold), or {refuse: reason}, or {noop: true}. Ids and
 *  component names go through names.js. */
export function toV4(st, verb, a) {
  const id = (s) => enc(String(s ?? ""));
  const has = (x) => !!st.entities[x];
  const tf = (x, cur) => ({ ...(cur ?? {}), ...(Array.isArray(x.pos) ? { pos: x.pos } : {}), ...(qOf(x) ? { q: qOf(x) } : {}), ...(s3(x.scale) ? { scale: s3(x.scale) } : {}) });
  switch (verb) {
    case "spawn":
      return { tool: "create", args: { id: id(a.id), ...(typeof a.lib === "string" && a.lib ? { model: a.lib } : {}), components: { transform: tf(a) } } };
    case "place": {
      const e = st.entities[id(a.id)];
      // a child's transform is LOCAL to its parent, so a place (world pos) can't move it; its scale is its own, though,
      // and a scale-only place (the Inspector's scale channels, the gizmo's scale) sets just that
      const onlyScale = a.scale != null && a.pos == null && a.q == null && a.yaw == null;
      if (e?.c.parent && onlyScale) return { tool: "set", args: { id: id(a.id), component: "transform", value: { ...e.c.transform, scale: s3(a.scale) } } };
      if (e?.c.parent) return { refuse: `${a.id} rides ${e.c.parent.to}: move it relative to it (mount with an offset), or detach it first` };
      return { tool: "set", args: { id: id(a.id), component: "transform", value: tf(a, e?.c.transform) } };
    }
    case "remove": return { tool: "delete", args: { id: id(a.id) } };
    case "comp": {
      if (typeof a.type !== "string") return { refuse: "comp needs a type" };
      // §5: `lock` is v1's lock, the same component with the same meaning (the identity). `guard` merged into it; an
      // old UI's guard toggle is refused with that reason rather than silently becoming a lock someone didn't ask for.
      if (a.type === "guard") return { refuse: "in a v4 world `guard` is merged into `lock` (PROTOCOL-v4 §5): lock it instead (any builder may unlock it)" };
      const comp = encName(a.type);
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
      // v1 reads a mount as the renderer does: at the offset, else the named socket's pos (and its yaw), else the
      // carrier's origin (shared/hierarchy.js localOf; translate-v1@2 writes old mounts the same way)
      const socks = st.entities[id(a.to)]?.c.sockets; const sock = typeof a.slot === "string" && socks && typeof socks === "object" && Object.hasOwn(socks, a.slot) ? socks[a.slot] : null;
      const slot = typeof a.slot === "string" && a.slot ? { slot: a.slot } : {};
      return { tool: "batch", args: { ops: [
        { tool: "set", args: { id: id(a.id), component: "parent", value: { to: id(a.to), ...slot } } },
        { tool: "set", args: { id: id(a.id), component: "transform", value: { ...(cur ?? {}), pos: Array.isArray(a.offset) ? a.offset : Array.isArray(sock?.pos) ? sock.pos : [0, 0, 0],
          q: qOf(a) ?? (Number.isFinite(sock?.yaw) ? yawQ(sock.yaw) : [0, 0, 0, 1]) } } }] } };
    }
    case "dismount": {
      const ops = [{ tool: "delete", args: { id: id(a.id), component: "parent" } }];
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
      // a role is held by an IDENTITY (u-…, from the door directory: the person's arrival carries it), never by a typed
      // name (round-2 R1/R2). A caller resolves the person first; a name that isn't an identity is refused, not guessed.
      if (!/^u-[a-z2-7]{20}$/.test(String(a.id ?? ""))) return { refuse: `in a v4 world a role goes to a person's identity, not a name: '${a.id}' isn't one (whoever is present has one; look lists them)` };
      return { tool: "set", args: { id: "@world", component: `roles:${a.id}`, value: { role: String(a.role) } } };
    default:
      return { refuse: `'${verb}' has no v4 request yet in this world (slice 2 maps spawn, place, remove, comp, motion, mount, dismount, light, say, use, grant)` };
  }
}

// ---- a whole plan: several v1 verbs as one request ----
const qArg = (a) => (Array.isArray(a?.q) && a.q.length === 4 ? a.q : Number.isFinite(a?.yaw) ? yawQ(a.yaw) : undefined);
/** v1 verbs (as today's UI and agent tools plan them) → ONE door request against the fold `st` (a single tool, or a
 *  batch), or {refuse} / {noop}. One edit is one act, so one Ctrl+Z. Every client spells at its own edge (3c): no v1
 *  verb crosses the wire to a v4 world. */
export function spellVerbs(st, verbs) {
  const ops = [];
  for (const v of verbs) {
    const a = v.args ?? {}; const e = a.id != null ? st.entities[enc(String(a.id))] : null;
    // a thing that already rides a parent moves in that parent's frame (what the scene shows it at): set transform,
    // local. A `mount` to the parent it already has is the same move (editschema spells a child's move as a mount).
    const sameParent = v.verb === 'mount' && e?.c.parent?.to === enc(String(a.to)) && (e.c.parent.slot ?? null) === (a.slot ?? null);
    if ((v.verb === 'place' && e?.c.parent) || sameParent) {
      const t = { ...(e.c.transform ?? {}) };
      const pos = v.verb === 'mount' ? a.offset : a.pos; if (Array.isArray(pos)) t.pos = pos;
      const q = qArg(a); if (q) t.q = q;
      if (Number.isFinite(a.scale)) t.scale = [a.scale, a.scale, a.scale];
      else if (Array.isArray(a.scale) && a.scale.length === 3 && a.scale.every(Number.isFinite)) t.scale = [...a.scale];   // per axis (R 10-04)
      ops.push({ tool: 'set', args: { id: enc(String(a.id)), component: 'transform', value: t } });
      continue;
    }
    const m = toV4(st, v.verb, a);
    if ('noop' in m) continue;
    if ('refuse' in m) return { refuse: m.refuse };
    if (m.tool === 'batch') ops.push(...m.args.ops); else ops.push(m);
  }
  if (!ops.length) return { noop: true };
  return ops.length === 1 ? ops[0] : { tool: 'batch', args: { ops } };
}
