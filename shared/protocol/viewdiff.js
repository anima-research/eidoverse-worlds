// shared/protocol/viewdiff.js — what changed between two world views (view.js viewState), said in the protocol's terms (slice 3c).
// The renderer's realizers and the agent's caches react to these. Pure.
//   diffView(prev, next) → { things: [{id, what, comp?}], world: [key], ids: {<map key>: [changed entry]} }
//     what: 'gone'   the thing left the world
//           'born'   it's new, or became a different thing (another model, kind, or a field only a rebuild can show)
//           'pose'   its own transform (pos / q / scale / scale3) moved
//           'parent' what it hangs from changed (attached, detached, or another parent / slot / offset)
//           'comp'   one component (`comp`) was set, changed or removed
//     world: the @world keys whose value changed (sky, terrain, grass, assets, roles, bans, blueprints, …)
//     ids:   for a world key that's a map (roles, bans, behaviors), the entries in it that changed: {roles: ['Ann']}
// A 'born' implies everything about the thing; it isn't followed by 'pose'/'parent'/'comp' for the same id.

const EPS = 1e-9;
export function near(a, b) {
  // a whole number is a count, an id's seq or a timestamp, compared exactly (a ms stamp near 1.7e12 is 1.7 s wide at a relative
  // 1e-9); the tolerance is for float noise in poses and scales
  if (typeof a === "number" && typeof b === "number") return a === b || (!(Number.isInteger(a) && Number.isInteger(b)) && Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => near(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && near(a[k], b[k]));
  }
  return a === b;
}

const POSE = ["pos", "q", "scale", "scale3"];
// fields the diff reads itself (the derived ones, view.js DERIVED), or that are stamps rather than state; every other key on
// a record is a component (model, parent and the rest sit flat, in the protocol's names)
const OWN = new Set([...POSE, "model", "kind", "yaw", "parent", "born", "actor", "ts", "placer"]);
// a component only a rebuild can show: the thing becomes another thing when it changes
const REBUILDS = new Set(["model", "kind", "mesh"]);
const NOT_WORLD = new Set(["entities", "recentChat", "chatTotal"]);
const MAPS = new Set(["roles", "bans", "behaviors"]);

/** One thing's change from `p` to `n` (either may be undefined), appended to `out`. */
export function diffThing(id, p, n, out) {
  if (!n) { if (p) out.push({ id, what: "gone" }); return; }
  const fresh = !p || [...REBUILDS].some((k) => !near(p[k] ?? null, n[k] ?? null));
  if (fresh) { if (p) out.push({ id, what: "gone" }); out.push({ id, what: "born" }); return; }
  if (POSE.some((k) => !near(p[k], n[k]))) out.push({ id, what: "pose" });
  if (!near(p.parent, n.parent)) out.push({ id, what: "parent" });
  const comps = (r) => Object.keys(r ?? {}).filter((k) => !OWN.has(k));
  for (const comp of new Set([...comps(p), ...comps(n)])) if (!near(p[comp], n[comp])) out.push({ id, what: "comp", comp });
}

export function diffView(prev, next) {
  const things = [], world = [], ids = {};
  const P = prev?.entities ?? {}, N = next?.entities ?? {};
  for (const id of Object.keys(P)) if (!N[id]) things.push({ id, what: "gone" });
  for (const id of Object.keys(N)) diffThing(id, P[id], N[id], things);
  for (const k of new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])) {
    if (NOT_WORLD.has(k)) continue;
    const empty = (v) => v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
    const a = prev?.[k], b = next?.[k];
    // absent (or null) and empty are alike only when both are absent or both empty: {} can mean something (grass {} is the default lawn)
    if (!(empty(a) && empty(b) && (a == null) === (b == null)) && !near(a, b)) {
      world.push(k);
      if (MAPS.has(k)) ids[k] = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((x) => !near(a?.[x], b?.[x]));
    }
  }
  return { things, world, ids };
}
