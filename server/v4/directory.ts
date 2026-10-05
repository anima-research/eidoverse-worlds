// server/v4/directory.ts — who an identity is (PROTOCOL-v4 §2.3: "the mapping from an identity to a person lives
// outside the log, so purging a person never needs the skeleton"). Round-2 review R1/R2, 2026-10-05.
//
// Every actor a v4 log names is an OPAQUE id, `u-` + 20 base32 characters, minted here. Nothing about the person is in
// the log: their display name, the account(s) that prove them, and anything else about them live in this file, which
// is never logged and is written 0600. So:
//   - a role is held by an id, and an id is reached only through its account (a `sub`): typing someone's display name
//     gets you nothing (R2). Two people who share a name are two ids; one person renamed is still one id.
//   - forgetting a person is deleting their entry here: the log keeps an id that no longer means anyone (R1).
// Accounts (`sub`): "human:discord:<id>" from a verified session, "agent:<slug>" for a token-verified agent. A
// connection with no account gets a FRESH id per connection (kind "anon"): it can act as the world's default role
// allows, and can never be anyone else. One directory per door (all the worlds in a worlds dir), like custody.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Entry = { name: string; subs: string[]; kind: "human" | "agent" | "anon" | "legacy"; since: number };
type File = { v: 1; ids: Record<string, Entry> };

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const mintId = () => "u-" + Array.from(crypto.randomBytes(20), (b) => B32[b & 31]).join("");
export const isMinted = (s: string) => /^u-[a-z2-7]{20}$/.test(s);

export function directoryAt(file: string, now: () => number = Date.now) {
  const d: File = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { v: 1, ids: {} };
  const bySub = new Map<string, string>();
  for (const [id, e] of Object.entries(d.ids)) for (const s of e.subs) bySub.set(s, id);
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600); };
  const add = (e: Entry) => { let id = mintId(); while (d.ids[id]) id = mintId(); d.ids[id] = e; for (const s of e.subs) bySub.set(s, id); save(); return id; };
  return {
    /** The id for a connection: its account's id (minted on first sight; the display name kept current), or, with no
     *  account, a fresh id that nobody else can ever hold. */
    resolve({ sub, name, agent = false }: { sub?: string | null; name: string; agent?: boolean }): string {
      if (sub) { const id = bySub.get(sub);
        if (id) { if (d.ids[id].name !== name) { d.ids[id].name = name; save(); } return id; }
        return add({ name, subs: [sub], kind: agent ? "agent" : "human", since: now() }); }
      return add({ name, subs: [], kind: "anon", since: now() });
    },
    /** An identity with no account yet (a translated v1 name): holds its roles until an operator binds an account. */
    legacy(name: string): string { return add({ name, subs: [], kind: "legacy", since: now() }); },
    /** Operator: let an account wear an existing id (e.g. a legacy owner proving who they are). */
    bind(id: string, sub: string) { const e = d.ids[id]; if (!e) throw new Error(`no identity ${id}`);
      const prev = bySub.get(sub); if (prev && prev !== id) throw new Error(`${sub} already wears ${prev}`);
      if (!e.subs.includes(sub)) e.subs.push(sub); if (e.kind === "legacy") e.kind = sub.startsWith("agent:") ? "agent" : "human"; bySub.set(sub, id); save(); },
    /** the id an account already wears, if any (read-only: the translator plans before it writes) */
    idOfSub: (sub: string): string | null => bySub.get(sub) ?? null,
    /** add identities planned elsewhere (the translator's, once its log is written); never overwrites one */
    put(entries: Record<string, Entry>) { for (const [id, e] of Object.entries(entries)) { if (d.ids[id]) throw new Error(`identity ${id} exists`);
        for (const s of e.subs) if (bySub.has(s)) throw new Error(`${s} already wears ${bySub.get(s)}`); }
      for (const [id, e] of Object.entries(entries)) { d.ids[id] = e; for (const s of e.subs) bySub.set(s, id); } save(); },
    nameOf: (id: string): string | null => d.ids[id]?.name ?? null,
    entry: (id: string): Entry | null => d.ids[id] ?? null,
    /** id → display name for the ids given (what a client is sent; never subs). */
    names(ids: Iterable<string>): Record<string, string> { const o: Record<string, string> = {};
      for (const id of ids) { const n = d.ids[id]?.name; if (n) o[id] = n; } return o; },
  };
}
export type Directory = ReturnType<typeof directoryAt>;

const cache = new Map<string, Directory>();
/** The one directory for a worlds dir (shared by every world in it, and by the translator writing into it). */
export function directoryFor(worldsDir: string): Directory {
  const f = path.join(path.resolve(worldsDir), ".v4-directory.json");
  let d = cache.get(f); if (!d) cache.set(f, (d = directoryAt(f))); return d;
}
