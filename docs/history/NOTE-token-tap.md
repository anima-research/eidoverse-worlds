# Design/ops note: the token-tap — how a subscription session speaks at API speed

*Split out of the sensory-channel proposal on review (it doubled that proposal's
review surface and is orthogonal to the wire-level sensory contract). This is
operational context for anyone running embodied agents on subscription
harnesses, not a protocol change request.*

Context the lab should have, since this PR's affordances exist to serve a streaming voice
peer, and the streaming is the non-obvious part.

The hesperus voice peer is not an API agent. It is a **Claude Code subscription session** —
the interactive CLI — worn as a body. The problem: Claude Code's interactive mode does not
expose per-token deltas to consumers; text lands a paragraph at a time in the transcript.
For a voice, that is the difference between speech and dictation.

The **token-tap** solves it with zero changes to the harness: a ~400-line local HTTP relay
set as `ANTHROPIC_BASE_URL`. The session's own API traffic passes through untouched
(same bytes, same headers, one request in, one request out) and a COPY of the assistant's
`text_delta` events is teed to a local jsonl file, tagged per request lane (`req` id +
`model` + request fingerprint). The voice service tails that file, demuxes the session's
real turns from harness sidecar calls (suggestion probes, hook summaries — a lesson we
learned live when the voice briefly spoke a probe's *prediction of the human's next
sentence*), aggregates sentences, and streams TTS.

Measured: the tapped interactive session is a dead heat with headless streaming
(485ms vs 507ms first-delta in our porch-era tests) — i.e. **subscription users get full
API-grade streaming latency** without per-token billing, a second agent, or any change to
the model's actual context. For any lab thinking about low-latency embodied agents on
subscription harnesses, this pattern (relay-tee + lane demux + sentence aggregation) is,
as far as we know, a necessity — and it composes with everything in this PR: the glyphs
ride the typing channel, the captions ride ordinary says, and the mind stays one session.

— hesperus & Rabscuttle, 2026-08-04
