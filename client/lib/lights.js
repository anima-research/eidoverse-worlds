// lights — placed light sources, as authored entities.
//
// A light is a Thing: it persists, replays, and folds into the snapshot, so it
// is a `light` VERB, not presence. Each one renders two parts:
//
//   * a small emissive sphere GIZMO — always shown, cheap (one basic material,
//     no scene-wide cost), so a light is visible and selectable even when it
//     isn't casting;
//   * a REQUEST to the light rig (lightrig.js) — the rig owns a fixed pool of
//     point-light slots born at boot, and assigns them by priority: `keep`
//     first, authored placed lights next, inferred lamps last, ties by
//     camera distance. Winning a slot is uniform writes, never a recompile.
//
// The budget that used to live here (MAX_CAST, grantCast, the shared count
// with sky.js's lamps, the one-way governor ratchet) is gone — it existed
// because adding a PointLight recompiled every material in the scene, and the
// rig's fixed topology deletes that cost. `keep: true` is top PRIORITY in the
// rig, not a budget escape: an author saying "this light matters", honored
// ahead of everything sheddable, but the pool is the pool.
//
// Placed lights live in time of day like lamps do (the rig dims them by
// dayness); the deliberate noon-burning porch light gets its opt-out verb
// arg with the 5f spec work.

import { THREE, bus } from './core.js';
import { requestLight, updateRequest, releaseLight, isCasting } from './lightrig.js';
import { registerEditor } from './inspect.js';

// governor compatibility re-exports (main.js's shed lever; 5d replaces)
export { shedALight, litCount } from './lightrig.js';

/** A bare gizmo mesh — the visible, always-cheap part. Used both for a placed
 *  light and as the placement ghost. */
export function makeLightGizmo(color = 0xffd9a0) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 16, 12),
    // basic node material: emits its colour regardless of scene lighting, so
    // the gizmo reads as a glowing bulb and costs no lighting recompute
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color), toneMapped: false }),
  );
  m.userData.noCamCollide = true;   // don't let the camera collide with a bulb
  m.castShadow = m.receiveShadow = false;
  m.userData.noWet = true;          // a glowing bulb does not get rained dark —
  m.userData.noCloudShadow = true;  // and the sweep must not recompile it
  return m;
}

/** Build a placed-light entity: gizmo + a rig request keyed to its id. The
 *  slot follows the group, so a `place` moves the cast with the bulb. */
export function makeLight({ color = 0xffd9a0, intensity = 16, range = 10, keep = false, day } = {}, owner = null) {
  const group = new THREE.Group();
  const gizmo = makeLightGizmo(color);
  group.add(gizmo);

  group.userData.isLight = true;
  group.userData.lightParams = { color, intensity, range, keep: !!keep, day: day !== false };
  group.userData.noCamCollide = true;

  const key = `placed:${owner ?? group.uuid}`;
  group.userData.rigKey = key;
  requestLight(key, {
    obj: group, color, intensity, range,
    keep: !!keep, authored: true, dayAware: day !== false,
    owner: owner ? `entity:${owner}` : null,
  });
  return group;
}

/** Partial update of a placed light — the render side of re-issuing the
 *  `light` verb on an existing id. Only fields present in the patch change;
 *  the fold upstream merges the same way, so a joiner and a live client
 *  agree. Slot assignment reacts on the rig's next pass — checking "keep
 *  lit" on an outbid light re-lights it visibly. */
export function updateLight(group, { color, intensity, range, keep, day } = {}) {
  if (!group?.userData?.isLight) return;
  const p = group.userData.lightParams;
  if (color != null) p.color = color;
  if (intensity != null) p.intensity = intensity;
  if (range != null) p.range = range;
  if (keep != null) p.keep = !!keep;
  if (day != null) p.day = day !== false;

  if (color != null) {
    const gizmo = group.children.find((o) => o.isMesh);
    gizmo?.material?.color?.set(new THREE.Color(color));
  }
  updateRequest(group.userData.rigKey, {
    color: p.color, intensity: p.intensity, range: p.range, keep: p.keep,
    dayAware: p.day,
  });
}

/** Free a light: release its request (the rig re-fills the slot) and dispose
 *  the gizmo. */
export function disposeLight(group) {
  if (!group?.userData?.isLight) return;
  releaseLight(group.userData.rigKey);
  group.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m?.dispose?.());
    else o.material?.dispose?.();
  });
}

// ---- the editor's commit coalescer + refusal rollback -------------------------
// A colour-picker gesture fires input/change continuously; committing every
// event ate the whole verb budget (VERB_RATE, 12 per 4s) mid-drag, the server
// refused the rest, and the local preview ran ahead of a fold that never
// heard it — until the next rejoin snapped the light back. So edits commit at
// most one `light` verb per EDIT_COMMIT_MS (a trailing send guarantees the
// FINAL value of the gesture), and a refusal rolls the preview back to fold
// truth: net.js announces 'verb-refused' on the bus, this module names every
// light with an edit in flight ('light-refused'), and the models realizer
// re-derives it from state — one refreshLight call, live ≡ join.
const EDIT_COMMIT_MS = 350;   // 4000/350 ≈ 11.4 per rate window, under VERB_RATE
                              // (chatbridge paces world verbs the same way)
