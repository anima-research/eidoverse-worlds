// Drives the exact sequence server.ts produces for relay-cred / voice-consent.
import { mintSfuCredential, setSfuConsent, revokeSfuLeg, setSfuModeratorMute, sfuState } from "../server/sfuadapter.ts";

const heard = (w: string, l: string, s: string) =>
  (sfuState(w).sfu as any).consent.get(l)?.get(s) === true;

// ── BUG A: reconnect resurrects consent (server.ts relay-cred path exactly) ──
// Browser reconnect: the client re-asks relay-cred. server.ts increments GEN
// and calls mintSfuCredential. It does NOT call revokeSfuLeg on the old leg.
{
  const W = "live1";
  mintSfuCredential(W, "speaker", 1, 100);   // relay-cred: speaker
  mintSfuCredential(W, "listener", 1, 101);  // relay-cred: listener
  setSfuConsent(W, "listener", 1, true);     // voice-consent recv:true
  console.log("A0 listener hears speaker:", heard(W, "listener", "speaker"));

  setSfuConsent(W, "listener", 1, false);    // voice-consent recv:false  (user turns it OFF)
  console.log("A1 after explicit OFF:", heard(W, "listener", "speaker"));

  // listener's tab reloads / voice leg restarts -> new relay-cred, new mediaGen
  mintSfuCredential(W, "listener", 1, 102);
  console.log("A2 after reconnect (expect false):", heard(W, "listener", "speaker"));
  console.log("   standing:", [...sfuState(W).standingConsent.entries()]);
}

// ── BUG B: consent ON, then reconnect. Must be fail-closed. ──
{
  const W = "live2";
  mintSfuCredential(W, "speaker", 1, 200);
  mintSfuCredential(W, "listener", 1, 201);
  setSfuConsent(W, "listener", 1, true);
  mintSfuCredential(W, "listener", 1, 202);  // reconnect, consent never re-stated
  console.log("B  reconnect w/ prior YES (expect false):", heard(W, "listener", "speaker"));
  const s = sfuState(W);
  console.log("   adapter.consent:", [...s.consent.entries()], "legs:", [...s.legs.entries()].map(([k,v])=>[k,v.gen]));
}

// ── BUG C: moderator mute lost on speaker reconnect while adapter thinks muted ──
{
  const W = "live3";
  mintSfuCredential(W, "speaker", 1, 300);
  mintSfuCredential(W, "listener", 1, 301);
  setSfuModeratorMute(W, "speaker", true);
  setSfuConsent(W, "listener", 1, true);
  const s = sfuState(W);
  console.log("C0 sfu.muted:", [...(s.sfu as any).muted], "adapter:", [...s.moderatorMuted]);
  revokeSfuLeg(W, "speaker");                // speaker disconnects
  console.log("C1 after revoke  sfu.muted:", [...(s.sfu as any).muted], "adapter:", [...s.moderatorMuted]);
  mintSfuCredential(W, "speaker", 1, 302);   // speaker rejoins
  console.log("C2 after rejoin  sfu.muted:", [...(s.sfu as any).muted], "adapter:", [...s.moderatorMuted]);
  // now a moderator toggles mute OFF then ON, using adapter state as truth
  setSfuModeratorMute(W, "speaker", false);
  console.log("C3 unmute -> sfu.muted:", [...(s.sfu as any).muted], "adapter:", [...s.moderatorMuted]);
}

// ── BUG D: standingConsent survives the SPEAKER leaving/rejoining ──
// and re-grants without the listener saying anything.
{
  const W = "live4";
  mintSfuCredential(W, "speaker", 1, 400);
  mintSfuCredential(W, "listener", 1, 401);
  setSfuConsent(W, "listener", 1, true);
  setSfuConsent(W, "listener", 1, false);    // listener explicitly REVOKES
  console.log("D0 after revoke:", heard(W, "listener", "speaker"),
              "standing:", [...sfuState(W).standingConsent.entries()]);
  revokeSfuLeg(W, "speaker");
  mintSfuCredential(W, "speaker", 1, 402);   // a NEW speaker leg arrives
  console.log("D1 new speaker arrives (expect false):", heard(W, "listener", "speaker"));
}

// ── BUG E: standingConsent grants to a speaker id that reuses a name ──
{
  const W = "live5";
  mintSfuCredential(W, "listener", 1, 500);
  setSfuConsent(W, "listener", 1, true);     // consent with NOBODY else present
  console.log("E0 standing:", [...sfuState(W).standingConsent.entries()]);
  mintSfuCredential(W, "stranger", 1, 501);  // an unrelated person joins later
  console.log("E1 stranger audible to listener without any new consent:",
              heard(W, "listener", "stranger"));
}
process.exit(0);
