// panels — schema-driven edit surfaces (design of 2026-08-04 21:52).
//
// A panel is a FRAME on desktop and a laser-clickable QUAD in VR, and the way
// that stays true is that a panel never owns bespoke DOM: it declares FIELDS —
// a serializable schema — and a renderer builds them. Two renderers live here,
// one target each, sharing the schema and a single action dispatcher:
//
//   renderDOM(body, fields, edit)              → frame body (desktop)
//   renderCanvas(canvas, fields) → hit regions → quad texture (VR); a laser
//     UV-hit resolves to a region and dispatches the SAME edit(action, payload)
//
// Field design rule (live, 21:58): every field must be operable with no keyboard —
// numbers are steppers, actions are buttons, lists are rows. Free-text exists
// on desktop (rename, comp JSON) and degrades to display-only in VR rather
// than summoning a keyboard nobody wants to float-type on.
//
// field specs (plain JSON, no closures — actions are string keys):
//   { t:'info',   label, value }
//   { t:'num',    k, label, value, step=0.1, dp=2, min?, max?, softMin?, softMax?,
//                 unit?, deg?, compact?, drag? }                  → edit(k, newValue)
//   { t:'vec3',   k, label, value:[x,y,z], step=0.1, dp=2, link? } → edit(k, [x,y,z], axis|null)
//   { t:'text',   k, label, value, placeholder? }                 → edit(k, string)  [desktop only]
//   { t:'ref',    k, label, value:id|null, arming?, filter? }      → edit(k) to arm the pick;
//                 the next thing clicked (a tree row or the thing in the world) names the
//                 target and commits edit(k, id). value shows the current target or '—'.
//                 A ✕ on a filled ref clears it: edit(k, null).
//   { t:'btn',    k, label, danger?, icon? }                      → edit(k)   (icon: an icons.js glyph before the label)
//   { t:'tiles',  k, value, options:[{v, label, icon?, img?, hint?}], empty? }
//                 a grid of tiles — an icon or a picture over a short label; the tile whose v is
//                 `value` reads as armed. Clicking dispatches edit(k, v) (the owner decides
//                 whether clicking the armed one disarms it)        → edit(k, v)
//   { t:'json',   k, label, value:string, collapsed? }            → edit(k, jsonText)  [desktop; the quad shows a one-line summary]
//   { t:'log',    lines:[string], empty? }   a scrolling console tail; the VR quad shows the newest line
//   { t:'range',  k, label, value, min=0, max=1, step=0.01, dp=2, unit? } → edit(k, number)  [a slider on BOTH renderers]
//   { t:'list',   k?, label, empty?, rows:[{ id, label, sub?, active?,
//                 actions:[{k, label, danger?}] }] }              → edit(a.k, rowId) / edit(k ?? 'row', rowId)
//   { t:'check',  k, label, value, hint? }                        → edit(k, bool)
//   { t:'enum',   k, label, value, options:[{v,label}] }          → edit(k, v)
//   { t:'color',  k, label, value:0xRRGGBB }                      → edit(k, int)
//   { t:'group',  k, label, open? }   marker: rows until the next marker belong to it;
//                 collapsed groups skip their rows                → edit('fold', k)
//   { t:'tree',   k, rows:[{ id, label, sub?, depth, active?, multi?, badges?:[], locked?, menu?, kids?, open?, dim? }],
//                 a Shift/Ctrl-click row dispatches edit(k, id, f, {extend:true}); dragging a row onto
//                 another dispatches edit('drop', {id, onto}) — onto empty tree space: {onto: null};
//                 rootDrop?: a label for a strip at the tree's foot, shown while a row is dragged, that drops {onto: null}
//                 menu?:[{k, label, danger?}] }   right-click a row → its menu (row.menu wins)
//                 rename?: current label — double-click / menu 'rename' edits it inline → edit('rename', id, f, {value})
//                 kids>0 draws a disclosure → edit('open', id)   → edit(k, id) / edit('lock', id) / edit(item.k, id)
// Every field also takes { disabled?, driven?, hint?, vrOnly?, def? } (def: the value ↺ reverts to) (vrOnly: painted on the VR quad, skipped
// on desktop — a button standing in for a key a headset lacks). Of the rest: disabled draws it
// read-only (a locked thing's pose); driven names what owns the value (a
// motion comp composes onto this rest pose) and marks the FIELD — edit chrome
// draws an amber edge and a `~` on the value, so an axis label keeps its x/y/z
// colour (provenance and axis both readable at once).
//
// The dispatcher is edit(k, value, field?, opts?). `field` is Godot's third
// signal arg (an axis index for vec3) so multi-select can assign one component
// without clobbering the others. `opts.live` is true while a drag is in
// progress: PREVIEW locally, no log traffic; a call without it is the gesture
// ending — commit ONE verb.
//
// num entry (desktop): drag the number to scrub — Godot's EditorSpinSlider
// shape (editor_spin_slider.cpp:108-136): the value is ALWAYS start + step ×
// distance, never accumulated, so a drag that wanders comes back to exactly
// where it began (Blender's #37453 drift is the failure this avoids). Shift =
// 0.1×, Ctrl = snap to whole units, Esc mid-drag restores the start value.
// Click without travel focuses the box to type; typed entry takes Maya's
// relative math: `+=2`, `-=.5`, `*=-1`, `/=2`, `+=10%`. Soft limits bound the
// drag; hard limits bound everything.

import { makeFrame } from './windows.js';
import { parseEntry } from '../../shared/editschema.js';
import { paintEdit } from './editpaint.js';
import { pictoRuns, hasPicto } from './edittheme.js';
import { svg as strokeSvg, rsvg, has as hasIcon, fsvg, hasFill, hasLine } from './icons.js';
// a name from either set: the line icons (24 grid) or the filled ones (the eye, R 10-10: the Hierarchy's eye drew nothing,
// 'eye' being a filled-set name the line-set function didn't know)
const iconSvg = (name, size = 18) => (hasIcon(name) ? strokeSvg(name, size) : hasFill(name) ? fsvg(name, size) : '');
import { KEYHINTS, engage, release, withKeys } from './keyhints.js';
export { parseEntry };

// ---------------------------------------------------------------- DOM renderer

export function makeSchemaFrame(key, opts) {
  const frame = makeFrame(key, opts);
  frame.body.classList.add('schema-panel');
  const ro = { icons: /\bedit\b/.test(opts?.className ?? '') };   // edit chrome draws pictographs as icons.js glyphs (edittheme.PICTO_ICON)
  // inner scroller — see .schema-scroll in index.html: a scrollbar on the body
  // itself steals the edge-resize band's pixels
  const scroll = document.createElement('div');
  scroll.className = 'schema-scroll';
  frame.body.append(scroll);
  guardActions(scroll);
  let live = null;                 // { key, rows, box } of the current paint
  let lastFields = null, pendingWhileFocused = false;

  function set(fields, edit) {
    lastFields = { fields, edit };
    // Same shape as what is on screen → update values in place: no node is
    // destroyed, a hovered button stays hovered, a scroll position holds.
    // (Godot routes a changed property to its one widget through
    // editor_property_map, editor_inspector.cpp:4870; this is that.)
    const key = shapeKey(fields);
    if (live && live.key === key) {
      live.box.edit = edit;
      // a hint is not shape either: provenance (who set it, when) arrives a moment after the paint and must reach the tooltip
      fields.forEach((f, i) => { const r = live.rows[i]; r?.update?.(f); if (r && f.t === 'group' && (r.title ?? '') !== (f.hint ?? '')) r.title = f.hint ?? ''; });
      // a focused input's update() skips itself (caret safety) — without this the
      // value it skipped was lost until some unrelated repaint came along
      holdUntilBlur();
      return;
    }
    // Rebuilding under a focused input eats the caret mid-edit; hold the
    // refresh until focus leaves the panel, then paint the queued state.
    if (holdUntilBlur()) return;
    // keep what is in view where it is (R 10-11 01:00: hiding a thing with the eye added a line above the Hierarchy's rows,
    // and every row jumped down, then back up on showing it): the first row in view, by its id, sits at the same height
    const top = scroll.getBoundingClientRect().top; let anchor = null;
    if (scroll.scrollTop > 0) for (const e of scroll.querySelectorAll('[data-id]')) { const t = e.getBoundingClientRect().top; if (t >= top) { anchor = { id: e.dataset.id, at: t }; break; } }
    live = { key, ...renderDOM(scroll, fields, edit, ro) };
    if (anchor) { const e = [...scroll.querySelectorAll('[data-id]')].find((x) => x.dataset.id === anchor.id); if (e) scroll.scrollTop += e.getBoundingClientRect().top - anchor.at; }
  }
  function holdUntilBlur() {
    const a = document.activeElement;
    if (!scroll.contains(a) || !/INPUT|TEXTAREA/.test(a.tagName)) return false;
    if (!pendingWhileFocused) {
      pendingWhileFocused = true;
      // repaint DIRECTLY, not via set(): during 'blur' some engines still report
      // the input as active, so update() would skip it again and the hold would
      // re-arm on an element that will never blur twice. The input is leaving;
      // a rebuild can no longer eat its caret.
      a.addEventListener('blur', () => {
        pendingWhileFocused = false;
        if (lastFields) live = { key: shapeKey(lastFields.fields), ...renderDOM(scroll, lastFields.fields, lastFields.edit, ro) };
      }, { once: true });
    }
    return true;
  }
  return { frame, set };
}

/** What makes two paints the same SHAPE: types, keys, fold state, options,
 *  and list membership. Values and labels are not shape — they update in
 *  place. */
export function shapeKey(fields) {
  return fields.map((f) => [f.t, f.k ?? '', f.disabled ? 1 : 0, f.driven ?? '',
    f.t === 'group' ? (f.open !== false ? 'o' : 'c') : '',
    f.t === 'enum' ? JSON.stringify(f.options ?? []) : '',
    f.t === 'tiles' ? JSON.stringify((f.options ?? []).map((o) => [o.v, o.label, o.img ?? '', o.icon ?? ''])) : '',
    (f.t === 'tree' || f.t === 'list') ? JSON.stringify(f.rows ?? []) : '',
    f.t === 'vec3' ? (f.link ? 'L' : '') : '',
    f.t === 'ref' ? ((f.value == null ? '0' : '1') + (f.arming ? 'A' : '')) : '',
  ].join('|')).join('\n');
}

