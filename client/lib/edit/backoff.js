// How long to wait before asking again after a refusal: doubles from `first` up to `cap`, back to `first` on reset (a
// success, or a different thing). A refusal for `rate` met with steady reads would stay refused. (tools/latestread-test.ts)
export function backoff(first = 2000, cap = 30000) {
  let next = first;
  return { next() { const w = next; next = Math.min(next * 2, cap); return w; }, reset() { next = first; } };
}
