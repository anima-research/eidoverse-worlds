// lod-loader-probe — runs the PRODUCTION loader (client/lib/assets.js,
// unmodified) against an owned sequencer and reports what it did.
//
// Spawned by tools/lod-client-test.ts, once per /version shape:
//   LODC_BASE      the owned child's base URL
//   LODC_STRIP     '' | 'lodRecipe' | 'ktx2Key' — a field removed from the
//                  child's /version answer at the network seam, so the same
//                  real module is exercised as it would be against an older
//                  sequencer (no recipe) or one that negotiates nothing (no key)
//   LODC_HEAVY     a library rel the child has baked a LOD variant for
//   LODC_AUTHORED  a light library rel whose SOURCE carries a `recipe` extra
//
// Only two things sit below the module: a renderer that never draws and
// frame conductors that run at once (tools/lod-loader-stub.mjs), and a fetch
// shim that resolves the loader's relative URLs against the child and
// records every URL that crossed. Review of #170, round three: a mutation at
// the loader's decision seam — `tier = req.tier` → `tier = 'full'`, the url,
// the glbKey, the tierAsked / tierServed stamps — must FAIL the gate, so the
// gate has to run the real seam. Output: one line, `PROBE {json}`.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

const BASE = process.env.LODC_BASE!;
const STRIP = process.env.LODC_STRIP ?? '';
const HEAVY = process.env.LODC_HEAVY!;
const AUTHORED = process.env.LODC_AUTHORED!;

// a DOM event class three's FileLoader constructs for progress callbacks;
// Bun has no DOM. Below the seam, like the renderer.
if (!(globalThis as any).ProgressEvent) {
  (globalThis as any).ProgressEvent = class ProgressEvent extends Event {
    lengthComputable: boolean; loaded: number; total: number;
    constructor(type: string, init: any = {}) { super(type); this.lengthComputable = !!init.lengthComputable; this.loaded = init.loaded ?? 0; this.total = init.total ?? 0; }
  };
}
// whatever the module does in the background must not take the answer with
// it: a rejection anywhere is reported, and the probe still prints its line
const background: string[] = [];
process.on('unhandledRejection', (e: any) => { background.push(String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')); });

// the network seam: relative → the child; /version minus one field, when asked
const fetched: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  let url: string = typeof input === 'string' ? input : input.url;
  if (url.startsWith('/')) url = BASE + url;
  fetched.push(url.startsWith(BASE) ? url.slice(BASE.length) : url);
  const r = await realFetch(url, init);
  if (STRIP && url.endsWith('/version')) {
    const j = await r.json();
    delete j[STRIP];
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return r;
}) as any;

const STUB = fileURLToPath(new URL('./lod-loader-stub.mjs', import.meta.url));
plugin({
  name: 'lod-loader-stub',
  setup(b) {
    for (const f of ['^\\./core\\.js$', '^\\./loadwork\\.js$', '^\\./warmqueue\\.js$', '^\\./materials\\.js$', '^\\./draw_batches\\.js$']) {
      b.onResolve({ filter: new RegExp(f) }, () => ({ path: STUB }));
    }
  },
});

const A: any = await import('../client/lib/assets.js');
await A.negotiationReady;
const identity = (o: any) => ({ glbKey: o.userData.glbKey, asked: o.userData.tierAsked, served: o.userData.tierServed });
const out: any = {
  strip: STRIP,
  capable: A.ktx2Capable(),
  negotiable: A.lodNegotiable(HEAVY),
  resolve: A.resolveLoadRequest(HEAVY, 'lod'),
};
try {
  out.lod = identity(await A.loadGLB(HEAVY, { tier: 'lod' }));
  out.full = identity(await A.loadGLB(HEAVY, { tier: 'full' }));
  out.authored = identity(await A.loadGLB(AUTHORED, { tier: 'lod' }));
} catch (e: any) {
  out.error = String(e?.stack ?? e);
}
out.fetched = fetched;
out.background = background;
console.log('PROBE ' + JSON.stringify(out));
process.exit(0);
