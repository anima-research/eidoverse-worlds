// bun test/water/wp5-verdict-test.ts — WP5's verdict (wp5-verdict.ts) on synthetic evidence: its negative controls,
// run without the browser session water-cross needs
import { wp5Verdict } from "./wp5-verdict.ts";
import { suite } from "../gate/suite.ts";
const { check, done } = suite("wp5-verdict");
const R = [251, 16, 20], K = [12, 12, 13], SKY = [56, 128, 158];
check("WP5a control: a NON-fallback adapter with a black reference still fails", wp5Verdict({ fb: false, settled: true, centre: K, ref: { pts: [K, K, K], mean: K } }) === "fail");
check("WP5b control: a fallback adapter with a readable reference still runs the red assertion (black fails, red passes)",
  wp5Verdict({ fb: true, settled: true, centre: K, ref: { pts: [SKY, SKY, SKY], mean: SKY } }) === "fail" && wp5Verdict({ fb: true, settled: true, centre: R, ref: { pts: [SKY, SKY, SKY], mean: SKY } }) === "pass");
check("WP5c a fallback adapter with a black reference is not observable (n/a), never a pass", wp5Verdict({ fb: true, settled: true, centre: R, ref: { pts: [K, K, K], mean: K } }) === "n/a");
done();
