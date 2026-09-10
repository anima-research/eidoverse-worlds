// perfscope — viewer-local perf instrumentation: false-color cost modes over
// the viewport + a hover loupe of deep per-object stats + a heaviest table.
//
// Why the overlay keeps textures: it is much easier to navigate a big world
// on an Easter-egg hunt for perf violators when the objects still look like
// themselves.
// The conventional replace-everything view is the `solid colors` checkbox.
//
// Doctrine:
// · VIEWER-LOCAL. No world verb is ever sent; nothing here mutates the log.
// · MEASURED vs ESTIMATED stays explicit: renderer.info counts are measured;
//   memory/cost numbers are estimates and say so. No GPU timers in v0 —
//   WebGL timer queries are dead-by-default post-Spectre and WebGPU
//   timestamps are a later bonus, so pretending estimates are hardware
//   measurements would be the one dishonest pixel in a debug tool.
// · Fixed absolute thresholds (UE/VRChat convention), not percentiles — a
//   scene of all-cheap objects must not invent red, and numbers stay
//   comparable across worlds. Rank = worst category wins (VRChat).
// · Survives scene churn: stats rebuild on a timer while active; tint
//   overlays are diffed against the census each cycle (originals untouched).
//
// Cost attribution is per SUBJECT, not per mesh: a subject is a world entity
// (nearest ancestor in `entities`), a person (remotes / the local body), or
// the residual 'world fabric' bucket (terrain, sky, grass). That's the
// granularity questions actually arrive at ("what is heavy?" — "the fountain",
// not "mesh #217").

import { THREE, scene, camera, renderer, canvas } from './core.js';
import { positionLocal, normalLocal, positionWorld, cameraPosition, modelScale } from 'three/tsl';
import { entities, entityMeta } from './world.js';
import * as icons from './icons.js';
// the fill icon set is optional: without it the loupe button is its word
const fsvg = (name, size) => (typeof icons.fsvg === 'function' ? icons.fsvg(name, size) : '');

// HTML-attribute escaper for the tooltip strings below (was used un-imported —
// a real hover threw ReferenceError; mocked-innerHTML shots never caught it).
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// data colors, not chrome: a perceptual cheap→dear ramp shared by every mode
// (VRChat's five ranks). Deliberately literal — these mean the same thing in
// every world and every theme, like a heatmap's, so they do NOT follow the
// accent picker.
// perceptually-separated ramp (an earlier ramp blurred: green≈lime, and the
// top three were all one warm tone). Even hue walk + rising chroma:
// emerald → spring-green → amber → tangerine → hot-red. Each tier is its own
// hue AND its own lightness, so they separate at a glance and for CVD eyes.
export const TIERS = ['#2fd08a', '#9be04a', '#ffc23d', '#ff7a2f', '#f23b52'];
const TIER_NAMES = ['excellent', 'good', 'medium', 'poor', 'very poor'];

// per-subject thresholds: crossing [i] puts you in tier i+1
const T = {
  tris:  [5_000, 20_000, 60_000, 150_000],
  draws: [2, 5, 12, 25],
  texMB: [8, 24, 64, 128],
  bones: [75, 150, 256, 400],
  mats:  [2, 4, 8, 16],
  alpha: [1, 3, 6, 12],
};
const tierOf = (v, k) => T[k].reduce((t, th) => (v > th ? t + 1 : t), 0);

// categorical material cost (an honest proxy — real instruction counts are
// not observable from here): lit-ness ladder + transparency/transmission tax
function matCost(m) {
  let c = 0;
  const n = m.type || '';
  if (/Physical|Node.*physical/i.test(n)) c = 4;
  else if (/Standard/i.test(n)) c = 3;
  else if (/Phong|Matcap/i.test(n)) c = 2;
  else if (/Lambert|Toon/i.test(n)) c = 1;
  else if (/NodeMaterial/i.test(n)) c = 3;          // TSL: assume standard-ish
  if (m.transparent) c += 1;
  if (m.transmission > 0) c += 2;
  return Math.min(4, c);
}

const bppOf = (tex) => {
  const f = tex.format, t = tex.type;
  if (t === THREE.FloatType) return 16;
  if (t === THREE.HalfFloatType) return 8;
  return f === THREE.RedFormat ? 1 : f === THREE.RGFormat ? 2 : 4;
};

// estimated GPU bytes for one texture (×1.33 mips). Compressed textures sum
// their real mip payloads instead of pretending to be RGBA8.
function texBytes(tex) {
  const img = tex.image;
  if (!img) return 0;
  const mipSum = (mips) => mips.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0);
  if (tex.isCompressedTexture) {
    // cube / array compressed textures keep their mip chains per face
    if (Array.isArray(img)) return img.reduce((s, f) => s + (Array.isArray(f?.mipmaps) ? mipSum(f.mipmaps) : 0), 0);
    if (Array.isArray(tex.mipmaps) && tex.mipmaps.length) return mipSum(tex.mipmaps);
  }
  if (Array.isArray(img)) {
    const f = img[0];
    if (!f) return 0;
    const w = f.width || f.videoWidth || 0, h = f.height || f.videoHeight || 0;
    return Math.round(w * h * bppOf(tex) * img.length * (tex.generateMipmaps ? 4 / 3 : 1));
  }
  // `||`, not `??`: a <video> has width 0, not undefined
  const w = img.width || img.videoWidth || 0, h = img.height || img.videoHeight || 0;
  // mip chain adds exactly 1/3 (geometric series 1+¼+1/16+… = 4/3) IF mips exist:
  // real uploaded mipmaps, or the auto-generate flag on a power-of-two-ish image.
  const hasMips = (Array.isArray(tex.mipmaps) && tex.mipmaps.length > 1) ||
                  (tex.generateMipmaps && tex.minFilter !== THREE.NearestFilter && tex.minFilter !== THREE.LinearFilter);
  return Math.round(w * h * bppOf(tex) * (hasMips ? 4 / 3 : 1));
}

