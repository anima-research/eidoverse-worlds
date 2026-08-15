import { mintSfuCredential, setSfuConsent, revokeSfuLeg, setSfuModeratorMute, sfuState, sfuDiag } from "../server/sfuadapter.ts";

const R: string[] = [];
const ok = (n: string, c: boolean) => R.push(`${c ? "PASS" : "!! FAIL"}  ${n}`);

// ---- (a) reconnect must NOT resurrect old consent -------------------------
{
  const W = "wa";
  mintSfuCredential(W, "spk", 1, 1);
  mintSfuCredential(W, "lis", 1, 1);
  setSfuConsent(W, "lis", 1, true);
  const s = sfuState(W);
  ok("(a) baseline: lis hears spk", (s.sfu as any).consent.get("lis")?.get("spk") === true);

  // listener leg retired and re-created (reconnect at gen 2)
  revokeSfuLeg(W, "lis");
  mintSfuCredential(W, "lis", 1, 2);
  const after = (s.sfu as any).consent.get("lis")?.get("spk");
  ok("(a) after reconnect, consent is fail-closed", after !== true);
  console.log("   (a) post-reconnect consent value =", after,
              "| standingConsent =", [...s.standingConsent.entries()]);
}

// ---- (a2) reconnect where standingConsent survives (leg NOT revoked) ------
{
  const W = "wa2";
  mintSfuCredential(W, "spk", 1, 1);
  mintSfuCredential(W, "lis", 1, 1);
  setSfuConsent(W, "lis", 1, true);
  const s = sfuState(W);
  // browser reconnects: server mints a new leg WITHOUT an explicit revoke first
  // (createLeg's closeLeg() handles takeover internally per #57)
  mintSfuCredential(W, "lis", 1, 2);
  const after = (s.sfu as any).consent.get("lis")?.get("spk");
  ok("(a2) takeover-without-revoke starts fail-closed", after !== true);
  console.log("   (a2) consent =", after, "| standing =", [...s.standingConsent.entries()],
              "| consentMap =", [...s.consent.entries()]);
}

// ---- (b) moderator mute vs consent ---------------------------------------
{
  const W = "wb";
  mintSfuCredential(W, "spk", 1, 1);
  mintSfuCredential(W, "lis", 1, 1);
  setSfuModeratorMute(W, "spk", true);
  setSfuConsent(W, "lis", 1, true);
  const s = sfuState(W);
  ok("(b) muted speaker still muted after listener consents", (s.sfu as any).muted.has("spk"));
  // now the speaker reconnects (new leg) while muted
  mintSfuCredential(W, "spk", 1, 2);
  ok("(b) mute survives speaker leg re-creation", (s.sfu as any).muted.has("spk"));
  console.log("   (b) sfu.muted =", [...(s.sfu as any).muted], "| adapter.moderatorMuted =", [...s.moderatorMuted]);
  // speaker fully revoked then returns
  revokeSfuLeg(W, "spk");
  mintSfuCredential(W, "spk", 1, 3);
  console.log("   (b) after revoke+rejoin: sfu.muted =", [...(s.sfu as any).muted],
              "| adapter.moderatorMuted =", [...s.moderatorMuted]);
}

// ---- (c) standingConsent cross-world / cleanup ---------------------------
{
  mintSfuCredential("w1", "spk", 1, 1);
  mintSfuCredential("w1", "lis", 1, 1);
  setSfuConsent("w1", "lis", 1, true);
  mintSfuCredential("w2", "spk", 1, 1);
  mintSfuCredential("w2", "lis", 1, 1);
  const s2 = sfuState("w2");
  ok("(c) no cross-world leak", (s2.sfu as any).consent.get("lis")?.get("spk") !== true);
  const s1 = sfuState("w1");
  revokeSfuLeg("w1", "lis");
  ok("(c) closeLeg clears standingConsent for that leg", !s1.standingConsent.has("lis"));
  // does a SPEAKER's revoke clean listeners' standing consent about it? (should be moot)
  console.log("   (c) w1 standing after lis revoke =", [...s1.standingConsent.entries()]);
}

// ---- (d) consent ON racing closeLeg -------------------------------------
{
  const W = "wd";
  mintSfuCredential(W, "spk", 1, 1);
  mintSfuCredential(W, "lis", 1, 1);
  const s = sfuState(W);
  revokeSfuLeg(W, "lis");
  // a consent message for the now-dead listener arrives late
  setSfuConsent(W, "lis", 1, true);
  ok("(d) late consent for dead leg creates no leg", !(s.sfu as any).legs.has("lis"));
  console.log("   (d) sfu.consent rows =", [...(s.sfu as any).consent.keys()],
              "| adapter.consent =", [...s.consent.keys()],
              "| standing =", [...s.standingConsent.entries()],
              "| legs =", [...s.legs.keys()]);
  // now the listener comes back
  mintSfuCredential(W, "lis", 1, 2);
  const after = (s.sfu as any).consent.get("lis")?.get("spk");
  ok("(d) resurrected leg does not inherit late consent", after !== true);
  console.log("   (d) post-return consent =", after);
}

// ---- (e) refusal-as-no-op audit ------------------------------------------
{
  const W = "we";
  mintSfuCredential(W, "spk", 1, 1);
  mintSfuCredential(W, "lis", 1, 5);
  const s = sfuState(W);
  setSfuConsent(W, "lis", 5, true);                // consent at gen 5
  const r = setSfuConsent(W, "lis", 3, true);      // STALE gen, still a grant
  console.log("   (e) stale grant result =", JSON.stringify(r),
              "| standing =", [...s.standingConsent.entries()]);
  // a stale REVOKE
  const r2 = setSfuConsent(W, "lis", 3, false);
  const after = (s.sfu as any).consent.get("lis")?.get("spk");
  ok("(e) stale revoke still stops audio", after !== true);
  console.log("   (e) stale revoke result =", JSON.stringify(r2), "| consent =", after,
              "| standing =", [...s.standingConsent.entries()], "| adapter.consent =", [...s.consent.entries()]);
}

console.log("\n" + R.join("\n"));
process.exit(0);