/** Nav/action separation: a drag that BEGINS on a button must scroll, never
 *  fire the button. Resonite #707 / Neos #1040 — eight years of "I scrolled
 *  the component list and it nulled a field". Measured from pointerdown; a
 *  click that travelled is swallowed at capture, before any onclick. */
function guardActions(root) {
  let down = null;
  root.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
  // a release outside the scroller never clicks it: forget the origin, or the
  // next keyboard activation (clientX/Y 0) reads as travel and is swallowed
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => { setTimeout(() => { down = null; }, 0); }, true);
  root.addEventListener('click', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6 && !e.target.closest('.sp-num')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

let fieldClip = null;   // { value } — a copied field value, pasted by type (the OS clipboard gets a copy too)
export const _fieldClip = () => fieldClip;   // probes
const treeScroll = new Map();   // a tree field's scroll position, by its key, across rebuilds
let treeDrag = null;   // the tree row being dragged (id), across the dragstart → drop pair

export function renderDOM(body, fields, edit, ro = {}) {
  body.innerHTML = '';
  const box = { edit };
  const via = (...a) => box.edit(...a);
  const rows = [];
  let folded = false;
  for (const f of fields) {
    let row = null;
    if (f.t === 'group') { folded = f.open === false || !!f.vrOnly; row = f.vrOnly ? null : fieldDOM(f, via, ro); }   // a vrOnly group hides its rows too
    else if ((!folded || f.unfold) && !f.vrOnly) row = fieldDOM(f, via, ro);   // vrOnly: the quad's stand-in for a key the desktop has; unfold: shown even under a folded card (the Add Component bar)
    rows.push(row);
    if (row) body.append(row);
  }
  return { rows, box };
}

/** One context menu at a time, anywhere; closes on a click, Esc, or scroll. */
export function contextMenu(x, y, items, pick) {
  closeContextMenu();
  const m = el('div', 'sp-ctx');
  for (const it of items) {
    const b = el('button', `sp-ctx-item${it.danger ? ' danger' : ''}`, it.label);
    if (Array.isArray(it.parts)) { b.textContent = ''; b.append(it.parts[0], el('span', 'sp-ctx-name', it.parts[1]), it.parts[2] ?? ''); }   // a thing's name, in the accent colour
    if (it.title) b.title = it.title;
    b.onclick = () => { closeContextMenu(); pick(it.k); };
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  const off = (e) => { if (e.type === 'keydown' && e.key !== 'Escape') return; if (e.type === 'pointerdown' && m.contains(e.target)) return; closeContextMenu(); };
  m._off = off;
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, off, true);
  return m;
}
export function closeContextMenu() {
  const m = document.querySelector('.sp-ctx');
  if (!m) return;
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.removeEventListener(ev, m._off, true);
  m.remove();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const R2D = 180 / Math.PI;

/** Set an element's text; in edit chrome (ro.icons) a mapped pictograph becomes its icons.js glyph —
 *  the same glyph the VR painter draws, so the two surfaces agree and no emoji font is relied on. */
function put(e, s, icons) {
  s = String(s ?? '');
  if (!icons || !hasPicto(s)) { e.textContent = s; return e; }
  e.textContent = '';
  for (const r of pictoRuns(s)) {
    if (typeof r === 'string') e.append(r);
    else { const i = document.createElement('span'); i.className = 'sp-ico'; i.innerHTML = iconSvg(r.icon, 13); e.append(i); }
  }
  return e;
}

// scrub feel (R 10-04, Maya's Channel Box icons): how dragging a number feels, per viewer, never logged. speed: slow /
// medium / fast; accel: the further you drag the faster it goes (Maya's "hyperbolic"; R's default). Modifiers while
// dragging: Shift = 10× finer, Ctrl = whole numbers. Said in every number's tooltip and when a drag starts, because
// a modifier nobody can find doesn't exist (R: "SOOOO much hidden knowledge").
export const SCRUB_SPEEDS = { slow: 0.3, medium: 1, fast: 3 };
let scrubFeel = { speed: 'medium', accel: true };
try { scrubFeel = { ...scrubFeel, ...JSON.parse(localStorage.getItem('ew-scrub-feel') ?? '{}') }; } catch { /* defaults */ }
export const getScrubFeel = () => ({ ...scrubFeel });
export function setScrubFeel(next) { scrubFeel = { ...scrubFeel, ...next }; try { localStorage.setItem('ew-scrub-feel', JSON.stringify(scrubFeel)); } catch { /* fine */ } return getScrubFeel(); }
/** pixels dragged → how far the value moves, in units of one 'step' of travel */
export const scrubTravel = (px) => { const k = SCRUB_SPEEDS[scrubFeel.speed] ?? 1; return scrubFeel.accel ? px * k * (1 + Math.abs(px) / 120) : px * k; };
export const SCRUB_TIP = KEYHINTS.scrub.before;
// while scrubbing, the keys go on the status line (keyhints.js); the speed rides along
function scrubHint(on) { if (on) engage('scrub'); else release(); }

/** A number as edit mode writes it (R, 10-10, after Maya's channel box): no trailing zeros, a bare 0, a leading 0 before
 *  a fraction: 0.5 not 0.50, 0 not 0.00, 0.15 not .15, 2 not 2.00. `dp` is the most decimals shown. */
export function trimNum(v, dp = 2) {
  let s = (+v).toFixed(dp);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
function stepper(value, f, commit) {
  const cur = { step: 0.1, dp: 2, ...f };   // options are LIVE: update() refreshes them (a typed value past softMax raises the next drag's cap)
  const { unit, deg, compact, disabled } = cur;
  const wrap = el('span', `sp-step${compact ? ' compact' : ''}`);
  const num = el('input', 'sp-num');
  num.type = 'text'; num.inputMode = 'decimal'; num.autocomplete = 'off'; num.spellcheck = false;
  if (disabled) num.disabled = true;
  const toFace = (w) => trimNum(deg ? w * R2D : w, deg ? 0 : cur.dp);
  const toWire = (face) => (deg ? face / R2D : face);
  const hard = (w) => Math.min(cur.max ?? Infinity, Math.max(cur.min ?? -Infinity, w));
  const soft = (w) => Math.min(cur.softMax ?? cur.max ?? Infinity, Math.max(cur.softMin ?? cur.min ?? -Infinity, w));
  let wire = +value;
  let shownFace = '';   // the text show() last put in the field (onchange: the same text is no edit)
  const show = (w) => { num.value = toFace(w); shownFace = num.value; };
  show(wire);
  const send = (w, o) => { wire = hard(w); show(wire); commit(wire, o); };

  // typed entry: relative math against the CURRENT face value, hard limits. ONE commit per typing: Enter commits and
  // blurs, and the blur's own native `change` must not commit again with a stale expect (review 10-07 B2: every Enter
  // wrote the edit, then a second identical set that the authority refused as `changed`, with a red toast). A change
  // whose text is what the field last showed is no edit at all.
  num.onchange = () => {
    if (num.value === shownFace) return;
    const face = parseEntry(num.value, +toFace(wire));
    if (face == null) { show(wire); return; }
    if (face === +toFace(wire)) { show(wire); num.blur(); return; }   // the value it already has: nothing to write
    send(toWire(face));
    num.blur();   // release focus so held repaints resume
  };
  num.onkeydown = (e) => {
    if (e.key === 'Escape') { show(wire); num.blur(); e.stopPropagation(); }
    else if (e.key === 'Enter') { e.preventDefault(); num.onchange(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * cur.step * (e.shiftKey ? 10 : 1);   // keys: scrub
      send(toWire(+toFace(wire) + d));
    }
  };

  // drag-to-scrub: absolute from origin, on the FACE scale, soft limits
  const perPx = () => cur.drag ?? cur.step * 0.2;
  let drag = null;
  // Esc while scrubbing: the input was BLURRED when the drag armed (so the
  // caret never fights the pointer), which means the key lands on the
  // document, not here — listen there, only while a drag is armed
  const onDragKey = (e) => { if (e.key === 'Escape' && drag?.armed) { e.stopImmediatePropagation(); e.preventDefault(); cancelDrag(); } };   // immediate: the global key router (controller.js) must not also see it and deselect
  const cancelDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    document.removeEventListener('keydown', onDragKey, true);
    num.classList.remove('scrub');
    try { (d.src ?? num).releasePointerCapture(d.id); } catch { /* already released */ }
    scrubHint(false);
    if (d.armed) { show(d.w0); commit(d.w0, { live: true }); wire = d.w0; for (const q of d.peers ?? []) q.p.peer.restore(q.w0); }
  };
  // the same drag from the value box and from the channel's NAME (R, 10-10: "make the channel lines themselves
  // selectable and scrub-able just like their value boxes. This is a Maya feature that I love")
  // a peer is another selected channel's stepper: it begins where it stands, follows the same face delta, and commits
  // or restores with the leader (the channel box's run, R 10-11 23:13: "scrubbing on then only affects one still")
  wrap.peer = { begin: () => ({ w0: wire, face0: +toFace(wire) }),
    to: (face, live) => { const w = soft(toWire(face)); wire = w; show(w); commit(w, live ? { live: true } : undefined); },
    restore: (w0) => { show(w0); commit(w0, { live: true }); wire = w0; } };
  const peersOf = () => (wrap.peers?.() ?? []).filter((p) => p && p !== wrap && p.peer).map((p) => ({ p, ...p.peer.begin() }));
  const bindScrub = (src, onClick) => {
  src.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && wrap.onSelectKey) { e.preventDefault(); wrap.onSelectKey(e); return; }   // keys: selectExtend — Shift/Ctrl-click a value box: select, as on its name (keys: selectExtend)
    drag = { id: e.pointerId, x0: e.clientX, lastX: e.clientX, w0: wire, face0: +toFace(wire), dist: 0, armed: false, src, onClick, peers: [] };
  });
  src.addEventListener('pointermove', (e) => {
    if (!drag || drag.src !== src) return;
    if (src._ranging) { drag = null; return; }   // a channel name dragged UP or DOWN selects channels (below), never scrubs
    const dx = e.clientX - drag.lastX; drag.lastX = e.clientX;
    // accumulate BEFORE the arm check (Godot :113 then :117): the pixels
    // inside the click slop still count, or a drag that wanders back lands
    // short of where it began — the drift this whole shape exists to avoid
    drag.dist += dx * (e.shiftKey ? 0.1 : 1);   // keys: scrub
    if (!drag.armed) {
      if (Math.abs(e.clientX - drag.x0) < 4) return;           // click-vs-drag slop
      drag.armed = true;
      try { src.setPointerCapture(drag.id); } catch { /* no capture here */ }
      num.classList.add('scrub');
      num.blur();
      scrubHint(true);
      document.addEventListener('keydown', onDragKey, true);
      drag.peers = peersOf();
    }
    let face = drag.face0 + scrubTravel(drag.dist) * perPx();
    if (e.ctrlKey || e.metaKey) face = Math.round(face);   // keys: scrub
    const w = soft(toWire(face));
    drag.cur = w; wire = w; show(w);
    commit(w, { live: true });
    drag.dFace = face - drag.face0;
    for (const q of drag.peers) q.p.peer.to(e.ctrlKey || e.metaKey ? Math.round(q.face0 + drag.dFace) : q.face0 + drag.dFace, true);   // keys: scrub
  });
  const endDrag = (e) => {
    if (!drag || drag.src !== src) return;
    const d = drag; drag = null;
    if (d.armed) {
      document.removeEventListener('keydown', onDragKey, true);
      num.classList.remove('scrub');
      scrubHint(false);
      try { src.releasePointerCapture(d.id); } catch { /* fine */ }
      if (d.cur != null && d.cur !== d.w0 && d.peers?.length && wrap.commitRun && wrap.key) {
        // the run commits as ONE edit (one request, one Ctrl+Z): every peer shows its final face and the leader carries them all
        const pairs = { [wrap.key]: +toFace(d.cur) };
        for (const q of d.peers) { const face = q.face0 + (d.dFace ?? 0); q.p.peer.to(face, true); if (q.p.key) pairs[q.p.key] = face; }
        wrap.commitRun(pairs);
      } else {
        if (d.cur != null && d.cur !== d.w0) commit(d.cur); else if (d.cur != null) commit(d.w0, { live: true });
        for (const q of d.peers ?? []) { if (d.cur != null && d.cur !== d.w0) q.p.peer.to(q.face0 + (d.dFace ?? 0), false); else q.p.peer.restore(q.w0); }
      }
    } else if (e.type === 'pointerup') { if (d.onClick) d.onClick(e); else { num.focus(); num.select(); } }   // a click: type (the box), select (the name)
  };
  src.addEventListener('pointerup', endDrag);
  src.addEventListener('pointercancel', endDrag);
  src.addEventListener('lostpointercapture', () => { if (drag?.armed && drag.src === src) endDrag({ type: 'lost' }); });
  };
  bindScrub(num, null);
  wrap.bindScrub = bindScrub; wrap.num = num;

  if (!compact) {
    const minus = el('button', 'sp-bump', '−');
    const plus = el('button', 'sp-bump', '+');
    minus.disabled = plus.disabled = !!disabled;
    minus.onclick = () => send(toWire(+toFace(wire) - cur.step));
    plus.onclick = () => send(toWire(+toFace(wire) + cur.step));
    wrap.append(minus, num, plus);
  } else wrap.append(num);
  if (unit || deg) wrap.append(el('span', 'sp-unit', deg ? '°' : unit));

  // in-place update from a repaint: never under a caret or a drag
  wrap.update = (nf) => {
    Object.assign(cur, nf);
    if (drag || document.activeElement === num) return;
    wire = +nf.value; show(wire);
  };
  return wrap;
}

