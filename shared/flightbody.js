// flightbody — which wings a body can ANIMATE, checked by name and nothing else. It never decides whether a body may fly
// (that is the world's fly right, shared/flightcap.js); it decides whether wings flap and fold.
//
// Janus's constraint, and the right one: "the flying mechanics should continue
// to work if I update the body as long as the load-bearing bits remain the
// same (such as wing bones), or maybe even more compatible than that."
//
// So wings are bound to a NAMING CONTRACT, which is the same contract hair and wings already flow through in this
// project (rigtest/EIDOVERSE-DEPLOY.md: "the pipeline recognises bones by NAME and nothing else"). Re-export the body
// with the same bone names and the wings keep moving; rename them and this says so, loudly (deadWingsNote), instead
// of producing a flier whose wings do not move.
//
// PURE, per shared/README.md: no three, no DOM, no fetch. The caller passes a
// list of bone names, however it happens to know them.

/** The wing chains, as authored by rigtest/hair_rig.py's sibling convention:
 *  <side>_Wing_<row> then _1, _2 outward. Two rows per side, three deep. */
export const WING_RE = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/;

/**
 * @param {string[]} boneNames  every bone in the body, in any order
 * @returns {{
 *   canAnimateWings: boolean, chains: Record<string, string[]>, wingCount: number,
 *   strays: string[], notes: string[]
 * }}  strays: bones that look like wings (/wing/i) but don't match WING_RE
 */
export function inspectBody(boneNames) {
  const names = Array.isArray(boneNames) ? boneNames : [];
  const chains = /** @type {Record<string, string[]>} */ ({});
  const strays = [];
  for (const n of names) {
    const m = WING_RE.exec(n);
    if (!m) { if (/wing/i.test(String(n))) strays.push(n); continue; }
    const key = `${m[1]}_${m[2]}`;                 // L_Upper, R_Lower, ...
    (chains[key] ??= []).push(n);
  }
  // Sort each chain root-first. The INDEX in the name is the depth: counting
  // underscores instead collapses _1 and _2 to the same level, which is the
  // bug ammodoll.js documents having hit.
  for (const k of Object.keys(chains)) {
    chains[k].sort((a, b) => depthOf(a) - depthOf(b));
  }
  const wingCount = Object.values(chains).reduce((n, c) => n + c.length, 0);

  const notes = [];
  const canAnimateWings = Object.keys(chains).length >= 2 && wingCount >= 4;
  if (!canAnimateWings) {
    notes.push(wingCount === 0
      ? 'no [LR]_Wing_* bones: wings will not animate'
      : `only ${wingCount} wing bone(s) in ${Object.keys(chains).length} chain(s); ` +
        'expected 4 chains (L/R x Upper/Lower)');
  }
  // Chains of differing depth are fine and worth SAYING: the wings grew from
  // two bones to three on 2026-08-17 and nothing in the pipeline counted them.
  const depths = [...new Set(Object.values(chains).map(c => c.length))];
  if (depths.length > 1) notes.push(`wing chains have uneven depth (${depths.join('/')})`);

  return { canAnimateWings, chains, wingCount, strays, notes };
}

function depthOf(name) {
  const m = WING_RE.exec(name);
  return m && m[3] ? Number(m[3]) : 0;
}

/** For a body that has wings it can't animate, the one sentence that says why; null for animatable wings or none. */
export function deadWingsNote(report) {
  if (report.canAnimateWings || (report.wingCount === 0 && report.strays.length === 0)) return null;
  if (report.wingCount === 0) {
    const shown = report.strays.slice(0, 3).join(', ') + (report.strays.length > 3 ? ', …' : '');
    return `its wings won't animate: their bones (${shown}) aren't named L_Wing_Upper / L_Wing_Lower / R_Wing_Upper / ` +
      'R_Wing_Lower (then _1, _2 outward), which is how flapping finds them';
  }
  return `its wings won't animate: ${report.wingCount} wing bone(s) in ${Object.keys(report.chains).length} chain(s), ` +
    'and flapping needs at least two chains and four bones';
}
