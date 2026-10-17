// tools/protocol/idalias.ts — a test client's names for the things it makes (R 10-17 ID HARDENING: a writer never chooses an
// id). A suite written as `create {id: "tbl"}` then `place {on: "tbl"}` keeps its words: the client sends the create's id as
// a placeholder ('$tbl'), keeps the id the authority minted (the reply's ids map), and writes that id wherever a later
// request names "tbl" in a reference position. The wire only ever carries placeholders and minted ids — what a real client
// sends. ids.of(name) reads a name as its id for the suite's own checks.
// @ts-nocheck
const REF_KEYS = new Set(["id", "to", "on", "beside", "hang", "against", "near", "from", "target", "copy", "facing"]);
const REF_LISTS = new Set(["targets", "marks", "ids", "refs"]);
export function idAliases() {
  const map = new Map();
  const sub = (v, key) => {
    if (typeof v === "string") return REF_KEYS.has(key) && map.has(v) ? map.get(v) : v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && REF_LISTS.has(key) ? (map.get(x) ?? x) : sub(x, key)));
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = sub(x, k); return o; }
    return v; };
  const names = new Set();
  const named = (a) => { if (a && typeof a === "object" && typeof a.id === "string" && !a.id.startsWith("$") && /^[a-z0-9][a-z0-9-]*$/.test(a.id) && !/^u-[a-z2-7]{20}$/.test(a.id)) { names.add(a.id); return { ...a, id: `$${a.id}` }; } return a; };
  return {
    /** the request as the wire gets it: a create's chosen id → '$id', every known name → its minted id */
    out(verb, args = {}) {
      // a create's own id names a NEW thing (a name may be reused for a new one): it becomes a placeholder before any
      // known name is replaced, so it never resolves to an older thing that had the same name
      const mark = (o) => { const n = named(o); return n === o ? sub(o, null) : { ...sub({ ...o, id: undefined }, null), id: n.id }; };
      if (verb === "create") return mark(args);
      if (verb === "batch" && Array.isArray(args?.ops)) return { ...sub({ ...args, ops: undefined }, null), ops: args.ops.map((o) => (o?.verb === "create" ? { ...o, args: mark(o.args) } : sub(o, null))) };
      return sub(args, null); },
    /** keep what the reply minted */
    back(reply) { for (const [k, v] of Object.entries(reply?.ids ?? {})) if (k.startsWith("$")) map.set(k.slice(1), v); return reply; },
    of: (name) => map.get(name) ?? name,
    map,
  };
}
