// server/v4/live.ts — a v4 world as a running server holds it: the door (shared/v4/door.js) over one directory, with
// every view the door reads kept INCREMENTALLY (research 35, slice-2 #5):
//   state   the strict fold, advanced per appended entry (copy-on-write: only the entities an entry touches are
//           copied, so a held state never changes under its holder, and a write costs the world's touched part, not
//           the log). A purge refolds from the log (purge is retroactive by law, L1).
//   sim     the sim layer as a running folder (simFolder), viewed at the door's clock. The lab simFolded the whole
//           log on EVERY request (settleSim calls it first).
//   index   id → seqs of the state entries that touch it, so creatorOf / lastTouch cost a thing's own history.
//   clock   monotonic: max(wall clock, every ts already written). §2.1 says ts never decreases; a monotonic door
//           clock also makes "advance the sim for a read, then fold a later entry" equal to folding it first.
//   presence the door's presence plane (bodies, holds): memory only, never a file (L6: never logged; the lab kept a
//           file because its CLI ran one process per request).
// The log file is <dir>/v4.jsonl (UTF-8 JSONL, §2.4); blobs are <dir>/v4-blobs/sha256-<hex>.json, named by the full
// hash of their JCS bytes, written once, verified on read (§2.2). Each line is appended with appendFileSync before
// the request returns: the door has already re-read it with the strict reader.
import fs from "node:fs";
import path from "node:path";
import { readLog, fold, opsOf, applyInPlace, jcs, sha256, Malformed } from "../../shared/v4/fold.js";
import { worldOf, posAt } from "../../shared/v4/door.js";
import { simFolder } from "../../shared/v4/simlayer.js";
import { custodyAt, modLogAt } from "./custody.ts";
import { directoryFor } from "./directory.ts";

type Any = any; // the door is JSDoc-typed JS; the server holds it structurally

const isE = (e: Any) => e && !(e instanceof Malformed) && typeof e === "object";
const opsQuiet = (e: Any) => { try { return opsOf(e); } catch { return []; } };

/** Apply one state entry's ops to a COPY of st that shares every entity the entry doesn't touch. */
export function applyShared(st: Any, ops: Any[], seq: number) {
  const entities = Object.create(null);
  for (const id of Object.keys(st.entities)) entities[id] = st.entities[id];
  const copied = new Set<string>();
  for (const o of ops) { const id = o?.id; if (typeof id !== "string" || copied.has(id)) continue; copied.add(id);
    const e = entities[id]; if (e) entities[id] = { born: e.born, c: Object.assign(Object.create(null), e.c) }; }
  return applyInPlace({ ...st, entities, diagnostics: st.diagnostics }, ops, seq);
}

export type LiveOpts = { now?: () => number; catalogue?: Any; simModels?: Any; onAppend?: (seq: number, e: Any) => void;
  /** the door's governance keys file (§2.4); default <worlds dir>/.v4-custody.json, shared by every world in it */ custodyFile?: string;
  /** id → display name (the door directory, server/v4/directory.ts); default: that worlds dir's directory */ nameOf?: (id: string) => string | null;
  /** id → human|agent|anon|legacy (the directory); default: that worlds dir's directory */ kindOf?: (id: string) => string | null };

/** Open (or prepare to found) the v4 world stored in `dir`. */
export function openLive(dir: string, name: string, opts: LiveOpts = {}) {
  const logPath = path.join(dir, "v4.jsonl");
  const blobDir = path.join(dir, "v4-blobs");
  const entries: Any[] = (fs.existsSync(logPath) ? readLog(fs.readFileSync(logPath)) : []).map(posAt);
  const blobPath = (h: string) => path.join(blobDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const getBlob = (h: string) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(h))) throw new Error(`not a blob name: ${h}`);
    const s = fs.readFileSync(blobPath(h), "utf8");
    if (`sha256:${sha256(s)}` !== h) throw new Error(`blob ${h} doesn't match its name`);
    return JSON.parse(s);
  };
  const putBlob = (v: unknown) => {
    const s = jcs(v); const h = `sha256:${sha256(s)}`;
    if (!fs.existsSync(blobPath(h))) { fs.mkdirSync(blobDir, { recursive: true }); fs.writeFileSync(blobPath(h), s); }
    return h;
  };
  // the clock: never behind anything already written, never backwards
  let lastNow = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastNow = entries[i].ts; break; }
  const wall = opts.now ?? (() => Date.now());
  const now = () => (lastNow = Math.max(lastNow, Math.floor(wall())));

  const w: Any = worldOf({
    name, entries, getBlob, putBlob, now, catalogue: opts.catalogue,
    writeLine: (line: string) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(logPath, line + "\n"); },
    presence: { bodies: {}, holds: {} }, savePresence: () => {},
    custody: custodyAt(opts.custodyFile ?? path.join(path.dirname(dir), ".v4-custody.json")),
    nameOf: opts.nameOf ?? directoryFor(path.dirname(dir)).nameOf,
    kindOf: opts.kindOf ?? ((id: string) => directoryFor(path.dirname(dir)).entry(id)?.kind ?? null),
    ...modLogAt(path.join(dir, "v4.mod.jsonl")),
  });

  // ---- the views, built once from the log, then advanced per entry ----
  let st = fold(entries);
  const touching = new Map<string, number[]>();
  const sim = simFolder(entries, { models: opts.simModels ?? {} });
  const index = (seq: number, e: Any) => { if (!isE(e) || e.kind !== "state") return;
    for (const id of new Set(opsQuiet(e).map((o: Any) => o.id))) { let a = touching.get(id as string); if (!a) touching.set(id as string, (a = [])); a.push(seq); } };
  const bad = new Set(st.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed")).map(([q]: Any) => q));
  for (let s = 0; s < entries.length; s++) { index(s, entries[s]); if (st.status === "ok" && isE(entries[s]) && !bad.has(s)) sim.feed(s); }

  w.state = () => st;
  w.sim = () => sim.view(now());
  w.touching = (id: string) => touching.get(id) ?? [];
  const baseAppend = w.append;
  w.append = (e: Any, token: Any) => {
    const seq = baseAppend(e, token); const x = entries[seq];
    if (x.kind === "genesis" || x.kind === "purge") st = fold(entries); // genesis starts the world; a purge is retroactive (L1)
    else if (x.kind === "state") st = applyShared(st, opsOf(x), seq);
    index(seq, x);
    if (st.status === "ok") sim.feed(seq);
    opts.onAppend?.(seq, x);
    return seq;
  };
  return w;
}

/** Is `dir` a v4 world? Its log exists and line 0 is a v4 genesis (§2.4: the fold version is stated there). */
export function isV4Dir(dir: string): boolean {
  const p = path.join(dir, "v4.jsonl");
  if (!fs.existsSync(p)) return false;
  try {
    const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(1 << 16); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
    const [g] = readLog(first);
    return isE(g) && g.kind === "genesis" && g.body?.version === 4;
  } catch { return false; }
}
