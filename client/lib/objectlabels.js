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
const positioned = [];

function refresh() {
  // Folded entities are keyed by ID; values deliberately contain no `id`.
  records = Object.entries(state.st.entities).map(([id, entity]) => ({
    entity, ...objectIdentity({ ...entity, id }, state.st.assets),
  }));
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
    plaque.onclick = () => showDetails(plaque.dataset.entityId);
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
    // Label activation never becomes a movement hotkey or an avatar grab.
    element.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') close.click();
    });
    for (const type of ['pointerdown', 'mousedown', 'click']) element.addEventListener(type, event => event.stopPropagation());
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
    let anchor = anchors.get(object);
    if (!anchor) {
      const box = new THREE.Box3().setFromObject(object);
      anchor = new THREE.Vector3();
      if (box.isEmpty()) continue; // Loading placeholders have no meaningful bounds.
      box.getCenter(anchor);
      anchor.y = box.max.y;
      object.worldToLocal(anchor);
      anchors.set(object, anchor);
    }
    if (record.offset) point.fromArray(record.offset);
    else point.copy(anchor);
    object.localToWorld(point);
    point.y += 0.2;
    projected.copy(point).project(camera);
    Object.assign(record, {
      wx: point.x, wy: point.y, wz: point.z, distance,
      inView: projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1,
      x: rect.left + (projected.x + 1) * rect.width / 2,
      y: rect.top + (1 - projected.y) * rect.height / 2,
    });
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
  const occupied = [];
  const clear = visible.filter(record => {
    if (record.occluded) return false;
    const width = Math.min(220, [...record.name].length * 13 + 20);
    const box = { left: record.x - width / 2, right: record.x + width / 2, top: record.y - 32, bottom: record.y };
    if (box.left < 4 || box.right > innerWidth - 4 || box.top < 4) return false;
    if (occupied.some(other => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 4 && box.bottom > other.top - 4)) return false;
    occupied.push(box);
    return true;
  });
  const byId = new Map(clear.map(record => [record.id, record]));
  const assigned = new Set();
  for (const plaque of plaques) {
    const id = plaque.dataset.entityId;
    plaque.hidden = !byId.has(id);
    if (!plaque.hidden) assigned.add(id);
    else if (document.activeElement === plaque) plaque.blur();
  }
  for (const record of clear) {
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
  return { html: `<fieldset><legend>Object label</legend><label>Name <input data-label-name maxlength="120" value="${esc(label.name)}"></label><label>Description <textarea data-label-description maxlength="2000">${esc(label.description)}</textarea></label><label>Visibility <select data-label-visibility>${['nearby', 'always', 'inspect'].map(value => `<option ${value === label.visibility ? 'selected' : ''}>${value}</option>`).join('')}</select></label><button data-label-save>Save label</button><button data-label-remove>Remove label</button></fieldset>`, wire(root) {
    root.querySelector('[data-label-save]').onclick = () => commit('comp', { id, type: 'label', data: {
      name: root.querySelector('[data-label-name]').value,
      description: root.querySelector('[data-label-description]').value,
      visibility: root.querySelector('[data-label-visibility]').value,
      ...(label.offset ? { offset: label.offset } : {}),
    } });
    root.querySelector('[data-label-remove]').onclick = () => commit('comp', { id, type: 'label', data: null });
  } };
});
