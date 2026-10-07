// server/directory.ts — who an identity is (PROTOCOL-v4 §2.3: "the mapping from an identity to a person lives
// outside the log, so purging a person never needs the skeleton"). Round-2 review R1/R2 (10-05); security review
// 10-06 (M2, M6, H4).
//
// Every actor a v4 log names is an OPAQUE id, `u-` + 20 base32 characters, minted here. Nothing about the person is in
// the log: their display name, the account(s) that prove them, and anything else about them live in this file, which
// is never logged and is written 0600. So:
//   - a role is held by an id, and an id is reached only through its account (a `sub`): typing someone's display name
//     gets you nothing. Two people who share a name are two ids; one person renamed is still one id.
//   - forgetting a person is deleting their entries here: the log keeps ids that no longer mean anyone.
//   - one id per account per server, the same in every world (R 10-06 14:05: friends, messages and "ask to be invited",
//     as VRChat does, need a person who stays the same person between worlds; per-world ids — review M6 — were
//     tried and withdrawn). A world's slice of this file (exportSlice) travels with the world to another server.
// Accounts (`sub`): "human:<provider>:<id>" from a verified session, "agent:token:<name>" for an operator-enrolled agent,
// "aid1:<iss>:<sub>" for a home-node-verified agent, "local:<name>" only on a private TRUST_NAMES server. A connection
// with no account is ANONYMOUS: a fresh id per connection, held in memory only (never written: M2), kind "anon".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readLog, worldIdOf } from "../shared/protocol/fold.js";

export type Entry = { name: string; subs: string[]; kind: "human" | "agent" | "anon" | "imported"; since: number; world?: string };
type File = { v: 1 | 2; ids: Record<string, Entry> };

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const mintId = () => "u-" + Array.from(crypto.randomBytes(20), (b) => B32[b & 31]).join("");
export const isMinted = (s: string) => /^u-[a-z2-7]{20}$/.test(s);
const kindOfSub = (sub: string) => (sub.startsWith("agent:") || sub.startsWith("aid1:") ? "agent" : "human");

/** `existingWorlds`: the world ids already in this server, read only on the one-time v1 → v2 upgrade (they keep their
 *  server-wide ids). */
