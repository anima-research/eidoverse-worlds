// avatar — a body in the world: VRM, clip set, nameplate, speech bubble, and
// the small autonomic behaviours that make a puppet read as present (gaze,
// blink, head pitch, mouth movement while speaking).

import { THREE, scene, camera, renderer, report, angleDelta } from './core.js';
import { measureChain, solveChain } from './reachbone.js';
import { REACH_CHAINS } from '../../shared/joints.js';
import {
  loadVRM, clipFor, vrmaBytes, loadTrack, loadDone,
  CLIP_SLOTS, CLIP_SPEED, releaseVRM, vrmWarmed, markVrmWarmed,
} from './assets.js';
import { beginWork, enqueue, idleYield, nextFrame, loadNote } from './loadwork.js';
import { warm } from './warmqueue.js';
import { heightAt } from './terrain.js';
import { surfaceUnder } from './colliders.js';
import { DRIVEN_BONES } from './ragdoll.js';
import { stroke as strokeIcon } from './icons.js';
import { SEAT_CLIP_FILE } from './seatcore.js';

// The clip library is ~1.9MB PER SLOT. Waiting for all seven before a body
// could exist put 13MB between a person and their own legs — the single
// largest chunk of a cold boot, spent on animations most arrivals don't use in
// the first minute (nobody lands mid-climb). So a body is born able to stand
// and walk, and learns the rest while you're already moving.
// How far an upper lid swings to shut, in radians about its own X, when the rig
// exports no limit of its own. Signed: which way is "closed" depends on how the
// lid bone was rolled, so this is a dial, not a constant of nature — the first
// guess here blinked mythos UPWARD, which is the other 50%.
export const BLINK = {
  closed: 1.2,   // radians — 69 deg, found on the slider against her own lids
  hz: 1,         // blink-rate multiplier
  // Which AXIS a lid swings about is a property of how the bone was rolled, and
  // Blender's bone axes are not glTF's — a lid that shuts about X in Blender may
  // need Y or Z here. 0=x 1=y 2=z. Rotating about the wrong one sweeps the lid
  // sideways instead of down, which looks like an eye you can see straight
  // through however far you close it.
  axis: 0,
  lower: -0.35,  // the LOWER lid's share, signed and usually opposite. An upper
                 // lid alone does not shut an eye: it covers the top and leaves
                 // the sclera and iris showing under it, which is why a "closed"
                 // eye read as a white eyeball with a dark dot.
  eyeMax: 0.42,  // radians an eyeball may turn off the head's forward (~24 deg).
                 // Human eyes reach further, but a doll whose eyes track hard
                 // reads as staring; the head is meant to do most of the work.
  dur: 0.28,     // seconds for a full close-and-open. 0.13 was the original and
                 // it is barely perceptible: a real blink is 100-150ms of
                 // CLOSING plus the reopen, and this curve covers both halves.
};

// Wings, when a rig has them: [LR]_Wing_(Upper|Lower)[_<n>]. Four chains hung
// off the clavicles — an upper pair and a lower pair per side — each as long as
// the rig cares to make it (mythos went from two bones to three on 08-17;
// nothing here counts them).
//
// The flap is PROCEDURAL rather than a clip, for two reasons. A VRMA clip can
// only address humanoid bones, and these are not humanoid; and the wings have
// to be able to stop being driven the instant the body goes limp, which a
// running clip cannot do without a second blend tree. Driving the raw bones
// directly costs nothing and makes limpness a one-line handover to the sim.
//
// The axis is the BODY'S FORWARD, not the bone's own X/Y/Z: bone roll out of
// Blender is arbitrary (the eyelids cost a day over exactly this), so rotating
// about a local axis would flap one rig and swipe sideways on the next. About
// the forward axis, "up" is up for any wing that points outward, and the two
// sides differ only by sign.
export const WING_IDLE = {
  deg: 15,       // half-amplitude at the shoulder. A resting bird's wings barely
                 // move; this is an IDLE, not flight, and the first value big
                 // enough to see (28) read as an animal trying to take off.
  hz: 0.42,      // full flaps per second — "slowly", and slow enough that the
                 // sine never looks like a loop.
  bias: 0,       // degrees of permanent lift added to the flap, both sides. A
                 // dial for resting the wings higher or lower than the rig's
                 // rest pose without editing the blend.
  tip: 0.65,     // the outer segment's share of the amplitude. Two segments
                 // rotating as one plank is the difference between a wing and a
                 // door; the tip carrying less than the root gives it a curve.
  lag: 0.16,     // cycles the outer segment trails the inner by. This is the
                 // whole reason a wing reads as membrane rather than board — the
                 // tip is still going up as the shoulder starts down.
  sync: true,    // upper and lower pairs share one phase. False gives the lower
                 // pair a half-cycle offset (they beat against each other, which
                 // is an insect, not a bird).
  recover: 0.55, // seconds to slerp back into the flap after a ragdoll, out of
                 // whatever pose the body was left in.
  // ---- the SWEEP: how far the tips travel FORWARD and BACK.
  //
  // Rotating about the forward axis alone confines every tip to the plane
  // across the body — up, down and inboard, and nothing fore or aft. That is a
  // hinge, and it reads as one. A real wing also sweeps: the tip goes forward
  // as it comes down and back as it rises, so the path is an ellipse rather
  // than an arc, and it is the sweep that makes a flap look like it is moving
  // air rather than waving.
  //
  // Applied as a second rotation about the body's UP axis, mirrored the other
  // way from the flap (both wings must sweep forward together, and the two
  // sides point opposite ways along the span).
  sweep: 9,        // degrees fore/aft at the shoulder
  sweepPhase: 0.25, // cycles the sweep leads the flap by. A QUARTER turn is
                    // what opens the arc into an ellipse; at 0 the two
                    // rotations peak together and the path stays a straight
                    // diagonal line, just a tilted hinge.
};

// THE POWER STROKE — what the same wings do when they are holding a body up.
//
// Every dial here is WING_IDLE's, so the two sets interpolate term by term and
// `_flap` needs no second code path: `wingEffort` in [0,1] crossfades between
// them and everything downstream (lag, taper, sweep, the limp handover) is
// unchanged. Janus, having finally seen himself fly: "can we add a more
// dramatic wing flap animation for when taking off (that should be several,
// while rising) and flapping wings to move up?"
//
// "Several, while rising" is the shape of the thing. A launch is not one beat
// and not a steady cruise -- it is a burst that the climb pays for -- so the
// EFFORT is driven by the flight state (controller.js), not by a timer here:
// full through the launch impulse, full while Space is held, and decaying back
// to the idle whenever she is only gliding. The animation follows the physics
// instead of running beside it.
export const WING_POWER = {
  deg: 46,       // a real downstroke. 15 is a bird sitting on a branch; this is
                 // the same wing doing work, and at the tip the taper and the
                 // root's own rotation compound it well past 46.
  hz: 2.1,       // five times the idle. Fast enough to read as effort, slow
                 // enough that the lag below still separates tip from shoulder
                 // -- past ~3Hz the whole chain blurs into one shape.
  bias: -8,      // the stroke sits LOW: a power flap drives down from above,
                 // so the arc is centred below the rest pose rather than on it.
  tip: 0.78,     // the tip carries more of the stroke than at idle (0.65) --
                 // under load a wing straightens out along its span instead of
                 // curling, and the extra carry is what sells the push.
  lag: 0.22,     // and trails further behind the shoulder, because the membrane
                 // is being dragged through air that is pushing back.
  sync: true,
  recover: 0.55, // unchanged: this is the ragdoll handover, not the flap.
  sweep: 17,     // nearly double. The ellipse is what makes a flap look like it
                 // moves air rather than waving, and moving air is the entire
                 // claim a power stroke makes.
  sweepPhase: 0.25,
};

/** Blend two wing dial sets. Numbers interpolate; everything else takes the
 *  idle's value, since `sync` is a mode rather than a magnitude and `recover`
 *  belongs to the ragdoll handover, which is not a thing you can be halfway
 *  through being. Scratch object reused: this runs per frame, per body. */
const _wmix = {};
function mixWings(a, b, t) {
  for (const k of Object.keys(a)) {
    const av = a[k], bv = b[k];
    _wmix[k] = (typeof av === 'number' && typeof bv === 'number') ? av + (bv - av) * t : av;
  }
  return _wmix;
}

/** What a limp body's springbones become, when no sim of its own is running.
 *  Live: the debug panel dials these, and they take effect on the next body to
 *  go limp. stiffness is a FACTOR on whatever the rig declared; gravity is a
 *  floor, so a chain that already falls harder keeps its own value. */
export const LIMP_SPRINGS = {
  stiffness: 0.2,   // give way — the rest shape was authored for standing up
  gravity: 0.45,    // ...and let the world win instead
};

const CORE_CLIPS = ['idle', 'walk'];
const LATER_CLIPS = CLIP_SLOTS.filter((s) => !CORE_CLIPS.includes(s));
// Until a clip arrives, the nearest thing that HAS arrived stands in. Silently
// playing nothing would read as a bug; walking when you meant to run reads as
// the world catching up.
const CLIP_FALLBACK = {
  run: 'walk', jump: 'idle', climb: 'walk',
  sit: 'idle', lie: 'idle', sitchair: 'sit',
  // A body with no flight clips still flies -- it just glides in its idle
  // pose rather than falling back to a stride, which was the goofy part.
  fly: 'soar', soar: 'idle',
};

