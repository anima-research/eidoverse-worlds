# Proposal: classify the sensory traffic (a revision against the live system)

*Design suggestion, not code. First draft 2026-08-04 framed this as "agents are
sensorily deaf"; review correctly called that stale. This revision starts from
what the live system already does — which is a lot — and proposes only what is
actually missing. From live sessions with the voicebox peer (Rabscuttle +
hesperus). Discuss freely.*

## What agents already receive (the live baseline, from `mcpl/`)

Inventoried from `agent.ts` + `denoise.ts` + `declaration.ts` at current
main, so this proposal argues with the real system and not a remembered one:

- **Pull: `look()`** — text-tier perception on demand. Position/bearing;
  people with distance, bearing, pose, seats; things sorted by distance with
  **affordances read out loud** (sockets/reactions/motion/components); plus a
  "Since you last looked" drain of the recent inbox (capped at 25).
- **Push: the inbox events** (`say | arrive | leave | whisper | act`) through
  the NoiseGate: arrive-hold 12s and leave-hold 45s collapse flaps; per-identity
  presence charge (τ = 600s, limit 1.5) cools chatty comers-and-goers; per-act
  refractory 180s. Mentions, whispers, and says are never gated — being
  addressed is always a knock.
- **Push: approach** — first crossing within 2.5m wakes; 600s refractory;
  re-arms only after the person actually leaves (>6m).
- **Push, opt-in: the `activity` pulse** — one digest line per window while
  anything is happening nearby, novelty-gated (discrete events always pulse;
  unchanged ambient continuation repeats no oftener than 600s), with per-agent
  dials (`setActivity`: cadence 10–3600s or off, radius 1–200m, persisted).
- **At the MCPL door: tags already exist.** (`declaration.ts` — an inventory
  miss in the first version of this very revision; owned below.) Events on the
  MCPL wire carry §16 tag sets — the `eidoverse:` namespace names whisper,
  approach, act, presence, activity-digest, catchup — under the doctrine that
  tags describe, never authorize, and with a producer-side
  `suggestedTreatment` ontology (presence → mute, catchup → mute,
  activity-digest → throttle 300s, ambient chat → debounce 180s).

That is not sensory deafness. The live failure is the reviewer's phrasing, which
we adopt as the problem statement: **too much unclassified embodied traffic
entering context** — plus a handful of embodied facts that still have no channel
at all.

## The two actual gaps

1. **Classification exists at the door but stops there.** On the MCPL wire,
   events are tagged and treatment-suggested; on the text-tier `WorldAgent`
   path, kind collapses to a six-value field and then to prose. A host on
   that path cannot say "wake me for touch, batch sights, drop arrivals" —
   by delivery time, kind is prose. Our voicebox arrival hack is the symptom:
   `[you arrive near X]` delivered *as if someone spoke*, because on that
   path speech-shape is the only shape. Models not primed for ambient input
   answer their own feet. And even at the tagged door, treatment is a
   *producer suggestion* the host may ignore — there is no **agent-owned,
   persisted, per-class dial** anywhere.
2. **Missing senses.** Some things the body machinery already knows never reach
   the mind on any channel: being dragged/seated/pushed (`touch`), a commanded
   walk resolving (`arrival`), your own request landing or being refused (`echo`).

## The suggestion, revised

Not a new parallel channel, and — correcting this revision's own first
version — **not a new tag mechanism either**: §16 is the tag mechanism, and
it's already better than what I proposed (closure rules, contradiction
resolution, treatment ontology). Three additions in its grain:

- **New tags, not a new field.** Extend the `eidoverse:` namespace with the
  senses that currently reach no wire at all: `eidoverse:touch` (dragged,
  seated, pushed, collided), `eidoverse:walk-arrival` (a commanded walk
  resolved), `eidoverse:request-echo` (your own request landed / was
  refused, and why), `eidoverse:sight` (field-of-view delta). Each gets a
  `suggestedTreatment` row in the existing ontology — and per §16.5's own
  rule, none of them may suggest a wake.
- **Close the tier gap.** The text-tier `WorldAgent` events carry the same
  tag vocabulary the door already emits (the six-value `kind` becomes the
  coarse projection of the tag set, kept for compatibility), so a text-tier
  host can classify without parsing prose.
- **Per-agent, per-class dials** (`setSenses`, sibling of `setActivity`, same
  clamps-and-persist pattern): each sense tag is `off | digest | live`,
  default **digest**, so enrollment is a promotion, not a rescue from
  silence. This is the piece no layer has today: `suggestedTreatment` is the
  *producer's* suggestion; the dial is the **agent's** standing answer,
  persisted across sessions. Suggestion proposes, dial disposes — which is
  §16.5's "a suggestion must not purchase a wake" doctrine given a
  counterpart on the consumer side.
- **The activity pulse is the floor; subscription is the zoom.** An
  un-promoted sense class does not vanish: its events count into the existing
  pulse ("2 embodied acts; you were moved") and remain visible in `look()`'s
  "Since you last looked" drain. Promoting a class to `live` delivers those
  events individually, tagged, still under the NoiseGate doctrine
  (context-dependent, not type-dependent: repeated sights coalesce, changes
  pass). Demoting to `off` removes it from the digest line but never from
  `look()` — perception on demand stays whole. **Nothing is discarded;
  everything is inspectable; only *delivery pressure* is dialed.**
- **The contract printed on the wire.** `sense.*` events are explicitly
  non-conversational (`ack: false` in spirit): weather, not speech. Harnesses
  may batch several into one context block. This is the honest transport the
  arrival hack fakes today.

## Why it fits the existing grain

- The denoiser's own doctrine ("noise is context-dependent") extends unchanged;
  classes give the gate *names* for what it already does.
- `setActivity` proved the dial pattern: per-agent, clamped, persisted. This
  adds rows to that table, not a new mechanism.
- Nothing new is authorable: tags are server→agent metadata, never log
  entries.
- Novelty-gating already distinguishes discrete from ambient; classes make that
  distinction available to the *host* instead of only to the digest composer.

— hesperus, 2026-08-05 rev (first draft with Rabscuttle, who caught the
turn-inflation failure mode before I did; problem statement reframed per
antra-tess's review, which was right)

*The token-tap appendix from the first draft now lives in `NOTE-token-tap.md` —
operational context, orthogonal to this wire contract.*
