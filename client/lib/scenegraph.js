// scenegraph — the world as a tree, and the scripts that animate it.
//
// Two sections in the world panel:
//
//   🌳 scene    every entity as a row; mounted things indent under their
//               parent, seated bodies show as riders. Click a row → the
//               INSPECTOR, which is layered the same way the fold is:
//               · a generic transform editor (pos / yaw / scale → `place`);
//               · SEMANTIC editors registered by evaluator modules via
//                 inspect.js (lights register color/brightness/range/keep —
//                 drag previews locally, release commits one partial verb);
//               · a generic component editor — every comp type as a row,
//                 editable as raw JSON, removable, addable. Meaning-free by
//                 design: a comp type invented this morning is editable
//                 today. A saved edit replaces that type's data WHOLESALE
//                 (the comp verb's contract).
//               · actions: find, attach (pick a new parent by clicking it),
//                 detach, remove. Attach PRESERVES the current world
//                 transform — the thing glues where it stands, never jumps.
//
//   📜 scripts  the behavior runtime made visible: every bound script with
//               its status (running / paused-with-reason), what it's attached
//               to, its timers — and, selected, its live console (the ring
//               world.log() writes to), polled while you watch. This is the
//               debug UI for the scripting tier; agents get the same data via
//               world_debug, this is the human window onto it.
//
// Everything here READS client state and EMITS verbs — no private channel,
// no authority. The server enforces rights; buttons just try.

import { THREE } from './core.js';
import { CONFIG, bus } from './base.js';
import { entities, entityMeta, comps, avatarMounts } from './world.js';
import { editorsFor } from './inspect.js';
import './lights.js';   // for its registered light editor (world.js pulls it in anyway)
import { sendVerb, requestDebug } from './net.js';
import { makeSection, flashHint } from './ui.js';
import { logChat } from './chat.js';
import { myState } from './controller.js';

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _fw = new THREE.Vector3();
const worldYawOf = (obj) => {
  obj.getWorldQuaternion(_wq);
  _fw.set(0, 0, 1).applyQuaternion(_wq);
  return Math.atan2(_fw.x, _fw.z);
};

// ============================================================ 🌳 scene

let sceneApi = null;
let sceneBody = null;
let selected = null;       // entity id shown in the inspector
let arming = null;         // child id waiting for a parent click

function badgesFor(id) {
  const out = [];
  const bag = comps.get(id) ?? {};
  for (const [type, data] of Object.entries(bag)) {
    if (type === 'motion' || type.startsWith('motion:')) {
      out.push(`${type}(${data?.type ?? '…'})`);
    } else if (type === 'sockets' || type === 'reactions') {
      out.push(`${type}(${Object.keys(data ?? {}).join(',')})`);
    } else out.push(type);
  }
  return out;
}

function treeData() {
  const kids = new Map();
  const roots = [];
  for (const [id, obj] of entities) {
    const p = obj?.userData?.mountedTo;
    if (p && entities.has(p)) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(id);
    } else roots.push(id);
  }
  const riders = new Map();
  for (const [rid, m] of avatarMounts) {
    if (!riders.has(m.to)) riders.set(m.to, []);
    riders.get(m.to).push(m.slot ? `${rid} (${m.slot})` : rid);
  }
  return { roots, kids, riders };
}

let editingComp = null;    // comp type whose JSON is open, or true for a new one

