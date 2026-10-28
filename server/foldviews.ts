// server/foldviews.ts — the authority's log views, carried in the fold cache at its covered line so a boot never reads the prefix
// (R 10-28 parity with main's seek). Only for a log with no purge and only no-op diagnostics; the re-derive rebuilds them from genesis.
import { fold, opsOf, Malformed, cloneState } from "../shared/protocol/fold.js";
import { worldOf } from "../shared/protocol/authority.js";
import { actIndexOf, seedActIndex } from "../shared/protocol/authority/undo.js";
import { guestScan } from "../shared/protocol/authority/capacity.js";
import { ckptScanOf, orphanScan, shapesOf } from "../shared/protocol/authority/scriptrun.js";
import { seedPurgedSeqs } from "../shared/protocol/authority/storage.js";
import { simFolder } from "../shared/protocol/simlayer.js";

type Any = any;
const isE = (e: Any) => e && !(e instanceof Malformed) && typeof e === "object";
const opsQuiet = (e: Any) => { try { return opsOf(e); } catch { return []; } };
/** Every file whose code shapes a view (statecache.ts foldKey hashes them: a change to any refuses every cache). */
export const VIEW_FILES = ["./foldviews.ts", "./livehost.ts", "../shared/protocol/authority/undo.js", "../shared/protocol/authority/capacity.js",
  "../shared/protocol/authority/scriptrun.js", "../shared/protocol/authority/storage.js", "../shared/protocol/authority/rights.js",
  "../shared/protocol/shaperepair.js", "../shared/protocol/simlayer.js"];

/** The host's own views (livehost.ts): id → the change seqs touching it, actors in first-seen order, say seqs, sim checkpoint
 *  seqs, the last change seq, and how many purge / governance entries the log holds. */
export function logIndex() {
  const X = { touching: new Map<string, number[]>(), actors: new Set<string>(), says: [] as number[], ckpts: [] as number[], lastChange: -1, purges: 0, n: 0,
    add(seq: number, e: Any) { X.n = seq + 1; if (e && typeof e.actor === "string") X.actors.add(e.actor);
      if (!isE(e)) return;
      if (e.kind === "say") X.says.push(seq);
      else if (e.kind === "purge") X.purges++;
      else if (e.kind === "sim" && e.verb === "checkpoint") X.ckpts.push(seq);
      else if (e.kind === "change") { X.lastChange = seq;
        for (const id of new Set(opsQuiet(e).map((o: Any) => o.id))) { let a = X.touching.get(id as string); if (!a) X.touching.set(id as string, (a = [])); a.push(seq); } } } };
  return X;
}
export type LogIndex = ReturnType<typeof logIndex>;

const delta = (a: number[]) => a.map((v, i) => (i ? v - a[i - 1] : v));
const undelta = (d: number[]) => { const a = new Array(d.length); let s = 0; for (let i = 0; i < d.length; i++) a[i] = s += d[i]; return a; };
const mapOut = (m: Map<Any, number[]>) => [...m].map(([k, a]) => [k, delta(a)]);
const mapIn = (x: Any[]) => new Map(x.map(([k, d]: Any) => [k, undelta(d)]));

/** May this log's views be carried? No purge (a later one changes what an earlier body reads back), no diagnostic but a no-op's
 *  (no malformed line, stripped value or other world's line), folded ok. */
export const viewsCarried = (st: Any, X: LogIndex) => st?.status === "ok" && X.purges === 0 && (st.diagnostics ?? []).every(([, c]: Any) => String(c).startsWith("noop:"));

/** The views at the log's head, as JSON (the scans are advanced to the head first; the guests' scan on a copy, since its kinds
 *  are read at its first real use). `sf`: the live sim folder's view, carried only when it holds no engine (a fold of the log). */