// ---- collection -------------------------------------------------------------

let subjects = new Map();   // key -> stat record
let meshOwner = new WeakMap(); // mesh -> subject key (for the loupe raycast)
let visibleMeshes = [];     // the shown subset — the loupe raycasts this, not the whole scene

function forget() {
  subjects = new Map();
  meshOwner = new WeakMap();
  visibleMeshes = [];
}

function freshRec(key, kind, label) {
  return { key, kind, label, tris: 0, verts: 0, draws: 0, meshes: 0,
    bones: 0, morphs: 0, instances: 0, alpha: 0, attrBytes: 0,
    mats: new Set(), texs: new Set(), texBytes: 0, meshList: [],
    rank: 0, worst: '' };
}

function collect() {
  // reverse index: entity Object3D -> id  (entities maps id -> node)
  const nodeToId = new Map();
  for (const [id, node] of entities) nodeToId.set(node, id);

  forget();
  const worldRec = freshRec('~world', 'fabric', 'world fabric (terrain · sky · grass …)');

  scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData?.perfscopeIgnore) return;          // our own helpers etc.

    // walk up: entity? a named remote/local body? else the fabric bucket.
    // Also learn whether the mesh is actually shown: hidden LOD levels /
    // outfits keep their VRAM but draw nothing, so tris/draws bill only the
    // visible chain while textures count regardless.
    let rec = null, vis = true;
    for (let p = o; p; p = p.parent) {
      if (!p.visible) vis = false;
      if (rec) continue;
      const id = nodeToId.get(p);
      if (id !== undefined) {
        rec = subjects.get(`e:${id}`);
        if (!rec) {
          const meta = entityMeta.get(id);
          rec = freshRec(`e:${id}`, 'entity', id + (meta?.lib ? `  (${String(meta.lib).split('/').pop()})` : ''));
          subjects.set(rec.key, rec);
        }
        continue;
      }
      if (p.userData?.perfscopeSubject) {              // bodies tag themselves (below)
        rec = subjects.get(`p:${p.userData.perfscopeSubject}`);
        if (!rec) { rec = freshRec(`p:${p.userData.perfscopeSubject}`, 'person', p.userData.perfscopeSubject); subjects.set(rec.key, rec); }
        continue;
      }
      // avatar roots stamp themselves (avatar.js: userData.who on every body).
      // isBody alone is not enough — gaze / drag-nail meshes wear it too.
      if (p.userData?.who) {
        const who = p.userData.who;
        rec = subjects.get(`p:${who}`);
        if (!rec) { rec = freshRec(`p:${who}`, 'person', who); subjects.set(rec.key, rec); }
      }
    }
    if (!rec) { rec = worldRec; if (!subjects.has(rec.key)) subjects.set(rec.key, rec); }

    const g = o.geometry;
    const inst = o.isInstancedMesh ? o.count : 1;
    const idx = g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (vis) {
      rec.tris += Math.round(idx / 3) * inst;
      rec.verts += (g?.attributes?.position?.count ?? 0) * inst;
      rec.instances += inst > 1 ? inst : 0;
      rec.draws += Math.max(1, g?.groups?.length || mats.length);
    }
    rec.meshes += 1;
    for (const m of mats) {
      if (!m) continue;
      rec.mats.add(m);
      if (m.transparent) rec.alpha += 1;
      // exhaustive texture sweep: any own value that IS a texture, plus
      // shader-style uniforms. Named-key lists missed everything MToon and
      // node materials carry (unoptimized textures are the real VRAM hit, so
      // the census must not have blind spots).
      const seen = (t) => { if (t?.isTexture && !rec.texs.has(t)) { rec.texs.add(t); rec.texBytes += texBytes(t); } };
      for (const v of Object.values(m)) seen(v);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) seen(u?.value);
    }
    if (g?.attributes) for (const a of Object.values(g.attributes)) rec.attrBytes += a.array?.byteLength ?? 0;
    if (o.isSkinnedMesh && o.skeleton) rec.bones = Math.max(rec.bones, o.skeleton.bones.length);
    if (g?.morphAttributes?.position) rec.morphs = Math.max(rec.morphs, g.morphAttributes.position.length);
    rec.meshList.push(o);
    meshOwner.set(o, rec.key);
    if (vis) visibleMeshes.push(o);
  });

  for (const rec of subjects.values()) {
    const tiers = {
      tris: tierOf(rec.tris, 'tris'), draws: tierOf(rec.draws, 'draws'),
      texMB: tierOf(rec.texBytes / 1e6, 'texMB'), bones: tierOf(rec.bones, 'bones'),
      mats: tierOf(rec.mats.size, 'mats'), alpha: tierOf(rec.alpha, 'alpha'),
    };
    rec.tiers = tiers;
    rec.rank = Math.max(...Object.values(tiers));
    rec.worst = Object.keys(tiers).find((k) => tiers[k] === rec.rank);
    rec.matCost = Math.max(0, ...[...rec.mats].map(matCost));
  }
  return subjects;
}