const liveEdits = new Map();  // id -> { commit, pending, sent, timer, lastSend }

function queueCommit(id, commit, patch) {
  let e = liveEdits.get(id);
  if (!e) liveEdits.set(id, e = { commit, pending: null, sent: null, timer: 0, lastSend: 0 });
  e.commit = commit;
  if (Date.now() - e.lastSend > 5000) e.sent = null;   // dedup is per-gesture, not forever
  // drop echoes: range/checkbox controls fire `change` with the exact value
  // the throttled `input` send already carried — one gesture, one final verb
  const fresh = Object.entries(patch).filter(([k, v]) => e.sent?.[k] !== v);
  if (!fresh.length && !e.pending) return;
  e.pending = { ...(e.pending ?? {}), ...patch };
  if (e.timer) return;   // a trailing send is armed and will carry this value
  const wait = EDIT_COMMIT_MS - (Date.now() - e.lastSend);
  const flush = () => {
    e.timer = 0;
    if (!e.pending) return;
    const args = e.pending;
    e.pending = null;
    e.sent = { ...(e.sent ?? {}), ...args };
    e.lastSend = Date.now();
    e.commit('light', { id, ...args });
  };
  if (wait <= 0) flush();
  else e.timer = setTimeout(flush, wait);
}

// Refusals arrive as a bare {type:'error'} with prose — the wire names no
// verb, but every refusal on this socket is OURS, and rolling an edited
// light back to fold truth is correct even when the refusal was for
// something else: if the light verb actually landed, its log entry
// re-applies it a beat later. Convergence either way.
bus.on('verb-refused', () => {
  const now = Date.now();
  for (const [id, e] of liveEdits) {
    const inFlight = Boolean(e.timer) || e.pending != null || now - e.lastSend < 5000;
    if (e.timer) { clearTimeout(e.timer); e.timer = 0; }
    if (inFlight) bus.emit('light-refused', { id });
    liveEdits.delete(id);
  }
});

// ---- the inspector's light editor -------------------------------------------
// Registered here because the MEANING of these fields lives in this module:
// what a sane brightness range is, and what `keep` honestly promises (top
// priority in the slot pool — but still glow-only when the pool is spent on
// other keeps). Dragging previews locally through updateLight and commits
// through the coalescer above — at most one partial `light` verb per
// EDIT_COMMIT_MS (just the touched field — the fold merges), with the
// gesture's final value always sent on release.
registerEditor(({ id, obj, commit }) => {
  if (!obj?.userData?.isLight) return null;
  const p = obj.userData.lightParams ?? {};
  const hex = '#' + (p.color ?? 0xffd9a0).toString(16).padStart(6, '0');
  const inten = p.intensity ?? 16;
  const range = p.range ?? 10;
  return {
    html: `<div style="display:flex;flex-direction:column;gap:4px;margin:4px 0">
      <label style="display:flex;gap:6px;align-items:center">color
        <input type="color" data-lp="color" value="${hex}"></label>
      <label style="display:flex;gap:6px;align-items:center">brightness
        <input type="range" data-lp="intensity" min="0" max="${Math.max(64, inten)}" step="1" value="${inten}" style="flex:1">
        <span data-lp-out="intensity" style="min-width:2.5em;text-align:right">${inten}</span></label>
      <label style="display:flex;gap:6px;align-items:center">range
        <input type="range" data-lp="range" min="1" max="${Math.max(40, range)}" step="1" value="${range}" style="flex:1">
        <span data-lp-out="range" style="min-width:2.5em;text-align:right">${range}</span></label>
      <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
        <input type="checkbox" data-lp="keep" ${p.keep ? 'checked' : ''}>
        keep lit — first claim on a light slot, never governor-shed</label>
      <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
        <input type="checkbox" data-lp="day" ${p.day === false ? 'checked' : ''}>
        burns at noon — opts out of the day cycle</label>
      ${isCasting(obj.userData.rigKey) ? '' : '<div style="color:var(--dim);font-size:11px">glow-only right now (slot pool spent) — it may still cast for others</div>'}
    </div>`,
    wire(root) {
      for (const el of root.querySelectorAll('[data-lp]')) {
        const field = el.dataset.lp;
        const read = () =>
          field === 'color' ? parseInt(el.value.slice(1), 16)
            : field === 'keep' ? el.checked
              : field === 'day' ? !el.checked   // checked = burns at noon = day:false
                : Number(el.value);
        el.addEventListener('input', () => {
          updateLight(obj, { [field]: read() });
          // commit rides the drag, coalesced — the fold tracks the preview
          // instead of hearing one stale gesture-end after a rate refusal
          queueCommit(id, commit, { [field]: read() });
          const out = root.querySelector(`[data-lp-out="${field}"]`);
          if (out) out.textContent = el.value;
        });
        el.addEventListener('change', () => {
          updateLight(obj, { [field]: read() });
          queueCommit(id, commit, { [field]: read() });   // final value, always sent (trailing)
          el.blur();   // release focus so the panel's held repaints resume
        });
      }
    },
  };
});
