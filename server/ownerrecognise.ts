// server/ownerrecognise.ts — is this signed-in account one of an old-format world's owners (R 10-28)? One pure rule over the
// owners the old log names (tools/protocol/import-v1/world.ts oldOwners), read by the translation's --claim and by the
// access index (worldindex.ts), so a join, /access or upgrade request never reads the old log to answer it.
// Watch for deletion: operators usually choose which engine is served; see WISHLIST 'Owner self-upgrade of old worlds'.
import { foldName } from "./directory.ts";

/** One owner of an old world: its name, the account main's records bind it to (null: none), how main bound it, and the
 *  accounts main's records give that name (mainSubs). */
export type OldOwner = { name: string; account: string | null; unbound: string; mainSubs: string[] };
export type Recognised = { recognised: "bound" | "name" | null; owner?: string; ownerless: boolean; why?: string };

/** "bound": main's records bind an owner to exactly this account; "name": an owner main recorded NO account for has this
 *  name, as the directory folds names (provisional: an alpha risk the owner accepted, until durable accounts), when main
 *  never bound that name to another account and only one account here holds it; else null, and why. `accountsNamed`: the
 *  directory's accounts holding a name. `ownerless`: the world has no owner at all (the upgrader claims it). */
export function recogniseOwner(owners: OldOwner[], account: string | null, name: string | null, accountsNamed: (name: string) => string[]): Recognised {
  const ownerless = owners.length === 0;
  if (!account) return { recognised: null, ownerless, why: "not signed in" };
  if (ownerless) return { recognised: null, ownerless, why: "the world has no owner: an operator upgrades it and becomes its owner" };
  const bound = owners.find((o) => o.account !== null && o.account === account);
  if (bound) return { recognised: "bound", owner: bound.name, ownerless };
  const named = name ? owners.find((o) => o.unbound === "none" && foldName(o.name) === foldName(name)) : undefined;   // the directory's one rule for a name (accountsNamed)
  if (named) {
    if (named.mainSubs.some((s) => s !== account)) return { recognised: null, ownerless, why: `main's records bind the owner ${named.name} to another account: that account is the owner` };
    // a local:<name> (TRUST_NAMES) is the name itself, not another person holding it
    if (accountsNamed(name!).some((s) => s !== account && !s.startsWith("local:"))) return { recognised: null, ownerless, why: `the name ${name} is held by more than one account on this server: which one is the owner isn't guessed` };
    return { recognised: "name", owner: named.name, ownerless }; }
  const several = name ? owners.find((o) => o.unbound === "several" && foldName(o.name) === foldName(name)) : undefined;
  return { recognised: null, ownerless, why: several ? `main recorded several accounts for the owner ${several.name}: which one is yours isn't guessed` : "main's records don't make this account one of the world's owners" };
}