export function directoryAt(file: string, now: () => number = Date.now, existingWorlds: () => string[] = () => []) {
  const read = (): File => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { v: 2, ids: {} });
  const d: File = read();
  if (d.v !== 2) {
    d.v = 2; void existingWorlds;
    // v1 keyed an agent by its display slug (`agent:<name>`); v2 keys an enrolled agent by its enrolment
    // (`agent:token:<id>`), never a slug (C2). The enrolled agents keep their ids through the rename.
    for (const e of Object.values(d.ids)) e.subs = e.subs.map((s) => (/^agent:(?!token:)/.test(s) ? `agent:token:${s.slice(6)}` : s));
  }
  const keyOf = (sub: string, _world?: string | null) => sub;   // server-wide: the same person in every world
  const byKey = new Map<string, string>();
  const index = (id: string, e: Entry) => { for (const s of e.subs) byKey.set(e.world ? `${s}|${e.world}` : s, id); };
  for (const [id, e] of Object.entries(d.ids)) index(id, e);
  const anon = new Map<string, Entry>();   // in memory only: an anonymous id is never written, never outlives the process
  // two writers (the CLI tools and a running server) share this file: re-read and merge before every write, so neither
  // drops the other's entries (M2). Ours win on a clash (the same id can only be minted by one of them).
  const save = () => {
    const disk = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as File) : null;
    if (disk) for (const [id, e] of Object.entries(disk.ids ?? {})) if (!d.ids[id]) { d.ids[id] = e; index(id, e); }
    fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600);
  };
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).v !== 2) save();   // the one-time upgrade lands
  // another writer (the found / translate tools) may have added an account since this process read the file: a MISS on
  // an account re-reads before minting, or the server would hand a translated world's owner a fresh, roleless id
  const refresh = () => { if (!fs.existsSync(file)) return;
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as File;
    for (const [id, e] of Object.entries(disk.ids ?? {})) if (!d.ids[id]) { d.ids[id] = e; index(id, e); } };
  const add = (e: Entry) => { let id = mintId(); while (d.ids[id] || anon.has(id)) id = mintId(); d.ids[id] = e; index(id, e); save(); return id; };
  const get = (id: string) => d.ids[id] ?? anon.get(id) ?? null;
  return {
    /** The id for a connection in a world: its account's id there (minted on first sight; the display name kept
     *  current), or, with no account, a fresh anonymous id held in memory only. `world` is the world's id (its
     *  genesis hash); without it the id is server-wide (tools, tests, legacy worlds). */
    resolve({ sub, name, agent = false, world = null }: { sub?: string | null; name: string; agent?: boolean; world?: string | null }): string {
      if (sub) { let id = byKey.get(keyOf(sub, world)); if (!id) { refresh(); id = byKey.get(keyOf(sub, world)); }
        if (id) { if (d.ids[id].name !== name) { d.ids[id].name = name; save(); } return id; }
        return add({ name, subs: [sub], kind: agent ? "agent" : kindOfSub(sub), since: now() }); }
      let id = mintId(); while (d.ids[id] || anon.has(id)) id = mintId();
      anon.set(id, { name, subs: [], kind: "anon", since: now() });
      return id;
    },
    /** An identity with no account yet (a name from an imported world's log): holds its roles until an operator binds an account. */
    imported(name: string, world: string | null = null): string { return add({ name, subs: [], kind: "imported", since: now(),  }); },
    /** Operator: let an account wear an existing id (e.g. a legacy owner proving who they are) — in that id's world. */
    bind(id: string, sub: string) { const e = d.ids[id]; if (!e) throw new Error(`no identity ${id}`);
      const k = e.world ? `${sub}|${e.world}` : sub;
      const prev = byKey.get(k); if (prev && prev !== id) throw new Error(`${sub} already wears ${prev}${e.world ? " in that world" : ""}`);
      if (!e.subs.includes(sub)) e.subs.push(sub); if (e.kind === "imported") e.kind = kindOfSub(sub); byKey.set(k, id); save(); },
    /** the id an account already wears in a world, if any (read-only: the translator plans before it writes) */
    idOfSub: (sub: string, world: string | null = null): string | null => byKey.get(keyOf(sub, world)) ?? null,
    /** add identities planned elsewhere (the translator's, once its log is written); never overwrites one */
    put(entries: Record<string, Entry>) { for (const [id, e] of Object.entries(entries)) { if (d.ids[id]) throw new Error(`identity ${id} exists`);
        for (const s of e.subs) { const k = e.world ? `${s}|${e.world}` : s; if (byKey.has(k)) throw new Error(`${s} already wears ${byKey.get(k)}`); } }
      for (const [id, e] of Object.entries(entries)) { d.ids[id] = e; index(id, e); } save(); },
    nameOf: (id: string): string | null => get(id)?.name ?? null,
    entry: (id: string): Entry | null => get(id),
    /** the display names an account-holding identity has claimed here (an anonymous joiner may not take one: H1/M3) */
    claimedName(name: string): boolean { const k = foldName(name); for (const e of Object.values(d.ids)) if (e.subs.length && foldName(e.name) === k) return true; return false; },
    /** id → display name for the ids given (what a client is sent; never subs). */
    names(ids: Iterable<string>): Record<string, string> { const o: Record<string, string> = {};
      for (const id of ids) { const n = get(id)?.name; if (n) o[id] = n; } return o; },
    /** this world's slice: the entries a world's log can name, for a move to another server (never in the log). */
    exportSlice(world: string, ids: Iterable<string>): Record<string, Entry> { const o: Record<string, Entry> = {};
      for (const id of ids) { const e = d.ids[id]; if (e && (!e.world || e.world === world)) o[id] = JSON.parse(JSON.stringify(e)); } return o; },
  };
}
export type Directory = ReturnType<typeof directoryAt>;

/** A display name folded for comparison: Unicode-compatibility normalized, case-folded, format characters (zero-width,
 *  bidi controls) and separators removed — so "Ríannon", "riannon", "Ri​annon" are the same claim (M3). */
export function foldName(s: string): string {
  return String(s).normalize("NFKC").toLowerCase().replace(/[\p{Cf}\p{Z}\p{P}\p{S}_]/gu, "");
}

/** The world ids already standing in a worlds dir (each v4 world's genesis hash, read from its log's second line). */
function worldIdsIn(worldsDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(worldsDir)) return out;
  for (const name of fs.readdirSync(worldsDir)) {
    const f = path.join(worldsDir, name, "world.jsonl"); if (!fs.existsSync(f)) continue;
    try { const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(1 << 16); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const nl = buf.subarray(0, n).indexOf(0x0a); const [g] = readLog(buf.subarray(0, nl < 0 ? n : nl + 1));
      const w = g ? worldIdOf(g) : null; if (w) out.push(w); } catch { /* an unreadable log isn't a world */ }
  }
  return out;
}

const cache = new Map<string, Directory>();
/** The one directory for a worlds dir (shared by every world in it, and by the translator writing into it). */
export function directoryFor(worldsDir: string): Directory {
  const f = path.join(path.resolve(worldsDir), ".v4-directory.json");
  let d = cache.get(f); if (!d) cache.set(f, (d = directoryAt(f, Date.now, () => worldIdsIn(path.resolve(worldsDir))))); return d;
}
