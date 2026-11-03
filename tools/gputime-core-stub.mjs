// Test stand-in for client/lib/core.js as gputime.js sees it: a WebGL2-ish backend with a fake timer extension, and a
// scene whose traverse yields the test's lights.
export const lights = [];
const gl = {
  getExtension: (n) => (n === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 } : null),
  getParameter: () => false, createQuery: () => ({}), beginQuery() {}, endQuery() {},
  getQueryParameter: () => false, QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4,
};
export const renderer = { backend: { gl } };
export const scene = { traverse: (f) => lights.forEach(f) };
