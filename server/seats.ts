// seats — the server side of seat profiles (#101): storage, judgment, push.
//
// One judge, three readers. This module owns the profile store
// (assets/opt/seats/profiles.json + an append-only provenance log), computes
// the serve-time verdict against the CURRENT bytes on disk (via seatcore,
// the same file every consumer evaluates), and tells the server when to
// broadcast `avatar-profile-updated`. Consumers never rehash a VRM and can
// never read a stale value as fresh — the verdict ships pre-judged.
//
// Write authority (design round, B4): HTTP proposals require a NAMED actor
// (a tokens.json bearer or a home-node-verified aid1 identity — the same two
// legs /upload trusts); the anonymous door token may not write here, because
// a seat profile moves every wearer of an avatar and "?by=" is self-asserted.
// The countersign that makes a profile load-bearing has NO HTTP path at all:
// tools/seat-accept.ts is run by the operator on the box, edits the store
// through this module's own functions, and the running server notices via an
// mtime watch — reloading, diffing, and pushing the update event. Bearer
// tokens are never logged and never echoed.
//
// Integrity boundaries (#105 review, B2/B3 — each rule is that review):
//  - the maps are NULL-PROTOTYPE and the keys are schema-refused reserved
//    names besides: "__proto__" cannot reach an inherited slot here even if
//    a future validator regresses;
//  - proposals name a ROSTER avatar (the bytes must exist to judge against);
//    the operator-import lane may explicitly carry an unrostered name, and
//    the flag is provenance;
//  - every write is PROVENANCE-FIRST: the log line is appended before the
//    snapshot renames, the in-memory store swaps only after both, and no
//    caller reports success (or broadcasts) before the swap. A crash between
//    log and snapshot leaves the log AHEAD — startup folds it forward. A
//    snapshot ahead of its log is a state with no receipt: quarantined,
//    served as missing, said loudly. Provenance ⊇ applied state, always;
//  - writes are CAS-guarded: the store reloads from disk before mutating
//    (two processes write here — the server and the operator tool), and the
//    countersign additionally requires the revision the operator REVIEWED —
//    a proposal that changed since `list` cannot be accepted unseen.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateProfile, profileStatus } from "../client/lib/seatcore.js";

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
  private store: Store = { rev: 0, profiles: Object.create(null) };
  private fileMtime = 0;
  private quarantined: string | null = null;
  private shaCache = new Map<string, { mtime: number; size: number; sha: string }>();
  private clipBases: string[];
  private vrmDirs: string[];
  private fs: SeatFs;

  constructor(optDir: string, libraryDir: string, fsOverride: Partial<SeatFs> = {}) {
    this.dir = join(optDir, "seats");
    this.file = join(this.dir, "profiles.json");
    this.logFile = join(this.dir, "profiles.log.jsonl");
    // overlay wins, like the avatar roster scan
    this.clipBases = [join(optDir, CLIP_REL), join(libraryDir, CLIP_REL)];
    this.vrmDirs = [join(optDir, "eidoverse/assets/vrms"), join(libraryDir, "eidoverse/assets/vrms")];
    this.fs = { writeFileSync, renameSync, appendFileSync, ...fsOverride };
    this.reload();
  }

  // ---- store I/O -----------------------------------------------------------

  private lastLogRev(): number {
    try {
      if (!existsSync(this.logFile)) return 0;
      const lines = readFileSync(this.logFile, "utf8").trimEnd().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const r = JSON.parse(lines[i]).rev; if (Number.isInteger(r)) return r; } catch { /* torn tail line: skip */ }
      }
    } catch { /* unreadable log = rev 0 */ }
    return 0;
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
    const logRev = this.lastLogRev();
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
      try {
        const lines = readFileSync(this.logFile, "utf8").trimEnd().split("\n");
        for (const line of lines) {
          let e: any; try { e = JSON.parse(line); } catch { continue; }
          if (!Number.isInteger(e.rev) || e.rev <= snap.rev) continue;
          this.foldLogEntry(snap, e);
          snap.rev = e.rev;
        }
        console.log(`[seats] snapshot lagged its log — receipted writes folded forward to rev ${snap.rev}`);
        this.store = snap;
        this.persistSnapshotOnly();   // rewrite the cache to match its receipts
        return;
      } catch (e) {
        this.quarantined = `provenance log unreadable during recovery: ${(e as Error).message}`;
        console.error(`[seats] ${this.quarantined}`);
        this.store = { rev: logRev, profiles: Object.create(null) };
        return;
      }
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
    this.fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.store));
    this.fs.renameSync(`${this.file}.tmp`, this.file);
    try { this.fileMtime = statSync(this.file).mtimeMs; } catch { /* next poll reloads harmlessly */ }
  }

  /** Provenance-first write. Builds the next state WITHOUT touching the live
   *  one; appends the log line; renames the snapshot; only then swaps memory.
   *  Any failure leaves the live store exactly as it was — and a failure
   *  after the append leaves the log AHEAD, which reload() folds forward:
   *  the write becomes durable WITH its receipt or not at all. */
  private persist(action: string, actor: string, name: string, pose: string, record: ProfileRec, prior: ProfileRec | null,
    mutate: (s: Store) => void): { ok: true; rev: number } | { ok: false; why: string } {
    const next: Store = { rev: this.store.rev + 1, profiles: inertProfiles(JSON.parse(JSON.stringify(this.store.profiles))) };
    mutate(next);
    mkdirSync(this.dir, { recursive: true });
    try {
      this.fs.appendFileSync(this.logFile,
        JSON.stringify({ ts: Date.now(), rev: next.rev, action, actor, name, pose, record, prior }) + "\n");
    } catch (e) {
      return { ok: false, why: `provenance append failed — nothing was written: ${(e as Error).message}` };
    }
    try {
      this.fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next));
      this.fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      // the log holds the receipt; the snapshot lags. The live store stays
      // unchanged, this call reports failure, and the NEXT load folds the
      // receipted write forward — never an applied state without a receipt.
      return { ok: false, why: `snapshot write failed (receipted in the log; recovery will fold it forward): ${(e as Error).message}` };
    }
    this.store = next;
    try { this.fileMtime = statSync(this.file).mtimeMs; } catch { /* poll heals */ }
    return { ok: true, rev: next.rev };
  }

  /** Two processes write here — reload from disk before every mutation so a
   *  decision is made against current state, not a stale snapshot. */
  private freshen() {
    let st; try { st = statSync(this.file); } catch { return; }
    if (st.mtimeMs !== this.fileMtime) this.reload();
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
      const sha = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
      this.shaCache.set(path, { mtime: st.mtimeMs, size: st.size, sha });
      return sha;
    } catch { return null; }
  }

  clipSha(): string | null {
    for (const p of this.clipBases) if (existsSync(p)) return this.shaOf(p);
    return null;
  }

  /** This slice profiles bodies the roster can serve — the bytes must exist
   *  to be judged against (#105 review B2). */
  rosterHas(name: string): boolean {
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
    this.freshen();
    if (this.quarantined) return { ok: false, status: 503, why: "profile store quarantined — operator must reconcile snapshot/log" };
    const val = validateProfile(record);
    if (!val.ok) return { ok: false, status: 422, why: val.why };
    if (record.review && record.review.status !== "proposed")
      return { ok: false, status: 403, why: "this door writes proposals only — countersign is an operator act" };
    const name = record.avatar, pose = record.pose;
    if (!allowUnrostered && !this.rosterHas(name))
      return { ok: false, status: 404, why: `"${name}" is not a roster avatar — there are no bytes to judge this profile against` };
    const prior = this.store.profiles[name]?.[pose]?.proposed ?? null;
    const rec = { ...record, review: { status: "proposed", proposedBy: actor, ...(allowUnrostered ? { unrostered: true } : {}), ts: Date.now() } };
    const r = this.persist("propose", actor, name, pose, rec, prior, (s) => {
      const slot = ((s.profiles[name] ??= Object.create(null))[pose] ??= {});
      slot.proposed = rec;
    });
    if (!r.ok) return { ok: false, status: 503, why: r.why };
    return { ok: true, rev: r.rev, name, pose };
  }

  /** Operator countersign (tools/seat-accept.ts — no HTTP path reaches this).
   *  `expectedRev` is the revision the operator LISTED and reviewed: if the
   *  store has moved since, the acceptance refuses rather than countersign a
   *  record nobody looked at (#105 review B3). */
  accept(name: string, pose: string, receipt: string, by: string, expectedRev: number):
    { ok: true; rev: number } | { ok: false; why: string } {
    this.freshen();
    if (this.quarantined) return { ok: false, why: `store quarantined: ${this.quarantined}` };
    if (!Number.isInteger(expectedRev)) return { ok: false, why: "expectedRev required — accept what you reviewed (run `list`, pass --expect-rev)" };
    if (this.store.rev !== expectedRev)
      return { ok: false, why: `store moved (rev ${this.store.rev} ≠ reviewed ${expectedRev}) — re-list and re-review before countersigning` };
    const slot = this.store.profiles[name]?.[pose];
    if (!slot?.proposed) return { ok: false, why: `no proposed profile for ${name}/${pose}` };
    const rec = { ...slot.proposed, review: { status: "accepted", receipt, by, ts: Date.now() } };
    const val = validateProfile(rec);
    if (!val.ok) return { ok: false, why: `proposed record no longer validates: ${val.why}` };
    const prior = slot.accepted ?? null;
    return this.persist("accept", by, name, pose, rec, prior, (s) => {
      const sl = ((s.profiles[name] ??= Object.create(null))[pose] ??= {});
      sl.accepted = rec;
      delete sl.proposed;
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
