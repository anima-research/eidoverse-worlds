// avatar — a body in the world: VRM, clip set, nameplate, speech bubble, and
// the small autonomic behaviours that make a puppet read as present (gaze,
// blink, head pitch, mouth movement while speaking).

import { THREE, scene, camera, renderer, report, angleDelta } from './core.js';
import {
  loadVRM, clipFor, vrmaBytes, loadTrack, loadDone,
  CLIP_SLOTS, CLIP_SPEED, VRMUtils,
} from './assets.js';
import { beginWork, enqueue, idleYield } from './loadwork.js';
import { DRIVEN_BONES } from './ragdoll.js';
import { stroke as strokeIcon } from './icons.js';

// The clip library is ~1.9MB PER SLOT. Waiting for all seven before a body
// could exist put 13MB between a person and their own legs — the single
// largest chunk of a cold boot, spent on animations most arrivals don't use in
// the first minute (nobody lands mid-climb). So a body is born able to stand
// and walk, and learns the rest while you're already moving.
const CORE_CLIPS = ['idle', 'walk'];
const LATER_CLIPS = CLIP_SLOTS.filter((s) => !CORE_CLIPS.includes(s));
// Until a clip arrives, the nearest thing that HAS arrived stands in. Silently
// playing nothing would read as a bug; walking when you meant to run reads as
// the world catching up.
const CLIP_FALLBACK = {
  run: 'walk', jump: 'idle', climb: 'walk',
  sit: 'idle', lie: 'idle', sitchair: 'sit',
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
export const SEAT_CLIPS = { ground: 'sitting_on_ground', chair: 'sitting_normal_chair' };

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
const _X = new THREE.Vector3(1, 0, 0);      // scratch — hot paths must not allocate
const _v2 = new THREE.Vector3();

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
        if (!target) continue;
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
    this.label = makeLabel(name);
    this.label.position.y = 1.95;
    this.root.add(this.label);
  }

  // ---- speech
  /** They're composing. Repeated calls extend it; it expires on its own so a
   *  dropped "stopped typing" never leaves the dots stuck up forever. */
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

    // ---- gaze: ease the target so eyes track instead of snapping
    if (this._hasGaze) this.gaze.position.lerp(this.gazeGoal, 1 - Math.exp(-6 * dt));
    else {
      _v.set(0, 1.5, 3).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.root.rotation.y)
        .add(this.root.position);
      this.gaze.position.lerp(_v, 1 - Math.exp(-3 * dt));
    }

    const em = this.vrm.expressionManager;
    if (em) {
      // ---- blink: irregular, in pairs sometimes, never metronomic
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const k = this.blinkT / 0.13;
        em.setValue('blink', k < 1 ? Math.sin(k * Math.PI) : 0);
        if (k >= 1) { this.blinkT = -1; em.setValue('blink', 0); }
      } else if (now > this.blinkAt) {
        this.blinkT = 0;
        this.blinkAt = now + (Math.random() < 0.22 ? 260 : 2200 + Math.random() * 4200);
      }
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
    this.vrm.update(dt);
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

  dispose() {
    scene.remove(this.root);
    scene.remove(this.gaze);
    if (this.bubble) disposeSprite(this.bubble);
    if (this.typing) disposeSprite(this.typing);
    disposeSprite(this.label);
    this.mixer.stopAllAction();
    this._composed.clear();
    VRMUtils.deepDispose?.(this.vrm.scene);
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
    // gpu lane: codegen slices interleave with the frame loop; the long tail
    // is driver-side pipeline creation, which overlaps other compiles fine.
    await enqueue(() => renderer.compileAsync(vrm.scene, camera, scene).catch(() => {}),
      { lane: 'gpu', priority });
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
