// flightcap — the capability boundary. Nothing flies without a profile, and
// the default provider issues none.
//
// mica's shape, adopted verbatim in intent:
//
//     flightCapability({ identity, avatar, world }) -> { enabled:false } | profile
//
// Three properties matter and each exists because its absence is a specific
// way to leak flight into a world that did not ask for it.
//
// DEFAULT DENY. A missing provider is not "no opinion", it is "no". The export
// that costs nothing to reach is the one that refuses; enabling flight takes a
// deliberate act by a caller who had to construct something.
//
// CHECKED AT ACTION TIME, not at construction. mica: "avatars/components can
// hot-swap." A body that was Mythos when the controller was built may be a
// commons avatar three frames later, and a capability cached at construction
// would let flight ride across the swap. So the profile is re-resolved on every
// action, and `revoked()` exists to make the swap testable.
//
// A SEMANTIC RIG PROFILE, not an asset hash. Janus's requirement and mica's
// ruling agree: authorization binds to the load-bearing bone names, so an
// updated body keeps flying if it is still shaped like a flier. The exact asset
// hash belongs in the clip receipt as provenance, and provenance is not
// permission.

import { inspectBody, describeBody } from './flightbody.js';

/** @typedef {{enabled:false, reason:string}} Denied */
/** @typedef {{enabled:true, profile:RigProfile, source:string}} Granted */
/** @typedef {{ wingChains:Record<string,string[]>, wingCount:number,
 *              core:string[], digest:string, version:string }} RigProfile */

/** The default. Always denies, for every caller, in every world.
 *
 *  This is what production gets until someone authors a capability component,
 *  and it is what a test gets when it forgets to inject one -- which is the
 *  point: the failure mode of a forgotten dependency must be "no flight",
 *  never "flight for everyone". */
export const denyAllFlight = {
  name: 'deny-all',
  flightCapability() {
    return { enabled: false, reason: 'no flight capability provider configured' };
  },
};

/** Build a rig profile from a body's bone names, or explain why not.
 *
 *  The DIGEST is over the load-bearing names only -- the wing chains and the
 *  core bones flight actually drives -- so a re-export that adds hair, changes
 *  materials, or moves a vertex produces the SAME digest and keeps flying,
 *  while a rename of a wing bone produces a different one and does not. That
 *  is the whole difference between binding to a rig and binding to a file.
 */
export function rigProfile(boneNames) {
  const report = inspectBody(boneNames);
  if (!report.canFly) {
    return { ok: false, reason: `not flight-capable: ${describeBody(report)}`, report };
  }
  // WINGS ARE REQUIRED FOR A CAPABILITY, even though they are not required for
  // the physics. inspectBody says a wingless body can fly -- true, and useful
  // for a headless bench that only cares about a trajectory. But a CAPABILITY
  // is permission to fly in a world with onlookers, and granting it to a
  // commons avatar is precisely the leak this boundary exists to stop. The two
  // answers differ because the questions do: "could this body be integrated?"
  // and "may this body take off?"
  if (!report.canAnimateWings) {
    return {
      ok: false,
      reason: `no flight rig: ${describeBody(report)}`,
      report,
    };
  }
  const core = ['Hip', 'Spine01', 'Spine02', 'Head', 'NeckTwist01']
    .filter(b => boneNames.includes(b));
  const loadBearing = [
    ...Object.values(report.chains).flat().sort(),
    ...core.sort(),
  ];
  return {
    ok: true,
    report,
    profile: {
      wingChains: report.chains,
      wingCount: report.wingCount,
      core,
      digest: digestOf(loadBearing),
      version: 'flight-rig/1',
      canAnimateWings: report.canAnimateWings,
      notes: report.notes,
    },
  };
}

/** A LOCAL DEV provider for the bench. Grants flight to named identities on a
 *  compatible rig and to nobody else.
 *
 *  mica: "expose bench controls only under the explicit local dev provider. Do
 *  not ship a query-string production bypass." So this takes its allow-list as
 *  a constructor argument -- there is no string a URL could contain that
 *  reaches it, and a build that never constructs one cannot be talked into
 *  flying.
 */
export function devFlightProvider({ allow = [], bones = null, label = 'local-dev' } = {}) {
  const allowed = new Set(allow);
  return {
    name: label,
    /** @param {{identity?:string, avatar?:{boneNames?:string[]}, world?:any}} [ctx] */
    flightCapability(ctx = {}) {
      const { identity, avatar } = ctx;
      if (!allowed.has(identity)) {
        return { enabled: false, reason: `identity ${identity ?? '(none)'} not in the bench allow-list` };
      }
      // THE LIVE BODY WINS. The first cut preferred the constructor's `bones`,
      // so a provider built with Mythos's rig kept granting flight after the
      // avatar hot-swapped to a wingless one -- the action-time gate resolving
      // against a body that was no longer there. The constructor list is only a
      // FALLBACK for a headless caller that has no avatar to inspect, which is
      // the one case it was meant for.
      const names = avatar?.boneNames ?? bones ?? null;
      if (!names) return { enabled: false, reason: 'no bone list available for this avatar' };
      const r = rigProfile(names);
      if (!r.ok) return { enabled: false, reason: r.reason };
      return { enabled: true, profile: r.profile, source: label };
    },
  };
}

/** Resolve a capability through a provider, defaulting to deny.
 *
 *  Every entry point -- verb, controller, UI, hook -- calls THIS, at the moment
 *  it acts. A caller that holds a stale grant across an avatar swap is the bug
 *  this signature exists to prevent, so nothing here caches. */
export function resolveFlight(provider, ctx) {
  const p = provider ?? denyAllFlight;
  let out;
  try { out = p.flightCapability(ctx ?? {}); }
  catch (e) { return { enabled: false, reason: `provider threw: ${e?.message ?? e}` }; }
  if (!out || out.enabled !== true) {
    return { enabled: false, reason: out?.reason ?? 'provider denied' };
  }
  if (!out.profile || !out.profile.digest) {
    return { enabled: false, reason: 'provider granted without a rig profile' };
  }
  return out;
}

/** True when a previously-granted profile no longer matches the body.
 *
 *  The hot-swap test mica asked for: hold a grant, swap the avatar, and this
 *  says the grant is stale. Flight must then STOP -- not degrade, not persist
 *  on the old rig's numbers. */
export function revoked(profile, currentBoneNames) {
  if (!profile) return true;
  const r = rigProfile(currentBoneNames);
  if (!r.ok) return true;
  return r.profile.digest !== profile.digest;
}

// A small, stable, dependency-free digest. Not a security primitive and not
// pretending to be one -- its job is "did the load-bearing names change",
// which is a change-detection question. Integrity of the ASSET is SHA-256 in
// the clip receipt, where mica put it.
function digestOf(parts) {
  const s = parts.join('|');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `rig1-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