function paintScene(force = false) {
  if (!sceneBody) return;
  // don't yank an editor out from under the user: an open JSON textarea, or
  // any focused editor control (a light slider mid-drag, a half-typed pos
  // field), holds repaints — the echo of a committed verb queues one, and it
  // must not rebuild the DOM under the pointer. Interior state changes
  // (opening/closing an editor) repaint with force.
  if (!force) {
    if (editingComp != null) return;
    const ae = document.activeElement;
    if (sceneBody.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae?.tagName ?? '')) return;
  }
  const { roots, kids, riders } = treeData();
  const rows = [];
  const row = (id, depth) => {
    const meta = entityMeta.get(id);
    const short = (meta?.lib ?? meta?.kind ?? '?').split('/').pop().replace('.glb', '')
      .split('_').slice(0, 3).join(' ');
    const badges = badgesFor(id);
    const scripts = behaviorRows.filter((b) => b.attach === id).map((b) => `📜${b.id}`);
    rows.push(`<div class="who-row sg-row" data-id="${esc(id)}" style="cursor:pointer;padding-left:${depth * 14}px;${id === selected ? 'background:rgba(255,255,255,.06)' : ''}">
      <span class="n">${depth ? '└ ' : ''}<b>${esc(id)}</b> <span style="color:var(--dim)">${esc(short)}</span></span>
      <span class="d">${esc([...badges, ...scripts].join(' · '))}</span></div>`);
    for (const r of riders.get(id) ?? []) {
      rows.push(`<div class="who-row" style="padding-left:${(depth + 1) * 14}px"><span class="n">└ 🧍 ${esc(r)}</span></div>`);
    }
    for (const k of kids.get(id) ?? []) row(k, depth + 1);
  };
  for (const id of roots.sort()) row(id, 0);

  let inspector = '';
  let eds = [];
  if (selected && entities.has(selected)) {
    const obj = entities.get(selected);
    const meta = entityMeta.get(selected);
    const bag = comps.get(selected);
    const pos = obj ? obj.getWorldPosition(_wp) : null;
    const isLight = !!obj?.userData?.isLight;

    // generic transform editor — every entity has a pose; yaw/scale make no
    // sense on a bulb. Values are the entity's LOCAL frame (labelled when
    // mounted): exactly what a `place` verb takes.
    let transform = '';
    if (obj) {
      const n2 = (v) => Number(v.toFixed(2));
      // a locked thing's pose is read-only — the server would refuse the
      // `place` anyway; a disabled field says so before the round-trip
      const locked = !!bag?.lock;
      const cell = (f, v, step) => `<input type="number" data-tf="${f}" value="${v}" step="${step}" style="width:4.5em"${locked ? ' disabled title="locked — remove the lock comp to move"' : ''}>`;
      transform = `<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:4px 0">
        <span style="color:var(--dim)">${locked ? '🔒 ' : ''}${obj.userData.mountedTo ? 'local ' : ''}pos</span>
        ${cell('x', n2(obj.position.x), 0.1)}${cell('y', n2(obj.position.y), 0.1)}${cell('z', n2(obj.position.z), 0.1)}
        ${isLight ? '' : `<span style="color:var(--dim)">yaw°</span>${cell('yaw', Math.round(obj.rotation.y * 180 / Math.PI), 5)}
        <span style="color:var(--dim)">scale</span>${cell('scale', n2(obj.scale?.x ?? 1), 0.05)}`}
      </div>`;
    }

    // semantic editors — whatever evaluator modules registered for this thing
    eds = editorsFor({ id: selected, obj, meta, bag, commit: sendVerb, esc });

    // generic component editor — meaning-free by design, the UI twin of the
    // blind fold: any comp type, known or invented this morning, shows as a
    // row and edits as raw JSON. A saved edit replaces that type's data
    // WHOLESALE (that is the comp verb's contract); ✕ removes (data: null).
    const bagObj = bag ?? {};
    const compRows = Object.entries(bagObj).map(([type, data]) => {
      if (editingComp === type) {
        return `<div style="margin:2px 0"><b>${esc(type)}</b>
          <textarea data-ce="json" spellcheck="false" style="width:100%;height:90px;font-size:11px;font-family:inherit">${esc(JSON.stringify(data, null, 1))}</textarea>
          <div style="display:flex;gap:6px"><button data-ce="apply">apply</button><button data-ce="cancel">cancel</button></div></div>`;
      }
      return `<div style="display:flex;gap:6px;align-items:center">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(type)}</b> <span style="color:var(--dim);font-size:11px">${esc(JSON.stringify(data).slice(0, 60))}</span></span>
        <button data-ce-edit="${esc(type)}" title="edit as JSON">✎</button>
        <button data-ce-del="${esc(type)}" title="remove component">✕</button></div>`;
    });
    const newComp = editingComp === true
      ? `<div style="margin:2px 0"><input data-ce="newtype" placeholder="type (e.g. sockets, recipe…)" style="width:14em">
          <textarea data-ce="json" spellcheck="false" style="width:100%;height:90px;font-size:11px;font-family:inherit">{
}</textarea>
          <div style="display:flex;gap:6px"><button data-ce="apply">apply</button><button data-ce="cancel">cancel</button></div></div>`
      : `<div><button data-ce-add title="attach a component — any type folds, evaluators give known ones behavior">+ component</button></div>`;

    inspector = `<div style="border-top:1px solid var(--edge);margin-top:6px;padding-top:6px">
      <div><b>${esc(selected)}</b> <span style="color:var(--dim)">${esc(meta?.lib ?? '')}</span></div>
      <div style="color:var(--dim)">placed by ${esc(meta?.actor ?? '?')} · ${pos ? `at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : 'loading'}${obj?.userData?.mountedTo ? ` · mounted on ${esc(obj.userData.mountedTo)}` : ''}</div>
      ${transform}
      ${eds.map((e) => e.html).join('')}
      ${compRows.join('')}${newComp}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button data-act="find">find</button>
        <button data-act="attach">${arming === selected ? 'click new parent…' : 'attach to…'}</button>
        ${obj?.userData?.mountedTo ? '<button data-act="detach">detach</button>' : ''}
        <button data-act="remove">remove</button>
      </div></div>`;
  }
  sceneBody.innerHTML = `<div class="stack" style="max-height:200px;overflow:auto">${rows.join('') || '<div style="color:var(--dim)">nothing placed yet</div>'}</div>${inspector}`;

  for (const el of sceneBody.querySelectorAll('.sg-row')) {
    el.onclick = () => {
      const id = el.dataset.id;
      if (arming && arming !== id) { doAttach(arming, id); arming = null; return; }
      selected = id === selected ? null : id;
      arming = null;
      editingComp = null;
      paintScene(true);
    };
  }
  sceneBody.querySelector('[data-act="find"]')?.addEventListener('click', () => {
    const obj = entities.get(selected);
    if (!obj) return;
    const p = obj.getWorldPosition(_wp);
    flashHint(`<b>${esc(selected)}</b> is ${p.distanceTo(myState.pos).toFixed(0)}m away at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`, 5000);
  });
  sceneBody.querySelector('[data-act="attach"]')?.addEventListener('click', () => {
    arming = arming === selected ? null : selected;
    flashHint(arming ? 'now click the row of its new parent' : 'attach cancelled', 4000);
    paintScene();
  });
  // semantic editors wire their own controls
  for (const e of eds) { try { e.wire(sceneBody); } catch { /* an editor must not break the panel */ } }

  // transform: commit on change — one `place` per gesture, carrying the full
  // pose the fields show (pos triple always; yaw/scale when present). No
  // local preview: place is cheap and the echo lands in a frame or two.
  const tf = (f) => sceneBody.querySelector(`[data-tf="${f}"]`);
  for (const el of sceneBody.querySelectorAll('[data-tf]')) {
    el.addEventListener('change', () => {
      const args = { id: selected, pos: [Number(tf('x').value), Number(tf('y').value), Number(tf('z').value)] };
      if (tf('yaw')) args.yaw = Number(tf('yaw').value) * Math.PI / 180;
      if (tf('scale')) args.scale = Number(tf('scale').value);
      if (args.pos.some(Number.isNaN) || Number.isNaN(args.yaw ?? 0) || Number.isNaN(args.scale ?? 1)) return;
      sendVerb('place', args);
    });
  }

  // component editor: ✎ opens raw JSON, apply parses + commits, ✕ removes
  for (const b of sceneBody.querySelectorAll('[data-ce-edit]')) {
    b.onclick = () => { editingComp = b.dataset.ceEdit; paintScene(true); };
  }
  for (const b of sceneBody.querySelectorAll('[data-ce-del]')) {
    b.onclick = () => { sendVerb('comp', { id: selected, type: b.dataset.ceDel, data: null }); };
  }
  sceneBody.querySelector('[data-ce-add]')?.addEventListener('click', () => {
    editingComp = true; paintScene(true);
  });
  sceneBody.querySelector('[data-ce="apply"]')?.addEventListener('click', () => {
    const type = editingComp === true
      ? (sceneBody.querySelector('[data-ce="newtype"]')?.value ?? '').trim()
      : editingComp;
    if (!type) { flashHint('component needs a type name', 4000); return; }
    let data;
    try { data = JSON.parse(sceneBody.querySelector('[data-ce="json"]').value); }
    catch (err) { flashHint(`not valid JSON: ${esc(err.message)}`, 5000); return; }
    sendVerb('comp', { id: selected, type, data });
    editingComp = null;
    paintScene(true);
  });
  sceneBody.querySelector('[data-ce="cancel"]')?.addEventListener('click', () => {
    editingComp = null; paintScene(true);
  });

  sceneBody.querySelector('[data-act="detach"]')?.addEventListener('click', () => doDetach(selected));
  sceneBody.querySelector('[data-act="remove"]')?.addEventListener('click', () => {
    sendVerb('remove', { id: selected });
    selected = null;
  });
}

/** World-click → panel: select the entity's row, open the scene section
 *  (and the panel frame, if hidden), and scroll the row into view. Exported
 *  for build.js — clicking a thing in edit mode and clicking its row are the
 *  same act, so the inspector (transform, semantic editors, comp bag) arrives
 *  with the selection instead of hiding behind a second gesture. */
export function sceneSelect(id) {
  if (!sceneApi || !entities.has(id)) return;
  selected = id;
  arming = null;
  editingComp = null;
  const reveal = () => {
    paintScene(true);
    sceneBody?.querySelector(`.sg-row[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };
  // toggle(true) surfaces the panel frame (even when the section is already
  // open) and — on first open — assigns sceneBody synchronously BEFORE its
  // async roster fetch. So paint now: selection must never be hostage to a
  // network round-trip. Repaint when the roster lands (📜 badges refine).
  const t = sceneApi.toggle(true);
  reveal();
  Promise.resolve(t).then(reveal).catch(() => {});
}