// ---- false-color modes ------------------------------------------------------

export const MODES = {
  off:      { label: 'off', tier: null },
  rank:     { label: 'overall rank (worst wins)', tier: (r) => r.rank },
  tris:     { label: 'triangles', tier: (r) => r.tiers.tris },
  draws:    { label: 'draw calls', tier: (r) => r.tiers.draws },
  tex:      { label: 'texture memory (est)', tier: (r) => r.tiers.texMB },
  mat:      { label: 'material cost (proxy)', tier: (r) => r.matCost },
  bones:    { label: 'skinning / bones', tier: (r) => r.tiers.bones },
  alpha:    { label: 'transparency', tier: (r) => r.tiers.alpha },
};

let mode = 'off';
// Tint is an OVERLAY, never a replacement: a 25% veil sharing the original's
// geometry plus an inverted-hull silhouette in the tier color, so the object's
// own textures stay readable and originals are never touched. The industry
// cost views (UE Shader Complexity, Unity/Godot Overdraw) are flat material
// OVERRIDES answering "where are the pixels dear?"; ours answers "WHAT is
// heavy?". `solid` flips to the conventional override (fabric included);
// overlay leaves the world fabric untinted and un-hulled — a hull on instanced
// grass would double the grass draw, a perf tool costing perf.
let solidOn = false;
export function setSolid(on) { solidOn = !!on; if (mode !== 'off') applyTint(); onSolidChange?.(); }
export const isSolid = () => solidOn;
let onSolidChange = null;
const solidMats = TIERS.map((c) => {
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.name = `perfscope-solid-${c}`;
  return m;
});
const VEIL_OPACITY = 0.25;
const tintMats = TIERS.map((c) => {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(c), transparent: true, opacity: VEIL_OPACITY,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  m.name = `perfscope-tint-${c}`;
  return m;
});
// Silhouette hull width is screen-constant: local displacement = K · distance
// to camera ÷ the object's world scale (a scale-3 cat and a scale-0.55 ruin get
// the same pixel edge). K≈2px at 720p/70°. The scale is read in-shader from the
// model matrix, so there are exactly TIERS×2 hull materials (thin / hot).
// Thin by default, THICK only on the subject the loupe is hovering or has
// pinned — the edge is a rank cue everywhere and a
// spotlight on the thing you're actually asking about.
const HULL_K = 0.0022, HULL_K_HOT = 0.0060;
const hullMats = new Map();
function hullMatFor(tier, k = HULL_K) {
  const key = `${tier}:${k}`;
  let m = hullMats.get(key);
  if (m) return m;
  m = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(TIERS[tier]), side: THREE.BackSide, toneMapped: false });
  const ws = modelScale.x.abs().add(modelScale.y.abs()).add(modelScale.z.abs()).div(3).max(1e-4);
  const w = cameraPosition.sub(positionWorld).length().mul(k).div(ws);
  m.positionNode = positionLocal.add(normalLocal.normalize().mul(w));
  m.name = `perfscope-hull-${tier}`;
  hullMats.set(key, m);
  return m;
}
const overlays = new Map();   // mesh -> { veil, hull, tier, key, geo, n, skel } — diffed each cycle, never rebuilt wholesale
const outlines = new Set();   // per-subject Box3Helpers
let outlinesOn = false;       // bounds boxes are opt-in ('a bit much' on by default)
const _box = new THREE.Box3();

let hotKey = null;
// an inverted hull over a transparent / cut-out / no-depth surface draws a
// solid shell where the object itself is see-through
function hullable(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.every((m) => !m || !(m.transparent || m.alphaTest > 0 || m.alphaHash || m.alphaToCoverage || m.depthWrite === false));
}
/** Thick hull on one subject (the loupe's hover/pin), thin on everything else. */
function setEmphasis(rec) {
  const next = rec?.key ?? null;
  if (next === hotKey) return;
  hotKey = next;
  for (const o of overlays.values()) {
    if (o.hull) o.hull.material = hullMatFor(o.tier, o.key === hotKey ? HULL_K_HOT : HULL_K);
  }
}
function overlayFor(mesh, mat, orderBump) {
  let ov = null;
  if (mesh.isSkinnedMesh) {
    ov = new THREE.SkinnedMesh(mesh.geometry, mat);
    ov.bindMode = mesh.bindMode;
    ov.bind(mesh.skeleton, mesh.bindMatrix);
    ov.frustumCulled = false;
  } else if (mesh.isInstancedMesh) {
    ov = new THREE.InstancedMesh(mesh.geometry, mat, mesh.count);
    ov.instanceMatrix = mesh.instanceMatrix;
  } else {
    ov = new THREE.Mesh(mesh.geometry, mat);
  }
  ov.userData.perfscopeIgnore = true;
  ov.renderOrder = (mesh.renderOrder || 0) + orderBump;
  ov.raycast = () => {};          // the loupe must hit the REAL mesh beneath
  mesh.add(ov);                   // rides the original's transform verbatim
  return ov;
}
function dropOverlay(mesh) {
  const o = overlays.get(mesh);
  if (!o) return;
  o.veil.parent?.remove(o.veil);
  o.hull?.parent?.remove(o.hull);
  overlays.delete(mesh);
}

