// seats — the server side of seat profiles (docs/reference/SEATS.md): storage, judgment, push.
// This module owns the profile store (assets/opt/seats/profiles.json + an append-only provenance log), computes the
// serve-time verdict against the current bytes on disk (via seatcore), and tells the server when to broadcast
// `avatar-profile-updated`, so consumers never rehash a VRM. HTTP proposals need a named actor; the countersign has no
// HTTP path (tools/operator/seat-accept.ts, noticed by an mtime watch). Every write is provenance-first under one on-disk
// lock shared by every process. Rationale: docs/research/seat-store-integrity.md.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { validateProfile, profileStatus } from "../shared/seatcore.js";
import { OPT_DIR, LIBRARY_DIR, PATCH_DIR } from "./config.ts";
import { worlds } from "./world.ts";
import { sha256Bytes } from "../shared/protocol/hash.js";
import { atomicWrite } from "./fsutil.ts";
import { avatarDefs } from "./defs.ts";
import { resolveLibFile } from "./libfile.ts";

export const SEAT_POSE = "sitchair";
export const CLIP_REL = "eidoverse/assets/animations/sitting_normal_chair.vrma";
export const MAX_PROPOSAL_BYTES = 4096;

type ProfileRec = Record<string, any>;
type Slot = { accepted?: ProfileRec; proposed?: ProfileRec };
type Store = { rev: number; profiles: Record<string, Record<string, Slot>> };

// the injectable fs surface — production uses node:fs verbatim; the fault-
// injection test replaces single calls to prove failure atomicity
export type SeatFs = {
  writeFileSync: typeof writeFileSync; renameSync: typeof renameSync;
  appendFileSync: typeof appendFileSync;
};

export type SeatVerdict = {
  pose: string; status: string;
  contactY?: number; refusal?: string; which?: string;
  clipSha256?: string;
};

/** null-prototype deep conversion for the two map layers — parsed JSON is
 *  plain-Object-rooted, and `obj[k] ??=` on a plain object READS inherited
 *  slots before assigning (that is the pollution door) */
function inertProfiles(raw: any): Store["profiles"] {
  const out: Store["profiles"] = Object.create(null);
  if (raw && typeof raw === "object") {
    for (const [name, poses] of Object.entries(raw)) {
      if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
      const p: Record<string, Slot> = Object.create(null);
      if (poses && typeof poses === "object")
        for (const [pose, slot] of Object.entries(poses as object))
          if (Object.prototype.hasOwnProperty.call(poses, pose)) p[pose] = slot as Slot;
      out[name] = p;
    }
  }
  return out;
}

export class SeatStore {
  private dir: string;
  private file: string;
  private logFile: string;
  private lockFile: string;
  private store: Store = { rev: 0, profiles: Object.create(null) };
  private fileMtime = 0;
  private quarantined: string | null = null;
  private shaCache = new Map<string, { mtime: number; size: number; sha: string }>();
  private clipBases: string[];
  private vrmDirs: string[];
  private fs: SeatFs;
  private lockTimeoutMs: number;

  constructor(optDir: string, libraryDir: string, fsOverride: Partial<SeatFs> = {},
    { lockTimeoutMs = 3000, patchDir = "" }: { lockTimeoutMs?: number; patchDir?: string } = {}) {
    this.dir = join(optDir, "seats");
    this.file = join(this.dir, "profiles.json");
    this.logFile = join(this.dir, "profiles.log.jsonl");
    this.lockFile = join(this.dir, ".write-lock");
    // overlay wins, like the avatar roster scan. The clip ladder matches what /library SERVES, patched fork first (the
    // order routes.ts resolves): hashing a copy nobody plays would read "stale" forever.
    this.clipBases = [patchDir, optDir, libraryDir].filter(Boolean).map((d) => join(d!, CLIP_REL));
    // every body the avatar roster lists, which scans the same three
    this.vrmDirs = [patchDir, optDir, libraryDir].filter(Boolean).map((d) => join(d!, "eidoverse/assets/vrms"));
    this.fs = { writeFileSync, renameSync, appendFileSync, ...fsOverride };
    this.lockTimeoutMs = lockTimeoutMs;
    this.reload();
  }

