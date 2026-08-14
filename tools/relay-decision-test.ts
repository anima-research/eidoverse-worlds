// The seven refusal proofs (#104 amendment 1) + incarnation and consent rules
// (amendments 2, 3), pinned headless. bun tools/relay-decision-test.ts
import { admitParticipant, relayIdentity, parseRelayIdentity, nextIncarnation,
  subscriptionActive, applyConsentUpdate,
  type RelayClaims, type LiveLegState } from "../server/relaydecision.ts";

let pass = 0, fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  okv ? pass++ : fail++;
  console.log(`  ${okv ? "✅" : "❌"} ${name}${okv ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const claims = (over: Partial<RelayClaims> = {}): RelayClaims => ({
  world: "staging", id: "hesperus", primaryGen: 412, mediaGen: 413,
  incarnation: "i7-abc", nonce: "n1", ...over });
const live = (over: Partial<LiveLegState> = {}): LiveLegState => ({
  world: "staging", incarnation: "i7-abc", primaryGen: 412, mediaGen: 413,
  usedNonces: new Set(), ...over });

// ── the seven refusals ──────────────────────────────────────────────────────
t("valid credential admits", admitParticipant(claims(), live()), { admit: true });
t("1 wrong world refused", admitParticipant(claims({ world: "other" }), live()),
  { admit: false, reason: "wrong world" });
t("2 wrong identity (no leg issued for id) refused",
  admitParticipant(claims(), live({ mediaGen: undefined })),
  { admit: false, reason: "no relay leg issued" });
t("3 retired primary generation refused",
  admitParticipant(claims({ primaryGen: 411 }), live()),
  { admit: false, reason: "retired primary generation" });
t("3b primary gone entirely refused",
  admitParticipant(claims(), live({ primaryGen: undefined })),
  { admit: false, reason: "no living primary" });
t("4 retired media generation refused",
  admitParticipant(claims({ mediaGen: 409 }), live()),
  { admit: false, reason: "retired media generation" });
t("5 prior relay incarnation refused",
  admitParticipant(claims({ incarnation: "i6-zzz" }), live()),
  { admit: false, reason: "prior relay incarnation" });
t("6 removed-participant replay refused (nonce single-use)",
  admitParticipant(claims(), live({ usedNonces: new Set(["n1"]) })),
  { admit: false, reason: "credential replay" });
// 7 expired: enforced at TokenVerifier(tolerance=0) upstream — the decision
// layer never sees an expired credential; pinned by the killq-a receipt.

// ── identity carries the generation ─────────────────────────────────────────
t("relayIdentity embeds gen", relayIdentity("hesperus", 413), "hesperus#g413");
t("parse round-trips", parseRelayIdentity("hesperus#g413"), { id: "hesperus", mediaGen: 413 });
t("parse survives # in id", parseRelayIdentity("a#b#g7"), { id: "a#b", mediaGen: 7 });
t("parse refuses genless", parseRelayIdentity("hesperus"), null);

// ── incarnation (amendment 2) ───────────────────────────────────────────────
t("first incarnation", nextIncarnation(null, "abc"), "i1-abc");
t("advance past prev", nextIncarnation("i7-old", "new"), "i8-new");
t("lost-file restart cannot equal prev (entropy differs)",
  nextIncarnation(null, "x9") !== "i1-abc" || "i1-x9" !== "i1-abc", true);

// ── audibility: three independent states (amendment 3) ──────────────────────
t("no consent → inactive (fail closed)",
  subscriptionActive({ listenerConsent: false, moderatorMuted: false }), false);
t("consent alone → active",
  subscriptionActive({ listenerConsent: true, moderatorMuted: false }), true);
t("moderator mute beats consent",
  subscriptionActive({ listenerConsent: true, moderatorMuted: true }), false);

// ── consent updates: gen-bound, idempotent, reconnect never broadens ────────
{
  const m = new Map<string, { gen: number; consent: boolean }>();
  t("fresh consent applies", applyConsentUpdate(m, "riannon", 500, true), { changed: true });
  t("repeat is idempotent", applyConsentUpdate(m, "riannon", 500, true),
    { changed: false, reason: "idempotent" });
  t("stale generation cannot apply", applyConsentUpdate(m, "riannon", 499, true),
    { changed: false, reason: "stale listener generation" });
  t("newer generation resets (fail-closed rejoin)",
    applyConsentUpdate(m, "riannon", 501, false), { changed: true });
  t("…and the old ON cannot resurrect", applyConsentUpdate(m, "riannon", 500, true),
    { changed: false, reason: "stale listener generation" });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} relay-decision: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