// Emote slots are loaded lazily — a body needs locomotion to exist, but it
// doesn't need to know how to dance until someone dances.
export const EMOTES = {
  wave: 'raise', cheer: 'cheer', dance: 'dance', salute: 'salute',
  point: 'reach', clap: 'fist', talk: 'talk', flail: 'crazy',
};
export const EMOTE_ORDER = ['wave', 'cheer', 'dance', 'point', 'salute', 'clap'];
// Seated postures differ by what you're sitting ON — the ground clip on a
// chair leaves you cross-legged in mid-air.
export const SEAT_CLIPS = { ground: 'sitting_on_ground', chair: SEAT_CLIP_FILE };

// ---------------------------------------------------------------- sprites

function textSprite(draw, w, h, scaleW) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(scaleW, scaleW * h / w, 1);
  s.renderOrder = 99;
  return s;
}
const disposeSprite = (s) => { s.material.map?.dispose(); s.material.dispose(); };

const makeLabel = (name) => textSprite((ctx) => {
  ctx.font = 'bold 40px ui-monospace, monospace';
  ctx.textAlign = 'center';
  const w = Math.min(500, ctx.measureText(name.slice(0, 24)).width + 40);
  ctx.fillStyle = 'rgba(6,16,22,0.62)';
  ctx.beginPath(); ctx.roundRect((512 - w) / 2, 6, w, 52, 12); ctx.fill();
  ctx.fillStyle = '#8fe8c8';
  ctx.fillText(name.slice(0, 24), 256, 46);
}, 512, 64, 0.9);

function wrap(text, n) {
  const words = String(text).split(/\s+/);
  const lines = ['']; let cur = 0;
  for (const w of words) {
    if ((lines[cur] + ' ' + w).trim().length > n) { lines.push(w); cur++; }
    else lines[cur] = (lines[cur] + ' ' + w).trim();
  }
  return lines;
}
// Speech cap is 4000 chars; a bubble that tries to show all of it is a wall.
// The bubble shows an opening, the chat log holds the whole thing — and now
// says so, instead of trailing off into an unexplained ellipsis.
const BUBBLE_LINES = 8;
function makeBubble(text) {
  const all = wrap(text, 38);
  const clipped = all.length > BUBBLE_LINES;
  const lines = clipped ? all.slice(0, BUBBLE_LINES) : all;
  if (clipped) lines.push('▾ more in chat');
  const h = 30 + lines.length * 34;
  return textSprite((ctx) => {
    ctx.font = '27px ui-monospace, monospace';
    // conform to the actual text (R, in-world 13:27): box hugs the widest
    // wrapped line; the old fixed 700 stays as the ceiling
    const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = Math.min(700, Math.ceil(wMax) + 44);
    ctx.fillStyle = 'rgba(8,20,28,0.86)';
    ctx.strokeStyle = 'rgba(143,232,200,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect((704 - w) / 2, 2, w, h - 4, 16); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      ctx.fillStyle = clipped && i === lines.length - 1 ? '#8ba39c' : '#e8f4ef';
      ctx.fillText(l, 352, 38 + i * 34);
    });
  }, 704, Math.max(64, h), 2.4);
}

// ---- typing indicator ------------------------------------------------------
// A small pill of pulsing dots above the head — the universal "composing"
// signal. Drawn on its own canvas so it can animate; redrawn only while
// actually typing and at a throttled rate, so a stage full of thinkers costs
// almost nothing. Gives way to the speech bubble the moment they speak.
function makeTypingSprite() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 56;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(0.5, 0.5 * 56 / 128, 1);
  s.renderOrder = 99;
  s.userData.ctx = c.getContext('2d');
  return s;
}
// Social affordance glyphs (R's ask, in-world 13:36): what is this agent's
// attention doing right now? ear = your speech will reach it; think = a reply
// is being composed; tool = mid-task, hands busy — wait or ping, your call.
// mic = this body's voice is LIVE in the room right now (R, 23:30) — the
// megaphone is presence, not a message: it says listen, sound is coming from
// here, independent of whether any words have been transcribed yet.
// Attention icons come from the shared Lucide registry (icons.js) — never
// from emoji: canvas fillText paints nothing when a glyph is missing, silently.
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
    // mic gets sound arcs on top: the icon says "a voice", the arcs say "NOW"
    if (state === 'mic') {
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
      ctx.fillStyle = `rgba(180,240,216,${b})`;
      ctx.beginPath(); ctx.arc(48 + i * 16, 28, 5, 0, Math.PI * 2); ctx.fill();
    }
  }
  sprite.material.map.needsUpdate = true;
}

// ---------------------------------------------------------------- Avatar

const _v = new THREE.Vector3();
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
const _gq = new THREE.Quaternion();        // gaze scratch — hot path, no allocs
const _gd = new THREE.Quaternion();
const _gi = new THREE.Quaternion();
const _gpq = new THREE.Quaternion();
const _gf = new THREE.Vector3();
const _gw = new THREE.Vector3();
const _gp = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);      // scratch — hot paths must not allocate
const _v2 = new THREE.Vector3();
const _wq = new THREE.Quaternion();        // wing scratch
const _wpq = new THREE.Quaternion();
const _wacc = new THREE.Quaternion();
const _wr = new THREE.Quaternion();
const _wax = new THREE.Vector3();
const _wup = new THREE.Vector3();
const _wsw = new THREE.Quaternion();
const DEG = Math.PI / 180;

