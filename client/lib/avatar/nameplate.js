// nameplate — a body's name pill, speech bubble and typing pill: drawn, hung from the body, sized for each viewer;
// one per Avatar (avatar.js), run last in its update().

import { THREE, camera } from '../core.js';
import { bus } from '../base.js';
import { stroke as strokeIcon } from '../ui/icons.js';
import { plateSize, plateClear, ownClearance, reachAbove, plateBox, CLEAR_MIN, PLATE_W } from './platesize.js';
import { revealLevel } from './namereveal.js';
import { crownEstimate, plateGap, plateAnchor, plateOffset, plateViewLift, STAND_SLOTS, DEAD as PLATE_DEAD } from './plateanchor.js';
import { plateLift } from '../../../shared/bodyscale.js';
import { Fn, userData, positionView, cameraNear, cameraFar, min, viewZToPerspectiveDepth, viewZToReversedPerspectiveDepth,
  viewZToOrthographicDepth } from 'three/tsl';

// ---------------------------------------------------------------- sprites

// Own-body clearance: labels are hidden by scenery and other avatars, never by their owner's body. Body-attached
// sprites are depth-tested but write their depth as if `userData.plateClear` metres nearer the eye (platesize.js).
// One node graph reads the per-object value, so every such sprite shares one pipeline. Alternatives rejected:
// docs/research/avatar-design-notes.md.
const PLATE_DEPTH = Fn((builder) => {
  const z = min(positionView.z.add(userData('plateClear', 'float')), cameraNear.negate().mul(1.0001));   // never past the near plane
  if (!builder.camera?.isPerspectiveCamera) return viewZToOrthographicDepth(z, cameraNear, cameraFar);
  return builder.renderer?.reversedDepthBuffer ? viewZToReversedPerspectiveDepth(z, cameraNear, cameraFar)
    : viewZToPerspectiveDepth(z, cameraNear, cameraFar);
})();
/** A body-attached sprite material: depth-tested against the world, cleared of its own body (see above). */
function clearedSpriteMaterial(map) {
  const mat = new THREE.SpriteNodeMaterial({ map, transparent: true, depthTest: true, depthWrite: false });
  mat.depthNode = PLATE_DEPTH;
  return mat;
}

// clear: true = a body-attached sprite (depth-tested, own body cleared); false = drawn over everything (speech bubbles)
function textSprite(draw, w, h, scaleW, clear = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = clear ? clearedSpriteMaterial(tex) : new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  if (clear) s.userData.plateClear = CLEAR_MIN;
  s.scale.set(scaleW, scaleW * h / w, 1);
  s.renderOrder = 99;
  return s;
}
const disposeSprite = (s) => { s.material.map?.dispose(); s.material.dispose(); };
// a token read at paint time — canvas sprites cannot use var(); a 'style' event repaints them
const tokv = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n) || fb).trim();
// every live body's plate, so a Style change can repaint the sprites it baked from tokens
const liveAvatars = new Set();
bus.on('style', () => { for (const a of liveAvatars) a.repaintLabel?.(); });

// the name's font, and the glyphs that set every plate's height (platesize.js plateBox says why)
const LABEL_FONT = '600 40px system-ui, "Segoe UI", sans-serif', LABEL_REF = 'Hdlgjpqy';
const labelFont = (ctx) => { ctx.font = LABEL_FONT; try { ctx.letterSpacing = '1.5px'; } catch {} };
let _labelCtx = null;
const makeLabel = (name) => {
  const text = name.slice(0, 24);
  const m = (_labelCtx ??= document.createElement('canvas').getContext('2d'));
  labelFont(m);
  const ink = m.measureText(text), ref = m.measureText(LABEL_REF);
  const box = plateBox({ asc: ink.actualBoundingBoxAscent, desc: ink.actualBoundingBoxDescent, width: ink.width },
    { asc: ref.actualBoundingBoxAscent, desc: ref.actualBoundingBoxDescent });
  const s = textSprite((ctx) => {
  labelFont(ctx);
  ctx.textAlign = 'center';
  ctx.fillStyle = tokv('--pill-bg', 'rgba(6,16,22,0.62)');
  ctx.beginPath(); ctx.roundRect((box.w - box.pillW) / 2, box.top, box.pillW, box.pillH, box.pillH / 2); ctx.fill();   // pill
  ctx.fillStyle = tokv('--pill-name', '#8fe8c8');
  ctx.fillText(text, box.w / 2, box.baseline);
  }, box.w, box.h, PLATE_W, true);
  s.userData.aspect = box.h / box.w;   // the sprite's height per metre of width: update() sizes it by width each frame
  s.userData.pillH = box.pillH / box.w;   // the pill's height, as a share of the sprite's width (the hover card's box)
  s.userData.pill = box.pillW / box.w;   // the pill's share of the sprite's width: the hover card sits beside IT
  // whether the viewer can see it, for the hover card (platecard.js): a GPU occlusion query, a frame or two old
  s.occlusionTest = true;
  s.onBeforeRender = noteOccluded;
  return s;
};
function noteOccluded(r) { this.userData.occluded = r.isOccluded(this); }

