// Optional, local presentation of authored labels. The fold and world stay untouched.
import { THREE, camera, renderer } from './core.js';
import { CONFIG, bus } from './base.js';
import { raySegment } from './colliders.js';
import { entities } from './world.js';
import { state, onWorldChange } from './state.js';
import { objectIdentity, readLabel, visibleLabels } from '../../shared/label.js';
import { registerEditor } from './inspect.js';

let mode = CONFIG.objectLabels ?? 'off', overlay, panel, content, selected = null;
let records = [], authoredRecords = [], candidates = [], lastCandidates = -Infinity, lastSight = 0, cursor = 0;
const anchors = new WeakMap(), plaques = [];
const point = new THREE.Vector3(), projected = new THREE.Vector3(), direction = new THREE.Vector3();
// Reused every frame: tickObjectLabels runs at frame rate and is not reentrant.
const positioned = [], occupied = [], cleared = [], byId = new Map(), assigned = new Set();
// The keys the overlay itself consumes. Everything else -- movement above all --
// must keep bubbling to window even while a plaque holds focus.
const CONSUMED_KEYS = new Set(['Enter', ' ', 'Spacebar', 'Escape', 'Esc']);

function refresh() {
  // Folded entities are keyed by ID; values deliberately contain no `id`.
  records = Object.entries(state.st.entities).map(([id, entity]) => {
    const record = { entity, ...objectIdentity({ ...entity, id }, state.st.assets) };
    // Code-point count for the plaque width, measured once here rather than by
    // spreading the name into a throwaway array per visible label per frame.
    // Names only ever change by rebuilding this array, so it cannot go stale.
    record.nameLength = [...record.name].length;
    return record;
  });
  authoredRecords = records.filter(record => record.authored);
  lastCandidates = -Infinity;
  if (selected) showDetails(selected);
}

function closeDetails() {
  selected = null;
  if (panel) panel.hidden = true;
}

function showDetails(id) {
  const record = records.find(record => record.id === id);
  if (!record) { closeDetails(); return; }
  selected = id;
  lastCandidates = -Infinity;
  content.replaceChildren();
  const heading = document.createElement('h2');
  heading.id = 'ew-object-title';
  heading.textContent = record.name;
  content.append(heading);
  if (record.description) {
    const description = document.createElement('p');
    description.textContent = record.description;
    content.append(description);
  }
  // Details describe the object. Technical identity stays in the scene tree.
  for (const [title, values] of [
    ['Seats', record.entity.comp?.sockets], ['Actions', record.entity.comp?.reactions],
  ]) {
    if (!values || typeof values !== 'object' || !Object.keys(values).length) continue;
    const text = document.createElement('p');
    text.textContent = `${title}: ${Object.keys(values).join(', ')}`;
    content.append(text);
  }
  panel.hidden = false;
}

/** Host-local rendering config. Unset/invalid mode disables the whole overlay.
 * No localStorage: enabling labels in one embed must not enable other worlds. */
export function configureObjectLabels({ mode: value = 'off' } = {}) {
  mode = ['nearby', 'all', 'off'].includes(value) ? value : 'off';
  lastCandidates = -Infinity;
  if (mode !== 'off') initObjectLabels();
  else {
    for (const plaque of plaques) plaque.hidden = true;
  }
}