let popOpen = null;
function openPop(anchor, f, pick) {
  popOpen?.close();
  const LS = `ew-recent-${f.recentKey ?? 'pop'}`;
  let recent = []; if (!f.plain) try { recent = JSON.parse(localStorage.getItem(LS) ?? '[]'); } catch { /* none */ }   // plain: a short menu of switches, no search box, no recents
  // opaque, inside the viewport, one row lit (review 10-07 S10: it drew over the fields behind it, ran off the right and
  // bottom edges, and every row wore the brand-green button look). Its look is index.html's .sp-pop rules.
  const box = el('div', 'sp-pop');
  const W = 260, H = 360, M = 8;
  Object.assign(box.style, { position: 'fixed', zIndex: 10000, width: `${W}px`, maxHeight: `${Math.min(H, innerHeight - 2 * M)}px`, boxSizing: 'border-box', display: 'flex', flexDirection: 'column' });
  const r = anchor.getBoundingClientRect();
  const h = Math.min(H, innerHeight - 2 * M);
  box.style.left = `${Math.round(Math.max(M, Math.min(r.left, innerWidth - W - M)))}px`;
  // below the button when it fits, else above it, else as low as the viewport allows
  const top = r.bottom + 4 + h <= innerHeight - M ? r.bottom + 4 : r.top - 4 - h >= M ? r.top - 4 - h : innerHeight - M - h;
  box.style.top = `${Math.round(Math.max(M, top))}px`;
  const inp = el('input', 'sp-pop-search'); inp.type = 'search'; inp.placeholder = f.placeholder ?? 'search components…';
  const list = el('div', 'sp-pop-list');
  if (f.plain) { inp.style.cssText = 'position:absolute;opacity:0;height:0;border:0;padding:0;pointer-events:none'; box.style.width = '190px'; }   // kept for the keys (↑↓ Enter Esc), unseen
  box.append(inp, list);
  const items = f.items ?? [];
  const take = (it) => {
    if (it.disabled) return;
    if (!f.plain) try { localStorage.setItem(LS, JSON.stringify([it.k, ...recent.filter((k) => k !== it.k)].slice(0, 5))); } catch { /* fine */ }
    close(); pick(it.k);
  };
  let shown = [], active = 0, rows = [];
  const light = () => { rows.forEach((row, i) => row.classList.toggle('active', i === active)); rows[active]?.scrollIntoView?.({ block: 'nearest' }); };
  const paint = () => {
    const q = inp.value.trim().toLowerCase();
    list.textContent = ''; rows = [];
    const word = (it) => (it.keywords ?? []).some((k) => k.toLowerCase().startsWith(q) || q.startsWith(k.toLowerCase()));
    const hit = (it) => !q || it.label.toLowerCase().includes(q) || word(it) || String(it.hint ?? '').toLowerCase().includes(q);
    // a name hit ranks above a search word ("seat" → Sockets), which ranks above a description hit ("swi" finds Pendulum by its "swings")
    const rank = (it) => (!q ? 0 : it.label.toLowerCase().includes(q) ? 2 : word(it) ? 1 : 0);
    const ranked = items.filter(hit).sort((a, b) => rank(b) - rank(a));
    const groups = [];
    if (!q) { const rec = recent.map((k) => items.find((it) => it.k === k)).filter(Boolean); if (rec.length) groups.push(['recent', rec]); }
    for (const cat of [...new Set(ranked.map((it) => it.category ?? ''))]) groups.push([cat, ranked.filter((it) => (it.category ?? '') === cat)]);
    shown = q ? ranked : groups.flatMap(([, xs]) => xs);
    for (const [cat, xs] of (q ? [['', ranked]] : groups)) {
      if (cat && !q) list.append(el('div', 'sp-pop-cat', cat));
      for (const it of xs) {
        const row = el('button', 'sp-pop-item', it.label);
        if (it.chip === 'amber' || it.chip === 'blue') row.prepend(el('span', `sp-pill sp-pill-${it.chip === 'blue' ? 'trusted' : 'draft'}`, it.chip === 'blue' ? 'trusted' : 'draft'));
        row.title = it.hint ?? ''; row.disabled = !!it.disabled;
        row.onclick = () => take(it);
        const i = rows.length; row.onpointerenter = () => { active = i; light(); };
        list.append(row); rows.push(row);
      }
    }
    if (!shown.length) list.append(el('div', 'sp-empty', `nothing matches "${inp.value}"`));
    active = Math.max(0, rows.findIndex((row) => !row.disabled)); light();
  };
  const onDoc = (e) => { if (!box.contains(e.target)) close(); };
  const close = () => { box.remove(); document.removeEventListener('pointerdown', onDoc, true); if (popOpen?.box === box) popOpen = null; };
  inp.oninput = paint;
  inp.onkeydown = (e) => {
    e.stopPropagation();   // typing here is not a shortcut (G/E/R, Delete…)
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; light(); } }
    else if (e.key === 'Enter') { const row = rows[active]; if (row && !row.disabled) row.click(); else { const first = shown.find((x) => !x.disabled); if (first) take(first); } }
  };
  document.addEventListener('pointerdown', onDoc, true);
  document.body.append(box);
  popOpen = { box, close };
  paint(); inp.focus();
}

/** The row's menu as a BUTTON (R, 10-10: "buttons in VR to the right of anywhere that would get a right-click menu,
 *  hidden on desktop"; Resonite's inspector does the same: a small button per field opens its menu, no right-click).
 *  It opens exactly what a right-click on the row opens. CSS shows it only on a frame staged for a headset
 *  (#xr-stage: domquad.js), so the desktop row is unchanged. */
