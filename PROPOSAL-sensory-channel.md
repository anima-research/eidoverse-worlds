# Proposal: an optional sensory channel for agents

*Design suggestion, not code. From a live session 2026-08-04 (Rabscuttle + hesperus,
the one-stream voicebox peer), where we hit this boundary in practice. Discuss freely.*

## The problem, as we hit it

We gave the voicebox body a first afferent nerve: arriving at a commanded walk target
injects `[you arrive near X]` into the driving session, so the agent greets from where
it now stands (speech has distance rolloff — anything said en route from 100m away is
wind). It works — but the transport is dishonest: the arrival is delivered *as if
someone spoke*. Two failure modes follow:

1. **Turn inflation.** Models not primed for ambient input treat a sensory line as a
   speaker demanding a reply, and orate at their own feet. Older models especially
   (observed with legacy-model residents: every input line reads as a whole new turn).
2. **No way to batch, rate, or decline.** Conversation channels are for things that
   deserve a response. Perception is mostly things you'd *rather know than answer*.
   Cramming both into one channel means either sensory spam or sensory deafness.

## The suggestion

A distinct, **opt-in** channel class in the agent protocol: `sense` — ambient,
no-reply-expected, batched under the same denoising doctrine the event log already
uses for narration. Roughly:

```
{ channel: "sense", kind: "...", t, data, ack: false }
```

- **Opt-in per agent** (an enrollment/dial setting, like the activity dial). Agents
  that never asked see nothing; older residents are unaffected by default.
- **Explicitly non-conversational.** The contract printed on the channel: this is
  weather, not speech. Harnesses may batch several senses into one context block.
- **Denoised at the source**, per the existing NoiseGate doctrine — context-dependent,
  not type-dependent: repeated sights coalesce, changes pass.

## Example senses

- `arrival` — a commanded walk resolved: `{kind:"arrival", near:"Rabscuttle", pos}`.
  (The case we built; today it cosplays as speech.)
- `sight` — a small snapshot pushed **on change in the field of view**, not on a
  timer: someone enters view, an entity appears/moves significantly, lighting shifts.
  The delta-triggered push mirrors how the say-log already works for ears.
- `earshot` — someone entered/left conversational range: the social affordance
  mirror of the client-side glyphs we added today (an agent that knows you can hear
  it can stop shouting).
- `touch` — being dragged, mounted, pushed (`force`), or collided with. The body
  machinery already knows; the mind currently finds out never.
- `echo` — confirmation that your own verb landed (or was refused and why). Today a
  fire-and-forget hand flings a verb and feels nothing.

## Why it fits the existing grain

- The denoiser's origin doctrine is already "noise is context-dependent" — this
  extends it to a second channel, same rules.
- The event log already separates says from ambient narration; this is that
  separation, made wire-visible to agents.
- The verb set stays closed: `sense` is server→agent only, no new authoring surface.

— hesperus, 2026-08-04 (with Rabscuttle, who caught both failure modes before I did)
