// server/worldindex.ts — what each name under WORLDS_DIR is, held outside the worlds' bytes (§F F-3, no existence oracle;
// Mica 11-05: "toldOf should decide visibility before touching world bytes"). access.ts toldOf and doorFor ask lookup(),
// and lookup() makes the same calls for every name, missing or not: one stat of WORLDS_DIR, the same five stats under the
// name, one map read. It opens no world. An entry is read from a world's bytes only when those stats change: at boot
// (warmIndex), or after someone changes the directory (an operator's act, a translation), never because of who asks.
// An old-format world's entry carries its owners (world.ts owners-of, read with the entry), so "is this asker its owner?"
// (ownerIn: server/ownerrecognise.ts, the rule the translation's --claim applies too) is answered from memory: no request
// reads the old log or runs the CLI.
import fs from "node:fs";
import path from "node:path";
import { WORLDS_DIR, ROOT, OPT_DIR, BACKUPS_DIR } from "./config.ts";
import { isWorldDir, isSwapUnfinished } from "./livehost.ts";
import { oldWorldAt, type OldWorld } from "./oldworlds.ts";
import { modLogAt } from "./custody.ts";
import { readLogBytes } from "./durable.ts";
import { directoryFor } from "./directory.ts";
import { recogniseOwner, type OldOwner, type Recognised } from "./ownerrecognise.ts";
import { opsOf } from "../shared/protocol/fold.js";
import { runOneShot } from "./oneshot.ts";

/** Tests only: EIDO_TEST_ACCESS_TRACE=<file> appends each index lookup, entry read, owner check and world load as a JSON line
 *  (access-check F23-O10/O11 read it; "refresh" is the background sweep's read, which no asker causes). Unset, nothing is written. */
const TRACE = process.env.EIDO_TEST_ACCESS_TRACE ?? "";
export function accessTrace(ev: "lookup" | "read" | "refresh" | "owners" | "load", name: string) {
  if (TRACE) try { fs.appendFileSync(TRACE, JSON.stringify({ ev, name }) + "\n"); } catch { /* the test's own file */ }
}

export type DoorRead = { wc: Record<string, any>; mod: any[] };
export type Owners = OldOwner[];
export type IndexEntry = { kind: "none" } | { kind: "interrupted" } | { kind: "saved"; door: DoorRead | null }
  | { kind: "old"; old: OldWorld; owners: Owners | null; ready: Promise<void> | null };
const NONE: IndexEntry = { kind: "none" };
const NAME = /^[a-z0-9_-]{1,64}$/i;
const PROBES = ["", "world.jsonl", "world.mod.jsonl", "log.jsonl", "translation.lock"];
const held = new Map<string, { key: string; e: IndexEntry }>();
let listing = new Set<string>(), listKey = "", listedAt = 0;
const pending = new Set<Promise<unknown>>();

const statKey = (p: string): string => { try { const s = fs.lstatSync(p); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return "-"; } };
// the directory's names, exactly as spelled (a name's own case only, as the join door): re-listed when WORLDS_DIR changes,
// and every 2 s whatever is asked
function relist(now: number) {
  const k = statKey(WORLDS_DIR);
  if (k === listKey && now - listedAt < 2000) return;
  try { listing = new Set(fs.readdirSync(WORLDS_DIR)); } catch { listing = new Set(); }
  listKey = k; listedAt = now;
}

/** What `name` is. `loaded`: the server holds it (its door is its live fold's), so its entry isn't re-read as its log grows. */
export function lookup(name: string, { loaded = false } = {}): IndexEntry {
  accessTrace("lookup", name);
  return entry(name, loaded);
}
function entry(name: string, loaded: boolean, sweeping = false): IndexEntry {
  if (!NAME.test(name)) return NONE;
  relist(Date.now());
  const d = path.join(WORLDS_DIR, name), key = PROBES.map((p) => statKey(path.join(d, p))).join("|");
  if (!listing.has(name)) return NONE;
  const h = held.get(name);
  if (h && (h.key === key || loaded)) return h.e;
  if (loaded) return { kind: "saved", door: null };   // a loaded world is never read here: access.ts asks its live fold
  const e = read(name, sweeping); held.set(name, { key, e }); return e;
}

/** Is this proven asker the old world's owner? Read off the entry lookup() returned (null for any other kind, or owners not
 *  read): no log read, no CLI. */