function menuButton(row) {
  const b = el('button', 'sp-ctxbtn', '⋯'); b.tabIndex = -1; b.title = 'menu'; b.setAttribute('aria-label', 'menu for this row');
  b.onpointerdown = (e) => e.stopPropagation();   // not a scrub, not a drag of the row
  b.onclick = (e) => { e.stopPropagation(); const r = b.getBoundingClientRect();
    row.oncontextmenu?.(new MouseEvent('contextmenu', { bubbles: false, cancelable: true, clientX: r.left, clientY: r.bottom })); };
  return b;
}
function fieldDOM(f, edit, ro = {}) {
  const row = el('div', `sp-row sp-f-${f.t}${f.bar ? ' sp-bar' : ''}${f.cls ? ' ' + f.cls : ''}`);   // cls: a field's own look (the Inspector's name line)   // sp-f- prefix: never collide with element classes; sp-bar: side by side
  const ax = /(?:^|:)(?:pos|rot|scale)\.s?([xyz])$/.exec(f.k ?? '');   // pos.x, rot.y, pos.sz (scale's channels)
  if (ax) row.dataset.axis = ax[1];   // the channel's axis: edit chrome colours its label x/y/z
  if (f.disabled) row.classList.add('disabled');
  if (f.dim) { row.style.opacity = '0.55'; row.style.fontSize = '0.9em'; }   // secondary: an id beside its name
  if (f.driven) { row.classList.add('driven'); row.title = `driven by ${f.driven} — editing moves its rest pose`; }
  else if (f.hint) row.title = f.hint;
  if (f.t === 'num' && !f.disabled) row.title = row.title ? `${row.title}\n${SCRUB_TIP}` : SCRUB_TIP;   // the modifiers, where the hand is
  let label = null;
  if (f.label != null && f.t !== 'btn' && f.t !== 'group' && f.t !== 'pop') { label = el('label', 'sp-label', f.label); row.append(label); }   // a pop's label is its button's face
  if (label && ro.icons) put(label, f.label, true);
  const setLabel = (nf) => { if (label && nf.label != null) put(label, nf.label, ro.icons); };
  switch (f.t) {
    case 'log': {
      // a scrolling monospace tail (a script console): follows the bottom unless you scrolled up to read
      const pre = el('pre', 'sp-log');
      const put = (nf) => {
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
        pre.textContent = (nf.lines ?? []).length ? nf.lines.join('\n') : (nf.empty ?? '');
        pre.classList.toggle('empty', !(nf.lines ?? []).length);
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      };
      put(f);
      row.append(pre);
      row.update = (nf) => put(nf);
      break;
    }
    case 'info': {
      const s = put(el('span', 'sp-info'), f.value, ro.icons);
      // a long value is cut at the panel's edge: hover shows it whole, a click unfolds it in place (R 10-11: 'reads as')
      const full = () => { const t = s.textContent ?? ''; s.title = t.length > 40 ? t : ''; s.classList.toggle('sp-info-long', t.length > 40); };
      full(); s.onclick = () => { if (s.classList.contains('sp-info-long')) s.classList.toggle('sp-info-open'); };
      row.append(s);
      row.update = (nf) => { setLabel(nf); put(s, nf.value, ro.icons); full(); };
      break;
    }
    case 'num': {
      const st = stepper(f.value ?? 0, f, (v, o) => edit(f.k, v, null, o));
      // driven: the FIELD carries it (edit chrome) — a `~` inside its left end; the label keeps its axis colour
      // …and it leads to its driver (Resonite's drive mark, Unity's animated tint; R 10-04: drivers are ordinary cards,
      // the field points at them — no second list to drift): click goes to the driver's card
      if (f.driven && ro.icons) { const d = el('span', 'sp-drv', '~'); d.title = `driven by ${f.drivenBy ? `its ${f.drivenBy} (${f.driven})` : f.driven} — click to go to its card`;
        d.style.cursor = 'pointer'; d.onpointerdown = (e) => e.stopPropagation(); d.onclick = (e) => { e.stopPropagation(); edit('goto', f.driven); }; st.prepend(d); }
      row.append(st); row._st = st;
      row.update = (nf) => { setLabel(nf); st.update(nf); };
      if (label && ro.icons && !f.disabled) {   // edit chrome: the channel's name is a handle too
        label.classList.add('sp-chan');
        // a scrub on a selected channel moves every selected channel by the same amount (Maya's channel box)
        st.key = f.k; st.commitRun = (pairs) => edit('__run', pairs);
        st.peers = () => (row.classList.contains('chan-sel') ? [...(row.parentElement?.querySelectorAll('.sp-row.chan-sel') ?? [])].map((r) => r._st).filter((x) => x && x !== st) : []);
        // selecting channels, as in Maya's channel box (R 10-10 23:36): a click selects one; Ctrl toggles one; Shift selects
        // the run from the last one clicked; dragging UP or DOWN the names selects the run under the pointer (sideways
        // is still the scrub)
        const chans = () => [...(row.parentElement?.children ?? [])].filter((r) => r.classList?.contains('sp-row') && r.querySelector('.sp-chan'));
        const selectRun = (a, b, keep) => { const L = chans(); const i = L.indexOf(a), j = L.indexOf(b); if (i < 0 || j < 0) return;
          if (!keep) for (const r of L) r.classList.remove('chan-sel'); for (let k = Math.min(i, j); k <= Math.max(i, j); k++) L[k].classList.add('chan-sel'); };
        const selectKey = (e) => {
          const sel = [...(row.parentElement?.querySelectorAll('.sp-row.chan-sel') ?? [])];
          if (e.ctrlKey || e.metaKey) { row.classList.toggle('chan-sel'); row.parentElement._chanAnchor = row; return; }   // keys: selectExtend
          if (e.shiftKey && row.parentElement?._chanAnchor?.isConnected) { selectRun(row.parentElement._chanAnchor, row, false); return; }   // keys: selectExtend
          const only = sel.length === 1 && sel[0] === row;
          for (const r of sel) r.classList.remove('chan-sel');
          if (!only) row.classList.add('chan-sel');
          if (row.parentElement) row.parentElement._chanAnchor = row;
        };
        st.bindScrub(label, (e) => { if (label._ranged) { label._ranged = false; return; } selectKey(e); });   // a click on the name
        st.onSelectKey = selectKey;   // Shift/Ctrl-click on the value box
        // dragging UP or DOWN a name OR a value box selects the run under the pointer (sideways is still the scrub)
        const rangeDrag = (src) => src.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; const y0 = e.clientY, x0 = e.clientX, keep = e.ctrlKey || e.metaKey;   // keys: selectExtend
          const move = (ev) => { if (!src._ranging) { if (Math.abs(ev.clientY - y0) < 6 || Math.abs(ev.clientY - y0) < Math.abs(ev.clientX - x0)) return; src._ranging = true; src._ranged = true; src.blur?.(); }
            const over = document.elementFromPoint(x0, ev.clientY)?.closest?.('.sp-row'); if (over && chans().includes(over)) { selectRun(row, over, keep); row.parentElement._chanAnchor = row; } };
          const up = () => { removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); setTimeout(() => { src._ranging = false; src._ranged = false; }, 0); };
          addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); });
        rangeDrag(label); rangeDrag(st.num);
      }
      break;
    }
    case 'range': {
      // the house's own <input type=range> (index.html styles it globally;
      // --p drives the progress fill) — the same control the desk's dials use
      const lo = f.min ?? 0, hi = f.max ?? 1, st = f.step ?? 0.01, dp = f.dp ?? 2;
      const sl = el('input', 'sp-range'); sl.type = 'range'; sl.min = lo; sl.max = hi; sl.step = st; sl.value = f.value ?? lo;
      const out = el('span', 'sp-range-val', `${trimNum(+sl.value, dp)}${f.unit ?? ''}`);
      const paint = () => sl.style.setProperty('--p', `${((sl.value - lo) / (hi - lo || 1)) * 100}%`);
      paint();
      const face = () => { paint(); out.textContent = `${trimNum(+sl.value, dp)}${f.unit ?? ''}`; };
      // the panels contract: a drag PREVIEWS (opts.live), the release commits once
      sl.oninput = () => { face(); edit(f.k, +sl.value, null, { live: true }); };
      sl.onchange = () => { face(); edit(f.k, +sl.value); };
      row.update = (nf) => { setLabel(nf); if (document.activeElement !== sl) { sl.value = nf.value ?? lo; face(); } };
      row.append(sl, out);
      break;
    }
    case 'vec3': {
      const box = el('span', 'sp-vec');
      let cur = [...(f.value ?? [0, 0, 0])];
      const parts = cur.map((c, i) => stepper(c, f, (v, o) => {
        if (f.link) { cur = [v, v, v]; edit(f.k, cur, null, o); return; }
        cur = [...cur]; cur[i] = v; edit(f.k, cur, i, o);
      }));
      box.append(...parts);
      row.append(box);
      row.update = (nf) => { setLabel(nf); cur = [...(nf.value ?? cur)]; parts.forEach((p, i) => p.update({ value: cur[i] })); };
      break;
    }
    case 'enum': {
      const sel = el('select', 'sp-enum');
      sel.disabled = !!f.disabled;
      for (const o of f.options ?? []) {
        const op = new Option(o.label ?? String(o.v), String(o.v));
        op.selected = o.v === f.value;
        sel.append(op);
      }
      sel.onchange = () => { const o = (f.options ?? []).find((x) => String(x.v) === sel.value); edit(f.k, o ? o.v : sel.value); };
      row.append(sel);
      row.update = (nf) => { setLabel(nf); if (document.activeElement !== sel) sel.value = String(nf.value); };
      break;
    }
    case 'color': {
      const inp = el('input', 'sp-color');
      inp.type = 'color';
      inp.disabled = !!f.disabled;
      const hex = (v) => '#' + (v ?? 0xffffff).toString(16).padStart(6, '0');
      inp.value = hex(f.value);
      inp.oninput = () => edit(f.k, parseInt(inp.value.slice(1), 16), null, { live: true });
      inp.onchange = () => { edit(f.k, parseInt(inp.value.slice(1), 16)); inp.blur(); };
      row.append(inp);
      row.update = (nf) => { setLabel(nf); if (document.activeElement !== inp) inp.value = hex(nf.value); };
      break;
    }
    case 'group': {
      row.classList.add(f.open === false ? 'closed' : 'open');
      // the card's title: the fold arrow, then its provenance pill at the FRONT (R 10-11: "move the draft/server-only
      // component pill to the front of the label row… to make it look more important"), then the name
      const DOT = { draft: ['draft', 'a draft component: not part of the engine yet (it can still change); unproven: this client reads it, the engine doesn\'t'], trusted: ['trusted here', 'not engine-official, but used and trusted in this world (the owner\'s word); the engine still doesn\'t read it'], foreign: ['unknown', 'a component this client has no reader for: kept and replayed, not drawn'] };
      const head = (hh, ff) => { hh.textContent = ''; hh.append(document.createTextNode(`${ff.open === false ? '▸' : '▾'} `));
        if (ff.dot && DOT[ff.dot]) { const d = el('span', `sp-pill sp-pill-${ff.dot}`, DOT[ff.dot][0]); d.title = DOT[ff.dot][1]; hh.append(d); }
        hh.append(put(el('span', 'sp-group-name'), ff.label, ro.icons)); return hh; };
      const h = head(el('button', 'sp-group'), f);
      h.onclick = () => edit('fold', f.k);
      row.innerHTML = ''; row.append(h);
      // a card's own actions on its title line, shown on hover (R 10-10: 'delete components right from the title line,
      // like an x that shows up on the line when you hover over it'); the VR quad keeps its remove row instead
      if (f.actions?.length) {
        const acts = el('span', 'sp-gacts');
        for (const a of f.actions) { const b = el('button', `sp-gact${a.danger ? ' danger' : ''}`); b.type = 'button'; b.title = a.title ?? a.label ?? ''; b.setAttribute('aria-label', b.title);
          if (a.icon && hasIcon(a.icon)) b.innerHTML = iconSvg(a.icon, 13); else b.textContent = a.label ?? '';
          b.onclick = (e) => { e.stopPropagation(); edit(a.k); }; acts.append(b); }
        row.append(acts); row.classList.add('has-acts');
      }
      row.update = (nf) => { head(h, nf); };
      break;
    }
    case 'tree': {
      const box = el('div', 'sp-tree');
      if (!f.rows?.length) box.append(el('div', 'sp-empty', f.empty ?? 'nothing here'));
      // drag a row onto another to reparent it (edit('drop', {id, onto})); onto
      // the tree's empty space to make it a root ({onto: null}). The dragged
      // id rides a module variable, not dataTransfer — synthetic DragEvents
      // in a headless bench carry no data, and nothing else needs it.
      const dropOn = (onto) => (e) => { e.preventDefault(); e.stopPropagation(); box.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); if (treeDrag && treeDrag !== onto) edit('drop', { id: treeDrag, onto }); treeDrag = null; };
      box.ondragover = (e) => { if (treeDrag) { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'move'); } };
      box.ondrop = dropOn(null);
      for (const r of f.rows ?? []) {
        const line = el('div', `sp-item sp-tree-row${r.active ? ' active' : ''}${r.multi ? ' multi' : ''}`);
        if (r.id != null) line.dataset.id = String(r.id);   // every row is findable by what it is (component rows too)
        if (!r.noDrag) {
          line.draggable = true;
          line.ondragstart = (e) => { treeDrag = r.id; line.classList.add('dragging'); box.classList.add('dragging'); e.dataTransfer?.setData('text/plain', String(r.id)); };
          line.ondragend = () => { treeDrag = null; line.classList.remove('dragging'); box.classList.remove('dragging'); box.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); };
          line.ondragover = (e) => { if (treeDrag && treeDrag !== r.id) { e.preventDefault(); e.stopPropagation(); line.classList.add('drop'); } };
          line.ondragleave = () => line.classList.remove('drop');
          line.ondrop = dropOn(r.id);
        }
        line.style.paddingLeft = `${4 + (r.depth ?? 0) * 14}px`;
        line.style.setProperty('--d', String(r.depth ?? 0));   // edit chrome draws one indent guide per level
        if (r.dim) line.classList.add('dim');
        // disclosure: a row with children folds them (edit('open', id))
        const disc = el('button', `sp-disc${r.kids ? '' : ' none'}`, r.kids ? (r.open === false ? '▸' : '▾') : '');
        disc.tabIndex = -1;
        // Shift- or Alt-click: this one and everything under it (Maya's and Blender's Shift, Unity's Alt)
        if (r.kids) disc.onclick = (e) => { e.stopPropagation(); edit('open', e.shiftKey || e.altKey ? { id: r.id, deep: true } : r.id); };   // keys: treeFold
        if (r.kids) disc.title = KEYHINTS.treeFold.before;
        line.append(disc);
        const main = el('span', 'sp-item-main');
        main.append(put(el('span', 'sp-item-label'), r.label, ro.icons));
        if (r.sub || r.badges?.length) main.append(put(el('span', 'sp-item-sub'), [r.sub, ...(r.badges ?? [])].filter(Boolean).join(' · '), ro.icons));
        main.onclick = (e) => edit(f.k, r.id, f, { extend: e.shiftKey || e.ctrlKey || e.metaKey });   // keys: selectExtend
        main.title = withKeys(r.title ?? (r.sub ? `${r.label} — ${r.sub}` : r.label), 'selectExtend');   // r.title: what the row left out (its id, its kind)
        // inline rename (Godot F2 / Blender double-click): a row that carries `rename` (its
        // current label) swaps the label for an input; Enter or blur commits
        // edit('rename', id, f, {value}), Esc cancels. The panel holds repaints while it's focused.
        let beginRename = null;
        if (r.rename != null) {
          const lab = main.querySelector('.sp-item-label');
          beginRename = () => {
            const inp = el('input', 'sp-rename'); inp.value = r.rename; inp.placeholder = String(r.id);
            lab.replaceWith(inp); line.draggable = false; inp.focus(); inp.select();
            let done = false;
            const end = (commit) => {
              if (done) return; done = true;
              const v = inp.value.trim();
              inp.replaceWith(lab); line.draggable = !r.noDrag;
              if (commit && v !== r.rename) edit('rename', r.id, f, { value: v });
            };
            inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } };
            inp.onblur = () => end(true);
            inp.onclick = (e) => e.stopPropagation();
          };
          main.ondblclick = (e) => { e.stopPropagation(); beginRename(); };
          line.dataset.id = String(r.id);
          line._rename = beginRename;
        }
        const items = r.menu ?? f.menu;
        if (items?.length) line.oncontextmenu = (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, items, (k) => (k === 'rename' && beginRename ? beginRename() : edit(k, r.id))); };
        line.append(main);
        if (items?.length) line.append(menuButton(line));
        if (r.mine != null) {   // 👁: hidden in MY view only (myview.js) — never the shared component
          const eye = el('button', `sp-mini sp-eye${r.mine ? ' on' : ''}`);
          eye.innerHTML = iconSvg(r.mine ? 'eye-slash' : 'eye', 14);
          eye.title = r.mine ? 'hidden in your view only — click to show it again' : 'click to hide it in your view only (nobody else is affected)';
          eye.onclick = (e) => { e.stopPropagation(); edit('myhide', r.id); };
          line.append(eye);
        }
        if (r.locked != null) {
          // held: not locked itself, but it rides a locked thing, which holds it just the same (the authority's rule)
          const held = !r.locked && !!r.heldBy;
          const lock = el('button', `sp-mini sp-lock${r.locked ? ' on' : ''}${held ? ' inherited' : ''}`);
          lock.innerHTML = iconSvg(r.locked || held ? 'lock' : 'lockOpen', 14);   // a glyph, not an emoji (the canvas trap; one icon set)
          const lv = r.lockLevel && r.lockLevel !== 'builder' ? ` (${r.lockLevel === 'owner' ? 'owners only' : 'moderators and up'})` : '';
          lock.title = r.locked ? `locked${lv} — click to unlock` : held ? `held by ${r.heldByLabel ?? r.heldBy}'s lock — it moves only with it; unlock that to move this on its own` : 'click to lock in place';
          if (held) lock.dataset.heldBy = r.heldBy;
          // lockable: false = this viewer may not lift locks (a visitor, §5; or a level above their rank): the icon still says, the click doesn't
          if (r.lockable === false) { lock.disabled = true; lock.title = r.locked ? `locked${lv} (${r.lockLevel === 'owner' ? 'owners' : r.lockLevel === 'moderator' ? 'moderators and owners' : 'builders and owners'} can unlock it)` : held ? lock.title : 'not locked (builders and owners can lock it)'; }
          lock.onclick = (e) => { e.stopPropagation(); if (lock.disabled) return; if (held) edit('find', r.heldBy); else edit('lock', r.id); };
          line.append(lock);
        }
        box.append(line);
      }
      // the root zone: a full tree has no empty space to drop on, so while a
      // row is in flight a strip at its foot says "no parent" and takes the drop
      if (f.rootDrop && f.rows?.length) {
        const zone = el('div', 'sp-tree-root', f.rootDrop);
        zone.ondragover = (e) => { if (treeDrag) { e.preventDefault(); e.stopPropagation(); zone.classList.add('drop'); } };
        zone.ondragleave = () => zone.classList.remove('drop');
        zone.ondrop = dropOn(null);
        box.append(zone);
      }
      row.append(box);
      // a changed tree is rebuilt (rows are shape), and a new box starts scrolled to the top: in a world where things
      // move, that was every few frames, and the lower rows could not be reached (R 10-10: "entities ... I can't get
      // to in the hierarchy"). The box keeps where it was scrolled to, by the field's key.
      const tkey = f.k ?? 'tree';
      box.addEventListener('scroll', () => treeScroll.set(tkey, box.scrollTop), { passive: true });
      const back = () => { const y = treeScroll.get(tkey); if (y && box.isConnected) box.scrollTop = y; };
      queueMicrotask(back); requestAnimationFrame(back);
      break;   // rows are shape: a changed tree repaints
    }
    case 'json': {
      // a component as JSON: multi-line, checked as you type (red = won't commit), commits on
      // blur or Ctrl/Cmd+Enter, Esc reverts. `collapsed` tucks it behind a { } toggle — the
      // escape hatch under a typed group, for keys its fields don't speak for.
      const wrap = el('div', 'sp-json');
      const tog = el('button', 'sp-json-tog', '{ } JSON');
      const ta = el('textarea', 'sp-json-ta'); ta.spellcheck = false; ta.disabled = !!f.disabled; ta.title = withKeys(f.hint, 'jsonCommit');
      const err = el('div', 'sp-json-err');
      let base = f.value ?? '', open = !f.collapsed;
      const size = () => { ta.rows = Math.min(14, Math.max(3, ta.value.split('\n').length)); };
      const valid = () => {
        try { if (ta.value.trim()) JSON.parse(ta.value); err.textContent = ''; ta.classList.remove('bad'); return true; }
        catch (e) { err.textContent = String(e.message).replace(/^JSON\.parse: /, ''); ta.classList.add('bad'); return false; }
      };
      const show = () => { ta.hidden = !open; err.hidden = !open; tog.classList.toggle('on', open); };
      ta.value = base; size();
      tog.onclick = () => { open = !open; show(); if (open) ta.focus(); };
      ta.oninput = () => { size(); valid(); };
      ta.onblur = () => { if (ta.value !== base && valid()) edit(f.k, ta.value); };
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }   // keys: jsonCommit
        else if (e.key === 'Escape') { ta.value = base; valid(); size(); ta.blur(); }
      };
      if (f.collapsed) wrap.append(tog);
      wrap.append(ta, err); show();
      row.append(wrap);
      row.update = (nf) => { setLabel(nf); base = nf.value ?? ''; ta.disabled = !!nf.disabled; if (document.activeElement !== ta) { ta.value = base; size(); valid(); } };
      break;
    }
    case 'text': {
      // multiline (a story's text, a sign's words; batch 2): a textarea, committed when it loses focus or on Ctrl+Enter
      const inp = f.multiline ? el('textarea', 'sp-text sp-textarea') : el('input', 'sp-text');
      if (f.multiline) { inp.rows = 4; inp.style.cssText = 'width:100%;min-height:4.5em;resize:vertical;font:inherit;font-size:12px';
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { inp.blur(); e.stopPropagation(); } else if (e.key !== 'Escape') e.stopPropagation(); });   // keys: jsonCommit
        inp.title = withKeys(f.hint, 'jsonCommit'); }
      else if (f.hint) inp.title = f.hint;
      let base = f.value ?? '';   // what Esc restores — the CURRENT value, refreshed by update() (the closure's f is the value at build time)
      inp.value = base;
      inp.disabled = !!f.disabled;
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.onchange = () => { edit(f.k, inp.value); inp.blur(); };
      inp.onkeydown = (e) => { if (e.key === 'Escape') { inp.value = base; inp.blur(); e.stopPropagation(); } };
      row.append(inp);
      row.update = (nf) => { setLabel(nf); base = nf.value ?? ''; if (document.activeElement !== inp) inp.value = base; };
      break;
    }
    case 'pop': {
      // one button that opens a searchable list (Add Component, R 10-04): {label, items:[{k, label, category, hint,
      // disabled}], recentKey}. Typing filters on name and hint, Enter takes the first, Esc or a click outside closes.
      const b = el('button', `sp-btn sp-pop-btn${f.icon ? ' sp-btn-ico' : ''}`, f.label);
      if (f.icon) b.insertAdjacentHTML('afterbegin', iconSvg(f.icon, 14));
      b.title = f.hint ?? '';
      b.onclick = (e) => { e.stopPropagation(); openPop(b, f, (k) => edit(k)); };
      row.append(b);
      row.update = (nf) => { b.lastChild.textContent = nf.label; f = nf; };
      break;
    }
    case 'btn': {
      const b = el('button', `sp-btn${f.danger ? ' danger' : ''}${f.icon ? ' sp-btn-ico' : ''}`);
      const txt = el('span', '', f.label); txt.hidden = !f.label;   // an icon-only button: no empty span to push the glyph off centre
      let ico = f.icon ?? null; if (ico) b.innerHTML = iconSvg(ico, 14);
      b.append(txt);
      b.disabled = !!f.disabled; b.classList.toggle('on', !!f.on); if (!f.label && f.hint) b.title = f.hint;
      b.onclick = () => edit(f.k);
      row.append(b);
      // an icon toggle (the eye, the padlock) must redraw its picture, not only its words
      row.update = (nf) => { txt.textContent = nf.label; txt.hidden = !nf.label; b.classList.toggle('on', !!nf.on); if (!nf.label && nf.hint) b.title = nf.hint;
        if ((nf.icon ?? null) !== ico) { ico = nf.icon ?? null; b.querySelector('svg')?.remove(); if (ico) b.insertAdjacentHTML('afterbegin', iconSvg(ico, 14)); } };
      break;
    }
    case 'tiles': {
      const box = el('div', `sp-tiles${(f.options ?? []).some((o) => o.img) ? ' sp-tiles-img' : ''}`);
      if (!f.options?.length) box.append(el('div', 'sp-empty', f.empty ?? 'nothing here'));
      for (const o of f.options ?? []) {
        const b = el('button', `sp-tile${o.v === f.value ? ' on' : ''}`);
        b.dataset.v = String(o.v);
        b.title = o.hint ? `${o.label} — ${o.hint}` : o.label;
        b.disabled = !!f.disabled;
        if (o.img) {
          const pic = el('span', 'sp-tile-pic');
          const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = o.img;
          img.onerror = () => { img.style.visibility = 'hidden'; };
          pic.append(img); b.append(pic);
        } else if (o.icon) b.insertAdjacentHTML('beforeend', iconSvg(o.icon, 18));
        b.append(el('span', 'sp-tile-label', o.label));
        b.onclick = () => edit(f.k, o.v);
        box.append(b);
      }
      row.append(box);
      // a hint is not shape (a saved blueprint's "2 copies placed" changes under it): kept current in place
      row.update = (nf) => {
        const byV = new Map((nf.options ?? []).map((o) => [String(o.v), o]));
        for (const b of box.querySelectorAll('.sp-tile')) {
          b.classList.toggle('on', b.dataset.v === String(nf.value));
          const o = byV.get(b.dataset.v);
          if (o) b.title = o.hint ? `${o.label} — ${o.hint}` : o.label;
        }
      };
      break;
    }
    case 'ref': {
      // a reference to another entity: the value is its id (or null). A "pick"
      // button arms the same click-to-name gesture attach uses — the next thing
      // clicked, a tree row or the thing itself in the world, becomes the target.
      const wrap = el('div', 'sp-ref');
      const name = el('button', `sp-btn sp-ref-name${f.arming ? ' arming' : ''}`,
        f.arming ? 'click a target…' : (f.value ?? '— pick —'));
      name.disabled = !!f.disabled;
      name.title = f.value ? `target: ${f.value} — click to re-pick` : 'click, then click the target';
      name.onclick = () => edit(f.k);                       // arm / cancel (editpanels toggles)
      wrap.append(name);
      if (f.value != null && !f.arming) {
        const clr = el('button', 'sp-btn sp-ref-clear', '✕');
        clr.title = 'clear this reference';
        clr.disabled = !!f.disabled;
        clr.onclick = () => edit(f.k, null);
        wrap.append(clr);
      }
      row.append(wrap);
      row.update = (nf) => {
        setLabel(nf);
        name.classList.toggle('arming', !!nf.arming);
        name.textContent = nf.arming ? 'click a target…' : (nf.value ?? '— pick —');
      };
      break;
    }
    case 'check': {
      const inp = el('input');
      inp.type = 'checkbox';
      inp.checked = !!f.value;
      inp.disabled = !!f.disabled;
      // R 10-10 23:48: in a busy world every frame repaints, and until the authority's answer folded in, each repaint put
      // the box back to the old value: it looked unclicked, so she clicked again and sent it twice. A clicked box keeps what
      // it was clicked to until the record agrees (or 3 s pass: then the record wins, e.g. a refusal).
      let pending = null;
      inp.onchange = () => { pending = { v: inp.checked, until: performance.now() + 3000 }; edit(f.k, inp.checked); };
      row.append(inp);
      row.update = (nf) => { setLabel(nf); const v = !!nf.value;
        if (pending && v !== pending.v && performance.now() < pending.until) { inp.checked = pending.v; return; }
        pending = null; inp.checked = v; };
      break;
    }
    case 'list': {
      const box = el('div', 'sp-list');
      if (!f.rows?.length) box.append(el('div', 'sp-empty', f.empty ?? 'nothing here'));
      for (const r of f.rows ?? []) {
        const line = el('div', `sp-item${r.active ? ' active' : ''}${r.indent ? ' sp-item-sub-row' : ''}`);
        if (r.id != null) line.dataset.id = String(r.id);   // a row is findable by what it IS, not by its label
        const main = el('span', 'sp-item-main');
        if (r.icon) {   // the World row: its glyph, its kind and its name on ONE line
          const head = el('span', 'sp-item-head'), i = el('span', 'sp-ico'); i.innerHTML = (hasIcon(r.icon) ? iconSvg : hasLine(r.icon) || !hasFill(r.icon) ? rsvg : fsvg)(r.icon, 14);   // any of the three sets
          const lab = el('span', 'sp-item-label'); if (r.kind) lab.append(el('span', 'sp-item-kind', r.kind)); lab.append(r.label);
          head.append(i, lab); main.append(head);
        } else main.append(el('span', 'sp-item-label', r.label));
        if (r.sub) main.append(el('span', 'sp-item-sub', r.sub));
        if (r.title) main.title = r.title;
        main.onclick = () => edit(f.k ?? 'row', r.id);   // a keyed list routes its rows; unkeyed lists keep 'row'
        line.append(main);
        for (const a of r.actions ?? []) {
          const b = el('button', `sp-mini${a.danger ? ' danger' : ''}${a.hover ? ' sp-hov' : ''}`, a.label); if (a.title) b.title = a.title;
          b.onclick = (e) => { e.stopPropagation(); edit(a.k, r.id); };
          line.append(b);
        }
        box.append(line);
      }
      row.append(box);
      break;
    }
  }
  // right-click a value field → copy value / paste value / copy path / reset to default. Reads
  // the LIVE field (update() keeps it current: the closure's f is the value at build time).
  if (f.k != null && ['num', 'text', 'enum', 'check', 'color', 'range', 'json'].includes(f.t)) {
    let live = f;
    const upd = row.update;
    row.update = (nf) => { live = nf; upd?.(nf); };
    // a selected channel resets with the others (dry: would it change anything?)
    row._reset = (dry = false) => { const can = live.def !== undefined && live.value !== live.def && !live.disabled; if (can && !dry) edit(live.k, live.def); return can; };
    row.oncontextmenu = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName ?? '') && e.target.type !== 'checkbox' && e.target.type !== 'color') return;   // keep the native text menu in a text box
      e.preventDefault();
      const canPaste = fieldClip != null && typeof fieldClip.value === typeof live.value && !live.disabled;
      const items = [
        { k: 'copy', label: 'copy value' },
        ...(canPaste ? [{ k: 'paste', label: `paste value  (${String(fieldClip.value).slice(0, 18)})` }] : []),
        ...(live.path ? [{ k: 'path', label: `copy path  (${live.path})` }] : []),
        ...((() => { const many = row.classList.contains('chan-sel') ? [...(row.parentElement?.querySelectorAll('.sp-row.chan-sel') ?? [])].filter((r) => r._reset?.(true)) : [];
          return many.length > 1 ? [{ k: 'resetsel', label: `reset the ${many.length} selected channels` }] : live.def !== undefined && live.value !== live.def && !live.disabled ? [{ k: 'reset', label: 'reset to default' }] : []; })()),
      ];
      contextMenu(e.clientX, e.clientY, items, (k) => {
        if (k === 'copy') { fieldClip = { value: live.value }; try { navigator.clipboard?.writeText?.(typeof live.value === 'string' ? live.value : JSON.stringify(live.value)); } catch { /* the in-page clip is enough */ } }
        else if (k === 'paste') edit(live.k, fieldClip.value);
        else if (k === 'path') { fieldClip = { value: live.path }; try { navigator.clipboard?.writeText?.(live.path); } catch { /* ok */ } }
        else if (k === 'reset') edit(live.k, live.def);
        else if (k === 'resetsel') void (async () => {
          // one after another: each write names the value it replaces, so the next must see the last one land (two at once
          // and the authority refuses the second as 'changed'; seen in the probe: x reset, z did not)
          for (const r of [...(row.parentElement?.querySelectorAll('.sp-row.chan-sel') ?? [])]) {
            if (!r._reset?.()) continue;
            for (let t = 0; t < 30 && r._reset?.(true); t++) await new Promise((z) => setTimeout(z, 50));
          }
        })();
      });
    };
    row.append(menuButton(row));
  }
  // revert-to-default (Godot's ↺ / Blender's Backspace): a field that declares `def` grows a
  // small ↺ while its value differs; clicking commits the default through the same edit path
  // …except the transform's channels: there the reset is the right-click menu's (R, 10-10: "why does only scale get
  // the 'reset to default'? it feels like a right-click menu item anyway")
  if (f.def !== undefined && ['num', 'enum', 'color', 'range'].includes(f.t) && !/(?:^|:)(?:pos|rot)\./.test(f.k ?? '')) {
    const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b);
    const face = f.t === 'color' ? '#' + (+f.def).toString(16).padStart(6, '0') : f.deg ? `${Math.round(f.def * R2D)}°` : String(f.def);
    const rv = el('button', 'sp-revert', '↺'); rv.tabIndex = -1; rv.title = `revert to default (${face})`;
    rv.onclick = (e) => { e.stopPropagation(); edit(f.k, f.def); };
    rv.hidden = same(f.value, f.def) || !!f.disabled;
    row.append(rv);
    const up = row.update;
    row.update = (nf) => { up?.(nf); rv.hidden = same(nf.value, nf.def) || !!nf.disabled; };
  }
  return row;
}

