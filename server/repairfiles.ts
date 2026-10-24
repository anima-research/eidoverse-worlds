// server/repairfiles.ts — the shape repair's rollback (reviewer item 9, 2026-10-18): a world's log as it was before a repair,
// kept beside the world, and put back byte-identical.
//   backupBeforeRepair(dir)   copies <dir>/world.jsonl to <dir>/repair-backups/<stamp>/world.jsonl with manifest.json
//                             {stamp, before: {size, sha256}}; returns the backup dir. The caller records `after` once the
//                             repair has been written (sealBackup).
//   rollbackRepair(dir, {force}) restores the LATEST backup. The current log must still begin with the bytes the repair wrote
//                             over it (a prefix check: a different history is not ours to overwrite), and must hold nothing
//                             after what the repair wrote (`after.size`), else it refuses: a rollback drops every line after
//                             the backup, and later writes would be lost. --force restores anyway. Verified after the copy:
//                             size and sha256 equal the manifest's `before`, or it throws.
// The repair itself is the authority's (shared/protocol/authority.js repairShapes): this file only moves bytes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const BACKUPS = "repair-backups";
const LOG = "world.jsonl";
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const measure = (f: string) => { const b = fs.readFileSync(f); return { size: b.length, sha256: sha256(b) }; };

export type Manifest = { stamp: string; command: string; by?: string | null; before: { size: number; sha256: string }; after?: { size: number; sha256: string } };

/** Copy the log before a repair touches it. Returns the backup directory. */
export function backupBeforeRepair(dir: string, { by = null as string | null, command = "repair-shapes" } = {}): string {
  const log = path.join(dir, LOG);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(dir, BACKUPS, stamp);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(log, path.join(out, LOG));
  const before = measure(path.join(out, LOG));
  if (before.sha256 !== measure(log).sha256) throw new Error(`the backup of ${log} doesn't match the file (it changed while being copied)`);
  const m: Manifest = { stamp, command, by, before };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 1) + "\n");
  return out;
}
/** Record what the repair left in the log, so a rollback can tell later writes from the repair's own. */
export function sealBackup(backupDir: string) {
  const f = path.join(backupDir, "manifest.json"); const m: Manifest = JSON.parse(fs.readFileSync(f, "utf8"));
  m.after = measure(path.join(backupDir, "..", "..", LOG));
  fs.writeFileSync(f, JSON.stringify(m, null, 1) + "\n");
  return m;
}
/** Remove a backup whose repair never wrote (nothing to roll back). */
export function dropBackup(backupDir: string) { fs.rmSync(backupDir, { recursive: true, force: true }); }

export function latestBackup(dir: string): string | null {
  const d = path.join(dir, BACKUPS); if (!fs.existsSync(d)) return null;
  const stamps = fs.readdirSync(d).filter((s) => fs.existsSync(path.join(d, s, "manifest.json"))).sort();
  return stamps.length ? path.join(d, stamps[stamps.length - 1]) : null;
}

export type Rollback = { ok: true; restored: { size: number; sha256: string }; backup: string; dropped: number } | { ok: false; why: string; backup?: string };
/** Put the latest backup's log back, byte-identical, or say why not. */
export function rollbackRepair(dir: string, { force = false } = {}): Rollback {
  const b = latestBackup(dir); if (!b) return { ok: false, why: `no repair backup under ${path.join(dir, BACKUPS)}: nothing to roll back` };
  const m: Manifest = JSON.parse(fs.readFileSync(path.join(b, "manifest.json"), "utf8"));
  const log = path.join(dir, LOG); const now = fs.readFileSync(log);
  const saved = fs.readFileSync(path.join(b, LOG));
  if (sha256(saved) !== m.before.sha256 || saved.length !== m.before.size) return { ok: false, backup: b, why: `the backup's bytes don't match its manifest (${b}): refusing to restore from it` };
  if (now.length < saved.length || sha256(now.subarray(0, saved.length)) !== m.before.sha256) {
    if (!force) return { ok: false, backup: b, why: `the current log no longer begins with the bytes the repair wrote over (a different history, or already rolled back): refusing; --force restores the backup anyway` }; }
  if (m.after && now.length > m.after.size && !force) return { ok: false, backup: b, why: `the log has grown since the repair (${now.length} bytes, ${m.after.size} right after it): ${now.length - m.after.size} bytes of later writes would be lost. --force restores anyway` };
  if (m.after && now.length === m.after.size && sha256(now) !== m.after.sha256 && !force) return { ok: false, backup: b, why: `the log was rewritten since the repair (same size, different bytes): refusing; --force restores anyway` };
  const tmp = log + ".rollback-tmp"; fs.copyFileSync(path.join(b, LOG), tmp); fs.renameSync(tmp, log);
  const got = measure(log);
  if (got.sha256 !== m.before.sha256 || got.size !== m.before.size) throw new Error(`rollback wrote ${log} but it doesn't match the backup (${got.sha256} vs ${m.before.sha256})`);
  return { ok: true, restored: got, backup: b, dropped: now.length - saved.length };
}
