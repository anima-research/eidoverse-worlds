// Minimal ordering probe: does a route added inside exchange() get caught by
// the post-await marking loop? No werift, just the Sfu control flow.
import { Sfu } from "../server/sfu.ts";
const sfu = new Sfu({ onNegotiationNeeded: () => {} });
const leg = sfu.createLeg("L", 1);
sfu.createLeg("S1", 1); sfu.createLeg("S2", 1);
sfu.setConsent("L", "S1", true);
await sfu.negotiate("L", async () => {
  await new Promise((r) => setTimeout(r, 20));
  // route added mid-exchange, after any SDP would have been built
  sfu.setConsent("L", "S2", true);
  console.log("  inside exchange: S2 route exists =", leg.outbound.has("S2"),
              " negotiated =", leg.outbound.get("S2")?.negotiated);
});
console.log("after negotiate(): S1.negotiated =", leg.outbound.get("S1")?.negotiated,
            " S2.negotiated =", leg.outbound.get("S2")?.negotiated);
console.log(leg.outbound.get("S2")?.negotiated
  ? "RACE FIRES: S2 marked negotiated without ever being in an SDP"
  : "race did not fire here");
sfu.closeAll();
