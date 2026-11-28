// Retry delay after a refusal: doubles from `first` up to `cap`; reset() goes back to `first`. Steady re-asks would keep
// a `rate` refusal refused. (test/client/latestread-test.ts)
export function backoff(first = 2000, cap = 30000) {
  let next = first;
  return { next() { const w = next; next = Math.min(next * 2, cap); return w; }, reset() { next = first; } };
}
