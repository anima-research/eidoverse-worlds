// The server-to-local clock offset, kept from samples: the one rule for a
// browser (client/lib/remotes.js), a lite page (client/lib/participants_lite.js)
// and an agent (mcpl/agent.ts).
//
// A sample is a message's `t`, the server's Date.now() when it sent it, less
// the local time the message was handled. That is the true offset less the
// message's delay, never more: a message handled late, behind a busy page or a
// slow link, reads the server's clock as earlier than it is. So the largest
// sample is the best estimate, and a late one moves it by no more than the
// leak below.
//
// The estimate may come down by LEAK_MS_PER_S for each second since the
// previous sample, and by no more than LEAK_MAX_MS at once, so a slow drift
// between the two clocks is followed, while a run of late samples moves it by
// almost nothing. Between samples it holds, so a world with no messages
// doesn't wander, and the cap keeps a late sample after a long quiet spell, a
// page coming back from a background tab, say, from pulling it down by its
// whole delay; its cost is that a drift built up over such a spell is followed
// by at most 100 ms at the first sample after it, and the rest of the way at
// 2 ms a second as samples resume, as any drift is. 2 ms/s is a reading, not
// a measurement: twice the 1 ms/s two clocks drift apart when each slews at
// 500 ppm, ntpd's limit.
// A step back of the server's clock, rare under NTP, which slews small
// offsets, or a reconnect to a server whose clock is behind the last one's, is
// followed at the same rate while samples come at least every 50 s, about 8
// minutes for a 1 s step and an hour for 7 s, and at 100 ms a sample when they
// come less often. The server sends a world frames only while some client
// there streams its body's pose, as an agent does every tick and a browser
// with a body does from its frame loop, moving or not, while its tab is
// shown; a world with nobody streaming (spectators only, or bodies whose tabs
// are hidden) gets none, so there the estimate holds until a frame, or this
// client's next join's clock message, brings a sample. That is the cost of not trusting late samples. (The stream
// offset below follows it within a few dozen samples, as the blend always
// did.)
export const LEAK_MS_PER_S = 2, LEAK_MAX_MS = 100;

// The stream offset is every sample blended in at STREAM_BLEND, the rule this
// one estimate followed before: the server's clock as the frames arrive,
// about one mean delay early. Interpolating remote bodies reads it
// (remotes.js streamNow): its INTERP_MS is a jitter buffer behind the frames
// as they come, so a frame late by the usual delay isn't late. Every other
// reader wants the server's true time and reads the offset.
export const STREAM_BLEND = 0.08;

/** Fold one sample into the estimate. `prev` is the previous result, or null
 *  before the first sample; `sample` is the message's t less the local time
 *  it was handled; `at` is that local time, in ms on a monotonic clock.
 *  Returns the new estimate, { offset, at, stream }. */
export function foldOffset(prev, sample, at) {
  // a non-finite sample or time (a t of 1e999 parses as Infinity) would
  // stick in the max and the blend for the page's life: it isn't a sample
  if (!Number.isFinite(sample) || !Number.isFinite(at)) return prev;
  if (!prev) return { offset: sample, at, stream: sample };
  const leak = Math.min(LEAK_MAX_MS, LEAK_MS_PER_S * Math.max(0, at - prev.at) / 1000);
  return {
    offset: Math.max(prev.offset - leak, sample),
    at: Math.max(prev.at, at),
    stream: prev.stream * (1 - STREAM_BLEND) + sample * STREAM_BLEND,
  };
}
