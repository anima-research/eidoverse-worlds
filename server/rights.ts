// eidoverse-worlds sequencer — the rights ladder (TEL0S_NOTES §15, step 7a).
// Everything here reads only the FOLDED state (state.roles / state.entities),
// so the signatures take a WorldState rather than the server's World — the
// cycle break §15.1 pinned: rights never needs the session, and no module
// here may import server.ts.

import { ROLE_RANK, type WorldState } from "../shared/fold.js";
// The precedence rule itself lives in shared/ so the browser and the mcpl
// agent can compute the SAME answer instead of each hand-rolling a merge --
// which is how one erased its own `fly` and the other never updated at all.
import { rightsIn, worldHasOwnerIn } from "../shared/rightsfold.js";

// ---------------------------------------------------------------- permissions
//
// Per-world roles, aligned with connectome/docs/home-node.md: the id in the
// roles map is the principal — today a self-asserted name (humans) or a
// token-verified agent name; when archipelago-home lands, aid1 `sub`s slot in
// here without the model changing. Rights ladder:
//   visitor  present, talk, emote           (say)
//   builder  + spawn / place / remove / drag         (build)
//   owner    + terrain / grass / sky / weather / grant  (shape the world)
//   gen      orthogonal capability: introduce NEW assets (`asset` verb) —
//            the landing point of Orrery generations, i.e. "spend".
// A world with no owner is OPEN: everyone is builder+gen (pre-permissions
// behaviour; scratch worlds stay frictionless). First embodied joiner of a
// brand-new world is auto-granted owner. The ladder itself (ROLE_RANK) is
// protocol (§7) and lives in shared/fold.js — imported above.
// Operators (comma-separated ids) who are owner+gen EVERYWHERE — the
// bootstrap for pre-permissions worlds and the lockout recovery.
export const ADMIN_IDS = new Set((process.env.WORLD_ADMIN ?? "").split(",").map((s) => s.trim()).filter(Boolean));

export function worldHasOwner(st: WorldState): boolean {
  return worldHasOwnerIn(st as any);
}
export function rightsOf(state: WorldState, id: string, sub?: string): { role: string; gen: boolean; fly: boolean } {
  // Grants are honored under either handle: the display id (what owners see
  // and type) or the durable principal sub (what survives a rename —
  // home-node.md §5: key state by sub). WORLD_ADMIN accepts both too.
  if (ADMIN_IDS.has(id) || (sub && ADMIN_IDS.has(sub))) return { role: "owner", gen: true, fly: true };
  // AN OPEN WORLD DOES NOT GRANT FLIGHT. `gen` opens here because a scratch
  // world should stay frictionless to build in; flight is not a building
  // permission, it is a body permission, and "no owner has said otherwise" is
  // not a grant. Default-deny has to survive the absence of an owner or it is
  // only default-deny in worlds that already have one.
  // In an OWNED world, unlisted ids take the wildcard default: builder
  // WITHOUT gen unless the owner says otherwise. Editing stays frictionless
  // for drop-in company; introducing new assets (spend) is what's restricted
  // by default. `/grant * visitor` closes the world; `/grant * +gen` opens
  // generation to everyone. And fly is NOT implied by owner -- owning a world
  // is authority over the world, not a wing rig.
  //
  // One implementation, in shared/rightsfold.js, so a client cannot drift from
  // this. The admin override above stays here: WORLD_ADMIN is an environment
  // fact, not a world fact, and reaches a client only as a computed answer.
  return rightsIn(state as any, id, sub);
}
/** What each verb demands. `asset` is the spend gate; `grant` is owner-only. */
export const VERB_NEEDS: Record<string, { rank: number; gen?: boolean }> = {
  say: { rank: 0 },
  // Using the world is for everyone; only authoring it is gated.
  use: { rank: 0 },
  // mount/dismount are rank 1 for THINGS (loading cargo is building) but the
  // gate drops them to rank 0 when you mount YOURSELF — sitting on a swing is
  // using the world, not editing it. See the verb handler.
  mount: { rank: 1 }, dismount: { rank: 1 },
  comp: { rank: 1 }, motion: { rank: 1 },
  // Binding a runtime script is building — the sandbox, capability mask,
  // author-rights-at-emit, and budgets are what make builder-rank safe.
  // (`bstate` is deliberately absent: only the server writes script state.)
  behavior: { rank: 1 },
  spawn: { rank: 1 }, place: { rank: 1 }, remove: { rank: 1 }, light: { rank: 1 },
  // An instantaneous radial push (blast, gust). Authoring a physical event is
  // building; whether any BODY moves stays each body's own consent (pushable,
  // client-side) — this rank only stops visitors from spamming detonations.
  force: { rank: 1 },
  // Punting a thing is USING the world (docs/leases.md): the verb is the
  // CAUSE — logged, attributed, replay-inert — and any present client with a
  // physics plugin volunteers to simulate it (the lease table arbitrates the
  // race). This is why agents need no special tool: world_verb punt. (It is
  // `punt`, not `kick`, on the wire — `kick` is moderation's remove-a-person,
  // and one log word meaning two acts by referent type is a landmine.)
  punt: { rank: 0 },
  asset: { rank: 1, gen: true },
  terrain: { rank: 2 }, grass: { rank: 2 }, sky: { rank: 2 }, weather: { rank: 2 },
  // Entering (or upgrading) the deterministic-sim epoch reinterprets every
  // physical intent that follows — owner power, like shaping the ground.
  epoch: { rank: 2 },
  grant: { rank: 2 },
  // Moderation is owner power, exactly like grant — and agents get it through
  // the same gate, so an agent OWNING a world can moderate it with no extra
  // capability machinery. (Global bans are not verbs at all: see "global-ban".)
  kick: { rank: 2 }, ban: { rank: 2 }, unban: { rank: 2 },
};

