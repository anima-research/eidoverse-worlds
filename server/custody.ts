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
/** Whether the process named in a lock file has exited (same host: the keys file is local). An unreadable or empty lock
 *  is being written by its holder, so it isn't gone. */
function lockHolderGone(lock: string): boolean {
  let pid: number;
  try { pid = Number(fs.readFileSync(lock, "utf8")); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
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
  // the mint and the write therefore run holding `<file>.lock`, made with O_EXCL: a process waits for it, and takes over
  // one whose holder has exited.
  const lock = `${file}.lock`;
  const minting = (missing: () => boolean, mint: () => void) => {
    if (!missing()) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const wait = new Int32Array(new SharedArrayBuffer(4)); const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { const fd = fs.openSync(lock, "wx", 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (lockHolderGone(lock)) { try { fs.unlinkSync(lock); } catch { /* another waiter took it over first */ } continue; }
        if (Date.now() > until) throw new Error(`custody: ${lock} has been held for ${LOCK_WAIT_MS / 1000} s; if no process is minting a key, remove it`);
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    try { sync(); if (missing()) { mint(); save(); } } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
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
