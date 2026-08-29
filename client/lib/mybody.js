// My identity and my body's handle — the avatar path resolution, the `me`
// avatar every module reads through getMe(), and the swap/update wiring that
// replaces it. Extracted from main.js (§14 6c): `me` was closed over by ~18
// sites; now there is one owner and everyone else holds the getter. Nothing
// here may import main.js.

import { CONFIG, bus, report } from './core.js';
import { makeAvatar, contributeThumbnail } from './avatar.js';
import { setMyAvatarPath, wireAvatarSwitch } from './palette.js';
import { toast } from './ui.js';
import { net } from './net.js';

// ---------------------------------------------------------------- identity

// No boot-blocking roster round-trip: the top-level `await fetch('/avatars')`
// that lived here gated the ENTIRE module graph on one RTT (the bench's
// "engine" number silently included it). A bare name now resolves from
// (1) the cached last resolution, or (2) the roster the join snapshot
// carries — and the server resolves names for everyone ELSE's view either
// way, so the wire never waits on us. UI that wants the full roster (the
// first-run door, the avatar panel) fetches it lazily at open.
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
// Cold cache only: START the roster fetch now, await it never — it rides in
// parallel with module parse and GPU init instead of gating them, and the
// body begins downloading as early as the old blocking prologue allowed.
// (Measured: making the body wait for the SNAPSHOT's roster instead cost
// +350ms at 25mbit/40ms — the multi-MB VRM is the long pole, and its start
// time is the boot.) Warm boots have the cached path and skip the request.
const rosterEarly = myAvatarPath ? null : rosterLazy();
// Warm boots must still REFRESH the stored resolution: the cached path
// carries a frozen ?v= stamp, so an avatar redeployed under the same name
// would otherwise replay from HTTP cache forever (bit 08-12: three hair
// retunes deployed to the box, zero ever reached a returning client — the
// live sim was running the day-one file). The cached path still wins THIS
// boot — nothing here blocks — but the roster re-resolves in the background
// and rewrites the cache, so the next reload wears the new version.
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
  myAvatarPath = (list ?? []).find((a) => a.name === want)?.path ?? 'eidoverse/assets/vrms/claude.vrm';
  try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name: want, path: myAvatarPath })); } catch { /* private mode */ }
  setMyAvatarPath(myAvatarPath);
  return myAvatarPath;
}

/** What the wire announces as my body: the resolved path, or the bare name —
 *  the server resolves names for everyone else's view either way. */
export function getMyAvatarPath() { return myAvatarPath ?? want; }
export function getMyAvatarName() { return myAvatarName; }

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
export function getMe() { return me; }
export function setMe(av) { me = av; }

// ---------------------------------------------------------------- avatar swap

wireAvatarSwitch(async (path, name) => {
  if (path === myAvatarPath) return;
  toast(`changing into ${name}…`, 'info', 3000);
  try {
    // The switch order is load-bearing (§19b): NEW body fully ready (pool-hit
    // or parse+compile; the Avatar constructor is the swap into the scene) →
    // only then does the old body shed. dispose() releases its VRM to the
    // instance pool, so switching BACK is a 0ms pool-hit, not a re-parse.
    const next = await makeAvatar(CONFIG.name, path, { urgent: true }); // build before shedding the old
    me?.dispose();
    me = next;
    myAvatarPath = path;
    myAvatarName = name;
    setMyAvatarPath(path);
    localStorage.setItem('ew-avatar-name', name);
    contributeThumbnail(name, next.vrm, CONFIG.token);
    if (net.joined) {
      // re-announce: everyone rebuilds my remote with the new body
      const { sendJoin } = await import('./net.js');
      sendJoin();
    }
  } catch (e) { report(`avatar switch ${name}`, e); }
});

// The `?.` on myAvatarPath is load-bearing (§14.1 found bug): on a cold cache
// the path is still null when an avatar-updated event can already arrive —
// the old handler threw before resolve had run.
bus.on('avatar-updated', ({ path, name, fresh }) => {
  if (myAvatarPath?.split('?')[0] === path) {
    toast(`your body "${name}" was updated — refreshing`, 'info');
    myAvatarPath = fresh;
    makeAvatar(CONFIG.name, fresh, { urgent: true }).then((av) => { me?.dispose(); me = av; }).catch((e) => report('reload avatar', e));
  }
});