// ---------------------------------------------------------------- canvas renderer
// The VR seam. Same fields, painted to a 2D canvas; returns hit REGIONS in
// canvas pixels so xr.js can turn a laser UV-hit into the same edit() call.
// Text fields render display-only here on purpose (no floating keyboards).

// The quad wears the PANELS' skin, not its own (in-headset, 09-04: "looks
// hand-rolled — go with the panels"): colors come from the same tokens the
// desktop frames use, read at paint time; a quad has no alpha, so the panel
// ground is the solid --panel-rgb. Fallbacks keep a headless/tokenless page
// painting the old palette.
function tokens() {
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch { /* no DOM */ }
  const t = (n, fb) => { const v = cs?.getPropertyValue(n)?.trim(); return v || fb; };
  const rgb = t('--panel-rgb', '16 19 24').split(/[ ,]+/).map(Number);
  const bg = `rgb(${rgb[0] ?? 16}, ${rgb[1] ?? 19}, ${rgb[2] ?? 24})`;
  return {
    bg, row: 'rgba(255,255,255,0.04)', well: 'rgba(0,0,0,0.4)',
    label: t('--dim', '#97979b'), text: t('--fg', '#ebebe9'),
    accent: t('--brand', '#8fe8c8'), danger: '#6e2a2a', line: 'rgba(255,255,255,0.10)',
    head: 'rgba(255,255,255,0.06)', driven: '#b48cff',
  };
}
let C = tokens();