function applyTint() {
  clearOutlines();                 // bounds boxes are cheap root helpers; rebuilt per cycle
  const keep = new Set();
  for (const rec of subjects.values()) {
    const t = Math.min(4, MODES[mode].tier?.(rec) ?? 0);
    const fabric = rec.kind === 'fabric';
    if (fabric && !solidOn) continue;               // overlay: the ground stays the ground
    const veilMat = solidOn ? solidMats[t] : tintMats[t];
    _box.makeEmpty();
    for (const mesh of rec.meshList) {
      if (!mesh.parent) continue;                    // churned out since collect
      keep.add(mesh);
      const wantHull = !fabric && hullable(mesh);    // never hull the meadow
      let o = overlays.get(mesh);
      // the overlay shares the original's geometry / instance buffer / skeleton
      // by reference at build time; a swap of any of them leaves a stale twin
      if (o && (!!o.hull !== wantHull || o.geo !== mesh.geometry || o.n !== mesh.count || o.skel !== mesh.skeleton)) { dropOverlay(mesh); o = null; }
      if (!o) {
        o = { veil: overlayFor(mesh, veilMat, 1), hull: null, tier: t, key: rec.key,
          geo: mesh.geometry, n: mesh.count, skel: mesh.skeleton };
        if (wantHull) o.hull = overlayFor(mesh, hullMatFor(t, rec.key === hotKey ? HULL_K_HOT : HULL_K), 0);
        overlays.set(mesh, o);
      } else {
        const migrated = o.key !== rec.key;
        o.key = rec.key;
        if (o.veil.material !== veilMat) o.veil.material = veilMat;
        // a mesh that migrated subjects may have gained or lost the hot edge
        if (o.hull && (o.tier !== t || migrated)) o.hull.material = hullMatFor(t, rec.key === hotKey ? HULL_K_HOT : HULL_K);
        o.tier = t;
      }
      _box.expandByObject(mesh);
    }
    if (outlinesOn && !_box.isEmpty()) {
      const o = new THREE.Box3Helper(_box.clone(), new THREE.Color(TIERS[t]));
      o.userData.perfscopeIgnore = true;
      o.userData.isDebug = true;                     // sky.js adopts unmarked root children
      outlines.add(o);
      scene.add(o);
    }
  }
  for (const mesh of [...overlays.keys()]) if (!keep.has(mesh) || !mesh.parent) dropOverlay(mesh);
}

function clearOutlines() {
  for (const o of outlines) { scene.remove(o); o.dispose?.(); }
  outlines.clear();
}
function clearTint() {
  for (const mesh of [...overlays.keys()]) dropOverlay(mesh);
  clearOutlines();
}

let timer = null, idleRelease = null;
// one census loop serves both the tint and the loupe: while either is on the
// scene is re-walked every 3 s (churn survival); tints are diffed only when a
// mode is active. Both off → timer cleared and the census dropped, so this
// module holds no references into a scene it isn't watching.
function syncCycle() {
  clearTimeout(timer); timer = null;
  clearTimeout(idleRelease); idleRelease = null;
  if (!loupeOn && mode === 'off') { forget(); paintTable(); return; }
  const cycle = () => {
    collect();
    if (mode !== 'off') applyTint();
    paintTable();
    refreshPinned();
    timer = setTimeout(cycle, 3000);
  };
  cycle();
}
export function setMode(next) {
  mode = next in MODES ? next : 'off';
  if (mode === 'off') clearTint();
  syncCycle();
  onModeChange?.();
}
export const activeMode = () => mode;
let onModeChange = null;

// ---- loupe ------------------------------------------------------------------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let loupeEl = null, loupeOn = false, pinned = null, pinnedHtml = '', lastCast = 0;

const fmtB = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
// short tier words for the chunky row pills
const TIER_SHORT = ['great', 'good', 'ok', 'poor', 'bad'];
const badge = (t, txt, chunky, title = '') => `<b class="ps-badge${chunky ? ' ps-badge-lg' : ''}" style="background:${TIERS[Math.min(4, t)]}"${title ? ` title="${esc(title)}"` : ''}>${txt}</b>`;

