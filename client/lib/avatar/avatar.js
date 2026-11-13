// avatar — a body in the world: VRM, clip set, nameplate, speech bubble, and
// the small autonomic behaviours that make a puppet read as present (gaze,
// blink, head pitch, mouth movement while speaking).

import { THREE, scene, camera, renderer } from '../core.js';
import { makeCapsuleVrm } from './capsulebody.js';
import { FADE_PRESS } from './locomotion_clip.js';   // one owner for the jump-press fade (see _setAction)
import { report, angleDelta, bus } from '../base.js';
import { swimPose } from '../../../shared/swimpose.js';
import { defsRegistry } from '../defs.js';
import { bodyRuntimeFor, bodyDefFor, capEmissive } from './bodyruntime.js';
import { measureChain, solveChain } from './reachbone.js';
import { REACH_CHAINS } from '../../../shared/joints.js';
// a body that glows also casts: light requests, never lights (lightrig owns the topology)
import { attachLamps, releaseOwner, updateRequest, glowScale } from '../lightrig.js';
import { setBodyShadows } from '../materials.js';
import { BREATH } from '../../../shared/breath.js';
import {
  loadVRM, clipFor, vrmaBytes, loadTrack, loadDone,
  CLIP_SLOTS, CLIP_SPEED, releaseVRM, vrmWarmed, markVrmWarmed,
} from '../assets.js';
import { beginWork, idleYield, nextFrame, loadNote } from '../loadwork.js';
import { warm, P_GATE } from '../warmqueue.js';
import { heightAt } from '../terrain.js';
import { surfaceUnder } from '../colliders.js';
import { DRIVEN_BONES } from '../ragdoll/ragdoll.js';
import { stroke as strokeIcon } from '../icons.js';
import { plateSize, plateClear, ownClearance, reachAbove, plateBox, CLEAR_MIN, PLATE_W } from './platesize.js';
import { revealLevel } from './namereveal.js';
import { crownEstimate, plateGap, plateAnchor, plateOffset, plateViewLift, STAND_SLOTS, DEAD as PLATE_DEAD } from './plateanchor.js';
import { clampBodyScale, clampPlateY, plateLift, clipRate } from '../../../shared/bodyscale.js';
import { Fn, userData, positionView, cameraNear, cameraFar, min, viewZToPerspectiveDepth, viewZToReversedPerspectiveDepth,
  viewZToOrthographicDepth } from 'three/tsl';
import { SEAT_CLIP_FILE } from '../../../shared/seatcore.js';
import { planReaches } from '../../../shared/reachorder.js';
import { poseChannels } from '../../../shared/humanoid.js';
import { swimTargets, SWIM_CLIPS } from '../../../shared/swimpose.js';
import { Wings } from './wings.js';

// Blink and eye dials, for a rig whose lids are bones and exports no limit of its own (_findLids).
export const BLINK = {
  closed: 1.2,   // radians an upper lid swings to shut, signed (depends on the lid bone's roll); tuned by eye
  hz: 1,         // blink-rate multiplier
  axis: 0,       // which axis a lid swings about (0=x 1=y 2=z): bone roll out of Blender is arbitrary
  lower: -0.35,  // the lower lid's share, usually opposite (an upper lid alone leaves the sclera showing)
  eyeMax: 0.42,  // radians an eyeball may turn off the head's forward; eyes that track hard read as staring
  dur: 0.28,     // seconds for a full close-and-open
};
const _v = new THREE.Vector3();
const _gq = new THREE.Quaternion();        // gaze scratch — hot path, no allocs
const _gd = new THREE.Quaternion();
const _gi = new THREE.Quaternion();
const _gpq = new THREE.Quaternion();
const _gf = new THREE.Vector3();
const _gw = new THREE.Vector3();
const _gp = new THREE.Vector3();

// the wing dials and the flap live in wings.js; debug.js and the tests read the dials here
export { WING_IDLE, WING_POWER } from './wings.js';

/** What a limp body's springbones become when no sim of its own is running (_springsLimp). Live: the debug panel
 *  dials these. stiffness is a factor on what the rig declared; gravity is a floor. */
export const LIMP_SPRINGS = {
  stiffness: 0.2,   // give way: the rest shape was authored for standing up
  gravity: 0.45,
};

// a body is born with the CORE_CLIPS (~1.9MB per clip slot) and learns the rest while you move (hydrateClips)
const CORE_CLIPS = ['idle', 'walk'];
const LATER_CLIPS = CLIP_SLOTS.filter((s) => !CORE_CLIPS.includes(s));
// until a clip arrives, the nearest thing that has arrived stands in
const CLIP_FALLBACK = {
  run: 'walk', jump: 'idle', climb: 'walk',
  sit: 'idle', lie: 'idle', sitchair: 'sit',
  // A body with no flight clips still flies -- it just glides in its idle pose.
  fly: 'soar', soar: 'idle',
  // swimming is procedural (Avatar._swimLayer) over the idle clip — no rig ships a swim clip
  swim: 'idle', tread: 'idle',
};

// the gesture vocabulary (animnames.js), re-exported; imported first because playOnce reads ANIM_CLIPS
import { ANIM_CLIPS, ANIM_ORDER, ANIM_ICONS, hydrateAnimNames } from '../animnames.js';
export { ANIM_CLIPS, ANIM_ORDER, ANIM_ICONS, hydrateAnimNames };
// seated postures differ by what you sit on: the ground clip on a chair leaves you cross-legged in mid-air
const SEAT_CLIPS = { ground: 'sitting_on_ground', chair: SEAT_CLIP_FILE };

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
// every live Avatar, so a Style change can repaint the sprites it baked from tokens
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
  s.userData.aspect = box.h / box.w;   // the sprite's height per metre of width: avatar.js sizes it by width each frame
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

// ---------------------------------------------------------------- Avatar

const _plateEye = new THREE.Vector3();   // nameplate fade: the camera's world position
const _pq = new THREE.Quaternion();
const _rq = new THREE.Quaternion();
const _rq2 = new THREE.Quaternion();
const _rq3 = new THREE.Quaternion();
const _rv = new THREE.Vector3();
const _rv2 = new THREE.Vector3();
const _rv3 = new THREE.Vector3();
const _rv4 = new THREE.Vector3();
const _Y2 = new THREE.Vector3(0, 1, 0);
const _Z2 = new THREE.Vector3(0, 0, 1);
const _X = new THREE.Vector3(1, 0, 0);      // scratch — hot paths must not allocate
const _v2 = new THREE.Vector3();
const _swE = new THREE.Euler(), _swQ = new THREE.Quaternion();   // swim-layer scratch
const _hq = new THREE.Quaternion();        // raw-pose scratch (_applyRawPose) — per bone, per frame
const _hv = new THREE.Vector3();
const _hs = new THREE.Vector3();
const _ONE = new THREE.Vector3(1, 1, 1);
const _sa1 = new THREE.Vector3(), _sa2 = new THREE.Vector3();          // seat anchor scratch (_measureAnchor)
const _sl1 = new THREE.Quaternion(), _sl2 = new THREE.Quaternion(), _sl3 = new THREE.Quaternion();   // seat look scratch
// a clip named the way the animation library names its files: what a socket's pose, enter and leave may name
const CLIP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
// the clips hydrateClips owns (slot names that are not file names): a socket naming one waits for hydration
const HYDRATED = new Set([...CORE_CLIPS, ...LATER_CLIPS, 'sitchair']);

// the lamp's breath (update): floor near-dark but never off; peak below 1 so it reads as breath, not a pulse
// (tuned with the lamp's shadows on); shape >1 dwells near the floor and softens the flare (1 is a plain sine)
const LAMP_FLOOR = 0.03;
const LAMP_PEAK = 0.62;
const LAMP_SHAPE = 1.6;
const LAMP_DAY_FLOOR = 0.18;   // the surface's share of the sky's dimming curve: never looks broken in full sun


/** A jump clip's take-off: the hips dip (anticipation), then come back up through their rest height — that is the
 *  frame the feet leave the floor. A clip with no hips track, or one that starts by rising, gives 0. */
function clipTakeoff(clip) {
  if (clip.userData.takeoff != null) return clip.userData.takeoff;
  const tr = clip.tracks.find((t) => /hips\.position$/i.test(t.name) || /Hips\.position$/.test(t.name));
  let out = 0;
  if (tr && tr.values.length >= 6) {
    const n = tr.times.length, half = Math.max(1, Math.floor(n / 2));
    let minI = 0, minY = Infinity;
    for (let i = 0; i < half; i++) { const y = tr.values[i * 3 + 1]; if (y < minY) { minY = y; minI = i; } }
    if (minI > 0 && tr.values[1] - minY > 0.01) {   // a real dip (>1 cm), not noise
      // the feet leave the ground when the hips come back up through rest height, not at the bottom of the squat
      let i = minI; while (i < n - 1 && tr.values[i * 3 + 1] < tr.values[1]) i++;
      out = tr.times[i];
    }
  }
  clip.userData.takeoff = out;
  return out;
}
export class Avatar {
  /** Monotonic, so one identity's successive bodies never share a lamp owner. */
  static _seq = 0;

