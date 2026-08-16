// parity — the shadow-mode probe (TEL0S_NOTES §11.6).
//
// While the migration runs two world models side by side — the legacy
// applyEntry scene path and the pure shared-fold shadow in state.js — this
// is the instrument that measures drift between them. House rule 1's
// remaining mirror (shared/fold.js vs applyEntry) stops being a hope and
// becomes a number you can print.
//
// Console surface: EW.foldParity() — run it in any live world, after any
// suspect sequence of verbs. It compares the fold's OWN outputs (entity
// ids, component bags, parents/mounts) and deliberately not realization
// (transforms mid-motion, loaded meshes): those diverge by design while an
// object is in flight or riding a motion comp.

import { state } from './state.js';
import { entities, entityMeta, comps, avatarMounts } from './world.js';

const jstr = (v) => JSON.stringify(v ?? null);

export function foldParity() {
  const shadow = state.st;
  const out = { hydrated: state.hydrated, lastSeq: state.lastSeq,
    checked: 0, onlyShadow: [], onlyLegacy: [], compDiffs: [], mountDiffs: [],
    identityDiffs: [], parentDiffs: [], mountPoseDiffs: [] };

  const legacyIds = new Set(entities.keys());
  const shadowIds = new Set(Object.keys(shadow.entities));
  for (const id of shadowIds) if (!legacyIds.has(id)) out.onlyShadow.push(id);
  for (const id of legacyIds) if (!shadowIds.has(id)) out.onlyLegacy.push(id);

  for (const id of shadowIds) {
    if (!legacyIds.has(id)) continue;
    out.checked++;
    const legacyBag = comps.get(id) ?? null;
    const shadowBag = shadow.entities[id].comp ?? null;
    if (jstr(legacyBag) !== jstr(shadowBag)) {
      out.compDiffs.push({ id, legacy: legacyBag, shadow: shadowBag });
    }
    // identity: the fold's word on WHAT this id is (a light? which model?)
    // vs what the scene realized — where same-id-spawn overwrite semantics
    // would drift first (a still-loading reservation has no meta yet: skip)
    const meta = entityMeta.get(id);
    if (meta) {
      const ent = shadow.entities[id];
      const sceneKind = meta.kind === 'light' ? 'light' : 'model';
      const foldKind = ent.kind === 'light' ? 'light' : 'model';
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
      const sock = rel.slot ? shadow.entities[rel.to]?.comp?.sockets?.[rel.slot] : null;
      if (!sock?.part) {
        const off = rel.offset ?? sock?.pos ?? [0, 0, 0];
        const d = Math.hypot(obj.position.x - off[0], obj.position.y - off[1], obj.position.z - off[2]);
        if (d > 0.05) out.mountPoseDiffs.push({ id, expected: off, actual: obj.position.toArray(), d: +d.toFixed(3) });
      }
    }
  }

  // body mounts: world.js's avatarMounts map vs the fold's mounts record
  const shadowMounts = shadow.mounts ?? {};
  const legacyMounts = avatarMounts instanceof Map ? Object.fromEntries(avatarMounts) : (avatarMounts ?? {});
  for (const id of new Set([...Object.keys(shadowMounts), ...Object.keys(legacyMounts)])) {
    if (jstr(legacyMounts[id]) !== jstr(shadowMounts[id])) {
      out.mountDiffs.push({ id, legacy: legacyMounts[id] ?? null, shadow: shadowMounts[id] ?? null });
    }
  }

  out.ok = !out.onlyShadow.length && !out.onlyLegacy.length
    && !out.compDiffs.length && !out.mountDiffs.length && !out.identityDiffs.length
    && !out.parentDiffs.length && !out.mountPoseDiffs.length;
  console.log(`[parity] ${out.ok ? '✓ fold and scene agree' : '✗ DRIFT'} — ` +
    `${out.checked} entities checked, +${out.onlyShadow.length} shadow-only, ` +
    `+${out.onlyLegacy.length} legacy-only, ${out.compDiffs.length} comp diffs, ` +
    `${out.mountDiffs.length} mount diffs, ${out.identityDiffs.length} identity diffs, ` +
    `${out.parentDiffs.length} parent diffs, ${out.mountPoseDiffs.length} mount-pose diffs ` +
    `(seq ${out.lastSeq})`);
  return out;
}
