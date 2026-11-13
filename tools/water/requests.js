// tools/water/requests.js — main's water-world records (asset/spawn/comp, as world-data/water/manifest.json holds them) as one
// `batch` of create/set requests, through the old-world translator's own mapping (import-v1/translate-v1.js project:
// water → zone + water, air boxes → zone + water-exclusion children, climb routes, collision, environment). Read by import.ts and prepare.ts.
import { emptyState, foldEntry } from '../protocol/import-v1/fold.js';
import { addSocket } from '../../shared/requests.js';
import { socketQ } from '../../shared/components.js';
import { stationOfBody } from '../protocol/import-v1/sockets.js';
import { project, deferredFeatures, volumeMappings, carriedMappings, unmappedOf, namespaceOf } from '../protocol/import-v1/translate-v1.js';

export const RECORD_VERBS = ['asset', 'spawn', 'comp', 'light', 'mount', 'motion'];
/** records → {batch, uploads, deferred, mapped, unmapped}: deferred (none in #248's world now) are listed and left out of the batch; unmapped is what rides imported.
 *  `ns` names what the protocol doesn't know (translate-v1 namespaceOf); every new thing is a '$<id>' placeholder. */
export function requestsOf(records, ns = 'water') {
  for (const v of records) if (!RECORD_VERBS.includes(v.verb)) throw Error(`unsupported record: ${v.verb}`);
  const entries = records.map((v, seq) => ({ seq, ts: 0, actor: 'import', ...structuredClone(v) }));
  const st = emptyState(); for (const e of entries) foldEntry(st, e);
  const effects = new Map(), deferred = deferredFeatures(entries), unknown = [], out = project(st, null, null, namespaceOf(ns), null, { effects, unknown }), blank = project(emptyState(), null, null, namespaceOf(ns))['@world'];
  const held = new Set(deferred.map((u) => `${u.id}\0${u.component}`));
  const base = (k) => k.split('/').pop().split(':')[0];
  const ph = (id) => `$${id}`, depth = (id) => { let n = 0; for (let p = out[id]?.parent?.to; p && n < 64; p = out[p]?.parent?.to) n++; return n; };
  const ops = [];
  for (const id of Object.keys(out).filter((x) => x !== '@world').sort((a, b) => depth(a) - depth(b))) {
    const components = {};
    for (const [k, v] of Object.entries(out[id])) if (!held.has(`${id}\0${base(k)}`)) components[k] = k === 'parent' && out[v?.to] ? { ...v, to: ph(v.to) } : v;
    // a sockets map is the old spelling the door refuses: its slots go as socket children of the host (each body its station)
    const sockets = components.sockets; delete components.sockets;
    ops.push({ verb: 'create', args: { id: ph(id), components } });
    let n = 0;
    if (sockets && typeof sockets === 'object') for (const [name, sk] of Object.entries(sockets)) { if (!sk || typeof sk !== 'object') continue;
      const sock = { name, ...Object.fromEntries(['part', 'accepts', 'radius'].filter((k) => sk[k] !== undefined).map((k) => [k, sk[k]])) };
      ops.push(addSocket(ph(id), sock, { id: `${ph(id)}-socket-${n++}`, pos: sk.pos, q: socketQ(sk), station: stationOfBody(sk.body) })); }
  }
  for (const [k, v] of Object.entries(out['@world'])) if (JSON.stringify(v) !== JSON.stringify(blank[k])) ops.push({ verb: 'set', args: { id: '@world', component: k, value: v } });
  // the derived particle effects the batch names (translate-v1 @24/@34), each an upload {effect} sent before it
  const uploads = [...effects.values()].map((effect) => ({ verb: 'upload', args: { effect } }));
  return { batch: { verb: 'batch', args: { requests: ops } }, uploads, deferred: deferred.map(({ component, feature, id }) => ({ component, feature, id })), mapped: [...volumeMappings(st), ...carriedMappings(st)], unmapped: [...unmappedOf(st), ...unknown] };   // unknown: keys no component has, carried as imported:<component>
}
