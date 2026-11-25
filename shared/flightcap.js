// flightcap — the capability boundary. Nothing flies without a profile, and
// the default provider issues none.
//
//     flightCapability({ identity, avatar, world }) -> { enabled:false } | profile
//
// DEFAULT DENY: a missing provider is "no"; enabling flight takes a caller who
// had to construct something.
// CHECKED AT ACTION TIME, not at construction: avatars hot-swap, so the profile
// is re-resolved on every action, and `revoked()` makes the swap testable.
// A SEMANTIC RIG PROFILE, not an asset hash: authorization binds to the
// load-bearing bone names, so an updated body keeps flying if it is still
// shaped like a flier. Provenance (the asset hash) is not permission.

import { inspectBody } from './flightbody.js';

/** A provider's answer when it has no bone list for the body. */
const BONES_UNKNOWN = "this body's bones aren't known (its model hasn't loaded or couldn't be read, or no bone list was given), so whether it can fly can't be checked";

/** @typedef {{enabled:false, reason:string}} Denied */
/** @typedef {{enabled:true, profile:RigProfile, source:string}} Granted */
/** @typedef {{ wingChains:Record<string,string[]>, wingCount:number,
 *              core:string[], digest:string, version:string }} RigProfile */

/** The default. Always denies, for every caller, in every world: the failure
 *  mode of a forgotten dependency is "no flight", never "flight for everyone". */
export const denyAllFlight = {
  name: 'deny-all',
  flightCapability() {
    return { enabled: false, reason: "flight isn't set up here (no capability provider is configured), so nobody can fly; if you need it, ask whoever runs this host" };
  },
};

/** Build a rig profile from a body's bone names, or explain why not. The DIGEST
 *  is over the load-bearing names only (wing chains and core bones), so a
 *  re-export that adds hair or moves a vertex keeps it, and a wing-bone rename
 *  changes it.
 */
export function rigProfile(boneNames) {
  const report = inspectBody(boneNames);
  if (!report.canFly) {
    const missing = report.missing.map((b) => ({ hip: 'hips', spine02: 'spine' })[b] ?? b);
    return {
      ok: false,
      reason: `this body can't fly: its skeleton lacks a flier's core bones (missing: ${missing.join(', ')}); wear a body with hips, a spine and a head`,
      report,
    };
  }
  // WINGS ARE REQUIRED FOR A CAPABILITY, though not for the physics: "could this body be integrated?" (inspectBody)
  // and "may this body take off in front of onlookers?" are different questions.
  if (!report.canAnimateWings) {
    const chains = Object.keys(report.chains).length;
    return {
      ok: false,
      reason: report.wingCount === 0
        ? 'this body has no wing bones, so it has no wings to fly with; wear a winged body to fly'
        : `this body's wings have ${report.wingCount} bone(s) in ${chains} chain(s), and flying needs at least ` +
          'two chains and four bones; wear a body with fully rigged wings to fly',
      report,
    };
  }
  // Same vocabularies as inspectBody, matched the same way; the digest records the spellings THIS body uses, so a
  // renamed rig digests as a different rig.
  const CORE_ANY = new Set(['hip', 'hips', 'spine', 'spine01', 'spine02',
                            'chest', 'upperchest', 'head', 'neck', 'necktwist01']);
  const core = boneNames.filter(b => CORE_ANY.has(String(b).toLowerCase()));
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
 *  compatible rig and to nobody else. The allow-list is a constructor argument,
 *  never a query string: a build that never constructs one can't be talked into
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
      // THE LIVE BODY WINS: the constructor's `bones` are only a fallback for a headless caller with no avatar. An
      // avatar whose bones aren't known gets no list, not the constructor's.
      const names = (avatar ? avatar.boneNames : bones) ?? null;
      if (!names) return { enabled: false, reason: BONES_UNKNOWN };
      const r = rigProfile(names);
      if (!r.ok) return { enabled: false, reason: r.reason };
      return { enabled: true, profile: r.profile, source: label };
    },
  };
}

/** THE PRODUCTION PROVIDER: a grant the SERVER made, for this identity, in
 *  this world. Two questions, and BOTH must say yes:
 *
 *    rights.fly   may this identity fly in this world -- server-authoritative,
 *                 per-world: a role's fly permission (server rightsFor; set
 *                 through the world's roles:<id>), on for the owner by
 *                 default (roles.js OWNERS_FLY). A URL cannot forge it; the
 *                 client only reports what the server sent.
 *    rigProfile   is this body physically a flier -- evidence, never consent.
 *
 *  `rights` is read through a THUNK, not captured: grants change live.
 *
 * @param {{ rights?: (() => any) | any, label?: string }} [opts]
 */
export function worldFlightProvider({ rights = null, label = 'world-grant' } = {}) {
  const read = typeof rights === 'function' ? rights : () => rights;
  return {
    name: label,
    flightCapability(ctx = {}) {
      const r = read() ?? null;
      // A MISSING RIGHTS OBJECT IS A NO (not yet joined, an older server, a dropped snapshot).
      if (!r) {
        return { enabled: false, reason: "your rights in this world haven't arrived, which counts as no: if you're still joining, try again once you've joined; if they never arrive, this server may not send them (an older version), so ask whoever runs it" };
      }
      if (r.fly !== true) {
        // flight is a role's fly permission (server rightsFor), so the fix this names is a roles:<id> set
        return {
          enabled: false,
          reason: "this world hasn't given you flight; flight comes with a role's fly permission, which the world's owner " +
            '(or someone who may give roles, can fly, and outranks you) gives you by sending set {id: "@world", component: "roles:<your id>", value: {can: {fly: true}}, merge: true} ' +
            '(merge keeps the rest of your record, a time limit included; with no record yet, value: {role: <your role>, can: {fly: true}})',
        };
      }
      const names = ctx.avatar?.boneNames ?? null;
      if (!names) return { enabled: false, reason: BONES_UNKNOWN };
      const p = rigProfile(names);
      if (!p.ok) return { enabled: false, reason: p.reason };
      return { enabled: true, profile: p.profile, source: label };
    },
  };
}

/** Resolve a capability through a provider, defaulting to deny. Every entry
 *  point (verb, controller, UI, hook) calls THIS at the moment it acts; nothing
 *  here caches. */
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
  if (!out.profile || !out.profile.digest) {
    return { enabled: false, reason: 'the flight check answered without a rig profile, which counts as no; ask whoever runs this host' };
  }
  return out;
}

/** True when a previously-granted profile no longer matches the body (hold a
 *  grant, swap the avatar: stale). Flight must then STOP, not degrade. */
export function revoked(profile, currentBoneNames) {
  if (!profile) return true;
  const r = rigProfile(currentBoneNames);
  if (!r.ok) return true;
  return r.profile.digest !== profile.digest;
}

// A small, stable, dependency-free digest for change detection, not security (asset integrity is SHA-256 elsewhere).
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
