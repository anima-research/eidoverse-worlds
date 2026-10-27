// tools/water/requests.js — main's water-world records (asset/spawn/comp, as world-data/water/manifest.json holds them) as one
// `batch` of create/set requests, through the old-world translator's own mapping (import-v1/translate-v1.js project:
// water → zone + water, air boxes → zone + water-exclusion children). Read by import.ts and prepare.ts.
import { emptyState, foldEntry } from '../protocol/import-v1/fold.js';
import { project, deferredFeatures, volumeMappings, namespaceOf } from '../protocol/import-v1/translate-v1.js';

export const RECORD_VERBS = ['asset', 'spawn', 'comp', 'light', 'mount', 'motion'];
/** records → {batch, deferred, mapped}: deferred (traversal, vehicle, collision) are listed and left out of the batch.
 *  `ns` names what the protocol doesn't know (translate-v1 namespaceOf); every new thing is a '$<id>' placeholder. */
export function requestsOf(records, ns = 'water') {
  for (const v of records) if (!RECORD_VERBS.includes(v.verb)) throw Error(`unsupported record: ${v.verb}`);
  const entries = records.map((v, seq) => ({ seq, ts: 0, actor: 'import', ...structuredClone(v) }));
  const st = emptyState(); for (const e of entries) foldEntry(st, e);
  const deferred = deferredFeatures(entries), out = project(st, null, null, namespaceOf(ns)), blank = project(emptyState(), null, null, namespaceOf(ns))['@world'];
  const held = new Set(deferred.map((u) => `${u.id}\0${u.component}`));
  const base = (k) => k.split('/').pop().split(':')[0];
  const ph = (id) => `$${id}`, depth = (id) => { let n = 0; for (let p = out[id]?.parent?.to; p && n < 64; p = out[p]?.parent?.to) n++; return n; };
  const ops = [];
  for (const id of Object.keys(out).filter((x) => x !== '@world').sort((a, b) => depth(a) - depth(b))) {
    const components = {};
    for (const [k, v] of Object.entries(out[id])) if (!held.has(`${id}\0${base(k)}`)) components[k] = k === 'parent' && out[v?.to] ? { ...v, to: ph(v.to) } : v;
    ops.push({ verb: 'create', args: { id: ph(id), components } });
  }
  for (const [k, v] of Object.entries(out['@world'])) if (JSON.stringify(v) !== JSON.stringify(blank[k])) ops.push({ verb: 'set', args: { id: '@world', component: k, value: v } });
  return { batch: { verb: 'batch', args: { ops } }, deferred: deferred.map(({ component, feature, id }) => ({ component, feature, id })), mapped: volumeMappings(st) };
}
