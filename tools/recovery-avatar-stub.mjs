// avatar.js stand-in for capsule-recovery-test.
//
// The members are taken from what remotes.js ACTUALLY reaches for (grepped, not guessed — a stub that
// invents product shape is this stack's most repeated test failure). `isCapsule` is the real flag
// avatar.js sets on makeCapsuleAvatar's product; everything else is an inert spy.
//
// One shared control object, `globalThis.__avatarProbe`, so the test and this stub cannot drift:
//   .failing  — whether makeAvatar rejects
//   .attempts — how many real-body loads were requested
import { THREE } from './core-stub.mjs';

const probe = (globalThis.__avatarProbe ||= { failing: true, attempts: 0, made: [], bodies: [] });
probe.bodies ||= [];   // every REAL body handed out, so a test can read its dispose flag

function body(kind) {
  return {
    kind,
    isCapsule: kind === 'capsule',
    root: new THREE.Object3D(),
    pitch: 0,
    disposed: false,
    dispose() { this.disposed = true; },
    resetTransients() {},
    update() {}, setClip() {}, setPose() {}, clearPose() {}, setLimp() {},
    setGazeTarget() {}, setSeatApprox() {}, playEmote() {},
  };
}

export async function makeAvatar(id, libPath) {
  probe.attempts++;
  probe.made.push({ id, libPath });
  // `loadMs` lets a test hold a load IN FLIGHT, which is the only way to reach the guard that runs
  // AFTER the await — a supersede during the backoff is caught by the earlier guard instead.
  if (probe.loadMs) await new Promise((r) => setTimeout(r, probe.loadMs));
  if (probe.failing) throw new Error(`stub: body load refused (${libPath})`);
  const b = body('real');
  probe.bodies.push(b);   // the caller may dispose it; the test reads that
  return b;
}

export function makeCapsuleAvatar() { return body('capsule'); }
