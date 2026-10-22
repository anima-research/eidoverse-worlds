// server/custody.ts — the authority's governance keys (PROTOCOL §2.4, §3d C1), held outside every log.
// One sequencer key per keys file, and one key per identity that founds a world through this server, so two worlds one
// person founds here carry the same keys and only genesis's nonce tells them apart. Keys never enter a log; the file
// is written 0600. Same layout and key encoding as the lab's custody (the protocol lab's authority.js custodyOf).
import { appendDurable, readLogBytes } from "./durable.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Key = { pub: string; priv: string };
type File = { sequencer?: Key; operator?: Key; holders: Record<string, Key> };

/** How long a mint waits for another process's mint to finish before it gives up. */
const LOCK_WAIT_MS = 10_000;
/** Who holds a lock file: the pid and the nonce its taker wrote (`<pid> <nonce>`), or null when it can't be read. */
function holderOf(f: string): { pid: number; nonce: string } | null {
  let s: string; try { s = fs.readFileSync(f, "utf8"); } catch { return null; }
  const [p, nonce] = s.split(" "); const pid = Number(p);
  return Number.isInteger(pid) && pid > 0 && /^[0-9a-f]{16}$/.test(nonce ?? "") ? { pid, nonce } : null;
}
/** Whether process `pid` has exited (same host: the keys file is local). */
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Takes the lock file `name` for this process, or returns null when another holds it. The pid and a nonce never used
 *  before are written to a file of their own and synced, and only then linked to `name`, so `name` never exists without
 *  its holder, even after a power loss. Returns the nonce. */
function take(name: string): string | null {
  const nonce = crypto.randomBytes(8).toString("hex"), tmp = `${name}.${nonce}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, `${process.pid} ${nonce}`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, name); return nonce; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
}
/** Removes the lock file `f` if its holder has exited, as one step. Two waiters can both see the same dead holder, so the
 *  one that removes it first takes `<lock>.<its nonce>`, the right to remove that one lock, and removes `f` only if `f`
 *  still holds that nonce. A nonce is never reused, so a lock that has since replaced it is never removed. A right whose
 *  holder exited before giving it back is removed the same way. Whether it removed `f`. */
function clearIfGone(lock: string, f: string): boolean {
  const h = holderOf(f); if (!h || !exited(h.pid)) return false;
  const right = `${lock}.${h.nonce}`;
  if (!take(right)) { clearIfGone(lock, right); return false; }
  try { if (holderOf(f)?.nonce !== h.nonce) return false; fs.unlinkSync(f); return true; } finally { fs.rmSync(right, { force: true }); }
}

const mk = (): Key => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: "ed25519:" + (publicKey.export({ format: "jwk" }) as { x: string }).x, priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
};

/** One custody per keys file per process (review of #260, server I5): every world under a worlds root opens the same file,
 *  and separate handles, each with its own cache, each minting a missing key and writing its whole cache back, overwrote
 *  one another's keys. */
const byFile = new Map<string, ReturnType<typeof openCustody>>();
/** Custody over the keys file at `file` (created on first use). */
export function custodyAt(file: string) {
  const k = path.resolve(file); let h = byFile.get(k);
  if (!h) { h = openCustody(k); byFile.set(k, h); }
  return h;
}
function openCustody(file: string) {
  const c: File = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { holders: {} };
  // before minting, take what another process (the found / translate tools) wrote since: a key minted here must never
  // replace one already on disk
  const sync = () => { if (!fs.existsSync(file)) return; const d = JSON.parse(fs.readFileSync(file, "utf8")) as File;
    c.sequencer ??= d.sequencer; c.operator ??= d.operator; c.holders = { ...(d.holders ?? {}), ...c.holders }; };
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600); };
  // A mint reads the file, adds a key and writes the whole file back, so two processes minting at once (the server and a
  // found / translate tool) would each write back what it read and the later rename would drop the other's key. The read,
  // the mint and the write therefore run holding `<file>.lock` (take above): a process waits for it, and removes one whose
  // holder has exited (clearIfGone above).
  const lock = `${file}.lock`;
  const minting = (missing: () => boolean, mint: () => void) => {
    if (!missing()) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const wait = new Int32Array(new SharedArrayBuffer(4)); const until = Date.now() + LOCK_WAIT_MS;
    while (!take(lock)) {
      if (clearIfGone(lock, lock)) continue;
      if (Date.now() > until) { const h = holderOf(lock);
        throw new Error(`custody: ${lock} has been held${h ? ` by process ${h.pid}` : ""} for ${LOCK_WAIT_MS / 1000} s; if no process is minting a key, remove it`); }
      Atomics.wait(wait, 0, 0, 10);
    }
    // only this process removes its own lock: another removes a lock only once its holder has exited
    try { sync(); if (missing()) { mint(); save(); } } finally { fs.rmSync(lock, { force: true }); }
  };
  return {
    sequencer(): string { minting(() => !c.sequencer, () => { c.sequencer = mk(); }); return c.sequencer!.pub; },
    /** The operator's GOVERNANCE key (tier 1 of the custodial default, §2.4): never the same key as the sequencer, so a
     *  stolen writing key isn't also the only override (round-2 review R4). */
    operator(): string { minting(() => !c.operator, () => { c.operator = mk(); }); return c.operator!.pub; },
    /** The OPERATOR's signature over msg (base64url Ed25519 by the operator key above, never the sequencer's): the host's
     *  COUNTERSIGNATURE on a translation approval (tools/protocol/world.ts approvalFor; PROTOCOL §14). */
    signOperator(msg: string): string {
      minting(() => !c.operator, () => { c.operator = mk(); });
      const key = crypto.createPrivateKey({ key: Buffer.from(c.operator!.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
    keyOf(who: string, make = false): string | null { if (make) minting(() => !c.holders[who], () => { c.holders[who] = mk(); }); return c.holders[who]?.pub ?? null; },
    /** §2.4 chain point: base64url Ed25519 over msg ("eidoverse-head:<world id>:<seq>:<head hex>") by the sequencer key. */
    sign(msg: string): string {
      minting(() => !c.sequencer, () => { c.sequencer = mk(); });
      const key = crypto.createPrivateKey({ key: Buffer.from(c.sequencer!.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
  };
}

/** A world's moderator log (§2.1: never in the world log): read it, and append one record per line. */
export function modLogAt(file: string) {
  // read as a reader; the first append repairs a torn tail first, as the log's writer (review of #260, server I127)
  const mod = fs.existsSync(file) ? readLogBytes(file, { cut: false }).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let repaired = false;
  return { mod, appendMod: (r: object) => { if (!repaired) { readLogBytes(file); repaired = true; } appendDurable(file, JSON.stringify(r)); } };
}
