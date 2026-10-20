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
  return {
    sequencer(): string { if (!c.sequencer) { sync(); if (!c.sequencer) { c.sequencer = mk(); save(); } } return c.sequencer.pub; },
    /** The operator's GOVERNANCE key (tier 1 of the custodial default, §2.4): never the same key as the sequencer, so a
     *  stolen writing key isn't also the only override (round-2 review R4). */
    operator(): string { if (!c.operator) { sync(); if (!c.operator) { c.operator = mk(); save(); } } return c.operator.pub; },
    /** The OPERATOR's signature over msg (base64url Ed25519 by the operator key above, never the sequencer's): the host's
     *  COUNTERSIGNATURE on a translation approval (tools/protocol/world.ts approvalFor; PROTOCOL §14). */
    signOperator(msg: string): string {
      if (!c.operator) { sync(); if (!c.operator) { c.operator = mk(); save(); } }
      const key = crypto.createPrivateKey({ key: Buffer.from(c.operator.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
    keyOf(who: string, make = false): string | null { if (!c.holders[who] && make) { sync(); if (!c.holders[who]) { c.holders[who] = mk(); save(); } } return c.holders[who]?.pub ?? null; },
    /** §2.4 chain point: base64url Ed25519 over msg ("eidoverse-head:<world id>:<seq>:<head hex>") by the sequencer key. */
    sign(msg: string): string {
      if (!c.sequencer) { sync(); if (!c.sequencer) { c.sequencer = mk(); save(); } }
      const key = crypto.createPrivateKey({ key: Buffer.from(c.sequencer.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
  };
}

/** A world's moderator log (§2.1: never in the world log): read it, and append one record per line. */
export function modLogAt(file: string) {
  const mod = fs.existsSync(file) ? readLogBytes(file).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { mod, appendMod: (r: object) => { appendDurable(file, JSON.stringify(r)); } };
}
