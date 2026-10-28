// server/livehost.ts — a world as a running server holds it: the authority (shared/protocol/authority.js) over one directory, with
// every view the authority reads kept INCREMENTALLY (research 35, slice-2 #5):
//   state   the strict fold, advanced per appended entry (copy-on-write: only the entities an entry touches are
//           copied, so a held state never changes under its holder, and a write costs the world's touched part, not
//           the log). A purge refolds from the log (purge is retroactive by law, L1).
//   sim     the sim layer as a running folder (simFolder), viewed at the authority's clock. The lab simFolded the whole
//           log on EVERY request (settleSim calls it first).
//   index   id → seqs of the change entries that touch it, so creatorOf / lastTouch cost a thing's own history.
//   clock   monotonic: max(wall clock, every ts already written). §2.1 says ts never decreases; a monotonic authority
//           clock also makes "advance the sim for a read, then fold a later entry" equal to folding it first.
//   presence the authority's presence plane (bodies, holds): memory only, never a file (L6: never logged; the lab kept a
//           file because its CLI ran one process per request).
// The log file is <dir>/world.jsonl (UTF-8 JSONL, §2.4); blobs are <dir>/blobs/sha256-<hex>.json, named by the full
// hash of their JCS bytes, written once, verified on read (§2.2). Each line is appended and fsynced (durable.ts) before
// the request returns: the authority has already re-read it with the strict reader.
import fs from "node:fs";
import path from "node:path";
import { custodyFileIn } from "./keyfiles.ts";
import { readLog, fold, opsOf, applyInPlace, purgesIn, jcs, sha256, Malformed, DIALECT, VERSION } from "../shared/protocol/fold.js";
import { worldOf, posAt } from "../shared/protocol/authority.js";
import { simFolder, carried, digestOf } from "../shared/protocol/simlayer.js";
import { readLogBytes, appendDurable, putBlobFile } from "./durable.ts";
import { custodyAt, modLogAt } from "./custody.ts";
import { directoryFor } from "./directory.ts";
import { SANDBOX } from "../shared/protocol/sandbox.js";

type Any = any; // the authority is JSDoc-typed JS; the server holds it structurally

const isE = (e: Any) => e && !(e instanceof Malformed) && typeof e === "object";
const opsQuiet = (e: Any) => { try { return opsOf(e); } catch { return []; } };

/** Apply one change entry's ops to a COPY of st that shares every entity the entry doesn't touch. */
export function applyShared(st: Any, ops: Any[], seq: number) {
  const entities = Object.create(null);
  for (const id of Object.keys(st.entities)) entities[id] = st.entities[id];
  const copied = new Set<string>();
  for (const o of ops) { const id = o?.id; if (typeof id !== "string" || copied.has(id)) continue; copied.add(id);
    const e = entities[id]; if (e) entities[id] = { born: e.born, c: Object.assign(Object.create(null), e.c) }; }
  return applyInPlace({ ...st, entities, diagnostics: st.diagnostics }, ops, seq);
}

export type LiveOpts = { now?: () => number; /** the speed track's elapsed-time clock (ms); default: performance.now, or `now` when given */ pace?: () => number; catalogue?: Any; simModels?: Any; onAppend?: (seq: number, e: Any) => void;
  /** the authority's governance keys file (§2.4); default <worlds dir>/.custody.json, shared by every world in it */ custodyFile?: string;
  /** id → display name (the authority directory, server/directory.ts); default: that worlds dir's directory */ nameOf?: (id: string) => string | null;
  /** id → account|anon|imported (the directory; the authority reads only "anon"); default: that worlds dir's directory */ kindOf?: (id: string) => string | null;
  /** the script sandbox (default QuickJS, shared/protocol/sandbox.js; null = none) */ scripts?: Any;
  /** who is connected beyond the authority's own bodies: [{id, at}] (server/worldlog.ts, from the World's clients) */ present?: () => { id: string; at: number[] | null }[];
  /** speech is arrival-only (R 10-18): the seq at or below which this asker may not read a say's body; null = no floor (storage.js worldOf) */ sayFloor?: (actor: string) => number | null };

/** An in-place translation's in-progress marker, like git's index.lock (tools/protocol/world.ts translateInPlace; R 10-27). */
export const SWAP_MARKER = "translation.lock";
/** Does `dir` hold an in-place swap that hasn't finished (its bans and identities may not be in yet)? Never served. */
export const isSwapUnfinished = (dir: string): boolean => fs.existsSync(path.join(dir, SWAP_MARKER));
/** What the operator does about an unfinished swap (boot notice, openLive's refusal). */
export const swapRecovery = (name: string, tool = "bun tools/protocol/world.ts") => `its in-place translation was interrupted mid-swap (${SWAP_MARKER} is still in its directory), so its bans and identity mappings may not be in place yet. `
  + `Finish it: ${tool} translate ${name} --no-founder-key (renames and moves only); then, to have the old world back: ${tool} rollback ${name}.`;