export class Avatar {
  constructor(id, vrm, clips) {
    this.id = id;
    this.vrm = vrm;
    this.root = new THREE.Group();
    this.root.userData.isBody = true;   // so the sky's scene-diff never claims a person
    this.root.add(vrm.scene);
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = {};
    this.extraClips = new Map(); // lazily-loaded emote actions
    for (const [slot, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true; a.setEffectiveWeight(0); a.play();
      this.actions[slot] = a;
    }
    this.current = null;
    this.currentSlot = null;
    this.emote = null;             // { action, until }
    this.setClip('idle');

    this.bubble = null;
    this.bubbleUntil = 0;
    this.speakUntil = 0;           // drives the fake viseme envelope
    this.voiceLevel = null;        // 0..1 real amplitude when a waveform exists
    this._mouth = 0;               // smoothed jaw, so the mouth has inertia
    this.typing = null;            // lazily-built dots sprite
    this._typingUntil = 0;         // typing signals repeat ~2.5s and expire ~4s
    this._typingDrawAt = 0;
    this.label = makeLabel(id);
    this.label.position.y = 1.95;
    this.root.add(this.label);

    // ---- gaze: VRM ships a lookAt rig and nothing was ever pointing it, so
    // every body in the world had dead eyes. A target object per avatar,
    // moved each frame toward whatever deserves attention.
    this.gaze = new THREE.Object3D();
    this.gaze.userData.isBody = true;
    scene.add(this.gaze);
    this.gazeGoal = new THREE.Vector3();
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;

    this.blinkAt = performance.now() + 1200 + Math.random() * 3600;
    this.blinkT = -1;
    this.head = vrm.humanoid?.getNormalizedBoneNode?.('head') ?? null;
    this.pitch = 0;                // radians, applied post-update
    this._limp = false;            // see setLimp: the mixer yields to the sim
    this._composed = new Map();    // node -> clip base + what we last wrote
    this.shadow = makeBlobShadow();
    this.root.add(this.shadow);

    scene.add(this.root);
  }

  /** Find the eyeball bones once. VRM ships a lookAt rig and three-vrm drives
   *  it — but only if the file HAS one, and this rig has hand-rigged bones
   *  instead: L_Eye / R_Eye. Same gaze target either way. */
  _findEyes() {
    this._eyes = null;
    if (!this.vrm?.scene) return;
    // DEFER to three-vrm when the rig maps its eyes properly. import-tripo-avatar
    // (#120) now maps L_Eye/R_Eye to VRM leftEye/rightEye, which gives the stock
    // lookAt rig those bones — and this.gaze is already its target. Driving them
    // from here as well would be two writers on one bone every frame, and the
    // one that lost would be whichever ran second. Bone-rigged eyes with no VRM
    // mapping (anything imported before that landed) still need us.
    if (this.vrm.lookAt && this.vrm.humanoid?.getNormalizedBoneNode?.('leftEye')) return;
    const found = [];
    this.vrm.scene.traverse((o) => {
      if (/^[LR]_Eye$/.test(o.name ?? '')) found.push({ node: o, rest: o.quaternion.clone() });
    });
    if (found.length) this._eyes = found;
  }

  /** Give the hair back to three-vrm, resuming from where the tumble left it.
   *
   *  Not a reset. springBoneManager.reset() restores every joint's
   *  _initialLocalRotation (three-vrm.module.js:5353) — the combed pose — which
   *  is a visible snap, and calling it when the doll disposed is what made the
   *  hair jump back to default a few seconds into every fall.
   *
   *  What is wanted is the other half of reset(): the tail state re-derived
   *  from the CURRENT world matrices, so the springs pick up smoothly with no
   *  stored velocity, keep the dishevelled shape, and comb it out over the next
   *  second the way they would if you had just been shoved. There is no public
   *  call for that half alone, so the rest rotation is pointed at the pose the
   *  hair is ALREADY in for the duration of the call — making the restore a
   *  no-op — and then put straight back, so the springs still pull toward the
   *  authored shape afterwards rather than freezing the crumple in forever.
   */
  _releaseHair({ adopt = false } = {}) {
    if (!this.__simHair) return;
    this.__simHair = false;
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints) return;
    this.vrm.scene?.updateMatrixWorld?.(true);
    // The authored spring rest, remembered ONCE, so adopting a fallen shape is
    // always reversible and can never ratchet.
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

  /** Springbone settings for a body that is LIMP and has no sim of its own.
   *
   *  three-vrm's springbones are tuned for a body that is standing up: the
   *  droop is modelled into the rest shape, so gravityPower is near zero
   *  (0.01-0.03) while stiffness is 0.35-1.3. Stiffness pulls each joint toward
   *  its rest DIRECTION, and that direction rotates with the body — so on a
   *  body lying on its side the hair is pulled sideways and world gravity is
   *  far too weak to argue. That is "the direction of gravity pulling the hair
   *  seems wrong", and it is not a bug in the springbones; it is a rest shape
   *  being applied in a pose it was never authored for.
   *
   *  A body that cannot hold its own head up cannot hold its hair up either.
   *  While limp and unowned, stiffness gives way and gravity takes over. The
   *  originals are restored on standing, so nothing accumulates.
   *
   *  This runs only where NO local sim owns the dressing — remotes, and the
   *  gap after a doll disposes. Where Bullet runs it already uses real world
   *  gravity and none of this applies.
   *
   *  CONFIRMED IN THE WORLD, 08-17. A 20s sample of a real drag showed Bullet
   *  owning the hair for 96% of it, from which the first read was that this
   *  could not be what "sideways while dragging" meant — and that was a
   *  misreading of WHICH INSTANTS were being described. Grabbing, letting go,
   *  pinning, and the fall afterwards are all springbone moments, and they are
   *  what the report was about. Dropping the center made all of it much
   *  better — but NOT completely: Janus still sees sideways hair
   *  occasionally, "significantly less often". So this is a large fix to a
   *  real cause, not the whole cause, and the remainder is an open thread
   *  (rigtest/EIDOVERSE-DEPLOY.md).
   *
   *  Two lessons, and neither is about hair. The 96% answered a question
   *  nobody had asked while the 4% was most of the story — a statistic can be
   *  accurate and still be about the wrong thing. And "confirmed fixed" was
   *  written here one report too early: better is not gone.
   */
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
      // ...AND THE HAIR LIVES IN THE WORLD, not in the hips.
      //
      // `center` is why hair does not sweep back when you walk: the tail state
      // is stored in the hips' frame, so pure locomotion moves hair and body
      // together and the springs never see it. Exactly the same property is
      // wrong for a body being carried: rotate it and the hair rotates
      // RIGIDLY with it, because in hip space nothing happened. That is
      // Janus's "drag it in one orientation and then the orientation changes",
      // and "when it falls the hair stays in the direction it was falling
      // before" — the hair is not lagging, it is being carried.
      //
      // A limp body is not walking, so the center has nothing left to protect.
      // Dropped, the tails live in world space, gravity is world gravity, and
      // swinging the body makes the hair trail the way it should.
      if (on) j._center = null;
      else if (o.center !== undefined) j._center = o.center;
    }
    // The tails were stored in the frame we just changed; re-derive them from
    // the pose the hair is in, or the first frame after the switch reads old
    // center-space numbers as world-space ones and flings it.
    this._springsResync();
  }

  /** Re-derive spring tail state from the CURRENT pose, keeping that pose.
   *
   *  reset() alone would restore each joint's _initialLocalRotation (the combed
   *  shape) — a visible snap. Pointing that rest at the pose the hair is
   *  already in makes the restore a no-op while the tails re-derive, and then
   *  the real rest goes back so the springs still pull toward the authored
   *  shape afterwards. Needed anywhere the frame those tails live in changes. */
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

  /** Put the AUTHORED spring rest back, so the hair combs itself out again.
   *
   *  Split from the release because the two happen at different moments. A doll
   *  that disposes mid-tumble (letting go of a dragged body) hands the hair back
   *  ADOPTING the fallen shape: it stays exactly where it was dropped and is
   *  live again, so it keeps falling with her. Getting UP is when the combed
   *  shape comes back. Without the split, a body released mid-air had its hair
   *  owned by a doll that no longer existed — frozen in the pose it was let go
   *  in, which is precisely what a dragged dummy did while a body going limp on
   *  its own never did (its doll lives until it settles). */
  _combHair() {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints || !this.__springRest) return;
    for (const j of sbm.joints) {
      const q = this.__springRest.get(j);
      if (q && j._initialLocalRotation) j._initialLocalRotation.copy(q);
    }
  }

  /** Find the wing bones once, and remember the pose they were authored in.
   *
   *  `[LR]_Wing_(Upper|Lower)` is the root of a chain and `_<n>` its nth
   *  segment outward: mythos runs `_1`, `_2` today and may grow more. Depth is
   *  the INDEX in the name, not a count of underscores — reading it as a count
   *  makes `_1` and `_2` both depth 1, and then the two outer segments share a
   *  phase and an amplitude and the chain flaps as two planks instead of three.
   *
   *  Chains do not all have to be the same length: depth is per bone, and the
   *  ragdoll's limit ramp divides by each chain's own length.
   *
   *  Rest is captured here, before the first flap is ever applied, and every
   *  frame rebuilds from it. That is not a style choice: composing onto last
   *  frame's pose integrates, and an integrating flap winds the wings around
   *  their own axis over a few minutes. The same capture is what the ragdoll
   *  reads as its equilibrium, so it must be the AUTHORED pose and not a pose
   *  the sim or the flap left behind (HANDOFF.md: never rebuild a rig from a
   *  simulated pose — it cost the hair a permanent crumple).
   */
  _findWings() {
    this._wings = null;
    if (!this.vrm?.scene) return;
    // THE AUTHORED REST, NOT THE LIVE ONE.
    //
    // This used to clone o.quaternion, which is only the authored pose if
    // nothing has moved the bone yet. Wings are declared as springbones now, so
    // three-vrm has posed them before the first update() gets here — and an
    // observer whose client first sees a body WHILE IT IS RAGDOLLED captured a
    // fallen pose as "rest" and composed every flap onto it forever after.
    // That is Janus's "after getting up the wings are twisted, but only from
    // the perspective of particular other users": per-client state, captured at
    // whatever moment that client happened to arrive.
    //
    // three-vrm already keeps the real thing. Every spring joint stores
    // _initialLocalRotation at setup, before any simulation runs, so prefer it
    // and fall back to the live pose only for a bone no springbone claims.
    const springRest = new Map();
    for (const j of this.vrm.springBoneManager?.joints ?? []) {
      if (j?.bone && j._initialLocalRotation) springRest.set(j.bone, j._initialLocalRotation);
    }
    const found = [];
    this.vrm.scene.traverse((o) => {
      const m = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/.exec(o.name ?? '');
      if (!m) return;
      found.push({
        node: o,
        rest: (springRest.get(o) ?? o.quaternion).clone(),
        // +1 left, -1 right. A single rotation about the body's forward axis
        // lifts a wing that points +X and drops the one that points -X, so the
        // mirror is a sign and nothing else.
        side: m[1] === 'L' ? 1 : -1,
        lower: m[2] === 'Lower',
        depth: m[3] ? Number(m[3]) : 0,
      });
    });
    if (!found.length) return;
    // roots before tips: a tip's world frame is read AFTER its root has been
    // written this frame, so the order it is visited in is load-bearing.
    found.sort((a, b) => a.depth - b.depth);
    this._wings = found;
    // Shared with the ragdoll, which hangs its Bullet chains off this pose.
    // Stored on the avatar because the doll is rebuilt on every grab.
    this.__wingRest = new Map(found.map((w) => [w.node, w.rest]));
  }

  /** One frame of the idle flap. Every wing is rebuilt from its captured rest,
   *  so this cannot integrate however long it runs.
   *
   *  The rotation is applied about a WORLD axis and then carried into the
   *  bone's parent frame — local = parentWorld⁻¹ · R · parentWorld · rest —
   *  which is the same construction the eyeballs use, and for the same reason:
   *  the axis that means something ("the body's forward") is not an axis any
   *  one bone owns.
   */
  _flap(dt) {
    // EFFORT crossfades the two dial sets, term by term. `wingEffort` is set
    // from outside (controller.js, from the flight state) and eased HERE so a
    // caller can slam it to 1 on the frame she leaves the ground without the
    // wings snapping between two amplitudes: 46 degrees appearing in one frame
    // is a glitch, arriving over ~0.2s is a downstroke.
    //
    // Asymmetric on purpose. Effort comes on fast (a bird commits to a beat)
    // and bleeds off slowly (the last strokes of a climb trail into the glide),
    // which is also what keeps a tapped Space from looking like a twitch.
    const want = THREE.MathUtils.clamp(this.wingEffort ?? 0, 0, 1);
    const have = this._wingEffort ?? 0;
    const tau = want > have ? 0.18 : 0.55;
    this._wingEffort = have + (want - have) * (1 - Math.exp(-dt / tau));
    const e = this._wingEffort;
    const W = e < 0.001 ? WING_IDLE : mixWings(WING_IDLE, WING_POWER, e);
    this._wingBlend = Math.min(1, (this._wingBlend ?? 1) + dt / Math.max(0.01, W.recover));
    this._wingT = (this._wingT ?? 0) + dt * Math.max(0, W.hz);
    this._wingT -= Math.floor(this._wingT);      // stays in [0,1) forever
    // The body's forward, from the NORMALIZED rig: three-vrm guarantees those
    // bones rest facing +Z, where the raw Tripo bones carry whatever roll
    // Blender gave them. Falls back to the avatar group, which is upright and
    // faces travel — worse only when the body is leaning.
    const h = this.vrm.humanoid;
    const ref = this._wingRef ?? (this._wingRef =
      h?.getNormalizedBoneNode?.('upperChest') ?? h?.getNormalizedBoneNode?.('chest')
      ?? h?.getNormalizedBoneNode?.('spine') ?? this.root);
    ref.getWorldQuaternion(_wq);
    _wax.set(0, 0, 1).applyQuaternion(_wq).normalize();   // forward: the flap
    _wup.set(0, 1, 0).applyQuaternion(_wq).normalize();   // up: the sweep
    for (const w of this._wings) {
      // the outer segments trail their root, and (optionally) the lower pair
      // trails the upper by half a beat
      const ph = this._wingT - W.lag * w.depth - (W.sync || !w.lower ? 0 : 0.5);
      // depth 0 carries the full amplitude; each segment out carries `tip` of
      // the one before it, as its OWN rotation — the total sweep at the tip is
      // larger than at the shoulder, because it inherits the root's as well.
      const amp = W.deg * Math.pow(W.tip, w.depth);
      const ang = (amp * Math.sin(ph * Math.PI * 2) + W.bias) * DEG * w.side;
      _wr.setFromAxisAngle(_wax, ang);
      // ...and the fore/aft sweep, about UP. Mirrored the OTHER way from the
      // flap: the two wings point opposite ways along the span, so sweeping
      // both forward together means opposite turns about the body's up axis.
      // Composed on the left, so the sweep acts in the body's frame rather than
      // in the already-flapped wing's.
      const sw = W.sweep * Math.pow(W.tip, w.depth)
        * Math.sin((ph + W.sweepPhase) * Math.PI * 2) * DEG * -w.side;
      if (sw) _wr.premultiply(_wsw.setFromAxisAngle(_wup, sw));
      // parentWorld is read fresh per bone, and roots are visited before tips
      // (see _findWings), so a tip composes on its root's NEW orientation
      // rather than last frame's.
      // _wacc, not _wpq, as the accumulator: three.js quaternion ops MUTATE the
      // receiver, so `_wpq.invert().multiply(_wr).multiply(_wpq)` reads the
      // already-inverted-and-multiplied value back as the third factor and
      // squares the rotation. It looked plausible — the wings flapped, in the
      // right plane, symmetrically — and was 2x every commanded angle.
      w.node.parent.getWorldQuaternion(_wpq);
      _wacc.copy(_wpq).invert().multiply(_wr).multiply(_wpq).multiply(w.rest);
      if (this._wingBlend < 1 && w.from) {
        // Standing up, the bones are wherever the ragdoll left them — folded,
        // or under her. Cutting straight to mid-flap is a one-frame teleport of
        // something a metre long, so the first half-second is a slerp out of
        // the pose she fell in. (The HAIR deliberately stays dishevelled; wings
        // are limbs, and a bird shakes them back into place.)
        w.node.quaternion.copy(w.from).slerp(_wacc, this._wingBlend);
      } else {
        w.node.quaternion.copy(_wacc);
      }
      // Explicit, though wing bones keep three.js's default: a bone declared as
      // a VRM springbone has matrixAutoUpdate FALSE (three-vrm sets it on every
      // spring joint), and on such a bone assigning .quaternion reaches the
      // renderer never. That cost four rounds of debugging on the hair; costing
      // it again on a rig that happens to declare its wings as springbones
      // would be careless.
      w.node.updateMatrix();
    }
  }

  /** Hold the eyes shut (1) or let them open (0). Eased in update() so it
   *  reads as closing rather than snapping. Returns false if this body has no
   *  eyelid bones, so a caller can say so instead of appearing to work. */
  setEyes(shut) {
    if (this._lids === undefined) this._findLids();
    if (!this._lids) return false;
    this._eyesGoal = shut ? 1 : 0;
    return true;
  }

  /** Find the eyelid bones once, and remember where OPEN is.
   *
   *  Named by the rig pipeline: L_/R_Eyelid_Upper (and _Lower, unused for now —
   *  a lower lid barely moves in a human blink). The closing angle comes from
   *  the Limit Rotation constraint the rig author set in Blender, carried out
   *  as a node extra by eido_export.py; BLINK.closed is the live fallback for a rig
   *  that never exported one, and is deliberately modest — a lid that overshoots
   *  reads as a wince, and this is the value you would rather have too small.
   */
  _findLids() {
    this._lids = null;
    if (!this.vrm?.scene) return;
    const found = [];
    this.vrm.scene.traverse((o) => {
      const m = /^[LR]_Eyelid_(Upper|Lower)$/.exec(o.name ?? '');
      if (!m) return;
      const ex = o.userData?.gltfExtras ?? o.userData ?? {};
      // A Limit Rotation's numbers are ABSOLUTE angles in the bone's own frame,
      // not offsets from rest — mythos's upper lids export min 150 / max 240
      // degrees, bracketing the ~195 the lid actually rests at. Read as a delta
      // that is a 240-degree sweep: the lid leaves the head entirely and the eye
      // is bare, which reads as "you can see through the eyelids" and survives
      // any amount of making the mesh bigger.
      //
      // Rest sits at the middle of a range that brackets it, so the closing
      // delta is closed - centre = 45 degrees here. Anything that does not come
      // out plausible is discarded in favour of the dial: a rig may have set
      // those limits for something other than a blink.
      let lim = NaN;
      const mn = Number(ex.limit_min_x), mx = Number(ex.limit_max_x);
      const cl = Number(ex.blink_closed_x);
      if ([mn, mx, cl].every(Number.isFinite) && mx > mn) {
        const d = cl - (mn + mx) / 2;
        if (Math.abs(d) > 1e-3 && Math.abs(d) < 1.6) lim = d;
      }
      found.push({
        node: o,
        rest: o.quaternion.clone(),
        lower: m[1] === 'Lower',
        exported: Number.isFinite(lim) && Math.abs(lim) > 1e-4 ? lim : null,
      });
    });
    // NOT report() — that is the error channel, and report(msg, null) renders
    // as "unknown error", which is what it did: a clean load announcing a fault
    // that never happened.
    if (found.length) this._lids = found;
  }

  // ---- first-person anchors (fp_view.js consumes these) -------------------

  /** Live world position of the head bone, or null when the rig has none.
   *  The RAW bone is the skinned skeleton the mesh actually follows — it
   *  carries the current clip (seated, mounted, mid-swing) because the root
   *  rides whatever drives it and the pose rides the mixer. */
  headWorldPosition(out) {
    const node = this.vrm.humanoid?.getRawBoneNode?.('head') ?? this.head;
    if (!node) return null;
    return node.getWorldPosition(out);
  }

  /** World bounds of the rig's own mesh — vrm.scene only, deliberately NOT
   *  this.root, so the nameplate/bubble sprites above the head don't inflate
   *  the box. Fallback anchor for rigs without a head bone. */
  visualBounds(box) {
    box.setFromObject(this.vrm.scene);
    return box.isEmpty() ? null : box;
  }

  // ---- locomotion / clips
  setClip(slot, speed = 0) {
    // Moving cancels an emote. Standing frozen mid-cheer while walking away
    // is worse than cutting the cheer short.
    if (this.emote && speed > 0.05) this.cancelEmote();
    if (this.emote) return;        // otherwise it owns the body until it finishes
    let use = slot;
    while (!this.actions[use] && CLIP_FALLBACK[use]) use = CLIP_FALLBACK[use];
    this._setAction(this.actions[use], use);
    const a = this.actions[use];
    if (!a) return;
    const nat = CLIP_SPEED[slot];
    a.timeScale = nat > 0 && speed > 0 ? THREE.MathUtils.clamp(speed / nat, 0.6, 1.6) : 1;
  }
  _setAction(a, slot) {
    if (!a || this.current === a) return;
    if (this.current) this.current.fadeOut(0.22);
    a.enabled = true;
    a.setEffectiveWeight(1);       // base weight — fadeIn ramps a MULTIPLIER on this
    a.reset().fadeIn(0.22);
    this.current = a;
    this.currentSlot = slot;
  }

  /** Fill in the clips that weren't needed to stand up. Safe to call twice.
   *  One at a time, in idle moments — hydration used to fire seven VRMA
   *  parses in a Promise.all burst right behind the avatar landing, which put
   *  a second stall directly after the first. (The parses are also now cached
   *  globally, so only the first body ever pays them at all.) */
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

  /** Play a one-shot emote over locomotion. Returns when it's queued, not done. */
  async playEmote(name) {
    const file = EMOTES[name];
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
      // play() is what puts an action in the mixer's evaluation set. The
      // locomotion actions get it in the constructor; these never did, so
      // emoting faded the walk out and faded in an action the mixer was not
      // looking at — leaving the skeleton at its REST pose. That is the T-pose.
      action.reset().play();
      this.emote = null;           // let _setAction run
      this._setAction(action, `emote:${name}`);
      this.emote = { action, until: performance.now() + dur * 1000 };
    } catch (e) { report(`emote ${name}`, e); }
  }
  cancelEmote() {
    if (!this.emote) return;
    const action = this.emote.action;
    this.emote = null;
    // The emote MUST be faded out here. It is a LoopOnce action with
    // clampWhenFinished, so when it ends it holds its final frame at full
    // weight — forever. Simply forgetting about it (this.current = null) left
    // that frozen pose blended into everything that came after, which is why
    // sitting and standing were wrong once you had pointed at something.
    action.fadeOut(0.25);
    if (this.current === action) this.current = null; // next setClip fades in fresh
  }

  // ---- custom poses & one-off animations ---------------------------------
  //
  // Both are the same thing at the bone level: a set of humanoid-bone
  // rotations, either held constant (a pose) or sampled over time (an
  // animation). They are applied AFTER vrm.update — the mixer rewrites every
  // bone from the active clip each frame, and this then SLERPS the listed
  // bones toward the override by a ramping weight, so a held "arms crossed"
  // composes over a walk cycle instead of fighting it, and releasing eases
  // back to the clip instead of snapping.
  //
  // No mixer, no AnimationClip, no asset — the whole thing is a few hundred
  // bytes of quaternions the agent sent, sampled per frame. That is why it
  // needs no server-side caching: it is smaller than one pose packet.

  /** Resolve+cache the normalized bone nodes for a set of names once. */
  _resolveBones(names) {
    const out = [];
    for (const n of names) {
      const node = this.vrm.humanoid?.getNormalizedBoneNode?.(n);
      if (node) out.push([n, node]);
    }
    return out;
  }

  /** Hold a pose. `bones` is a sparse map name -> [x,y,z,w]. */
  setPose(bones) {
    if (!bones || typeof bones !== 'object') return this.clearPose();
    const targets = new Map();
    for (const [n, q] of Object.entries(bones)) {
      if (Array.isArray(q) && q.length === 4) targets.set(n, new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize());
    }
    if (!targets.size) return;
    this._override = {
      kind: 'pose', nodes: this._resolveBones([...targets.keys()]),
      // A tumble starts at FULL weight. The ramp is right for a held pose
      // arriving over the wire, but the ragdoll's first frame is by
      // construction the pose the body is already in — easing into it from
      // whatever the clip says just blends the walk cycle back in for the
      // first 200ms, which is the window the impact happens in.
      targets, weight: this._override?.weight ?? (this._limp ? 1 : 0), wantWeight: 1,
    };
  }

  /** Play a one-off animation. data = { dur, loop?, tracks: {bone:[{t,q:[x,y,z,w]}]} }. */
  playAnimation(data) {
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
    this._override = {
      kind: 'anim', nodes: this._resolveBones([...tracks.keys()]),
      tracks, dur, loop: !!data.loop, start: performance.now(),
      weight: this._override?.weight ?? 0, wantWeight: 1, _scratch: new THREE.Quaternion(),
    };
  }

  // ---- reaching: IK that re-solves every frame ------------------------------
  //
  // A reach is not a pose. A pose is a set of angles; a reach is a RELATION to
  // a point that may be moving — someone else's shoulder, a thrown ball, a
  // door handle on a swinging door. So it is stored as a target FUNCTION and
  // re-solved every frame, which is what makes it track. The cost is one
  // closed-form solve per reaching arm per frame: no iteration, no history.
  //
  // It gets its own override slot rather than sharing `_override`, because a
  // held pose and a reach have to coexist — an agent holding a posture and
  // still putting a hand out is the ordinary case, not an exotic one. Where
  // both would write the same bone the reach wins and the pose skips it, so
  // the one-author-per-bone-per-frame rule that _composeBegin depends on still
  // holds. (Two authors on one bone is the recurring bug in this file: eyes vs
  // three-vrm lookAt, hair vs Bullet, wings vs ragdoll.)

  /** Measure the fixed facts about one arm/leg chain, once. Everything here is
   *  in the avatar ROOT's local frame, where the rest pose has identity
   *  rotations — the frame shared/reach.js does its algebra in. */
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
    });
    return true;
  }

  /** Let an arm go, easing back to whatever the clip was doing. */
  clearReach(key) {
    if (key == null) { for (const r of this._reach?.values() ?? []) r.wantWeight = 0; return; }
    const r = this._reach?.get(key);
    if (r) r.wantWeight = 0;
  }

  /** What each live reach achieved last frame — for callers that need to know
   *  a hand did NOT get there (out of range, or stopped by a joint). */
  reachStatus() {
    const out = {};
    for (const [k, r] of this._reach ?? []) out[k] = { weight: r.weight, gap: r.gap ?? null, bound: r.bound, penetration: r.penetration ?? null, palmResidual: r.palmResidual ?? null };
    return out;
  }

  _applyReach(dt, now) {
    if (!this._reach?.size) return;
    for (const [key, r] of [...this._reach]) {
      r.weight += (r.wantWeight - r.weight) * Math.min(1, 12 * dt);
      if (r.wantWeight === 0 && r.weight < 0.02) {
        for (const node of [r._nu, r._nl, r._nh]) {
          const c = node && this._composed.get(node);
          if (c?.live && node.quaternion.equals(c.out)) { node.quaternion.copy(c.base); c.live = false; }
        }
        this._reach.delete(key);
        continue;
      }
      const ch = this._measureChain(key);
      if (!ch) { this._reach.delete(key); continue; }

      // A target may be a bare point, or a {pos, normal} — the normal being
      // the surface the hand is meeting, which is what lets the palm face it
      // rather than arriving back-first.
      const raw = typeof r.target === 'function' ? r.target() : r.target;
      const tw = Array.isArray(raw) ? raw : raw?.pos;
      const normal = Array.isArray(raw) ? null : raw?.normal;
      if (!tw || tw.length !== 3 || !tw.every(Number.isFinite)) { r.bound = ['no-target']; continue; }

      // the palm faces INTO the surface, so it wants the opposite of the
      // outward normal
      const palm = (r.palm !== false && normal && normal.length === 3 && normal.every(Number.isFinite))
        ? { dir: [-normal[0], -normal[1], -normal[2]] } : null;
      const out = solveChain(ch, this, tw, r.lastElbow, { palm, lastPick: r.lastPick, lastSwivel: r.lastSwivel });
      if (!out.ok) { r.bound = [out.why]; continue; }
      r.bound = out.res.bound; r.gap = out.res.gap; r.lastPick = out.pick ?? null; r.lastSwivel = out.swivelUsed ?? null; r.penetration = out.penetration ?? 0; r.lastElbow = out.elbowOffset;
      // what the solver BELIEVES it placed, in world space, so a probe can
      // compare it against where the bones actually ended up
      r.solved = { elbow: this.root.localToWorld(_rv3.set(...out.res.elbow)).toArray(),
                   hand: this.root.localToWorld(_rv4.set(...out.res.hand)).toArray() };
      const q = { upper: out.upper, lower: out.lower };
      r._nu = ch.nodes.upper; r._nl = ch.nodes.lower;
      this._writeBone(ch.nodes.upper, q.upper, r.weight);
      this._writeBone(ch.nodes.lower, q.lower, r.weight);
      if (out.hand) { r._nh = ch.nodes.end; this._writeBone(ch.nodes.end, out.hand, r.weight); }
      r.palmResidual = out.palmResidual ?? null;
    }
  }

  /** Slerp one bone from whatever the clip left toward `q`, composed so the
   *  fade-out actually returns to the clip rather than converging near it. */
  _writeBone(node, q, weight) {
    const c = this._composeBegin(node);
    _rq3.set(q[0], q[1], q[2], q[3]);
    node.quaternion.slerp(_rq3, weight);
    this._composeEnd(node, c);
  }

  /** Bones a live reach owns this frame — a held pose must not also write
   *  them, or two authors compose onto each other and both drift. */
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

  /** Go limp, or stand back up.
   *
   *  A ragdoll writes twelve bones. The locomotion mixer writes every bone the
   *  clip has a track for, every frame, forever — and `setClip('ragdoll')`
   *  never stopped it: there is no ragdoll clip and no CLIP_FALLBACK entry, so
   *  _setAction was handed undefined and returned at its first line. Whatever
   *  was playing when you fell (idle, or walk if you fell mid-stride) went on
   *  running underneath the tumble, and _applyOverride only slerps the twelve
   *  DRIVEN bones back — so the shoulders, upperChest, head, hands, feet, toes
   *  and every finger stayed animated on a corpse. Which bones those were
   *  differs per rig (the fleet splits into 19-bone and 54-bone rigs), and
   *  that was most of why one fall looked fine on one avatar and broken on the
   *  next.
   *
   *  So: park every bone the sim does NOT drive at its rest rotation, every
   *  frame, right after the mixer has written it. Parking rather than freezing
   *  mid-stride is deliberate — a body going limp SHOULD unclench its hands
   *  and drop its shoulders, so the snap reads as relaxing. It also makes the
   *  chest->upperArm span rigid, which is what the sim's distance constraint
   *  always assumed it was.
   *
   *  What this must NOT do is stop the mixer. mixer.stopAllAction() looks like
   *  the obvious move and breaks three things at once, because the actions are
   *  play()ed exactly once when they are loaded and cross-faded by WEIGHT ever
   *  after — _setAction never calls play(). Stopping them therefore:
   *    - deactivates every action permanently, so nothing animates again after
   *      you get up;
   *    - leaves head.rotation with nothing to reset it, and the head pitch
   *      composes with `+=` on the assumption that the mixer rewrote the bone
   *      first, so the head integrates one pitch per frame into a flywheel;
   *    - calls restoreOriginalState() on every binding, snapping the whole
   *      skeleton to its bind pose — a visible T-pose flash, and the Ragdoll
   *      constructor then measures THAT instead of the pose you fell in.
   *  Leaving the mixer running costs one clip evaluation whose driven bones we
   *  overwrite anyway, and none of the above happens. */
  setLimp(on) {
    on = !!on;
    if (on === this._limp) return;
    this._limp = on;
    // Eyes close when the body goes slack, and open when it gets up. Only for a
    // rig with eyelid BONES — setEyes says so itself and does nothing otherwise,
    // so a VRM that blinks with a blendshape is unaffected.
    //
    // This is driven from setLimp rather than from the ragdoll, which means it
    // is also true of everyone ELSE you watch fall: remotes call setLimp the
    // moment a streamed clip turns to 'ragdoll'. Nothing new on the wire.
    //
    // _limpEyes remembers that WE closed them, so getting up only reopens eyes
    // that the fall shut — someone who chose to lie there with their eyes closed
    // (/eyes) keeps them closed.
    if (on) { this._limpEyes = this.setEyes(true); }
    else if (this._limpEyes) { this._limpEyes = false; this.setEyes(false); }
    // Wings: while limp they belong to the ragdoll (ammodoll hangs Bullet
    // chains off these same bones), and here we only mark the handover BACK.
    // Where the sim left them is captured now, so the flap can slerp out of it
    // instead of cutting. On a REMOTE body no doll ever ran and the wings are
    // simply frozen where the flap stopped — remotes carry no dressing on the
    // wire, exactly as with the hair.
    // Getting up is when the hair goes back to three-vrm — not when the doll
    // disposed, which happens the moment the body settles and left the hair
    // snapping to combed while she was still lying there.
    if (!on) { this._releaseHair(); this._combHair(); }
    if (!on) {
      if (this._wings === undefined) this._findWings();
      if (this._wings) {
        for (const w of this._wings) w.from = w.node.quaternion.clone();
        this._wingBlend = 0;
      }
    }
    if (!on) {
      // Hand the bones back as we found them. three.js only writes a bone when
      // the clip's computed value CHANGES, so a track that holds still — a
      // single-key finger curl, a shoulder that does not move in idle — would
      // never overwrite the parked rest rotation, and the body would stand up
      // with its hands left open.
      for (const [node, q] of this._parked ?? []) node.quaternion.copy(q);
      this._parked = null;
      return;
    }
    if (this.emote) this.cancelEmote();
    const driven = new Set(DRIVEN_BONES);
    this._parked = this._resolveBones(
      this._humanoidBones().filter((n) => !driven.has(n)))
      .map(([, node]) => [node, node.quaternion.clone()]);
    // once here as well as per-frame, so the Ragdoll about to be built reads a
    // skeleton that already agrees with what it will be driving
    this._park();
    this.root.updateMatrixWorld(true);
  }

  _park() { for (const [node] of this._parked ?? []) node.quaternion.identity(); }

  // ---- composing on top of the clip, without trusting it to come back
  //
  // Everything written to a bone between mixer.update and vrm.update composes
  // on the clip pose, and every such writer has silently assumed the mixer
  // rewrites that bone every frame. It does not. three.js only calls
  // binding.setValue when the value it computes CHANGES, so a bone whose track
  // holds still — a single-key finger, a head that does not move in idle — is
  // written once and never again, and whatever we put on top is never undone.
  //
  // Measured on a constant track: head pitch integrates one pitch per frame
  // into 54 radians in three seconds, and clearPose becomes a ONE-WAY DOOR —
  // the bone never returns to the clip, so a body that went limp could stand
  // up still holding the pose it landed in.
  //
  // So remember the clip's value and what we left. If the bone still holds
  // exactly what we left, the mixer did not rewrite it: put the clip's value
  // back before composing again. Exact float compare is the right test — both
  // sides are plain copies of the same numbers — and a false match is
  // harmless, since recomposing the same base yields the same result.
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

  _humanoidBones() { return Object.keys(this.vrm.humanoid?.humanBones ?? {}); }

  /** World positions of the humanoid bones in the NEUTRAL rest pose — every
   *  humanoid rotation identity — without disturbing the pose on screen.
   *
   *  The ragdoll measures every joint limit, every brace length and its own hip
   *  offset against this. Measuring against the LIVE skeleton meant a body that
   *  went limp mid-stride took the stride's angles as its definition of rest,
   *  so the same avatar got different knees depending on which frame of the
   *  walk cycle it happened to fall on. */
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
    const o = this._override;
    if (!o) return;
    // A live reach owns its two bones outright this frame. Letting the held
    // pose write them too would put two authors on one bone, and the compose
    // guard cannot tell them apart: each would read the other's output as the
    // clip's value and both would integrate.
    const taken = this._reachOwned();
    // ramp toward the wanted weight (ease ~120ms)
    o.weight += (o.wantWeight - o.weight) * Math.min(1, 12 * dt);
    if (o.wantWeight === 0 && o.weight < 0.02) {
      // Hand the bones back on the way out. The ramp is cut at 2%, and on a
      // track that holds still nothing would ever clear that last 2% of the
      // pose — the body would stand up fractionally wrong, forever.
      for (const [, node] of o.nodes) {
        const r = this._composed.get(node);
        if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
      }
      this._override = null;
      return;
    }

    if (o.kind === 'pose') {
      for (const [name, node] of o.nodes) {
        const target = o.targets.get(name);
        if (!target || taken?.has(node)) continue;
        // Composed, so the fade-OUT actually returns to the clip: slerping
        // from wherever the bone happens to sit only converges toward the
        // target, it never walks back. With a still track that made clearPose
        // a one-way door.
        const r = this._composeBegin(node);
        node.quaternion.slerp(target, o.weight);
        this._composeEnd(node, r);
      }
    }
    if (o.kind === 'anim') {
      let tt = (now - o.start) / 1000;
      if (tt >= o.dur) {
        if (o.loop) tt %= o.dur; else { o.wantWeight = 0; tt = o.dur; }
      }
      for (const [name, node] of o.nodes) {
        if (taken?.has(node)) continue;
        this._sampleTrack(o.tracks.get(name), tt, o._scratch);
        node.quaternion.slerp(o._scratch, o.weight);
      }
    }
  }

  /** Rename the body. The nameplate is a baked sprite, so it has to be redrawn
   *  — but the VRM, its clips and its mixer are unaffected, and rebuilding the
   *  whole avatar to change a label would drop you through the floor mid-step. */
  setName(name) {
    this.id = name;
    this.root.remove(this.label);
    disposeSprite(this.label);
    this.label = makeLabel(this._seatApprox ? `${name} ≈` : name);
    this.label.position.y = 1.95;
    this.root.add(this.label);
  }

  /** Declared-approximation marker (#101): a seated body whose profile gate
   *  is closed (legacy socket, no profile, clip not loaded, …) wears a small
   *  ≈ on its nameplate — the browser's half of "no silent root-at-socket".
   *  Idempotent per state; the sprite is only redrawn on a transition. */
  setSeatApprox(on) {
    if (this._seatApprox === !!on) return;
    this._seatApprox = !!on;
    this.setName(this.id);
  }

  // ---- speech
  /** They're composing. Repeated calls extend it; it expires on its own so a
   *  dropped "stopped typing" never leaves the dots stuck up forever. */
  /** Generation-end (#95): everything TRANSIENT this body was expressing —
   *  typing pill, speech bubble, held bone pose, limpness, gaze — belongs to
   *  the generation that expressed it, not to the mesh. A takeover
   *  transplants the mesh into a fresh record; this is what does NOT ride
   *  along. Each reset goes through the transient's own teardown mechanism
   *  (the bubble expires through the update loop, the pill through
   *  setTyping's stop path), so nothing here invents a second way to die. */
  resetTransients() {
    this.setTyping(null);
    this.bubbleUntil = 0;
    this.speakUntil = 0;
    this.voiceLevel = null;
    this.clearPose();
    this.clearReach();      // a transplanted body must not keep reaching at the predecessor's target
    this.setLimp(false);
    this.setGazeTarget(null);
    this.setClip('idle');
  }

  setTyping(state) {
    // state === null means STOP (mic went cold, composing ended) — it must
    // clear the pill, not schedule 4s of an empty one. Found live: R's
    // megaphone rendered as a blank bubble (2026-08-04 23:35).
    if (state === null) { this._typingUntil = 0; this._typingState = null; return; }
    this._typingUntil = performance.now() + 4000;
    this._typingState = state || null;
  }

  say(text) {
    // Speaking ends COMPOSING — but not a live mic. The 🎙 is presence: the
    // voice is still coming out of this body while its transcript scrolls
    // past. Only the composing states yield to the bubble.
    if (this._typingState !== 'mic') this._typingUntil = 0;
    if (this.bubble) { this.root.remove(this.bubble); disposeSprite(this.bubble); }
    this.bubble = makeBubble(text);
    this.bubble.position.y = 2.3;
    this.root.add(this.bubble);
    // Long speech deserves a longer read — roughly reading speed, clamped.
    const ms = THREE.MathUtils.clamp(2500 + text.length * 45, 5000, 22000);
    this.bubbleUntil = performance.now() + ms;
    this.speakUntil = performance.now() + Math.min(ms, 1000 + text.length * 38);
  }

  /** Where this body should be looking. Null = relax to neutral. */
  setGazeTarget(v3) {
    if (v3) { this.gazeGoal.copy(v3); this._hasGaze = true; }
    else this._hasGaze = false;
  }

  update(dt, now = performance.now()) {
    const BC = globalThis.__ewBC ?? (() => {});
    // emote expiry
    if (this.emote && now > this.emote.until) this.cancelEmote();

    BC('av:mixer');
    this.mixer.update(dt);

    // While limp the clip keeps running (see setLimp for why stopping it is a
    // trap) — so the bones the sim does not drive have to be re-parked after
    // every mixer write, or the locomotion clip goes on animating the
    // shoulders, hands and fingers of a corpse.
    BC('av:park');
    if (this._limp) this._park();

    // ---- bone edits must land BETWEEN the mixer and vrm.update.
    //
    // three-vrm's flow each frame is: the mixer writes the NORMALIZED humanoid
    // bones from the active clip, then vrm.update() copies normalized -> the
    // raw skinned rig and runs springs. Anything written to a normalized bone
    // AFTER vrm.update() is copied nowhere until next frame, where the mixer
    // overwrites it first — so it is invisible. (Head pitch lived here too and
    // was silently doing nothing; it only ever passed a numeric check.) Applied
    // here, we compose on the fresh clip pose and vrm.update carries it through.
    // ...but not while limp: a corpse does not keep looking where you last
    // aimed the camera, and the pitch is never reset when you fall.
    //
    // Composed through _composeBegin so it cannot integrate (see there), and
    // as a quaternion premultiply rather than `rotation.x +=`. Those agree for
    // an XYZ Euler — adding to x is a pre-rotation in the parent frame — but
    // the quaternion form says so outright instead of leaning on the decompose
    // order of whatever the clip left in the bone.
    BC('av:head');
    if (this.head && !this._limp) {
      const r = this._composeBegin(this.head);
      if (this.pitch) {
        this.head.quaternion.premultiply(
          _pq.setFromAxisAngle(_X, THREE.MathUtils.clamp(this.pitch, -0.5, 0.6)));
      }
      this._composeEnd(this.head, r);
    }
    BC('av:override');
    if (this._override) this._applyOverride(dt, now);

    // ---- reach: solved fresh every frame, so it TRACKS. After the held pose
    // (which yields any bone a reach owns) and before vrm.update, same as
    // every other humanoid-bone writer here. Not while limp: a corpse does not
    // keep reaching for what it wanted.
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

    // ---- blink: irregular, in pairs sometimes, never metronomic
    //
    // The CLOCK runs whether or not this body has expressions. It used to live
    // inside `if (em)`, which is fine for a VRM authored with a blink
    // blendshape and silently nothing for one without: a rig whose eyelids are
    // BONES has no expressions at all, so the timer never advanced and the
    // avatar never blinked. Value first, consumers after.
    let blinkV = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const k = this.blinkT / Math.max(0.05, BLINK.dur);
      blinkV = k < 1 ? Math.sin(k * Math.PI) : 0;
      if (k >= 1) {
        this.blinkT = -1;
        // Schedule from the END of the blink, not its start. Measured from the
        // start, the 260ms "pair" gap is shorter than a 280ms blink — so the
        // next one is already due the instant this one finishes and EVERY blink
        // came in twos. It only worked before because the blink was 130ms, i.e.
        // the bug was hidden by the duration rather than absent.
        const rate = Math.max(0.15, BLINK.hz);
        this.blinkAt = now + (Math.random() < 0.22 ? 220
          : (2200 + Math.random() * 4200) / rate);
      }
    } else if (now > this.blinkAt) {
      this.blinkT = 0;
    }
    // eyelids as BONES: rotate the uppers from their rest pose by the same
    // curve. Rest is captured once, so a blink cannot integrate — the lids
    // return exactly where they started rather than creeping shut over an hour.
    // ---- eyeballs: point them at the same target the gaze already eases to
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

    if (this._lids === undefined) this._findLids();
    // ease toward the held state — a lid that snaps shut reads as a flinch
    this._eyesShut = this._eyesShut ?? 0;
    const goal = this._eyesGoal ?? 0;
    if (this._eyesShut !== goal) {
      this._eyesShut += (goal - this._eyesShut) * (1 - Math.exp(-12 * dt));
      if (Math.abs(goal - this._eyesShut) < 0.002) this._eyesShut = goal;
    }
    if (this._lids) {
      // a held close (/eyes) and a blink share the lids: whichever is further
      // shut wins, so blinking while your eyes are closed changes nothing
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
      // ---- mouth: no audio to drive visemes from, but a frozen mouth during
      // a paragraph of speech is worse than an approximate one. Syllable-rate
      // envelope for the duration of the utterance.
      // A REAL amplitude wins over the fake envelope whenever we have one
      // (live mic, R 23:30): the mouth then moves with the actual voice
      // instead of an approximation of one. Smoothed asymmetrically — jaws
      // open fast and close slower, which is what reads as speech rather
      // than chatter. Falls back to the syllable envelope for TTS/captions,
      // where no waveform is available on this client.
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
    // ONE author per bone, again — this time for the hair.
    //
    // A rig with Hair_* chains is simulated TWICE while limp: ammodoll builds
    // Bullet bodies for those bones and writes them in the 'me-drive' system,
    // and three-vrm's springBoneManager writes the same bones inside
    // vrm.update() during 'me-update'. Registration order is execution order,
    // so the springbones always ran second and always won — the Bullet boxes
    // swung wide in the debug overlay while the rendered hair barely moved,
    // which is exactly how Janus described it.
    //
    // The wings never had this problem because nothing else simulates them.
    // The hair's second simulator is the whole reason it moves while WALKING,
    // so it cannot simply be removed: it is suppressed for exactly as long as a
    // local sim owns those bones (__simHair, set by ammodoll between build and
    // dispose), and dispose resets it so it resumes from where the tumble left
    // the hair instead of snapping from its own stale state.
    //
    // Caveat worth knowing: this suppresses the whole manager, so a rig whose
    // springbones include something Bullet does NOT drive — a skirt, a tail —
    // would freeze that too while limp. Every chain in this rig is hair.
    // Self-healing: ownership is claimed by the doll and released by setLimp,
    // and anything that ends a tumble without going through setLimp (an avatar
    // swap, a dragger taking over) would otherwise leave the hair suppressed
    // and frozen for good.
    if (this.__simHair && !this._limp) { this._releaseHair(); this._combHair(); }
    // A limp body with no sim of its own hangs its hair on the world, not on
    // its own rest shape (see _springsLimp).
    this._springsLimp(this._limp && !this.__simHair);
    const sbm = this.__simHair ? this.vrm.springBoneManager : null;
    if (sbm) this.vrm.springBoneManager = null;
    this.vrm.update(dt);
    if (sbm) this.vrm.springBoneManager = sbm;

    // ---- wings: flap while alive, let go the instant the body does.
    //
    // AFTER vrm.update, unlike every other bone edit here, and deliberately.
    // Wing bones are RAW and not humanoid, so nothing in vrm.update overwrites
    // them — the ordering trap that put the head pitch and the blink up there
    // does not apply. What DOES apply is that their parent clavicle is
    // humanoid, and only receives this frame's clip pose when vrm.update copies
    // normalized -> raw. Composing before that would hang every wing off last
    // frame's shoulder, which shows as a shear whenever the body turns.
    //
    // While limp the wings belong to the sim: ammodoll hangs Bullet chains off
    // these same bones and writes them every step, and two authors on one bone
    // is decided by whichever runs second.
    if (this._wings === undefined) this._findWings();
    if (this._wings && !this._limp) this._flap(dt);

    // ---- contact shadow: on the GROUND, not on the body.
    // The blob is a child of root at a fixed local y, so it rode along under a
    // lifted body at a constant 2cm — which is precisely the one thing it
    // exists to disprove ("how high a jump went"). Put it at the surface under
    // her instead, and let it shrink and fade with the gap, so height reads
    // even when the ground is out of frame. surfaceUnder, not heightAt: a body
    // held over a platform casts onto the PLATFORM.
    if (this.shadow) {
      const rp = this.root.position;
      const gy = surfaceUnder(rp.x, rp.z, heightAt, rp.y + 0.05).y;
      const gap = Math.max(0, rp.y - gy);
      this.shadow.position.y = (gy - rp.y) + 0.02;
      // 3 m up the blob is gone; directly underfoot it is full size.
      const k = THREE.MathUtils.clamp(1 - gap / 3, 0, 1);
      this.shadow.scale.setScalar(0.55 + 0.45 * k);
      this.shadow.material.opacity = k * k;
      this.shadow.visible = k > 0.02;
    }

    BC('av:plates');

    // ---- nameplate: fade with distance and stop screaming across the stage.
    // depthTest is off (labels must not be eaten by your own shoulder), so
    // distance is what keeps 24 of them from becoming a wall of text.
    const d = this.root.position.distanceTo(camera.position);
    const vis = THREE.MathUtils.clamp(1 - (d - 18) / 14, 0, 1);
    this.label.material.opacity = vis;
    this.label.visible = vis > 0.02;
    this.label.scale.setScalar(0); // reset then set (scale carries aspect)
    const lw = 0.9 * (1 + Math.max(0, d - 8) * 0.012); // gentle size hold at range
    this.label.scale.set(lw, lw * 64 / 512, 1);

    if (this.bubble) {
      if (now > this.bubbleUntil) {
        this.root.remove(this.bubble); disposeSprite(this.bubble); this.bubble = null;
      } else {
        this.bubble.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
      }
    }

    // ---- typing dots: shown only while composing and not already speaking
    // A composing pill hides behind a bubble (you've stopped composing, you
    // said it). A LIVE MIC does not: the voice keeps coming while its
    // transcript floats. Stack it above the bubble instead of suppressing it.
    const micLive = this._typingState === 'mic';
    const typingNow = now < this._typingUntil && (micLive || !this.bubble);
    if (typingNow && !this.typing) { this.typing = makeTypingSprite(); this.root.add(this.typing); }
    if (this.typing) this.typing.position.y = (micLive && this.bubble) ? 2.72 : 2.12;
    if (this.typing) {
      this.typing.visible = typingNow;
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

  // Split teardown (§19b): everything PER-BODY dies here — scene membership,
  // the gaze anchor, the sprites, the mixer and its actions, the compose
  // records. The VRM instance itself (scene subtree, skeleton, materials,
  // textures) is deliberately NOT disposed here: the pool owns disposal
  // (assets.js releaseVRM resets it to rest and shelves it; the real
  // deepDispose happens only at pool eviction). Deep-disposing a body that
  // then pools is the recorded black-avatar landmine (§13.3).
  dispose() {
    // Idempotent, and that is load-bearing now: a second dispose() of THIS
    // avatar after its VRM was re-worn by a newer one would release a body
    // someone is wearing back into the pool — two wearers, one instance.
    if (this._disposed) return;
    this._disposed = true;
    scene.remove(this.root);
    scene.remove(this.gaze);
    if (this.bubble) disposeSprite(this.bubble);
    if (this.typing) disposeSprite(this.typing);
    disposeSprite(this.label);
    this.mixer.stopAllAction();
    this._composed.clear();
    releaseVRM(this.vrm);
  }
}

// ---------------------------------------------------------------- shadows
// A cheap contact shadow. Real shadow maps land in the lighting pass, but a
// blob under the feet is what actually tells you where a body IS relative to
// the ground and how high a jump went.
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

export async function makeAvatar(id, libPath, { full = false, urgent = false } = {}) {
  loadTrack(`avatar:${id}`, `${id} materializing`);
  const work = beginWork(`avatar ${id}`);
  // YOUR body outranks everything; ANY body outranks every object — fable's
  // remote once queued 19s behind crate pipeline compiles (prod trace 08-02).
  const priority = urgent ? 2 : 1;
  try {
    const slots = full ? CLIP_SLOTS : CORE_CLIPS;
    work.phase('body');
    // VRM + the clip bytes we actually need download in PARALLEL.
    const [vrm] = await Promise.all([loadVRM(libPath, { priority }), ...slots.map(vrmaBytes)]);
    work.phase('clips');
    const clips = {};
    for (const slot of slots) { // sequential: each may be a VRMA parse (once ever, cached)
      try { clips[slot] = await clipFor(vrm, slot, { priority }); } catch (e) { report(`clip ${slot}`, e); }
    }
    work.phase('compile');
    if (vrmWarmed(vrm)) {
      // §19b: a pooled body's material set compiled on its first wear and the
      // renderer's pipeline cache still holds it — a re-warm would be a cheap
      // no-op that nonetheless occupies the conductor. Skip it, and say so.
      loadNote(`avatar ${id}: compile skipped — pooled body, pipelines already warm`);
    } else {
      // Through the warm conductor (§16.2.A), mesh by mesh with a real frame
      // between: the body's MToon set is a burst of ~11 pipelines, and both
      // the old 2-wide gpu lane AND a single whole-scene conductor item landed
      // that burst in one GPU-process gulp — bootjank attributed 383ms/491ms
      // compile-stall frames to exactly that. Spread, shared materials
      // cache-hit after their first mesh. frustumCulled defeats the compile
      // walk's culling while the body is still detached (stale matrices).
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
      });
      markVrmWarmed(vrm);
    }
    const av = new Avatar(id, vrm, clips);
    // The rest arrives behind you. Remote bodies hydrate too — someone else
    // breaking into a run should not be stuck walking on your screen.
    if (!full) av.hydrateClips();
    return av;
  } finally { loadDone(`avatar:${id}`); work.end(); }
}

