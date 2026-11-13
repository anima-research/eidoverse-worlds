// server/custodycheck.ts — custody at startup and in backups (docs/DESIGN-log-vocabulary.md §F F-5): the live sequencer key is
// verified against genesis (or the latest governance handoff) without minting; a mismatch serves the world read-only; a backup
// manifest records the key fingerprints and the custody file's hash, and is checked from its written bytes when the backup is
// made. No restore path reads it yet (notes WISHLIST, restore-path custody check): restoration is not verified by this.
import fs from "node:fs";
import crypto from "node:crypto";

type Key = { pub: string; priv?: string };
type CustodyFile = { sequencer?: Key; operator?: Key; holders?: Record<string, Key> };
export type CustodyVerdict = { ok: true; sequencer: string } | { ok: false; why: string; expected: string | null; held: string | null };

/** The custody file as stored, never minting (a missing file is {}). */
export function readCustody(file: string): CustodyFile { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}; }
/** The key a world's log says signs it: genesis's sequencer, or the latest governance handoff's key. `from`: the first line a
 *  tail boot holds (server/lazylog.ts); a cache is never written over a governance entry, so the prefix needs no scan. */
export function expectedSequencer(entries: any[], from = 0): string | null {
  let key = entries[0]?.kind === "genesis" ? entries[0].body?.sequencer ?? null : null;
  for (let s = Math.max(from, 1); s < entries.length; s++) { const e = entries[s]; if (e && e.kind === "governance" && typeof e.body?.key === "string") key = e.body.key; }
  return key;
}
/** Does the custody file hold the key the log names? Read-only when not; a world with no genesis yet is fine (founding mints). */
export function custodyVerdict(file: string, entries: any[], from = 0): CustodyVerdict {
  const expected = expectedSequencer(entries, from); if (!expected) return { ok: true, sequencer: "" };
  const held = readCustody(file).sequencer?.pub ?? null;
  if (held === expected) return { ok: true, sequencer: held };
  return { ok: false, expected, held, why: held ? `the custody file's sequencer key is not the one this world's log names` : `the custody file ${fs.existsSync(file) ? "holds no sequencer key" : "is missing"}` };
}
/** A custody that answers reads from the file and refuses every write: what a mismatched world is served with. Never mints. */
export function readOnlyCustody(file: string, why: string) {
  const c = readCustody(file); const no = (): never => { throw new Error(`read-only: ${why}`); };
  return { sequencer: () => c.sequencer?.pub ?? "", operator: () => c.operator?.pub ?? "", keyOf: (who: string) => c.holders?.[who]?.pub ?? null,
    sign: no, signOperator: no, secret: no, readOnly: why };
}

export const MANIFEST = "CUSTODY.json";
const fp = (pub: string | undefined) => pub ? crypto.createHash("sha256").update(pub).digest("hex") : null;
export type BackupManifest = { sequencer: string | null; operator: string | null; custodySha256: string | null };
/** What a backup records of the keys that governed the world: fingerprints (never the keys) and the custody file's hash. */
export function backupManifestOf(custodyFile: string): BackupManifest {
  const c = readCustody(custodyFile);
  return { sequencer: fp(c.sequencer?.pub), operator: fp(c.operator?.pub), custodySha256: fs.existsSync(custodyFile) ? crypto.createHash("sha256").update(fs.readFileSync(custodyFile)).digest("hex") : null };
}
/** Why `m` is not a complete backup manifest, or (with the live custody file) why it is not this custody's; null when it checks.
 *  The custody comparison reads the file itself, never through backupManifestOf: a builder defect (a swapped or wrong
 *  fingerprint, a stale hash) is caught, not repeated. */
export function checkBackupManifest(m: unknown, custodyFile?: string): string | null {
  const x = m as BackupManifest; const hex = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  if (!x || typeof x !== "object") return `${MANIFEST} is missing or not an object`;
  if (!hex(x.sequencer) || !hex(x.operator)) return `${MANIFEST} records no sequencer/operator fingerprints`;
  if (!hex(x.custodySha256)) return `${MANIFEST} records no custody file hash`;
  if (custodyFile) { const bytes = fs.readFileSync(custodyFile); const c = JSON.parse(bytes.toString("utf8")) as CustodyFile;
    const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
    if (sha(String(c.sequencer?.pub ?? "")) !== x.sequencer || sha(String(c.operator?.pub ?? "")) !== x.operator) return `${MANIFEST} names other keys than the live custody file`;
    if (sha(bytes) !== x.custodySha256) return `${MANIFEST} records another custody file's hash than the live one`; }
  return null;
}
