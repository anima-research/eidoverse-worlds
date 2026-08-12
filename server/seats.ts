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

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { validateProfile, profileStatus } from "../client/lib/seatcore.js";

export const SEAT_POSE = "sitchair";
export const CLIP_REL = "eidoverse/assets/animations/sitting_normal_chair.vrma";
export const MAX_PROPOSAL_BYTES = 4096;

type ProfileRec = Record<string, any>;
type Slot = { accepted?: ProfileRec; proposed?: ProfileRec };
type Store = { rev: number; profiles: Record<string, Record<string, Slot>> };

export type SeatVerdict = {
  pose: string; status: string;
  contactY?: number; refusal?: string; which?: string;
  /** the CURRENT clip digest the verdict was judged against — the browser
   *  compares its loaded bytes to this, closing the fallback/filename gap */
  clipSha256?: string;
};

export class SeatStore {
  private dir: string;
  private file: string;
  private log: string;
  private store: Store = { rev: 0, profiles: {} };
  private fileMtime = 0;
  private shaCache = new Map<string, { mtime: number; size: number; sha: string }>();
  private clipBases: string[];

  constructor(optDir: string, libraryDir: string) {
    this.dir = join(optDir, "seats");
    this.file = join(this.dir, "profiles.json");
    this.log = join(this.dir, "profiles.log.jsonl");
    // overlay wins, like the avatar roster scan
    this.clipBases = [join(optDir, CLIP_REL), join(libraryDir, CLIP_REL)];
    this.reload();
  }

  // ---- store I/O -----------------------------------------------------------

  private reload() {
    try {
      if (!existsSync(this.file)) return;
      const st = statSync(this.file);
      this.store = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Number.isInteger(this.store.rev)) this.store.rev = 0;
      if (!this.store.profiles || typeof this.store.profiles !== "object") this.store.profiles = {};
      this.fileMtime = st.mtimeMs;
    } catch { /* unreadable store serves as empty — verdicts degrade to "missing", never crash the door */ }
  }

  private persist(action: string, actor: string, name: string, pose: string, record: ProfileRec | null, prior: ProfileRec | null) {
    this.store.rev++;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.store));
    renameSync(`${this.file}.tmp`, this.file);
    try { this.fileMtime = statSync(this.file).mtimeMs; } catch { /* next poll reloads harmlessly */ }
    // Provenance is append-only and carries both sides of every write, so the
    // json is reconstructible and any write is rollback-able from the log.
    appendFileSync(this.log, JSON.stringify({ ts: Date.now(), rev: this.store.rev, action, actor, name, pose, record, prior }) + "\n");
  }

  /** Operator tools edit the same files from another process; the server
   *  notices by mtime, reloads, and reports which (name,pose) slots changed
   *  so the caller can broadcast. Cheap enough to poll every few seconds. */
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

  // ---- the serve-time verdict ---------------------------------------------

  /** The seat field for one /avatars roster entry. `vrmPath` is the actual
   *  file the roster resolved — the same bytes clients download. */
  judge(name: string, vrmPath: string): SeatVerdict {
    const slot = this.store.profiles[name]?.[SEAT_POSE];
    const rec = slot?.accepted ?? slot?.proposed ?? null;
    if (!rec) return { pose: SEAT_POSE, status: "missing" };
    const avatarSha = this.shaOf(vrmPath);
    const clipSha = this.clipSha();
    if (!avatarSha || !clipSha) return { pose: SEAT_POSE, status: "missing" };
    const v = profileStatus(rec, avatarSha, clipSha);
    // A record still waiting for countersign serves as "proposed" even when
    // its hashes are fresh — only the accepted slot can ever carry a value.
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
  propose(record: ProfileRec, actor: string): { ok: true; rev: number; name: string; pose: string } | { ok: false; status: number; why: string } {
    const val = validateProfile(record);
    if (!val.ok) return { ok: false, status: 422, why: val.why };
    if (record.review && record.review.status !== "proposed")
      return { ok: false, status: 403, why: "this door writes proposals only — countersign is an operator act" };
    const name = record.avatar, pose = record.pose;
    const slot = ((this.store.profiles[name] ??= {})[pose] ??= {});
    const prior = slot.proposed ?? null;
    slot.proposed = { ...record, review: { status: "proposed", proposedBy: actor, ts: Date.now() } };
    this.persist("propose", actor, name, pose, slot.proposed, prior);
    return { ok: true, rev: this.store.rev, name, pose };
  }

  /** Operator countersign (tools/seat-accept.ts — no HTTP path reaches this).
   *  Promotes the proposed record wholesale; the value cannot be edited in
   *  flight, only accepted as derived or not at all. */
  accept(name: string, pose: string, receipt: string, by: string): { ok: true; rev: number } | { ok: false; why: string } {
    const slot = this.store.profiles[name]?.[pose];
    if (!slot?.proposed) return { ok: false, why: `no proposed profile for ${name}/${pose}` };
    const rec = { ...slot.proposed, review: { status: "accepted", receipt, by, ts: Date.now() } };
    const val = validateProfile(rec);
    if (!val.ok) return { ok: false, why: `proposed record no longer validates: ${val.why}` };
    const prior = slot.accepted ?? null;
    slot.accepted = rec;
    delete slot.proposed;
    this.persist("accept", by, name, pose, rec, prior);
    return { ok: true, rev: this.store.rev };
  }

  /** Operator import (the no-attribution environments' path — local dev has
   *  no home node to vouch for anyone, so the operator IS the provenance). */
  importProposal(record: ProfileRec, operator: string) {
    return this.propose(record, `operator:${operator}`);
  }

  list() {
    const out: { name: string; pose: string; slot: string; status: string }[] = [];
    for (const [name, poses] of Object.entries(this.store.profiles))
      for (const [pose, slot] of Object.entries(poses)) {
        if (slot.accepted) out.push({ name, pose, slot: "accepted", status: slot.accepted.unsupported ? "unsupported" : "accepted" });
        if (slot.proposed) out.push({ name, pose, slot: "proposed", status: slot.proposed.unsupported ? "unsupported" : "proposed" });
      }
    return { rev: this.store.rev, records: out };
  }
}
