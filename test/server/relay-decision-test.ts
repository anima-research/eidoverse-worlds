// Incarnation and consent rules (#104 amendments 2, 3), pinned headless; the eight refusal branches (amendment 1) are one
// table in test/server/sfu-adapter-test.ts. bun test/server/relay-decision-test.ts
import { relayIdentity, parseRelayIdentity, nextIncarnation,
  subscriptionActive, applyConsentUpdate,
} from "../../server/relaydecision.ts";
import { suite } from "../gate/suite.ts";

const S = suite("relay-decision");
const t = (name: string, got: unknown, want: unknown) => S.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// the eight refusal branches: one table through admitParticipant AND admitSfuLeg in test/server/sfu-adapter-test.ts

// ── identity carries the generation ─────────────────────────────────────────
t("relayIdentity embeds gen", relayIdentity("hesperus", 413), "hesperus#g413");
t("parse round-trips", parseRelayIdentity("hesperus#g413"), { id: "hesperus", mediaGen: 413 });
t("parse survives # in id", parseRelayIdentity("a#b#g7"), { id: "a#b", mediaGen: 7 });
t("parse refuses genless", parseRelayIdentity("hesperus"), null);

// ── incarnation (amendment 2) ───────────────────────────────────────────────
t("first incarnation", nextIncarnation(null, "abc"), "i1-abc");
t("advance past prev", nextIncarnation("i7-old", "new"), "i8-new");
t("lost-file restart cannot equal prev (entropy differs)",
  nextIncarnation(null, "x9") !== nextIncarnation(null, "abc"), true);

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
  t("fresh consent applies", applyConsentUpdate(m, "listener-a", 500, true), { changed: true });
  t("repeat is idempotent", applyConsentUpdate(m, "listener-a", 500, true),
    { changed: false, reason: "idempotent" });
  t("stale generation cannot apply", applyConsentUpdate(m, "listener-a", 499, true),
    { changed: false, reason: "stale listener generation" });
  t("newer generation resets (fail-closed rejoin)",
    applyConsentUpdate(m, "listener-a", 501, false), { changed: true });
  t("…and the old ON cannot resurrect", applyConsentUpdate(m, "listener-a", 500, true),
    { changed: false, reason: "stale listener generation" });
}

S.done();