  constructor(id, vrm, clips, { lamps = true } = {}) {
    this.id = id;
    this.vrm = vrm;
    this.root = new THREE.Group();
    this.root.userData.isBody = true;   // so the sky's scene-diff never claims a person
    this.root.userData.who = id;        // perf attribution: this subtree is a PERSON (perfscope)
    this.root.add(vrm.scene);
    // The chosen size (bodyscale.js) lives on vrm.scene, multiplied with the VR puppet fit, never on the root: the
    // root also carries the plate, pill and bubble, which platesize.js keeps screen-sized. Written fresh: a pooled
    // VRM may still wear its last owner's size.
    this.userScale = 1; this.plateY = 0; this._puppet = 1;
    vrm.scene.scale.setScalar(1);
    // A lamp in the body: a light request at each emissive mesh's centre, so a glowing chest lights the room. Owned
    // per body instance, not per identity: a body swap builds the new body before disposing the old (mybody.js).
    this._lampOwner = `body:${id}:${++Avatar._seq}`;
    this._lamps = [];
    // `shadows: true` claims the one casting slot (see attachLamps). A def whose glow is not a lamp (`lamps: false`:
    // indicator lights, a screen) keeps its blob.
    if (lamps) {
      try { this._lamps = attachLamps(vrm.scene, this._lampOwner, { shadows: true }) ?? []; }
      catch { /* a body with no glow simply has none */ }
    }
    // a lamped body casts and receives; every other body keeps its blob (shadows for every avatar is an unmeasured cost)
    if (this._lamps.length) {
      try { setBodyShadows(vrm.scene, true); }
      catch { /* shadows are a nicety; a body that cannot take them still works */ }
    }

    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = {};
    this.extraClips = new Map(); // lazily-loaded gesture actions
    for (const [slot, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true; a.setEffectiveWeight(0); a.play();
      this.actions[slot] = a;
    }
    this.current = null;
    this.currentSlot = null;
    this.onceAnim = null;             // { action, until }
    // the ankles' height above the root at rest: a socket anchoring the feet puts the soles on it, not the ankles
    try { const h = vrm.humanoid; const f = h?.getRawBoneNode?.('leftFoot') ?? h?.getNormalizedBoneNode?.('leftFoot');
      if (f) { this.root.updateMatrixWorld(true); this._footRestY = Math.max(0, this.root.worldToLocal(f.getWorldPosition(new THREE.Vector3())).y); } } catch { this._footRestY = 0; }
    this.setClip('idle');

    this.bubble = null;
    this.bubbleUntil = 0;
    this.speakUntil = 0;           // drives the fake viseme envelope
    this.voiceLevel = null;        // 0..1 real amplitude when a waveform exists
    this.typing = null;            // lazily-built dots sprite
    this._typingUntil = 0;         // typing signals repeat ~2.5s and expire ~4s
    this._typingDrawAt = 0;
    this.label = makeLabel(id);
    this.label.position.y = 1.95;   // until the first frame hangs it from the body (_placePlate)
    this.root.add(this.label);
    this._plateRest = this._measurePlateRest();   // the crown, once, while the body is still at rest
    this._plateOff = null;                        // smoothed plate height above the root (world m) — see _placePlate
    liveAvatars.add(this);

    // gaze: the VRM lookAt rig's target, eased each frame toward whatever deserves attention
    this.gaze = new THREE.Object3D();
    this.gaze.userData.isBody = true;
    scene.add(this.gaze);
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;

    this.gazeGoal = new THREE.Vector3();
    this.blinkAt = performance.now() + 1200 + Math.random() * 3600;
    this.blinkT = -1;
    this._mouth = 0;               // smoothed jaw, so the mouth has inertia
    this.head = vrm.humanoid?.getNormalizedBoneNode?.('head') ?? null;
    this.pitch = 0;                // radians, applied post-update
    this._limp = false;            // see setLimp: the mixer yields to the sim
    this.wings = new Wings(this);   // wings.js: the flap and the fold, found on first use
    this._composed = new Map();    // node -> clip base + what we last wrote
    this.shadow = makeBlobShadow();
    this.root.add(this.shadow);

    scene.add(this.root);
  }

  /** Give the hair back to three-vrm, resuming from where the tumble left it. springBoneManager.reset() would snap
   *  to the combed pose; wanted is only its other half, tails re-derived from the current matrices. So the rest
   *  rotation is pointed at the current pose for the call, and put back by _combHair unless `adopt`. */
  _releaseHair({ adopt = false } = {}) {
    if (!this.__simHair) return;
    this.__simHair = false;
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints) return;
    this.vrm.scene?.updateMatrixWorld?.(true);
    // the authored spring rest, remembered once, so adopting a fallen shape can never ratchet
    if (!this.__springRest) {
      this.__springRest = new Map();
      for (const j of sbm.joints) {
        if (j?._initialLocalRotation) this.__springRest.set(j, j._initialLocalRotation.clone());
      }
    }
    for (const j of sbm.joints) {
      if (j?._initialLocalRotation && j.bone) j._initialLocalRotation.copy(j.bone.quaternion);
    }
    sbm.reset();                 // re-derives tails; the rotation restore is a no-op
    if (!adopt) this._combHair();
  }

