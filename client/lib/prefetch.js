// prefetch — background streaming of the library into client storage.
//
// Once arrival has settled, everything the world COULD need next — roster
// bodies, the model catalog, conjured store assets, other worlds' skies —
// streams quietly into the browser's HTTP cache, so the next spawn or walk-in
// is a disk read instead of a download. Idle bandwidth is otherwise wasted;
// this spends it.
//
// Three rules keep it honest:
//   1. Demand wins, instantly. The moment any real load starts (assets.js
//      'demand' event), the in-flight prefetch is ABORTED — the socket is
//      surrendered, not throttled — and the queue parks until the network has
//      been quiet for a while. A preempted asset just retries later; HTTP
//      caches never store partial bodies, so the demand fetch starts clean.
//   2. Storage only, never memory. Bytes are drained and dropped — the HTTP
//      cache keeps them, and the server's etag/immutable/max-age headers
//      already make every real load path (fetchBytes) hit that cache. Nothing
//      is parsed, nothing lands in the JS heap or on the GPU.
//   3. Budgeted, and never pinned. A per-session cap plus a storage-quota
//      floor; beyond that the browser's own LRU eviction is the eviction
//      policy — assets that get USED are the ones that stay warm, and a newly
//      needed asset displaces stale speculative ones by construction.

import { negotiate } from '../../shared/ktx2.js';
import { bus, CONFIG, report } from './core.js';
import { whenBooted } from './boot.js';
import { whenCalm } from './governor.js';
import { demandState, listLibrary, ktx2Capable, ktx2KeyReady } from './assets.js';

const QUIET_MS = 1500;      // demand-free time required before (re)taking the wire
const SESSION_CAP = 600e6;  // max bytes streamed per session — a long visit warms a lot, a peek doesn't
const QUOTA_FLOOR = 300e6;  // leave at least this much storage quota untouched

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Aborts the in-flight prefetch stream. Wired to the demand event permanently:
// preemption must not wait for the prefetcher's next turn around its loop.
let abortNow = null;
bus.on('demand', () => abortNow?.());

const stats = { queued: 0, fetched: 0, bytes: 0, skipped: 0, preempted: 0, done: false };
globalThis.__ewPrefetch = stats; // console-inspectable, like EW

async function quietWindow() {
  for (;;) {
    const { active, last } = demandState();
    const since = performance.now() - last;
    if (!active && since >= QUIET_MS) return;
    await sleep(active ? 350 : Math.max(100, QUIET_MS - since + 50));
  }
}

/** Stream one URL through to the HTTP cache; resolves to bytes drained.
 *  Throws {preempted:true} when a demand load kicked us off the wire. */
async function pull(url) {
  const ctl = new AbortController();
  let preempted = false;
  abortNow = () => { preempted = true; ctl.abort(); };
  try {
    const r = await fetch(url, { priority: 'low', signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    if (!r.body) return 0;
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return got;
      got += value.length;
    }
  } catch (e) {
    if (preempted) { const err = new Error('preempted'); err.preempted = true; throw err; }
    throw e;
  } finally { abortNow = null; }
}

async function quotaTight() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {};
    return quota > 0 && quota - usage < QUOTA_FLOOR;
  } catch { return false; }
}

