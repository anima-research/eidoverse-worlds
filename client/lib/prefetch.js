// prefetch — background streaming of the library into the browser's HTTP cache, once arrival has settled, so the
// next spawn or walk-in is a disk read instead of a download.
//
// Three rules:
//   1. Demand wins, instantly: any real load (assets.js 'demand' event) aborts the in-flight prefetch, and the queue
//      parks until the network has been quiet for QUIET_MS. A preempted asset retries later.
//   2. Storage only, never memory: bytes are drained and dropped; the HTTP cache keeps them.
//   3. Budgeted, never pinned: a per-session cap and a storage-quota floor; beyond that the browser's own LRU evicts.

import { negotiate } from '../../shared/ktx2.js';
import { bus, CONFIG, report } from './base.js';
import { whenBooted } from './boot.js';
import { whenCalm } from './render/governor.js';
import { demandState, listLibrary, ktx2Capable, ktx2KeyReady } from './assets.js';

const QUIET_MS = 1500;      // demand-free time required before (re)taking the wire
const SESSION_CAP = 600e6;  // max bytes streamed per session — a long visit warms a lot, a peek doesn't
const QUOTA_FLOOR = 300e6;  // leave at least this much storage quota untouched

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// aborts the in-flight prefetch stream the instant demand starts, not at the loop's next turn
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

// The queue is discovered from the server's listings, ordered by how soon someone would feel the miss:
//   1. roster bodies (a new walker materialising instantly)
//   2. catalog previews (the B picker)
//   3. animation clips
//   4. everything spawnable: store assets and the model library, smallest first
//   5. sky + weather sprites (other worlds' atmospheres; this world's are warm already)
async function buildQueue() {
  const q = [];
  const seen = new Set();
  // the KTX2 key demand fetches use, so warmth lands in the same cache entry (assets.js)
  const key = ktx2Capable() ? await ktx2KeyReady : null;
  const push = (path, size = 0) => {
    let url = path.startsWith('/') ? path : `/library/${path}`;
    // capable clients fetch .glb/.vrm with ?ktx2=<key>; loose images negotiate only where assets.js primeFiles does
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
  // clips from /animations, not the directory listing: its paths carry the ?v=<mtime> the real fetch uses
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
  // wait for the governor's calm (5 smooth seconds, no load work in flight) so speculative fetches don't race the boot storm
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
