// bun tools/library-status-probe.mjs — /library-models carries each entry's optimization status (opt.{min,ktx2,lod}),
// read from the sweep's markers. Uses an owned world server; asserts shape on every entry and that states are the
// documented set. Real counts depend on the host's store, so they are printed, not asserted.
import { ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
try {
  const r = await fetch(`${world.origin}/library-models`, { headers: { cookie: world.cookie ?? '' } });
  const hits = await r.json();
  const STATES = new Set(['built', 'not-needed', 'unsupported', 'refused', 'stale', 'deferred', 'pending']);
  // store/ entries have all three passes; library entries have no draco 'min' pass at all, so no min field
  const want = (h) => (h.path.startsWith('store/') ? ['min', 'ktx2', 'lod'] : ['ktx2', 'lod']);
  const bad = hits.filter((h) => !h.opt || !want(h).every((k) => STATES.has(h.opt[k]?.state) && ('reason' in h.opt[k]))
    || (!h.path.startsWith('store/') && 'min' in h.opt));
  const tally = {};
  for (const h of hits) for (const k of ['min', 'ktx2', 'lod']) { const s = h.opt?.[k]?.state; tally[`${k}:${s}`] = (tally[`${k}:${s}`] ?? 0) + 1; }
  console.log(`  ${hits.length} entries; ${JSON.stringify(tally)}`);
  check('every entry carries the opt fields its kind HAS (store: min/ktx2/lod; library: ktx2/lod, no phantom min)', r.ok && hits.length > 0 && bad.length === 0, bad.slice(0, 2));
  // every pass, not only the LOD; and with no refusal in this catalog the check has no subject — say so, don't pass
  const NEEDS = ['refused', 'unsupported', 'stale', 'deferred'];
  const refused = hits.flatMap((h) => Object.entries(h.opt ?? {}).filter(([, v]) => NEEDS.includes(v?.state)).map(([k, v]) => ({ path: h.path, pass: k, ...v })));
  if (refused.length) check(`no refusal is silent: all ${refused.length} non-built, non-pending states (min/ktx2/lod) carry a reason`, refused.every((v) => v.reason), refused.filter((v) => !v.reason).slice(0, 2));
  else console.log('  – SKIP no refusal is silent: this catalog has no refused/stale/deferred pass (the blank-reason rule is covered by variant-status-test "empty marker")');
  // served cost is ranked on the file a KTX2-negotiating client really gets: fetch it and rank THOSE bytes
  const { glbPerf } = await import('../server/glbperf.ts');
  const ver = await (await fetch(`${world.origin}/version`)).json().catch(() => ({}));
  const key = ver.ktx2Key;
  const sample = hits.filter((h) => h.perf).filter((_, i) => i % 6 === 0).slice(0, 10);
  const bad2 = [];
  for (const h of sample) {
    const b = new Uint8Array(await (await fetch(`${world.origin}/library/${h.path}${key ? `?ktx2=${key}` : ''}`)).arrayBuffer());
    const p = glbPerf(b);
    if (p.tris !== h.perf.tris || Math.abs(p.texMB - h.perf.texMB) > 0.01 || p.rank !== h.perf.rank) bad2.push(`${h.name}: served bytes ${p.tris}/${p.texMB} vs catalog ${h.perf.tris}/${h.perf.texMB} (${h.perf.servedAs})`);
  }
  console.log(`  served check on ${sample.length} entries (ktx2 key ${key ?? 'none'}); servedAs: ${JSON.stringify(Object.fromEntries(Object.entries(hits.reduce((a, h) => ((a[h.perf?.servedAs] = (a[h.perf?.servedAs] ?? 0) + 1), a), {}))))}`);
  check('the catalog\'s perf is the perf of the bytes /library actually serves (KTX2-negotiated)', key && sample.length >= 5 && bad2.length === 0, bad2.slice(0, 3));
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await world.close(); }
done();
