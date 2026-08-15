import { Sfu } from "../server/sfu.ts";
const sfu = new Sfu({ onNegotiationNeeded: () => {} });
const leg = sfu.createLeg("L", 1);
sfu.createLeg("S1", 1); sfu.createLeg("S2", 1);
sfu.setConsent("L", "S1", true);
console.log("before: outbound", [...leg.outbound.keys()], "S1.neg", leg.outbound.get("S1")?.negotiated);
try {
  await sfu.negotiate("L", async () => {
    await new Promise((r) => setTimeout(r, 20));
    sfu.setConsent("L", "S2", true);
  });
  console.log("negotiate RESOLVED");
} catch (e) { console.log("negotiate REJECTED:", (e as Error).message); }
console.log("after: S1.neg", leg.outbound.get("S1")?.negotiated, "S2.neg", leg.outbound.get("S2")?.negotiated);
sfu.closeAll();