function loupeHtml(rec) {
  // biggest textures first as an inner table: dims (+ `raw` = uncompressed,
  // the usual VRAM crime — KTX2 costs ~4-8× less) against the seam, size after
  const texRows = [...rec.texs]
    .map((t) => ({ t, b: texBytes(t) }))
    .sort((a, b) => b.b - a.b).slice(0, 4)
    .map(({ t, b }) => `<div class="pl-texd">${t.image?.width ?? '?'}×${t.image?.height ?? '?'}${t.isCompressedTexture ? '' : ' <em title="uncompressed — sits in VRAM at full size; a compressed (KTX2) version costs ~4-8× less">raw</em>'}</div><div class="pl-texb">${fmtB(b)}</div>`)
    .join('');
  // "#2 of 17" under the active lens — mirrors paintTable's sort; with no
  // overlay active the ordering falls back to overall rank.
  const lensMode = mode === 'off' ? 'rank' : mode;
  // compact lens label for the tight header standing-line (the dropdown keeps
  // the fuller MODES labels with their (est)/(proxy) qualifiers).
  const lensLabel = { rank: 'overall', tris: 'triangles', draws: 'draw calls',
    tex: 'texture memory', mat: 'material cost', bones: 'bones',
    alpha: 'transparency' }[lensMode] ?? 'overall';
  const lensMetric = (r) => lensMode === 'rank' ? r.rank
    : lensMode === 'tris' ? r.tris : lensMode === 'draws' ? r.draws
    : lensMode === 'tex' ? r.texBytes : lensMode === 'mat' ? r.matCost
    : lensMode === 'bones' ? r.bones : lensMode === 'alpha' ? r.alpha : r.rank;
  const ordered = [...subjects.values()]
    .sort((a, b) => lensMode === 'rank'
      ? b.rank - a.rank || b.tris - a.tris
      : lensMetric(b) - lensMetric(a));
  const pos = ordered.indexOf(rec) + 1, total = ordered.length;
  const rankStr = total > 1 && pos > 0 ? `#${pos} of ${total}` : '';
  // channel-box grid: label | value | tier pill, aligned on two vertical rules
  const boundsTip = (label, key) => {
    const th = T[key]; if (!th) return '';
    const u = key === 'texMB' ? ' MB' : '';
    const parts = TIER_SHORT.map((name, i) =>
      i < th.length ? `${name} ≤${th[i].toLocaleString()}${u}` : `${name} >${th[th.length - 1].toLocaleString()}${u}`);
    // one tier per line: #tipchip renders titles pre-line (R, 09-04: easier to read)
    return `${label}\n${parts.join('\n')}`;
  };
  // what each metric IMPACTS (data labels should describe which part of
  // performance they affect). Hovering the label row shows this.
  const LABEL_TIP = {
    triangles: 'geometry the GPU rasterizes each frame; high counts tax vertex processing & fill',
    'draw calls': 'separate GPU submissions (≈1 per material/group); high counts are CPU-bound overhead — often the true bottleneck',
    materials: 'distinct material instances; more = more state changes & draw calls',
    textures: 'number of distinct texture images this subject references',
    'tex VRAM': 'estimated GPU memory the textures occupy (w·h·bpp ×1.33 mips); compressed textures use their real mip payloads',
    geometry: 'estimated CPU/GPU bytes of vertex attribute buffers (position, normal, uv…)',
    bones: 'skeleton size; every bone is a per-frame matrix the skinning shader applies',
    'morph targets': 'blend-shape channels; each adds vertex data & per-frame blending',
    instances: 'instanced copies drawn in one call — cheap multiplicity (good)',
    'transparent mats': 'alpha/transmission materials; cause overdraw & back-to-front sorting cost',
    meshes: 'mesh objects rolled into this subject',
  };
  const row = (label, val, tier, key) =>
    `<div class="pll" title="${esc(LABEL_TIP[label] || label)}">${label}</div><div class="plv">${val}</div>${
      tier == null ? '<div></div>' : `<div class="plp" title="${esc(boundsTip(label, key))}">${badge(tier, TIER_SHORT[Math.min(4, tier)], true)}</div>`}`;
  const rows = [
    row('triangles', rec.tris.toLocaleString(), rec.tiers.tris, 'tris'),
    row('draw calls', rec.draws, rec.tiers.draws, 'draws'),
    row('materials', rec.mats.size, rec.tiers.mats, 'mats'),
    row('textures', rec.texs.size, null),
    texRows ? `<div class="pl-texwrap">${texRows}</div>` : '',
    row('tex VRAM', fmtB(rec.texBytes), rec.tiers.texMB, 'texMB'),
    row('geometry', fmtB(rec.attrBytes), null),
    rec.bones ? row('bones', rec.bones, rec.tiers.bones, 'bones') : '',
    rec.morphs ? row('morph targets', rec.morphs, null) : '',
    rec.instances ? row('instances', rec.instances.toLocaleString(), null) : '',
    rec.alpha ? row('transparent mats', rec.alpha, rec.tiers.alpha, 'alpha') : '',
    row('meshes', rec.meshes, null),
  ].join('');
  // "why this rank" — the overall badge carries a hover explaining the rule
  // (worst category wins, VRChat model) and which metric set THIS rank.
  const worstLabel = { tris: 'triangles', draws: 'draw calls', texMB: 'texture VRAM',
    bones: 'bones', mats: 'materials', alpha: 'transparency' }[rec.worst] || rec.worst;
  const why = `overall = worst category wins (VRChat model)\nthis object's ${TIER_NAMES[rec.rank]} rank is set by ${worstLabel}\nfix the red/orange rows to raise it`;
  const lensTip = { rank: 'overall rank — worst category wins (VRChat model)',
    tris: 'triangle count — GPU vertex/geometry load', draws: 'draw calls — CPU→GPU submit overhead, often the real cost',
    tex: 'texture memory — estimated VRAM the images occupy', mat: 'material cost — a categorical shader-complexity proxy',
    bones: 'skinning — bone count driving per-frame skeletal transforms', alpha: 'transparency — overdraw & sort cost from alpha materials' }[lensMode] ?? '';
  // title = the entity id; the GLB basename is provenance, shown dim beneath.
  // <wbr> after separators / camelCase humps lets long identifiers wrap.
  const paren = rec.label.indexOf('  (');
  const nameOnly = paren > 0 ? rec.label.slice(0, paren) : rec.label;
  // keep the .glb/.gltf/.vrm: the second line is the FILE, and the extension is what says so (R, 09-04)
  const libOnly = paren > 0 ? rec.label.slice(paren + 3).replace(/\)$/, '') : '';
  const wbr = (t) => esc(t)
    .replace(/([_./:\-])/g, '$1<wbr>')          // break after separators
    .replace(/([a-z0-9])([A-Z])/g, '$1<wbr>$2'); // and at camelCase humps
  const nameHtml = wbr(nameOnly);
  const libHtml = libOnly ? `<span class="pl-lib" title="${esc(libOnly)}">${wbr(libOnly)}</span>` : '';
  // header: verdict stack (pill · lens · rank) is a right float and comes
  // first in the DOM so the name flows around it; 'placed by' is provenance,
  // not a perf fact, and lives in the inspector instead.
  return `
  <div class="pl-head">
    <div class="pl-verdict">
      <span title="${esc(why)}" class="pl-rank">${badge(rec.rank, TIER_NAMES[rec.rank], true, why)}</span>
      <div class="pl-verdictsub">
        <span class="pl-mode" title="${esc(lensTip)}">${lensLabel}</span>
        ${rankStr ? `<span class="pl-rankrow" title="this object's position among all ${total} subjects in the scene, ranked by the active lens">${rankStr}</span>` : ''}
      </div>
    </div>
    <b class="pl-name" title="${esc(nameOnly)}">${nameHtml}</b>${libHtml}
  </div>
  <div class="pl-grid">${rows}</div>
  <div class="pl-foot" title="${pinned ? 'click anywhere in the scene to unpin this card' : 'click an object to pin its card so you can hover its rows for detail'}">${pinned ? 'click elsewhere to unpin' : 'click to pin'}</div>`;
}

