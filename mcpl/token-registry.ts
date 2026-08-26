import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type TokenAuth = {
  id: string; name: string; world?: string; avatar?: string;
  /** Existing-world travel policy ("*" = any existing world). */
  worlds?: string[];
  /** Founding authority is separate from travel policy. */
  create?: boolean;
};

type Log = Pick<Console, "error" | "warn">;

function readObject(path: string): Record<string, TokenAuth> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("root must be a JSON object");
  }
  return parsed as Record<string, TokenAuth>;
}

/**
 * Read the legacy token registry fail-closed.
 *
 * The tracked example file is public. Any key copied from it is deliberately
 * rejected even when it appears in tokens.json; examples document shape, not
 * grant authority. Missing or malformed live registries authorize nobody.
 */
export function readTokenRegistry(tokensPath: string, examplePath: string, log: Log = console): Record<string, TokenAuth> {
  if (!existsSync(tokensPath)) {
    log.error(`[mcpl] token registry missing: ${tokensPath}; legacy token auth disabled`);
    return {};
  }

  let live: Record<string, TokenAuth>;
  try {
    live = readObject(tokensPath);
  } catch (error) {
    log.error(`[mcpl] token registry unreadable: ${(error as Error).message}; legacy token auth disabled`);
    return {};
  }

  if (!existsSync(examplePath)) {
    log.error(`[mcpl] example token registry missing: ${examplePath}; refusing legacy token auth`);
    return {};
  }

  let exampleKeys: Set<string>;
  try {
    exampleKeys = new Set(Object.keys(readObject(examplePath)));
  } catch (error) {
    log.error(`[mcpl] example token registry unreadable: ${(error as Error).message}; refusing legacy token auth`);
    return {};
  }

  // Null-prototype map: an attacker-controlled token such as `__proto__` or
  // `constructor` must never resolve through Object.prototype.
  const accepted: Record<string, TokenAuth> = Object.create(null);
  for (const [token, candidate] of Object.entries(live)) {
    const digest = createHash("sha256").update(token).digest("hex").slice(0, 12);
    if (exampleKeys.has(token)) {
      const id = candidate && typeof candidate === "object" && typeof candidate.id === "string" ? candidate.id : "unknown";
      log.warn(`[mcpl] rejected public example credential sha256:${digest} id=${id}`);
      continue;
    }
    const auth = candidate as Partial<TokenAuth> | null;
    if (!auth || typeof auth !== "object" || typeof auth.id !== "string" || !auth.id) {
      log.error(`[mcpl] token registry entry sha256:${digest} has no usable string id — ignored`);
      continue;
    }
    accepted[token] = {
      id: auth.id,
      name: typeof auth.name === "string" && auth.name ? auth.name : auth.id,
      world: typeof auth.world === "string" ? auth.world : undefined,
      avatar: typeof auth.avatar === "string" ? auth.avatar : undefined,
      // RFC-005 travel/founding fields survive the fail-closed registry seam.
      // Travel to an existing world and permission to found one are distinct.
      worlds: Array.isArray(auth.worlds)
        ? auth.worlds.filter((world): world is string => typeof world === "string")
        : undefined,
      create: typeof auth.create === "boolean" ? auth.create : undefined,
    };
  }
  return accepted;
}
/** Look up an attacker-controlled credential as an OWN registry key only. */
export function lookupToken(registry: Record<string, TokenAuth>, token: string): TokenAuth | undefined {
  return Object.hasOwn(registry, token) ? registry[token] : undefined;
}
