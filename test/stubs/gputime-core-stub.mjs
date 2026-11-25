// Test stand-in for client/lib/core.js as gputime.js sees it: a WebGL2-ish backend with a fake timer extension, and a
// scene whose traverse yields the test's lights. `em` drives the extension: answer=false leaves every query pending;
// answer=true makes an ended query read `ns`; disjoint is the driver's GPU_DISJOINT flag.
export const lights = [];
export const em = { answer: false, ns: 2e6, disjoint: false, begins: 0 };
const ended = new WeakSet();
const gl = {
  getExtension: (n) => (n === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 } : null),
  getParameter: (p) => (p === 2 ? em.disjoint : false), createQuery: () => ({}),
  beginQuery(_t, q) { em.begins++; ended.delete(q); this._cur = q; }, endQuery() { if (this._cur) ended.add(this._cur); this._cur = null; },
  getQueryParameter: (q, p) => (p === 3 ? em.answer && ended.has(q) : p === 4 ? em.ns : false), QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4,
};
export const renderer = { backend: { gl } };
export const scene = { traverse: (f) => lights.forEach(f) };
