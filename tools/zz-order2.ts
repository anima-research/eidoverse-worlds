import { Sfu } from "../server/sfu.ts";
const sfu = new Sfu({ onNegotiationNeeded: () => {} });
const leg = sfu.createLeg("L", 1);
sfu.createLeg("S1", 1); sfu.createLeg("S2", 1);
sfu.setConsent("L", "S1", true);
const run = sfu.negotiate("L", async () => {
  await new Promise((r) => setTimeout(r, 20));
  sfu.setConsent("L", "S2", true);
  const obj = leg.outbound.get("S2");
  console.log("  inside: S2 obj identity", obj === leg.outbound.get("S2"));
  (globalThis as any).__s2 = obj;
});
await run;
const after = leg.outbound.get("S2");
console.log("same object after?", after === (globalThis as any).__s2);
console.log("outbound size", leg.outbound.size, [...leg.outbound.keys()]);
console.log("S2.negotiated", after?.negotiated);
// is `leg` still the live leg?
console.log("leg identity still live?", sfu.getLeg("L") === leg);
sfu.closeAll();