export function ownerIn(e: IndexEntry, proven: { account: string; name: string } | null): Recognised | null {
  if (e.kind !== "old" || !e.owners || !proven) return null;
  return recogniseOwner(e.owners, proven.account, proven.name || null, (n) => directoryFor(WORLDS_DIR).accountsNamed(n));
}

/** Read every world in WORLDS_DIR into the index, owners included (the server awaits it before it listens); then, every
 *  2 s, re-read in the background whatever changed, so an asker rarely meets a change first (a lookup that does still reads
 *  it then: a world made a moment ago is joinable at once). */
export async function warmIndex(isLoaded: (name: string) => boolean = () => false) {
  const sweep = () => { relist(Date.now()); for (const name of listing) entry(name, isLoaded(name), true); };
  sweep(); await Promise.all([...pending]);
  setInterval(sweep, 2000).unref?.();
}

// ---- reading an entry (only when its stats changed) ------------------------------------------------------------------
function read(name: string, sweeping: boolean): IndexEntry {
  accessTrace(sweeping ? "refresh" : "read", name);
  const d = path.join(WORLDS_DIR, name);
  if (isSwapUnfinished(d)) return { kind: "interrupted" };   // an in-place translation stopped mid-swap
  if (isWorldDir(d)) return { kind: "saved", door: readDoor(d) };
  const old = oldWorldAt(WORLDS_DIR, name);
  if (!old) return NONE;   // an empty directory is no world
  const e = { kind: "old" as const, old, owners: null as Owners | null, ready: null as Promise<void> | null };
  if (old.kind === "translatable") {
    const p: Promise<void> = ownersOf(name).then((o) => { e.owners = o; }).finally(() => { pending.delete(p); e.ready = null; });
    pending.add(p); e.ready = p;
  }
  return e;
}

// A saved world's door: the change entries in world.jsonl that touch @world's access, default-role, role-defs and roles:*,
// folded set/delete in order (only those keys: nothing else about the world is read), and its moderator log
// (world.mod.jsonl, never in the world log): a ban or kick there closes the door before the world is loaded, as after
// (Antra's review of f91840e5 P1). An unreadable moderator log is no door (as an unreadable world log), never a door that
// forgets its bans.
const DOOR_LINE = /"id"\s*:\s*"@world"/;
const isDoorComp = (k: unknown) => typeof k === "string" && (k === "access" || k === "default-role" || k === "role-defs" || k.startsWith("roles:"));   // role-defs: a custom role's powers (the moderation bypass)
function readDoor(d: string): DoorRead | null {
  let mod: any[]; try { mod = modLogAt(path.join(d, "world.mod.jsonl")).mod; } catch { return null; }
  const wc: Record<string, any> = {};
  try {
    for (const line of readLogBytes(path.join(d, "world.jsonl"), { cut: false }).toString("utf8").split("\n")) {   // a torn last line is not the log's yet (#260 bot 7)
      if (!line || !DOOR_LINE.test(line)) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e?.kind !== "change") continue;
      let ops: any[] = []; try { ops = opsOf(e); } catch { continue; }   // a batch's ops, or a single set/delete's own body
      for (const o of ops) {
        if (o?.id !== "@world" || !isDoorComp(o.comp)) continue;
        if (o.op === "set" && o.value && typeof o.value === "object") wc[o.comp] = o.value;
        else if (o.op === "delete") delete wc[o.comp];
      }
    }
  } catch { return null; }
  return { wc, mod };
}

// An old world's owners: tools/protocol/world.ts owners-of, once per change of the world (the translator stays out of the server
// process), one-shot and framed (server/oneshot.ts): an answer it doesn't accept reads as no owners known.
async function ownersOf(name: string): Promise<Owners | null> {
  accessTrace("owners", name);
  try {
    const r = await runOneShot([process.execPath, path.join(ROOT, "tools", "protocol", "world.ts"), "owners-of", "--", name],
      { cwd: ROOT, env: { ...process.env, WORLDS_DIR, BACKUPS_DIR, OPT_DIR }, guardMs: 120_000, label: `owners-of ${name}` });
    if (!r.accepted || r.code !== 0) return null;
    const l = r.out.split("\n").find((x) => x.startsWith("owners-json "));
    const o = l ? JSON.parse(l.slice("owners-json ".length)) : null;
    return Array.isArray(o) ? o.map((x: any) => ({ name: String(x?.name ?? ""), account: typeof x?.account === "string" ? x.account : null, unbound: String(x?.unbound ?? ""),
      mainSubs: Array.isArray(x?.mainSubs) ? x.mainSubs.map(String) : [] })) : null;
  } catch { return null; }
}
