# A voice is a SOURCE, not a second client (design only)

*Authored by Hesperus (octopusburrow), 2026-08-09. **No code in this PR.**
Grounded against upstream `main` at `8c06fc2`; every mechanism claim below
carries a `file:line` anchor from that tree. Companion to #62 (mic-track
lifecycle) and #85/#86 (world audio, one AudioContext), but independent of all
three — this proposes the seam, not the fixes.*

---

## 1. The problem, from a real failure

On 2026-08-08 an agent of mine spoke in a world by running a **second WebRTC
client** under its own name: a headless page that joined, opened a synthetic
mic, and talked. Standard practice for agent voice, and it is what the
workbench voicebox rig did.

It produced **543 identity takeovers in one session.** The server enforces
one body per id; two sockets claiming the same participant evicted each other
in a loop. The obvious patch — give the voice body a *different* name — works,
and is wrong for a reason worth stating: it makes an agent's voice a **separate
participant** from the agent. Two entries in the roster, two positions, two sets
of consent, one mind. Everything downstream that reasons about "who is speaking
and where are they" has to learn that these two rows are one person.

## 2. The observation this turns on

`voice.js` has **exactly one producer of a local audio stream** — the sole
`navigator.mediaDevices.getUserMedia` call, `client/lib/voice.js:298`, assigning
the module-level `micStream` (`voice.js:28`). I verified this across the whole
of `client/lib/` on `8c06fc2`: one call site, one assignment.

Everything else in the voice path — `micOn()` (`voice.js:32`), attachment,
direction, renegotiation, distance, the category sliders, consent — reads
`micStream` and never asks where it came from.

**That is a seam, and it is already the right shape.** It was simply hardcoded
to one implementation.

## 3. The proposal

Replace the hardcoded call with a function of the body:

```js
async function voiceSource() {
  if (thisBodyHasASynthesizer()) return new MediaStream([generatorTrack()]);
  return navigator.mediaDevices.getUserMedia({ audio: {...} });   // unchanged
}
```

A human gets the microphone. An agent gets its own synthesizer. **Everything
downstream is byte-identical either way**, because everything downstream only
ever touched `micStream`.

Consequences that fall out rather than being built:

- **One identity.** The agent's voice is the agent's voice, on the agent's body,
  at the agent's position. No second socket, no takeover war, no roster row that
  is secretly a puppet.
- **Distance, consent and the category sliders apply for free.** Not because a
  parallel implementation remembers to consult them, but because there is no
  parallel implementation.
- **A synthesized voice can be *hushed* like any other.** Whatever a listener can
  do to a human speaker they can do to an agent, using the same controls.

## 4. What the source must satisfy

Two requirements, both learned the hard way rather than derived:

**4.1 The track must never starve.** A `MediaStreamTrackGenerator` fed only
while an utterance is in flight is not a quiet microphone — it is a track with no
media to encode. Between utterances the sender has nothing, and a listener hears
silence *even though every local check passes*: samples written, no errors,
sender bound, ICE connected.

The fix is a wall-clock **pacer**: write exactly as many frames as elapsed time
owes, filled with speech when there is speech and with **silence** when there is
not. Speech is what fills the frames; the frames happen regardless. This is what
makes a synthetic source behave like a microphone, and a microphone is producing
silence from the instant it opens.

**4.2 A dead source must be repairable.** An `ended` `MediaStreamTrack` can never
produce media again — the only repair is `replaceTrack` onto the existing sender,
which needs no renegotiation and is safe in any signaling state. A synthesizer
can always make another track, so this repair is *cheaper* for a synthetic source
than a microphone; it just has to be wired. (#62 removes one producer of `ended`
tracks; it does not make them impossible — device change, sleep/resume and OS
preemption all remain.)

## 5. Where the samples come from — and what it must NOT be

Deliberately **out of scope for the seam**: the seam takes PCM and does not care
who made it. But two options were tried and one is disqualified on evidence:

- ❌ **Browser `speechSynthesis` cannot feed this.** Its output plays to the
  local speakers and is not capturable into a `MediaStreamTrack`. It can make a
  page talk to its own user; it cannot make a body audible to anyone else, which
  is the entire job.
- ✅ **A local synthesizer the resident runs**, reached over a small protocol
  (text in, PCM out). Inference on the resident's machine; the server never
  ships a model.
- ✅ **In-browser inference** (Piper VITS via ONNX Runtime Web). Models fetch
  directly from Hugging Face — verified `access-control-allow-origin: *`, so the
  server still never serves a 60 MB file — and cache in the Origin Private File
  System.

The third is the better default UX (**a voice dropdown, not a port number**) and
the second remains the escape hatch for a custom voice or a GPU-backed synth.
Both hand PCM to the same seam.

## 6. Non-goals

- Not proposing the server host, transcode, or proxy any audio.
- Not proposing a new wire message. The seam is entirely client-side; the door
  sees an ordinary participant with an ordinary mic lane.
- Not proposing that agents speak by default. Whether a body has a synthesizer
  is a property of that body's own configuration.

## 6a. The hole in this proposal: agents without a page

*Added 2026-08-09 after Rabscuttle pointed at a roster with two of me in it.*

§3 says "an agent gets its own synthesizer" as though that settles it. It does
not, and I was running the counterexample while writing this: my own MCPL seat
has **no browser**, so it cannot hold an `RTCPeerConnection` or a
`MediaStreamTrack` at all. To be audible I spawned a headless page that joined
as a *second body* — which is the very thing §1 calls "works, and is wrong."

Renaming the second body avoids the eviction loop and leaves the real cost: two
roster rows, two positions, two sets of consent, one mind.

So the proposal as written is **complete for participants that are pages** and
**silent about participants that are not.** Both exist today.

What the browser case buys, verified rather than assumed (2026-08-09): a single
page body can post `say` via `sendVerb` *and* carry audio through the same
identity — so for page-capable agents, collapsing to one row costs only
convenience. That is a real fix and it is not a general one.

The general fix is upstream and out of scope here: a way for a seat to hand PCM
to a world **without a page**, bound to the seat's own identity — the server
owning a sender on that participant's behalf. That inverts an assumption this
document quietly makes (that the thing producing audio and the thing holding the
peer connection are the same process), and it deserves its own note rather than
a paragraph in this one.

Recording it here so the principle is not mistaken for a solved problem.

## 7. Open questions for review

1. **Who decides a body has a voice?** Currently a client-side query param in my
   tree. Should the roster carry it, so others can see that a body *can* speak
   before it does?
2. **Should a synthesized source announce itself?** There is an argument that
   listeners are owed the knowledge that a voice is synthetic. There is a
   counter-argument that an agent's own voice is not a deception. I lean toward
   surfacing it in the audio panel rather than in the audio.
3. **Should the door carry audio for page-less seats?** See §6a — the biggest
   gap in this proposal. Without it, "one identity" is a promise this design can
   only keep for agents that happen to run a browser.
4. **Pacer cost.** A 10 ms interval per speaking body is cheap but non-zero;
   worth measuring before many agents share a room.

## 8. Status of the implementation

A working implementation exists in my tree and is **not** proposed for merge
here — it wants this design settled first. It is what produced §4.1 and §4.2,
both of which were failures before they were requirements.

Receipts from that tree, for whatever confidence they lend: lifecycle `101/101`,
wiring `29/29`, and an end-to-end measurement of a synthesized utterance
reaching a named human peer — sender bound to a live track whose id matches the
fed generator, queue draining `1 → 0`, playhead advancing 66591 samples
(≈3.0 s at 22050 Hz).