export function captureViews(w: Any, X: LogIndex, sf: Any) {
  const n = w.entries.length, x = actIndexOf(w), G0 = w.__guests;
  const G = guestScan(w, G0 ? { n: G0.n, made: new Map(G0.made), pending: new Map(), ids: new Map() } : { n: 0, made: new Map(), pending: new Map(), ids: new Map() });
  const k = ckptScanOf(w); shapesOf(w); const o = orphanScan(w, (w.__orphans ??= { n: 0, lifted: new Map(), parentOf: new Map() }));
  const simOk = sf && !sf.sim && sf.spec === null && !sf.foreign && !sf.lifted?.size && !Object.keys(sf.launched ?? {}).length && !sf.unknownEpoch && !sf.unknownHold;
  return { n, touch: mapOut(X.touching), actors: [...X.actors], says: delta(X.says), ckpts: X.ckpts, lastChange: X.lastChange,
    act: { actsOf: mapOut(x.actsOf), resultOf: [...x.resultOf].flat(), undone: [...x.undone], changes: delta(x.changes), rests: delta(x.rests), restAfter: [...x.restAfter], lastAct: x.lastAct },
    ever: [...w.everIds()], guests: [...G.made], ckpt: { ...k, newest: Number.isFinite(k.newest) ? k.newest : null },
    shapes: { ...w.__shapes }, orphans: { n: o.n, lifted: [...o.lifted].map(([id, l]: Any) => [id, l.seq, l.by]), parentOf: [...o.parentOf] },
    sim: simOk ? { rev: sf.rev ?? 0, checks: sf.checks ?? { agree: 0, disagree: [] } } : null };
}

/** Seed w's scans and the host's index X from carried views (n = coversIndex + 1). */
export function seedViews(w: Any, X: LogIndex, V: Any, st: Any) {
  const n = V.n;
  X.touching = mapIn(V.touch); X.actors = new Set(V.actors); X.says = undelta(V.says); X.ckpts = [...V.ckpts]; X.lastChange = V.lastChange; X.purges = 0; X.n = n;
  const r = V.act.resultOf, resultOf = new Map(); for (let i = 0; i < r.length; i += 2) resultOf.set(r[i], r[i + 1]);
  seedActIndex(w, n, { actsOf: mapIn(V.act.actsOf), resultOf, undone: new Set(V.act.undone), changes: undelta(V.act.changes), touch: mapIn(V.touch),
    rests: undelta(V.act.rests), restAfter: new Map(V.act.restAfter), lastAct: V.act.lastAct }, st);
  w.__ever.n = n; w.__ever.ids = new Set(V.ever);
  seedPurgedSeqs(w, n);
  w.__guests = { n, made: new Map(V.guests), pending: new Map(V.guests), ids: new Map(), seeded: true };
  w.ckptScan = { ...V.ckpt, newest: V.ckpt.newest ?? -Infinity };
  w.__shapes = { ...V.shapes };
  w.__orphans = { n: V.orphans.n, lifted: new Map(V.orphans.lifted.map(([id, seq, by]: Any) => [id, { seq, by }])), parentOf: new Map(V.orphans.parentOf) };
}

/** A purge after a boot from carried views: the guests' scan, if nothing has read it since the boot, is rebuilt from the whole log
 *  (its creators' rights read the purge, as a scan made after it does). Every other view either rebuilds itself on a purge or
 *  doesn't read bodies. */
export function viewsAfterPurge(w: Any) { if (w.__guests?.seeded) delete w.__guests; }

/** The sim folder's start at coversIndex for a world with no engine: the fold itself, as the sim holds it (no world id; its
 *  diagnostics the no-ops a carried log's fold holds, which the sim's own ops record alike), at the covered line's clock. */
export const simFromCut = (V: Any, st: Any, clock: number) => ({ st: { ...cloneState(st), worldId: null, diagnostics: st.diagnostics.map((d: Any) => [...d]) }, clock, spec: null, foreign: false, sim: null, launched: {}, lifted: [],
  rev: V.sim.rev, checks: JSON.parse(JSON.stringify(V.sim.checks)) });

/** The views built from genesis over `entries` (the re-derive's, and the suites' reference): what captureViews says at that length. */
export function viewsFresh(entries: Any[], { sim = false } = {}) {
  const st = fold(entries); const X = logIndex(); entries.forEach((e, s) => X.add(s, e));
  const w: Any = worldOf({ name: "re-derive", entries, getBlob: () => { throw new Error("no blobs here"); }, putBlob: () => { throw new Error("read only"); }, now: () => 0, writeLine: () => { throw new Error("read only"); } });
  w.state = () => st; w.touching = (id: string) => X.touching.get(id) ?? [];
  let sf = null; if (sim && st.status === "ok") { const f = simFolder(entries, { models: {} }); for (let s = 0; s < entries.length; s++) if (isE(entries[s])) f.feed(s); sf = f.view(); }
  return captureViews(w, X, sf);
}