function castAt(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(visibleMeshes, false);
  for (const h of hits) {
    // the census is up to 3 s stale: a mesh whose chain no longer reaches the
    // scene (entity removed) or was hidden since must not answer a hover
    let root = h.object, shown = true;
    for (; root.parent; root = root.parent) if (!root.visible) shown = false;
    if (root !== scene || !shown || !root.visible) continue;
    let key = null;
    for (let p = h.object; p && !key; p = p.parent) key = meshOwner.get(p) ?? null;
    if (key) return subjects.get(key);
  }
  return null;
}

// The title is clipped at 2 lines by max-height + clip-path (the
// float-wrapped header can't use -webkit-box line-clamp — any BFC-maker stops
// lines flowing around the floats), so the '…' truncation cue is drawn by hand:
// measure the last VISIBLE line's end via Range rects and pin an absolutely-
// positioned ellipsis there (absolute = out of flow, can't disturb the wrap).
// Skipped entirely when the whole name fits.
function dressLoupeName() {
  const nm = loupeEl.querySelector('.pl-name');
  if (!nm || nm.scrollHeight <= nm.clientHeight + 1) return;
  const rng = document.createRange(); rng.selectNodeContents(nm);
  const nb = nm.getBoundingClientRect();
  let last = null;
  for (const r of rng.getClientRects()) {
    if (r.width <= 0) continue;
    if (r.bottom - nb.top > nm.clientHeight + 1) continue;   // a clipped line
    if (!last || r.bottom > last.bottom + 2 ||
        (Math.abs(r.bottom - last.bottom) <= 2 && r.right > last.right)) last = r;
  }
  if (!last) return;
  const e = document.createElement('i');
  e.className = 'pl-ell'; e.textContent = '…';
  e.style.left = `${Math.round(last.right - nb.left) + 1}px`;
  e.style.top = `${Math.round(last.top - nb.top)}px`;
  nm.appendChild(e);
}

function onMove(ev) {
  if (!loupeOn || pinned) return;
  const now = performance.now();
  if (now - lastCast < 90) return;
  lastCast = now;
  const rec = castAt(ev);
  setEmphasis(rec);
  if (!rec) { loupeEl.classList.remove('show'); return; }
  loupeEl.innerHTML = loupeHtml(rec);
  dressLoupeName();
  placeLoupe(ev);
  loupeEl.classList.add('show');
}

function placeLoupe(ev) {
  const w = loupeEl.offsetWidth, h = loupeEl.offsetHeight;
  let x = ev.clientX + 16, y = ev.clientY + 16;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 16;
  if (y + h > innerHeight - 8) y = innerHeight - h - 8;
  loupeEl.style.left = `${Math.max(4, x)}px`;
  loupeEl.style.top = `${Math.max(4, y)}px`;
}

// collect() rebuilds every record, so a pinned card holds a dead one: repoint
// it at the fresh record, or drop the pin if the subject left the scene
function refreshPinned() {
  if (!pinned) return;
  const rec = subjects.get(pinned.key);
  if (rec) {
    pinned = rec; setEmphasis(rec);
    // a re-render kills the tooltip being read; never swap under the pointer
    if (loupeEl.matches(':hover')) return;
    const html = loupeHtml(rec);
    if (html !== pinnedHtml) { pinnedHtml = html; loupeEl.innerHTML = html; dressLoupeName(); }
  }
  else { pinned = null; setEmphasis(null); loupeEl.classList.remove('show', 'pinned'); }
}