export function initObjectLabels() {
  if (overlay || mode === 'off') return;
  const style = document.createElement('style');
  style.textContent = `
    .ew-object-labels { position:fixed; inset:0; pointer-events:none; z-index:5; overflow:hidden }
    .ew-object-labels button { position:absolute; pointer-events:auto; max-width:min(220px,calc(100vw - 24px));
      min-height:32px; padding:5px 9px; border:1px solid #9cd6c599; border-radius:6px;
      color:#e8fff7; background:#102425e8; font:600 13px/20px monospace;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer;
      transform:translate(-50%,-100%); box-shadow:0 2px 6px #0008 }
    .ew-object-labels button:hover, .ew-object-labels button:focus-visible { outline:2px solid #b7ffe6; background:#254845 }
    .ew-object-detail { position:fixed; right:12px; top:70px; z-index:25;
      box-sizing:border-box; width:min(300px,calc(100vw - 24px)); max-height:60vh;
      overflow:auto; padding:14px; border:1px solid #9cd6c599; border-radius:8px;
      color:#e8fff7; background:#102425f5; font:14px/1.5 sans-serif; overflow-wrap:anywhere }
    .ew-object-detail h2 { margin:0 0 8px; font:600 16px/1.4 sans-serif }
    .ew-object-detail p { margin:8px 0 }
    .ew-object-detail button { min-height:36px; margin-top:8px; padding:4px 10px;
      border:1px solid #9cd6c599; border-radius:5px; color:inherit; background:#254845; cursor:pointer }
    .ew-object-labels [hidden], .ew-object-detail[hidden] { display:none !important }
  `;
  overlay = document.createElement('div');
  overlay.className = 'ew-object-labels';
  overlay.setAttribute('role', 'group');
  overlay.setAttribute('aria-label', 'World object labels');
  for (let i = 0; i < 32; i++) {
    const plaque = document.createElement('button');
    plaque.type = 'button';
    plaque.hidden = true;
    // A mouse activation must not leave the plaque holding focus (the mousedown
    // preventDefault below already suppresses it in Chromium; this is the belt).
    // A keyboard activation reports detail 0 and KEEPS focus, or Tab-to-activate
    // would dump the user back at the top of the document on every press.
    plaque.onclick = event => {
      if (event.detail > 0) plaque.blur();
      showDetails(plaque.dataset.entityId);
    };
    overlay.append(plaque);
    plaques.push(plaque);
  }
  panel = document.createElement('section');
  panel.className = 'ew-object-detail';
  panel.id = 'ew-object-detail';
  panel.setAttribute('aria-labelledby', 'ew-object-title');
  panel.hidden = true;
  content = document.createElement('div');
  content.setAttribute('aria-live', 'polite');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close details';
  close.onclick = () => {
    const previous = selected;
    closeDetails();
    plaques.find(plaque => !plaque.hidden && plaque.dataset.entityId === previous)?.focus();
  };
  panel.append(content, close);
  for (const element of [panel, overlay]) {
    // Label activation never becomes a movement hotkey or an avatar grab --
    // but ONLY for the keys this overlay actually consumes. Stopping every
    // keydown killed keyboard play outright: these plaques are <button>s, a
    // click focused one, and from then on W/A/S/D died at the overlay instead
    // of reaching the movement listener in controller.js. Tab is deliberately
    // NOT consumed -- focus must be able to leave a floating world label.
    element.addEventListener('keydown', event => {
      if (!CONSUMED_KEYS.has(event.key)) return;
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Esc') close.click();
    });
    for (const type of ['pointerdown', 'mousedown', 'click']) element.addEventListener(type, event => {
      event.stopPropagation();   // a look-drag must never start under a plaque
      // Keep the mouse from parking focus on a button; Tab still reaches it.
      if (type === 'mousedown' && event.target?.closest?.('button')) event.preventDefault();
    });
  }
  document.head.append(style);
  document.body.append(overlay, panel);
  onWorldChange(event => {
    if (event.type !== 'entry' || ['spawn', 'light', 'remove', 'comp', 'asset'].includes(event.entry.verb)) refresh();
  });
  bus.on('entity', ({ id }) => { if (selected === id) showDetails(id); });
  refresh();
}

function positions(source = authoredRecords) {
  const rect = renderer.domElement.getBoundingClientRect();
  positioned.length = 0;
  camera.updateMatrixWorld();
  for (const record of source) {
    const object = entities.get(record.id);
    if (!object || !object.visible || object.userData.placeholder) continue;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(point);
    const distance = point.distanceTo(camera.position);
    if (distance > 60) continue;
    // An authored offset is complete on its own. It needs no bounds -- labelling
    // a geometry-less marker Group is the case it exists for, and measuring that
    // Group first sent it down the isEmpty() path, so it never rendered at all --
    // and it takes no clearance bump, because the builder placed it exactly where
    // they meant it. The measured anchor is the one docs/labels.md gives the 0.2m
    // of air above the model's top.
    if (record.offset) {
      point.fromArray(record.offset);
      object.localToWorld(point);
    } else {
      let anchor = anchors.get(object);
      if (anchor === undefined) {
        const box = new THREE.Box3().setFromObject(object);
        // Cache the MISS as well (null, hence the `=== undefined` test above):
        // setFromObject walks the entire subtree, and bailing before the write
        // re-walked every geometry-less object EVERY FRAME. Caching forever is
        // safe because nothing grows geometry in place -- realizeModel(),
        // demote() and createLight() each `entities.set()` a brand-new
        // Object3D, which re-keys this WeakMap on its own.
        anchor = null;
        if (!box.isEmpty()) {
          anchor = new THREE.Vector3();
          box.getCenter(anchor);
          anchor.y = box.max.y;
          object.worldToLocal(anchor);
        }
        anchors.set(object, anchor);
      }
      if (!anchor) continue;   // no meaningful bounds, and never will have
      point.copy(anchor);
      object.localToWorld(point);
      point.y += 0.2;
    }
    projected.copy(point).project(camera);
    // Written field by field, not through an Object.assign literal: this runs
    // per visible label per frame and the literal was pure garbage.
    record.wx = point.x; record.wy = point.y; record.wz = point.z;
    record.distance = distance;
    record.inView = projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
    record.x = rect.left + (projected.x + 1) * rect.width / 2;
    record.y = rect.top + (1 - projected.y) * rect.height / 2;
    positioned.push(record);
  }
  return positioned;
}

