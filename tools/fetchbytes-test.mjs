// fetchBytes (client/lib/assets.js): retry 5xx and network failures (3 tries), never retry a 4xx, EVICT a
// rejected entry so the next ask starts clean, and share one in-flight fetch between concurrent callers.
// Review 2026-09-10 #1 removed the eviction and the suite stayed green — this drives the REAL function
// against a scripted global fetch and counts every call.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });

// ---- the scripted network: per-path queues of {status|throw|hold}; every call is logged
const script = new Map(), calls = [];
let held = [];
globalThis.fetch = async (path) => {
  calls.push(path);
  const q = script.get(path) ?? [];
  const step = q.length ? q.shift() : { status: 200 };
  if (step.hold) await new Promise((r) => held.push(r));
  if (step.throw) throw new TypeError('network down');
  return new Response(step.status === 200 ? new Uint8Array(step.len ?? 16) : null, { status: step.status, headers: step.status === 200 ? { 'content-length': String(step.len ?? 16) } : {} });
};
// retry back-off is 0.7 s then 1.8 s; shrink the wait, keep the count
const _setTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => _setTimeout(fn, ms >= 700 ? 1 : ms, ...a);

const { fetchBytes } = await import('../client/lib/assets.js');
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const count = (p) => calls.filter((c) => c === p).length;
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
// a call that rejects when it should resolve is a FAIL line, never an uncaught rejection
const resolves = async (p) => { try { return { buf: await p, err: null }; } catch (err) { return { buf: null, err }; } };

console.log('FETCHBYTES — 503, 503, 200');
{ const P = '/library/a.glb'; script.set(P, [{ status: 503 }, { status: 503 }, { status: 200, len: 24 }]);
  const { buf, err } = await resolves(fetchBytes(P));
  check('three attempts, then success', count(P) === 3 && buf?.byteLength === 24, `${count(P)} calls, ${buf?.byteLength} bytes${err ? `, rejected: ${err.message}` : ''}`);
  await resolves(fetchBytes(P));
  check('a success is cached (no fourth fetch)', count(P) === 3); }
console.log('FETCHBYTES — 404 is final, and evicted');
{ const P = '/library/b.glb'; script.set(P, [{ status: 404 }, { status: 200, len: 8 }]);
  const e = await rejects(fetchBytes(P));
  check('one attempt, rejected', count(P) === 1 && /404/.test(e?.message ?? ''), `${count(P)} calls; ${e?.message}`);
  const { buf, err } = await resolves(fetchBytes(P));
  check('the same path fetches AGAIN and succeeds (rejected entry evicted)', count(P) === 2 && buf?.byteLength === 8, `${count(P)} calls${err ? `, rejected again: ${err.message}` : ''}`); }
console.log('FETCHBYTES — three network failures');
{ const P = '/library/c.glb'; script.set(P, [{ throw: 1 }, { throw: 1 }, { throw: 1 }, { status: 200, len: 4 }]);
  const e = await rejects(fetchBytes(P));
  check('three attempts, then the network error', count(P) === 3 && e instanceof TypeError, `${count(P)} calls; ${e?.constructor?.name}`);
  const { buf, err } = await resolves(fetchBytes(P));
  check('the next ask starts clean and succeeds', count(P) === 4 && buf?.byteLength === 4, `${count(P)} calls${err ? `, rejected again: ${err.message}` : ''}`); }
console.log('FETCHBYTES — concurrent callers');
{ const P = '/library/d.glb'; script.set(P, [{ status: 200, len: 32, hold: 1 }]);
  const p1 = fetchBytes(P), p2 = fetchBytes(P);
  await new Promise((r) => _setTimeout(r, 5));
  check('one underlying fetch while both wait', count(P) === 1 && held.length === 1, `${count(P)} calls`);
  held.forEach((r) => r()); held = [];
  const [{ buf: a }, { buf: b }] = await Promise.all([resolves(p1), resolves(p2)]);
  check('both callers get the same bytes', a && a === b && a.byteLength === 32); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
