/**
 * Adversarial probes — B (negotiation queue) and A (fanout).
 * Each probe is independent and prints PASS/DEFECT with exact numbers.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  PASS " : "  DEFECT "} ${n}${d ? "  :: " + d : ""}`);

// ── B1: coalesced ask LOST across a takeover ──────────────────────────────
// ensureRoute adds legId to `dirty` and schedules a microtask. The microtask
// checks `this.legs.get(listenerId)?.closed === false`. If the leg is closed
// and RECREATED (takeover) before the microtask runs, the NEW leg is not
// closed, so the ask fires -- but for a leg that has NO route (the new leg's
// outbound map is empty). Conversely: dirty is keyed by ID only.
console.log("\n── B1: dirty set is keyed by id, not by leg identity ──");
{
  const asks: string[] = [];
  const sfu = new Sfu({ onNegotiationNeeded: (id) => asks.push(id) });
  sfu.createLeg("carol", 1);
  sfu.createLeg("dave", 1);
  sfu.setConsent("carol", "dave", true);   // marks carol dirty, schedules microtask
  // takeover BEFORE the microtask drains:
  const carol2 = sfu.createLeg("carol", 2); // closeLeg("carol") then new leg
  await sleep(50);
  const routes = [...carol2.outbound.keys()];
  P("B1 ask fired for a leg with no routes",
    !(asks.includes("carol") && routes.length === 0),
    `asks=${JSON.stringify(asks)} carol2.outbound=${JSON.stringify(routes)}`);
  sfu.closeAll();
}

// ── B2: ask LOST -- route exists, no offer ever made ───────────────────────
// The inverse and worse case. If a leg is marked dirty, then closed, the
// microtask's `dirty.delete` succeeds and the guard drops the ask. Fine.
// But: setConsent -> ensureRoute returns false when the route ALREADY exists,
// which means NO ask is scheduled. Combine with a failed/未-negotiated offer
// and the route is permanently silent.
console.log("\n── B2: re-consent after a dropped negotiation never re-asks ──");
{
  const asks: string[] = [];
  const sfu = new Sfu({ onNegotiationNeeded: (id) => asks.push(id) });
  sfu.createLeg("l", 1); sfu.createLeg("s", 1);
  sfu.setConsent("l", "s", true);
  await sleep(20);
  const firstAsks = asks.length;
  // Caller's negotiation fails (network blip / exchange throws). Route stays in
  // outbound. Caller retries by re-asserting consent -- the natural recovery.
  sfu.setConsent("l", "s", false);
  sfu.setConsent("l", "s", true);
  await sleep(20);
  P("B2 re-consent re-asks for negotiation",
    asks.length > firstAsks,
    `asks after re-consent = ${asks.length}, was ${firstAsks} -- route exists but no offer will ever be made`);
  sfu.closeAll();
}

// ── B3: negotiate() serialization vs. the ask fired OUTSIDE negotiate() ────
// onNegotiationNeeded is invoked from a raw queueMicrotask, NOT through the
// negotiating chain. A caller that (correctly) calls sfu.negotiate() from the
// hook is serialized. But nothing forces that. Check: does the SFU itself
// guarantee ordering, or does it depend on caller discipline?
console.log("\n── B3: is the ask itself serialized? ──");
{
  let inFlight = 0, maxInFlight = 0;
  const sfu = new Sfu({
    onNegotiationNeeded: () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); },
  });
  sfu.createLeg("x", 1); sfu.createLeg("y", 1); sfu.createLeg("z", 1);
  sfu.setConsent("x", "y", true);
  sfu.setConsent("x", "z", true);
  await sleep(20);
  P("B3 coalescing held for multi-route same-turn", maxInFlight <= 1, `maxInFlight=${maxInFlight}`);
  sfu.closeAll();
}

// ── B4: onNegotiationNeeded throws ────────────────────────────────────────
console.log("\n── B4: a throwing onNegotiationNeeded ──");
{
  let reached = false;
  const sfu = new Sfu({ onNegotiationNeeded: () => { throw new Error("caller blew up"); } });
  sfu.createLeg("a", 1); sfu.createLeg("b", 1);
  sfu.setConsent("a", "b", true);
  await sleep(60);
  reached = true;
  P("B4 survived a throwing hook", reached, "if you see this, the throw did not kill the run");
  // Does the SFU still work afterwards?
  const asks2: string[] = [];
  const sfu2 = new Sfu({ onNegotiationNeeded: (id) => asks2.push(id) });
  sfu2.createLeg("c", 1); sfu2.createLeg("d", 1);
  sfu2.setConsent("c", "d", true);
  await sleep(20);
  P("B4b a later Sfu still gets asks", asks2.length === 1, `asks=${asks2.length}`);
  sfu.closeAll(); sfu2.closeAll();
}

// ── A1: consent revoked DURING fanout iteration ───────────────────────────
console.log("\n── A1: closeLeg during fanout (iteration-during-mutation) ──");
{
  const sfu = new Sfu({ onNegotiationNeeded: () => {} });
  const legs = ["s", "L0", "L1", "L2", "L3"].map((id) => sfu.createLeg(id, 1));
  for (let i = 0; i < 4; i++) sfu.setConsent(`L${i}`, "s", true);
  await sleep(20);
  // Give every listener a real track object so fanout writes into it.
  let writes = 0;
  for (let i = 0; i < 4; i++) {
    const t = sfu.getLeg(`L${i}`)!.outbound.get("s")!;
    (t as any).writeRtp = () => {
      writes++;
      if (writes === 2) sfu.closeLeg("L3");   // mutate this.legs mid-iteration
    };
  }
  const speaker = sfu.getLeg("s")!;
  (speaker as any).ingress = new MediaStreamTrack({ kind: "audio" });
  const pkt = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: 1, timestamp: 960, ssrc: 7 }), Buffer.from([1]));
  (sfu as any).fanout(speaker, pkt);
  P("A1 no crash iterating while deleting", true, `writes=${writes} (Map iteration is delete-safe in JS)`);
  sfu.closeAll();
}
console.log("");