  // ---- the write lock (one per store directory, shared by every process) ---

  /** Exclusive create (openSync "wx") is the atom; ownership is the nonce in {pid, nonce, ts}. Liveness is PID-verified
   *  (ESRCH = orphaned), never inferred from age; a dead lock is broken by rename-steal. docs/research/seat-store-integrity.md#the-write-lock */
  private lockNonce: string | null = null;

  private static pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (e: any) { return e?.code !== "ESRCH"; }
  }

  private readLockRecord(): { pid?: number; nonce?: string; ts?: number } | null {
    try { return JSON.parse(readFileSync(this.lockFile, "utf8")); } catch { return null; }
  }

  private acquireLock(): boolean {
    const deadline = Date.now() + this.lockTimeoutMs;
    const nonce = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    mkdirSync(this.dir, { recursive: true });
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        writeSync(fd, JSON.stringify({ pid: process.pid, nonce, ts: Date.now() }));
        closeSync(fd);
        this.lockNonce = nonce;
        return true;
      } catch {
        const holder = this.readLockRecord();
        if (holder && Number.isInteger(holder.pid) && !SeatStore.pidAlive(holder.pid!)) {
          // dead holder: claim the corpse atomically, verify it IS the corpse
          const tomb = `${this.lockFile}.tomb-${nonce}`;
          try {
            renameSync(this.lockFile, tomb);
            const claimed = JSON.parse(readFileSync(tomb, "utf8"));
            if (claimed.nonce === holder.nonce) {
              console.error(`[seats] breaking dead writer's lock (pid ${holder.pid} no longer exists)`);
              unlinkSync(tomb);
            } else {
              // the rename caught a NEWER lock — put it back untouched
              try { renameSync(tomb, this.lockFile); } catch { try { unlinkSync(tomb); } catch { /* commit gates protect the rest */ } }
            }
          } catch { /* another breaker won the rename: loop */ }
          continue;
        }
        // live (or unknowable) holder: wait, however old its stamp — age is
        // not proof of death, and exclusion outranks our patience
        if (Date.now() >= deadline) return false;
        Bun.sleepSync(25);
      }
    }
  }

  /** True while the on-disk lock is still the one we minted — the commit
   *  gates read this immediately before each irreversible step so that even
   *  a pathological steal aborts a transaction instead of forking history. */
  private ownsLock(): boolean {
    return this.lockNonce !== null && this.readLockRecord()?.nonce === this.lockNonce;
  }

  private releaseLock() {
    // release only what we minted — never a successor's lock
    if (this.lockNonce !== null) {
      if (this.readLockRecord()?.nonce === this.lockNonce) {
        try { unlinkSync(this.lockFile); } catch { /* vanished: nothing ours remains */ }
      } else console.error("[seats] write lock no longer ours at release — leaving it untouched");
    }
    this.lockNonce = null;
  }

  /** Every mutation runs WHOLE under the lock (forced reload, re-check, append, rename, swap), so two writers can't
   *  both build rev N+1 from rev N: the second waits or refuses. */
  private withLock<T>(fn: () => T): T | { ok: false; status: number; why: string } {
    if (!this.acquireLock())
      return { ok: false, status: 503, why: `another writer holds the seat-profile lock (waited ${this.lockTimeoutMs}ms) — nothing was written; retry after it releases` };
    try {
      this.reload();   // unconditional: the lock is when the disk is the truth
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  // ---- store I/O -----------------------------------------------------------

  /** All valid log entries, in file order, and the monotonicity verdict: two records at one revision mean a forked
   *  history with no defensible fold order (quarantine). */
  private readLog(): { entries: any[]; monotonic: boolean } {
    const entries: any[] = [];
    let monotonic = true, prev = 0;
    try {
      if (!existsSync(this.logFile)) return { entries, monotonic };
      for (const line of readFileSync(this.logFile, "utf8").trimEnd().split("\n")) {
        let e: any; try { e = JSON.parse(line); } catch { continue; /* torn tail line */ }
        if (!Number.isInteger(e.rev)) continue;
        if (e.rev <= prev) monotonic = false;
        prev = e.rev;
        entries.push(e);
      }
    } catch { /* unreadable log = empty; the snapshot check below decides */ }
    return { entries, monotonic };
  }

  private reload() {
    this.quarantined = null;
    let snap: Store = { rev: 0, profiles: Object.create(null) };
    try {
      if (existsSync(this.file)) {
        const st = statSync(this.file);
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        snap = { rev: Number.isInteger(parsed.rev) ? parsed.rev : 0, profiles: inertProfiles(parsed.profiles) };
        this.fileMtime = st.mtimeMs;
      }
    } catch { /* unreadable snapshot serves as empty below, subject to the log check */ }
    const log = this.readLog();
    if (!log.monotonic) {
      this.quarantined = "provenance log has duplicate or non-monotonic revisions — a forked history has no defensible fold order; operator must reconcile";
      console.error(`[seats] ${this.quarantined}`);
      this.store = { rev: snap.rev, profiles: Object.create(null) };
      return;
    }
    const logRev = log.entries.at(-1)?.rev ?? 0;
    if (snap.rev > logRev) {
      // a snapshot with no receipt for its last write — the exact state the
      // provenance boundary exists to forbid. Refuse to serve it as truth.
      this.quarantined = `profiles.json rev ${snap.rev} is AHEAD of its provenance log (rev ${logRev}) — serving no profiles until the operator reconciles`;
      console.error(`[seats] ${this.quarantined}`);
      this.store = { rev: snap.rev, profiles: Object.create(null) };
      return;
    }
    if (logRev > snap.rev) {
      // crash between log append and snapshot rename: fold the receipted
      // writes forward — the log is the truth the snapshot merely caches
      for (const e of log.entries) {
        if (e.rev <= snap.rev) continue;
        this.foldLogEntry(snap, e);
        snap.rev = e.rev;
      }
      console.log(`[seats] snapshot lagged its log — receipted writes folded forward to rev ${snap.rev}`);
      this.store = snap;
      try { this.persistSnapshotOnly(); } catch { /* the log still leads; the next load folds again */ }
      return;
    }
    this.store = snap;
  }

  private foldLogEntry(s: Store, e: any) {
    if (typeof e.name !== "string" || typeof e.pose !== "string") return;
    const slot = ((s.profiles[e.name] ??= Object.create(null))[e.pose] ??= {});
    if (e.action === "propose") slot.proposed = e.record;
    else if (e.action === "accept") { slot.accepted = e.record; delete slot.proposed; }
  }

  private persistSnapshotOnly() {
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.file, JSON.stringify(this.store), { fs: this.fs });
    try { this.fileMtime = statSync(this.file).mtimeMs; } catch { /* next poll reloads harmlessly */ }
  }

  /** Provenance-first write: build the next state aside, append the log line, rename the snapshot, then swap memory.
   *  A failure after the append leaves the log AHEAD, which reload() folds forward: durable with its receipt or not at all. */
  private persist(action: string, actor: string, name: string, pose: string, record: ProfileRec, prior: ProfileRec | null,
    mutate: (s: Store) => void): { ok: true; rev: number } | { ok: false; why: string } {
    const next: Store = { rev: this.store.rev + 1, profiles: inertProfiles(JSON.parse(JSON.stringify(this.store.profiles))) };
    mutate(next);
    mkdirSync(this.dir, { recursive: true });
    // COMMIT GATE: the on-disk lock must still be ours before each irreversible step; a breach is a refused write,
    // never a forked history
    if (!this.ownsLock())
      return { ok: false, why: "lock ownership lost before commit — nothing was written; retry" };
    try {
      this.fs.appendFileSync(this.logFile,
        JSON.stringify({ ts: Date.now(), rev: next.rev, action, actor, name, pose, record, prior }) + "\n");
    } catch (e) {
      return { ok: false, why: `provenance append failed — nothing was written: ${(e as Error).message}` };
    }
    if (!this.ownsLock())
      // the receipt stands; the snapshot must not race a successor (recovery folds it forward, or quarantines)
      return { ok: false, why: "lock ownership lost after provenance append — snapshot withheld; recovery will reconcile the receipt" };
    try {
      atomicWrite(this.file, JSON.stringify(next), { fs: this.fs });
    } catch (e) {
      // the log holds the receipt; the live store stays unchanged and the next load folds it forward
      return { ok: false, why: `snapshot write failed (receipted in the log; recovery will fold it forward): ${(e as Error).message}` };
    }
    this.store = next;
    try { this.fileMtime = statSync(this.file).mtimeMs; } catch { /* poll heals */ }
    return { ok: true, rev: next.rev };
  }

  pollExternalChange(): { rev: number; changed: { name: string; pose: string }[] } | null {
    let st; try { st = statSync(this.file); } catch { return null; }
    if (st.mtimeMs === this.fileMtime) return null;
    const before = this.store;
    this.reload();
    if (this.store.rev === before.rev) return null;
    const changed: { name: string; pose: string }[] = [];
    const names = new Set([...Object.keys(before.profiles), ...Object.keys(this.store.profiles)]);
    for (const n of names) {
      const poses = new Set([...Object.keys(before.profiles[n] ?? {}), ...Object.keys(this.store.profiles[n] ?? {})]);
      for (const p of poses)
        if (JSON.stringify(before.profiles[n]?.[p] ?? null) !== JSON.stringify(this.store.profiles[n]?.[p] ?? null))
          changed.push({ name: n, pose: p });
    }
    return { rev: this.store.rev, changed };
  }

  get rev() { return this.store.rev; }
  get quarantineReason() { return this.quarantined; }

  // ---- hashing (mtime-cached — the ?v= trick, applied to digests) ----------

  private shaOf(path: string): string | null {
    let st; try { st = statSync(path); } catch { return null; }
    const hit = this.shaCache.get(path);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.sha;
    try {
      const sha = sha256Bytes(readFileSync(path));
      this.shaCache.set(path, { mtime: st.mtimeMs, size: st.size, sha });
      return sha;
    } catch { return null; }
  }

  clipSha(): string | null {
    for (const p of this.clipBases) if (existsSync(p)) return this.shaOf(p);
    return null;
  }

  /** This slice profiles bodies the roster can serve: the bytes must exist to be judged against. */
  rosterHas(name: string): boolean {
    const vrm = avatarDefs()[name]?.vrm;   // a def's vrm first, as avatarRoster resolves it (#326)
    if (vrm && resolveLibFile(vrm)) return true;
    return this.vrmDirs.some((d) => existsSync(join(d, `${name}.vrm`)));
  }

  // ---- the serve-time verdict ---------------------------------------------

  judge(name: string, vrmPath: string): SeatVerdict {
    if (this.quarantined) return { pose: SEAT_POSE, status: "missing" };
    const slot = this.store.profiles[name]?.[SEAT_POSE];
    const rec = slot?.accepted ?? slot?.proposed ?? null;
    if (!rec) return { pose: SEAT_POSE, status: "missing" };
    const avatarSha = this.shaOf(vrmPath);
    const clipSha = this.clipSha();
    if (!avatarSha || !clipSha) return { pose: SEAT_POSE, status: "missing" };
    const v = profileStatus(rec, avatarSha, clipSha);
    if (rec === slot?.proposed && v.status === "accepted") return { pose: SEAT_POSE, status: "proposed", clipSha256: clipSha };
    return { pose: SEAT_POSE, status: v.status, clipSha256: clipSha,
      ...(v.contactY !== undefined ? { contactY: v.contactY } : {}),
      ...(v.refusal ? { refusal: v.refusal } : {}),
      ...(v.which ? { which: v.which } : {}) };
  }

  // ---- writes --------------------------------------------------------------

  /** HTTP proposal (named actor already authenticated by the caller). May
   *  only create/replace the PROPOSED slot; the accepted slot is inert to
   *  this path by construction. */
  propose(record: ProfileRec, actor: string, { allowUnrostered = false } = {}):
    { ok: true; rev: number; name: string; pose: string } | { ok: false; status: number; why: string } {
    // shape refusals need no lock — garbage never contends with real writers
    const val = validateProfile(record);
    if (!val.ok) return { ok: false, status: 422, why: val.why };
    if (record.review && record.review.status !== "proposed")
      return { ok: false, status: 403, why: "this door writes proposals only — countersign is an operator act" };
    return this.withLock(() => {
      if (this.quarantined) return { ok: false as const, status: 503, why: "profile store quarantined — operator must reconcile snapshot/log" };
      const name = record.avatar, pose = record.pose;
      if (!allowUnrostered && !this.rosterHas(name))
        return { ok: false as const, status: 404, why: `"${name}" is not a roster avatar — there are no bytes to judge this profile against` };
      const prior = this.store.profiles[name]?.[pose]?.proposed ?? null;
      const rec = { ...record, review: { status: "proposed", proposedBy: actor, ...(allowUnrostered ? { unrostered: true } : {}), ts: Date.now() } };
      const r = this.persist("propose", actor, name, pose, rec, prior, (s) => {
        const slot = ((s.profiles[name] ??= Object.create(null))[pose] ??= {});
        slot.proposed = rec;
      });
      if (!r.ok) return { ok: false as const, status: 503, why: r.why };
      return { ok: true as const, rev: r.rev, name, pose };
    });
  }

  /** Operator countersign (tools/operator/seat-accept.ts — no HTTP path reaches this).
   *  `expectedRev` is the revision the operator LISTED and reviewed: if the
   *  store has moved since, the acceptance refuses rather than countersign a
   *  record nobody looked at. */
  accept(name: string, pose: string, receipt: string, by: string, expectedRev: number):
    { ok: true; rev: number } | { ok: false; why: string; status?: number } {
    if (!Number.isInteger(expectedRev)) return { ok: false, why: "expectedRev required — accept what you reviewed (run `list`, pass --expect-rev)" };
    return this.withLock(() => {
      if (this.quarantined) return { ok: false as const, why: `store quarantined: ${this.quarantined}` };
      // the reload happened UNDER the lock: an interleaved proposal moves the revision and refuses the countersign
      if (this.store.rev !== expectedRev)
        return { ok: false as const, why: `store moved (rev ${this.store.rev} ≠ reviewed ${expectedRev}) — re-list and re-review before countersigning` };
      const slot = this.store.profiles[name]?.[pose];
      if (!slot?.proposed) return { ok: false as const, why: `no proposed profile for ${name}/${pose}` };
      const rec = { ...slot.proposed, review: { status: "accepted", receipt, by, ts: Date.now() } };
      const val = validateProfile(rec);
      if (!val.ok) return { ok: false as const, why: `proposed record no longer validates: ${val.why}` };
      const prior = slot.accepted ?? null;
      return this.persist("accept", by, name, pose, rec, prior, (s) => {
        const sl = ((s.profiles[name] ??= Object.create(null))[pose] ??= {});
        sl.accepted = rec;
        delete sl.proposed;
      });
    });
  }

  /** Operator import (the no-attribution environments' path — local dev has
   *  no home node to vouch for anyone, so the operator IS the provenance). */
  importProposal(record: ProfileRec, operator: string, opts: { allowUnrostered?: boolean } = {}) {
    return this.propose(record, `operator:${operator}`, opts);
  }

  list() {
    const out: { name: string; pose: string; slot: string; status: string }[] = [];
    for (const [name, poses] of Object.entries(this.store.profiles))
      for (const [pose, slot] of Object.entries(poses)) {
        if (slot.accepted) out.push({ name, pose, slot: "accepted", status: slot.accepted.unsupported ? "unsupported" : "accepted" });
        if (slot.proposed) out.push({ name, pose, slot: "proposed", status: slot.proposed.unsupported ? "unsupported" : "proposed" });
      }
    return { rev: this.store.rev, records: out, ...(this.quarantined ? { quarantined: this.quarantined } : {}) };
  }
}

// ---- the server's one store + the update push -------------------------------

/** The live server's store (importable by routes, which never import server.ts). The operator tool and tests build
 *  their own over the same directory; the on-disk lock serializes them. */
export const seatStore = new SeatStore(OPT_DIR, LIBRARY_DIR, {}, { patchDir: PATCH_DIR });

/** Announce one profile change to every connected client: one event for both paths (POST /seat-profile, and the
 *  operator tool's write the 5 s poll notices), so they cannot drift. */
export function announceProfileUpdate(name: string, pose: string, rev: number): number {
  const update = JSON.stringify({ type: "avatar-profile-updated", name, pose, rev });
  let notified = 0;
  for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
  return notified;
}
