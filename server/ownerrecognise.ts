// server/ownerrecognise.ts — is this signed-in account one of an old-format world's owners? One pure rule over the owners the
// old log names (tools/import-v1/world.ts oldOwners), shared by the translation's --claim and the access index (worldindex.ts).
import { foldName } from "./directory.ts";

/** One owner of an old world: its name, the account main's records bind it to (null: none), how, and every account main gave that name. */
export type OldOwner = { name: string; account: string | null; unbound: string; mainSubs: string[] };
export type Recognised = { recognised: "bound" | "name" | null; owner?: string; ownerless: boolean; why?: string };

/** "bound": main binds an owner to this very account; "name": an owner main recorded no account for has this name (directory
 *  folding) and only this account here holds it; else null, with why. `ownerless`: no owner at all (the upgrader claims it). */
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
