// flightbody — which wings a body can ANIMATE, checked by name and nothing else. It never decides whether a body may fly
// (that is the world's fly right, shared/flightcap.js); it decides whether wings flap and fold.
//
// Wings are bound to a NAMING CONTRACT, which is the same contract hair and wings already flow through in this
// project (rigtest/EIDOVERSE-DEPLOY.md: "the pipeline recognises bones by NAME and nothing else"). Re-export the body
// with the same bone names and the wings keep moving; rename them and they stay still (the body still flies).
//
// PURE, per shared/README.md: no three, no DOM, no fetch. The caller passes a
// list of bone names, however it happens to know them.

/** The wing chains, as the rig authors them: <side>_Wing_<row> then _1, _2 outward. Two rows per side, three deep. */
export const WING_RE = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/;

/**
 * @param {string[]} boneNames  every node name in the body (the renderer, client/lib/avatar/wings.js _findWings, moves
 *   any node whose name matches WING_RE, bone or not), in any order
 * @returns {{ canAnimateWings: boolean, chains: Record<string, string[]>, wingCount: number, notes: string[] }}
 *   canAnimateWings: the renderer finds at least one wing to move (and so to fold)
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

  const notes = [];
  const canAnimateWings = wingCount > 0;
  if (!canAnimateWings) notes.push('no [LR]_Wing_* bones: wings will not animate');
  // Chains of differing depth are fine and worth SAYING: the wings grew from
  // two bones to three on 2026-08-17 and nothing in the pipeline counted them.
  const depths = [...new Set(Object.values(chains).map(c => c.length))];
  if (depths.length > 1) notes.push(`wing chains have uneven depth (${depths.join('/')})`);

  return { canAnimateWings, chains, wingCount, notes };
}

/** Why a fold was released on a body: said the same way by the agent and the browser. It names the convention rather
 *  than claiming the body is wingless, since its wings may just be named otherwise. */
export const FOLD_RELEASED = 'folded-wing posture released — this body has no L_Wing_* / R_Wing_* bones for the fold to move';

function depthOf(name) {
  const m = WING_RE.exec(name);
  return m && m[3] ? Number(m[3]) : 0;
}