function onClick(ev) {
  if (!loupeOn) return;
  if (pinned) { pinned = null; setEmphasis(null); loupeEl.classList.remove('show', 'pinned'); return; }
  const rec = castAt(ev);
  if (rec) {
    pinned = rec; setEmphasis(rec); pinnedHtml = loupeHtml(rec); loupeEl.innerHTML = pinnedHtml; dressLoupeName(); placeLoupe(ev);
    // pinned → make the card hoverable so every `title` tooltip fires.
    // Unpinned it stays pointer-events:none so it follows the cursor and
    // the raycast reaches the scene beneath it.
    loupeEl.classList.add('show', 'pinned');
  }
}

export function setLoupe(onOff) {
  loupeOn = !!onOff;
  pinned = null;
  setEmphasis(null);
  if (!loupeEl) {
    loupeEl = document.createElement('div');
    loupeEl.className = 'perf-loupe';
    document.body.appendChild(loupeEl);
  }
  document.body.classList.toggle('loupe-on', loupeOn);  // the loupe cursor (ui.js bakes it)
  if (loupeOn) {
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('click', onClick);
  } else {
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('click', onClick);
    loupeEl.classList.remove('show', 'pinned');
  }
  syncCycle();
  onLoupeChange?.(loupeOn);
}
let onLoupeChange = null;

// ---- heaviest table + receipt ----------------------------------------------

let tableEl = null;

// mode 'off' orders by overall rank — the same fallback the loupe card uses
const lensOf = () => (mode === 'off' ? 'rank' : mode);
const metricOf = (r, lens) => lens === 'tex' ? r.texBytes : lens === 'draws' ? r.draws
  : lens === 'bones' ? r.bones : lens === 'mat' ? r.matCost
  : lens === 'alpha' ? r.alpha : r.tris;
const metricFmt = (r, lens) => lens === 'tex' ? fmtB(r.texBytes) : lens === 'draws' ? `${r.draws} dc`
  : lens === 'bones' ? `${r.bones} bones` : lens === 'alpha' ? `${r.alpha} α`
  : `${(r.tris / 1000).toFixed(r.tris > 9999 ? 0 : 1)}k tri`;

function paintTable() {
  if (!tableEl) return;
  const lens = lensOf();
  const rows = [...subjects.values()]
    .sort((a, b) => (lens === 'rank' ? b.rank - a.rank || b.tris - a.tris : metricOf(b, lens) - metricOf(a, lens)))
    .slice(0, 6);
  tableEl.innerHTML = rows.map((r) =>
    `<div class="ps-row" data-key="${esc(r.key)}">
       <i style="background:${TIERS[MODES[lens].tier?.(r) ?? r.rank]}"></i>
       <span>${esc(r.label)}</span><em>${metricFmt(r, lens)}</em>
     </div>`).join('') || '<div class="ps-row"><span>nothing collected yet</span></div>';
}

// a one-shot census taken while nothing is watching must not outlive its use —
// but the table it just painted should stay readable for a while
function releaseIfIdle() {
  clearTimeout(idleRelease);
  idleRelease = setTimeout(() => {
    idleRelease = null;
    if (!loupeOn && mode === 'off') { forget(); paintTable(); }
  }, 30_000);
}

function flashSubject(key) {
  const rec = subjects.get(key);
  const target = rec?.meshList[0];
  if (!target) return;
  const box = new THREE.BoxHelper(rec.kind === 'entity' ? entities.get(key.slice(2)) ?? target : target, 0xffffff);
  box.userData.perfscopeIgnore = true;
  box.userData.isDebug = true;      // sky.js adopts unmarked root children
  scene.add(box);
  setTimeout(() => { scene.remove(box); box.dispose?.(); }, 1800);
}

async function copyReceipt() {
  if (!subjects.size) collect();
  let gpu = 'unknown';
  try {
    const gl = renderer.getContext?.();
    const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
    if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    else if (renderer.backend?.adapter?.info) {
      const i = renderer.backend.adapter.info;
      gpu = `${i.vendor ?? ''} ${i.architecture ?? ''} ${i.device ?? ''}`.trim() || 'webgpu';
    }
  } catch { /* identity stays unknown; the receipt says so honestly */ }
  const info = renderer.info;
  const receipt = {
    kind: 'perfscope-receipt', v: 1, at: new Date().toISOString(),
    page: location.origin + location.pathname,   // never the query: it carries the join key
    ua: navigator.userAgent, gpu,
    measured: { calls: info?.render?.calls, triangles: info?.render?.triangles,
      geometries: info?.memory?.geometries, textures: info?.memory?.textures },
    estimated: true, thresholds: T,
    subjects: [...subjects.values()]
      .sort((a, b) => b.rank - a.rank || b.tris - a.tris).slice(0, 20)
      .map((r) => ({ label: r.label, kind: r.kind, rank: TIER_NAMES[r.rank], worst: r.worst,
        tris: r.tris, draws: r.draws, mats: r.mats.size, texMB: +(r.texBytes / 1e6).toFixed(1),
        bones: r.bones, meshes: r.meshes, instances: r.instances,
        topTex: [...r.texs].map((t) => ({ b: texBytes(t), w: t.image?.width, h: t.image?.height, raw: !t.isCompressedTexture }))
          .sort((a, b) => b.b - a.b).slice(0, 3)
          .map((x) => `${x.w}x${x.h}${x.raw ? ' raw' : ''} ${(x.b / 1e6).toFixed(1)}MB`) })),
  };
  const text = JSON.stringify(receipt, null, 1);
  try { await navigator.clipboard.writeText(text); } catch { console.log(text); }
  const n = receipt.subjects.length;
  releaseIfIdle();
  return n;
}

