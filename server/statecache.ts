// server/statecache.ts — a DERIVED cache of a world's strict fold beside its log, so a boot folds only the tail (WISHLIST "State
// snapshots", step 1). The log is the truth: on any doubt the caller folds from genesis. Never served; backups, forks, resets and
// rollbacks never carry it (the destination derives its own). The later signed in-log checkpoint (§2) is a different thing.
import fs from "node:fs";
import path from "node:path";
import { PURGED, checkEntry, opsOf, applyInPlace, cloneState, worldIdOf, jcs, sha256, Malformed } from "../shared/protocol/fold.js";
import { replaceDurable } from "./durable.ts";
import { VIEW_FILES } from "./foldviews.ts";

type Any = any;
export const CACHE_FILE = "fold.cache.json";
/** Is `f` (a name in a world's directory) the cache or a temp file of one? Rollback and backups skip these. */
export const isCacheFile = (f: string) => f === CACHE_FILE || f.startsWith(`${CACHE_FILE}.`);
const FORMAT = 2;   // this file's encoding (2: the views and byte offsets, server/foldviews.ts); also in the foldKey through these bytes

const isE = (e: Any) => e && !(e instanceof Malformed) && typeof e === "object";
let key: string | Error | null = null;
/** hash(fold.js + its one import + registry-pin.json + this file + every file shaping a view + the runtime): any change and every
 *  cache is refused. Throws (memoised) when a source can't be read: the caller then neither reads nor writes a cache. */
export function foldKey(): string {
  if (key === null) try {
    const files = ["../shared/protocol/fold.js", "../shared/protocol/hash.js", "../spec/registry-pin.json", "./statecache.ts", ...VIEW_FILES]
      .map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8"));
    key = sha256(jcs([FORMAT, process.versions.bun ?? process.version, ...files]));
  } catch (x) { key = new Error(`the fold's sources can't be read for its key (${(x as Error).message})`); }
  if (key instanceof Error) throw key;
  return key;
}

/** The fold as JSON: a purged value is {purged: true}, a value {v} (canonicalView's shape, plus born and the diagnostics). */
export function encodeState(st: Any) {
  const entities: Any = {};
  for (const id of Object.keys(st.entities)) { const e = st.entities[id], c: Any = {};
    for (const k of Object.keys(e.c)) c[k] = e.c[k] === PURGED ? { purged: true } : { v: e.c[k] };
    entities[id] = { born: e.born, c }; }
  return { status: st.status, v: st.v, worldId: st.worldId, diagnostics: st.diagnostics, entities };
}
function decodeState(o: Any) {
  const entities = Object.create(null);
  for (const id of Object.keys(o.entities)) { const e = o.entities[id], c = Object.create(null);
    for (const k of Object.keys(e.c)) { const x = e.c[k]; if (x?.purged === true) c[k] = PURGED; else if (x && "v" in x) c[k] = x.v; else throw new Error(`entity ${id}.${k} is neither a value nor purged`); }
    entities[id] = { born: e.born, c }; }
  return { status: o.status, v: o.v, worldId: o.worldId, entities, diagnostics: o.diagnostics };
}
export const stateDigest = (encoded: Any) => sha256(jcs(encoded));

/** Only a fold every line of which the strict reader took is cached: then its tail resumes exactly as the whole fold reads it. */
const clean = (st: Any) => st?.status === "ok" && !st.diagnostics.some(([, c]: Any) => String(c).startsWith("malformed") || c === "world-mismatch");

/** Where the covered line sits in the file: genesis ends at byte g; line coversIndex is [start, end) with its newline. */
export type At = { g: number; start: number; end: number };
/** Write the cache for `st`, the fold of entries[0..at] (default: all of them). False (nothing written) when it can't stand in for one.
 *  `views` + `bytes` (server/foldviews.ts captureViews, at the head only): a boot then reads only genesis and the tail. */