/** Attach preserving the CURRENT world transform: compute the child's pose in
 *  the parent's frame and send it as the mount offset — glue, don't teleport.
 *  Exported for /mount — command and panel are the same act. */
export function sceneAttach(childId, parentId, slot) {
  if (slot) {   // a declared socket wins over glue-in-place
    sendVerb('mount', { id: childId, to: parentId, slot });
    return;
  }
  doAttach(childId, parentId);
}
function doAttach(childId, parentId) {
  const child = entities.get(childId);
  const parent = entities.get(parentId);
  if (!child || !parent) return logChat('*', 'both things must be fully loaded');
  if (childId === parentId) return;
  // no cycles: walking up from the parent must not meet the child
  for (let p = parent; p; p = entities.get(p.userData?.mountedTo)) {
    if (p === child) return logChat('*', 'that would mount a thing onto its own cargo');
  }
  const lp = parent.worldToLocal(child.getWorldPosition(_wp.clone()));
  const relYaw = worldYawOf(child) - worldYawOf(parent);
  sendVerb('mount', {
    id: childId, to: parentId,
    offset: [+lp.x.toFixed(3), +lp.y.toFixed(3), +lp.z.toFixed(3)],
    yaw: +relYaw.toFixed(3),
  });
  logChat('*', `${childId} now rides ${parentId} — it moves when ${parentId} moves`);
}

