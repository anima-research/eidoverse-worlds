// parity — the scene against the view (EW.foldParity() in the console): does what this page DRAWS agree with the view
// of its own fold (state.js)? Run it in any live world, after any suspect sequence of edits. It compares the fold's
// OWN outputs (entity ids, what each is, parents) and deliberately not realization (transforms mid-motion, loaded
// meshes): those diverge by design while an object is in flight or riding a motion.
// (compDiffs — the realizer's `comps` mirror against the view — is retired with the mirror, C7c: every reader holds the
// fold's own record (world.js bagOf), so there is no second bag to drift. The key stays, always empty, for the benches.)

import { state } from './state.js';
import { entities, childrenOf, ancestorsOf } from './world.js';
import { realizedAs } from './realize/models.js';
import { kindOf } from '../../shared/protocol/kind.js';
import { childrenOf as scanChildren, ancestors as scanAncestors } from '../../shared/hierarchy.js';


export function foldParity() {
  const shadow = state.st;
  const out = { hydrated: state.hydrated, lastSeq: state.lastSeq,
    checked: 0, onlyShadow: [], onlyLegacy: [], compDiffs: [], mountDiffs: [],
    identityDiffs: [], parentDiffs: [], mountPoseDiffs: [], edgeDiffs: [] };

  const legacyIds = new Set(entities.keys());
  const shadowIds = new Set(Object.keys(shadow.entities));
  for (const id of shadowIds) if (!legacyIds.has(id)) out.onlyShadow.push(id);
  for (const id of legacyIds) if (!shadowIds.has(id)) out.onlyLegacy.push(id);

  for (const id of shadowIds) {
    if (!legacyIds.has(id)) continue;
    out.checked++;
    // identity: the fold's word on WHAT this id is (a light? which model?)
    // vs what the scene realized — where same-id-spawn overwrite semantics
    // would drift first (a still-loading reservation is tracked as nothing yet: skip)
    const meta = realizedAs(id);
    if (meta) {
      const ent = shadow.entities[id];
      const sceneKind = meta.kind;
      const foldKind = kindOf(ent);
      if (sceneKind !== foldKind || (foldKind === 'model' && meta.lib !== ent.lib)) {
        out.identityDiffs.push({ id, legacy: { kind: sceneKind, lib: meta.lib },
          shadow: { kind: foldKind, lib: ent.lib } });
      }
    }
  }

  // entity→entity mounts: the fold's parent record vs the scene's linkage —
  // AND, when linked, the child's parent-local transform vs the mount's own
  // offset. The link can be right while the pose is wrong (a reconcile that
  // re-applies an absolute pos in the parent's frame — review finding B1),
  // so both are buckets. Part-socket mounts skip the pose check: attach
  // bakes the part's live phase into the offset, honestly.
  for (const id of shadowIds) {
    if (!legacyIds.has(id)) continue;
    const rel = shadow.entities[id].parent ?? null;
    const obj = entities.get(id);
    if (!obj) continue;                      // still loading — linkage realizes with it
    const got = obj.userData?.mountedTo ?? null;
    const want = rel?.to ?? null;
    if (want !== got) { out.parentDiffs.push({ id, legacy: got, shadow: want }); continue; }
    if (rel && got) {
      const sock = rel.socket ? shadow.entities[rel.to]?.comp?.sockets?.[rel.socket] : null;
      if (!sock?.part) {
        const off = rel.offset ?? sock?.pos ?? [0, 0, 0];
        const d = Math.hypot(obj.position.x - off[0], obj.position.y - off[1], obj.position.z - off[2]);
        if (d > 0.05) out.mountPoseDiffs.push({ id, expected: off, actual: obj.position.toArray(), d: +d.toFixed(3) });
      }
    }
  }

  // the fold's edge index (replica.js, kept op by op at ingest) against the view's records (viewState, rebuilt whole):
  // two derivations of the same parent fields; a missed ingest path shows here as a child one lists and the other doesn't
  for (const id of shadowIds) {
    const kids = childrenOf(id), want = scanChildren(shadow.entities, id);
    if (kids.join('\n') !== want.join('\n')) out.edgeDiffs.push({ id, index: kids, view: want });
    const up = ancestorsOf(id), wantUp = scanAncestors(shadow.entities, id);
    if (up.join('\n') !== wantUp.join('\n')) out.edgeDiffs.push({ id, indexUp: up, viewUp: wantUp });
  }

  // (bodies on seats are presence — world.js avatarMounts — never the fold: nothing to compare them with here)

  out.ok = !out.onlyShadow.length && !out.onlyLegacy.length
    && !out.compDiffs.length && !out.mountDiffs.length && !out.identityDiffs.length
    && !out.parentDiffs.length && !out.mountPoseDiffs.length && !out.edgeDiffs.length;
  console.log(`[parity] ${out.ok ? '✓ fold and scene agree' : '✗ DRIFT'} — ` +
    `${out.checked} entities checked, +${out.onlyShadow.length} shadow-only, ` +
    `+${out.onlyLegacy.length} legacy-only, ${out.compDiffs.length} comp diffs, ` +
    `${out.mountDiffs.length} mount diffs, ${out.identityDiffs.length} identity diffs, ` +
    `${out.parentDiffs.length} parent diffs, ${out.mountPoseDiffs.length} mount-pose diffs, ${out.edgeDiffs.length} edge diffs ` +
    `(seq ${out.lastSeq})`);
  return out;
}