// what hangs over the plate (metres above it): the bubble, the typing pill, the pill over a bubble
const BUBBLE_LIFT = 0.35, TYPING_LIFT = 0.17, TYPING_OVER_BUBBLE = 0.77;
const _pHips = new THREE.Vector3(), _pHead = new THREE.Vector3(), _pFoot = new THREE.Vector3(), _pScale = new THREE.Vector3();
const _ownM = new THREE.Matrix4();
const _pArgs = { hips: [0, 0, 0], head: [0, 0, 0], feetY: 0, rest: null, s: 1, gap: 0, lift: 0 }, _pOut = { p: [0, 0, 0], lie: 0 };
const FEET = ['leftFoot', 'rightFoot'];
const _pSmooth = { dead: PLATE_DEAD };
const _pRest = new THREE.Vector3(), _pTarget = { standing: false, standY: 0, liveY: 0 };
const plateBone = (h, n) => h?.getRawBoneNode?.(n) ?? h?.getNormalizedBoneNode?.(n) ?? null;
const _pRoot = new THREE.Vector3();
const _lvP = new THREE.Vector3(), _lvE = new THREE.Vector3(), _lvU = new THREE.Vector3(), _lvF = new THREE.Vector3(), _lvQ = new THREE.Quaternion();
const _lvArgs = { eye: [0, 0, 0], up: [0, 0, 0], fwd: [0, 0, 0], plate: [0, 0, 0], drop: 0, headR: 0, halfH: 0 };

function wrap(text, n) {
  const words = String(text).split(/\s+/);
  const lines = ['']; let cur = 0;
  for (const w of words) {
    if ((lines[cur] + ' ' + w).trim().length > n) { lines.push(w); cur++; }
    else lines[cur] = (lines[cur] + ' ' + w).trim();
  }
  return lines;
}
const BUBBLE_LINES = 8;   // a long say shows an opening and points at the chat log
function makeBubble(text) {
  const all = wrap(text, 38);
  const clipped = all.length > BUBBLE_LINES;
  const lines = clipped ? all.slice(0, BUBBLE_LINES) : all;
  if (clipped) lines.push('▾ more in chat');
  const h = 30 + lines.length * 34;
  return textSprite((ctx) => {
    ctx.font = '27px system-ui, "Segoe UI", sans-serif';
    // the box hugs the widest wrapped line; 700 is the ceiling
    const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = Math.min(700, Math.ceil(wMax) + 44);
    ctx.fillStyle = tokv('--pill-bg', 'rgba(8,20,28,0.86)');
    ctx.strokeStyle = tokv('--pill-edge', 'rgba(143,232,200,0.25)');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect((704 - w) / 2, 2, w, h - 4, 16); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      ctx.fillStyle = clipped && i === lines.length - 1 ? tokv('--pill-dim', '#8ba39c') : tokv('--pill-fg', '#e8f4ef');
      ctx.fillText(l, 352, 38 + i * 34);
    });
  }, 704, Math.max(64, h), 2.4);
}