/** Open (or prepare to found) the world stored in `dir`. */
export function openLive(dir: string, name: string, opts: LiveOpts = {}) {
  if (isSwapUnfinished(dir)) throw new Error(`"${name}" can't be served: ${swapRecovery(name)}`);
  const logPath = path.join(dir, "world.jsonl");
  const blobDir = path.join(dir, "blobs");
  const entries: Any[] = readLog(readLogBytes(logPath)).map(posAt);
  // governance is RESERVED (§13): this server neither writes nor validates `sequencer` entries, and one may have moved the
  // writer role somewhere it can't check, so it refuses to serve the world rather than fold past the entry and write on
  { const g = entries.findIndex((e) => isE(e) && e.kind === "sequencer");
    if (g >= 0) throw new Error(`"${name}" can't be served: its log holds a governance (sequencer) entry at seq ${g}, and governance is reserved in this server (PROTOCOL §13): it can't check who that entry made the writer, so it won't write after it. Nothing was changed.`); }
  const blobPath = (h: string) => path.join(blobDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const getBlob = (h: string) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(h))) throw new Error(`not a blob name: ${h}`);
    const s = fs.readFileSync(blobPath(h), "utf8");
    if (`sha256:${sha256(s)}` !== h) throw new Error(`blob ${h} doesn't match its name`);
    return JSON.parse(s);
  };
  const putBlob = (v: unknown) => {
    const s = jcs(v); const h = `sha256:${sha256(s)}`;
    putBlobFile(blobPath(h), s, h);
    return h;
  };
  // the clock: never behind anything already written, never backwards
  let lastNow = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastNow = entries[i].ts; break; }
  const wall = opts.now ?? (() => Date.now());
  const now = () => (lastNow = Math.max(lastNow, Math.floor(wall())));
  // the speed track's pace: elapsed time from the monotonic clock. The wall is stepped back by NTP or a VM's host sync (WSL2
  // pulls Burrow's back ~1.4 s every ~30 s), and `now` then holds still until the wall catches up — right for ts, but a body's
  // allowance would refill nothing meanwhile. A host that brings its own clock (a lab pinning time) is paced by it.
  const pace = opts.pace ?? (opts.now ? now : () => performance.now());

  const w: Any = worldOf({
    name, entries, getBlob, putBlob, now, pace, catalogue: opts.catalogue,
    scripts: opts.scripts === undefined ? SANDBOX : opts.scripts, present: opts.present, sayFloor: opts.sayFloor,
    writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {},
    custody: custodyAt(opts.custodyFile ?? custodyFileIn(path.dirname(dir))),
    nameOf: opts.nameOf ?? directoryFor(path.dirname(dir)).nameOf,
    kindOf: opts.kindOf ?? ((id: string) => directoryFor(path.dirname(dir)).entry(id)?.kind ?? null),
    ...modLogAt(path.join(dir, "world.mod.jsonl")),
  });

  // ---- the views, built once from the log, then advanced per entry ----
  let st = fold(entries);
  const touching = new Map<string, number[]>();
  // the sim starts from the last VALID checkpoint (authority checkpointSim): its blob present and hashing to its name, written
  // right after the entry it says (at = seq - 1), no purge after it (a purge is retroactive: its bytes may sit in the cut), an
  // engine this host carries, and the cut's sim hashing to the digest the entry recorded. Anything else: from genesis, as before.
  const ckpt = (() => {
    let lastPurge = -1; for (let s = entries.length - 1; s >= 0; s--) if (isE(entries[s]) && entries[s].kind === "purge") { lastPurge = s; break; }
    for (let s = entries.length - 1; s > lastPurge; s--) { const e = entries[s]; if (!isE(e) || e.kind !== "sim" || e.verb !== "checkpoint") continue;
      const b = e.body ?? {}; if (b.at !== s - 1 || typeof b.state !== "string") { w.log?.(`checkpoint at ${s} malformed; skipped`); continue; }
      let blob: Any; try { blob = getBlob(b.state); } catch (err) { console.warn(`[world:${name}] checkpoint ${s}: ${(err as Error).message}; skipped`); continue; }
      let cut: Any = null; try { cut = typeof blob?.cutJson === "string" ? JSON.parse(blob.cutJson) : null; } catch { cut = null; }
      if (!cut?.spec || !carried(cut.spec) || !cut.sim || digestOf(cut.sim) !== b.sim) { console.warn(`[world:${name}] checkpoint ${s}: ${!cut ? "no cut in the blob" : !carried(cut.spec) ? `engine ${cut.spec?.engine}@${cut.spec?.build} not carried` : "digest mismatch"}; skipped`); continue; }
      return { seq: s, cut }; }
    return null;
  })();
  // the cut carries the engine and what's lifted/launched, not the fold: the layer's engine view needs the state AT the
  // cut (second review 10-11 S1-1: without it the first edit after a reopen removed the thing from the engine)
  let sim = simFolder(entries, { models: opts.simModels ?? {}, purged: purgesIn(entries), ...(ckpt ? { from: { ...ckpt.cut, st: fold(entries, { until: ckpt.seq }) } } : {}) });
  const index = (seq: number, e: Any) => { if (!isE(e) || e.kind !== "change") return;
    for (const id of new Set(opsQuiet(e).map((o: Any) => o.id))) { let a = touching.get(id as string); if (!a) touching.set(id as string, (a = [])); a.push(seq); } };
  const bad = new Set(st.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed")).map(([q]: Any) => q));
  for (let s = 0; s < entries.length; s++) { index(s, entries[s]); if (st.status === "ok" && isE(entries[s]) && !bad.has(s) && (!ckpt || s > ckpt.seq)) sim.feed(s); }
  w.bootedFrom = ckpt ? ckpt.seq : null;

  // a world that holds scripts starts its sandbox processes now, so its first activation doesn't wait for one
  if (st.status === "ok" && Object.values(st.entities ?? {}).some((e: Any) => Object.keys(e.c).some((k) => k.startsWith("script:")))) w.scripts?.warm?.();
  w.state = () => st;
  w.sim = () => sim.view(w.now()); // the authority's clock: one per request (authority.js request pins it)
  w.simCapTs = (maxTicks: number) => sim.capTs(maxTicks);
  w.simPeek = () => sim.view();   // where the engine stands, without advancing it (checks)
  w.touching = (id: string) => touching.get(id) ?? [];
  const baseAppend = w.append;
  w.append = (e: Any, token: Any) => {
    const seq = baseAppend(e, token); const x = entries[seq];
    if (x.kind === "genesis" || x.kind === "purge") st = fold(entries); // genesis starts the world; a purge is retroactive (L1)
    else if (x.kind === "change") st = applyShared(st, opsOf(x), seq);
    if (x.kind === "purge") for (const e of entries) if (isE(e) && e.kind === "sim" && e.verb === "checkpoint" && typeof e.body?.state === "string") {   // the purged bytes may sit in a cut: gone (§12)
      try { fs.unlinkSync(blobPath(e.body.state)); } catch { /* already gone */ } }
    index(seq, x);
    // a purge is retroactive, so the engine's world is rebuilt from the whole log with it, as a fresh reader would fold it
    // (the sim fold reads a purged physical value as no body); a checkpoint can't stand in, since it may hold the purged bytes
    if (x.kind === "purge") { const bad = new Set(st.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed")).map(([q]: Any) => q));
      sim = simFolder(entries, { models: opts.simModels ?? {}, purged: purgesIn(entries) });
      if (st.status === "ok") for (let s = 0; s < entries.length; s++) if (isE(entries[s]) && !bad.has(s)) sim.feed(s); }
    else if (st.status === "ok") sim.feed(seq);
    opts.onAppend?.(seq, x);
    return seq;
  };
  return w;
}

/** Line 0 of the log at `p`, read (only the first 64 KiB is looked at), or null. */
function genesisAt(p: string): any {
  if (!fs.existsSync(p)) return null;
  try {
    const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(1 << 16); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const [g] = readLog(buf.subarray(0, n).toString("utf8").split("\n")[0]);
    return isE(g) && g.kind === "genesis" ? g : null;
  } catch { return null; }
}
/** Is `dir` a world this server reads? Its log exists and line 0 is a genesis saying {dialect: "eidoverse-log", v: 4}
 *  (§2.4: the protocol's number is stated there and nowhere else). */
export function isWorldDir(dir: string): boolean {
  const g = genesisAt(path.join(dir, "world.jsonl"));
  return !!g && g.body?.dialect === DIALECT && g.body?.v === VERSION;
}
/** A log of this protocol's family (an entry-kind genesis) that this server can't read: saved before the 2026-10-07
 *  names pass (an older file name, or a genesis that stated its number in its own field). Refounded, or re-translated
 *  from its original log; never opened. */
export function isPreNamesDir(dir: string): boolean {
  if (isWorldDir(dir) || !fs.existsSync(dir)) return false;
  try { return fs.readdirSync(dir).some((f) => f.endsWith(".jsonl") && !!genesisAt(path.join(dir, f))); } catch { return false; }
}
