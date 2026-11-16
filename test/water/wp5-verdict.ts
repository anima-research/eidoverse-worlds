// test/water/wp5-verdict.ts — water-cross's WP5 verdict (crossing-pipelines-check.ts), a pure function of its evidence.
// WP5's policy: a readable reference keeps the red-fog assertion; a FALLBACK adapter whose reference is uniformly
// near-black can't show fog colour at all, so the row records "not observable" (with the evidence), never "water correct"
const nearBlack = (p: number[]) => Math.max(...p) < 30;
export function wp5Verdict(e: { fb: unknown; settled: boolean; centre: number[]; ref: { pts: number[][]; mean: number[] } }): "pass" | "n/a" | "fail" {
  const refBlack = e.ref.pts.every(nearBlack) && nearBlack(e.ref.mean);
  if (!refBlack) return e.settled && e.centre[0] > 180 && e.centre[1] < 60 && e.centre[2] < 60 ? "pass" : "fail";
  return e.fb === true ? "n/a" : "fail";
}