// ---- typing indicator: a pill of pulsing dots above the head, redrawn at a throttled rate while composing
function makeTypingSprite() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 56;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(clearedSpriteMaterial(tex));   // body-attached: hidden by walls, never by its own head
  s.userData.plateClear = CLEAR_MIN;
  s.scale.set(0.5, 0.5 * 56 / 128, 1);
  s.renderOrder = 99;
  s.userData.ctx = c.getContext('2d');
  return s;
}
// attention glyphs (icons.js, never emoji): ear = your speech reaches it; think = composing a reply; tool =
// mid-task; mic = this body's voice is live now
const ICON_FOR = { ear: 'ear', think: 'think', tool: 'wrench', mic: 'mic' };

function drawTypingDots(sprite, t, state) {
  const ctx = sprite.userData.ctx;
  ctx.clearRect(0, 0, 128, 56);
  ctx.fillStyle = 'rgba(8,20,28,0.82)';
  ctx.strokeStyle = 'rgba(143,232,200,0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(28, 12, 72, 32, 16); ctx.fill(); ctx.stroke();
  if (ICON_FOR[state]) {
    const b = 0.75 + 0.25 * Math.sin(t * 3);      // gentle breathing, not a strobe
    ctx.save();
    ctx.translate(64, 28);
    ctx.globalAlpha = b;
    ctx.strokeStyle = 'rgba(180,240,216,1)';
    strokeIcon(ctx, ICON_FOR[state], 26);
    if (state === 'mic') {   // sound arcs: the voice is live now
      for (let i = 0; i < 2; i++) {
        const amp = 0.3 + 0.7 * Math.max(0, Math.sin(t * 5 - i * 0.7));
        ctx.globalAlpha = b * amp;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(2, 0, 15 + i * 5, -0.7, 0.7); ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  } else {
    for (let i = 0; i < 3; i++) {
      const b = 0.32 + 0.68 * Math.max(0, Math.sin(t * 5 - i * 0.85));
      ctx.globalAlpha = b; ctx.fillStyle = tokv('--pill-dot', 'rgb(180,240,216)');
      ctx.beginPath(); ctx.arc(48 + i * 16, 28, 5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  sprite.material.map.needsUpdate = true;
}
const _plateEye = new THREE.Vector3();   // nameplate fade: the camera's world position

/** One body's nameplate, bubble and typing pill. `a` is the Avatar that owns them (a piece never imports its owner). */
export class Nameplate {
  constructor(a) {
    this.a = a;
    this.bubble = null;
    this.bubbleUntil = 0;
    this.typing = null;            // lazily-built dots sprite
    this._typingUntil = 0;         // typing signals repeat ~2.5s and expire ~4s
    this._typingDrawAt = 0;
    this.label = makeLabel(this.a.id);
    this.label.position.y = 1.95;   // until the first frame hangs it from the body (_placePlate)
    this.a.root.add(this.label);
    this._plateRest = this._measurePlateRest();   // the crown, once, while the body is still at rest
    this._plateOff = null;                        // smoothed plate height above the root (world m) — see _placePlate
    liveAvatars.add(this);
  }

  /** Per frame, last (avatar.js update says why). */
  update(dt, now) {
    // ---- nameplate: sized and faded by distance (platesize.js), depth-tested but cleared of its own body (PLATE_DEPTH);
    // while names are held (namereveal.js) it comes through everything
    const d = this.a.root.position.distanceTo(camera.getWorldPosition(_plateEye));   // WORLD: in XR camera.position is rig-local
    const rk = revealLevel();
    const { lw, vis } = plateSize(d, rk);
    this._placePlate(dt);   // hang it from the body first: the clearance below is measured from where it hangs
    if (this._ownClear == null) this._ownClear = this._measureOwnClear();
    this.label.userData.plateClear = plateClear(this._ownClear, d, rk);
    this.label.material.opacity = vis;
    const ownHidden = this.a.ownPlateHidden;
    this.label.visible = vis > 0.02 && !ownHidden;
    this.label.scale.set(lw, lw * (this.label.userData.aspect ?? 64 / 512), 1);   // scale carries the aspect: the text keeps its size whatever the canvas height
    this._liftPlateForView(camera);   // after the size (the lift clears the pill as drawn), before what hangs off the plate

    if (this.bubble) {
      if (now > this.bubbleUntil) {
        this.a.root.remove(this.bubble); disposeSprite(this.bubble); this.bubble = null;
      } else {
        this.bubble.position.copy(this.label.position).y += BUBBLE_LIFT;   // follows the plate down when they sit or lie
        this.bubble.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
        this.bubble.visible = !ownHidden;
      }
    }

    // ---- typing dots: a composing pill hides behind a bubble; a live mic stacks above it instead
    const micLive = this._typingState === 'mic';
    const typingNow = now < this._typingUntil && (micLive || !this.bubble);
    if (typingNow && !this.typing) { this.typing = makeTypingSprite(); this.a.root.add(this.typing); }
    if (this.typing) this.typing.position.copy(this.label.position).y += (micLive && this.bubble) ? TYPING_OVER_BUBBLE : TYPING_LIFT;
    // the pill sits above the plate's anchor: its own reach is the plate's plus the lift (triangle inequality); not revealed
    if (this.typing) this.typing.userData.plateClear = this._ownClear + Math.abs(this.typing.position.y - this.label.position.y);
    if (this.typing) {
      this.typing.visible = typingNow && !ownHidden;
      if (typingNow) {
        if (now - this._typingDrawAt > 110) {
          this._typingDrawAt = now;
          drawTypingDots(this.typing, now / 1000, this._typingState);
          if (globalThis.__pillDebug) globalThis.__pillLast = { id: this.a.id, state: this._typingState, t: now };
        }
        this.typing.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
      }
    }
  }

  /** The avatar's dispose(): off the Style repaint list, every sprite freed. */
  dispose() {
    liveAvatars.delete(this);
    if (this.bubble) disposeSprite(this.bubble);
    if (this.typing) disposeSprite(this.typing);
    disposeSprite(this.label);
  }

  /** Rename the body: the nameplate is redrawn, nothing else is touched. */
  setName(name) {
    this.a.id = name;
    this._labelName = name;
    this.repaintLabel();
  }
  /** The crown, measured once while the body is at rest (the constructor): plateanchor.js crownEstimate over the
   *  head/hips/eye bones and the skinned mesh top (≤4000 vertices a mesh), in the VRM scene's own frame so a live
   *  resize multiplies in per frame. null = nothing to measure. */
  _measurePlateRest() {
    try {
      const sc = this.a.vrm?.scene, h = this.a.vrm?.humanoid;
      if (!sc) return null;
      this.a.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(sc.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
      const yOf = (n) => { const b = h?.getRawBoneNode?.(n) ?? h?.getNormalizedBoneNode?.(n);
        return b ? b.getWorldPosition(v).applyMatrix4(inv).y : null; };
      const hips = yOf('hips'), head = yOf('head'), le = yOf('leftEye'), re = yOf('rightEye');
      const eye = le != null && re != null ? (le + re) / 2 : (le ?? re);
      const lf = yOf('leftFoot'), rf = yOf('rightFoot');
      const feet = lf != null || rf != null ? Math.min(lf ?? Infinity, rf ?? Infinity) : 0;
      let top = -Infinity;
      sc.traverse((o) => {
        const pos = o.isMesh && o.visible !== false ? o.geometry?.attributes?.position : null;
        if (!pos) return;
        m.multiplyMatrices(inv, o.matrixWorld);
        const step = Math.max(1, Math.ceil(pos.count / 4000));
        for (let i = 0; i < pos.count; i += step) {
          o.getVertexPosition(i, v);   // skinned + morphed, in the mesh's own space
          v.applyMatrix4(m);
          if (v.y > top) top = v.y;
        }
      });
      const boundsTop = Number.isFinite(top) ? top : null;
      const c = crownEstimate({ hips, head, eye, boundsTop });
      const crown = c?.crown ?? boundsTop;
      return { ...(c ?? {}), boundsTop, eye, feet, restHeadAboveFeet: head != null ? head - feet : null,
        height: crown != null ? crown - feet : null };
    } catch { return null; }
  }

  /** Hang the plate from the body this frame (plateanchor.js): X/Z over the live hips (the head, when lying), Y from
   *  the rest crown, chased on its height above the root so moving the whole body never makes it trail. Standing, Y
   *  is the rest crown over the root, so a jump clip's hips don't move it. Worked in world, written into the root's
   *  frame. A body with no hips/head hangs it over its rest mesh top; with nothing at all, at a fixed 1.95. */
  _placePlate(dt) {
    const r = this._plateRest, sc = this.a.vrm?.scene, h = this.a.vrm?.humanoid;
    if (!sc || !r || (r.hipsToCrown == null && r.boundsTop == null)) { this.label.position.set(0, 1.95, 0); this._plateDrop = null; return; }
    this.a.root.updateWorldMatrix(true, false);
    const s = sc.getWorldScale(_pScale).y || 1;   // model units → world (root scale × puppet scale)
    const gap = plateGap((r.height ?? 1.7) * s);
    const lift = plateLift(this.a.plateY, s);   // the wearer's own lift over the crown (Profile › Avatar), grows with the body
    this._plateDrop = gap + lift;   // plate → crown, and the head under it as a ball (_liftPlateForView)
    this._plateHeadR = r.headSpan != null ? r.headSpan * s / 2 : 0.1;
    const rootY = this.a.root.getWorldPosition(_pRoot).y;
    const hipsN = r.hipsToCrown != null ? plateBone(h, 'hips') : null, headN = hipsN ? plateBone(h, 'head') : null;
    let x, y, z;
    if (hipsN && headN) {
      // per body, per frame: the arguments and the answer are module scratch
      const a = _pArgs;
      hipsN.getWorldPosition(_pHips).toArray(a.hips); headN.getWorldPosition(_pHead).toArray(a.head);
      let feetY = Infinity;
      for (let i = 0; i < 2; i++) { const f = plateBone(h, FEET[i]); if (f) feetY = Math.min(feetY, f.getWorldPosition(_pFoot).y); }
      a.feetY = Number.isFinite(feetY) ? feetY : rootY; a.rest = r; a.s = s; a.gap = gap; a.lift = lift;
      const { p, lie } = plateAnchor(a, _pOut);
      x = p[0]; y = p[1]; z = p[2];
      this._plateLie = lie;
    } else {
      _pHips.set(0, r.boundsTop, 0); sc.localToWorld(_pHips);
      x = _pHips.x; y = _pHips.y + gap + lift; z = _pHips.z;
      this._plateLie = 0;
    }
    const standing = hipsN && headN && r.crown != null && this._plateStanding();
    let standY = 0;
    if (standing) {
      x = _pArgs.hips[0]; z = _pArgs.hips[2]; this._plateLie = 0;
      _pRest.set(0, r.crown, 0); sc.localToWorld(_pRest);
      standY = _pRest.y + gap + lift - rootY;
    }
    _pTarget.standing = !!standing; _pTarget.standY = standY; _pTarget.liveY = y - rootY;
    this._plateOff = plateOffset(this._plateOff, _pTarget, dt, _pSmooth);
    this.label.position.copy(this.a.root.worldToLocal(_pHips.set(x, rootY + this._plateOff, z)));
  }

  /** Upright in ordinary motion (plateanchor.js STAND_SLOTS) with nothing else owning the body. */
  _plateStanding() { return STAND_SLOTS.has(this.a.postureSlot) && !this.a.onceAnim && !this.a._override && !this.a._limp; }

  /** Slide the hung plate off the head for this viewer's camera (plateanchor.js plateViewLift), along the camera's
   *  up. After _placePlate and this frame's size; the pill and the bubble copy the plate after it. */
  _liftPlateForView(camera) {
    if (this._plateDrop == null) return;
    const lab = this.label, a = _lvArgs;
    this.a.root.updateWorldMatrix(true, false);
    this.a.root.localToWorld(_lvP.copy(lab.position));
    camera.getWorldPosition(_lvE); camera.getWorldQuaternion(_lvQ);
    _lvU.set(0, 1, 0).applyQuaternion(_lvQ); _lvF.set(0, 0, -1).applyQuaternion(_lvQ);
    _lvE.toArray(a.eye); _lvU.toArray(a.up); _lvF.toArray(a.fwd); _lvP.toArray(a.plate);
    a.drop = this._plateDrop; a.headR = this._plateHeadR ?? 0.1;
    a.halfH = lab.scale.x * this.a.root.getWorldScale(_pScale).y * (lab.userData.pillH ?? 52 / 512) / 2;   // the pill as drawn, world m
    const d = plateViewLift(a);
    if (d > 0) lab.position.copy(this.a.root.worldToLocal(_lvP.addScaledVector(_lvU, d)));
  }

  /** How far this body reaches from its plate's anchor: the clearance its sprites write (platesize.js ownClearance).
   *  The body is sampled once into the VRM scene's frame; a size or fit change only re-projects the sample. A body
   *  with nothing measurable clears a head (CLEAR_MIN). */
  _measureOwnClear() {
    try {
      const sceneRoot = this.a.vrm?.scene;
      if (!sceneRoot) return ownClearance(0);
      this.a.root.updateMatrixWorld(true);
      const pts = this._ownPts ??= this._sampleOwnBody(sceneRoot);
      const out = this._ownXyz ??= new Float32Array(pts.length);
      const e = _ownM.copy(this.a.root.matrixWorld).invert().multiply(sceneRoot.matrixWorld).elements;
      const ax = this.label.position.x, az = this.label.position.z;
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2];
        out[i] = e[0] * x + e[4] * y + e[8] * z + e[12] - ax;   // relative to the plate's own column (it hangs over the hips, not the root)
        out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14] - az;
      }
      return ownClearance(reachAbove(out, this.label.position.y));
    } catch { return ownClearance(0); }
  }
  _sampleOwnBody(sceneRoot) {
    const inv = new THREE.Matrix4().copy(sceneRoot.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
    const meshes = [];
    let n = 0;
    sceneRoot.traverse((o) => {
      const pos = o.isMesh && o.visible !== false ? o.geometry?.attributes?.position : null;
      if (!pos) return;
      const step = Math.max(1, Math.ceil(pos.count / 4000));
      meshes.push([o, pos.count, step]); n += Math.ceil(pos.count / step);
    });
    const pts = new Float32Array(n * 3);
    let k = 0;
    for (const [o, count, step] of meshes) {
      m.multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < count; i += step) {
        o.getVertexPosition(i, v);   // skinned + morphed, in the mesh's own space
        v.applyMatrix4(m);
        pts[k++] = v.x; pts[k++] = v.y; pts[k++] = v.z;
      }
    }
    return pts;
  }

  /** rebuild the nameplate sprite from the current tokens (rename, or a Style change) */
  repaintLabel() {
    const name = this._labelName ?? this.a.id ?? '';
    const at = this.label.position.clone();   // where the body hangs it (_placePlate); the new sprite takes the same spot
    this.a.root.remove(this.label);
    disposeSprite(this.label);
    this.label = makeLabel(this._seatApprox ? `${name} ≈` : name);
    this.label.position.copy(at);
    this.a.root.add(this.label);
  }

  /** A seated body whose profile gate is closed (occupants.js) wears a small ≈ on its nameplate. */
  setSeatApprox(on) {
    if (this._seatApprox === !!on) return;
    this._seatApprox = !!on;
    this.setName(this.a.id);
  }

  // ---- speech
  setTyping(state) {
    // null means stop (mic went cold, composing ended)
    if (state === null) { this._typingUntil = 0; this._typingState = null; return; }
    this._typingUntil = performance.now() + 4000;
    this._typingState = state || null;
  }

  say(text) {
    // speaking ends composing, but not a live mic: the voice is still coming out of this body
    if (this._typingState !== 'mic') this._typingUntil = 0;
    if (this.bubble) { this.a.root.remove(this.bubble); disposeSprite(this.bubble); }
    this.bubble = makeBubble(text);
    this.bubble.position.copy(this.label.position).y += BUBBLE_LIFT;   // it rides the plate (update keeps it there)
    this.a.root.add(this.bubble);
    // roughly reading speed, clamped
    const ms = THREE.MathUtils.clamp(2500 + text.length * 45, 5000, 22000);
    this.bubbleUntil = performance.now() + ms;
    this.a.speakUntil = performance.now() + Math.min(ms, 1000 + text.length * 38);
  }
}