// ---------------------------------------------------------------- thumbnails
// Contributed roster art: whoever wears a body renders one portrait off the
// VRM they already have in memory and posts it back, so the next person picks
// from faces instead of filenames. Costs one offscreen frame, once per body,
// ever.

export async function contributeThumbnail(name, vrm, token = '', { force = false } = {}) {
  try {
    if (!name) return;
    if (!force && localStorage.getItem(`ew-thumb-${name}`)) return;   // we already tried
    if (!force) {
      const head = await fetch(`/thumb/${encodeURIComponent(name)}.png`, { method: 'HEAD' });
      if (head.ok) { localStorage.setItem(`ew-thumb-${name}`, '1'); return; }
    }

    const size = 256;
    const rt = new THREE.RenderTarget(size, size);
    const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 12);
    const sub = new THREE.Scene();
    sub.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(1.4, 2.2, 2.4);
    sub.add(key);

    // Precompile the portrait's pipelines BEFORE borrowing the body. This
    // render target + these lights are a brand-new pipeline context (different
    // lightsNode, different color format and sample count than the canvas), so
    // the synchronous render below used to codegen+compile every MToon
    // material variant INSIDE render() — a seconds-long main-thread stall on
    // heavy bodies, timed exactly when an avatar had just finished loading.
    // compileAsync captures its render context synchronously before its first
    // internal yield, so the target can be restored immediately and the main
    // loop keeps rendering the world while the variants build. The body stays
    // in the main scene throughout — compileAsync takes the object tree and
    // pulls lights from the target scene, no reparenting needed.
    {
      const work = beginWork(`thumb ${name}`);
      try {
        work.phase('queued');
        await enqueue(() => {
          work.phase('compile');
          const prev = renderer.getRenderTarget();
          renderer.setRenderTarget(rt);
          const compiled = renderer.compileAsync(vrm.scene, cam, sub);
          renderer.setRenderTarget(prev);
          return compiled.catch(() => {});
        }, { lane: 'gpu', priority: 0 }); // a portrait never outranks a person
      } finally { work.end(); }
    }

    // Deep-cloning a VRM is not safe — the MToon node materials and the
    // spring-bone/lookAt proxies carry references that don't survive
    // Object3D.clone. So the real body is BORROWED for one frame: reparented
    // into the portrait scene, rendered, and put straight back. Costs at most
    // one frame where this avatar isn't in the main scene, once per body ever.
    const home = vrm.scene.parent;
    const homeIndex = home ? home.children.indexOf(vrm.scene) : -1;
    const keptPos = vrm.scene.position.clone();
    const keptRot = vrm.scene.rotation.clone();

    // Pose it first. A VRM at rest is in a T-pose, which reads as a mannequin
    // on a shelf rather than a person you might be. One frame of the idle clip
    // costs a single already-cached download and makes the roster look alive.
    let poseMixer = null;
    try {
      const clip = await clipFor(vrm, 'idle');
      poseMixer = new THREE.AnimationMixer(vrm.scene);
      const act = poseMixer.clipAction(clip);
      act.play();
      poseMixer.update(0.6);        // a little way in, past the settling frames
      vrm.update(0.6);
    } catch { /* T-pose is survivable; a missing portrait is worse */ }

    // Frame the WHOLE figure, identically for every body. Framing on the head
    // sounds better and isn't: these avatars range from a human silhouette to
    // something that is mostly mane, so a head-relative crop gave each one a
    // different apparent size — one portrait filled its card while the rest sat
    // tiny inside theirs. A full-body fit also shows the outfit, which is what
    // someone choosing a body is actually looking at.
    const bbox = new THREE.Box3().setFromObject(vrm.scene);
    const dims = new THREE.Vector3();     // NOT `size` — that is the pixel size
    bbox.getSize(dims);
    // True stature comes from the SKELETON, not the bounding box — hair,
    // capes, and particle shells inflate bounds (one body rendered half-size
    // inside its own card), and the height is also REPORTED with the portrait
    // so catalogs can draw the roster to a common scale.
    let height = dims.y;
    try {
      const rootY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
      const headY = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3()).y;
      const stature = headY - rootY + 0.13; // crown ≈ head joint + a forehead
      if (stature > 0.2) height = stature;
    } catch { /* bbox fallback */ }
    const fov = 30;
    // fit the taller of (height, width) into a square frame, with headroom
    const extent = Math.max(height, dims.x, 0.4) * 0.55;
    const dist = (extent / Math.tan((fov * Math.PI / 180) / 2)) * 1.0;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.position.set(dist * 0.16, height * 0.56, dist);
    cam.lookAt(0, height * 0.5, 0);

    const prevTarget = renderer.getRenderTarget();
    try {
      sub.add(vrm.scene);
      vrm.scene.position.set(0, 0, 0);
      // Keep the loader's VRM0 normalization (rotateVRM0 sets rotation.y=π on
      // the scene root) — zeroing it photographed every VRM0 body from behind.
      vrm.scene.rotation.set(0, vrm.meta?.metaVersion === '0' ? Math.PI : 0, 0);
      renderer.setRenderTarget(rt);
      renderer.render(sub, cam);
    } finally {
      renderer.setRenderTarget(prevTarget);
      poseMixer?.stopAllAction();
      vrm.scene.position.copy(keptPos);
      vrm.scene.rotation.copy(keptRot);
      if (home) {
        home.add(vrm.scene);
        // restore draw order so the body isn't shuffled behind its own label
        if (homeIndex >= 0 && homeIndex < home.children.length - 1) {
          home.children.splice(home.children.indexOf(vrm.scene), 1);
          home.children.splice(homeIndex, 0, vrm.scene);
        }
      }
    }

    // readRenderTargetPixelsAsync RETURNS the pixels; its 6th parameter is a
    // texture index, not an output buffer.
    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    // WebGPU hands back rows already in top-down order — flipping here (the
    // WebGL habit) produced upside-down portraits.
    img.data.set(buf.subarray(0, size * size * 4));
    ctx.putImageData(img, 0, 0);
    rt.dispose();

    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const q = new URLSearchParams({ name, height: height.toFixed(2) });
    if (force) q.set('force', '1'); // a re-mint pass really does replace
    if (token) q.set('token', token);
    await fetch(`/thumb?${q}`, { method: 'POST', body: blob });
    localStorage.setItem(`ew-thumb-${name}`, '1');
  } catch (e) {
    console.warn('thumbnail contribution skipped', e);
  }
}

export { angleDelta };
