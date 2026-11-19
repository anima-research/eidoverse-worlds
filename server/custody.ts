// server/custody.ts — the authority's governance keys (spec/PROTOCOL.md §2.4, §3d C1), held outside every log, 0600.
// One sequencer key per keys file, and one key per identity founding a world through this server.
import { appendDurable, readLogBytes, replaceDurable, mkdirDurable, withFileLock } from "./durable.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { envNumber } from "./limits.ts";

type Key = { pub: string; priv: string };
type File = { sequencer?: Key; operator?: Key; holders: Record<string, Key> };

/** How long a mint waits for another process's mint to finish before it gives up. */
const LOCK_WAIT_MS = envNumber("EIDO_CUSTODY_LOCK_WAIT_MS", 10_000, (n) => n > 0);
const mk = (): Key => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: "ed25519:" + (publicKey.export({ format: "jwk" }) as { x: string }).x, priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
};

/** A host secret for `purpose` from a sequencer key's private bytes: what secret() below returns, from the stored key alone. */
export const secretOf = (priv: string, purpose: string): Buffer =>
  crypto.createHmac("sha256", Buffer.from(priv, "base64")).update(`eidoverse-secret:${purpose}`).digest();

/** One custody per keys file per process: every world under a worlds root opens the same file, and separate handles
 *  (each caching, minting and writing its whole cache back) would overwrite one another's keys. */
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
  // durably: a key handed out must survive a crash, or the genesis it signed (already synced) names a key no one holds
  const save = () => replaceDurable(file, JSON.stringify(c, null, 1), 0o600);
  // a mint writes the whole file back, so two processes minting at once would drop each other's keys: read, mint and
  // write run under `<file>.lock` (durable.ts withFileLock)
  const lock = `${file}.lock`;
  const minting = (missing: () => boolean, mint: () => void) => {
    if (!missing()) return;
    mkdirDurable(path.dirname(file));   // the keys file's directory is named in its parent, which a crash can lose too
    withFileLock(lock, LOCK_WAIT_MS, () => {
      sync();
      if (missing()) {
        const was = { sequencer: c.sequencer, operator: c.operator, holders: { ...c.holders } };
        mint();
        try { save(); } catch (e) { Object.assign(c, was); throw e; }
      }
    });
  };
  return {
    sequencer(): string { minting(() => !c.sequencer, () => { c.sequencer = mk(); }); return c.sequencer!.pub; },
    /** The operator's GOVERNANCE key (tier 1 of the custodial default, §2.4): never the same key as the sequencer, so a
     *  stolen writing key isn't also the only override. */
    operator(): string { minting(() => !c.operator, () => { c.operator = mk(); }); return c.operator!.pub; },
    /** The OPERATOR's signature over msg (base64url Ed25519 by the operator key above, never the sequencer's): the host's
     *  COUNTERSIGNATURE on a translation approval (tools/world.ts approvalFor; PROTOCOL §14). */
    signOperator(msg: string): string {
      minting(() => !c.operator, () => { c.operator = mk(); });
      const key = crypto.createPrivateKey({ key: Buffer.from(c.operator!.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
    /** This host's secret for `purpose` (HMAC-SHA256 keyed by the sequencer's private bytes): the same on every run here, never
     *  the key itself, and nothing another host can derive (tools/import-v1/world.ts identitySalt). */
    secret(purpose: string): Buffer {
      minting(() => !c.sequencer, () => { c.sequencer = mk(); });
      return secretOf(c.sequencer!.priv, purpose);
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
  // read as a reader; the first append repairs a torn tail first, as the log's writer
  const mod = fs.existsSync(file) ? readLogBytes(file, { cut: false }).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let repaired = false;
  return { mod, appendMod: (r: object) => { if (!repaired) { readLogBytes(file); repaired = true; } appendDurable(file, JSON.stringify(r)); } };
}
