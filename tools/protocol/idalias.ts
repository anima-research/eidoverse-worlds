// tools/protocol/idalias.ts — a test client's names for the things it makes (R 10-17 ID HARDENING: a writer never chooses an
// id). A suite written as `create {id: "tbl"}` then `place {on: "tbl"}` keeps its words: the client sends the create's id as
// a placeholder ('$tbl'), keeps the id the authority minted (the reply's ids map), and writes that id wherever a later
// request names "tbl" in a reference position. The wire only ever carries placeholders and minted ids — what a real client
// sends. ids.of(name) reads a name as its id for the suite's own checks.
// @ts-nocheck
// self-contained (no outer names): pageIds() ships this very function to a browser page as source
export function idAliases() {
  const REF_KEYS = new Set(["id", "to", "on", "beside", "hang", "against", "near", "from", "target", "copy", "facing", "attach"]);
  const REF_LISTS = new Set(["targets", "marks", "ids", "refs"]);
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

/** The same names, inside a browser page (the headless probes): source to evaluate once in the page, after which every
 *  request any page code sends (net.js sendRequest, editwrites.send, a raw socket) goes out with its create ids as
 *  placeholders and its names as minted ids, every reply's ids map is kept before the reply is handled, and
 *  globalThis.__id(name) reads a name as its id for the probe's own page code. Installed once per page (a second
 *  evaluation is a no-op); sockets opened before or after the install are both covered. */
export function pageIds(): string {
  return `(() => { if (globalThis.__eidoIds) return true;
  const IDS = (${idAliases.toString()})(); globalThis.__eidoIds = IDS; globalThis.__id = (n) => IDS.of(n);
  const back = (ev) => { try { const m = JSON.parse(ev.data); if (m && m.type === 'reply') IDS.back(m.reply); } catch {} };
  const wrap = (fn) => (fn && !fn.__ids ? Object.assign(function (ev) { back(ev); return fn.call(this, ev); }, { __ids: true }) : fn);
  const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, enumerable: d.enumerable, get() { return d.get.call(this); }, set(fn) { d.set.call(this, wrap(fn)); } });
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const h = d.get.call(this); if (h && !h.__ids) d.set.call(this, wrap(h));
    if (typeof data === 'string') { try { const m = JSON.parse(data); if (m && m.type === 'request') data = JSON.stringify({ ...m, args: IDS.out(m.verb, m.args ?? {}) }); } catch {} }
    return send.call(this, data); };
  return true; })()`;
}

/** A probe's page code, ready for the page: the install (pageIds, idempotent) runs first, then the expression, in which
 *  each quoted scene name ('tbl', "cup") is read as its id — the node side's id where the probe's own node client made
 *  it (`node`: an idAliases map), else __id('<name>') in the page (a thing the page itself made). `names` lists the
 *  scene's names; anything else quoted is left alone. */
export function inPage(expr: string, names: string[], node?: Map<string, string>): string {
  const alt = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[-]/g, "\\-")).join("|");
  const body = alt ? expr.replace(new RegExp(`(['"])(${alt})\\1`, "g"), (m, q, n) => (node?.has(n) ? `${q}${node.get(n)}${q}` : `__id(${q}${n}${q})`)) : expr;
  return `(${pageIds()}, (${body}))`;
}

/** A probe's evalJson, page-side names included: every expression goes through inPage, and every answer brings back the
 *  page's name → id map, merged into `node` — so node-side checks read a page-made thing's id as N(name) right after the
 *  page made it. Returns the wrapped evalJson; its `.ids` is `node`. */
export function pagedEval(raw: (expr: string) => Promise<any>, names: string[], node: Map<string, string> = new Map()) {
  const f: any = async (expr: string) => {
    const r = await raw(`Promise.resolve(${inPage(expr, names, node)}).then((v) => ({ v, ids: [...globalThis.__eidoIds.map] }))`);
    for (const [k, x] of r?.ids ?? []) node.set(k, x);
    return r?.v; };
  f.ids = node; return f;
}
