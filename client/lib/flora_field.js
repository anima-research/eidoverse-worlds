// flora_field — field lifecycle assembly, DOM-free (unit-tested in
// spec/flora_field.test.ts). A "field" is the setGrass-shaped object the
// grass verb owns: possibly several engine strokes composed under one group.

import { ownHook, releaseHook } from './autohooks.js';
import { densityCount } from './grass_quality.js';

// ---- applied truth (#74) ---------------------------------------------------
// The density dial can silently no-op: wireDensityDial returns early when a
// stroke's expected instanced attributes are absent (vegetation.js version
// skew), leaving the stroke without setDensity, and the composed dial
// optional-chains every child. Policy arithmetic then reports a density the
// renderer never applied. These reports read the LIVE draw state — the
// instanced mesh's actual count — never the arithmetic, so a resident-facing
// surface can say when the cap did not take.

/** One stroke's draw truth for a requested density factor. */
export function strokeApplied(f, eff, i = 0) {
  const stroke = f.strokeLabel ?? `stroke ${i}`;
  const total = f.count ?? 0;
  // a stroke that planted nothing draws nothing — any factor is vacuously on
  if (!total) return { stroke, total: 0, drawn: 0, expected: 0, dial: false, ok: true, why: 'empty' };
  const drawn = f.mesh?.count ?? total;
  const stemDrawn = f.stemMesh?.count;
  const expected = densityCount(total, eff);
  const dial = typeof f.setDensity === 'function';
  const ok = drawn === expected && (stemDrawn == null || stemDrawn === expected);
  return {
    stroke, total, drawn, ...(stemDrawn != null ? { stemDrawn } : {}), expected, dial, ok,
    why: ok ? 'applied' : dial ? 'count-mismatch' : 'no-density-dial',
  };
}

/** The whole field's draw truth. `off` (eff ≤ 0) is enforced by group
 *  visibility — terrain hides the group — so it applies even where count
 *  dialing is unsupported; any positive factor needs every live stroke's
 *  actual count to match what densityCount requested. */
export function fieldApplied({ fields, groupVisible }, eff) {
  if (eff <= 0) {
    const ok = groupVisible === false;
    return {
      status: ok ? 'applied' : 'not-applied',
      via: 'visibility',
      strokes: fields.map((f, i) => ({
        stroke: f.strokeLabel ?? `stroke ${i}`, total: f.count ?? 0,
        drawn: ok ? 0 : (f.mesh?.count ?? f.count ?? 0), expected: 0,
        dial: typeof f.setDensity === 'function', ok,
        why: ok ? 'hidden' : 'group-still-visible',
      })),
    };
  }
  const strokes = fields.map((f, i) => strokeApplied(f, eff, i));
  const live = strokes.filter((s) => s.total > 0);
  const status = live.every((s) => s.ok) ? 'applied'
    : live.some((s) => s.ok) ? 'partial' : 'unavailable';
  return { status, via: 'count', strokes };
}

/** Compose stroke fields (createFlora results) + a clearing mask handle into
 *  ONE setGrass-shaped field. The caller supplies the parent group (THREE
 *  lives with the caller) and appends any host hooks (pushers) to autoHooks. */
export function composeField({ group, fields, mask }) {
  return {
    mesh: group,
    material: fields[0]?.material,
    update: fields[0]?.update,
    setPushers: (list) => { for (const f of fields) f.setPushers?.(list); },
    setDensity: (k) => { for (const f of fields) f.setDensity?.(k); },
    /** live draw truth for a requested factor (#74) — group.visible read at
     *  call time so `off` reports what the scene actually shows */
    applied: (eff) => fieldApplied({ fields, groupVisible: group.visible }, eff),
    // The engine registered these itself; marking them says the meadow retires
    // them, so no subsystem that claims per-frame hooks by diffing the global
    // array may adopt one that appeared while ITS own async build was in
    // flight (see autohooks.js).
    autoHooks: fields.map((f) => ownHook(f.update)).filter(Boolean),
    dispose: () => {
      for (const f of fields) f.dispose?.();
      mask?.dispose?.();
    },
  };
}

/** Retire a field completely: unhook its per-frame updates, release its GPU
 *  resources, remove it from the scene. Prefers the field's own dispose()
 *  (engine fields know their textures); falls back to the legacy single-mesh
 *  teardown for fields that predate it. Safe against double-removal. */
export function retireField(field, autos, scene) {
  if (!field) return;
  const hooks = field.autoHooks ?? (field.update ? [field.update] : []);
  for (const h of hooks) releaseHook(h, autos);
  if (field.dispose) {
    field.dispose();
  } else if (field.mesh) {
    field.mesh.geometry?.dispose?.();
    const m = field.mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.()); else m?.dispose?.();
  }
  if (field.mesh) scene?.remove?.(field.mesh);
}
