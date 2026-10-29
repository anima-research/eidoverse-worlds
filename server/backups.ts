// server/backups.ts — a world directory's verified copy, made before an in-place upgrade (docs/TRANSLATING-OLD-WORLDS.md, "Backups").
// One path for the CLI (tools/protocol/world.ts translate) and the server's operator upgrade (which runs that CLI).
// A backup is written once and never again: nothing here, and nothing that calls it, writes to one afterwards.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BACKUPS_DIR } from "./config.ts";
import { isCacheFile } from "./statecache.ts";
import { mkdirDurable, syncDir, syncTree } from "./durable.ts";

const NAME = /^[a-z0-9_-]{1,64}$/i;
export const SUMS = "SHA256SUMS";
export type Backup = { dir: string; files: number; bytes: number };

/** sha256 of a file, read in chunks (a world's log can be large). */
export function hashFile(p: string): string {
  const h = crypto.createHash("sha256"), buf = Buffer.allocUnsafe(1 << 20), fd = fs.openSync(p, "r");
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
const inside = (dir: string, parent: string) => { const r = path.relative(path.resolve(parent), path.resolve(dir)); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
/** Why backups can't go to `backupsDir` for `worldsDir`, or null. */
export function backupsDirProblem(worldsDir: string, backupsDir = BACKUPS_DIR): string | null {
  return inside(backupsDir, worldsDir) ? `BACKUPS_DIR (${backupsDir}) is inside WORLDS_DIR (${worldsDir}), where every directory is served as a world: point BACKUPS_DIR beside it (the default is backups/ next to the worlds directory)` : null;
}
/** UTC yyyymmddThhmmssZ */
export const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Every file under `d` as relative paths with "/" (a symlink or anything that isn't a file or directory is refused). */
function filesUnder(d: string, at = ""): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(path.join(d, at)).sort()) { const rel = at ? `${at}/${f}` : f; const st = fs.lstatSync(path.join(d, rel));
    if (st.isDirectory()) out.push(...filesUnder(d, rel)); else if (st.isFile()) out.push(rel); else throw new Error(`${path.join(d, rel)} is not a plain file or directory (a link?): it can't be copied byte for byte`); }
  return out;
}

/** Copy WORLDS_DIR/<name>/ byte for byte to <backupsDir>/<name>-<stamp>/ with SHA256SUMS, then re-read and verify every hash
 *  (the copy against the original, and the original against what was copied). Throws, in words, on any copy error or
 *  mismatch, removing the incomplete copy (it never became a backup). `afterCopy`: tests only, runs before the verify. */
export function backupWorld(worldsDir: string, name: string, { backupsDir = BACKUPS_DIR, now = new Date(), afterCopy }: { backupsDir?: string; now?: Date; afterCopy?: (dir: string) => void } = {}): Backup {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a world name`);
  const bad = backupsDirProblem(worldsDir, backupsDir); if (bad) throw new Error(bad);
  const src = path.join(worldsDir, name);
  if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`there is no world directory ${src} to back up`);
  mkdirDurable(backupsDir);
  let dir = path.join(backupsDir, `${name}-${stampOf(now)}`);
  for (let k = 2; fs.existsSync(dir); k++) dir = path.join(backupsDir, `${name}-${stampOf(now)}-${k}`);
  fs.mkdirSync(dir);
  try {
    const files = filesUnder(src).filter((f) => !isCacheFile(f)); const sums: Record<string, string> = {}; let bytes = 0;
    if (files.includes(SUMS)) throw new Error(`${src} holds a file named ${SUMS}, the name the backup's own list takes`);
    for (const rel of files) { const a = path.join(src, rel), b = path.join(dir, rel);
      fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b);
      const st = fs.statSync(a); fs.utimesSync(b, st.atime, st.mtime); sums[rel] = hashFile(a); bytes += st.size; }
    fs.writeFileSync(path.join(dir, SUMS), files.map((rel) => `${sums[rel]}  ${rel}\n`).join(""));
    afterCopy?.(dir);
    // verify: the list as written, every copy against it, and the original still the bytes that were copied
    const listed = fs.readFileSync(path.join(dir, SUMS), "utf8").split("\n").filter(Boolean).map((l) => /^([0-9a-f]{64}) {2}(.+)$/.exec(l));
    if (listed.length !== files.length || listed.some((m, i) => !m || m[2] !== files[i] || m[1] !== sums[files[i]])) throw new Error(`the backup's ${SUMS} doesn't read back as written`);
    const copied = filesUnder(dir).filter((f) => f !== SUMS);
    if (copied.join("\n") !== files.join("\n")) throw new Error(`the backup holds ${copied.length} file(s), the world ${files.length}`);
    for (const rel of files) {
      const h = hashFile(path.join(dir, rel)); if (h !== sums[rel]) throw new Error(`the backup's copy of ${rel} doesn't match the original (sha256 ${h.slice(0, 16)}…, the original ${sums[rel].slice(0, 16)}…)`);
      const o = hashFile(path.join(src, rel)); if (o !== sums[rel]) throw new Error(`${rel} changed while it was being backed up (something is still writing to the world: stop it first)`); }
    syncTree(dir); syncDir(backupsDir);   // copyFileSync syncs nothing: on disk before anything moves (review L5)
    return { dir, files: files.length, bytes };
  } catch (x) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* named below */ }
    throw new Error(`the backup of "${name}" failed and was removed: ${(x as Error).message}`);
  }
}