export function tickObjectLabels(now = performance.now()) {
  if (!overlay || mode === 'off') return;
  if (now - lastCandidates >= 100) {
    candidates = visibleLabels(positions(), mode, selected);
    lastCandidates = now;
  }
  // The full authored set is scanned at 10Hz; only the bounded shortlist
  // follows camera/motion every frame.
  const visible = visibleLabels(positions(candidates), mode, selected);
  // Bounds and projection follow live transforms every frame. Collider queries
  // are sampled at 10Hz with a fixed four-ray budget.
  if (now - lastSight >= 100) {
    lastSight = now;
    for (let n = 0; n < Math.min(4, visible.length); n++) {
      const record = visible[cursor++ % visible.length];
      direction.set(record.wx, record.wy, record.wz).sub(camera.position);
      const distance = direction.length();
      record.occluded = distance > 0 && raySegment(camera.position, direction.normalize(), distance, record.id) !== null;
    }
  }
  occupied.length = 0;
  cleared.length = 0;
  for (const record of visible) {
    if (record.occluded) continue;
    const width = Math.min(220, record.nameLength * 13 + 20);
    // `bottom` is clamped too: without it a label near the bottom edge rendered
    // half off-screen instead of being suppressed like every other edge case.
    const box = { left: record.x - width / 2, right: record.x + width / 2, top: record.y - 32, bottom: record.y };
    if (box.left < 4 || box.right > innerWidth - 4 || box.top < 4 || box.bottom > innerHeight - 4) continue;
    if (occupied.some(other => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 4 && box.bottom > other.top - 4)) continue;
    occupied.push(box);
    cleared.push(record);
  }
  byId.clear();
  assigned.clear();
  for (const record of cleared) byId.set(record.id, record);
  for (const plaque of plaques) {
    const id = plaque.dataset.entityId;
    plaque.hidden = !byId.has(id);
    if (!plaque.hidden) assigned.add(id);
    else if (document.activeElement === plaque) plaque.blur();
  }
  for (const record of cleared) {
    if (assigned.has(record.id)) continue;
    const plaque = plaques.find(plaque => plaque.hidden);
    if (!plaque) break;
    plaque.dataset.entityId = record.id;
    plaque.hidden = false;
  }
  for (const plaque of plaques) {
    if (plaque.hidden) continue;
    const record = byId.get(plaque.dataset.entityId);
    if (plaque.textContent !== record.name) plaque.textContent = record.name;
    plaque.setAttribute('aria-label', `About ${record.name}`);
    plaque.setAttribute('aria-controls', 'ew-object-detail');
    plaque.setAttribute('aria-expanded', String(record.id === selected));
    plaque.style.left = `${record.x}px`;
    plaque.style.top = `${record.y}px`;
  }
}

registerEditor(({ id, bag, commit, esc }) => {
  const label = readLabel(bag.label);
  return { html: `<fieldset><legend>Object label</legend><label>Name <input data-label-name maxlength="120" value="${esc(label.name)}"></label><label>Description <textarea data-label-description maxlength="2000">${esc(label.description)}</textarea></label><label>Visibility <select data-label-visibility>${[['nearby', 'nearby'], ['always', 'always'], ['inspect', 'inspect (all-nearby mode only)']].map(([value, caption]) => `<option value="${value}" ${value === label.visibility ? 'selected' : ''}>${caption}</option>`).join('')}</select></label><button data-label-save>Save label</button><button data-label-remove>Remove label</button></fieldset>`, wire(root) {
    root.querySelector('[data-label-save]').onclick = () => commit('comp', { id, type: 'label', data: {
      name: root.querySelector('[data-label-name]').value,
      description: root.querySelector('[data-label-description]').value,
      visibility: root.querySelector('[data-label-visibility]').value,
      ...(label.offset ? { offset: label.offset } : {}),
    } });
    root.querySelector('[data-label-remove]').onclick = () => commit('comp', { id, type: 'label', data: null });
  } };
});
