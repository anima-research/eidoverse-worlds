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
import { WIDGETS, FACTS, paintFields, el, put, trimNum, R2D } from './widgets.js';
export { trimNum, WIDGETS } from './widgets.js';
// a name from either set: the line icons (24 grid) or the filled ones (the eye, R 10-10: the Hierarchy's eye drew nothing,
// 'eye' being a filled-set name the line-set function didn't know)
import { KEYHINTS, engage, release } from './keyhints.js';
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

function stepper(value, f, commit) {
  const cur = { step: 0.1, dp: 2, ...f };   // options are LIVE: update() refreshes them (a typed value past softMax raises the next drag's cap)
  const { unit, deg, compact, disabled } = cur;
  const wrap = el('span', `sp-step${compact ? ' compact' : ''}`);
  const num = el('input', 'sp-num');
  num.type = 'text'; num.inputMode = 'decimal'; num.autocomplete = 'off'; num.spellcheck = false;
  if (disabled) num.disabled = true;
  // a value finer than the row's dp (a typed 0.5 m in a whole-metre row) shows as it is, not rounded to what it isn't
  const toFace = (w) => { const v = deg ? w * R2D : w, dp = deg ? 0 : cur.dp; return trimNum(v, Math.abs(v - +v.toFixed(dp)) > 1e-9 ? Math.max(dp, 3) : dp); };
  const toWire = (face) => (deg ? face / R2D : face);
  const hard = (w) => Math.min(cur.max ?? Infinity, Math.max(cur.min ?? -Infinity, w));
  const soft = (w) => Math.min(cur.softMax ?? cur.max ?? Infinity, Math.max(cur.softMin ?? cur.min ?? -Infinity, w));
  let wire = +value;
  let shownFace = '';   // the text show() last put in the field (onchange: the same text is no edit)
  const show = (w) => { num.value = toFace(w); shownFace = num.value; };
  show(wire);
  const send = (w, o) => { wire = hard(w); show(wire); commit(wire, o); };
  // typed: written AS TYPED. The row's min/max are the slider's, not the door's: the editor's own check (editschema
  // editOps, D4a) refuses what the door would refuse and says why, so nothing here clamps (tools/editor-range-test.ts)
  const sendTyped = (w) => { wire = w; show(wire); commit(wire); };

  // typed entry: relative math against the CURRENT face value, no clamp (sendTyped). ONE commit per typing: Enter commits and
  // blurs, and the blur's own native `change` must not commit again with a stale expect (review 10-07 B2: every Enter
  // wrote the edit, then a second identical set that the authority refused as `changed`, with a red toast). A change
  // whose text is what the field last showed is no edit at all.
  num.onchange = () => {
    if (num.value === shownFace) return;
    const face = parseEntry(num.value, +toFace(wire));
    if (face == null) { show(wire); return; }
    if (face === +toFace(wire)) { show(wire); num.blur(); return; }   // the value it already has: nothing to write
    sendTyped(toWire(face));
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
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && wrap.onSelectKey) { e.preventDefault(); wrap.onSelectKey(e); return; }   // keys: selectExtend — Shift/Ctrl-click a value box: select, as on its name
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
    for (const q of drag.peers) q.p.peer.to(e.ctrlKey || e.metaKey ? Math.round(q.face0 + drag.dFace) : q.face0 + drag.dFace, true);   // keys: scrub (the peers round with the leader)
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
  WIDGETS[f.t]?.dom?.(f, { row, label, setLabel, edit, ro, el, put, stepper, openPop, contextMenu, menuButton });
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
    const face = f.t === 'color' ? FACTS.hex(+f.def) : f.deg ? `${Math.round(f.def * R2D)}°` : String(f.def);
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
    head: 'rgba(255,255,255,0.06)', driven: '#b48cff', mine: '#b08ad8',
  };
}
export function renderCanvas(canvas, fields, { width = 512, rowH = 44, pad = 12, title = '', theme = null } = {}) {
  if (theme === 'edit') return paintEdit(canvas, fields, { width, title });   // edit mode's frames: their own look, under the VR floor (editpaint.js)
  const C = tokens();
  const g = canvas.getContext('2d');
  const regions = [];
  const font = (px, w = 400) => { g.font = `${w} ${px}px system-ui, sans-serif`; };
  const S = {
    kind: 'legacy', edit: false, g, regions, C, font, width, rowH, pad, vx: width * 0.34,
    paintStepper: (f, val, x, y, k, axis, dp, w) => paintStepper(g, regions, C, f, val, x, y, rowH, k, axis, dp, w),
    roundRect,
    begin(items) {
      const HEAD = title ? 30 : 0;                       // the frame's small always-on header
      const H = HEAD + items.length * rowH + pad * 2;
      canvas.width = width; canvas.height = H;
      g.fillStyle = C.bg; g.fillRect(0, 0, width, H);
      let y = 0;
      if (title) {
        g.fillStyle = C.head; g.fillRect(0, 0, width, HEAD);
        g.fillStyle = C.line; g.fillRect(0, HEAD - 1, width, 1);
        font(13, 600); g.fillStyle = C.label;
        g.fillText(title.toUpperCase(), pad, HEAD * 0.66);
        y = HEAD;
      }
      return y + pad;
    },
    prep(f, y, h) {
      const lab = f?.vrLabel ?? f?.label;   // vrLabel: the word a quad paints where the desktop row shows none (the header's box, its name)
      if (f && lab != null) { font(13); g.fillStyle = f.driven ? C.driven : C.label; g.fillText(lab, pad, y + rowH * 0.6); }
      return { ...S, y, h };
    },
  };
  return paintFields(fields, S);
}

function paintStepper(g, regions, C, f, val, x, y, rowH, k, axis, dp = 2, w = 150) {
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
  const d = FACTS.delta(f);
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