  /** Springbone settings for a limp body with no sim of its own (remotes, and the gap after a doll disposes).
   *  Stiffness pulls toward a rest direction that rotates with the body, so on a body lying on its side the hair is
   *  pulled sideways: while limp, stiffness gives way and gravity takes over (LIMP_SPRINGS). */
  _springsLimp(on) {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints || this.__springsLimp === on) return;
    this.__springsLimp = on;
    if (!this.__springSettings) {
      this.__springSettings = new Map();
      for (const j of sbm.joints) {
        if (j?.settings) {
          this.__springSettings.set(j, {
            s: j.settings.stiffness, g: j.settings.gravityPower, center: j._center ?? null,
          });
        }
      }
    }
    for (const j of sbm.joints) {
      const o = this.__springSettings.get(j);
      if (!o) continue;
      j.settings.stiffness = on ? o.s * LIMP_SPRINGS.stiffness : o.s;
      j.settings.gravityPower = on ? Math.max(o.g, LIMP_SPRINGS.gravity) : o.g;
      // `center` stores tails in the hips' frame so walking doesn't sweep the hair back, but a carried body's hair
      // then rotates rigidly with it: dropped while limp
      if (on) j._center = null;
      else if (o.center !== undefined) j._center = o.center;
    }
    this._springsResync();   // the tails were stored in the frame just changed; re-derive them or the hair flings
  }

  /** Re-derive spring tail state from the CURRENT pose, keeping that pose (the trick in
   *  _releaseHair). Needed anywhere the frame those tails live in changes. */
  _springsResync() {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints) return;
    this.vrm.scene?.updateMatrixWorld?.(true);
    const saved = [];
    for (const j of sbm.joints) {
      if (!j?._initialLocalRotation || !j.bone) continue;
      saved.push([j, j._initialLocalRotation.clone()]);
      j._initialLocalRotation.copy(j.bone.quaternion);
    }
    sbm.reset();
    for (const [j, q] of saved) j._initialLocalRotation.copy(q);
  }

  /** Put the authored spring rest back, so the hair combs itself out again (on getting up, not on the doll's
   *  dispose, which hands the hair back still falling). */
  _combHair() {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints || !this.__springRest) return;
    for (const j of sbm.joints) {
      const q = this.__springRest.get(j);
      if (q && j._initialLocalRotation) j._initialLocalRotation.copy(q);
    }
  }

  /** Find hand-rigged eyeball bones (L_Eye / R_Eye) once. A rig whose eyes are VRM-mapped is three-vrm's: this.gaze
   *  is already its target, and two writers on one bone fight. */
  _findEyes() {
    this._eyes = null;
    if (!this.vrm?.scene) return;
    if (this.vrm.lookAt && this.vrm.humanoid?.getNormalizedBoneNode?.('leftEye')) return;
    const found = [];
    this.vrm.scene.traverse((o) => {
      if (/^[LR]_Eye$/.test(o.name ?? '')) found.push({ node: o, rest: o.quaternion.clone() });
    });
    if (found.length) this._eyes = found;
  }

  /** Hold the eyes shut or let them open (eased in update). False when this body has no eyelid bones. */
  setEyes(shut) {
    if (this._lids === undefined) this._findLids();
    if (!this._lids) return false;
    this._eyesGoal = shut ? 1 : 0;
    return true;
  }

  /** Find the eyelid bones (L_/R_Eyelid_Upper, _Lower) once and remember where open is. The closing angle comes
   *  from the rig as a node extra; BLINK.closed is the fallback. */
  _findLids() {
    this._lids = null;
    if (!this.vrm?.scene) return;
    const found = [];
    this.vrm.scene.traverse((o) => {
      const m = /^[LR]_Eyelid_(Upper|Lower)$/.exec(o.name ?? '');
      if (!m) return;
      const ex = o.userData?.gltfExtras ?? o.userData ?? {};
      // in order of authority: a saved closed pose (already a rotation from rest), a Limit Rotation constraint
      // (absolute angles, rest mid-range, so the delta is closed - centre), then the BLINK.closed dial
      let lim = NaN;
      const cl = Number(ex.blink_closed_x);
      if (ex.blink_closed_src === 'pose') {
        if (Number.isFinite(cl) && Math.abs(cl) > 1e-3 && Math.abs(cl) < 1.6) lim = cl;
      } else {
        const mn = Number(ex.limit_min_x), mx = Number(ex.limit_max_x);
        if ([mn, mx, cl].every(Number.isFinite) && mx > mn) {
          const d = cl - (mn + mx) / 2;
          if (Math.abs(d) > 1e-3 && Math.abs(d) < 1.6) lim = d;
        }
      }
      found.push({
        node: o,
        rest: o.quaternion.clone(),
        lower: m[1] === 'Lower',
        exported: Number.isFinite(lim) && Math.abs(lim) > 1e-4 ? lim : null,
      });
    });
    if (found.length) this._lids = found;
  }

  /** Where this body should be looking. Null = relax to neutral. */
  setGazeTarget(v3) {
    if (v3) { this.gazeGoal.copy(v3); this._hasGaze = true; }
    else this._hasGaze = false;
  }

  // ---- first-person anchors (fp_view.js consumes these) -------------------

  /** Live world position of the head bone (the raw bone, which the mesh follows), or null when the rig has none. */
  headWorldPosition(out) {
    const node = this.vrm.humanoid?.getRawBoneNode?.('head') ?? this.head;
    if (!node) return null;
    return node.getWorldPosition(out);
  }

  /** World bounds of the rig's own mesh (vrm.scene, not the root: the sprites above the head would inflate it). */
  visualBounds(box) {
    box.setFromObject(this.vrm.scene);
    return box.isEmpty() ? null : box;
  }

  // ---- locomotion / clips
  setClip(slot, speed = 0, { fade, ease = false } = {}) {
    this.postureSlot = slot;   // what was ASKED (the wire's clip), before any fallback: the plate reads posture from it
    if (this.onceAnim && speed > 0.05) this.cancelOnce();   // moving cancels a gesture
    if (this.onceAnim) return;        // otherwise it owns the body until it finishes
    if (this._sb) return;          // a socket's pose (setSeatBlend) owns the base clips while it holds
    // any clip the library has, by name: loaded on first ask, the nearest loaded posture stands in meanwhile
    if (!this.actions[slot] && !CLIP_FALLBACK[slot] && !HYDRATED.has(slot)) this.ensureClip(slot);
    let use = slot;
    while (!this.actions[use] && CLIP_FALLBACK[use]) use = CLIP_FALLBACK[use];
    if (!this.actions[use]) use = this.actions.idle ? 'idle' : use;   // a named clip still loading: stand meanwhile
    this._setAction(this.actions[use], use, fade, ease);
    const a = this.actions[use];
    if (!a) return;
    // a bigger stride is a slower cadence at the same speed; the swim layer keeps its own cadence over idle
    a.timeScale = slot === 'swim' || slot === 'tread' ? 1 : clipRate(speed, CLIP_SPEED[slot], this.userScale);
  }

  /** Standing height in metres, from the skeleton at rest (the head joint plus a forehead — the stature
   *  rule the portrait framing uses), at this body's current size. What water depth is measured against. */
  bodyHeight() {
    const key = this.userScale ?? 1;
    if (this._bodyH && this._bodyHKey === key) return this._bodyH;
    let h = 1.7 * key;
    try {
      const r = this.restBonePositions(['head']);
      if (r?.head) h = Math.min(4, Math.max(0.5, r.head.y - this.root.position.y + 0.13));
    } catch { /* a body with no humanoid: the default */ }
    this._bodyH = h; this._bodyHKey = key;
    return h;
  }

  /** Swimming, drawn: no rig ships a swim clip, so the stroke (shared/swimpose.js swimTargets) is composed over the
   *  idle clip on the normalized bones, eased and cross-faded between `swim` and `tread` by weight. Runs before
   *  the held pose and animations, which win any bone they name; never the head. */
  _swimLayer(dt, now) {
    const slot = this.postureSlot;
    const want = !this._limp && SWIM_CLIPS.includes(slot) ? 1 : 0;
    this._swimW = (this._swimW ?? 0) + (want - (this._swimW ?? 0)) * Math.min(1, 4 * dt);
    if (this._swimW < 0.005) { this._swimW = 0; return; }
    this._swimMove = (this._swimMove ?? 0) + ((slot === 'swim' ? 1 : 0) - (this._swimMove ?? 0)) * Math.min(1, 3 * dt);
    const h = this.vrm.humanoid, taken = this._reachOwned();
    const tg = swimTargets(this._swimMove, now / 1000), w = this._swimW;
    for (const [name, x, y, z] of tg) {
      const node = h?.getNormalizedBoneNode?.(name);
      if (!node || taken?.has(node)) continue;
      _swE.set(x, y, z, 'YZX');
      _swQ.setFromEuler(_swE);
      const r = this._composeBegin(node);
      node.quaternion.slerp(_swQ, w);
      this._composeEnd(node, r);
    }
  }
  _setAction(a, slot, fadeIn, ease = false) {
    if (!a || this.current === a) return;
    let linear = false;
    const fade = fadeIn ?? (slot === 'jump' ? FADE_PRESS : 0.22);   // a jump press is snappy (locomotion_clip.js)
    // a cut landing inside an ease continues from the current weights, linear (reset()+fadeIn would dip the sum)
    if (this._xfade) { const x = this._xfade; if (x.out && x.out !== a && x.out !== this.current) x.out.fadeOut(fade); this._xfade = null; ease = true; linear = true; }
    if (ease) {
      // smoothstep on both sides, so the weights always sum to 1
      const prev = this.current; const out0 = prev ? prev.getEffectiveWeight() : 0; if (prev) prev.stopFading();
      const in0 = a.getEffectiveWeight();   // from wherever the previous linear fade left them, not 0/1
      a.enabled = true; a.reset(); a.stopFading(); a.setEffectiveWeight(in0); a.play();
      this._xfade = { out: prev, in: a, dur: fade, t: 0, in0, out0, linear };
    } else {
      if (this.current) this.current.fadeOut(fade);
      a.enabled = true;
      a.setEffectiveWeight(1);       // base weight — fadeIn ramps a MULTIPLIER on this
      a.reset().fadeIn(fade);
    }
    // the body leaves the ground instantly, so the jump clip starts at its take-off, past the anticipation crouch
    if (slot === 'jump') a.time = clipTakeoff(a.getClip());
    this.current = a;
    this.currentSlot = slot;
  }

  /** Fill in the clips that weren't needed to stand up, one at a time in idle moments. Safe to call twice. */
  async hydrateClips() {
    if (this._hydrating) return this._hydrating;
    this._hydrating = (async () => {
      for (const [slot, name] of [...LATER_CLIPS.map((s) => [s, s]), ['sitchair', SEAT_CLIPS.chair]]) {
        await idleYield();
        try {
          const clip = await clipFor(this.vrm, name);
          const a = this.mixer.clipAction(clip);
          a.enabled = true; a.setEffectiveWeight(0); a.play();
          this.actions[slot] = a;
        } catch (e) {
          if (slot !== 'sitchair') console.warn(`clip ${slot} unavailable`, e);
        }
      }
    })();
    return this._hydrating;
  }

  /** Play a gesture over locomotion. Returns when it's queued, not done. */
  async playOnce(name) {
    const file = ANIM_CLIPS[name];
    if (!file) return;
    try {
      let action = this.extraClips.get(file);
      if (!action) {
        const clip = await clipFor(this.vrm, file);
        action = this.mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        this.extraClips.set(file, action);
      }
      const dur = action.getClip().duration;
      action.reset().play();   // without play() the skeleton falls to its T-pose
      this.onceAnim = null;           // let _setAction run
      this._setAction(action, `once:${name}`);
      this.onceAnim = { action, until: performance.now() + dur * 1000 };
    } catch (e) { report(`gesture ${name}`, e); }
  }
  cancelOnce() {
    if (!this.onceAnim) return;
    const action = this.onceAnim.action;
    this.onceAnim = null;
    action.fadeOut(0.25);   // a clamped LoopOnce holds its final frame at full weight forever otherwise
    if (this.current === action) this.current = null; // next setClip fades in fresh
  }

  // ---- custom poses & one-off animations ---------------------------------
  // Both are bone rotations, held (a pose) or sampled over time (an animation), slerped over the clip's pose by a
  // ramping weight between the mixer and vrm.update (see update): composing over a walk cycle instead of fighting it.

  /** Resolve+cache the normalized bone nodes for a set of names once. */
  _resolveBones(names) {
    const out = [];
    for (const n of names) {
      const node = this.vrm.humanoid?.getNormalizedBoneNode?.(n);
      if (node) out.push([n, node]);
    }
    return out;
  }

  /** Any bone of this rig by its exported name (hair, wings, eyelids, twist bones, raw humanoid bones), or null. */
  _rawBone(name) {
    if (!this._rawBones) {
      this._rawBones = new Map();
      this.vrm.scene.traverse((o) => { if (o.isBone && o.name && !this._rawBones.has(o.name)) this._rawBones.set(o.name, o); });
    }
    return this._rawBones.get(name) ?? null;
  }

  /** A raw bone's rest, from the TRS every bone had at load (assets.js boneRest), not the live node. `pq` is the
   *  parent's rest rotation in the model frame, `pinv` its inverse linear part, `rq` this bone's rest local
   *  rotation: what a model-axes pose value needs to land in a parent-local node (raw = P⁻¹·q·P·rest, as three-vrm
   *  does for humanoid bones). Null when the body has no recorded rest (the capsule). */
  _rawRest(node) {
    this._rawRests ??= new Map();
    if (this._rawRests.has(node)) return this._rawRests.get(node);
    const table = this.vrm.userData?.boneRest;
    const local = (o) => {
      const r = table[o.name];
      return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(r.p), new THREE.Quaternion().fromArray(r.q), new THREE.Vector3().fromArray(r.s));
    };
    let rest = null;
    if (table?.[node.name]) {
      // walk up through bones at rest; the first non-bone (the armature node) does not animate
      const P = new THREE.Matrix4();
      let o = node.parent;
      while (o && o.isBone && table[o.name]) { P.premultiply(local(o)); o = o.parent; }
      if (o && o !== this.vrm.scene) {
        this.vrm.scene.updateMatrixWorld(true);
        P.premultiply(this.vrm.scene.matrixWorld.clone().invert().multiply(o.matrixWorld));
      }
      const pq = new THREE.Quaternion();
      P.decompose(new THREE.Vector3(), pq, new THREE.Vector3());
      rest = { pq, pqInv: pq.clone().invert(), rq: new THREE.Quaternion().fromArray(table[node.name].q),
        pinv: new THREE.Matrix3().setFromMatrix4(P).invert() };
    }
    this._rawRests.set(node, rest);
    return rest;
  }

  /** Hold a pose. `bones` is a sparse map name -> [x,y,z,w] or {q?, t?, s?} (shared/humanoid.js poseChannels). A
   *  humanoid name rotates the normalized bone over the clip; any other bone the rig has is posed on the raw node.
   *  Translation and scale ride the raw node, except hips translation, which goes through the normalized hips so
   *  everything downstream sees the body where it is. */
  setPose(bones) {
    if (!bones || typeof bones !== 'object') return this.clearPose();
    const targets = new Map(), raw = [];
    let hipsT = null;
    const h = this.vrm.humanoid;
    for (const [n, v] of Object.entries(bones)) {
      const c = poseChannels(v);
      if (!c) continue;
      const norm = h?.getNormalizedBoneNode?.(n);
      if (norm) {
        if (c.q) targets.set(n, new THREE.Quaternion(c.q[0], c.q[1], c.q[2], c.q[3]).normalize());
        if (n === 'hips' && c.t) hipsT = new THREE.Vector3(c.t[0], c.t[1], c.t[2]);
        const t = n === 'hips' ? null : c.t;
        if (t || c.s) { const node = h.getRawBoneNode?.(n); if (node) raw.push({ node, q: null, t, s: c.s }); }
        continue;
      }
      const node = this._rawBone(n);
      if (node) raw.push({ node, q: c.q && new THREE.Quaternion(c.q[0], c.q[1], c.q[2], c.q[3]).normalize(), t: c.t, s: c.s });
    }
    if (!targets.size && !raw.length && !hipsT) return;
    const nodes = this._resolveBones([...targets.keys()]);
    // a pose replacing a pose hands back what only the old one covered (a still clip track never would)
    if (this._override) this._handBack(this._override, nodes, raw, hipsT);
    this._override = {
      kind: 'pose', nodes,
      raw, hipsT, hipsNode: hipsT ? h.getNormalizedBoneNode('hips') : null,
      // a tumble starts at full weight: the ragdoll's first frame is the pose the body is already in
      targets, weight: this._override?.weight ?? (this._limp ? 1 : 0), wantWeight: 1,
    };
  }

  /** Play a one-off animation. data = { dur, loop?, replace?, tracks: {bone:[{t,q:[x,y,z,w]}]} }. Animations are
   *  layers over the held pose (a wave while crouching keeps the crouch); a new one takes only its bones from the
   *  layers playing, or every layer with `replace`. The held pose itself is presence, which this body only renders. */
  playAnimation(data) {
    // {stop: true}: every layer fades out and hands its bones back to what is beneath
    if (data?.stop === true) { for (const l of this._anims ?? []) l.wantWeight = 0; return; }
    if (!data?.tracks) return;
    const tracks = new Map();
    for (const [n, keys] of Object.entries(data.tracks)) {
      if (!Array.isArray(keys) || !keys.length) continue;
      tracks.set(n, keys.map((k) => ({
        t: Number(k.t) || 0,
        q: new THREE.Quaternion(...(k.q ?? [0, 0, 0, 1])).normalize(),
      })).sort((a, b) => a.t - b.t));
    }
    if (!tracks.size) return;
    const dur = Math.max(0.1, Math.min(30, Number(data.dur) || 2));
    const nodes = this._resolveBones([...tracks.keys()]);
    const mine = new Set(nodes.map(([, n]) => n));
    // omitted = replace (the older wire); false requests a merge
    const replace = data.replace !== false;
    let from = 0;   // a bone taken over mid-play continues from where it was
    this._anims ??= [];
    for (const l of this._anims) {
      const lose = l.nodes.filter(([, n]) => mine.has(n));
      if (lose.length) from = Math.max(from, l.weight);
      if (replace) this._handBack(l, nodes);
      else l.nodes = l.nodes.filter(([, n]) => !mine.has(n));
    }
    this._anims = replace ? [] : this._anims.filter((l) => l.nodes.length);
    this._anims.push({
      kind: 'anim', nodes,
      tracks, dur, loop: !!data.loop, start: performance.now(),
      weight: from, wantWeight: 1, _scratch: new THREE.Quaternion(),
    });
  }

  /** Return an outgoing override's bones to their owners (the clip, or the pose underneath), except those the
   *  incoming one (`nodes`, `raw`, `hipsT`) goes on writing. Only bones still holding exactly what we left. */
  _handBack(o, nodes = [], raw = [], hipsT = null) {
    const keep = new Set(nodes.map(([, n]) => n));
    // an outgoing ANIMATION's bones under the held pose stay the pose's
    if (o !== this._override) for (const [, n] of this._override?.nodes ?? []) keep.add(n);
    for (const [, node] of o.nodes ?? []) {
      if (keep.has(node)) continue;
      const r = this._composed.get(node);
      if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
    }
    const keepRaw = new Set(raw.map((e) => e.node));
    for (const e of o.raw ?? []) if (!keepRaw.has(e.node)) this._rawRelease(e.node);
    if (o.hipsNode && !hipsT) this._rawRelease(o.hipsNode);
  }

  // ---- reaching: IK re-solved every frame ------------------------------
  // A reach is a relation to a point that may be moving, so it is stored as a target function and re-solved every
  // frame (reachbone.js). Where a held pose and a reach would write the same bone the reach wins and the pose skips
  // it: one author per bone per frame, which _composeBegin depends on.

  /** Measure the fixed facts about one arm/leg chain, once (in the root's frame, where rest is identity). */
  _measureChain(key) {
    this._chains ??= new Map();
    if (!this._chains.has(key)) this._chains.set(key, measureChain(this, key));
    return this._chains.get(key);
  }

  /** Reach `key` ('leftHand' | 'rightHand' | ...) toward a point.
   *  `target` is either [x,y,z] in WORLD space or a function returning one —
   *  pass the function when the thing being reached for can move. */
  setReach(key, target, opts = {}) {
    if (!REACH_CHAINS[key]) return false;
    if (!this._measureChain(key)) return false;
    this._reach ??= new Map();
    const prev = this._reach.get(key);
    this._reach.set(key, {
      key, target, weight: prev?.weight ?? 0, wantWeight: opts.weight ?? 1,
      pole: opts.pole ?? null, lastElbow: prev?.lastElbow ?? null, bound: [],
      lastPick: prev?.lastPick ?? null, lastSwivel: prev?.lastSwivel ?? null, lastTwist: prev?.lastTwist ?? null,
      lastGap: prev?.gap ?? prev?.lastGap ?? null,
      lastWrist: prev?.lastWrist ?? null,
      relation: opts.relation ?? null,
      palm: opts.palm !== false,
      owner: opts.owner ?? null,            // 'seat': a socket's reach (occupybody.js); a person's own reach outranks it
      hint: opts.hint ?? null,              // () => [x,y,z] world: where the elbow/knee points
      // retargeting still restores the previous writes when the new relation cannot solve
      _nu: prev?._nu, _nl: prev?._nl, _nh: prev?._nh,
    });
    return true;
  }

  /** Let an arm go, easing back to whatever the clip was doing. */
  clearReach(key) {
    if (key == null) { for (const r of this._reach?.values() ?? []) r.wantWeight = 0; return; }
    const r = this._reach?.get(key);
    if (r) r.wantWeight = 0;
  }

  /** What each live reach achieved last frame (a hand may not have got there). */
  reachStatus() {
    const out = {};
    for (const [k, r] of this._reach ?? []) out[k] = { weight: r.weight, gap: r.gap ?? null, bound: r.bound, penetration: r.penetration ?? null, palmResidual: r.palmResidual ?? null };
    return out;
  }

  _applyReach(dt, now) {
    if (!this._reach?.size) return;
    // this frame's clip base, before any relation reads a target
    for (const r of this._reach.values()) for (const node of [r._nu, r._nl, r._nh]) {
      const c = node && this._composed.get(node);
      if (c?.live && node.quaternion.equals(c.out)) { node.quaternion.copy(c.base); c.live = false; }
    }
    // retire fading entries before planning, so their dependants resume against the released limb this frame
    for (const [key, r] of this._reach) {
      if (r.wantWeight !== 0) continue;
      r.weight += (r.wantWeight - r.weight) * Math.min(1, 12 * dt);
      if (r.wantWeight === 0 && r.weight < 0.02) {
        this._reach.delete(key);
      }
    }
    const owner = this._reachOwner ?? 'self';
    const plan = planReaches([...this._reach].map(([limb, r]) => ({ owner, limb, target: r.relation, reach: r })));
    for (const e of plan.blocked) { e.reach.bound = ['cyclic-reach']; e.reach.gap = null; }
    for (const { limb: key, reach: r } of plan.order) {
      if (r.wantWeight !== 0) r.weight += (r.wantWeight - r.weight) * Math.min(1, 12 * dt);
      const ch = this._measureChain(key);
      if (!ch) { this._reach.delete(key); continue; }

      // a bare point, or {pos, normal} (the surface the hand meets, so the palm can face it)
      const raw = typeof r.target === 'function' ? r.target() : r.target;
      const tw = Array.isArray(raw) ? raw : raw?.pos;
      const normal = Array.isArray(raw) ? null : raw?.normal;
      if (!tw || tw.length !== 3 || !tw.every(Number.isFinite)) { r.bound = ['no-target']; continue; }

      // the palm faces into the surface: the opposite of the outward normal
      const palm = (r.palm !== false && normal && normal.length === 3 && normal.every(Number.isFinite))
        ? { dir: [-normal[0], -normal[1], -normal[2]] } : null;
      const hint = typeof r.hint === 'function' ? r.hint() : r.hint;
      const out = solveChain(ch, this, tw, r.lastElbow, { palm, lastPick: r.lastPick, lastSwivel: r.lastSwivel, lastTwist: r.lastTwist, lastWrist: r.lastWrist, lastGap: r.lastGap, dt,
        ...(Array.isArray(hint) && hint.length === 3 && hint.every(Number.isFinite) ? { hintWorld: hint } : {}) });
      if (!out.ok) { r.bound = [out.why]; continue; }
      r.bound = out.res.bound; r.gap = out.res.gap; r.lastPick = out.pick ?? null; r.lastSwivel = out.swivelUsed ?? null; r.penetration = out.penetration ?? 0; r.lastElbow = out.elbowOffset;
      // what the solver believes it placed, for probes
      r.solved = { elbow: this.root.localToWorld(_rv3.set(...out.res.elbow)).toArray(),
                   hand: this.root.localToWorld(_rv4.set(...out.res.hand)).toArray() };
      const q = { upper: out.upper, lower: out.lower };
      r._nu = ch.nodes.upper; r._nl = ch.nodes.lower;
      this._writeBone(ch.nodes.upper, q.upper, r.weight);
      this._writeBone(ch.nodes.lower, q.lower, r.weight);
      if (out.hand) { r._nh = ch.nodes.end; this._writeBone(ch.nodes.end, out.hand, r.weight); }
      r.palmResidual = out.palmResidual ?? null;
      r.lastTwist = out.palmTwist ?? null;
      r.lastGap = out.res.gap;
      r.lastWrist = out.hand ?? null;
    }
  }

  /** Slerp one bone from the clip's pose toward `q`, composed so the fade-out returns to the clip. */
  _writeBone(node, q, weight) {
    const c = this._composeBegin(node);
    _rq3.set(q[0], q[1], q[2], q[3]);
    node.quaternion.slerp(_rq3, weight);
    this._composeEnd(node, c);
  }

  /** Bones a live reach owns this frame; a held pose must not also write them. */
  _reachOwned() {
    if (!this._reach?.size) return null;
    const s = new Set();
    for (const r of this._reach.values()) {
      const ch = this._chains?.get(r.key);
      if (ch && r.weight > 0.02) { s.add(ch.nodes.upper); s.add(ch.nodes.lower); }
    }
    return s.size ? s : null;
  }

  clearPose() { if (this._override) this._override.wantWeight = 0; }

  // ---- the body at a socket (shared/sockbody.js) ------------------------------
  // A socket says what a body does there as data: a clip, a blend of clips by a signal, or a clip whose time is
  // locked to the thing's motion. So a socket's pose is its own layer over the mixer: several actions at once,
  // weights set every frame, time optionally driven. While it holds, setClip yields and gestures play over it.

  /** The action for a clip name, loading it from the animation library on first ask (null until it lands). Slot
   *  names (idle, walk, sit, sitchair, lie…) come from hydrateClips; every other name is a library file. */
  ensureClip(name) {
    if (this.actions[name]) return this.actions[name];
    if (HYDRATED.has(name) || !CLIP_NAME_RE.test(String(name))) return null;
    this._clipLoads ??= new Map();
    if (!this._clipLoads.has(name)) {
      this._clipLoads.set(name, clipFor(this.vrm, name).then((clip) => {
        if (this._disposed) return;
        const a = this.mixer.clipAction(clip);
        a.enabled = true; a.setEffectiveWeight(0); a.play();
        this.actions[name] = a;
      }).catch((e) => { console.warn(`[clips] '${name}' unavailable — the nearest posture stands in`, e?.message ?? e); }));
    }
    return null;
  }

  /** Hold a socket's pose: `clips` = [[name, weight]] (weights sum to 1), `phase` = null (clips play at their own
   *  rate) or 0..1 (every clip's time is that fraction of its length: locked to the thing's motion, or to an enter's
   *  progress). Called every frame while seated; null lets go, and the body's own clip comes back. A clip still loading
   *  is stood in for by its nearest loaded posture, so the weights never fall short of a whole body. */
  setSeatBlend(clips, phase = null) {
    if (!clips) {
      if (!this._sb) return;
      for (const [a] of this._sb.w) a.fadeOut(0.25);
      this._sb = null; this.current = null;
      this.setClip('idle');   // the body's own clip comes back (the caller sets the real one on its next frame)
      return;
    }
    if (!this._sb) {
      // the clip playing now fades out under three's own fade; the blend's actions ease in under ours
      if (this.current && this.current !== this.onceAnim?.action) this.current.fadeOut(0.25);
      this.current = null; this.currentSlot = null; this._xfade = null;
      this._sb = { w: new Map(), want: [], phase: null };
    }
    this._sb.want = clips; this._sb.phase = Number.isFinite(phase) ? phase : null;
  }
  /** The slot actually carrying the body: currentSlot, or the seat blend's heaviest clip (occupants.js reads this). */
  playingSlot() {
    if (!this._sb) return this.currentSlot;
    let best = null, bw = 0;
    for (const [a, w] of this._sb.w) if (w > bw) { best = a; bw = w; }
    if (!best) return null;
    for (const [n, act] of Object.entries(this.actions)) if (act === best) return n;
    return null;
  }
  /** What the seat blend is doing (probes and the agent's eye): [[clip, weight, time]] as the mixer has it. */
  seatBlendState() {
    if (!this._sb) return null;
    return { phase: this._sb.phase, clips: [...this._sb.w].map(([a, w]) => [a._seatName, +w.toFixed(4), +a.time.toFixed(4)]).filter((x) => x[1] > 1e-3) };
  }
  _applySeatBlend(dt) {
    const sb = this._sb;
    const target = new Map();
    for (const [name, w] of sb.want) {
      let use = name, a = this.ensureClip(name) ?? this.actions[name];
      while (!a && CLIP_FALLBACK[use]) { use = CLIP_FALLBACK[use]; a = this.actions[use]; }
      a ??= this.actions.idle;
      if (!a) continue;
      a._seatName ??= name;
      target.set(a, (target.get(a) ?? 0) + w);
    }
    for (const a of target.keys()) if (!sb.w.has(a)) { a.stopFading(); sb.w.set(a, a === this.current ? a.getEffectiveWeight() : 0); a.enabled = true; if (sb.phase == null) a.reset(); a.play(); }
    // a gesture plays over the seat; the seat yields exactly the weight it takes
    const over = this.onceAnim ? 1 - Math.min(1, this.onceAnim.action.getEffectiveWeight()) : 1;
    const k = Math.min(1, 10 * dt);
    for (const [a, cur] of sb.w) {
      const want = target.get(a) ?? 0;
      const w = cur + (want - cur) * k;
      if (want === 0 && w < 1e-3) { a.setEffectiveWeight(0); sb.w.delete(a); continue; }
      sb.w.set(a, w);
      a.setEffectiveWeight(w * over);
      if (sb.phase != null) { a.timeScale = 0; a.paused = false; a.time = sb.phase * a.getClip().duration; }
      else a.timeScale = 1;
    }
  }

  /** Sparse bone overrides a socket holds over its pose ({spine: [x,y,z,w]}: normalized humanoid bones, parent-local).
   *  A bone the person's own held pose or a reach names stays theirs. Null lets go. */
  setSeatHold(bones) {
    if (!bones || !Object.keys(bones).length) { if (this._seatHold) this._seatHold.want = 0; return; }
    const nodes = this._resolveBones(Object.keys(bones)).map(([n, node]) => [node, new THREE.Quaternion(...bones[n]).normalize()]);
    this._seatHold = { nodes, w: this._seatHold?.w ?? 0, want: 1 };
  }
  _applySeatHold(dt) {
    const h = this._seatHold;
    h.w += (h.want - h.w) * Math.min(1, 8 * dt);
    if (h.want === 0 && h.w < 0.01) { for (const [node] of h.nodes) { const r = this._composed.get(node); if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; } } this._seatHold = null; return; }
    const mine = new Set((this._override?.weight > 0.02 ? this._override.nodes : []).map(([, n]) => n));
    const reach = this._reachOwned();
    for (const [node, q] of h.nodes) if (!mine.has(node) && !reach?.has(node)) this._writeBone(node, [q.x, q.y, q.z, q.w], h.w);
  }

  /** What holding a thing does to this body (grabbable, client/lib/thingphysics.js): sparse normalized-bone rotations, the
   *  fingers of each holding hand (a grip's preset) and, for a body without tracked hands, the arms' hold pose. Every
   *  client sets the same from the door's hold record and the thing's component: presence, never streamed. It applies
   *  after a seat's hold (a held thing wins its hand) and yields to the person's own held pose and reach. Null lets go. */
  setHoldPose(bones) {
    const key = bones ? JSON.stringify(bones) : null;
    if (!key || key === '{}') { if (this._holdPose) this._holdPose.want = 0; return; }
    if (this._holdPose?.key === key) { this._holdPose.want = 1; return; }
    const nodes = this._resolveBones(Object.keys(bones)).map(([n, node]) => [node, new THREE.Quaternion(...bones[n]).normalize()]);
    this._holdPose = { key, nodes, w: this._holdPose?.w ?? 0, want: 1 };
  }
  _applyHoldPose(dt) {
    const h = this._holdPose;
    h.w += (h.want - h.w) * Math.min(1, 10 * dt);
    if (h.want === 0 && h.w < 0.01) { for (const [node] of h.nodes) { const r = this._composed.get(node); if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; } } this._holdPose = null; return; }
    const mine = new Set((this._override?.weight > 0.02 ? this._override.nodes : []).map(([, n]) => n));
    const reach = this._reachOwned();
    for (const [node, q] of h.nodes) if (!mine.has(node) && !reach?.has(node)) this._writeBone(node, [q.x, q.y, q.z, q.w], h.w);
  }

  /** Turn the head toward a look direction, in the BODY's frame (yaw about its up, pitch about its right, radians,
   *  + = left / up), clamped to the socket's limits and shared between neck (40%) and head (60%) — the turn a seated
   *  person makes to look round. Null lets the head go back to the clip. */
  setSeatLook(look) {
    if (!look) { if (this._seatLook) this._seatLook.want = 0; return; }
    this._seatLook = { yaw: look.yaw, pitch: look.pitch, w: this._seatLook?.w ?? 0, want: 1 };
  }
  _applySeatLook(dt) {
    const L = this._seatLook, h = this.vrm.humanoid;
    L.w += (L.want - L.w) * Math.min(1, 8 * dt);
    if (L.want === 0 && L.w < 0.01) { this._seatLook = null; return; }
    const parts = [['neck', 0.4], ['head', 0.6]].map(([n, f]) => [h?.getNormalizedBoneNode?.(n), f]).filter(([n]) => n);
    if (!parts.length) return;
    if (parts.length === 1) parts[0][1] = 1;
    this.root.getWorldQuaternion(_sl3).invert();   // world → body frame
    for (const [node, f] of parts) {
      const r = this._composeBegin(node);
      // the turn in the body frame, carried into the bone's parent frame: local = P⁻¹·T·P·local, P = body⁻¹·parentWorld
      _sl1.setFromAxisAngle(_Y2, L.yaw * f * L.w).multiply(_sl2.setFromAxisAngle(_X, -L.pitch * f * L.w));
      node.parent.getWorldQuaternion(_sl2).premultiply(_sl3);
      node.quaternion.premultiply(_sl2).premultiply(_sl1).premultiply(_sl2.invert());
      this._composeEnd(node, r);
    }
  }

  /** Which body point a socket seats (hips | feet | head): its place in the root's frame, measured from the posed
   *  skeleton every frame it is asked for, so any body in any clip lands on the socket. Null = not measured yet. */
  setAnchorWant(kind) { this._anchorWant = kind && kind !== 'root' ? kind : null; if (!this._anchorWant) this._anchorOff = null; }
  anchorOffset() { return this._anchorOff ?? null; }
  _measureAnchor() {
    const h = this.vrm.humanoid; const k = this._anchorWant;
    const bone = (n) => h?.getRawBoneNode?.(n) ?? h?.getNormalizedBoneNode?.(n) ?? null;
    let p = null;
    if (k === 'hips' || k === 'head') { const n = bone(k); if (n) p = n.getWorldPosition(_sa1); }
    else if (k === 'feet') { const l = bone('leftFoot'), r = bone('rightFoot'); if (l && r) p = l.getWorldPosition(_sa1).add(r.getWorldPosition(_sa2)).multiplyScalar(0.5); }
    if (!p) { this._anchorOff = null; return; }
    this.root.worldToLocal(p);
    // feet: the soles, not the ankles — the ankle's height above the root at rest, at this body's size
    if (k === 'feet') p.y -= (this._footRestY ?? 0) * this.vrm.scene.scale.y;
    this._anchorOff = p.toArray();
  }

  /** Move a held pose's hips translation onto the root, leaving every joint where it is in the world, for the
   *  moment a sim takes the body (its rotations-only pose would snap a kneel back to standing height). `clip: true`
   *  bakes a lowering clip's hips too (sit, lie). One convention everywhere: the root carries every drop, the hips
   *  stay at rest while limp (_park). True when something moved. */
  bakeHipsIntoRoot({ clip = false } = {}) {
    let moved = false;
    const o = this._override;
    if (o?.kind === 'pose' && o.hipsT && o.hipsNode) {
      o.hipsNode.parent.updateWorldMatrix(true, false);
      _hv.copy(o.hipsT).multiplyScalar(o.weight)
        .applyMatrix3(new THREE.Matrix3().setFromMatrix4(o.hipsNode.parent.matrixWorld));
      this._rawRelease(o.hipsNode);
      o.hipsT = null; o.hipsNode = null;
      this.root.position.add(_hv);
      moved = true;
    }
    const hips = clip ? this.vrm.humanoid?.getNormalizedBoneNode('hips') : null;
    const rest = hips && this._hipsRest();
    if (rest) {
      _hv.copy(hips.position).sub(rest);
      if (_hv.lengthSq() > 1e-8) {
        hips.parent.updateWorldMatrix(true, false);
        _hv.applyMatrix3(new THREE.Matrix3().setFromMatrix4(hips.parent.matrixWorld));
        hips.position.copy(rest);
        this.root.position.add(_hv);
        moved = true;
      }
    }
    if (moved) this.root.updateMatrixWorld(true);
    return moved;
  }

  /** The normalized hips' rest position in its parent's frame: the height every fallen body's root is measured from. */
  _hipsRest() {
    if (this.__hipsRest !== undefined) return this.__hipsRest;
    const p = this.vrm.humanoid?.normalizedRestPose?.hips?.position;
    return (this.__hipsRest = Array.isArray(p) && p.length === 3 ? new THREE.Vector3().fromArray(p) : null);
  }

  /** Go limp, or stand back up. A ragdoll drives only DRIVEN_BONES, so every other bone is parked at its rest
   *  rotation each frame after the mixer writes it (_park). The mixer keeps running: its actions are play()ed once
   *  and cross-faded by weight, and stopAllAction() would snap the skeleton to its bind pose.
   *  `bake`: your own body only (a remote's root arrives carrying its drop; bakeHipsIntoRoot). */
  setLimp(on, { bake = false } = {}) {
    on = !!on;
    if (on === this._limp) return;
    // a held pose's hips translation is baked first, handing the hips back to the clip's value for getting up
    if (on && bake) this.bakeHipsIntoRoot();
    const hipsNode = on ? this.vrm.humanoid?.getNormalizedBoneNode('hips') : null;
    const clipHips = hipsNode?.position.clone() ?? null;   // what getting up hands back
    if (on && bake) this.bakeHipsIntoRoot({ clip: true });
    this._limp = on;
    // A body with its own runtime hands the sim back the nodes it was solving (bodyruntime_core.js setLimp).
    this.bodyRuntime?.setLimp?.(this.vrm, on);
    // eyes close when the body goes slack and open when it gets up; _limpEyes remembers that WE closed them, so
    // someone who chose /eyes closed keeps them closed
    if (on) { this._limpEyes = this.setEyes(true); }
    else if (this._limpEyes) { this._limpEyes = false; this.setEyes(false); }
    // getting up is when the hair goes back to three-vrm, and when the flap captures where the sim left the wings
    if (!on) { this._releaseHair(); this._combHair(); }
    if (!on) this.wings.stoodUp();   // wings.js
    if (!on) {
      // hand the bones back as found: a still clip track would never overwrite the parked rest rotation
      for (const [node, q] of this._parked ?? []) node.quaternion.copy(q);
      this._parked = null;
      if (this._parkedHips) this._parkedHips[0].position.copy(this._parkedHips[1]);
      this._parkedHips = null;
      return;
    }
    if (this.onceAnim) this.cancelOnce();
    for (const l of this._anims ?? []) this._handBack(l);   // a falling body stops waving
    this._anims = null;
    const driven = new Set(DRIVEN_BONES);
    this._parked = this._resolveBones(
      this._humanoidBones().filter((n) => !driven.has(n)))
      .map(([, node]) => [node, node.quaternion.clone()]);
    this._parkedHips = hipsNode && clipHips && this._hipsRest() ? [hipsNode, clipHips] : null;   // the drop belongs to the root
    this._park();   // now as well as per frame, so the ragdoll about to be built reads the parked skeleton
    this.root.updateMatrixWorld(true);
  }

  _park() {
    for (const [node] of this._parked ?? []) node.quaternion.identity();
    if (this._parkedHips) this._parkedHips[0].position.copy(this._hipsRest());
  }

  // ---- composing on top of the clip. three.js writes a bone only when the clip's value changes, so a still
  // track is written once and anything composed on top would integrate. So: remember the clip's value and what we
  // left; if the bone still holds exactly what we left, put the clip's value back before composing again.
  _composeBegin(node) {
    let r = this._composed.get(node);
    if (!r) {
      r = { base: new THREE.Quaternion(), out: new THREE.Quaternion(), live: false };
      this._composed.set(node, r);
    }
    if (r.live && node.quaternion.equals(r.out)) node.quaternion.copy(r.base);
    r.base.copy(node.quaternion);
    return r;
  }
  _composeEnd(node, r) { r.out.copy(node.quaternion); r.live = true; }

  // the same guard over all three channels, per channel (vrm.update rewrites a humanoid bone's rotation, never its scale)
  _rawBegin(node) {
    this._rawComposed ??= new Map();
    let r = this._rawComposed.get(node);
    if (!r) {
      r = { bq: new THREE.Quaternion(), bp: new THREE.Vector3(), bs: new THREE.Vector3(),
        oq: new THREE.Quaternion(), op: new THREE.Vector3(), os: new THREE.Vector3(), live: false };
      this._rawComposed.set(node, r);
    }
    if (r.live) {
      if (node.quaternion.equals(r.oq)) node.quaternion.copy(r.bq);
      if (node.position.equals(r.op)) node.position.copy(r.bp);
      if (node.scale.equals(r.os)) node.scale.copy(r.bs);
    }
    r.bq.copy(node.quaternion); r.bp.copy(node.position); r.bs.copy(node.scale);
    return r;
  }
  _rawEnd(node, r) { r.oq.copy(node.quaternion); r.op.copy(node.position); r.os.copy(node.scale); r.live = true; }
  /** Hand a raw-posed bone back: every channel we still own returns to its base. */
  _rawRelease(node) {
    const r = this._rawComposed?.get(node);
    if (!r?.live) return;
    if (node.quaternion.equals(r.oq)) node.quaternion.copy(r.bq);
    if (node.position.equals(r.op)) node.position.copy(r.bp);
    if (node.scale.equals(r.os)) node.scale.copy(r.bs);
    if (!node.matrixAutoUpdate) node.updateMatrix();
    r.live = false;
  }

  /** The raw half of a held pose: rotation of non-humanoid bones, translation/scale of any bone. After vrm.update
   *  and the wings, their other authors, so a bone the pose names is the pose's. Not while limp (the sim's). */
  _applyRawPose() {
    const o = this._override;
    if (o?.kind !== 'pose' || !o.raw?.length || this._limp) return;
    const w = o.weight;
    for (const e of o.raw) {
      const rest = this._rawRest(e.node);
      if (!rest) continue;
      const r = this._rawBegin(e.node);
      if (e.q) {   // local = P⁻¹ · q · P · rest
        _hq.copy(rest.pqInv).multiply(e.q).multiply(rest.pq).multiply(rest.rq);
        e.node.quaternion.slerp(_hq, w);
      }
      if (e.t) e.node.position.addScaledVector(_hv.set(e.t[0], e.t[1], e.t[2]).applyMatrix3(rest.pinv), w);
      if (e.s) e.node.scale.multiply(_hs.set(e.s[0], e.s[1], e.s[2]).lerp(_ONE, 1 - w));
      if (!e.node.matrixAutoUpdate) e.node.updateMatrix();   // spring joints rebuild their matrices by hand
      this._rawEnd(e.node, r);
    }
  }

  _humanoidBones() { return Object.keys(this.vrm.humanoid?.humanBones ?? {}); }

  /** World positions of the humanoid bones in the neutral rest pose (every rotation identity), without disturbing
   *  the pose on screen. The ragdoll measures against this, never the live skeleton. */
  restBonePositions(names = null) {
    const h = this.vrm.humanoid;
    if (!h) return null;
    const saved = [];
    for (const name of this._humanoidBones()) {
      const node = h.getNormalizedBoneNode(name);
      if (node) { saved.push([node, node.quaternion.clone()]); node.quaternion.identity(); }
    }
    this.root.updateMatrixWorld(true);
    const out = {};
    for (const name of names ?? this._humanoidBones()) {
      const node = h.getNormalizedBoneNode(name);
      if (node) out[name] = node.getWorldPosition(new THREE.Vector3());
    }
    for (const [node, q] of saved) node.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    return out;
  }

  /** Sample one bone's target quaternion for an animation at time t (seconds). */
  _sampleTrack(keys, t, out) {
    if (t <= keys[0].t) return out.copy(keys[0].q);
    const last = keys[keys.length - 1];
    if (t >= last.t) return out.copy(last.q);
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        const f = (t - a.t) / Math.max(1e-4, b.t - a.t);
        return out.copy(a.q).slerp(b.q, f);
      }
    }
    return out.copy(last.q);
  }

  _applyOverride(dt, now) {
    // a live reach owns its bones outright this frame: the compose guard cannot tell two authors apart
    const taken = this._reachOwned();
    const posed = this._override ? this._applyPoseSlot(dt, taken) : null;
    if (this._anims?.length) {
      for (const l of this._anims) this._applyAnimSlot(l, dt, now, taken, posed);
      this._anims = this._anims.filter((l) => !l.done);
    }
  }

  /** The held pose. Returns the set of bones it wrote this frame. */
  _applyPoseSlot(dt, taken) {
    const o = this._override;
    const posed = new Set();
    o.weight += (o.wantWeight - o.weight) * Math.min(1, 12 * dt);
    if (o.wantWeight === 0 && o.weight < 0.02) {
      // hand the bones back on the way out: on a still track nothing would ever clear the last 2%
      for (const [, node] of o.nodes) {
        const r = this._composed.get(node);
        if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
      }
      if (o.hipsNode) this._rawRelease(o.hipsNode);
      for (const e of o.raw ?? []) this._rawRelease(e.node);
      this._override = null;
      return posed;
    }

    // hips translation on the normalized hips (three-vrm carries it to the raw hips), under the same compose rule
    if (o.kind === 'pose' && o.hipsNode && o.hipsT) {
      const r = this._rawBegin(o.hipsNode);
      o.hipsNode.position.addScaledVector(o.hipsT, o.weight);
      this._rawEnd(o.hipsNode, r);
    }

    if (o.kind === 'pose') {
      for (const [name, node] of o.nodes) {
        const target = o.targets.get(name);
        if (!target || taken?.has(node)) continue;
        const r = this._composeBegin(node);
        node.quaternion.slerp(target, o.weight);
        this._composeEnd(node, r);
        posed.add(node);
      }
    }
    return posed;
  }

  /** The one-off animation, over the clip and the pose. A bone the pose wrote this frame is composed onto the pose's
   *  output rather than begun afresh (which would read the pose's value as the clip's). */
  _applyAnimSlot(o, dt, now, taken, posed) {
    o.weight += (o.wantWeight - o.weight) * Math.min(1, 12 * dt);
    if (o.wantWeight === 0 && o.weight < 0.02) {
      for (const [, node] of o.nodes) {
        if (posed?.has(node)) continue;          // the pose goes on owning it
        const r = this._composed.get(node);
        if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
      }
      o.done = true;
      return;
    }
    let tt = (now - o.start) / 1000;
    if (tt >= o.dur) {
      if (o.loop) tt %= o.dur; else { o.wantWeight = 0; tt = o.dur; }
    }
    for (const [name, node] of o.nodes) {
      if (taken?.has(node)) continue;
      const r = posed?.has(node) ? this._composed.get(node) : this._composeBegin(node);
      this._sampleTrack(o.tracks.get(name), tt, o._scratch);
      node.quaternion.slerp(o._scratch, o.weight);
      this._composeEnd(node, r);
    }
  }

  /** Rename the body: the nameplate is redrawn, nothing else is touched. */
  setName(name) {
    this.id = name;
    this._labelName = name;
    this.repaintLabel();
  }
  /** This body's chosen size (bodyscale.js). True when it changed. */
  setUserScale(u) {
    const v = clampBodyScale(u);
    if (v === (this.userScale ?? 1)) return false;
    this.userScale = v; this._applyBodyScale();
    return true;
  }
  /** The VR device fit (xr.js puppetScale, 1/k), composed under the chosen size. xrbody.js is its one writer. */
  setPuppetScale(p) {
    const v = p > 0 && Number.isFinite(p) ? p : 1;
    if (v === (this._puppet ?? 1)) return false;
    this._puppet = v; this._applyBodyScale();
    return true;
  }
  /** The body's model→root multiplier: chosen size × VR fit. The seat seam (occupants.js occupantScalar) reads this. */
  bodyScale() { return (this.userScale ?? 1) * (this._puppet ?? 1); }
  _applyBodyScale() {
    const sc = this.vrm?.scene;
    if (!sc) return;
    sc.scale.setScalar(this.bodyScale());
    sc.updateMatrixWorld(true);
    this._ownClear = null;   // world units: re-measure at the new size
    // a held reach's limb lengths are in the root frame: re-measure, or a live resize keeps bending the old arm
    if (this._chains) for (const key of [...this._chains.keys()]) this._chains.set(key, measureChain(this, key));
  }
  /** Metres the nameplate hangs over the measured crown, at the authored size (bodyscale.js plateLift). 0 = auto. */
  setPlateY(m) {
    const v = clampPlateY(m);
    if (v === (this.plateY ?? 0)) return false;
    this.plateY = v; this._ownClear = null;
    return true;
  }

  /** The crown, measured once while the body is at rest (the constructor): plateanchor.js crownEstimate over the
   *  head/hips/eye bones and the skinned mesh top (≤4000 vertices a mesh), in the VRM scene's own frame so a live
   *  resize multiplies in per frame. null = nothing to measure. */
  _measurePlateRest() {
    try {
      const sc = this.vrm?.scene, h = this.vrm?.humanoid;
      if (!sc) return null;
      this.root.updateMatrixWorld(true);
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
    const r = this._plateRest, sc = this.vrm?.scene, h = this.vrm?.humanoid;
    if (!sc || !r || (r.hipsToCrown == null && r.boundsTop == null)) { this.label.position.set(0, 1.95, 0); this._plateDrop = null; return; }
    this.root.updateWorldMatrix(true, false);
    const s = sc.getWorldScale(_pScale).y || 1;   // model units → world (root scale × puppet scale)
    const gap = plateGap((r.height ?? 1.7) * s);
    const lift = plateLift(this.plateY, s);   // the wearer's own lift over the crown (Profile › Avatar), grows with the body
    this._plateDrop = gap + lift;   // plate → crown, and the head under it as a ball (_liftPlateForView)
    this._plateHeadR = r.headSpan != null ? r.headSpan * s / 2 : 0.1;
    const rootY = this.root.getWorldPosition(_pRoot).y;
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
    this.label.position.copy(this.root.worldToLocal(_pHips.set(x, rootY + this._plateOff, z)));
  }

  /** Upright in ordinary motion (plateanchor.js STAND_SLOTS) with nothing else owning the body. */
  _plateStanding() { return STAND_SLOTS.has(this.postureSlot) && !this.onceAnim && !this._override && !this._limp; }

  /** Slide the hung plate off the head for this viewer's camera (plateanchor.js plateViewLift), along the camera's
   *  up. After _placePlate and this frame's size; the pill and the bubble copy the plate after it. */
  _liftPlateForView(camera) {
    if (this._plateDrop == null) return;
    const lab = this.label, a = _lvArgs;
    this.root.updateWorldMatrix(true, false);
    this.root.localToWorld(_lvP.copy(lab.position));
    camera.getWorldPosition(_lvE); camera.getWorldQuaternion(_lvQ);
    _lvU.set(0, 1, 0).applyQuaternion(_lvQ); _lvF.set(0, 0, -1).applyQuaternion(_lvQ);
    _lvE.toArray(a.eye); _lvU.toArray(a.up); _lvF.toArray(a.fwd); _lvP.toArray(a.plate);
    a.drop = this._plateDrop; a.headR = this._plateHeadR ?? 0.1;
    a.halfH = lab.scale.x * this.root.getWorldScale(_pScale).y * (lab.userData.pillH ?? 52 / 512) / 2;   // the pill as drawn, world m
    const d = plateViewLift(a);
    if (d > 0) lab.position.copy(this.root.worldToLocal(_lvP.addScaledVector(_lvU, d)));
  }

  /** Your own plate is hidden while presenting (xr.js hideLabel) and in desktop first person (controller.js). */
  get ownPlateHidden() { return !!(this.hideLabel || this.firstPersonView); }

  /** How far this body reaches from its plate's anchor: the clearance its sprites write (platesize.js ownClearance).
   *  The body is sampled once into the VRM scene's frame; a size or fit change only re-projects the sample. A body
   *  with nothing measurable clears a head (CLEAR_MIN). */
  _measureOwnClear() {
    try {
      const sceneRoot = this.vrm?.scene;
      if (!sceneRoot) return ownClearance(0);
      this.root.updateMatrixWorld(true);
      const pts = this._ownPts ??= this._sampleOwnBody(sceneRoot);
      const out = this._ownXyz ??= new Float32Array(pts.length);
      const e = _ownM.copy(this.root.matrixWorld).invert().multiply(sceneRoot.matrixWorld).elements;
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
    const name = this._labelName ?? this.id ?? '';
    const at = this.label.position.clone();   // where the body hangs it (_placePlate); the new sprite takes the same spot
    this.root.remove(this.label);
    disposeSprite(this.label);
    this.label = makeLabel(this._seatApprox ? `${name} ≈` : name);
    this.label.position.copy(at);
    this.root.add(this.label);
  }

  /** A seated body whose profile gate is closed (occupants.js) wears a small ≈ on its nameplate. */
  setSeatApprox(on) {
    if (this._seatApprox === !!on) return;
    this._seatApprox = !!on;
    this.setName(this.id);
  }

  // ---- speech
  /** Everything transient this body was expressing (pill, bubble, held pose, limpness, gaze) belongs to the
   *  generation that expressed it, and does not ride along on a takeover. */
  resetTransients() {
    this.setTyping(null);
    this.bubbleUntil = 0;
    this.speakUntil = 0;
    this.voiceLevel = null;
    this.clearPose();
    for (const l of this._anims ?? []) this._handBack(l);
    this._anims = null;
    this.clearReach();      // a transplanted body must not keep reaching at the predecessor's target
    this.setLimp(false);
    this.setGazeTarget(null);
    this.setClip('idle');
  }

  setTyping(state) {
    // null means stop (mic went cold, composing ended)
    if (state === null) { this._typingUntil = 0; this._typingState = null; return; }
    this._typingUntil = performance.now() + 4000;
    this._typingState = state || null;
  }

  say(text) {
    // speaking ends composing, but not a live mic: the voice is still coming out of this body
    if (this._typingState !== 'mic') this._typingUntil = 0;
    if (this.bubble) { this.root.remove(this.bubble); disposeSprite(this.bubble); }
    this.bubble = makeBubble(text);
    this.bubble.position.copy(this.label.position).y += BUBBLE_LIFT;   // it rides the plate (update keeps it there)
    this.root.add(this.bubble);
    // roughly reading speed, clamped
    const ms = THREE.MathUtils.clamp(2500 + text.length * 45, 5000, 22000);
    this.bubbleUntil = performance.now() + ms;
    this.speakUntil = performance.now() + Math.min(ms, 1000 + text.length * 38);
  }

  update(dt, now = performance.now()) {
    if (this._xfade) {   // the eased crossfade (see _setAction): smoothstep in, its complement out
      const x = this._xfade; x.t += dt; const u = Math.min(1, x.t / x.dur), w = x.linear ? u : u * u * (3 - 2 * u);
      x.in.setEffectiveWeight(x.in0 + (1 - x.in0) * w); if (x.out && x.out !== x.in) x.out.setEffectiveWeight(x.out0 * (1 - w));
      if (u >= 1) { if (x.out && x.out !== x.in) x.out.setEffectiveWeight(0); this._xfade = null; }
    }
    const BC = globalThis.__ewBC ?? (() => {});
    // gesture expiry
    if (this.onceAnim && now > this.onceAnim.until) this.cancelOnce();

    if (this._sb) this._applySeatBlend(dt);   // a socket's pose: its weights (and locked times) before the mixer samples
    BC('av:mixer');
    this.mixer.update(dt);
    // a body with its own runtime takes the clip's pose whole (bodyruntime_core.js); not while limp
    if (this.bodyRuntime && !this._limp) this.bodyRuntime.afterMixer(this.vrm, this.mixer);
    // the swim overlay for a body in water without a swim clip (shared/swimpose.js); the clip is restored every
    // frame so leaving water releases the limbs
    for (const node of this._swimNodes ?? []) {
      const r=this._composed.get(node);
      if(r?.live && node.quaternion.equals(r.out))node.quaternion.copy(r.base);
    }
    this._swimNodes=[];
    if(this.locomotion?.medium==='water' && this.locomotion?.body!=='submarine' && !SWIM_CLIPS.includes(this.postureSlot) && !this._limp && !this._override && !this.onceAnim){
      for(const [name,rotation] of Object.entries(swimPose(now/1000,this.locomotion.mode==='surface'))){
        const node=this.vrm.humanoid?.getNormalizedBoneNode(name);if(!node)continue;
        const r=this._composeBegin(node);
        node.quaternion.setFromEuler(new THREE.Euler(...rotation));
        this._composeEnd(node,r);this._swimNodes.push(node);
      }
    }

    // while limp the clip keeps running (see setLimp), so the undriven bones are re-parked after every mixer write
    BC('av:park');
    if (this._limp) this._park();

    // ---- bone edits land between the mixer and vrm.update: the mixer writes the normalized bones, vrm.update copies
    // them to the raw skeleton. Head pitch: not while limp; composed so it cannot integrate.
    BC('av:head');
    if (this.head && !this._limp) {
      const r = this._composeBegin(this.head);
      if (this.pitch) {
        this.head.quaternion.premultiply(
          _pq.setFromAxisAngle(_X, THREE.MathUtils.clamp(this.pitch, -0.5, 0.6)));
      }
      this._composeEnd(this.head, r);
    }
    if (this._seatLook && !this._limp) this._applySeatLook(dt);   // a seated head turns toward the look, within the socket's limits
    BC('av:swim');
    if (this._swimW || this.postureSlot === 'swim' || this.postureSlot === 'tread') this._swimLayer(dt, now);
    BC('av:override');
    if (this._override || this._anims?.length) this._applyOverride(dt, now);
    if (this._seatHold && !this._limp) this._applySeatHold(dt);
    if (this._holdPose && !this._limp) this._applyHoldPose(dt);   // after the seat's hold: a held thing wins its hand

    // ---- reach: after the held pose (which yields any bone a reach owns), before vrm.update; not while limp
    BC('av:reach');
    if (this._reach?.size && !this._limp) this._applyReach(dt, now);
    else if (this._limp && this._reach?.size) this._reach.clear();

    // ---- gaze: ease the target so eyes track instead of snapping
    if (this._hasGaze) this.gaze.position.lerp(this.gazeGoal, 1 - Math.exp(-6 * dt));
    else {
      _v.set(0, 1.5, 3).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.root.rotation.y)
        .add(this.root.position);
      this.gaze.position.lerp(_v, 1 - Math.exp(-3 * dt));
    }

    // ---- blink: irregular, in pairs sometimes. The clock runs whether or not this body has expressions.
    let blinkV = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const k = this.blinkT / Math.max(0.05, BLINK.dur);
      blinkV = k < 1 ? Math.sin(k * Math.PI) : 0;
      if (k >= 1) {
        this.blinkT = -1;
        // scheduled from the end of the blink, so a pair gap shorter than a blink can't chain
        const rate = Math.max(0.15, BLINK.hz);
        this.blinkAt = now + (Math.random() < 0.22 ? 220
          : (2200 + Math.random() * 4200) / rate);
      }
    } else if (now > this.blinkAt) {
      this.blinkT = 0;
    }
    // ---- eyeballs: point them at the same target the gaze eases to
    if (this._eyes === undefined) this._findEyes();
    if (this._eyes && this.head) {
      this.head.getWorldQuaternion(_gq);
      _gf.set(0, 0, 1).applyQuaternion(_gq);          // where the head faces NOW
      for (const e of this._eyes) {
        e.node.getWorldPosition(_gp);
        _gw.copy(this.gaze.position).sub(_gp);
        if (_gw.lengthSq() < 1e-10) continue;
        _gw.normalize();
        _gd.setFromUnitVectors(_gf, _gw);             // the world-space turn
        const ang = 2 * Math.acos(Math.min(1, Math.abs(_gd.w)));
        if (ang > BLINK.eyeMax) {                     // clamp into a cone
          _gi.identity().slerp(_gd, BLINK.eyeMax / ang);
          _gd.copy(_gi);
        }
        // local = parentWorld⁻¹ · turn · parentWorld · rest
        e.node.parent.getWorldQuaternion(_gpq);
        _gi.copy(_gpq).invert().multiply(_gd).multiply(_gpq).multiply(e.rest);
        e.node.quaternion.copy(_gi);
      }
    }

    // ---- eyelids as bones: rotated from their captured rest by the blink curve, or the eased held state
    if (this._lids === undefined) this._findLids();
    this._eyesShut = this._eyesShut ?? 0;
    const goal = this._eyesGoal ?? 0;
    if (this._eyesShut !== goal) {
      this._eyesShut += (goal - this._eyesShut) * (1 - Math.exp(-12 * dt));
      if (Math.abs(goal - this._eyesShut) < 0.002) this._eyesShut = goal;
    }
    if (this._lids) {
      // a held close and a blink share the lids: whichever is further shut wins
      const amt = Math.max(blinkV, this._eyesShut ?? 0);
      for (const l of this._lids) {
        l.node.quaternion.copy(l.rest);
        // the rig's own exported limit wins; BLINK.closed is the dial otherwise
        const shut = l.exported ?? (l.lower ? BLINK.lower : BLINK.closed);
        if (amt > 0) {
          const ax = BLINK.axis === 1 ? _Y2 : BLINK.axis === 2 ? _Z2 : _X;
          l.node.quaternion.multiply(_pq.setFromAxisAngle(ax, shut * amt));
        }
      }
    }

    const em = this.vrm.expressionManager;
    if (em) {
      em.setValue('blink', blinkV);
      // mouth: a real amplitude (live mic) drives the jaw, smoothed open-fast close-slow; otherwise a syllable-rate
      // envelope for the utterance
      if (this.voiceLevel != null) {
        const target = Math.min(1, this.voiceLevel * 3.2);
        const k = target > this._mouth ? 0.55 : 0.18;
        this._mouth += (target - this._mouth) * k;
        em.setValue('aa', this._mouth * 0.8);
      } else if (now < this.speakUntil) {
        const t = now / 1000;
        const env = 0.5 + 0.5 * Math.sin(t * 17) * Math.sin(t * 7.3);
        em.setValue('aa', Math.max(0, env) * 0.65);
        this._mouth = 0;
      } else { em.setValue('aa', 0); this._mouth = 0; }
    }

    BC('av:gaze-expr');
    // One author per bone for the hair: while ammodoll owns the Hair_* bones (__simHair) the springBoneManager is
    // suppressed for the frame, or its write inside vrm.update would win. The whole manager, so a skirt or tail
    // freezes too while limp. Anything that ends a tumble without setLimp releases it here.
    if (this.__simHair && !this._limp) { this._releaseHair(); this._combHair(); }
    this._springsLimp(this._limp && !this.__simHair);   // a limp body with no sim hangs its hair on the world
    const sbm = this.__simHair ? this.vrm.springBoneManager : null;
    if (sbm) this.vrm.springBoneManager = null;
    this.onBeforeVrmUpdate?.(dt);   // the seam for tracked-body writes (xrbody.js): posed, not yet copied to raw
    // the body runtime's own limits get the final word over every writer above (bodyruntime_core.js)
    if (this.bodyRuntime && !this._limp) { BC('av:body-runtime'); this.bodyRuntime.beforeVrmUpdate(this.vrm, dt); }
    this.vrm.update(dt);
    if (sbm) this.vrm.springBoneManager = sbm;
    if (this._anchorWant) this._measureAnchor();   // the posed anchor (hips/feet/head) where the seat put the root

    // ---- wings, after vrm.update: wing bones are raw, but their parent clavicle only gets this frame's pose in
    // vrm.update. While limp they belong to the sim.
    this.wings.update(dt);   // wings.js
    // the held pose's raw bones — last, so it wins every bone it names
    if (this._override) this._applyRawPose();

    // ---- the lamp breathes on BREATH (shared/breath.js), the wing idle's period, so lamp and wings rise together:
    // |sin|^LAMP_SHAPE at half the angular rate. The emissive surface and the cast light move together.
    if (this._lampMats === undefined) {
      this._lampMats = [];
      this.vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m?.emissiveIntensity !== undefined && /lampglass/i.test(m.name || '')) {
            // ?? not ||: an authored emissiveIntensity of ZERO is a deliberate value
            this._lampMats.push({ m, base: m.emissiveIntensity ?? 1 });
          }
        }
      });
    }
    if (this._lampMats.length) {
      const phase = (now / 1000) * (Math.PI / BREATH);
      const breath = Math.abs(Math.sin(phase)) ** LAMP_SHAPE;
      // the sky dims the surface on lightrig's curve (glowScale), floored so it stays present in full sun
      const day = LAMP_DAY_FLOOR + (1 - LAMP_DAY_FLOOR) * glowScale();
      const k = (LAMP_FLOOR + (LAMP_PEAK - LAMP_FLOOR) * breath) * day;
      for (const { m, base } of this._lampMats) m.emissiveIntensity = base * k;
      // the cast gets the breath only: lightrig applies its own day curve to a dayAware request
      for (const { key, intensity } of this._lamps) {
        updateRequest(key, { intensity: intensity * (LAMP_FLOOR
          + (LAMP_PEAK - LAMP_FLOOR) * breath) });
      }
    }

    // ---- contact shadow: on the surface under the body, shrinking and fading with the gap
    if (this.shadow) {
      const rp = this.root.position;
      const gy = surfaceUnder(rp.x, rp.z, heightAt, rp.y + 0.05).y;
      const gap = Math.max(0, rp.y - gy);
      this.shadow.position.y = (gy - rp.y) + 0.02;
      const k = THREE.MathUtils.clamp(1 - gap / 3, 0, 1);
      this.shadow.scale.setScalar((0.55 + 0.45 * k) * (this.userScale ?? 1));   // a bigger body throws a bigger blob
      this.shadow.material.opacity = k * k;
      this.shadow.visible = k > 0.02;
    }

    BC('av:plates');

    // ---- nameplate: sized and faded by distance (platesize.js), depth-tested but cleared of its own body (PLATE_DEPTH);
    // while names are held (namereveal.js) it comes through everything
    const d = this.root.position.distanceTo(camera.getWorldPosition(_plateEye));   // WORLD: in XR camera.position is rig-local
    const rk = revealLevel();
    const { lw, vis } = plateSize(d, rk);
    this._placePlate(dt);   // hang it from the body first: the clearance below is measured from where it hangs
    if (this._ownClear == null) this._ownClear = this._measureOwnClear();
    this.label.userData.plateClear = plateClear(this._ownClear, d, rk);
    this.label.material.opacity = vis;
    const ownHidden = this.ownPlateHidden;
    this.label.visible = vis > 0.02 && !ownHidden;
    this.label.scale.set(lw, lw * (this.label.userData.aspect ?? 64 / 512), 1);   // scale carries the aspect: the text keeps its size whatever the canvas height
    this._liftPlateForView(camera);   // after the size (the lift clears the pill as drawn), before what hangs off the plate

    if (this.bubble) {
      if (now > this.bubbleUntil) {
        this.root.remove(this.bubble); disposeSprite(this.bubble); this.bubble = null;
      } else {
        this.bubble.position.copy(this.label.position).y += BUBBLE_LIFT;   // follows the plate down when they sit or lie
        this.bubble.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
        this.bubble.visible = !ownHidden;
      }
    }

    // ---- typing dots: a composing pill hides behind a bubble; a live mic stacks above it instead
    const micLive = this._typingState === 'mic';
    const typingNow = now < this._typingUntil && (micLive || !this.bubble);
    if (typingNow && !this.typing) { this.typing = makeTypingSprite(); this.root.add(this.typing); }
    if (this.typing) this.typing.position.copy(this.label.position).y += (micLive && this.bubble) ? TYPING_OVER_BUBBLE : TYPING_LIFT;
    // the pill sits above the plate's anchor: its own reach is the plate's plus the lift (triangle inequality); not revealed
    if (this.typing) this.typing.userData.plateClear = this._ownClear + Math.abs(this.typing.position.y - this.label.position.y);
    if (this.typing) {
      this.typing.visible = typingNow && !ownHidden;
      if (typingNow) {
        if (now - this._typingDrawAt > 110) {
          this._typingDrawAt = now;
          drawTypingDots(this.typing, now / 1000, this._typingState);
          if (globalThis.__pillDebug) globalThis.__pillLast = { id: this.id, state: this._typingState, t: now };
        }
        this.typing.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
      }
    }
  }

  // Everything per-body dies here. The VRM instance is not disposed: the pool owns that (assets.js releaseVRM), and
  // deep-disposing a body that then pools gives a black avatar.
  dispose() {
    liveAvatars.delete(this);
    // idempotent: a second dispose() after the VRM was re-worn would release a worn body into the pool
    if (this._disposed) return;
    this._disposed = true;
    releaseOwner(this._lampOwner);
    // the breath writes emissiveIntensity every frame and the pool touches no materials: a body pooled mid-breath
    // would come back dimmer, below the attachLamps threshold
    for (const { m, base } of this._lampMats ?? []) m.emissiveIntensity = base;
    scene.remove(this.root);
    scene.remove(this.gaze);
    if (this.bubble) disposeSprite(this.bubble);
    if (this.typing) disposeSprite(this.typing);
    disposeSprite(this.label);
    // the pool resets humanoid bones, not custom-bone transforms or scale: return every raw channel we still own
    for (const node of this._rawComposed?.keys() ?? []) this._rawRelease(node);
    this._rawComposed?.clear();
    this.bodyRuntime?.dispose?.(this.vrm);
    this.mixer.stopAllAction();
    this._composed.clear();
    releaseVRM(this.vrm);
  }
}

