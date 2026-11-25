// parity — the scene against the view (EW.foldParity() in the console): does what this page DRAWS agree with the view
// of its own fold (state.js)? Run it in any live world, after any suspect sequence of edits. It compares the fold's
// OWN outputs (entity ids, what each is, parents) and mostly not realization (loaded meshes, transforms mid-motion);
// the one transform read is a mounted child's position against its offset (mountPoseDiffs: its own motion reads as drift).
// compDiffs and mountDiffs are always empty (what they compared is gone); kept so the result's shape is stable.

import { state } from '../state.js';
import { entities, childrenOf, ancestorsOf } from '../world.js';
import { realizedAs } from '../realize/models.js';
import { childrenOf as scanChildren, ancestors as scanAncestors } from '../../../shared/hierarchy.js';


export function foldParity() {
  const fold = state.st;
  const out = { hydrated: state.hydrated, lastSeq: state.lastSeq,
    checked: 0, onlyFold: [], onlyScene: [], compDiffs: [], mountDiffs: [],
    identityDiffs: [], parentDiffs: [], mountPoseDiffs: [], edgeDiffs: [] };

  const sceneIds = new Set(entities.keys());
  const foldIds = new Set(Object.keys(fold.entities));
  for (const id of foldIds) if (!sceneIds.has(id)) out.onlyFold.push(id);
  for (const id of sceneIds) if (!foldIds.has(id)) out.onlyScene.push(id);

  for (const id of foldIds) {
    if (!sceneIds.has(id)) continue;
    out.checked++;
    // identity: the fold's model for this id vs what the scene realized (a still-loading reservation is skipped)
    const meta = realizedAs(id);
    if (meta) {
      const ent = fold.entities[id];
      const foldModel = typeof ent?.model === 'string' ? ent.model : null;
      if ((meta.model ?? null) !== foldModel) out.identityDiffs.push({ id, scene: { model: meta.model ?? null }, fold: { model: foldModel } });
    }
  }

  // entity→entity mounts: the fold's parent record vs the scene's linkage, and (when linked) the child's parent-local
  // transform vs the mount's offset. Part-socket mounts skip the pose check: attach bakes the part's live phase in.
  for (const id of foldIds) {
    if (!sceneIds.has(id)) continue;
    const rel = fold.entities[id].parent ?? null;
    const obj = entities.get(id);
    if (!obj) continue;                      // still loading — linkage realizes with it
    const got = obj.userData?.mountedTo ?? null;
    const want = rel?.to ?? null;
    if (want !== got) { out.parentDiffs.push({ id, scene: got, fold: want }); continue; }
    if (rel && got) {
      // a socket that rides a part stands in the part's node (at rest), not at its offset from the host
      if (typeof fold.entities[id]?.socket?.part !== 'string') {
        const off = rel.offset ?? [0, 0, 0];
        const d = Math.hypot(obj.position.x - off[0], obj.position.y - off[1], obj.position.z - off[2]);
        if (d > 0.05) out.mountPoseDiffs.push({ id, expected: off, actual: obj.position.toArray(), d: +d.toFixed(3) });
      }
    }
  }

  // the fold's edge index (replica.js, kept op by op at ingest) against the view's records (viewState, rebuilt whole):
  // two derivations of the same parent fields; a missed ingest path shows here as a child one lists and the other doesn't
  for (const id of foldIds) {
    const kids = childrenOf(id), want = scanChildren(fold.entities, id);
    if (kids.join('\n') !== want.join('\n')) out.edgeDiffs.push({ id, index: kids, view: want });
    const up = ancestorsOf(id), wantUp = scanAncestors(fold.entities, id);
    if (up.join('\n') !== wantUp.join('\n')) out.edgeDiffs.push({ id, indexUp: up, viewUp: wantUp });
  }

  // (bodies on seats are presence — world.js avatarMounts — never the fold: nothing to compare them with here)

  out.ok = !out.onlyFold.length && !out.onlyScene.length
    && !out.compDiffs.length && !out.mountDiffs.length && !out.identityDiffs.length
    && !out.parentDiffs.length && !out.mountPoseDiffs.length && !out.edgeDiffs.length;
  console.log(`[parity] ${out.ok ? '✓ fold and scene agree' : '✗ DRIFT'} — ` +
    `${out.checked} entities checked, +${out.onlyFold.length} fold-only, ` +
    `+${out.onlyScene.length} scene-only, ${out.compDiffs.length} comp diffs, ` +
    `${out.mountDiffs.length} mount diffs, ${out.identityDiffs.length} identity diffs, ` +
    `${out.parentDiffs.length} parent diffs, ${out.mountPoseDiffs.length} mount-pose diffs, ${out.edgeDiffs.length} edge diffs ` +
    `(seq ${out.lastSeq})`);
  return out;
}