// The queue is DISCOVERED, not hardcoded (the no-manifest rule applies here
// too), and ordered by how soon someone is likely to feel the miss:
//   1. roster bodies — a new walker materialising instantly is the single most
//      felt win, and their URLs are ?v=mtime versioned, so they cache forever
//   2. catalog previews — they turn the B picker from a wall of grey squares
//      into an actual catalog
//   3. everything spawnable — conjured store assets (content-addressed,
//      immutable) and the model library, smallest first: the most assets
//      warmed per byte, with the giants last, once the session has proven long
//   4. sky + weather sprites — other worlds' atmospheres; this world's are
//      warm already, so those re-pulls resolve from cache for free
async function buildQueue() {
  const q = [];
  const seen = new Set();
  // the running sequencer's key, or null — the same answer every demand
  // fetch gets, so warmth lands in the same cache entry (assets.js)
  const key = ktx2Capable() ? await ktx2KeyReady : null;
  const push = (path, size = 0) => {
    let url = path.startsWith('/') ? path : `/library/${path}`;
    // Warm the SAME cache key demand fetches will use (§20c gate finding):
    // capable clients fetch .glb/.vrm with ?ktx2=<key> — unflagged warmth lands
    // in a different HTTP-cache entry and is pure waste for them. Loose
    // images (§20d) negotiate too, but ONLY where the file layer does
    // (primeFiles, i.e. the curated toolkit dirs) — catalog previews and
    // other images are consumed unflagged, and flagging them here would be
    // the same wasted-warmth bug in the other direction.
    const bare = url.split('?')[0];
    if (key && (/\.(glb|vrm)$/.test(bare)
      || (/^\/library\/eidoverse\/assets\/(grass|sky|particle_textures)\//.test(bare) && /\.(png|jpe?g)$/i.test(bare)))) {
      url = negotiate(url, key);
    }
    if (!seen.has(url) && seen.add(url)) q.push({ url, size });
  };
  const roster = await fetch('/avatars').then((r) => r.json()).catch(() => []);
  for (const a of roster) push(a.path);
  const models = (await listLibrary('eidoverse/assets/models')) ?? [];
  for (const f of models) if (/_preview\.jpe?g$/i.test(f.path)) push(f.path, f.size);
  const store = (await listLibrary('store')) ?? [];
  const glbs = [...store, ...models.filter((f) => f.path.endsWith('.glb'))]
    .sort((a, b) => a.size - b.size);
  // Clips come from /animations, not the raw directory listing, for the same
  // reason avatars come from /avatars: the roster's paths carry ?v=<mtime>,
  // and warming a DIFFERENT url than the one vrmaBytes will request is warmth
  // thrown away (and the bytes pulled twice) — the §20 wasted-warmth bug, in
  // clip clothing. The roster also resolves upstream-patched over library, so
  // this warms the fork rather than the original it shadows.
  const clips = await fetch('/animations').then((r) => r.json()).catch(() => []);
  for (const c of clips) push(c.path, c.size);
  for (const f of glbs) push(f.path, f.size);
  for (const dir of ['eidoverse/assets/sky', 'eidoverse/assets/particle_textures'])
    for (const f of (await listLibrary(dir)) ?? []) push(f.path, f.size);
  return q;
}

export async function startPrefetch() {
  if (CONFIG.renderer) return;                        // the snap hub stays lean
  if (CONFIG.params.get('prefetch') === '0') return;  // escape hatch
  if (navigator.connection?.saveData) return;         // respect data saver
  await whenBooted();
  // The storm's edge (§16.2.D): the roster pull used to start ~5s in — 45MB
  // of speculative VRMs racing the boot storm's own compiles. Calm is the
  // governor's word: 5 smooth seconds with no load work in flight. This
  // gates only the SPECULATIVE stream — anything the world actually needs
  // goes through fetchBytes directly and never waited on prefetch, and the
  // 'demand' abort below still preempts us the instant a real load starts.
  await whenCalm();
  await quietWindow(); // let the join's own warm-fetches drain first
  const queue = await buildQueue().catch((e) => { report('prefetch', e); return []; });
  if (!queue.length) return;
  stats.queued = queue.length;
  const listed = queue.reduce((s, f) => s + f.size, 0);
  console.log(`[prefetch] ${queue.length} assets queued (~${(listed / 1e6).toFixed(0)}MB listed)`);
  while (queue.length) {
    if (stats.bytes >= SESSION_CAP) { console.log('[prefetch] session cap reached'); break; }
    if (stats.fetched % 25 === 0 && (await quotaTight())) { console.log('[prefetch] storage quota tight — stopping'); break; }
    await quietWindow();
    try {
      stats.bytes += await pull(queue[0].url);
      stats.fetched++;
      queue.shift();
    } catch (e) {
      if (e.preempted) { stats.preempted++; continue; } // same asset, after the next quiet window
      stats.skipped++; queue.shift();                   // 404 etc — drop it, move on
    }
  }
  stats.done = true;
  console.log(`[prefetch] done: ${stats.fetched} streamed (${(stats.bytes / 1e6).toFixed(1)}MB), `
    + `${stats.preempted} preemption(s), ${stats.skipped} skipped`);
}