export function renderCanvas(canvas, fields, { width = 512, rowH = 44, pad = 12, title = '', theme = null } = {}) {
  if (theme === 'edit') return paintEdit(canvas, fields, { width, title });   // edit mode's frames: their own look, under the VR floor (editpaint.js)
  const rows = [];
  let folded = false;
  for (const f of fields) {
    if (f.t === 'group') { folded = f.open === false; rows.push(f); continue; }
    if (folded || f.deskOnly) continue;
    rows.push(f, ...(f.t === 'list' || f.t === 'tree' ? (f.rows ?? []).map((r) => ({ _row: r, parent: f })) : []));
  }
  C = tokens();
  const HEAD = title ? 30 : 0;                       // the frame's small always-on header
  const H = HEAD + rows.length * rowH + pad * 2;
  canvas.width = width; canvas.height = H;
  const g = canvas.getContext('2d');
  const regions = [];
  g.fillStyle = C.bg; g.fillRect(0, 0, width, H);
  let y = 0;
  const font = (px, w = 400) => { g.font = `${w} ${px}px system-ui, sans-serif`; };

  if (title) {
    g.fillStyle = C.head; g.fillRect(0, 0, width, HEAD);
    g.fillStyle = C.line; g.fillRect(0, HEAD - 1, width, 1);
    font(13, 600); g.fillStyle = C.label;
    g.fillText(title.toUpperCase(), pad, HEAD * 0.66);
    y = HEAD;
  }
  y += pad;
  for (const f of rows) {
    if (f._row) { // a list or tree row
      const r = f._row; const tree = f.parent.t === 'tree';
      const ind = tree ? (r.depth ?? 0) * 18 : 0;
      g.fillStyle = r.active ? 'rgba(143,232,200,0.16)' : C.row;
      g.fillRect(pad, y + 2, width - pad * 2, rowH - 4);
      font(15, r.active ? 600 : 400); g.fillStyle = C.text;
      g.fillText(String(r.label).slice(0, 34), pad + 10 + ind, y + rowH * 0.62);
      if (tree && (r.sub || r.badges?.length)) {
        font(11); g.fillStyle = C.label;
        g.fillText([r.sub, ...(r.badges ?? [])].filter(Boolean).join(' · ').slice(0, 40), pad + 10 + ind + Math.min(220, r.label.length * 9 + 14), y + rowH * 0.62);
      }
      regions.push({ x: pad, y, w: width * 0.6, h: rowH, action: f.parent.k ?? 'row', payload: r.id });
      if (tree && r.kids) {   // a disclosure glyph, its own hit region ahead of the row's
        font(13); g.fillStyle = C.label; g.fillText(r.open === false ? '▸' : '▾', pad + ind - 4, y + rowH * 0.62);
        regions.unshift({ x: pad + ind - 8, y, w: 16, h: rowH, action: 'open', payload: r.id });
      }
      if (tree) {
        const bw = 34, bx = width - pad - bw;
        g.fillStyle = r.locked ? C.accent : '#2a3342';
        g.fillRect(bx, y + 7, bw, rowH - 14);
        font(13, 600); g.fillStyle = r.locked ? '#14100c' : C.text;
        g.fillText(r.locked ? 'L' : 'l', bx + 12, y + rowH * 0.62);
        if (r.lockable !== false) regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: 'lock', payload: r.id });
        y += rowH; continue;
      }
      let bx = width - pad;
      for (const a of [...(r.actions ?? [])].reverse()) {
        const bw = Math.max(52, a.label.length * 9 + 18);
        bx -= bw + 6;
        g.fillStyle = a.danger ? C.danger : C.well;
        g.fillRect(bx, y + 7, bw, rowH - 14);
        font(13, 500); g.fillStyle = C.text;
        g.fillText(a.label, bx + 9, y + rowH * 0.6);
        regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: a.k, payload: r.id });
      }
      y += rowH; continue;
    }
    if (f.t === 'group') {
      g.fillStyle = C.line; g.fillRect(pad, y + rowH - 6, width - pad * 2, 1);
      font(14, 600); g.fillStyle = C.accent;
      g.fillText(`${f.open === false ? '▸' : '▾'} ${f.label}`, pad, y + rowH * 0.62);
      regions.push({ x: pad, y, w: width - pad * 2, h: rowH, action: 'fold', payload: f.k });
      y += rowH; continue;
    }
    if (f.label != null) { font(13); g.fillStyle = f.driven ? C.driven : C.label; g.fillText(f.label, pad, y + rowH * 0.6); }
    const vx = width * 0.34;
    const mark = regions.length;   // a disabled field paints but takes no hits
    switch (f.t) {
      case 'enum': {
        let bx = vx;
        for (const o of f.options ?? []) {
          const lab = String(o.label ?? o.v); const bw = Math.max(40, lab.length * 8 + 16);
          const on = o.v === f.value;
          g.fillStyle = on ? C.accent : '#2a3342';
          g.fillRect(bx, y + 7, bw, rowH - 14);
          font(13, on ? 600 : 400); g.fillStyle = on ? '#14100c' : C.text;
          g.fillText(lab, bx + 8, y + rowH * 0.62);
          regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: f.k, payload: o.v });
          bx += bw + 4;
          if (bx > width - pad - 40) break;
        }
        break;
      }
      case 'color': {
        const s = rowH - 14;
        g.fillStyle = '#' + (f.value ?? 0xffffff).toString(16).padStart(6, '0');
        g.fillRect(vx, y + 7, s * 1.6, s);
        g.strokeStyle = C.label; g.lineWidth = 1; g.strokeRect(vx, y + 7, s * 1.6, s);
        // an 8-swatch palette: the keyboard-free way to pick a color
        const PAL = [0xffffff, 0xffd9a0, 0xff8a5c, 0xe05a5a, 0x7cc47c, 0x5fa8ff, 0xb48cff, 0x202020];
        let bx = vx + s * 1.6 + 8;
        for (const c of PAL) {
          g.fillStyle = '#' + c.toString(16).padStart(6, '0');
          g.fillRect(bx, y + 9, s - 4, s - 4);
          regions.push({ x: bx, y: y + 9, w: s - 4, h: s - 4, action: f.k, payload: c });
          bx += s;
        }
        break;
      }
      case 'tiles': {   // legacy quads: the tiles as one line of pills (edit chrome paints a grid)
        let bx = pad;
        for (const o of f.options ?? []) {
          const lab = String(o.label ?? o.v); const bw = Math.max(40, lab.length * 8 + 16);
          if (bx + bw > width - pad) break;
          const on = o.v === f.value;
          g.fillStyle = on ? C.accent : '#2a3342';
          g.fillRect(bx, y + 7, bw, rowH - 14);
          font(13, on ? 600 : 400); g.fillStyle = on ? '#14100c' : C.text;
          g.fillText(lab, bx + 8, y + rowH * 0.62);
          regions.push({ x: bx, y: y + 7, w: bw, h: rowH - 14, action: f.k, payload: o.v });
          bx += bw + 4;
        }
        break;
      }
      case 'info': font(15); g.fillStyle = C.text; g.fillText(String(f.value ?? '').slice(0, 30), vx, y + rowH * 0.6); break;
      case 'log': font(13); g.fillStyle = C.label; g.fillText(String((f.lines ?? []).at(-1) ?? f.empty ?? '').slice(0, 44), pad, y + rowH * 0.6); break;   // newest line only: a quad has no scrollback
      case 'text': font(15); g.fillStyle = C.label; g.fillText(String(f.value ?? '—').slice(0, 26), vx, y + rowH * 0.6); break;
      case 'json': font(13); g.fillStyle = C.label; g.fillText(String(f.value ?? '—').replace(/\s+/g, ' ').slice(0, 34), vx, y + rowH * 0.6); break;   // display-only: no keyboard in a headset
      case 'btn': {
        const bw = Math.max(90, f.label.length * 9 + 24);
        g.fillStyle = f.danger ? C.danger : C.accent;
        g.fillRect(pad, y + 6, bw, rowH - 12);
        font(15, 600); g.fillStyle = f.danger ? C.text : '#14100c';
        g.fillText(f.label, pad + 12, y + rowH * 0.62);
        regions.push({ x: pad, y: y + 6, w: bw, h: rowH - 12, action: f.k });
        break;
      }
      case 'ref': {
        // the reference name box arms the laser-pick; the next thing the
        // pointer selects (a row or the thing in the world) names the target.
        const txt = f.arming ? 'click a target…' : (f.value ?? '— pick —');
        const bw = Math.max(120, txt.length * 8 + 24);
        g.fillStyle = f.arming ? C.accent : C.row;
        g.fillRect(vx, y + 6, bw, rowH - 12);
        font(15); g.fillStyle = f.arming ? '#14100c' : C.text;
        g.fillText(txt, vx + 10, y + rowH * 0.62);
        regions.push({ x: vx, y: y + 6, w: bw, h: rowH - 12, action: f.k });
        if (f.value != null && !f.arming) {                 // a ✕ to clear
          const cx = vx + bw + 8;
          g.fillStyle = C.danger; font(15, 600);
          g.fillText('✕', cx, y + rowH * 0.62);
          regions.push({ x: cx - 4, y: y + 6, w: 24, h: rowH - 12, action: f.k, payload: null });
        }
        break;
      }
      case 'check': {
        const s = rowH - 16;
        g.strokeStyle = C.label; g.lineWidth = 2;
        g.strokeRect(vx, y + 8, s, s);
        if (f.value) {
          g.strokeStyle = C.accent; g.lineWidth = 3;
          g.beginPath();
          g.moveTo(vx + s * 0.2, y + 8 + s * 0.55);
          g.lineTo(vx + s * 0.45, y + 8 + s * 0.8);
          g.lineTo(vx + s * 0.85, y + 8 + s * 0.2);
          g.stroke();
        }
        regions.push({ x: vx, y: y + 8, w: s, h: s, action: f.k, payload: !f.value });
        break;
      }
      case 'range': {
        const lo = f.min ?? 0, hi = f.max ?? 1, st = f.step ?? 0.01, dp = f.dp ?? 2;
        const v = Math.min(hi, Math.max(lo, +(f.value ?? lo)));
        const tw = width - pad - vx - 64, ty = y + rowH / 2, frac = (v - lo) / (hi - lo || 1);
        g.fillStyle = C.well; roundRect(g, vx, ty - 4, tw, 8, 4); g.fill();
        g.fillStyle = C.accent; roundRect(g, vx, ty - 4, Math.max(8, tw * frac), 8, 4); g.fill();
        g.beginPath(); g.arc(vx + tw * frac, ty, 9, 0, Math.PI * 2); g.fillStyle = C.text; g.fill();
        font(15); g.fillStyle = C.text; g.textAlign = 'right'; g.fillText(`${trimNum(v, dp)}${f.unit ?? ''}`, width - pad, y + rowH * 0.62); g.textAlign = 'left';
        // one region for the whole track: the hit's fraction along it is the value
        regions.push({ x: vx - 6, y: y + 4, w: tw + 12, h: rowH - 8, action: f.k, slider: { lo, hi, st } });
        break;
      }
      case 'num': paintStepper(g, regions, f, +(f.value ?? 0), vx, y, rowH, f.k, null, f.dp); break;
      case 'vec3': {
        const seg = (width - vx - pad) / 3;
        (f.value ?? [0, 0, 0]).forEach((c, i) =>
          paintStepper(g, regions, f, +c, vx + seg * i, y, rowH, f.k, f.link ? null : i, f.dp, seg - 8));
        break;
      }
    }
    if (f.disabled) regions.length = mark;
    y += rowH;
  }
  return regions;
}