export function writeCache(dir: string, entries: Any[], st: Any, at = entries.length - 1, extra: { views: Any; bytes: At } | null = null): boolean {
  const e = entries[at];
  if (at < 1 || !clean(st) || !isE(e) || typeof e.head !== "string") return false;   // an unsigned log has no head to check at boot
  const body = { format: FORMAT, foldKey: foldKey(), coversIndex: at, coversHead: e.head, ...(extra && extra.views.n === at + 1 ? { at: extra.bytes, views: extra.views } : {}), state: encodeState(st) };
  replaceDurable(path.join(dir, CACHE_FILE), JSON.stringify(body));
  return true;
}
export function dropCache(dir: string) { try { fs.unlinkSync(path.join(dir, CACHE_FILE)); } catch { /* none */ } }

export type Hit = { base: Any; coversIndex: number; coversHead: string; digest: string; views: Any | null; at: At | null; viewsDigest: string | null };
/** The cache file, if its format and foldKey are current (the line checks are checkCache's). */
export function readCacheFile(dir: string, why: (s: string) => void): Any | null {
  const p = path.join(dir, CACHE_FILE);
  let text: string; try { text = fs.readFileSync(p, "utf8"); } catch { return null; }
  let c: Any; try { c = JSON.parse(text); } catch { why("it doesn't parse"); return null; }
  let k: string; try { k = foldKey(); } catch (x) { why((x as Error).message); return null; }
  if (c?.format !== FORMAT || c.foldKey !== k) { why("it was written by another fold, registry or runtime"); return null; }
  return c;
}
/** The cached fold, if it is this log's: format and foldKey current, the same world, and the head at coversIndex the one it
 *  covered. Null with `why` said when a cache was there and refused; null quietly when there is none. */
export function readCache(dir: string, entries: Any[], why: (s: string) => void): Hit | null {
  const c = readCacheFile(dir, why); return c ? checkCache(c, entries, why) : null;
}
export function checkCache(c: Any, entries: Any[], why: (s: string) => void): Hit | null {
  const at = c.coversIndex;
  if (!Number.isInteger(at) || at < 1 || at >= entries.length) { why(`it covers line ${at}, and the log has ${entries.length}`); return null; }
  if (!isE(entries[at]) || entries[at].head !== c.coversHead) { why(`line ${at} isn't the line it covered (another head)`); return null; }
  if (!isE(entries[0]) || c.state?.worldId !== worldIdOf(entries[0])) { why("it is another world's"); return null; }
  try { return { base: decodeState(c.state), coversIndex: at, coversHead: c.coversHead, digest: stateDigest(c.state), views: c.views ?? null, at: c.at ?? null, viewsDigest: c.views ? stateDigest(c.views) : null }; }
  catch (x) { why(`its state doesn't read: ${(x as Error).message}`); return null; }
}

/** Fold entries after the cache onto its state (mutated), as fold() would; `snapAt`: also a copy of the state at that seq.
 *  Null (with `why`) on anything the whole fold must read: a malformed line, a genesis, a purge (retroactive, L1), a governance
 *  entry, another world's line, a ts that goes back, a value stripped to its commit. */
export function resumeFold(hit: Hit, entries: Any[], why: (s: string) => void, snapAt?: number) {
  const st = hit.base; let lastTs = entries[hit.coversIndex].ts, snap: Any = snapAt === hit.coversIndex ? cloneState(st) : null;   // clean log: the covered line's ts is the fold's last
  for (let s = hit.coversIndex + 1; s < entries.length; s++) {
    const e = entries[s];
    if (!isE(e)) { why(`line ${s} is malformed`); return null; }
    try { checkEntry(e, s); } catch { why(`line ${s} is malformed`); return null; }
    if (!["change", "act", "sim", "say"].includes(e.kind)) { why(`line ${s} is a ${e.kind}`); return null; }
    if (e.world !== st.worldId || !Number.isInteger(e.ts) || e.ts < lastTs) { why(`line ${s} is another world's or goes back in time`); return null; }
    lastTs = e.ts;
    if (e.kind === "change") try { applyInPlace(st, opsOf(e), s); } catch { why(`line ${s} needs the whole log's purges`); return null; }
    if (s === snapAt) snap = cloneState(st);
  }
  return { st, snap };
}