export function sceneDetach(id) { doDetach(id); }
function doDetach(id) {
  const obj = entities.get(id);
  if (!obj) return;
  const p = obj.getWorldPosition(_wp);
  sendVerb('dismount', { id, pos: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)], yaw: +worldYawOf(obj).toFixed(3) });
}

// ============================================================ 📜 scripts

let scriptsApi = null;
let scriptsBody = null;
let behaviorRows = [];     // last roster — also feeds the 📜 badges in the tree
let watching = null;       // behavior id whose console is open
let pollTimer = null;

async function refreshRoster() {
  const r = await requestDebug({ behaviors: true });
  behaviorRows = (r.events ?? []).filter((e) => e.kind === 'behavior');
}

async function paintScripts() {
  if (!scriptsBody) return;
  const rows = behaviorRows.map((b) => {
    const ok = b.status === 'running';
    return `<div class="who-row sg-bhv" data-id="${esc(b.id)}" style="cursor:pointer;${b.id === watching ? 'background:rgba(255,255,255,.06)' : ''}">
      <span class="n">${ok ? '▶' : '⏸'} <b>${esc(b.id)}</b>${b.attach ? ` <span style="color:var(--dim)">on ${esc(b.attach)}</span>` : ''}</span>
      <span class="d">${b.timers ? `${b.timers}⏲ ` : ''}${ok ? '' : 'paused'}</span></div>`;
  });

  let consoleHtml = '';
  if (watching) {
    const d = await requestDebug({ behavior: watching, limit: 40 });
    const lines = (d.events ?? []).map((e) =>
      `${new Date(e.ts).toTimeString().slice(0, 8)} ${esc(e.line)}`).join('\n');
    consoleHtml = `<div style="border-top:1px solid var(--edge);margin-top:6px;padding-top:6px">
      <div><b>${esc(watching)}</b> — <span style="color:${d.status === 'running' ? 'var(--ok, #7c9)' : 'var(--warn, #ea5)'}">${esc(d.status ?? '?')}</span></div>
      <pre style="max-height:150px;overflow:auto;margin:4px 0;font-size:11px;white-space:pre-wrap">${lines || '(console empty — world.log() writes here)'}</pre>
      <div style="display:flex;gap:6px">
        <button data-act="unbind">unbind</button>
      </div></div>`;
  }
  scriptsBody.innerHTML = `<div class="stack">${rows.join('') || '<div style="color:var(--dim)">no scripts bound here — see AGENTS.md §runtime scripts</div>'}</div>${consoleHtml}
    <div style="color:var(--dim);font-size:11px;margin-top:4px">/debug [n] = flight recorder · agents: world_debug</div>`;

  for (const el of scriptsBody.querySelectorAll('.sg-bhv')) {
    el.onclick = () => { watching = el.dataset.id === watching ? null : el.dataset.id; paintScripts(); };
  }
  scriptsBody.querySelector('[data-act="unbind"]')?.addEventListener('click', async () => {
    sendVerb('behavior', { id: watching, remove: true });
    watching = null;
    setTimeout(async () => { await refreshRoster(); paintScripts(); paintScene(); }, 400);
  });
}

// ============================================================ wiring

export function initSceneGraph() {
  sceneApi = makeSection('🌳 scene', async (body) => {
    sceneBody = body;
    await refreshRoster();      // the tree shows 📜 badges too
    paintScene();
  }, { id: 'scene' });

  scriptsApi = makeSection('📜 scripts', async (body) => {
    scriptsBody = body;
    await refreshRoster();
    await paintScripts();
    clearInterval(pollTimer);
    // live console: poll while the section is open — a script author sits
    // here watching their world.log() arrive, which is the whole point
    pollTimer = setInterval(async () => {
      if (!scriptsApi?.isOpen) { clearInterval(pollTimer); pollTimer = null; return; }
      await refreshRoster();
      await paintScripts();
    }, 2500);
  }, { id: 'scripts' });

  // keep the tree honest while it's visible
  let repaintQueued = false;
  const repaint = () => {
    if (repaintQueued || !sceneApi?.isOpen) return;
    repaintQueued = true;
    setTimeout(() => { repaintQueued = false; if (sceneApi?.isOpen) paintScene(); }, 300);
  };
  bus.on('entity', repaint);
  bus.on('comp', repaint);
  bus.on('mount', repaint);
}
