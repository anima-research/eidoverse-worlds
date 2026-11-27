// My identity and my body's handle — the avatar path resolution, the `me`
// avatar every module reads through getMe(), and the swap/update wiring that
// replaces it (TEL0S_NOTES §14). One owner; everyone else holds the getter.
// Nothing here may import main.js.

import { CONFIG, bus, report, tee } from '../base.js';
import { DEFAULT_BODY } from '../../../shared/avatardefs.js';
import { releaseBodyGate } from '../render/bodygate.js';
import { armFlightForBody, folded } from './controller.js';
import { makeAvatar } from '../avatar/avatar.js';
import { contributeThumbnail } from '../avatar/avatar-thumbnail.js';
import { setMyAvatarPath, wireAvatarSwitch } from '../edit/catalog.js';
import { toast } from '../ui/ui.js';
import { net } from '../net.js';
import { loadBodyPrefs, saveBodyPrefs } from '../../../shared/bodyscale.js';
import { applyOwnBodyShadow } from '../render/materials.js';
import { warmDepth, warmLit } from '../render/warmqueue.js';

// ---------------------------------------------------------------- identity

// No boot-blocking roster round-trip: a bare name resolves from the cached last
// resolution or the roster the join snapshot carries. UI that wants the full
// roster (the first-run door, the avatar panel) fetches it lazily at open.
const want = CONFIG.params.get('avatar') || localStorage.getItem('ew-avatar-name') || 'claude';
let myAvatarName = want.includes('/') ? want.split('/').pop().replace(/\.vrm.*$/, '') : want;
let myAvatarPath = want.includes('/') ? want : null;
if (!myAvatarPath) {
  try {
    const c = JSON.parse(localStorage.getItem('ew-avatar-path') ?? 'null');
    if (c?.name === want && typeof c.path === 'string') myAvatarPath = c.path;
  } catch { /* cold cache — the snapshot roster resolves it */ }
}
if (myAvatarPath) setMyAvatarPath(myAvatarPath);
export const rosterLazy = () => fetch('/avatars').then((r) => r.json()).catch(() => []);
// Cold cache only: START the roster fetch now; resolving the avatar path takes
// whichever lands first, it or the snapshot's roster. The multi-MB VRM is the
// long pole, so its download starts as early as possible. Warm boots have the
// cached path and don't wait for the roster (they refresh it, below).
const rosterEarly = myAvatarPath ? null : rosterLazy();
// Warm boots still REFRESH the stored resolution in the background: the cached
// path carries a frozen ?v= stamp, so a redeployed avatar would otherwise replay
// from HTTP cache forever. The cached path wins this boot; the next reload wears
// the new version.
if (myAvatarPath) {
  rosterLazy().then((list) => {
    const fresh = (list ?? []).find((a) => a.name === myAvatarName)?.path;
    if (fresh && fresh !== myAvatarPath) {
      try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name: myAvatarName, path: fresh })); } catch { /* private mode */ }
      console.log(`[avatar] ${myAvatarName} was updated on the server — reload to wear the new version`);
    }
  });
}
/** The body path: cache, else whichever of (early fetch | snapshot roster)
 *  lands first. Nothing here ever blocked the module graph. */
export async function resolveMyAvatarPath() {
  if (myAvatarPath) return myAvatarPath;
  const fromBus = new Promise((res) => {
    const off = bus.on('avatars', (l) => { off(); res(l); });
    setTimeout(() => { off(); res(null); }, 8000);   // offline: default body
  });
  const list = net.avatars ?? await Promise.race([rosterEarly, fromBus]) ?? [];
  myAvatarPath = (list ?? []).find((a) => a.name === want)?.path ?? DEFAULT_BODY;
  try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name: want, path: myAvatarPath })); } catch { /* private mode */ }
  setMyAvatarPath(myAvatarPath);
  return myAvatarPath;
}

/** What the wire announces as my body: the resolved path, or the bare name —
 *  the server resolves names for everyone else's view either way. */
export function getMyAvatarPath() { return myAvatarPath ?? want; }
export function getMyAvatarName() { return myAvatarName; }
// the bodies panel (bodies.js) lists what you have worn; the Avatar object itself carries neither name nor path,
// so the two sites that know both announce it: the initial body (main.js) and a switch (wireAvatarSwitch below)
export function announceWorn(name, path) { if (name) bus.emit('avatar-worn', { name, path: path ?? null }); }

/** The door (and the bad-key re-door) hands a choice here. `remember` is the
 *  first-run door's cache write; the bad-key path never persisted, and still
 *  doesn't. */
