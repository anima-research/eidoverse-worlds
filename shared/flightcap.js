// flightcap — the capability boundary: may this identity fly here? Default deny; the answer is the world's fly right.
//
// mica's shape, adopted verbatim in intent:
//
//     flightCapability({ identity, avatar, world }) -> { enabled:false, reason } | { enabled:true, source }
//
// DEFAULT DENY. A missing provider is not "no opinion", it is "no". The export
// that costs nothing to reach is the one that refuses; enabling flight takes a
// deliberate act by a caller who had to construct something.
//
// CHECKED AT ACTION TIME, not at construction: grants change live, so every entry point re-resolves when it acts.
//
// THE BODY IS NOT ASKED. Flight is a property of the avatar's rights, not of its shape (R 11-12: "clouds, asian
// dragons, psychic masters"); wings, if a body has them, only decide whether they flap (shared/flightbody.js).

/** @typedef {{enabled:false, reason:string}} Denied */
/** @typedef {{enabled:true, source:string}} Granted */

/** The default. Always denies, for every caller, in every world.
 *
 *  This is what production gets until someone authors a capability component,
 *  and it is what a test gets when it forgets to inject one -- which is the
 *  point: the failure mode of a forgotten dependency must be "no flight",
 *  never "flight for everyone". */
export const denyAllFlight = {
  name: 'deny-all',
  flightCapability() {
    return { enabled: false, reason: "flight isn't set up here (no capability provider is configured), so nobody can fly; if you need it, ask whoever runs this host" };
  },
};

/** A LOCAL DEV provider for the bench. Grants flight to named identities and to nobody else.
 *
 *  mica: "expose bench controls only under the explicit local dev provider. Do
 *  not ship a query-string production bypass." So this takes its allow-list as
 *  a constructor argument -- there is no string a URL could contain that
 *  reaches it, and a build that never constructs one cannot be talked into
 *  flying.
 */
export function devFlightProvider({ allow = [], label = 'local-dev' } = {}) {
  const allowed = new Set(allow);
  return {
    name: label,
    /** @param {{identity?:string, avatar?:{boneNames?:string[]}, world?:any}} [ctx] */
    flightCapability(ctx = {}) {
      const { identity } = ctx;
      if (!allowed.has(identity)) {
        return { enabled: false, reason: `identity ${identity ?? '(none)'} not in the bench allow-list` };
      }
      return { enabled: true, source: label };
    },
  };
}

/** THE PRODUCTION PROVIDER: a grant the SERVER made, for this identity, in this world (rights.fly).
 *
 *  This exists because an earlier cut shipped `devFlightProvider` in both entry points, so wearing a winged rig
 *  authorized itself. mica, reviewing cea3c3c: "That collapses provenance ('is this a flier?') into permission ('may
 *  this person fly here?')." rights.fly is server-authoritative, per-world, default-off even in an open world and
 *  even for its owner; a URL cannot forge it. (That review also required a rig check; 11-12 retired it, see the PR.)
 *
 *  `rights` is read through a THUNK, not captured: grants change live.
 *
 * @param {{ rights?: (() => any) | any, label?: string }} [opts]
 */
export function worldFlightProvider({ rights = null, label = 'world-grant' } = {}) {
  const read = typeof rights === 'function' ? rights : () => rights;
  return {
    name: label,
    flightCapability() {
      const r = read() ?? null;
      // A MISSING RIGHTS OBJECT IS A NO. Not yet joined, an older server that
      // never heard of `fly`, a dropped snapshot -- every one of those is
      // "nobody has said you may", which is the same answer as "no".
      if (!r) {
        return { enabled: false, reason: "your rights in this world haven't arrived, which counts as no: if you're still joining, try again once you've joined; if they never arrive, this server may not send them (an older version), so ask whoever runs it" };
      }
      if (r.fly !== true) {
        // main #245's wording (why, and who can fix it), in this branch's shape: flight is a role's `fly` permission
        // (server rightsFor; research roles S4), not a `grant` verb flag, so the fix it names is a roles:<id> set
        return {
          enabled: false,
          reason: "this world hasn't given you flight; flight comes with a role's fly permission, which the world's owner " +
            '(or someone who may give roles, can fly, and outranks you) gives you by sending set {id: "@world", component: "roles:<your id>", value: {can: {fly: true}}, merge: true} ' +
            '(merge keeps the rest of your record, a time limit included; with no record yet, value: {role: <your role>, can: {fly: true}})',
        };
      }
      return { enabled: true, source: label };
    },
  };
}

/** Resolve a capability through a provider, defaulting to deny.
 *
 *  Every entry point -- verb, controller, UI, hook -- calls THIS, at the moment
 *  it acts, so nothing here caches. Only `enabled === true` is a yes. */
export function resolveFlight(provider, ctx) {
  const p = provider ?? denyAllFlight;
  let out;
  try { out = p.flightCapability(ctx ?? {}); }
  catch (e) {
    return { enabled: false, reason: `the flight check failed on this host (${e?.message ?? e}); if it keeps failing, ask whoever runs this host` };
  }
  if (!out || out.enabled !== true) {
    return { enabled: false, reason: out?.reason ?? 'provider denied' };
  }
  return { enabled: true, source: out.source ?? p.name ?? 'provider' };
}
