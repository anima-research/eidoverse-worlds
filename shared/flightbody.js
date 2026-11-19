// flightbody — what a body must HAVE to fly, checked by name and nothing else.
//
// Flight is bound to a NAMING CONTRACT, not an avatar hash: the rig pipeline recognises bones by name and nothing else.
// Re-export the body with the same bone names and flight keeps working; rename them and this says so, loudly.
//
// It returns a CAPABILITY REPORT, not a boolean: a body with no wing bones still flies the physics (the integrator
// moves a point and has never heard of a skeleton); it just can't ANIMATE the wings.
//
// PURE, per shared/README.md: no three, no DOM, no fetch. The caller passes a
// list of bone names, however it happens to know them.

/** The wing chains, as the rig authors them: <side>_Wing_<row> then _1, _2 outward. Two rows per side, three deep. */
export const WING_RE = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/;

/**
 * @param {string[]} boneNames  every bone in the body, in any order
 * @returns {{
 *   canFly: boolean, canAnimateWings: boolean,
 *   chains: Record<string, string[]>, wingCount: number,
 *   missing: string[], notes: string[]
 * }}
 */
export function inspectBody(boneNames) {
  const names = Array.isArray(boneNames) ? boneNames : [];
  const chains = /** @type {Record<string, string[]>} */ ({});
  for (const n of names) {
    const m = WING_RE.exec(n);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;                 // L_Upper, R_Lower, ...
    (chains[key] ??= []).push(n);
  }
  // Sort each chain root-first. The INDEX in the name is the depth (counting underscores would put _1 and _2 level).
  for (const k of Object.keys(chains)) {
    chains[k].sort((a, b) => depthOf(a) - depthOf(b));
  }
  const wingCount = Object.values(chains).reduce((n, c) => n + c.length, 0);
  // CORE BONES BY ANY SPELLING: each entry is the set of acceptable names for one joint, matched case-insensitively.
  // Three vocabularies reach here: the Tripo rig's `Hip`/`Spine02`, a VRM humanoid map's `hips`/`chest` (which the
  // readers add to a VRM's node names), and a Mixamo-derived body's `Hips`/`Spine`.
  const CORE = [
    ['hip', 'hips'],
    ['spine02', 'spine01', 'spine', 'chest', 'upperchest'],
    ['head'],
  ];
  const lower = new Set(names.map(n => String(n).toLowerCase()));
  const has = (alts) => alts.some(a => lower.has(a));
  const missing = CORE.filter(alts => !has(alts)).map(alts => alts[0]);

  const notes = [];
  const canAnimateWings = Object.keys(chains).length >= 2 && wingCount >= 4;
  if (!canAnimateWings) {
    notes.push(wingCount === 0
      ? 'no [LR]_Wing_* bones: physics will fly, wings will not animate'
      : `only ${wingCount} wing bone(s) in ${Object.keys(chains).length} chain(s); ` +
        'expected 4 chains (L/R x Upper/Lower)');
  }
  if (missing.length) notes.push(`missing core bone(s): ${missing.join(', ')}`);
  // Chains of differing depth are fine and worth SAYING.
  const depths = [...new Set(Object.values(chains).map(c => c.length))];
  if (depths.length > 1) notes.push(`wing chains have uneven depth (${depths.join('/')})`);

  return {
    canFly: missing.length === 0,      // the integrator needs a root, not feathers
    canAnimateWings,
    chains, wingCount, missing, notes,
  };
}

function depthOf(name) {
  const m = WING_RE.exec(name);
  return m && m[3] ? Number(m[3]) : 0;
}

/** A one-line summary for a log or a HUD readout. */
export function describeBody(report) {
  if (!report.canFly) return `NOT FLIGHT-CAPABLE: ${report.missing.join(', ')} absent`;
  const wings = report.canAnimateWings
    ? `${report.wingCount} wing bones in ${Object.keys(report.chains).length} chains`
    : 'no animatable wings';
  return `flight-capable, ${wings}${report.notes.length ? ' -- ' + report.notes.join('; ') : ''}`;
}