// ---------------------------------------------------------------- shadows: a blob under the feet
let blobTex = null;
function makeBlobShadow() {
  if (!blobTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    blobTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 1.15).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }),
  );
  m.position.y = 0.02;
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------- factory

/** The body of last resort (capsulebody.js): a real Avatar over a capsule puppet — labels, gestures, the XR arm
 *  solver and the wire all work on it. Never throws; never touches the network. */
export function makeCapsuleAvatar(id) {
  const av = new Avatar(id, makeCapsuleVrm(), {});
  av.isCapsule = true;
  // the standard clips, best-effort (the capsule exists because the network may be gone)
  (async () => {
    for (const slot of CORE_CLIPS) {
      try { const clip = await clipFor(av.vrm, slot); if (av._disposed) return;   // a remote disposed on takeover: stop feeding a dead body
        const a = av.mixer.clipAction(clip); a.enabled = true; a.setEffectiveWeight(0); a.play(); av.actions[slot] = a; }
      catch (e) { console.warn(`capsule clip ${slot} unavailable`, e); }
    }
    if (av._disposed) return;
    av.setClip(av.currentSlot ?? 'idle');
    av.hydrateClips().catch(() => {});
  })();
  return av;
}
export async function makeAvatar(id, libPath, { full = false, urgent = false } = {}) {
  loadTrack(`avatar:${id}`, `${id} materializing`);
  const work = beginWork(`avatar ${id}`);
  const priority = urgent ? 2 : 1;   // your body outranks everything; any body outranks every object
  try {
    const slots = full ? CLIP_SLOTS : CORE_CLIPS;
    work.phase('body');
    const [vrm] = await Promise.all([loadVRM(libPath, { priority }), ...slots.map(vrmaBytes)]);
    // a body with its own runtime (its def's `runtime`: bodyruntime.js) is set up at load, before anything poses it
    const bodyDef = await bodyDefFor(libPath).catch(() => null);
    const bodyRuntime = await bodyRuntimeFor(libPath, (m, e) => report(`${id} ${m}`, e), bodyDef);
    bodyRuntime?.init(vrm);
    capEmissive(vrm, bodyDef?.def?.emissiveMax);   // before the lamps are inferred from it (the Avatar constructor)
    work.phase('clips');
    const clips = {};
    for (const slot of slots) { // sequential: each may be a VRMA parse (once ever, cached)
      try { clips[slot] = await clipFor(vrm, slot, { priority }); } catch (e) { report(`clip ${slot}`, e); }
    }
    work.phase('compile');
    if (vrmWarmed(vrm)) {
      loadNote(`avatar ${id}: compile skipped — pooled body, pipelines already warm`);
    } else {
      // through the warm conductor (warmqueue.js), mesh by mesh with a frame between: the body's MToon set in one
      // gulp is a compile stall. frustumCulled off defeats the compile walk's culling while the body is detached.
      await warm(`avatar ${id}`, async () => {
        const meshes = [];
        vrm.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
        for (const mesh of meshes) {
          const culled = mesh.frustumCulled;
          mesh.frustumCulled = false;
          try { await renderer.compileAsync(mesh, camera, scene).catch(() => {}); }
          finally { mesh.frustumCulled = culled; }
          await nextFrame();
        }
      }, { p: urgent ? P_GATE : undefined });
      markVrmWarmed(vrm);
    }
    const av = new Avatar(id, vrm, clips, { lamps: bodyDef?.def?.lamps !== false });
    av.bodyRuntime = bodyRuntime;
    if (!full) av.hydrateClips();   // the rest arrives behind you; remote bodies too
    return av;
  } finally { loadDone(`avatar:${id}`); work.end(); }
}

export { angleDelta };