// ---- panel section ----------------------------------------------------------

/** Mounts the perf section into the debug panel's stack. */
export function buildPerfPanel(stack, { toast = console.log } = {}) {
  // house rows only (R, 09-04: "stop making people guess"): .row.wide = label
  // column + control, the same grid Video uses; no private layout rules here.
  const modeRow = document.createElement('div');
  modeRow.className = 'row wide';
  const lbl = document.createElement('span');
  lbl.className = 'nm'; lbl.textContent = 'overlay';
  const sel = document.createElement('select');
  sel.dataset.mode = '1';   // a persistent mode: the skinned trigger outlines in accent while it isn't 'off' (dropdown.js paint)
  for (const [k, m] of Object.entries(MODES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = m.label;
    sel.appendChild(o);
  }
  sel.value = mode;                         // the section builds lazily — read the live mode, don't assume 'off'
  sel.onchange = () => setMode(sel.value);
  onModeChange = () => { sel.value = mode; };
  const selCtl = document.createElement('span'); selCtl.className = 'ctl'; selCtl.appendChild(sel);
  modeRow.append(lbl, selCtl);

  // the loupe is a plain house button (button.on draws its armed state) and
  // lives with rescan/copy in the button row below — no private tool styling
  const lb = document.createElement('button');
  lb.classList.add('mode');   // a persistent mode: its `on` paints in accent (index.html button.mode.on), not the hover grey
  lb.title = 'loupe — hover an object for its cost card; click pins';
  lb.innerHTML = `${fsvg('magnifying-glass', 13)} loupe`;
  lb.onclick = () => setLoupe(!loupeOn);
  lb.classList.toggle('on', loupeOn);       // lazily built: reflect the live state
  onLoupeChange = (on) => lb.classList.toggle('on', on);

  const checkRow = (text, checked, title, onchange) => {
    const row = document.createElement('label');
    row.className = 'row wide';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = text;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked; if (title) cb.title = title;
    cb.onchange = () => onchange(cb);
    row.append(nm, cb);
    return { row, cb };
  };
  const { row: olRow } = checkRow('bounds outlines', outlinesOn, '', (cb) => { outlinesOn = cb.checked; if (mode !== 'off') applyTint(); });
  const { row: solRow, cb: solCb } = checkRow('solid colors', solidOn,
    'the conventional cost view (UE/Unity/Godot): flat tier color replaces textures, ground and sky included',
    (cb) => setSolid(cb.checked));
  onSolidChange = () => { solCb.checked = solidOn; };

  const legend = document.createElement('div');
  legend.className = 'ps-legend';
  legend.title = 'viewer-local: nothing here is sent to the world or written to the log';
  legend.innerHTML = TIERS.map((c, i) => `<i style="background:${c}" title="${TIER_NAMES[i]}"></i>`).join('')
    + '<span>cheap → costly · fixed thresholds</span>';

  tableEl = document.createElement('div');
  tableEl.className = 'ps-table';
  tableEl.onclick = (e) => {
    const k = e.target.closest('.ps-row')?.dataset.key;
    if (k) flashSubject(k);
  };

  const btns = document.createElement('div');
  btns.className = 'row btn-row';
  const rescan = document.createElement('button');
  rescan.textContent = 'rescan';
  rescan.onclick = () => { collect(); if (mode !== 'off') applyTint(); paintTable(); refreshPinned(); toast(`perfscope: rescanned (${subjects.size} subjects)`); releaseIfIdle(); };
  const rcpt = document.createElement('button');
  rcpt.textContent = 'copy receipt';
  rcpt.onclick = async () => toast(`perfscope: receipt copied (${await copyReceipt()} subjects)`);
  btns.append(rescan, rcpt);

  // the loupe is the tool; it sits under the overlay lens, not among the
  // housekeeping buttons (R, 09-04)
  const loupeRow = document.createElement('div'); loupeRow.className = 'row btn-row'; loupeRow.appendChild(lb);
  stack.append(modeRow, loupeRow, olRow, solRow, legend, tableEl, btns);
}

/** Full teardown: overlays removed (originals were never touched), loupe
 *  listeners dropped, the census timer stopped and its references released. */
export function perfscopeOff() {
  setMode('off');
  setLoupe(false);
}

/** Mount the panel into a debug stack. Idempotent per stack: a plain mount
 *  upgrades in place when a collapsible `section(parent, title, build)` is
 *  offered later; a section mount is never duplicated. */
export function mountPerfPanel(stack, { toast = console.log, section = null } = {}) {
  const cur = stack.__perfMount;
  if (cur?.kind === 'section') return;
  if (section) {
    cur?.el?.remove();
    const box = section(stack, 'performance', (body) => buildPerfPanel(body, { toast })) ?? stack.lastElementChild;
    stack.__perfMount = { kind: 'section', el: box };
    return;
  }
  if (cur) return;
  const el = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'row'; head.style.cssText = 'margin-top:10px;opacity:.75';
  head.textContent = '— perf (viewer-local) —';
  const body = document.createElement('div');
  el.append(head, body); stack.appendChild(el);
  buildPerfPanel(body, { toast });
  stack.__perfMount = { kind: 'plain', el };
}
