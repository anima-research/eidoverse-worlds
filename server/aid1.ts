// aid1 verification: a self-contained copy of archipelago-home's verifier (src/token.ts + src/keys.ts; re-copy if the format
// changes, never fork it). A credential is `aid1.<b64url payload>.<b64url ed25519 sig>`, the signature over the literal
// `aid1.<payload>` bytes, verified offline against the issuer's pinned public key.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const TOKEN_PREFIX = "aid1";

export type PrincipalKind = "human" | "agent" | "service";

export interface Aid1Payload {
  v: 1;
  iss: string;
  /** Durable principal id as the issuer signed it, e.g. `human:discord:<snowflake>` / `agent:<name>@<domain>`; /auth takes any `human:` one (server/routes.ts). */
  sub: string;
  kind: PrincipalKind;
  name: string;
  aud: string;
  scopes: string[];
  claims?: Record<string, unknown>;
  iat: number;
  exp: number;
  jti?: string;
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function b64urlToBuf(s: string): Buffer | null {
  try {
    if (typeof s !== "string" || /[^A-Za-z0-9_-]/.test(s)) return null;
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
}

export type VerifyOutcome = { ok: true; payload: Aid1Payload } | { ok: false; reason: string };

/** The handle slug every door derives from an aid1 identity, so an agent is the same person whichever door it walks through.
 *  `sub` is the fallback for a name that slugs to nothing. */
export function aid1Slug(payload: Aid1Payload): string {
  return payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || payload.sub;
}

export interface VerifyOpts {
  /** Issuer public key `ed25519:<b64url raw 32B>`. */
  issuerId: string;
  iss: string;
  aud: string;
  requireScopes?: string[];
  nowMs?: number;
}

export function verifyToken(token: string, opts: VerifyOpts): VerifyOutcome {
  const fail = (reason: string): VerifyOutcome => ({ ok: false, reason });
  if (typeof token !== "string") return fail("not a string");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return fail("not an aid1 token");
  const [, seg, sigSeg] = parts as [string, string, string];

  if (!opts.issuerId.startsWith("ed25519:")) return fail("malformed issuer key");
  const rawKey = b64urlToBuf(opts.issuerId.slice("ed25519:".length));
  if (!rawKey || rawKey.length !== 32) return fail("malformed issuer key");
  const sig = b64urlToBuf(sigSeg);
  if (!sig || sig.length !== 64) return fail("malformed signature");
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawKey]), format: "der", type: "spki" });
    if (!cryptoVerify(null, Buffer.from(`${TOKEN_PREFIX}.${seg}`, "utf8"), key, sig)) {
      return fail("signature verify failed");
    }
  } catch {
    return fail("signature verify failed");
  }

  const segBuf = b64urlToBuf(seg);
  if (!segBuf) return fail("malformed payload segment");
  let payload: Aid1Payload;
  try {
    payload = JSON.parse(segBuf.toString("utf8")) as Aid1Payload;
  } catch {
    return fail("payload not JSON");
  }
  if (payload.v !== 1) return fail("unsupported version");
  if (payload.iss !== opts.iss) return fail(`issuer mismatch (${payload.iss})`);
  if (payload.aud !== opts.aud) return fail(`audience mismatch (${payload.aud})`);
  if (typeof payload.sub !== "string" || !payload.sub) return fail("missing sub");
  if (typeof payload.name !== "string" || !payload.name) return fail("missing name");
  if (!Array.isArray(payload.scopes) || !payload.scopes.every((s) => typeof s === "string")) {
    return fail("malformed scopes");
  }
  const now = (opts.nowMs ?? Date.now()) / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= now) return fail("expired");
  if (typeof payload.iat !== "number" || payload.iat > now + 300) return fail("iat in the future");
  for (const s of opts.requireScopes ?? []) {
    if (!payload.scopes.includes(s)) return fail(`missing scope ${s}`);
  }
  return { ok: true, payload };
}

/** Single-use guard for login-redirect tokens; a restart forgets them, which the token's own 10-minute exp covers. */
export class JtiCache {
  private seen = new Map<string, number>();

  claim(jti: string, expUnixSec: number, nowMs = Date.now()): boolean {
    const now = nowMs / 1000;
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, expUnixSec);
    return true;
  }
}