/** WORLD_ADMIN under either handle — the same doctrine as rightsOf. */
export function isAdminId(id: string, sub?: string): boolean {
  return ADMIN_IDS.has(id) || (sub != null && ADMIN_IDS.has(sub));
}

/** Is this verb trying to move or destroy a nailed-down thing?
 *
 *  `comp {id, type: "lock", data: true}` nails an entity in place: while the
 *  lock is on, nothing may move it (place, punt, cargo-mount), replace it
 *  (spawn/light onto the same id), or remove it. It is an ACCIDENT guard, not
 *  a rights system — anyone builder+ can toggle it, and the deliberate
 *  unlock (`data: null`) is exactly what converts an accident into an intent.
 *  Everything that doesn't relocate the thing stays open: sitting ON it
 *  (self-mount), use, motion, behaviors, other comps — content, not carpentry.
 *  Applies to everyone including the locker: your own stray drag is the
 *  original accident (a build-mode fallthrough once relocated Fable's swing). */
export const LOCK_GUARDED = new Set(["place", "remove", "punt", "mount", "spawn", "light"]);
export function lockRefusal(state: WorldState, verb: string, args: Record<string, unknown> | undefined): string | null {
  if (!LOCK_GUARDED.has(verb)) return null;
  const id = String(args?.id ?? "");
  const ent = id ? state.entities[id] : undefined;   // people aren't entities — self-mount passes here
  if (!ent?.comp?.lock) return null;
  const act = verb === "remove" ? "remove" : verb === "spawn" || verb === "light" ? "replace" : "move";
  return `"${id}" is locked — unlock it first (comp {id: "${id}", type: "lock", data: null}) to ${act} it`;
}

/** Is this verb trying to AUTHOR a thing its placer has guarded?
 *
 *  `comp {id, type: "guard", data: true}` says: this is mine to author. While
 *  the guard is on, only the entity's PLACER (the actor who spawned it), the
 *  world's owner, or an operator may change it — its comps, its motion, the
 *  behaviors bound to it, where it stands, or whether it exists. The lock
 *  above is an accident guard among people who all may build; the guard is
 *  the rights edge the lock deliberately isn't. An owned world defaults its
 *  drop-in guests to builder so that editing stays frictionless, which also
 *  means anyone can swap the picture someone hung: the guard is how the
 *  person who hung it says who may. USING the thing stays open (`use`,
 *  sitting on it): the guard is about authorship, not access.
 *
 *  The guard comp itself is placer-gated whether or not the guard is on.
 *  Otherwise "guard" would be a way to fence someone ELSE's thing off from
 *  the room, and clearing it would be the griefer's first move.
 *
 *  Placer = the fold's `actor` on the entity. A behavior-spawned entity
 *  carries `bhv:<id>` there; its placer for this purpose is the behavior's
 *  author — the person whose rights the script already emits under.
 *  Matching is by id today (entities record the display id); the sub leg is
 *  there for the day the fold keys actors by durable principal. */
export const GUARD_AUTHORED = new Set(["comp", "motion", "behavior", "place", "remove", "punt", "mount", "dismount", "spawn", "light"]);
export function placerOf(state: WorldState, ent: { actor?: string }): string | undefined {
  const actor = ent.actor;
  if (actor?.startsWith("bhv:")) return (state as any).behaviors?.[actor.slice(4)]?.author ?? actor;
  return actor;
}
export function guardRefusal(
  state: WorldState,
  who: { id: string; sub?: string; role: string },
  verb: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!GUARD_AUTHORED.has(verb)) return null;
  // a behavior binds to `attach`; every other authoring verb names `id`
  const id = String((verb === "behavior" ? args?.attach : args?.id) ?? "");
  const ent = id ? state.entities[id] : undefined;   // people aren't entities — self-mount passes here
  if (!ent) return null;
  const guarded = !!ent.comp?.guard;
  const touchingGuard = verb === "comp" && String(args?.type ?? "") === "guard";
  if (!guarded && !touchingGuard) return null;
  const placer = placerOf(state, ent);
  if (who.id === placer || (who.sub != null && who.sub === placer)) return null;
  if (ROLE_RANK[who.role as keyof typeof ROLE_RANK] >= ROLE_RANK.owner) return null;   // owner and WORLD_ADMIN (rightsOf makes admins owner)
  const may = `only ${placer ?? "its placer"}, the world's owner, or an operator may`;
  if (!guarded) return `"${id}" was placed by ${placer ?? "someone else"} — ${may} guard it`;
  const act = verb === "remove" ? "remove"
    : verb === "spawn" || verb === "light" ? "replace"
      : verb === "place" || verb === "punt" || verb === "mount" || verb === "dismount" ? "move"
        : "change";
  return `"${id}" is guarded — ${may} ${act} it`;
}