export function chooseAvatar(path, name, { remember = false } = {}) {
  myAvatarPath = path; myAvatarName = name; setMyAvatarPath(path);
  if (remember) {
    try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name, path })); } catch { /* private mode */ }
  }
}

// ---------------------------------------------------------------- the handle

let me = null;
let seenFirstBody = false;
export function getMe() { return me; }
// ---------------------------------------------------------------- this body's size / plate lift
// Per body, per browser (bodyscale.js: ew-body-prefs, keyed by the worn body's NAME, like ew-xr-scale). Applied on
// every setMe — boot, a switch, a server-side refresh — so wearing a body again restores what you chose for it. The
// wire (net.js sendPose → bodyWire) reads it off the Avatar; nothing else needs telling.
let lsRef = null;
try { lsRef = globalThis.localStorage ?? null; } catch { lsRef = null; }
export function myBodyPrefs() { return loadBodyPrefs(lsRef, getMyAvatarName()); }
function applyMyBodyPrefs(av) {
  if (!av) return;
  const p = myBodyPrefs();
  av.setUserScale?.(p.scale);
  av.setPlateY?.(p.plateY);
  applyOwnBodyShadow(av, { warm: warmDepth, lit: warmLit, still: () => me === av }).catch((e) => report('my shadow', e));
}
bus.on('my-shadow', () => { if (me) applyMyBodyPrefs(me); });
/** Profile › Avatar writes here: { scale?, plateY? } for the body you have on, saved and worn at once. `name` is for a
 *  write that outlived its body (bodies.js's rest-timer save after a switch): saved under it, worn only if still on. */
export function setMyBodyPref(patch, name = getMyAvatarName()) {
  const p = saveBodyPrefs(lsRef, name, patch);
  if (name !== getMyAvatarName()) return p;
  if (me) { me.setUserScale?.(p.scale); me.setPlateY?.(p.plateY); }
  bus.emit('body-prefs', p);
  return p;
}

export function setMe(av) {
  me = av;
  applyMyBodyPrefs(av);
  if (me) {
    releaseBodyGate('body on screen');
    // ONE '[body] on screen' per page — it is the load metric; later setMe
    // calls are body changes.
    if (!seenFirstBody) { seenFirstBody = true; tee(`[body] on screen +${(performance.now() / 1000).toFixed(1)}s`); }
    else tee(`[body] changed → ${getMyAvatarName()}`);
  }
  bus.emit('avatar-worn', me ? getMyAvatarName() : null);
  if (me) me.wingsFolded = folded();
  armFlightFor(av);
}

/** Arm flight for whatever body this is now, on every swap (controller.js armFlightForBody), and say what changed. */
function armFlightFor(av) {
  const say = armFlightForBody(av, 'me');
  if (say) toast?.(say);
}

// ---------------------------------------------------------------- avatar swap

wireAvatarSwitch(async (path, name) => {
  // Same path is a no-op unless the body on screen is the capsule:
  // `myAvatarPath` records intent and survives a failed load, so wearing the
  // body we already "have" is the retry.
  if (path === myAvatarPath && !me?.isCapsule) return;
  toast(`changing into ${name}…`, 'info', 3000);
  try {
    // Switch order is load-bearing: the NEW body is fully ready before the old
    // one sheds. dispose() releases its VRM to the instance pool, so switching
    // BACK is a pool-hit, not a re-parse.
    const next = await makeAvatar(CONFIG.name, path, { urgent: true }); // build before shedding the old
    me?.dispose();
    // name and path FIRST: setMe announces 'avatar-worn' with the current name,
    // and My Avatars / the profile read it — set after, they heard the old body
    myAvatarPath = path;
    myAvatarName = name;
    announceWorn(name, path);
    setMyAvatarPath(path);
    setMe(next);
    localStorage.setItem('ew-avatar-name', name);
    contributeThumbnail(name, next.vrm, CONFIG.token, { path });
    if (net.joined) {
      // re-announce: everyone rebuilds my remote with the new body
      const { sendJoin } = await import('../net.js');
      sendJoin();
    }
  } catch (e) { report(`avatar switch ${name}`, e); }
});

// The `?.` is load-bearing (TEL0S_NOTES §14.1): on a cold cache the path can still be null when
// avatar-updated arrives.
bus.on('avatar-updated', ({ path, name, fresh }) => {
  if (myAvatarPath?.split('?')[0] === path) {
    toast(`your body "${name}" was updated — refreshing`, 'info');
    myAvatarPath = fresh;
    makeAvatar(CONFIG.name, fresh, { urgent: true }).then((av) => { me?.dispose(); setMe(av); }).catch((e) => report('reload avatar', e));
  }
});