function paintStepper(g, regions, f, val, x, y, rowH, k, axis, dp = 2, w = 150) {
  const bump = 26, mid = w - bump * 2;
  g.fillStyle = C.well;
  g.fillRect(x, y + 7, bump, rowH - 14);
  g.fillRect(x + bump + mid, y + 7, bump, rowH - 14);
  g.fillStyle = C.row; g.fillRect(x + bump, y + 7, mid, rowH - 14);
  g.font = '600 16px system-ui'; g.fillStyle = C.text;
  g.fillText('−', x + 8, y + rowH * 0.62);
  g.fillText('+', x + bump + mid + 7, y + rowH * 0.62);
  g.font = '500 14px system-ui';
  const face = f.deg ? `${Math.round(val * R2D)}°` : trimNum(val, dp) + (f.unit ? ` ${f.unit}` : '');
  g.fillText(face, x + bump + 8, y + rowH * 0.62);
  // deltas are on the WIRE scale (radians for deg fields): the dispatcher adds
  // them to the current value and never has to know what the face showed
  const d = f.deg ? (f.step ?? 1) / R2D : (f.step ?? 0.1);
  regions.push({ x, y: y + 7, w: bump, h: rowH - 14, action: k, payload: { axis, delta: -d } });
  regions.push({ x: x + bump + mid, y: y + 7, w: bump, h: rowH - 14, action: k, payload: { axis, delta: +d } });
}

/** A canvas stepper reports { axis, delta } (it has no value to add to); a
 *  dispatcher that expects the NUMBER the DOM path sends resolves it here
 *  against the painted field. Numbers pass through untouched. */
export function resolveDelta(fields, k, payload) {
  if (!(typeof payload === 'object' && payload && 'delta' in payload)) return payload;
  const f = fields.find((x) => x.k === k);
  if (!f) return null;
  if (f.t === 'vec3') { const v = [...(f.value ?? [0, 0, 0])]; const i = payload.axis ?? 0; v[i] = +v[i] + payload.delta; return v; }
  return +(f.value ?? 0) + payload.delta;
}

/** Resolve a UV hit (0..1, v measured from the top) against regions. */
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h);
  g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}

export function hitRegion(regions, canvas, u, v) {
  const x = u * canvas.width, y = v * canvas.height;
  const r = regions.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) ?? null;
  if (r?.slider) {
    // a slider's payload is WHERE you clicked along the track, snapped to step
    const { lo, hi, st } = r.slider;
    const frac = Math.min(1, Math.max(0, (x - (r.x + 6)) / Math.max(1, r.w - 12)));
    const raw = lo + frac * (hi - lo);
    r.payload = +(Math.round(raw / st) * st).toFixed(6);
  }
  return r;
}
